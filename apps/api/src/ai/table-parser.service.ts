import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as XLSX from '@e965/xlsx';
import * as ExcelJS from 'exceljs';
import * as iconv from 'iconv-lite';
import type { ParsedOrder, ParsedOrderLine } from './order-parser.service';

/**
 * 表格订单解析：xls(BIFF8/OLE2) / xlsx / csv → 二维矩阵 → 表头规则映射 → 紧凑文本（LLM 兜底映射用）。
 *
 * 设计取向与既有「确定性为骨」一致：
 * - 规则映射（关键词命中表头）命中齐全时**完全不调用 LLM**，结果可复现、离线可用；
 * - 命中率不足（缺客户/产品/数量/单价任一列，或没有数据行）才把表格前 N 行转紧凑文本，
 *   交给既有 LLM 网关做语义映射，并要求返回与图片识别同构的 JSON（见 order-parser.service）。
 *
 * .xls 支持（本轮新增）：用 @e965/xlsx（SheetJS 维护中的 fork）读 BIFF8，**复用同一套矩阵/表头映射/金额分口径**，
 * 不另起管线；格式判定以 magic bytes 为准（扩展名写错也能救），exceljs 仍只负责 .xlsx。
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

// ============ 文件格式判定：magic bytes 优先（扩展名写错也能救） ============

/** OLE2/CFB 复合文档头（.xls = BIFF8 装在 CFB 容器里），8 字节 */
export const OLE2_MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex');
/** ZIP 头（.xlsx 本质是 zip 包）：PK\x03\x04 / 空档 PK\x05\x06 / 分卷 PK\x07\x08 */
const ZIP_MAGICS = [Buffer.from('504b0304', 'hex'), Buffer.from('504b0506', 'hex'), Buffer.from('504b0708', 'hex')];
/** 图片头：PNG / JPEG / GIF / WEBP */
const IMAGE_MAGICS: Buffer[] = [
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('ffd8ff', 'hex'),
  Buffer.from('47494638', 'hex'), // GIF8
  Buffer.from('52494646', 'hex'), // RIFF（配合 8-11 字节 WEBP 再判）
];

/** BMP 头更弱（仅 'BM' 两字节），单独加「保留位为 0 + 数据偏移合理」的完整性校验，
 *  避免把以 BM 开头的文本表格（如「BM号,客户…」）误判成图片。 */
function isBmp(buf: Buffer): boolean {
  return buf.length >= 14 && buf[0] === 0x42 && buf[1] === 0x4d && buf.readUInt16LE(6) === 0 && buf.readUInt16LE(8) === 0
    && buf.readUInt32LE(10) >= 26 && buf.readUInt32LE(10) <= 4096;
}

/**
 * 内容嗅探（只看文件头，不依赖扩展名/MIME）：
 * 'xls'（OLE2）· 'xlsx'（zip）· 'pdf' · 'image' · 'text'（可读文本，如 CSV/TSV）· 'binary'（其余二进制）。
 */
export function sniffMagicKind(buf: Buffer): 'xls' | 'xlsx' | 'pdf' | 'image' | 'text' | 'binary' {
  if (!buf || !buf.length) return 'binary';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(OLE2_MAGIC)) return 'xls';
  if (ZIP_MAGICS.some((m) => buf.length >= 4 && buf.subarray(0, 4).equals(m))) return 'xlsx';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  for (const m of IMAGE_MAGICS) {
    if (buf.length >= m.length && buf.subarray(0, m.length).equals(m)) {
      // RIFF 仅当 8-11 字节是 WEBP 时才算图片（避免把 wav/avi 误判为图片）
      if (m.toString('latin1') === 'RIFF') {
        if (buf.length >= 12 && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';
        continue;
      }
      return 'image';
    }
  }
  if (isBmp(buf)) return 'image';
  return looksLikeText(buf) ? 'text' : 'binary';
}

/** 文本判定：前 512 字节无 NUL 且不含控制字符（制表/换行/回车除外）→ 视为可读文本 */
export function looksLikeText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 512);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) return false;
  }
  return true;
}

/**
 * 上传文件 → 类型判定：**magic bytes 优先**（避免「.xls 被改名成 .xlsx」这类扩展名谎报导致解析失败）；
 * 内容不可判别（截断/加密/纯文本）时再按扩展名与 MIME 兜底：
 * 扩展名声称 Excel 但内容是文本（Excel 另存的 CSV 被改名等）→ 按 CSV 管线处理。
 */
export function detectUploadKind(buffer: Buffer, fileName?: string, mimeType?: string): TableFileKind {
  const magic = sniffMagicKind(buffer);
  if (magic === 'xls' || magic === 'xlsx' || magic === 'pdf' || magic === 'image') return magic;
  const byName = detectTableFileKind(fileName, mimeType);
  if (magic === 'text' && (byName === 'xls' || byName === 'xlsx')) return 'csv';
  return byName;
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

/** 读取 .xlsx 第一个**非空**工作表为二维字符串矩阵（合并单元格由 exceljs 自动回填左上值）；无工作表/全空 → 中文报错 */
export async function readXlsxMatrix(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch (e) {
    throw new BadRequestException('无法读取该 .xlsx 文件（' + (e as Error).message + '）：请确认文件未损坏，或另存为 .csv 后重试');
  }
  if (!wb.worksheets.length) throw new BadRequestException('Excel 中没有可读的工作表，请检查文件');
  // 多工作表：取第一个非空表（客户常把说明页/封面页放在最前面）
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0) ?? wb.worksheets[0];
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

// ============ .xls（BIFF8 / OLE2 复合文档）：@e965/xlsx（SheetJS fork） ============

/** SheetJS 日期（UTC 口径，见 ParsingOptions.UTC 默认 true）→ YYYY-MM-DD
 *  注意：这里必须用 UTC 取数——SheetJS 把单元格日期还原成 UTC 时刻，
 *  用本地 getter 会在西半球时区（UTC-x）上整体退一天。 */
export function fmtDateUtc(d: Date): string {
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** SheetJS 单元格 → 字符串（日期归一 YYYY-MM-DD；数字保持数值原样，不套格式/千分位；错误值留空） */
export function sheetCellToString(cell: XLSX.CellObject | undefined): string {
  if (!cell) return '';
  const v = (cell as { v?: unknown }).v;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDateUtc(v);
  if ((cell as { t?: string }).t === 'e') return ''; // #N/A / #REF! 等错误值：留空待人工补填
  if (typeof v === 'number') return String(v); // 数值精度：不做 toFixed/格式化，避免「0.1+0.2」类尾差与千分位污染
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim();
}

/** 工作表是否有内容（含合并区域锚点）——用于「多工作表取第一个非空表」 */
export function sheetHasData(ws: XLSX.WorkSheet | undefined): boolean {
  if (!ws) return false;
  const ref = (ws as { '!ref'?: string })['!ref'];
  if (!ref) return false;
  const range = XLSX.utils.decode_range(ref);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (sheetCellToString(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject)) return true;
    }
  }
  return false;
}

/** 工作表 → 二维矩阵：跳过全空行、合并单元格补齐左上值（SheetJS 只在左上角存值） */
export function sheetToMatrix(ws: XLSX.WorkSheet): string[][] {
  const ref = (ws as { '!ref'?: string })['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const cells: string[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      row.push(sheetCellToString(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject));
    }
    cells.push(row);
  }
  // 合并单元格：把左上角的值补齐到整个合并区域（跨行合并的客户名/包装要求不再只落在第一行）
  const merges = ((ws as { '!merges'?: XLSX.Range[] })['!merges'] ?? []) as XLSX.Range[];
  for (const m of merges) {
    const anchorRow = cells[m.s.r - range.s.r];
    const anchor = anchorRow ? (anchorRow[m.s.c - range.s.c] ?? '') : '';
    for (let r = m.s.r; r <= m.e.r; r++) {
      const row = cells[r - range.s.r];
      if (!row) continue;
      for (let c = m.s.c; c <= m.e.c; c++) row[c - range.s.c] = anchor;
    }
  }
  return cells.filter((r) => r.some((c) => c !== '')); // 跳过全空行
}

/**
 * 读取 .xls（BIFF8 / OLE2）第一个非空工作表为二维字符串矩阵。
 * cellDates:true → 日期单元格还原为 Date（再按 UTC 归一到 YYYY-MM-DD）；数字单元格保持数值。
 */
export function readXlsMatrix(buf: Buffer): string[][] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: true, cellNF: false, cellText: false });
  } catch (e) {
    throw new BadRequestException('无法读取该 .xls 文件（' + (e as Error).message + '）：请确认是 Excel 97-2003 工作簿且未损坏，或另存为 .xlsx / .csv 后重试');
  }
  const names = wb.SheetNames ?? [];
  if (!names.length) throw new BadRequestException('Excel 中没有可读的工作表，请检查文件');
  const picked = names.find((n) => sheetHasData(wb.Sheets[n]));
  if (!picked) throw new BadRequestException('Excel 所有工作表都是空的，没有可识别的订单内容');
  const rows = sheetToMatrix(wb.Sheets[picked]);
  if (!rows.length) throw new BadRequestException('Excel 中没有可识别的订单数据行，请检查文件内容');
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

/** 表头关键词（大小写不敏感、全角半角归一后 includes 匹配；命中「最长关键词」者占列） */
const HEADER_KEYWORDS: Record<TableField, string[]> = {
  customer: ['客户名称', '客户简称', '客户全称', '客户名', '客户公司', '客户', 'customer', 'buyer', '客户单位', '需方'],
  poNo: ['客户po', '客户订单号', 'po号', 'pono', 'po no', '订单号', '订单编号', '采购订单号', '合同号', 'orderno', 'order no', 'p/o', 'po'],
  productName: ['产品名称', '产品型号', '物料名称', '品名', '型号', '产品', 'product', 'item', 'description', '规格'],
  quantity: ['订购数量', '订货数量', '数量', 'qty', 'quantity', 'pcs'],
  unitPrice: ['含税单价', '单价', '价格', '出厂价', 'unitprice', 'unit price', 'price'],
  currency: ['币种', '币别', '货币', 'currency'],
  dueDate: ['交货日期', '交货时间', '交货期', '出货日期', '发货日期', '交期', 'delivery', 'duedate', 'due date', 'eta'],
  note: ['备注', '说明', 'remark', 'note', 'comment'],
  engraving: ['刻字', '印刷', 'engraving', 'logo'],
  packaging: ['包装要求', '包装', 'packing', 'packaging'],
};

/** 规则映射「齐全」所需的四个关键列（缺任一 → 需要 LLM 兜底映射） */
export const REQUIRED_TABLE_FIELDS: TableField[] = ['customer', 'productName', 'quantity', 'unitPrice'];

/** 表头归一：全角→半角、大小写、去空白、去括号/冒号/星号/顿号等噪声（前后空格与「单价（元）」类写法都能命中） */
const normHeader = (s: string) =>
  (s ?? '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角 → 半角
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()：:*，,。、.．\-_/／【】\[\]「」'’“”"]/g, '');

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
   * 上传文件 → 规范化矩阵。xls / xlsx / csv 三条读入分支，之后**共用**同一套规范化 + 表头规则映射。
   * 类型判定以 magic bytes 为准（OLE2 → .xls；PK → .xlsx），扩展名/MIME 仅作兜底。
   */
  async parseUpload(input: { buffer: Buffer; fileName?: string; mimeType?: string }): Promise<{
    kind: TableFileKind;
    rows: string[][];
    encoding?: string;
    delimiter?: string;
  }> {
    const kind = detectUploadKind(input.buffer, input.fileName, input.mimeType);
    if (kind === 'pdf') {
      throw new BadRequestException('PDF 暂不支持直接解析：请把订单页截图成图片上传，或另存为 .xls / .xlsx / .csv 后重试');
    }
    if (kind === 'image') {
      throw new BadRequestException('图片请走图片识别通道（当前为表格解析入口）');
    }
    if (kind === 'unsupported') {
      throw new BadRequestException('无法识别的文件类型（' + (input.fileName ?? '未命名') + '）：表格仅支持 .xls / .xlsx / .csv');
    }
    if (kind === 'xls' || kind === 'xlsx') {
      const raw = kind === 'xls' ? readXlsMatrix(input.buffer) : await readXlsxMatrix(input.buffer);
      const rows = normalizeMatrix(raw);
      if (!rows.length) throw new BadRequestException('Excel 第一个非空工作表没有可识别的数据行');
      this.logger.log(kind + ' 解析完成：' + rows.length + ' 行 × ' + rows[0].length + ' 列（含表头）');
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
