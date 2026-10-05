#!/usr/bin/env node
/**
 * 资料包抽取共享库（产品建档候选 / 历史成交价种子 两个 CLI 共用）
 * =============================================================================
 * 为什么单独抽库：产品清单与历史价必须来自**同一遍解析**，否则「合同里读到的产品名」
 * 与「报价种子里写的产品名」会漂移，导入后按名称匹配就会对不上。
 *
 * 三条数据来源（与既有识单管线同一口径，不另起一套规则）：
 *   ① Excel 合同（.xls/.xlsx，工作表表头含单价列）        —— 安宝公司 / 尤耐克
 *   ② .doc 切片 CSV（计划单族，**无单价列**）              —— 嵊州海田 / 正恒公司
 *   ③ .doc 切片 CSV（采购单族，有「不含税价」列）          —— 嵊州海田 / 正恒公司
 * 另读 _work/texts.jsonl（scan_texts.py 的 Word 正文抽取结果）补单据日期/合同号：
 * 切片 CSV 只保留了表格，签定时间这类抬头信息在正文里。
 *
 * 口径声明（不臆造）：
 *   · 文本归一 normalizeToken 与 apps/api/src/ai/table-parser.service.ts **逐字符同口径**
 *     （全角→半角、小写、去空白、去括号冒号等噪声），保证「脚本判重」与「服务端匹配」一致；
 *   · 表头匹配沿用服务端「最长关键词命中优先」规则（同 mapHeaderFields）；
 *   · 读不到的值一律留空，不做任何猜测（日期除外，见 inferSignDate 的显式说明）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const API_DIR = path.resolve(__dirname, '../../../apps/api');
const require = createRequire(path.join(API_DIR, 'package.json'));
/** 复用仓库 apps/api 已安装的 SheetJS（BIFF8 .xls 与 OOXML .xlsx 同一入口） */
export const XLSX = require('@e965/xlsx');

export const DEFAULT_ZILIAO_ROOT = process.env.ZILIAO_ROOT ?? 'D:/futures/ziliao-data';
export const DEFAULT_WORK = process.env.ZILIAO_WORK ?? 'D:/futures/_work';
export const DEFAULT_DOC_SLICE_DIRS = [
  path.join(DEFAULT_WORK, 'doc_csv_sz'),
  path.join(DEFAULT_WORK, 'doc_csv_zh'),
];

/** 服务端 headerArea/pack 口径用到的「非产品行」终止词（与 table-parser.service 的 NOISE_RULES 同精神，本工具只用其中与产品名判定相关的部分） */
const STOP_ROW_RE = /^(合\s*计|总\s*计|大写|人民币大写|金额大写|备\s*注|合同备注|正\s*唛|侧\s*唛|签署|盖章|供\s*方|需\s*方|[一二三四五六七八九十]{1,3}\s*[、.．]|第[一二三四五六七八九十]{1,3}条)/;

/**
 * 与 apps/api/src/ai/table-parser.service.ts 的 normalizeToken 完全同口径。
 * ⚠️ 口径边界（2026 甲方更正）：归一化只碰文本外壳（空格/全角半角/大小写/标点），
 * **不碰数字** —— 不删前导零、不折叠数字位。但删标点会让 1-1-101 与 111-01 归一后都成 11101，
 * 所以凡「是不是同一个产品型号」的判定都必须再过一道 digitSignature（见 productIdentityKey）。
 */
export function normalizeToken(s) {
  return String(s ?? '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\uff08\uff09()\uff1a:*\uff0c,\u3002\u3001.\uff0e\-_\/\uff0f\u3010\u3011\[\]\u300c\u300d'\u2019\u201c\u201d"]/g, '');
}

/**
 * 数字指纹（与 apps/api/src/ai/table-parser.service.ts 的 digitSignature 完全同口径）：
 * 按出现顺序抽出数字段并用 - 连接，**前导零与位数原样保留 → 逐字符比较**。
 *   0-GPN → "0" ／ 00-GPN → "00" ／ 000-GPN → "000"（互不相等）
 *   1-1-101 → "1-1-101" ／ 111-01 → "111-01"（互不相等）
 */
export function digitSignature(s) {
  // 全角 → 半角（属于允许的「全角半角」归一），其余不动：前导零 / 位数原样保留
  const half = String(s ?? '').replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return (half.match(/[0-9]+/g) ?? []).join('-');
}

/** 产品去重键（文本归一 + 数字指纹）：0-GPN / 00-GPN / 000-GPN 必须是三个不同的键 */
export function productIdentityKey(s) {
  return normalizeToken(s) + '#' + digitSignature(s);
}

/** 两个写法是否同一型号：文本归一相同 **且** 数字指纹相同（数字部分含前导零逐字符一致） */
export function sameProductModel(a, b) {
  return normalizeToken(a) === normalizeToken(b) && digitSignature(a) === digitSignature(b);
}
/** 极简 CSV 解析（支持引号包裹与双引号转义；与 import_quotes_cloud.mjs 同一实现口径） */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

/** 单元格 → 数字：剥离货币符号/千分位/全角/中文单位 */
export function parseNumberCell(v) {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const cleaned = s
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,\s]/g, '')
    .replace(/[\uffe5\u00a5$\uff0f\/]/g, '')
    .replace(/(元|人民币|rmb|cny|usd|只|个|pcs|pc|套|支|件|kg)/gi, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** 单元格 → YYYY-MM-DD（只认明确的年月日；不做「9/30 是哪一年」的猜测） */
export function parseDateCell(v) {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  let m = s.match(/(\d{4})\s*[\/\-\u5e74.]\s*(\d{1,2})\s*[\/\-\u6708.]\s*(\d{1,2})/);
  if (m) return pad4(m[1]) + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return undefined;
}

const pad2 = (n) => String(Number(n)).padStart(2, '0');
const pad4 = (n) => String(Number(n)).padStart(4, '0');

// ============================================================
// 表头匹配（与服务端 mapHeaderFields 同规则：每列取最长命中关键词，同字段择优）
// ============================================================

/** 本工具用到的字段 → 关键词（取自服务端 HEADER_KEYWORDS / 主数据导入的别名表，只保留抽取需要的列） */
export const EXTRACT_FIELDS = {
  productName: ['产品名称、商标、厂家、规格', '客户需求产品描述', '产品图片及刻字要求', '产品名称', '物料名称', '品名规格', '产品型号', '品名', '产品', 'description'],
  quantity: ['订购数量', '数量', 'qty', 'quantity'],
  unitPrice: ['不含税单价', '不含税价', '含税单价', '含税价', '单价', '价格', '出厂价', 'unitprice', 'unit price', 'price'],
  packaging: ['包装要求及产品图片', '产品图片寄包装要求', '包装及生产要求', '包装要求', '包装', 'packing', 'packaging'],
  unit: ['单位', 'unit'],
  currency: ['币种', '币别', '货币', 'currency'],
};

/** 单行表头 → 字段到列下标（同服务端「最长命中优先、同长取靠左」） */
export function matchColumns(headerRow, fieldKeywords) {
  const fields = Object.keys(fieldKeywords);
  const colBest = {};
  (headerRow ?? []).forEach((cell, c) => {
    const h = normalizeToken(cell);
    if (!h) return;
    let bestField = null, bestLen = 0;
    for (const f of fields) {
      for (const k of fieldKeywords[f]) {
        const nk = normalizeToken(k);
        if (nk && h.includes(nk) && nk.length > bestLen) { bestField = f; bestLen = nk.length; }
      }
    }
    if (!bestField) return;
    const prev = colBest[bestField];
    if (!prev || bestLen > prev.kwLen) colBest[bestField] = { col: c, kwLen: bestLen };
  });
  const columns = {};
  for (const [f, pick] of Object.entries(colBest)) columns[f] = pick.col;
  return columns;
}

/** 在前 maxScan 行内挑命中字段最多的一行当表头 */
export function findHeaderRow(rows, fieldKeywords, opts = {}) {
  const maxScan = Math.min(rows.length, opts.maxScan ?? 8);
  const minHits = opts.minHits ?? 2;
  let best = { idx: -1, columns: {}, hits: 0 };
  for (let r = 0; r < maxScan; r++) {
    const columns = matchColumns(rows[r], fieldKeywords);
    const hits = Object.keys(columns).length;
    if (hits > best.hits) best = { idx: r, columns, hits };
  }
  if (best.hits < minHits) return { idx: -1, columns: {}, hits: 0 };
  return best;
}

// ============================================================
// ① Excel 合同
// ============================================================

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(xls|xlsx)$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

/** 合并单元格回填：SheetJS 只在左上角给值，产品名列跨行合并时后续行为空 → 向下填充 */
function forwardFill(matrix, col) {
  let last = '';
  for (const row of matrix) {
    const v = String(row[col] ?? '').trim();
    if (v) last = v;
    else if (last) row[col] = last;
  }
}

/** 抬头区扫描（表头行以上）：合同编号 / 签约时间 —— 与识单管线的 scanContractHeader 同一目标字段 */
export function scanContractHeader(rows, headerRowIndex, ctx) {
  const out = { poNo: null, signDate: null, buyer: null, supplier: null };
  const head = rows.slice(0, Math.max(0, headerRowIndex));
  for (const row of head) {
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] ?? '').trim();
      if (!cell) continue;
      if (!out.poNo && /^(合同编号|合同号|合同no|po\s*no|po号)/i.test(cell)) {
        out.poNo = (cell.replace(/^(合同编号|合同号|合同no|po\s*no|po号)\s*[:\uff1a]?\s*/i, '') || String(row[c + 1] ?? '')).trim() || null;
      }
      if (!out.poNo && /合同编号\s*[:\uff1a]/.test(cell)) {
        const v = cell.split(/合同编号\s*[:\uff1a]/)[1];
        if (v && v.trim()) out.poNo = v.trim();
      }
      if (!out.signDate && /(签约时间|签订时间|签定时间|签约日期|签订日期)/.test(cell)) {
        out.signDate = parseDateCell(cell) ?? parseDateCell(String(row[c + 1] ?? '')) ?? null;
      }
      if (!out.buyer && /^需\s*方/.test(cell)) out.buyer = (cell.replace(/^需\s*方\s*[:\uff1a]?/, '') || String(row[c + 1] ?? '')).trim() || null;
      if (!out.supplier && /^供\s*方/.test(cell)) out.supplier = (cell.replace(/^供\s*方\s*[:\uff1a]?/, '') || String(row[c + 1] ?? '')).trim() || null;
    }
  }
  // 币种：表头下一行常见孤零零的 RMB / CNY 子行
  if (ctx) out.currencyRow = ctx;
  return out;
}

/**
 * 读一份 Excel 合同 → 一个或多个工作表的抽取结果。
 * @returns [{ sheet, columns, headerRowIndex, headerArea, rows: [{productName, quantity, unitPrice, packaging, variantText, rowNo}] }]
 */
export function extractContractFile(absPath, rel, top) {
  const buf = fs.readFileSync(absPath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellStyles: false });
  const sheets = [];
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false })
      .map((r) => r.map((c) => String(c ?? '')));
    if (!matrix.length) continue;
    const head = findHeaderRow(matrix, EXTRACT_FIELDS, { maxScan: 8, minHits: 3 });
    if (head.idx < 0 || head.columns.productName === undefined) continue;
    if (head.columns.unitPrice === undefined) continue; // 本抽取只认「带单价列」的合同
    forwardFill(matrix, head.columns.productName);
    const headerArea = scanContractHeader(matrix, head.idx);
    // 币种：单价列上方/表头上一行出现 RMB / CNY / USD 时作为整表币种线索
    let currency = null;
    for (let r = 0; r <= head.idx; r++) {
      for (const c of matrix[r]) {
        const v = String(c ?? '').trim();
        if (/^(rmb|rmb\u00a5|\uffe5|cny|\u4eba\u6c11\u5e01|usd|\u7f8e\u5143|us\$|\$)$/i.test(v)) currency = v;
      }
    }
    const outRows = [];
    for (let r = head.idx + 1; r < matrix.length; r++) {
      const row = matrix[r];
      const firstNonEmpty = row.find((c) => String(c ?? '').trim() !== '');
      if (firstNonEmpty && STOP_ROW_RE.test(String(firstNonEmpty).trim())) break;
      const name = String(row[head.columns.productName] ?? '').trim();
      if (!name) continue;
      if (STOP_ROW_RE.test(name)) break;
      const quantity = parseNumberCell(row[head.columns.quantity]);
      const unitPrice = head.columns.unitPrice === undefined ? undefined : parseNumberCell(row[head.columns.unitPrice]);
      if ((quantity === undefined || quantity <= 0) && (unitPrice === undefined || unitPrice <= 0)) continue;
      // 产品名后的紧邻短单元格（如「0#」「1#」）是号数/规格，单独留痕供人工看，不并入产品名
      const nextCol = head.columns.productName + 1;
      const variantText = (head.columns.quantity !== undefined && nextCol < head.columns.quantity)
        ? String(row[nextCol] ?? '').trim() : '';
      outRows.push({
        productName: name,
        variantText: variantText && variantText.length <= 12 ? variantText : '',
        quantity: quantity === undefined ? null : quantity,
        unitPrice: unitPrice === undefined ? null : unitPrice,
        packaging: head.columns.packaging === undefined ? '' : String(row[head.columns.packaging] ?? '').trim(),
        rowNo: r + 1,
      });
    }
    if (!outRows.length) continue;
    sheets.push({ sheet: sn, columns: head.columns, headerRowIndex: head.idx, headerArea, currency, rows: outRows, nrows: matrix.length });
  }
  return { rel, top, absPath, sheets };
}

/**
 * 扫描资料包全部 Excel，挑出「含单价列」的合同族。
 * @returns { contracts: [...extractContractFile 结果], scanned, priceFiles }
 */
export function scanContracts(root, opts = {}) {
  const files = walk(root).sort();
  const contracts = [];
  let priceFiles = 0;
  for (const p of files) {
    const rel = path.relative(root, p).split(path.sep).join('/');
    let r;
    try { r = extractContractFile(p, rel, topFolder(rel)); } catch (e) { continue; }
    if (!r.sheets.length) continue;
    priceFiles += 1;
    contracts.push(r);
    if (opts.onProgress && priceFiles % 100 === 0) opts.onProgress(priceFiles, files.length);
  }
  return { contracts, scanned: files.length, priceFiles };
}

// ============================================================
// ② / ③ .doc 切片 CSV
// ============================================================

/**
 * 顶层客户文件夹（甲方裁定「文件夹=客户」）。
 * 注意：资料包根目录下还有一层 ziliao/（解压产物），要跳过它才是客户文件夹。
 */
export function topFolder(rel) {
  const seg = String(rel ?? '').split('/').filter(Boolean);
  return (seg[0] === 'ziliao' ? seg[1] : seg[0]) ?? '';
}

/** 切片文件名 = 原始相对路径把 "/" 换成 "__" */
export function relFromSliceFileName(f) {
  return f.replace(/\.csv$/i, '').replace(/__/g, '/');
}

/** 单据类别（按文件名判定，与既有脚本口径一致） */
export function sliceKind(name) {
  if (/采购单/.test(name)) return 'purchase';
  if (/计划单/.test(name)) return 'plan';
  return 'other';
}

/**
 * 读 texts.jsonl（Word 正文抽取缓存）→ rel → { text, signDate, poNo }
 * 用于补 .doc 单据的「签定时间 / 合同号」：切片 CSV 只留了表格，抬头信息在正文里。
 */
export function loadDocTexts(textsPath) {
  const map = new Map();
  if (!fs.existsSync(textsPath)) return map;
  for (const ln of fs.readFileSync(textsPath, 'utf8').split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let rec; try { rec = JSON.parse(ln); } catch { continue; }
    const rel = String(rec.rel ?? '').replace(/^ziliao\//, '');
    const text = String(rec.text ?? '');
    map.set(rel, { text, signDate: findSignDate(text), poNo: findPoNo(text) });
  }
  return map;
}

/** 正文里找「签定时间 / 签订时间 / 日期」后的日期（只取原文字面，年份缺失交给 inferSignDate 显式处理） */
export function findSignDate(text) {
  const m = String(text ?? '').match(/(?:签\s*[定订]\s*时\s*间|签\s*约\s*时\s*间|签\s*[定订]\s*日\s*期|日\s*期)\s*[:\uff1a]?\s*([0-9]{4}\s*[\/\-\u5e74.]\s*[0-9]{1,2}\s*[\/\-\u6708.]\s*[0-9]{1,2}|[0-9]{1,2}\s*[\/\-]\s*[0-9]{1,2})/);
  return m ? m[1] : null;
}

/** 正文里找合同号（YZ###### 之类） */
export function findPoNo(text) {
  const m = String(text ?? '').match(/(?:合同号|合同编号|合\s*同\s*号|订单号)\s*[:\uff1a]?\s*([A-Za-z]{0,4}[0-9][0-9A-Za-z ]{3,20})/);
  return m ? m[1].trim() : null;
}

/**
 * 月/日缺年份时的年份推断（**显式规则，全部写进备注，绝不悄悄猜**）：
 *   ① 合同号形如 YZ250602（YZ + YYMMDD）且月日与签定时间一致 → 取该年；
 *   ② 否则取原 .doc 文件的最后修改年份；
 *   ③ 都没有 → 返回 null（该行不写日期，由调用方标记）。
 * @returns { date, source } source ∈ contract-no | file-mtime | none
 */
export function inferSignDate(raw, poNo, fileMtimeMs) {
  if (!raw) return { date: null, source: 'none' };
  const full = parseDateCell(raw);
  if (full) return { date: full, source: 'explicit' };
  const m = String(raw).match(/^(\d{1,2})\s*[\/\-]\s*(\d{1,2})$/);
  if (!m) return { date: null, source: 'none' };
  const mm = pad2(m[1]), dd = pad2(m[2]);
  const po = String(poNo ?? '').replace(/\s+/g, '');
  const pm = po.match(/(\d{2})(\d{2})(\d{2})$/);
  if (pm && pm[2] === mm && pm[3] === dd) return { date: '20' + pm[1] + '-' + mm + '-' + dd, source: 'contract-no' };
  if (fileMtimeMs) {
    const d = new Date(fileMtimeMs);
    const y = d.getFullYear();
    if (y >= 2015 && y <= 2035) return { date: y + '-' + mm + '-' + dd, source: 'file-mtime' };
  }
  return { date: null, source: 'none' };
}

/** 从切片首行（抬头行）里取 需方 / 合同号 / 交货时间 */
export function parseSliceHeadRow(row) {
  const out = { customer: null, poNo: null, dueRaw: null, signRaw: null };
  for (const cell of row ?? []) {
    const s = String(cell ?? '').trim();
    if (!s) continue;
    let m;
    if ((m = s.match(/需\s*方\s*[:\uff1a]\s*(.+)$/))) out.customer = m[1].trim();
    if ((m = s.match(/合同号\s*[:\uff1a]\s*([^,，\s]+)/))) out.poNo = m[1].trim();
    if ((m = s.match(/交货(?:时间|期)\s*[:\uff1a]\s*(.+)$/))) out.dueRaw = m[1].trim();
    if ((m = s.match(/(?:签\s*[定订]\s*时\s*间|签\s*约\s*时\s*间)\s*[:\uff1a]\s*(.+)$/))) out.signRaw = m[1].trim();
  }
  return out;
}

/**
 * 读一个切片目录下的全部 CSV。
 * @returns [{ rel, top, kind, csvPath, head, headerRowIndex, columns, rows: string[][], allRows }]
 */
export function loadDocSlices(dirs) {
  const out = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.csv$/i.test(f)) continue;
      const rel = relFromSliceFileName(f);
      const csvPath = path.join(d, f);
      const allRows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
      if (!allRows.length) continue;
      const head = findHeaderRow(allRows, EXTRACT_FIELDS, { maxScan: 3, minHits: 2 });
      if (head.idx < 0 || head.columns.productName === undefined) {
        out.push({ rel, top: topFolder(rel), kind: sliceKind(f), csvPath, head: null, headerRowIndex: -1, columns: {}, rows: [], allRows });
        continue;
      }
      out.push({
        rel, top: topFolder(rel), kind: sliceKind(f), csvPath,
        head: head.idx > 0 ? parseSliceHeadRow(allRows[0]) : null,
        headerRowIndex: head.idx, columns: head.columns,
        rows: allRows.slice(head.idx + 1), allRows,
        headerRow: allRows[head.idx],
      });
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

const UNIT_WORD_RE = /^(只|个|套|根|袋|件|支|条|箱|pcs|pc|set|sets|kgs|kg)$/i;

/**
 * 取一行的产品名/数量/单价/包装。
 * doc_table.py 把 Word 表格切成矩阵时，**合并单元格会让产品名落到后一列**（实测「工矿产品购销合同」
 * 与部分采购单：列 0 为空、列 1 才是产品名，且数量/单价整体后移）。
 * 但整体平移并不能修好（表头的列数与数据行不一致），所以这里做**行级回填**：
 *   产品名列空 → 往前找「第一个数字之前、最后一个非空且非单位词」的单元格当名字，
 *   其后的前两个数字依次当数量、单价。
 * 回填行一律带 recovered=true，由调用方在报告/备注里标「列错位回填，需人工核对」。
 */
export function docRowValues(row, columns) {
  const cell = (i) => (i === undefined || i === null ? '' : String(row[i] ?? '').trim());
  let name = cell(columns.productName);
  let quantity = parseNumberCell(cell(columns.quantity));
  let unitPrice = columns.unitPrice === undefined ? undefined : parseNumberCell(cell(columns.unitPrice));
  const packaging = columns.packaging === undefined ? '' : cell(columns.packaging);
  if (name) return { name, quantity, unitPrice, packaging, recovered: false };
  const firstNum = row.findIndex((v) => parseNumberCell(v) !== undefined);
  const limit = firstNum < 0 ? row.length : firstNum;
  let nameIdx = -1;
  for (let c = limit - 1; c >= 0; c--) {
    const v = String(row[c] ?? '').trim();
    if (!v) continue;
    if (UNIT_WORD_RE.test(v)) continue;
    if (parseNumberCell(v) !== undefined) continue;
    name = v; nameIdx = c; break;
  }
  if (!name) return { name: '', quantity, unitPrice, packaging, recovered: false };
  const nums = row.slice(nameIdx + 1).map((v) => parseNumberCell(v)).filter((n) => n !== undefined);
  quantity = nums.length ? nums[0] : undefined;
  unitPrice = columns.unitPrice === undefined ? undefined : (nums.length > 1 ? nums[1] : undefined);
  return { name, quantity, unitPrice, packaging, recovered: true };
}

/** 原始 .doc 文件的最后修改时间（用于 inferSignDate 的兜底年份） */
export function docMtime(root, rel) {
  for (const cand of [path.join(root, 'ziliao', rel), path.join(root, rel)]) {
    try { if (fs.existsSync(cand)) return fs.statSync(cand).mtimeMs; } catch { /* ignore */ }
  }
  return null;
}

// ============================================================
// 产品类型推断（只认字面证据，推断不出一律 tbd）
// ============================================================

/** 气体轴：乙炔 / 丙烷（含英文） */
export function inferGasType(name) {
  const s = String(name ?? '');
  if (/乙\s*炔|acetylene|\bAC\b/i.test(s)) return 'acetylene';
  if (/丙\s*烷|propane|\bLPG\b/i.test(s)) return 'propane';
  return null;
}

/**
 * 地域轴：英式(UK) / 美式(US)。
 * 证据来源（全部是资料/型号字面，不是猜测）：
 *   · 中文/英文写法：英式 / UK / 英乙 / 英丙 ↔ 美式 / US / USA / 美乙 / 美丙 / MADE IN USA；
 *   · 型号族（CONTEXT/schema 已定义，见 db/schema.ts PRODUCT_TYPES 注释与识单关键词表）：
 *       ANM = 英式乙炔系、PNM/PNME = 英式丙烷系、6290 = 美式乙炔/丙烷系、1-101/5-1-101 = 美式丙烷系。
 * 只凭地域不足以定四值枚举 → 调用方按「缺一轴 → tbd」处理。
 */
export function inferRegionType(name) {
  const s = String(name ?? '');
  if (/英\s*式|英乙|英丙|\bUK\b|\bANM\b|\bPNM/i.test(s)) return 'uk';
  if (/美\s*式|美乙|美丙|\bU\.?S\.?A?\b|MADE\s+IN\s+USA|\b6290\b|(^|[^0-9])101([^0-9]|$)/i.test(s)) return 'us';
  return null;
}

/**
 * 产品类型推断：两个轴都明确才给四值枚举，否则 tbd（甲方要求：推断不出的一律 tbd，不臆造）。
 * @returns { type, gas, region, reason }
 */
export function inferProductType(name) {
  const gas = inferGasType(name);
  const region = inferRegionType(name);
  if (gas && region) return { type: region + '_' + gas, gas, region, reason: '气体（' + gas + '）+ 地域（' + region + '）均为字面证据' };
  if (gas) return { type: 'tbd', gas, region: null, reason: '只认到气体「' + gas + '」，缺英式/美式 → 待人工确认' };
  if (region) return { type: 'tbd', gas: null, region, reason: '只认到地域「' + region + '」，缺乙炔/丙烷 → 待人工确认' };
  return { type: 'tbd', gas: null, region: null, reason: '名称里没有可辨认的类型证据 → 待人工确认' };
}

/**
 * 「号数/规格」判定：品名规格单元格里只有一个 1~2 位数字（或 #N）——
 * 它是上一行产品的号数（Word 表格合并单元格所致），**不是一个可识别的产品**。
 * 实测：正恒公司/106D7镀铬采购单.doc 的品名规格列是 "GK3-00" 后面跟 "0".."8"；
 * 任江南采购单 - HARRIS焊杆.doc 是 "HARRIS焊杆" 后面跟 "1#"、"3#"。
 * 这类名字**既不进产品候选，也不进报价种子**：两边都不可识别，匹配上等于编造价格。
 */
export function isSizeOnlyName(name) {
  const s = String(name ?? '').trim();
  return /^\d{1,2}$/.test(s) || /^#\d{1,2}$/.test(s) || /^\d{1,2}#$/.test(s);
}

/** 产品名噪声过滤：明显不是产品型号的行（合计/表头残留/整句话/过短无意义） */
export function isProductNoise(name) {
  const s = String(name ?? '').trim();
  if (!s) return true;
  if (s.length > 80) return true;
  if (STOP_ROW_RE.test(s)) return true;
  if (/^(产品名称|品名规格|品名|型号|规格|序号|单位|数量|单价|备注|客户需求产品描述)$/.test(s)) return true;
  if (/^(无|空|同上|同上。|—|-|\/|N\/?A|合计)$/i.test(s)) return true;
  if (isSizeOnlyName(s)) return true;
  // 整句话特征：很长且含句末标点，或含 2 个以上分句标点
  if (s.length > 40 && /[，。；]/.test(s)) return true;
  if ((s.match(/[。；]/g) ?? []).length >= 2) return true;
  return false;
}

/** 包装描述清洗：过长/含换行的当噪声截断；含「如图」「见附图」这类无信息量的当空 */
export function cleanPackaging(text) {
  let s = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length < 2) return '';
  if (/^(\/|—|-|无|空|无要求|同上|如图|见附图|不干胶|贴标)$/.test(s)) return '';
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

/**
 * 型号指纹（**产品同一性判定可用**）：归一后去掉非字母数字字符。
 * 数字段原样保留 —— modelFingerprint('0-GPN')='0gpn' ≠ modelFingerprint('00-GPN')='00gpn'。
 * 修正记录：旧实现额外做 `t.replace(/(^|[^0-9])0+(\d)/g, '$1$2')` 折叠前导零，
 * 会把 0/00/000-GPN 折成同一个键 —— 与甲方「前导零=不同尺寸」的口径冲突，已删除（见 variantGroupFingerprint 注释）。
 */
export function modelFingerprint(name) {
  return normalizeToken(name).replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
}

/**
 * 变体候选分组指纹（**只用于把「疑似同一型号族」的写法聚到一起供人工分类**；
 * 🚫 绝不可用于合并、去重、取价、建档判重 —— 那些地方一律用 productIdentityKey / modelFingerprint）。
 *
 * 它刻意比型号指纹更宽松：把「号数 #N」与前导零折成占位，好让 0/00/000-GPN 这类**同族不同尺寸**
 * 的写法落进同一组，再由分类器按 digitSignature 判定它们属于 B 类（同型号不同尺寸，不合并）。
 * 因此：分组结果本身**不代表可以合并**，只代表「需要人工看一眼」。
 */
export function variantGroupFingerprint(name) {
  return String(name ?? '')
    .replace(/#[0-9]+/g, '#')            // 号数 #10 → #（只折叠「号数」，不折叠型号里的数字）
    .replace(/[0-9]+#/g, '#')            // 号数 10# → #
    .replace(/(^|[^0-9])0+([0-9])/g, '$1$2') // 前导零 00-GPN → 0-GPN（只为聚组，便于人工看到「同族不同尺寸」）
    .replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
}

export { STOP_ROW_RE };
