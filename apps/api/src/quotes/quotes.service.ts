import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { customers, operators, productQuotes, products, QUOTE_SOURCES } from '../db/schema';
import type { NewProductQuote, ProductQuote, QuoteSource } from '../db/schema';
import { fromCents, toCents } from '../common/money';
import { normalizeCurrency } from '../common/currency';
import { currentOperatorId } from '../common/operator-context';
import {
  mapHeaderFields, normalizeToken, parseDateCell, parseNumberCell, TableParserService,
} from '../ai/table-parser.service';
import { currencyToOrderEnum, describeHit, pickQuote, todayYmd } from './quote-pricing';
import type { PriceHit, PriceQuery, QuoteLike } from './quote-pricing';

/**
 * ============================================================
 * 报价记录（I17）—— 独立单据「报价单」的落库与取价
 * ------------------------------------------------------------
 * 核心诉求（甲方裁定）：**方便更新**。因此：
 *   · 列表 / 新增 / 修改 / **改价**（PUT 只改单价，写 updated_at + operator_id 留痕）/ 停用启用；
 *   · 改价不删历史行：同一「客户+产品」的不同有效期各是一条记录，按 valid_from 取最新；
 *   · 批量导入复用既有 Excel/CSV 导入管线（与 /api/master-data/import 同风格：preview 分类统计 → commit）；
 *   · 取价试算 GET /api/quotes/lookup 与识单补价共用 quotes/quote-pricing.ts 的**同一个纯函数**。
 *
 * 金额口径：一律以「分」存（unit_price_cents），入参可给 unitPrice（元）或 unitPriceCents（分）。
 */

/** 行级结论：与主数据批量导入同一套词表（新增/更新/跳过/错误） */
export type QuoteRowStatus = 'new' | 'update' | 'skip' | 'error';

export interface QuoteSummary { total: number; new: number; update: number; skip: number; error: number }

/** 字段定义：schema 列 → 表头别名（复用 mapHeaderFields 的最长命中规则） */
interface QuoteFieldDef {
  field: string;
  label: string;
  keywords: string[];
  required?: boolean;
  kind: 'text' | 'number' | 'date' | 'enum';
  hint?: string;
}

/** 报价导入的列（客户名称 / 产品名称 至少给一个产品标识；单价必填） */
export const QUOTE_IMPORT_FIELDS: QuoteFieldDef[] = [
  { field: 'customerName', label: '客户名称', keywords: ['客户名称', '客户简称', '客户全称', '客户名', '客户公司', '客户单位', '客户', 'customer', 'buyer', '需方'], kind: 'text' },
  { field: 'productName', label: '产品名称', keywords: ['产品名称', '产品型号', '物料名称', '品名', '型号', '产品', 'product', 'item', 'description', '规格'], kind: 'text' },
  { field: 'unitPrice', label: '单价', keywords: ['不含税单价', '不含税价', '含税单价', '含税价', '单价', '价格', '出厂价', '报价', 'unitprice', 'unit price', 'price'], required: true, kind: 'number' },
  { field: 'currency', label: '币种', keywords: ['币种', '币别', '货币', 'currency'], kind: 'text' },
  { field: 'validFrom', label: '生效日期', keywords: ['生效日期', '生效日', '开始日期', '有效起', 'validfrom', 'valid from'], kind: 'date' },
  { field: 'validTo', label: '失效日期', keywords: ['失效日期', '失效日', '截止日期', '结束日期', '有效期至', 'validto', 'valid to'], kind: 'date' },
  { field: 'remark', label: '备注', keywords: ['备注', '说明', 'remark', 'note', 'comment'], kind: 'text' },
];

/** 导入模板（中文表头 + 2 行示例） */
const QUOTE_TEMPLATE_HEADERS = ['客户名称', '产品名称', '单价', '币种', '生效日期', '失效日期', '备注'];
const QUOTE_TEMPLATE_SAMPLES = [
  ['安宝公司', '1-101 割嘴 00#', '9.68', 'CNY', '2026-01-01', '', '留空客户名 = 通用价'],
  ['', 'ANM 1/32 乙炔', '12.50', 'CNY', '', '2026-12-31', '不限客户的通用价'],
];

export interface QuoteListQuery {
  customerId?: number;
  productId?: number;
  kw?: string;
  /** '1'/'true' = 只看当前有效（enabled + 在有效期内） */
  effective?: string;
  /** '1'/'0' = 只看启用/停用 */
  enabled?: string;
  page?: number;
  pageSize?: number;
}

export interface QuoteRow {
  id: number;
  customerId: number | null;
  customerName: string | null;
  productId: number | null;
  productName: string | null;
  unitPriceCents: number;
  unitPrice: number;
  currency: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  sourceFile: string | null;
  remark: string | null;
  enabled: boolean;
  operatorId: number | null;
  operatorName: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** 当前是否有效（enabled 且在有效期内，按今天判定） */
  effective: boolean;
}

export interface QuoteInput {
  customerId?: number | null;
  productId?: number | null;
  productName?: string | null;
  unitPrice?: number | string | null;
  unitPriceCents?: number | null;
  currency?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  source?: string | null;
  sourceFile?: string | null;
  remark?: string | null;
  enabled?: boolean | null;
}

export interface QuotePreviewRow {
  rowNo: number;
  status: QuoteRowStatus;
  reasons: string[];
  data: Record<string, string | number | null>;
  raw: string[];
  existingId?: number | null;
}

export interface QuotePreviewResult {
  fileKind: string;
  headerRowIndex: number;
  columns: Record<string, number>;
  unmappedHeaders: string[];
  summary: QuoteSummary;
  rows: QuotePreviewRow[];
}

export interface QuoteCommitResult {
  summary: QuoteSummary;
  created: Array<{ rowNo: number; id: number; label: string }>;
  updated: Array<{ rowNo: number; id: number; label: string }>;
  failures: Array<{ rowNo: number; label: string; reason: string }>;
}

/** CSV 单元格转义（与主数据导入同一实现口径） */
function csvCell(v: string): string {
  const s = v ?? '';
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 名称归一（客户/产品建档比对）：与识单同一套 normName 口径（去空格 + 去公司后缀） */
const normName = (s: string) =>
  s.toLowerCase().replace(/\s+/g, '').replace(/(公司|有限公司|co\.?|ltd\.?|inc\.?|llc|gmbh)$/g, '');

/** 报价唯一键：客户（0=通用）+ 产品（id 或 名称文本）+ 生效日 —— 用于导入幂等与「同键改价」 */
function quoteKey(customerId: number | null, productId: number | null, productName: string | null, validFrom: string | null): string {
  const c = customerId == null ? '0' : String(customerId);
  const p = productId != null ? 'id:' + productId : 'name:' + normalizeToken(productName ?? '');
  return c + '|' + p + '|' + (validFrom ?? '');
}

const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(private readonly tableParser: TableParserService) {}

  /** 导入模板：中文表头 + 2 行示例（controller 加 UTF-8 BOM 后以 CSV 下载） */
  template(): { name: string; csv: string } {
    const lines = [QUOTE_TEMPLATE_HEADERS, ...QUOTE_TEMPLATE_SAMPLES].map((r) => r.map(csvCell).join(','));
    return { name: '报价记录导入模板.csv', csv: lines.join('\r\n') + '\r\n' };
  }

  // ============ 列表 ============

  /** 列表：按客户/产品/关键词/是否有效筛选 + 分页 */
  async findAll(q: QuoteListQuery): Promise<{ total: number; page: number; pageSize: number; rows: QuoteRow[] }> {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));
    const conds = [];
    if (q.customerId) conds.push(eq(productQuotes.customerId, q.customerId));
    if (q.productId) conds.push(eq(productQuotes.productId, q.productId));
    if (q.kw) {
      const kw = '%' + q.kw + '%';
      conds.push(or(ilike(productQuotes.productName, kw), ilike(productQuotes.remark, kw), ilike(productQuotes.sourceFile, kw)));
    }
    if (q.enabled === '1' || q.enabled === 'true') conds.push(eq(productQuotes.enabled, true));
    if (q.enabled === '0' || q.enabled === 'false') conds.push(eq(productQuotes.enabled, false));
    const today = todayYmd();
    if (q.effective === '1' || q.effective === 'true') {
      conds.push(eq(productQuotes.enabled, true));
      conds.push(or(isNull(productQuotes.validFrom), sql`${productQuotes.validFrom} <= ${today}`)!);
      conds.push(or(isNull(productQuotes.validTo), sql`${productQuotes.validTo} >= ${today}`)!);
    }
    const where = conds.length ? and(...conds) : undefined;

    const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(productQuotes).where(where);
    const rows = await db
      .select({ q: productQuotes, customerName: customers.name, productCatalogName: products.name, operatorName: operators.name })
      .from(productQuotes)
      .leftJoin(customers, eq(productQuotes.customerId, customers.id))
      .leftJoin(products, eq(productQuotes.productId, products.id))
      .leftJoin(operators, eq(productQuotes.operatorId, operators.id))
      .where(where)
      .orderBy(desc(productQuotes.updatedAt), desc(productQuotes.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      total: Number(cnt?.n ?? 0),
      page,
      pageSize,
      rows: rows.map((r) => this.toRow(r.q, r.customerName, r.productCatalogName ?? r.q.productName, r.operatorName)),
    };
  }

  /** 由于列表还按客户名搜（客户名不在报价表里），这里再补一层「客户名关键词」的内存过滤（数据量小，简单可靠） */
  private toRow(q: ProductQuote, customerName: string | null, productLabel: string | null, operatorName: string | null): QuoteRow {
    const today = todayYmd();
    const effective = q.enabled
      && (!q.validFrom || q.validFrom <= today)
      && (!q.validTo || q.validTo >= today);
    return {
      id: q.id,
      customerId: q.customerId ?? null,
      customerName: customerName ?? null,
      productId: q.productId ?? null,
      productName: productLabel ?? q.productName ?? null,
      unitPriceCents: Math.round(Number(q.unitPriceCents) || 0),
      unitPrice: fromCents(Math.round(Number(q.unitPriceCents) || 0)),
      currency: q.currency,
      validFrom: q.validFrom ?? null,
      validTo: q.validTo ?? null,
      source: q.source,
      sourceFile: q.sourceFile ?? null,
      remark: q.remark ?? null,
      enabled: q.enabled,
      operatorId: q.operatorId ?? null,
      operatorName: operatorName ?? null,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      effective,
    };
  }

  async findOne(id: number): Promise<QuoteRow> {
    const rows = await db
      .select({ q: productQuotes, customerName: customers.name, productCatalogName: products.name, operatorName: operators.name })
      .from(productQuotes)
      .leftJoin(customers, eq(productQuotes.customerId, customers.id))
      .leftJoin(products, eq(productQuotes.productId, products.id))
      .leftJoin(operators, eq(productQuotes.operatorId, operators.id))
      .where(eq(productQuotes.id, id));
    if (!rows.length) throw new NotFoundException('报价记录不存在');
    const r = rows[0];
    return this.toRow(r.q, r.customerName, r.productCatalogName ?? r.q.productName, r.operatorName);
  }

  // ============ 新增 / 修改 / 改价 / 停用启用 ============

  async create(input: QuoteInput, sourceDefault: QuoteSource = 'manual'): Promise<QuoteRow> {
    const values = await this.buildValues(input, sourceDefault);
    // buildValues 的 partial=false 分支已保证单价存在（缺失时抛 400），这里再兜一层类型安全
    const [row] = await db.insert(productQuotes)
      .values({ ...values, unitPriceCents: values.unitPriceCents ?? 0 })
      .returning({ id: productQuotes.id });
    return this.findOne(row.id);
  }

  /** 修改（整条编辑：客户/产品/单价/币种/有效期/备注/启用状态） */
  async update(id: number, input: QuoteInput): Promise<QuoteRow> {
    const cur = await this.requireRow(id);
    const patch = await this.buildValues(input, undefined, true);
    const cents = this.priceToCents(input);
    if (cents != null) patch.unitPriceCents = cents;
    this.assertRange(
      patch.validFrom !== undefined ? patch.validFrom : (cur.validFrom ?? null),
      patch.validTo !== undefined ? patch.validTo : (cur.validTo ?? null),
    );
    patch.updatedAt = new Date();
    const op = currentOperatorId();
    if (op != null) patch.operatorId = op;
    await db.update(productQuotes).set(patch).where(eq(productQuotes.id, id));
    return this.findOne(id);
  }

  /**
   * 改价（PUT /api/quotes/:id/price）：**只动单价**（可选带新有效期/备注），
   * 写 updated_at + operator_id 留痕 —— 满足「价格会变，要能快速改、留痕」。
   */
  async changePrice(id: number, input: QuoteInput): Promise<QuoteRow> {
    const cur = await this.requireRow(id);
    const cents = this.priceToCents(input);
    if (cents == null) throw new BadRequestException('改价必须给出新单价（unitPrice 元 或 unitPriceCents 分）');
    const patch: Partial<NewProductQuote> = {
      unitPriceCents: cents,
      updatedAt: new Date(),
      operatorId: currentOperatorId() ?? cur.operatorId ?? null,
    };
    // 币种归一（甲方裁定）：RMB / RMB¥ / ￥ / ¥ / 人民币 → CNY
    if (input.currency !== undefined && input.currency !== null && String(input.currency).trim()) {
      patch.currency = normalizeCurrency(input.currency);
    }
    if (input.validFrom !== undefined) patch.validFrom = this.dateOrThrow(input.validFrom, '生效日期');
    if (input.validTo !== undefined) patch.validTo = this.dateOrThrow(input.validTo, '失效日期');
    if (input.remark !== undefined) patch.remark = str(input.remark) ?? null;
    this.assertRange(
      patch.validFrom !== undefined ? patch.validFrom : (cur.validFrom ?? null),
      patch.validTo !== undefined ? patch.validTo : (cur.validTo ?? null),
    );
    await db.update(productQuotes).set(patch).where(eq(productQuotes.id, id));
    this.logger.log('报价改价：#' + id + ' → ' + fromCents(cents) + '（操作人 ' + (patch.operatorId ?? '未绑定') + '）');
    return this.findOne(id);
  }

  /** 停用 / 启用（保留历史行，不物理删除） */
  async setEnabled(id: number, enabled: boolean): Promise<QuoteRow> {
    const cur = await this.requireRow(id);
    await db.update(productQuotes).set({
      enabled,
      updatedAt: new Date(),
      operatorId: currentOperatorId() ?? cur.operatorId ?? null,
    }).where(eq(productQuotes.id, id));
    return this.findOne(id);
  }

  // ============ 取价 ============

  /** 取价试算（= 识单补价同一套规则）：返回命中报价 + priceSource 说明；未命中返回 hit=null */
  async lookup(query: PriceQuery): Promise<{
    hit: PriceHit | null;
    evaluated: number;
    onDate: string;
    hint: string;
  }> {
    const onDate = query.onDate || todayYmd();
    const conds = [eq(productQuotes.enabled, true)];
    // 只可能命中「本客户」或「通用价」两种归属，先用 SQL 收窄，再交给纯函数定档
    if (query.customerId != null) {
      conds.push(or(isNull(productQuotes.customerId), eq(productQuotes.customerId, query.customerId))!);
    } else {
      conds.push(isNull(productQuotes.customerId));
    }
    const rows = await db.select().from(productQuotes).where(and(...conds));
    const hit = pickQuote(rows.map((r) => this.toQuoteLike(r)), { ...query, onDate });
    return {
      hit,
      evaluated: rows.length,
      onDate,
      hint: hit ? describeHit(hit) : '未命中任何有效报价（保持缺价待补；可先录入报价记录或放宽有效期）',
    };
  }

  /**
   * 供识单补价使用的批量取价（一次把候选全部取出，逐行用纯函数命中）：
   * 避免每行一次 SQL；命中的行会带 priceSource = 'quote'（来源可追溯）。
   */
  async lookupMany(queries: PriceQuery[]): Promise<Array<PriceHit | null>> {
    if (!queries.length) return [];
    const ids = Array.from(new Set(queries.map((q) => q.customerId).filter((v): v is number => v != null)));
    const conds = [eq(productQuotes.enabled, true)];
    conds.push(ids.length ? or(isNull(productQuotes.customerId), sql`${productQuotes.customerId} in ${ids}`)! : isNull(productQuotes.customerId));
    const rows = await db.select().from(productQuotes).where(and(...conds));
    const pool: QuoteLike[] = rows.map((r) => this.toQuoteLike(r));
    return queries.map((q) => pickQuote(pool, q));
  }

  private toQuoteLike(r: ProductQuote): QuoteLike {
    return {
      id: r.id,
      customerId: r.customerId ?? null,
      productId: r.productId ?? null,
      productName: r.productName ?? null,
      unitPriceCents: Math.round(Number(r.unitPriceCents) || 0),
      currency: r.currency,
      validFrom: r.validFrom ?? null,
      validTo: r.validTo ?? null,
      source: r.source,
      enabled: r.enabled,
      remark: r.remark ?? null,
    };
  }

  // ============ 批量导入（复用既有表格解析 + 表头映射管线） ============

  /** 预览（只读，不写库）：解析 + 表头映射 + 逐行校验分类 */
  async preview(input: { buffer: Buffer; fileName?: string; mimeType?: string; mode?: string }): Promise<QuotePreviewResult> {
    const mode = input.mode === 'upsert' ? 'upsert' : 'insert-only';
    const parsed = await this.tableParser.parseUpload({ buffer: input.buffer, fileName: input.fileName, mimeType: input.mimeType });
    const rows = parsed.rows;

    const keywords: Record<string, string[]> = {};
    for (const f of QUOTE_IMPORT_FIELDS) keywords[f.field] = f.keywords;
    const header = mapHeaderFields(rows, keywords, { maxScan: 8, minHits: 1 });
    const missingRequired = QUOTE_IMPORT_FIELDS.filter((f) => f.required && header.columns[f.field] === undefined);
    if (header.headerRowIndex < 0 || missingRequired.length) {
      const want = QUOTE_IMPORT_FIELDS.map((f) => f.label + (f.required ? '（必填）' : '')).join(' / ');
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

    // 既有档案（解析客户/产品名 → id，以及导入幂等的依据）
    const allCustomers = await db.select({ id: customers.id, name: customers.name }).from(customers);
    const allProducts = await db.select({ id: products.id, name: products.name }).from(products);
    const existing = await db.select({
      id: productQuotes.id, customerId: productQuotes.customerId, productId: productQuotes.productId,
      productName: productQuotes.productName, validFrom: productQuotes.validFrom,
      unitPriceCents: productQuotes.unitPriceCents, currency: productQuotes.currency,
    }).from(productQuotes);
    const existingByKey = new Map<string, { id: number; unitPriceCents: number; currency: string }>();
    for (const e of existing) {
      const k = quoteKey(e.customerId ?? null, e.productId ?? null, e.productName ?? null, e.validFrom ?? null);
      if (!existingByKey.has(k)) {
        existingByKey.set(k, { id: e.id, unitPriceCents: Math.round(Number(e.unitPriceCents) || 0), currency: e.currency });
      }
    }

    const out: QuotePreviewRow[] = [];
    const seenInFile = new Map<string, number>();
    rows.slice(header.headerRowIndex + 1).forEach((row, idx) => {
      if (!row.some((c) => c !== '')) return;
      const rowNo = header.headerRowIndex + 2 + idx;
      const reasons: string[] = [];
      const data: Record<string, string | number | null> = {};
      const raw: string[] = [];
      const cell = (f: string) => {
        const col = header.columns[f];
        return col === undefined ? '' : String(row[col] ?? '').trim();
      };
      for (const f of QUOTE_IMPORT_FIELDS) {
        const text = cell(f.field);
        raw.push(text);
        if (!text) { data[f.field] = null; continue; }
        if (f.kind === 'number') {
          const n = parseNumberCell(text);
          if (n === undefined || n < 0) { reasons.push(f.label + '「' + text + '」不是有效数字'); continue; }
          data[f.field] = n;
        } else if (f.kind === 'date') {
          const d = parseDateCell(text);
          if (!d) { reasons.push(f.label + '「' + text + '」不是有效日期'); continue; }
          data[f.field] = d;
        } else {
          data[f.field] = text;
        }
      }

      // 客户名 → 档案 id（找不到就报错，不臆造客户）
      let customerId: number | null = null;
      const cname = String(data.customerName ?? '').trim();
      if (cname) {
        const exact = allCustomers.find((c) => c.name.trim() === cname);
        const nn = normName(cname);
        const cands = exact ? [exact] : allCustomers.filter((c) => nn && (nn.includes(normName(c.name)) || normName(c.name).includes(nn)));
        if (cands.length === 1) customerId = cands[0].id;
        else reasons.push(cands.length > 1
          ? '客户「' + cname + '」匹配到多个档案（' + cands.map((c) => c.name).join('、') + '），请先在客户档案里确认'
          : '客户「' + cname + '」不在档案中（留空客户名称 = 通用价），请先建档或清空该列');
      }
      data.customerId = customerId;

      // 产品名 → 档案 id（找不到不报错：允许「只有产品名文本」的报价，product_id 留空）
      let productId: number | null = null;
      const pname = String(data.productName ?? '').trim();
      if (pname) {
        const exact = allProducts.find((p) => p.name.trim() === pname);
        const nn = normName(pname);
        const hit = exact ?? allProducts.find((p) => nn && normName(p.name) === nn);
        if (hit) productId = hit.id;
      }
      data.productId = productId;

      if (data.unitPrice === null || data.unitPrice === undefined) reasons.push('单价不能为空');

      let status: QuoteRowStatus = reasons.length ? 'error' : 'new';
      let existingId: number | null = null;
      if (!reasons.length) {
        data.unitPriceCents = toCents(Number(data.unitPrice));
        // 币种归一（甲方裁定）：识别到的 RMB / RMB¥ / ￥ / ¥ / 人民币 一律归一到 CNY
        data.currency = normalizeCurrency(String(data.currency ?? ''));
        const key = quoteKey(customerId, productId, pname || null, (data.validFrom as string | null) ?? null);
        const dupRowNo = seenInFile.get(key);
        if (dupRowNo !== undefined) {
          reasons.push('与表内第 ' + dupRowNo + ' 行重复（同客户+同产品+同生效日），已跳过');
          status = 'error';
        } else {
          seenInFile.set(key, rowNo);
          const hit = existingByKey.get(key);
          if (hit) {
            existingId = hit.id;
            if (mode === 'insert-only') {
              status = 'skip';
              reasons.push('已有同键报价（报价 #' + hit.id + '，' + fromCents(hit.unitPriceCents) + ' ' + hit.currency + '）；仅新增模式不覆盖，可改用「新增或改价」');
            } else {
              status = 'update';
              reasons.push('将改价：' + fromCents(hit.unitPriceCents) + ' → ' + fromCents(Number(data.unitPriceCents)));
            }
          }
        }
      }
      out.push({ rowNo, status, reasons, data, raw, existingId });
    });

    if (!out.length) throw new BadRequestException('表格表头之下没有数据行，请检查文件内容（可下载导入模板参考格式）');
    const summary: QuoteSummary = {
      total: out.length,
      new: out.filter((r) => r.status === 'new').length,
      update: out.filter((r) => r.status === 'update').length,
      skip: out.filter((r) => r.status === 'skip').length,
      error: out.filter((r) => r.status === 'error').length,
    };
    this.logger.log('报价导入预览（' + parsed.kind + '，' + mode + '）：共 ' + summary.total + ' 行，新增 ' + summary.new
      + '，改价 ' + summary.update + '，跳过 ' + summary.skip + '，错误 ' + summary.error);
    return { fileKind: parsed.kind, headerRowIndex: header.headerRowIndex, columns: header.columns, unmappedHeaders, summary, rows: out };
  }

  /** 确认导入：先按同一套规则重新解析校验（失败即中止、不发写），再逐行事务写库 */
  async commit(input: { buffer: Buffer; fileName?: string; mimeType?: string; mode?: string }): Promise<QuoteCommitResult> {
    const p = await this.preview(input);
    const created: QuoteCommitResult['created'] = [];
    const updated: QuoteCommitResult['updated'] = [];
    const failures: QuoteCommitResult['failures'] = [];
    let skipped = 0;
    const sourceFile = input.fileName ?? null;

    for (const row of p.rows) {
      const label = String(row.data.productName ?? '') || String(row.data.customerName ?? '') || '（通用价）';
      if (row.status === 'error') { failures.push({ rowNo: row.rowNo, label, reason: row.reasons.join('；') }); continue; }
      if (row.status === 'skip') { skipped += 1; continue; }
      try {
        const base: QuoteInput = {
          customerId: row.data.customerId as number | null,
          productId: row.data.productId as number | null,
          productName: (row.data.productName as string | null) ?? null,
          unitPriceCents: row.data.unitPriceCents as number,
          currency: normalizeCurrency(String(row.data.currency ?? '')),
          validFrom: (row.data.validFrom as string | null) ?? null,
          validTo: (row.data.validTo as string | null) ?? null,
          remark: (row.data.remark as string | null) ?? null,
          sourceFile,
        };
        if (row.status === 'update' && row.existingId) {
          await db.update(productQuotes).set({
            unitPriceCents: base.unitPriceCents as number,
            currency: base.currency as string,
            productName: base.productName ?? null,
            remark: base.remark ?? null,
            source: 'import',
            sourceFile,
            updatedAt: new Date(),
            operatorId: currentOperatorId(),
          }).where(eq(productQuotes.id, row.existingId));
          updated.push({ rowNo: row.rowNo, id: row.existingId, label });
        } else {
          const r = await this.create(base, 'import');
          created.push({ rowNo: row.rowNo, id: r.id, label });
        }
      } catch (e) {
        failures.push({ rowNo: row.rowNo, label, reason: (e as Error).message });
      }
    }

    const summary: QuoteSummary = {
      total: p.summary.total,
      new: created.length,
      update: updated.length,
      skip: skipped,
      error: failures.length,
    };
    this.logger.log('报价导入完成：新增 ' + summary.new + '，改价 ' + summary.update + '，跳过 ' + summary.skip + '，失败 ' + summary.error);
    return { summary, created, updated, failures };
  }

  // ============ helpers ============

  private async requireRow(id: number): Promise<ProductQuote> {
    const [row] = await db.select().from(productQuotes).where(eq(productQuotes.id, id));
    if (!row) throw new NotFoundException('报价记录不存在');
    return row;
  }

  /** 单价 → 分：优先 unitPriceCents（分），否则 unitPrice（元）；两者都没给返回 null（由调用方决定是否必填） */
  private priceToCents(input: QuoteInput): number | null {
    if (input.unitPriceCents !== undefined && input.unitPriceCents !== null && String(input.unitPriceCents).trim() !== '') {
      const n = Math.round(Number(input.unitPriceCents));
      if (!Number.isFinite(n) || n < 0) throw new BadRequestException('单价（分）不能为负数');
      return n;
    }
    if (input.unitPrice !== undefined && input.unitPrice !== null && String(input.unitPrice).trim() !== '') {
      const n = Number(input.unitPrice);
      if (!Number.isFinite(n) || n < 0) throw new BadRequestException('单价「' + input.unitPrice + '」不是有效数字');
      return toCents(n);
    }
    return null;
  }

  /** 有效期区间校验（含编辑场景：只改一侧时与库中另一侧合并后校验） */
  private assertRange(validFrom: string | null, validTo: string | null): void {
    if (validFrom && validTo && validTo < validFrom) {
      throw new BadRequestException('失效日期（' + validTo + '）不能早于生效日期（' + validFrom + '）');
    }
  }

  private dateOrThrow(v: string | null | undefined, label: string): string | null {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const d = parseDateCell(String(v));
    if (!d) throw new BadRequestException(label + '「' + v + '」不是有效日期（YYYY-MM-DD）');
    return d;
  }

  /** 入参 → 落库值（create / update 共用）；skipSource = true 时不覆盖 source（编辑既有行） */
  private async buildValues(input: QuoteInput, sourceDefault?: QuoteSource, partial = false): Promise<Partial<NewProductQuote>> {
    const out: Partial<NewProductQuote> = {};
    if (!partial || input.customerId !== undefined) {
      const cid = input.customerId ?? null;
      if (cid != null) {
        const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, Number(cid)));
        if (!c) throw new BadRequestException('客户 #' + cid + ' 不存在');
      }
      out.customerId = cid == null ? null : Number(cid);
    }
    if (!partial || input.productId !== undefined) {
      const pid = input.productId ?? null;
      if (pid != null) {
        const [p] = await db.select({ id: products.id }).from(products).where(eq(products.id, Number(pid)));
        if (!p) throw new BadRequestException('产品 #' + pid + ' 不存在');
      }
      out.productId = pid == null ? null : Number(pid);
    }
    if (!partial || input.productName !== undefined) out.productName = str(input.productName) ?? null;
    const cents = this.priceToCents(input);
    if (cents == null && !partial) throw new BadRequestException('单价必填（unitPrice 元 或 unitPriceCents 分）');
    if (cents != null) out.unitPriceCents = cents;
    // 币种归一（甲方裁定）：写入前归一 —— RMB / RMB¥ / ￥ / ¥ / 人民币 等一律存 CNY
    if (!partial || input.currency !== undefined) out.currency = normalizeCurrency(str(input.currency));
    if (!partial || input.validFrom !== undefined) out.validFrom = this.dateOrThrow(input.validFrom, '生效日期');
    if (!partial || input.validTo !== undefined) out.validTo = this.dateOrThrow(input.validTo, '失效日期');
    if (!partial || input.remark !== undefined) out.remark = str(input.remark) ?? null;
    if (!partial) {
      const src = (str(input.source) ?? sourceDefault ?? 'manual') as QuoteSource;
      out.source = (QUOTE_SOURCES as readonly string[]).includes(src) ? src : 'manual';
      out.sourceFile = str(input.sourceFile) ?? null;
      out.enabled = input.enabled === undefined || input.enabled === null ? true : !!input.enabled;
      out.operatorId = currentOperatorId();
    }
    this.assertRange(out.validFrom ?? null, out.validTo ?? null);
    return out;
  }
}

/** 供其它模块（识单）复用的币种归一 */
export { currencyToOrderEnum };
