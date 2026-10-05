import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as iconv from 'iconv-lite';
import type { ParsedOrder, ParsedOrderLine } from './order-parser.service';

/**
 * 表格订单解析（新增）：xlsx / csv → 二维矩阵 → 表头规则映射 → 紧凑文本（LLM 兜底映射用）。
 *
 * 设计取向与既有「确定性为骨」一致：
 * - 规则映射（关键词命中表头）命中齐全时**完全不调用 LLM**，结果可复现、离线可用；
 * - 命中率不足（缺客户/产品/数量/单价任一列，或没有数据行）才把表格前 N 行转紧凑文本，
 *   交给既有 LLM 网关做语义映射，并要求返回与图片识别同构的 JSON（见 order-parser.service）。
 *
 * 说明：本文件刻意不使用模板字符串（便于本仓库批量生成/审查），字符串拼接统一用 + 与 join。
 */

/** 支持的上传文件类型（图片走既有 vision 通道，不在此列） */
export type TableFileKind = 'xlsx' | 'csv' | 'xls' | 'pdf' | 'image' | 'unsupported';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

/** 文件类型判定：优先扩展名，其次 MIME（两者都拿不到 → unsupported） */
export function detectTableFileKind(fileName?: string, mimeType?: string): TableFileKind {
  const name = (fileName ?? '').toLowerCase().trim();
  const mime = (mimeType ?? '').toLowerCase().trim();
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.tsv')) return 'csv'; // 制表符分隔同样按 CSV 管线处理（分隔符自动探测）
  if (name.endsWith('.xls')) return 'xls';
  if (name.endsWith('.pdf')) return 'pdf';
  if (IMAGE_EXT.some((e) => name.endsWith(e))) return 'image';

  if (mime.includes('spreadsheetml')) return 'xlsx';
  if (mime === 'application/vnd.ms-excel') return 'xls';
  if (mime === 'text/csv' || mime === 'text/tab-separated-values' || mime === 'application/csv') return 'csv';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return 'unsupported';
}

// ============ CSV：解码（GBK / UTF-8 自动识别） ============

/** 字节流 → 文本：BOM 优先；UTF-8 非法字节序列 → 回退 GBK（Excel 中文版另存的 CSV 常见编码） */
export function decodeTextBuffer(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8(bom)' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.subarray(2), 'utf-16le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.subarray(2), 'utf-16be'), encoding: 'utf-16be' };
  }
  try {
    // fatal:true：出现非法 UTF-8 序列即抛错 → 判定为非 UTF-8（如 GBK）
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'utf-8' };
  } catch {
    return { text: iconv.decode(buf, 'gbk'), encoding: 'gbk' };
  }
}

/** 分隔符探测：首个非空行的引号外统计 , \t ; 出现次数，取最多者（全 0 则逗号） */
export function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const counts: Record<string, number> = { ',': 0, '\t': 0, ';': 0 };
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * CSV/TSV 解析（RFC4180 子集）：支持双引号包裹、字段内换行、"" 转义、CRLF/CR/LF。
 * 宽容处理：非字段起始位置的引号按字面字符处理，不抛错（客户表格常有脏数据）。
 */
export function parseCsvText(text: string, delimiter?: string): string[][] {
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false; // 当前字段是否已开始（决定引号是否作为包裹符）

  const endField = () => { row.push(field.trim()); field = ''; started = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
      continue;
    }
    if (c === '"' && !started) { inQuotes = true; started = true; continue; }
    if (c === d) { endField(); continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
      continue;
    }
    if (c === '\n') { endRow(); continue; }
    field += c;
    started = true;
  }
  if (field.length > 0 || row.length > 0) endRow();
  // 去掉尾部空行
  return rows.filter((r) => r.some((c) => c !== ''));
}

// ============ xlsx：exceljs 读第一个工作表 ============

const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtDate = (d: Date) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

/** exceljs 单元格值 → 字符串（Date/富文本/公式/超链接/错误值 全覆盖） */
export function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('').trim();
    }
    if ('text' in o) return String(o.text ?? '').trim();
    if ('result' in o) return cellToString(o.result);
    if ('error' in o) return '';
  }
  return String(v).trim();
}

/** Excel 日期序列号（1900 系统）→ YYYY-MM-DD */
export function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return fmtDate(new Date(ms));
}

/** 读取 .xlsx 第一个工作表为二维字符串矩阵；无工作表/空表 → 中文报错 */
export async function readXlsxMatrix(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new BadRequestException('Excel 中没有可读的工作表，请检查文件');
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[]; // 1-based（[0] 为空位）
    const cells: string[] = [];
    for (let i = 1; i < values.length; i++) cells.push(cellToString(values[i]));
    rows.push(cells);
  });
  if (!rows.length) throw new BadRequestException('Excel 第一个工作表是空的，没有可识别的订单内容');
  return rows;
}

/** 规范化：全角空格/不可见字符清理，去空行，右侧空列补齐（保持矩形便于按列取数） */
export function normalizeMatrix(rows: string[][]): string[][] {
  const clean = rows.map((r) =>
    r.map((c) => (c ?? '').replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').trim()),
  );
  const nonEmpty = clean.filter((r) => r.some((c) => c !== ''));
  if (!nonEmpty.length) return [];
  const width = Math.max(...nonEmpty.map((r) => r.length));
  return nonEmpty.map((r) => {
    const out = r.slice();
    while (out.length < width) out.push('');
    return out;
  });
}

// ============ 表头规则映射 ============

/** 可映射字段（客户/PO/产品/数量/单价/币种/交期/备注/刻字/包装） */
export const TABLE_FIELDS = [
  'customer', 'poNo', 'productName', 'quantity', 'unitPrice',
  'currency', 'dueDate', 'note', 'engraving', 'packaging',
] as const;
export type TableField = (typeof TABLE_FIELDS)[number];

/** 表头关键词（大小写不敏感、去空格后 includes 匹配；先命中者先占列） */
const HEADER_KEYWORDS: Record<TableField, string[]> = {
  customer: ['客户名称', '客户名', '客户', 'customer', 'buyer', '需方'],
  poNo: ['客户po', 'po号', 'pono', 'po no', '订单号', '采购订单号', 'orderno', 'order no', 'p/o', 'po'],
  productName: ['产品名称', '品名', '型号', '产品', 'product', 'item', 'description', '规格'],
  quantity: ['数量', '订购数量', 'qty', 'quantity', 'pcs'],
  unitPrice: ['单价', '价格', 'unitprice', 'unit price', 'price'],
  currency: ['币种', '货币', 'currency'],
  dueDate: ['交期', '交货日期', '交货期', '交货时间', '出货日期', 'delivery', 'duedate', 'due date', 'eta'],
  note: ['备注', '说明', 'remark', 'note', 'comment'],
  engraving: ['刻字', '印刷', 'engraving', 'logo'],
  packaging: ['包装要求', '包装', 'packing', 'packaging'],
};

/** 规则映射「齐全」所需的四个关键列（缺任一 → 需要 LLM 兜底映射） */
export const REQUIRED_TABLE_FIELDS: TableField[] = ['customer', 'productName', 'quantity', 'unitPrice'];

const normHeader = (s: string) => (s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[（）()：:*]/g, '');

export interface TableMapping {
  /** 命中表头所在行下标；-1 = 未识别出表头 */
  headerRowIndex: number;
  /** 字段 → 列下标 */
  columns: Partial<Record<TableField, number>>;
  /** 关键列命中数（满分 4） */
  requiredHits: number;
  hitRate: number;
  /** 关键列是否齐全（规则映射足够，无需 LLM） */
  sufficient: boolean;
  /** 缺失的关键列 */
  missingRequired: TableField[];
  headerRow: string[];
}

/**
 * 表头识别：在前 min(8, 行数) 行内挑选「命中关键词最多且 ≥2」的行作为表头。
 * 客户表格常见「抬头 2~3 行 + 表头 + 数据行」，逐行打分比「永远取第一行」稳。
 */
export function mapHeader(rows: string[][]): TableMapping {
  const scan = Math.min(rows.length, 8);
  let best = { idx: -1, score: 0, columns: {} as Partial<Record<TableField, number>> };
  for (let r = 0; r < scan; r++) {
    const columns: Partial<Record<TableField, number>> = {};
    let score = 0;
    rows[r].forEach((cell, c) => {
      const h = normHeader(cell);
      if (!h) return;
      // 取「最长命中的关键词」所属字段：避免「客户PO号」被「客户」抢先吃掉（应归 poNo）
      let bestField: TableField | null = null;
      let bestLen = 0;
      for (const f of TABLE_FIELDS) {
        for (const k of HEADER_KEYWORDS[f]) {
          const nk = normHeader(k);
          if (nk && h.includes(nk) && nk.length > bestLen) { bestField = f; bestLen = nk.length; }
        }
      }
      if (bestField && columns[bestField] === undefined) { columns[bestField] = c; score += 1; }
    });
    if (score > best.score) best = { idx: r, score, columns };
  }
  if (best.score < 2) {
    // 未识别出表头：全部字段视为缺失（交给 LLM 兜底）
    best = { idx: -1, score: 0, columns: {} };
  }
  const missingRequired = REQUIRED_TABLE_FIELDS.filter((f) => best.columns[f] === undefined);
  const requiredHits = REQUIRED_TABLE_FIELDS.length - missingRequired.length;
  return {
    headerRowIndex: best.idx,
    columns: best.columns,
    requiredHits,
    hitRate: requiredHits / REQUIRED_TABLE_FIELDS.length,
    sufficient: best.idx >= 0 && requiredHits === REQUIRED_TABLE_FIELDS.length,
    missingRequired,
    headerRow: best.idx >= 0 ? rows[best.idx] : [],
  };
}

/** 单元格 → 数字：剥离货币符号/千分位/中文单位/全角字符 */
export function parseNumberCell(v: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v)
    // 全角 → 半角（数字 ０-９ 与小数点 ．一并归一，避免「３．５」被截成 3）
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,]/g, '')
    .replace(/(pcs|pc|usd|rmb|cny|元|只|个|件|套|支|箱|￥|¥|\$|€)/gi, '')
    .replace(/\s+/g, '')
    .trim();
  if (!s) return undefined;
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

/** 单元格 → YYYY-MM-DD：支持 2026-09-30 / 2026/9/30 / 2026年9月30日 / 20260930 / 9/30/2026 / Excel 序列号 */
export function parseDateCell(v: string): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  let m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    // 月/日 二义：>12 的一方为日；均 ≤12 时按 月/日（外贸单据惯例）
    if (a > 12 && b <= 12) return validDate(y, b, a);
    return validDate(y, a, b);
  }
  m = s.match(/^(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (m) return validDate(new Date().getFullYear(), +m[1], +m[2]);
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 80000) return excelSerialToDate(n); // Excel 日期序列号
  }
  return undefined;
}

function validDate(y: number, mo: number, d: number): string | undefined {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return y + '-' + pad2(mo) + '-' + pad2(d);
}

export interface RuleMapResult {
  parsed: ParsedOrder;
  mapping: TableMapping;
  /** 数据行数（表头之后非空行） */
  dataRowCount: number;
  notes: string[];
}

/**
 * 规则映射：表头映射 + 逐行取数 → 与图片识别同构的 ParsedOrder（一张订单 + 多行明细）。
 * 单头字段（客户/PO/交期/备注）取「列内首个非空值」；每行可含不同产品/数量/单价。
 */
export function ruleMapMatrix(rows: string[][]): RuleMapResult {
  const mapping = mapHeader(rows);
  const columns = mapping.columns;
  const dataRows = mapping.headerRowIndex >= 0 ? rows.slice(mapping.headerRowIndex + 1) : rows;
  const pick = (row: string[], f: TableField): string => {
    const c = columns[f];
    if (c === undefined) return '';
    return (row[c] ?? '').trim();
  };

  const notes: string[] = [];
  let customerName = '';
  let poNo = '';
  let dueDateRaw = '';
  let note = '';
  let currency: 'RMB' | 'USD' | undefined;

  const lines: ParsedOrderLine[] = [];
  let dataRowCount = 0;
  for (const row of dataRows) {
    if (!row.some((c) => c !== '')) continue;
    dataRowCount += 1;
    if (!customerName) customerName = pick(row, 'customer');
    if (!poNo) poNo = pick(row, 'poNo');
    if (!dueDateRaw) dueDateRaw = pick(row, 'dueDate');
    if (!note) note = pick(row, 'note');
    if (!currency) {
      const cur = pick(row, 'currency').toUpperCase();
      if (cur.includes('USD') || cur.includes('$') || cur.includes('美元')) currency = 'USD';
      else if (cur.includes('RMB') || cur.includes('CNY') || cur.includes('￥') || cur.includes('¥') || cur.includes('元')) currency = 'RMB';
    }
    const productName = pick(row, 'productName');
    const quantity = parseNumberCell(pick(row, 'quantity'));
    const unitPrice = parseNumberCell(pick(row, 'unitPrice'));
    const engraving = pick(row, 'engraving');
    const packagingText = pick(row, 'packaging') || pick(row, 'note');
    lines.push({
      productName,
      quantity,
      unitPrice,
      currency,
      engraving: engraving || undefined,
      packagingText: packagingText || undefined,
    });
  }

  const dueDate = dueDateRaw ? parseDateCell(dueDateRaw) : undefined;
  if (dueDateRaw && !dueDate) notes.push('交期「' + dueDateRaw + '」无法解析为日期，已留空待人工补填');
  if (mapping.missingRequired.length) {
    notes.push('表格缺少关键列（' + mapping.missingRequired.join('、') + '），已尝试语义映射');
  }

  return {
    parsed: {
      customerName,
      poNo: poNo || undefined,
      dueDate,
      note: note || undefined,
      lines,
      confidence: mapping.sufficient ? 'high' : 'low',
      notes,
    },
    mapping,
    dataRowCount,
    notes,
  };
}

/** 表格前 N 行 → 紧凑文本（喂 LLM 做语义映射；制表符分列，保留表头便于模型对齐） */
export function matrixToCompactText(rows: string[][], limit = 30): string {
  return rows
    .slice(0, limit)
    .map((r, i) => 'R' + (i + 1) + '| ' + r.map((c) => (c ?? '').replace(/[\t\n\r|]/g, ' ')).join(' | '))
    .join('\n');
}

/** 数据行数（排除表头与全空行）——判断「表格里到底有没有订单行」 */
export function countDataRows(rows: string[][]): number {
  const mapping = mapHeader(rows);
  const body = mapping.headerRowIndex >= 0 ? rows.slice(mapping.headerRowIndex + 1) : rows;
  return body.filter((r) => r.some((c) => c !== '')).length;
}

// ============ 服务封装（Nest 注入用） ============

@Injectable()
export class TableParserService {
  private readonly logger = new Logger(TableParserService.name);

  /**
   * 上传文件 → 规范化矩阵。
   * .xls 给出明确中文提示（exceljs 只支持 xlsx；xls 是二进制 BIFF 格式，纯 JS 解析不划算）。
   */
  async parseUpload(input: { buffer: Buffer; fileName?: string; mimeType?: string }): Promise<{
    kind: TableFileKind;
    rows: string[][];
    encoding?: string;
    delimiter?: string;
  }> {
    const kind = detectTableFileKind(input.fileName, input.mimeType);
    if (kind === 'xls') {
      throw new BadRequestException('暂不支持旧版 .xls 格式：请用 Excel 另存为 .xlsx 或 .csv 后重试');
    }
    if (kind === 'pdf') {
      throw new BadRequestException('PDF 暂不支持直接解析：请把订单页截图成图片上传，或另存为 .xlsx / .csv 后重试');
    }
    if (kind === 'image') {
      throw new BadRequestException('图片请走图片识别通道（当前为表格解析入口）');
    }
    if (kind === 'unsupported') {
      throw new BadRequestException('无法识别的文件类型（' + (input.fileName ?? '未命名') + '）：表格仅支持 .xlsx / .csv');
    }
    if (kind === 'xlsx') {
      const rows = normalizeMatrix(await readXlsxMatrix(input.buffer));
      if (!rows.length) throw new BadRequestException('Excel 第一个工作表没有可识别的数据行');
      this.logger.log('xlsx 解析完成：' + rows.length + ' 行 × ' + rows[0].length + ' 列（含表头）');
      return { kind, rows };
    }
    // csv
    const decoded = decodeTextBuffer(input.buffer);
    const delimiter = detectDelimiter(decoded.text);
    const rows = normalizeMatrix(parseCsvText(decoded.text, delimiter));
    if (!rows.length) throw new BadRequestException('CSV 文件没有可识别的数据行（请确认不是空文件）');
    this.logger.log('csv 解析完成：' + rows.length + ' 行（编码 ' + decoded.encoding + '，分隔符 ' + (delimiter === '\t' ? 'TAB' : delimiter) + '）');
    return { kind, rows, encoding: decoded.encoding, delimiter };
  }
}
