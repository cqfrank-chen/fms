#!/usr/bin/env node
/**
 * 资料包「报价单」检索 + 表结构抽样（纯 Node，零额外依赖；Excel 复用 apps/api 的 SheetJS）
 * =====================================================================================
 * 背景（甲方裁定 2026-10-05 第 6 项）：要从 D:\futures\ziliao-data 里找出报价单类文件，
 * 抽样确认表结构（客户/产品/单价/币种/有效期），产出清单 + 可直接对云端执行的报价导入脚本。
 *
 * 本脚本只做「找 + 抽样 + 可映射性判断」，**不写任何库**：
 *   · 命中口径：文件名含 报价/报价单/价格/价格表/单价/单价表/价目/quote/quotation/price，且扩展名 ∈ xls/xlsx/doc/docx/pdf/csv；
 *   · 客户归属：沿用甲方裁定「文件夹=客户」——取路径里 ziliao 之后的第一个目录名（没有则取第一层目录）；
 *   · 抽样：xls/xlsx 读每个 sheet 的前 N 行矩阵；doc/docx 用 tools/ziliao/doc-text.mjs 抽正文（含表格 0x07 分隔）；
 *     pdf 只做「是否有文本层」的字节启发式判断（扫描件无法结构化，如实说明）。
 *   · 可映射性：yes = 抽样里同时出现「产品列 + 单价列」的表头行；partial = 有价格但表头不成形（如 Word 文字型报价）；
 *     no = 无价格信息/扫描件。
 *
 * 用法：
 *   node tools/ziliao/find_quote_files.mjs
 *   node tools/ziliao/find_quote_files.mjs --root D:/futures/ziliao-data --out tools/ziliao --rows 12
 *
 * 产物（默认写到 tools/ziliao/）：
 *   quote_files.csv            报价单清单（路径 + 归属文件夹客户 + 抽样表头 + 可映射性判断）
 *   quote_files_samples.json   每份文件的抽样明细（表头矩阵 / 正文摘录 / pdf 判定）
 *   quote_files_summary.txt    人读摘要 + 结论
 *   quote_seed_candidates.csv  能结构化出来的候选行（客户名称,产品名称,单价,币种,生效日期,失效日期,备注）
 *                              —— 直接可用 tools/ziliao/import_quotes_cloud.mjs 导入（认不出就 0 行，绝不臆造）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { extractText } from './doc-text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(__dirname, '../../apps/api');
const require = createRequire(path.join(apiDir, 'package.json'));
const XLSX = require('@e965/xlsx');

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ROOT = arg('--root', 'D:/futures/ziliao-data');
const OUT = arg('--out', __dirname);
const ROWS = Number(arg('--rows', '12')) || 12;

/** 文件名命中关键词（小写比较） */
const NAME_KEYWORDS = ['报价', '价格', '单价', '价目', 'quote', 'quotation', 'price', 'pricelist'];
/** 参与检索的扩展名 */
const EXTS = ['.xls', '.xlsx', '.doc', '.docx', '.pdf', '.csv'];
/** 表头关键词（用于判定「这张表能不能映射到报价导入模板」） */
const H_PRODUCT = /产品|品名|型号|规格|item|product|description|物料/;
const H_PRICE = /单价|价格|报价|不含税|含税|price|unit\s*price|金额/;
const H_CUSTOMER = /客户|需方|买方|customer|buyer/;
const H_CURRENCY = /币种|币别|货币|currency/;
const H_DATE = /有效期|生效|失效|日期|date/;

fs.mkdirSync(OUT, { recursive: true });

/** 归属文件夹客户：ziliao 之后的第一段（沿用「文件夹=客户」口径） */
function folderCustomer(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const i = parts.indexOf('ziliao');
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  return parts[0] ?? '';
}

function walk(dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else {
      const ext = path.extname(e.name).toLowerCase();
      if (!EXTS.includes(ext)) continue;
      const low = e.name.toLowerCase();
      if (NAME_KEYWORDS.some((k) => low.includes(k.toLowerCase()))) acc.push(p);
    }
  }
  return acc;
}

/** 极简 CSV 解析（仅用于候选行落盘，不解析引号内换行） */
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/**
 * 从表格矩阵里找「像表头」的那一行。
 * 口径：必须有**两个不同的列**分别命中「产品列」与「单价列」（同一格既像产品又像价格不算，
 * 例如合同首行「一、产品名称、商标、厂家、规格、数量、金额」就不是表头）。
 */
function findHeaderRow(aoa) {
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const row = aoa[i].map((c) => String(c ?? '').trim());
    const pIdx = row.findIndex((c) => c && H_PRODUCT.test(c));
    const qIdx = row.findIndex((c) => c && H_PRICE.test(c));
    if (pIdx >= 0 && qIdx >= 0 && pIdx !== qIdx) return i;
  }
  return -1;
}

/** 列名 → 报价模板字段（够用即可：只认产品/单价/客户/币种/有效期） */
function mapColumns(headers) {
  const map = {};
  headers.forEach((h, idx) => {
    const t = String(h ?? '').trim();
    if (!t) return;
    if (map.productName === undefined && H_PRODUCT.test(t)) map.productName = idx;
    else if (map.unitPrice === undefined && H_PRICE.test(t)) map.unitPrice = idx;
    else if (map.customerName === undefined && H_CUSTOMER.test(t)) map.customerName = idx;
    else if (map.currency === undefined && H_CURRENCY.test(t)) map.currency = idx;
    else if (map.validFrom === undefined && H_DATE.test(t)) map.validFrom = idx;
  });
  return map;
}

/**
 * Word 报价单的「文字行价格」提取（型号: 价格 元）—— 仅作**候选**，必须人工确认后再导入。
 * 依据：资料包里的 7 份 .doc 报价单实际形态是逐行「型号：价格」的文字/表格混排（非 Excel 表头），
 * 例如 "6290: 8.6元" / "GPN: 7.8元" / "T15: 108"。这些行能机械抽出来，但产品名是否对应目录、
 * 客户归属、有效期都需要人工核对，因此脚本把它们标成 partial-text，并在备注里注明来源。
 */
const TEXT_PRICE_BLACKLIST = /^(交货|交货期|付款|账期|电话|传真|日期|报价|订单|价格|表格|说明|备注|净重|铜价|利润|重量|总金额|合计|大写|小计|要求|数量|单位|金额|税率|币种|价格表)/;
const TEXT_PRICE_RE = /^([A-Za-z0-9]{1,4}[\-\/#]?[A-Za-z0-9\u4e00-\u9fa5+\/\-]{0,18})\s*[:：=]\s*¥?￥?\s*([0-9]{1,6}(?:\.[0-9]{1,4})?)\s*(?:元|块|RMB|rmb)?\s*(?:\(.*\))?$/;

/**
 * 从报价单正文里找「报价日期」→ 作为报价的**生效日期**。
 * 为什么必须给生效日：报价的服务端幂等键是「客户 + 产品 + 生效日期」；同一客户+产品在不同年份
 * 报过不同价，若都不给生效日就会互相判重（后一条被当重复跳过），也就丢掉了「按 valid_from 取最新价」的能力。
 * 取值顺序：正文里第一个 YYYY-MM-DD / YYYY/M/D / YYYY年M月D日 → 文件修改日期（兜底）。
 */
function quoteDateFromText(text, file) {
  const t = String(text ?? '');
  const m = t.match(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/);
  const pad = (n) => String(n).padStart(2, '0');
  if (m) return m[1] + '-' + pad(Number(m[2])) + '-' + pad(Number(m[3]));
  try {
    const d = fs.statSync(file).mtime;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  } catch {
    return '';
  }
}

function extractTextPriceRows(lines, folderCustomer, rel, validFrom) {
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s*\|\s*/g, ' | ').trim();
    if (!line || line.length > 60 || /[。；;]/.test(line)) continue;
    if (/\d{4}\/\d{1,2}\/\d{1,2}/.test(line)) continue; // 纯日期行
    const m = line.match(TEXT_PRICE_RE);
    if (!m) continue;
    const product = m[1].replace(/[-#\/]+$/, '').trim();
    if (!product || TEXT_PRICE_BLACKLIST.test(product)) continue;
    const price = Number(m[2]);
    if (!Number.isFinite(price) || price <= 0 || price > 100000) continue;
    out.push([
      folderCustomer, product, price.toFixed(2), 'CNY',
      validFrom || '', '',
      '【文字行提取·需人工确认】来自 ' + rel + '（报价日 ' + (validFrom || '未知') + '）：' + line.slice(0, 60),
    ]);
  }
  return out;
}

const num = (s) => {
  const m = String(s ?? '').replace(/[,\s￥¥$]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : undefined;
};

const samples = [];
const seedRows = [];

for (const p of walk(ROOT).sort()) {
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  const ext = path.extname(p).toLowerCase();
  const rec = { rel, folderCustomer: folderCustomer(rel), ext, size: fs.statSync(p).size, kind: '', headers: [], headerRow: -1, sample: [], mapColumns: {}, mappable: 'no', note: '' };

  if (ext === '.xls' || ext === '.xlsx') {
    try {
      const wb = XLSX.read(fs.readFileSync(p), { type: 'buffer', cellDates: true, cellStyles: false });
      rec.kind = 'excel';
      for (const sn of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '', blankrows: false });
        if (!aoa.length) continue;
        const hIdx = findHeaderRow(aoa);
        if (hIdx >= 0) {
          rec.headerRow = hIdx;
          rec.headers = aoa[hIdx].map((c) => String(c ?? '').trim()).filter((c) => c);
          rec.sample = aoa.slice(hIdx, hIdx + 1 + ROWS).map((r) => r.slice(0, 12).map((c) => String(c ?? '').slice(0, 60)));
          rec.mapColumns = mapColumns(aoa[hIdx]);
          rec.mappable = rec.mapColumns.productName !== undefined && rec.mapColumns.unitPrice !== undefined ? 'yes' : 'partial';
        } else {
          rec.sample = aoa.slice(0, ROWS).map((r) => r.slice(0, 12).map((c) => String(c ?? '').slice(0, 60)));
        }
        rec.sheet = sn;
        break; // 只抽样第一个有内容的 sheet（本脚本用于判断可映射性，不穷举）
      }
    } catch (e) {
      rec.kind = 'excel';
      rec.note = '读取失败：' + (e && e.message);
    }
  } else if (ext === '.doc' || ext === '.docx') {
    rec.kind = 'word';
    try {
      const { text } = extractText(p); // extractText 返回 { chars, text, ... }
      // Word 表格：单元格以 0x07 分隔，行以 0x0D 分隔 → 拆成矩阵文本，便于人工/后续切片核对
      const lines = text.split(/[\r\n\u000b\u000c]+/).map((s) => s.replace(/\u0007/g, ' | ').trim()).filter(Boolean);
      rec.sample = lines.slice(0, ROWS + 6).map((s) => [s.slice(0, 160)]);
      const joined = lines.join('\n');
      const docDate = quoteDateFromText(text, p);
      const textRows = extractTextPriceRows(lines, rec.folderCustomer, rel, docDate);
      const hasPrice = /单价|价格|不含税|含税|报价|¥|￥|\d+\s*元/.test(joined);
      rec.textRows = textRows.length;
      if (textRows.length) {
        rec.mappable = 'partial-text';
        rec.note = 'Word 文字型报价：抽出 ' + textRows.length + ' 条「型号: 价格」候选行（生效日取正文报价日 ' + docDate + '；**产品名/单价仍需人工确认后再导入**）';
        seedRows.push(...textRows);
      } else {
        rec.mappable = hasPrice && /型号|规格|品名|产品|割嘴|喷嘴/.test(joined) ? 'partial' : 'no';
        rec.note = hasPrice
          ? 'Word 文档：有价格字样但逐行模式不认识（可能含表格/多列），需人工或可视化识别'
          : 'Word 文档：未见价格信息';
      }
    } catch (e) {
      rec.note = '抽取失败：' + (e && e.message);
    }
  } else if (ext === '.pdf') {
    rec.kind = 'pdf';
    const buf = fs.readFileSync(p);
    const hasTextLayer = buf.includes(Buffer.from('/Font')) || buf.includes(Buffer.from('BT'));
    rec.mappable = 'no';
    rec.note = hasTextLayer ? 'PDF（疑似有文本层，需人工/PDF 解析工具才能结构化）' : 'PDF（疑似扫描件，必须可视化识别或人工录入）';
  } else {
    rec.kind = 'csv';
    const text = fs.readFileSync(p, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean).slice(0, ROWS + 1);
    rec.sample = lines.map((l) => [l.slice(0, 160)]);
    rec.headers = (lines[0] ?? '').split(',').map((s) => s.trim());
    rec.mapColumns = mapColumns(rec.headers);
    rec.mappable = rec.mapColumns.productName !== undefined && rec.mapColumns.unitPrice !== undefined ? 'yes' : 'no';
  }

  // 能结构化 → 产出候选行（客户取文件夹名，币种与有效期留空由导入脚本/人工决定）
  if (rec.mappable === 'yes' && rec.sample.length > 1) {
    const hIdxLocal = 0; // rec.sample 已从表头行开始
    const mc = rec.mapColumns;
    for (const row of rec.sample.slice(hIdxLocal + 1)) {
      // 产品名折叠成单行；剔除合计/大写/备注等噪声行（不产出，避免把合计当报价）
      const product = String(row[mc.productName] ?? '').replace(/\s+/g, ' ').trim();
      const price = num(row[mc.unitPrice]);
      if (!product || price === undefined) continue;
      if (/合计|大写|小计|总金额|以下空白|备注|说明/.test(product)) continue;
      seedRows.push([
        rec.folderCustomer,
        product,
        price.toFixed(2),
        mc.currency !== undefined ? String(row[mc.currency] ?? '').trim() || 'CNY' : 'CNY',
        mc.validFrom !== undefined ? String(row[mc.validFrom] ?? '').trim() : '',
        '',
        '来自 ' + rel,
      ]);
    }
  }
  samples.push(rec);
}

// ---- 落盘 ----
const csvPath = path.join(OUT, 'quote_files.csv');
const head = ['文件路径', '归属文件夹客户', '类型', '可映射性', '抽样表头', '说明'];
const lines = [head.map(csvCell).join(',')];
for (const r of samples) {
  lines.push([
    r.rel,
    r.folderCustomer,
    r.kind + r.ext,
    r.mappable,
    (r.headers.length ? r.headers : (r.sample[0] ?? []).map((s) => String(s).slice(0, 40))).join(' / '),
    r.note || (r.mapColumns && Object.keys(r.mapColumns).length ? '可映射字段：' + JSON.stringify(r.mapColumns) : ''),
  ].map(csvCell).join(','));
}
fs.writeFileSync(csvPath, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');

const seedPath = path.join(OUT, 'quote_seed_candidates.csv');
const seedHead = ['客户名称', '产品名称', '单价', '币种', '生效日期', '失效日期', '备注'];
fs.writeFileSync(seedPath, '\uFEFF' + [seedHead.map(csvCell).join(','), ...seedRows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n', 'utf8');

const samplesPath = path.join(OUT, 'quote_files_samples.json');
fs.writeFileSync(samplesPath, JSON.stringify(samples, null, 1), 'utf8');

const byMappable = { yes: 0, 'partial-text': 0, partial: 0, no: 0 };
const byKind = {};
for (const r of samples) {
  byMappable[r.mappable] = (byMappable[r.mappable] ?? 0) + 1;
  byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
}
const summary = [
  '资料包报价单检索摘要（find_quote_files.mjs）',
  '===============================================',
  '资料包根目录：' + ROOT,
  '命中文件数：' + samples.length + '（文件名含 报价/价格/单价/价目/quote/price，扩展名 ∈ ' + EXTS.join('/') + '）',
  '按类型：' + JSON.stringify(byKind),
  '可映射性：Excel 表头可映射 yes=' + (byMappable.yes ?? 0) + '，Word 文字行候选 partial-text=' + (byMappable['partial-text'] ?? 0)
  + '，其余 partial=' + (byMappable.partial ?? 0) + '，不可 no=' + (byMappable.no ?? 0),
  '可结构化候选行：' + seedRows.length + ' 行 → ' + path.basename(seedPath),
  '',
  ...samples.map((r) => '- [' + r.mappable + '] ' + r.rel + '　（客户=' + r.folderCustomer + '）' + (r.note ? '　' + r.note : '')),
  '',
  '结论口径：',
  '  · yes          = 抽样里同时有「产品列 + 单价列」的表头 → 可直接转成报价导入 CSV；',
  '  · partial-text = Word 文字型报价（逐行「型号: 价格」）→ 已抽成候选行，**导入前必须人工确认**；',
  '  · partial      = 有价格但逐行模式不认识（多列表格/散文）→ 需人工或可视化识别；',
  '  · no           = 无价格信息 / 扫描件 → 无法结构化。',
  '  本脚本**不写库、不臆造价格**：认不出的行一律不产出。',
  '',
].join('\r\n');
fs.writeFileSync(path.join(OUT, 'quote_files_summary.txt'), summary, 'utf8');

console.log('资料包根目录：' + ROOT);
console.log('命中报价单类文件：' + samples.length + ' 份  ' + JSON.stringify(byKind));
console.log('可映射性：yes=' + (byMappable.yes ?? 0) + ' partial-text=' + (byMappable['partial-text'] ?? 0) + ' partial=' + (byMappable.partial ?? 0) + ' no=' + (byMappable.no ?? 0) + '；候选行 ' + seedRows.length);
console.log('清单：' + csvPath);
console.log('明细：' + samplesPath);
console.log('候选：' + seedPath);
console.log('摘要：' + path.join(OUT, 'quote_files_summary.txt'));
