import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { customers, products, PRODUCT_TYPES, SETTLEMENTS } from '../db/schema';
import type { NewCustomer, NewProduct, ProductType, Settlement } from '../db/schema';
import { mapHeaderFields, normalizeToken, parseNumberCell, productIdentityKey, TableParserService } from '../ai/table-parser.service';

/**
 * 主数据批量导入（客户 / 产品）：Excel(.xls/.xlsx) / CSV → 预览校验 → 用户确认 → 逐行事务写库。
 *
 * 设计取向：
 * - **复用** AI 识单的表格解析（TableParserService.parseUpload：magic bytes 判型 + xls/xlsx/csv 三通道）
 *   与表头匹配（mapHeaderFields：同一套别名、全角半角、最长命中规则），不另起一套解析器；
 * - **严格按现有 schema 建模**：字段名与列一一对应，schema 没有的字段不臆造（未映射清单见报告）；
 * - 上传**不写库**：preview 只读；commit 先按同一套规则重新解析校验，解析失败直接 400，一个写都不发；
 * - 幂等：客户按名称、产品按型号（trim + 全角半角 + 大小写归一）判定；模式 = 仅新增 / 新增或更新；
 * - 容错：逐行处理，单行失败只记入失败清单，不影响其它行；每行写库各自在事务内。
 *
 * 说明：本文件与 table-parser.service 保持一致，不使用模板字符串（字符串拼接统一用 +）。
 */

export const IMPORT_TARGETS = ['customers', 'products'] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number];

export const IMPORT_MODES = ['insert-only', 'upsert'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/** 行级结论：新增 / 更新 / 跳过 / 错误（错误行不入库，进失败清单） */
export type ImportRowStatus = 'new' | 'update' | 'skip' | 'error';

/** 字段定义：schema 列 → 表头别名 + 校验规则 */
interface ImportFieldDef {
  /** 服务端字段名（与 db/schema.ts 列名一一对应） */
  field: string;
  /** 中文标签（错误提示与模板表头用） */
  label: string;
  /** 表头别名（交给 mapHeaderFields 做最长命中匹配） */
  keywords: string[];
  required?: boolean;
  kind: 'text' | 'int' | 'enum';
  /** kind=enum 时的「归一化文本 → 词表值」查找表 */
  values?: Record<string, string>;
  /** 枚举可选值的中文提示 */
  hint?: string;
}

/** 由「中文标签/别名/词表原值 → 词表值」生成归一化查找表（与表头匹配同一套归一函数） */
function enumLookup(entries: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, value] of entries) out[normalizeToken(label)] = value;
  return out;
}

/** 产品类型：中文/缩写/原值都接受；'tbd'（待定）是占位产品的中立值，人工也允许显式填 */
const PRODUCT_TYPE_VALUES = enumLookup([
  ...PRODUCT_TYPES.map((t) => [t, t] as [string, string]),
  ['英式乙炔', 'uk_acetylene'], ['英乙', 'uk_acetylene'], ['uk乙炔', 'uk_acetylene'],
  ['英式丙烷', 'uk_propane'], ['英丙', 'uk_propane'], ['uk丙烷', 'uk_propane'],
  ['美式乙炔', 'us_acetylene'], ['美乙', 'us_acetylene'], ['us乙炔', 'us_acetylene'],
  ['美式丙烷', 'us_propane'], ['美丙', 'us_propane'], ['us丙烷', 'us_propane'],
  ['待定', 'tbd'], ['未定', 'tbd'],
]);

/** 结算方式：schema 词表 + 常见中文写法 */
const SETTLEMENT_VALUES = enumLookup([
  ...SETTLEMENTS.map((s) => [s, s] as [string, string]),
  ['30%定金+70%发货前', 'deposit_30_balance_before_ship'],
  ['30定金70发货前', 'deposit_30_balance_before_ship'],
  ['定金30尾款发货前', 'deposit_30_balance_before_ship'],
  ['月结30天', 'monthly_30'], ['月结30', 'monthly_30'],
  ['月结60天', 'monthly_60'], ['月结60', 'monthly_60'],
  ['发货前付清', 'before_ship'], ['款到发货', 'before_ship'],
  ['预付30%', 'prepay_30'], ['预付30', 'prepay_30'],
  ['月结', 'monthly'],
  ['现结', 'cash'], ['现金', 'cash'],
]);

const PRODUCT_TYPE_HINT = '可填：英式乙炔 / 英式丙烷 / 美式乙炔 / 美式丙烷 / 待定（或 uk_acetylene、tbd 等原值）';
const SETTLEMENT_HINT = '可填：30%定金+70%发货前 / 月结30天 / 月结60天 / 发货前付清 / 预付30% / 月结 / 现结';

/** 两类导入的字段定义（以 db/schema.ts 现有列为准，不臆造字段） */
export const IMPORT_FIELDS: Record<ImportTarget, ImportFieldDef[]> = {
  // customers: name / contact / settlement / creditDays（schema §主数据）
  customers: [
    { field: 'name', label: '客户名称', keywords: ['客户名称', '客户简称', '客户全称', '客户名', '客户公司', '客户单位', '客户', 'customer', 'buyer', '需方'], required: true, kind: 'text' },
    { field: 'contact', label: '联系人', keywords: ['联系人', '联系', '对接人', 'contact'], kind: 'text' },
    { field: 'settlement', label: '结算方式', keywords: ['结算方式', '结算', '付款方式', '账期方式', 'settlement'], kind: 'enum', values: SETTLEMENT_VALUES, hint: SETTLEMENT_HINT },
    { field: 'creditDays', label: '账期天数', keywords: ['账期天数', '账期天', '账期', '信用天数', 'creditdays', 'credit days'], kind: 'int' },
  ],
  // products: name / type / defaultPackaging / defaultRouting / safetyStock（schema §产品目录）
  products: [
    { field: 'name', label: '型号', keywords: ['产品名称', '产品型号', '物料名称', '型号', '品名', '产品', 'product', 'item', 'description', '规格'], required: true, kind: 'text' },
    { field: 'type', label: '类型', keywords: ['产品类型', '类型', '分类', 'type'], required: true, kind: 'enum', values: PRODUCT_TYPE_VALUES, hint: PRODUCT_TYPE_HINT },
    { field: 'defaultPackaging', label: '默认包装', keywords: ['默认包装', '包装要求', '包装', 'defaultpackaging', 'packaging'], kind: 'text' },
    { field: 'defaultRouting', label: '默认工序路线', keywords: ['默认工序路线', '工序路线', '工艺路线', '路线', 'defaultrouting', 'routing'], kind: 'text' },
    { field: 'safetyStock', label: '安全库存', keywords: ['安全库存量', '安全库存', '最低库存', 'safetystock', 'safety stock'], kind: 'int' },
  ],
};

/** 导入模板（中文表头 + 示例行，CSV/UTF-8，Excel 可直接打开） */
const TEMPLATES: Record<ImportTarget, { fileName: string; headers: string[]; samples: string[][] }> = {
  customers: {
    fileName: '客户导入模板.csv',
    headers: ['客户名称', '联系人', '结算方式', '账期天数'],
    samples: [
      ['Weldclass（澳洲）', 'John', '30%定金+70%发货前', '30'],
      ['桐乡五金城', '王经理', '月结30天', '30'],
    ],
  },
  products: {
    fileName: '产品导入模板.csv',
    headers: ['型号', '类型', '默认包装', '默认工序路线', '安全库存'],
    samples: [
      ['ANM 1/32 乙炔', '英式乙炔', '包装盒×50+纸箱', '下料→车削→钻孔→包装', '100'],
      ['6290 美式乙炔', '美式乙炔', '', '', '0'],
    ],
  },
};

export interface ImportPreviewRow {
  /** 表格里的行号（1-based，含表头行；与用户看到的 Excel 行号一致） */
  rowNo: number;
  status: ImportRowStatus;
  reasons: string[];
  /** 归一后的入库值（null = 表格留空，更新模式下不覆盖原值） */
  data: Record<string, string | number | null>;
  /** 原始单元格文本（预览展示用） */
  raw: string[];
  /** 命中的既有档案 id（新增为 null） */
  existingId?: number | null;
  /** 更新模式下将变化的字段名 */
  changedFields?: string[];
}

export interface ImportSummary {
  total: number;
  new: number;
  update: number;
  skip: number;
  error: number;
}

export interface ImportPreviewResult {
  target: ImportTarget;
  mode: ImportMode;
  /** 实际走的上传解析通道（xls / xlsx / csv） */
  fileKind: string;
  headerRowIndex: number;
  columns: Record<string, number>;
  /** 表头里没有对应到任何字段的列名（未映射提示，不参与导入） */
  unmappedHeaders: string[];
  summary: ImportSummary;
  rows: ImportPreviewRow[];
}

export interface ImportCommitResult {
  target: ImportTarget;
  mode: ImportMode;
  summary: ImportSummary;
  created: Array<{ rowNo: number; id: number; name: string }>;
  updated: Array<{ rowNo: number; id: number; name: string; fields: string[] }>;
  /** 失败清单（行号 + 原因）：含校验错误行与写库异常行 */
  failures: Array<{ rowNo: number; name: string; reason: string }>;
}

interface ImportInput {
  target: string;
  mode?: string;
  buffer: Buffer;
  fileName?: string;
  mimeType?: string;
}

/** CSV 单元格转义（含逗号/引号/换行时加引号，内部引号翻倍） */
function csvCell(v: string): string {
  const s = v ?? '';
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));

@Injectable()
export class MasterImportService {
  private readonly logger = new Logger(MasterImportService.name);

  constructor(private readonly tableParser: TableParserService) {}

  /** 导入模板：中文表头 + 2 行示例（controller 加 UTF-8 BOM 后以 CSV 下载） */
  template(targetRaw: string): { name: string; csv: string } {
    const target = this.assertTarget(targetRaw);
    const t = TEMPLATES[target];
    const lines = [t.headers, ...t.samples].map((r) => r.map(csvCell).join(','));
    return { name: t.fileName, csv: lines.join('\r\n') + '\r\n' };
  }

  /**
   * 预览：解析 + 表头映射 + 逐行校验分类（**只读，不写库**）。
   * 解析/表头失败直接 400 中文提示（此时未发生任何写操作）。
   */
  async preview(input: ImportInput): Promise<ImportPreviewResult> {
    const target = this.assertTarget(input.target);
    const mode = this.assertMode(input.mode);
    const fields = IMPORT_FIELDS[target];

    // 1) 复用 AI 识单的表格解析入口（magic bytes 判型；.xls/.xlsx/.csv 同一条路）
    const parsed = await this.tableParser.parseUpload({
      buffer: input.buffer,
      fileName: input.fileName,
      mimeType: input.mimeType,
    });
    const rows = parsed.rows;

    // 2) 复用表头匹配（同一套别名/全角半角/最长命中规则）
    const keywords: Record<string, string[]> = {};
    for (const f of fields) keywords[f.field] = f.keywords;
    const header = mapHeaderFields(rows, keywords, { maxScan: 8, minHits: 1 });
    const missingRequired = fields.filter((f) => f.required && header.columns[f.field] === undefined);
    if (header.headerRowIndex < 0 || missingRequired.length) {
      const want = fields.map((f) => f.label + (f.required ? '（必填）' : '')).join(' / ');
      const got = header.headerRowIndex >= 0 ? '识别到的表头：' + header.headerRow.join(' | ') : '前 8 行未识别出表头';
      throw new BadRequestException(
        (missingRequired.length ? '表格缺少必填列：' + missingRequired.map((f) => '「' + f.label + '」').join('、') + '；' : '')
        + got + '。可用列名：' + want + '（可下载导入模板）',
      );
    }

    const usedCols = new Set(Object.values(header.columns));
    const unmappedHeaders = header.headerRow
      .map((h, i) => ({ h: (h ?? '').trim(), i }))
      .filter((x) => x.h && !usedCols.has(x.i))
      .map((x) => x.h);

    // 3) 既有档案（幂等判定的依据：客户按名称、产品按型号；schema 无唯一约束 → 应用层归一比对）
    const existing: Array<Record<string, unknown>> = target === 'customers'
      ? await db.select({
          id: customers.id, name: customers.name, contact: customers.contact,
          settlement: customers.settlement, creditDays: customers.creditDays,
        }).from(customers)
      : await db.select({
          id: products.id, name: products.name, type: products.type,
          defaultPackaging: products.defaultPackaging, defaultRouting: products.defaultRouting,
          safetyStock: products.safetyStock,
        }).from(products);
    // ⚠️ 产品键必须带数字指纹（productIdentityKey）：0-GPN / 00-GPN / 000-GPN 是**同一型号的不同尺寸**，
    // 归一后必须仍是三个不同的键 —— 否则导入会把不同尺寸判成「已存在」而漏建档（甲方更正，宁缺勿错）。
    // 客户档案不涉及型号，仍按名称归一（保持既有行为不变）。
    const keyOf = (name: unknown): string => (target === 'products'
      ? productIdentityKey(String(name ?? ''))
      : normalizeToken(String(name ?? '')));
    const existingByKey = new Map<string, Record<string, unknown>>();
    for (const e of existing) {
      const k = keyOf(e.name);
      if (k && !existingByKey.has(k)) existingByKey.set(k, e);
    }

    // 4) 逐行校验 + 分类
    const nameLabel = fields[0].label;
    const out: ImportPreviewRow[] = [];
    const seenInFile = new Map<string, number>(); // 归一化名称 → 表内首次出现的行号
    rows.slice(header.headerRowIndex + 1).forEach((row, idx) => {
      if (!row.some((c) => c !== '')) return; // 全空行跳过（解析层已过滤，这里兜底）
      const rowNo = header.headerRowIndex + 2 + idx;
      const reasons: string[] = [];
      const data: Record<string, string | number | null> = {};
      const raw: string[] = [];
      for (const f of fields) {
        const col = header.columns[f.field];
        const text = col === undefined ? '' : String(row[col] ?? '').trim();
        raw.push(text);
        if (!text) {
          if (f.required) reasons.push(f.label + '不能为空');
          else data[f.field] = null;
          continue;
        }
        if (f.kind === 'int') {
          const n = parseNumberCell(text);
          if (n === undefined || !Number.isInteger(n) || n < 0) {
            reasons.push(f.label + '「' + text + '」不是非负整数');
            continue;
          }
          data[f.field] = n;
        } else if (f.kind === 'enum') {
          const v = f.values?.[normalizeToken(text)];
          if (!v) {
            reasons.push(f.label + '「' + text + '」无法识别；' + (f.hint ?? ''));
            continue;
          }
          data[f.field] = v;
        } else {
          data[f.field] = text;
        }
      }

      let status: ImportRowStatus = reasons.length ? 'error' : 'new';
      let existingId: number | null = null;
      let changedFields: string[] | undefined;
      if (!reasons.length) {
        const key = keyOf(data.name);
        const dupRowNo = seenInFile.get(key);
        if (dupRowNo !== undefined) {
          reasons.push('与表内第 ' + dupRowNo + ' 行重复（' + nameLabel + '相同），已跳过');
          status = 'error';
        } else {
          seenInFile.set(key, rowNo);
          const hit = existingByKey.get(key);
          if (hit) {
            existingId = Number(hit.id);
            if (mode === 'insert-only') {
              status = 'skip';
              reasons.push('档案已存在（仅新增模式不覆盖）：' + nameLabel + '「' + String(data.name) + '」');
            } else {
              const changed = fields.filter((f) => {
                const v = data[f.field];
                if (v === null || v === undefined) return false; // 只更新「非空字段」
                return String(hit[f.field] ?? '') !== String(v);
              });
              if (changed.length) {
                status = 'update';
                changedFields = changed.map((f) => f.field);
                reasons.push('将更新字段：' + changed.map((f) => f.label).join('、'));
              } else {
                status = 'skip';
                reasons.push('档案已存在且字段无变化');
              }
            }
          }
        }
      }

      out.push({ rowNo, status, reasons, data, raw, existingId, changedFields });
    });

    if (!out.length) throw new BadRequestException('表格表头之下没有数据行，请检查文件内容（可下载导入模板参考格式）');

    const summary: ImportSummary = {
      total: out.length,
      new: out.filter((r) => r.status === 'new').length,
      update: out.filter((r) => r.status === 'update').length,
      skip: out.filter((r) => r.status === 'skip').length,
      error: out.filter((r) => r.status === 'error').length,
    };
    this.logger.log(
      '导入预览（' + target + '，' + parsed.kind + '，' + mode + '）：共 ' + summary.total
      + ' 行，新增 ' + summary.new + '，更新 ' + summary.update + '，跳过 ' + summary.skip + '，错误 ' + summary.error,
    );
    return {
      target, mode, fileKind: parsed.kind,
      headerRowIndex: header.headerRowIndex,
      columns: header.columns,
      unmappedHeaders,
      summary,
      rows: out,
    };
  }

  /**
   * 确认导入：先按 preview 的同一套规则重新解析校验（解析失败 → 400，一个写都不发），
   * 再逐行事务写库；单行失败只记入 failures，不影响其它行。
   */
  async commit(input: ImportInput): Promise<ImportCommitResult> {
    const p = await this.preview(input); // 解析/表头失败在这里就抛出，此前无任何写操作
    const created: ImportCommitResult['created'] = [];
    const updated: ImportCommitResult['updated'] = [];
    const failures: ImportCommitResult['failures'] = [];
    let skipped = 0;

    for (const row of p.rows) {
      const name = String(row.data.name ?? '');
      if (row.status === 'error') {
        failures.push({ rowNo: row.rowNo, name, reason: row.reasons.join('；') });
        continue;
      }
      if (row.status === 'skip') { skipped += 1; continue; }
      try {
        const r = p.target === 'customers' ? await this.writeCustomer(row) : await this.writeProduct(row);
        if (row.status === 'new' && r.created) created.push({ rowNo: row.rowNo, id: r.id, name });
        else if (row.status === 'new') skipped += 1; // 事务内二次查重命中（并发/重复提交）→ 不重复建档
        else updated.push({ rowNo: row.rowNo, id: r.id, name, fields: row.changedFields ?? [] });
      } catch (e) {
        failures.push({ rowNo: row.rowNo, name, reason: (e as Error).message });
      }
    }

    const summary: ImportSummary = {
      total: p.summary.total,
      new: created.length,
      update: updated.length,
      skip: skipped,
      error: failures.length,
    };
    this.logger.log(
      '导入完成（' + p.target + '）：新增 ' + summary.new + '，更新 ' + summary.update
      + '，跳过 ' + summary.skip + '，失败 ' + summary.error,
    );
    return { target: p.target, mode: p.mode, summary, created, updated, failures };
  }

  // ============ 逐行写库（每行一个事务） ============

  private async writeCustomer(row: ImportPreviewRow): Promise<{ id: number; created: boolean }> {
    const name = String(row.data.name);
    return db.transaction(async (tx) => {
      if (row.status === 'update' && row.existingId) {
        const patch: Partial<NewCustomer> = { updatedAt: new Date() };
        if (row.data.contact !== null && row.data.contact !== undefined) patch.contact = String(row.data.contact);
        if (row.data.settlement) patch.settlement = row.data.settlement as Settlement;
        if (row.data.creditDays !== null && row.data.creditDays !== undefined) patch.creditDays = Number(row.data.creditDays);
        await tx.update(customers).set(patch).where(eq(customers.id, row.existingId));
        return { id: row.existingId, created: false };
      }
      // 仅新增：事务内二次查重（表间不存在唯一约束，应用层兜底避免重复档案）
      const dup = await tx.select({ id: customers.id, name: customers.name }).from(customers);
      const hit = dup.find((d) => normalizeToken(d.name) === normalizeToken(name));
      if (hit) return { id: hit.id, created: false };
      const [r] = await tx.insert(customers).values({
        name,
        contact: str(row.data.contact),
        settlement: (row.data.settlement as Settlement) ?? undefined,
        creditDays: row.data.creditDays === null || row.data.creditDays === undefined ? 0 : Number(row.data.creditDays),
      }).returning({ id: customers.id });
      return { id: r.id, created: true };
    });
  }

  private async writeProduct(row: ImportPreviewRow): Promise<{ id: number; created: boolean }> {
    const name = String(row.data.name);
    return db.transaction(async (tx) => {
      if (row.status === 'update' && row.existingId) {
        const patch: Partial<NewProduct> = { updatedAt: new Date() };
        if (row.data.type) patch.type = row.data.type as ProductType;
        if (row.data.defaultPackaging !== null && row.data.defaultPackaging !== undefined) patch.defaultPackaging = String(row.data.defaultPackaging);
        if (row.data.defaultRouting !== null && row.data.defaultRouting !== undefined) patch.defaultRouting = String(row.data.defaultRouting);
        if (row.data.safetyStock !== null && row.data.safetyStock !== undefined) patch.safetyStock = Number(row.data.safetyStock);
        await tx.update(products).set(patch).where(eq(products.id, row.existingId));
        return { id: row.existingId, created: false };
      }
      const dup = await tx.select({ id: products.id, name: products.name }).from(products);
      // 产品：文本归一 + 数字指纹都相等才算同一档案（0-GPN ≠ 00-GPN ≠ 000-GPN）
      const hit = dup.find((d) => productIdentityKey(d.name) === productIdentityKey(name));
      if (hit) return { id: hit.id, created: false };
      const [r] = await tx.insert(products).values({
        name,
        type: row.data.type as ProductType,
        defaultPackaging: str(row.data.defaultPackaging),
        defaultRouting: str(row.data.defaultRouting),
        safetyStock: row.data.safetyStock === null || row.data.safetyStock === undefined ? 0 : Number(row.data.safetyStock),
      }).returning({ id: products.id });
      return { id: r.id, created: true };
    });
  }

  // ============ 入参断言 ============

  private assertTarget(t: string): ImportTarget {
    if (!IMPORT_TARGETS.includes(t as ImportTarget)) {
      throw new BadRequestException('target 须为 customers（客户）或 products（产品），当前：' + (t ?? '空'));
    }
    return t as ImportTarget;
  }

  private assertMode(m?: string): ImportMode {
    if (!m) return 'insert-only';
    if (!IMPORT_MODES.includes(m as ImportMode)) {
      throw new BadRequestException('mode 须为 insert-only（仅新增）或 upsert（新增或更新），当前：' + m);
    }
    return m as ImportMode;
  }
}
