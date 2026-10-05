#!/usr/bin/env node
/**
 * 任务三配套：**剩余缺价原因分析**
 * =============================================================================
 * 回答甲方最关心的问题：「产品建档 + 报价种子导入之后，为什么还有大量缺价？」
 *
 * 输入：
 *   · --seeds  tools/ziliao/contract_price_seeds.csv（已导入/待导入的历史成交价种子）
 *   · --csvdir 切片目录（默认 D:/futures/_work/doc_csv_sz + doc_csv_zh）
 * 输出：
 *   price_gap_analysis.csv   逐「客户 + 产品写法」的缺价行清单 + 原因 + 疑似对应价源
 *   price_gap_summary.txt    人读摘要（按行数的原因分布 + Top 未命中型号）
 *
 * 判定口径（全部是**字面比较**，不做任何语义合并）：
 *   ① 计划单产品名与报价种子的**归一写法完全相同** → 已命中（不计入缺价分析）；
 *   ② 否则在**同客户**的报价种子里找「归一写法互为子串」的 → 原因 = 命名不一致（同客户有近似价源）；
 *   ③ 否则在**其它客户**的报价种子里找「归一写法互为子串」的 → 原因 = 命名不一致（其它客户有近似价源，需甲方裁定是否可作为通用价）；
 *   ④ 都找不到 → 原因 = 无任何可对应的价源（该型号族只出现在计划单里）。
 *   ⚠️ ③ 只是**测算与线索**，脚本不会把它当命中，也不会自动生成跨客户报价（那等于给没报过价的客户编价）。
 *
 * 用法：node tools/ziliao/analyze_price_gap.mjs [--seeds <csv>] [--csvdir <目录> ...] [--out <目录>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WORK, DEFAULT_DOC_SLICE_DIRS, parseCsv,
  loadDocSlices, docRowValues, isProductNoise, normalizeToken, digitSignature, topFolder,
} from './lib/ziliao-extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argsOf = (k) => process.argv.reduce((a, v, i) => (v === k && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
const SEEDS = argsOf('--seeds')[0] ?? path.join(__dirname, 'contract_price_seeds.csv');
const OUT_DIR = argsOf('--out')[0] ?? __dirname;
const DIRS = argsOf('--csvdir').length ? argsOf('--csvdir') : DEFAULT_DOC_SLICE_DIRS;

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---- 报价种子池 ----
const seedRows = parseCsv(fs.readFileSync(SEEDS, 'utf8'));
const seedHeader = seedRows[0].map((h) => h.trim());
const ci = (n) => seedHeader.indexOf(n);
const seeds = seedRows.slice(1).map((r) => ({
  customer: (r[ci('客户名称')] ?? '').trim(),
  product: (r[ci('产品名称')] ?? '').trim(),
  price: (r[ci('单价')] ?? '').trim(),
  date: (r[ci('生效日期')] ?? '').trim(),
  tok: normalizeToken(r[ci('产品名称')] ?? ''),
  digits: digitSignature(r[ci('产品名称')] ?? ''),
})).filter((x) => x.product && x.tok);
const byCustomer = new Map();
for (const s of seeds) {
  if (!byCustomer.has(s.customer)) byCustomer.set(s.customer, []);
  byCustomer.get(s.customer).push(s);
}
console.log('报价种子：' + seeds.length + ' 条（' + SEEDS + '）');

// ---- 计划单行 ----
const slices = loadDocSlices(DIRS);
const hits = [];
const missGroups = new Map();
let planRows = 0, hitRows = 0;
for (const s of slices) {
  if (s.kind !== 'plan' || s.headerRowIndex < 0) continue;
  const top = topFolder(s.rel);
  const pool = byCustomer.get(top) ?? [];
  for (const row of s.rows) {
    const v = docRowValues(row, s.columns);
    if (!v.name || isProductNoise(v.name)) continue;
    planRows += 1;
    const tok = normalizeToken(v.name);
    // ⚠️ 命中判定必须带**数字指纹**（甲方更正）：归一文本相同但数字部分不同 → 不是同一产品（不同尺寸）
    const digits = digitSignature(v.name);
    if (pool.some((x) => x.tok === tok && x.digits === digits)) { hitRows += 1; hits.push([top, v.name, s.rel]); continue; }
    const key = top + '|' + tok + '|' + digits;
    if (!missGroups.has(key)) missGroups.set(key, { customer: top, name: v.name, tok, digits, n: 0, files: new Set() });
    const g = missGroups.get(key);
    g.n += 1;
    g.files.add(s.rel);
  }
}

const out = [];
const reasonByRows = {};
const reasonByGroups = {};
for (const g of missGroups.values()) {
  // 线索也用**同一道数字守卫**：数字部分含前导零/位数/号数不一致的一律不算「近似价源」
  // （旧口径把 0-GPN 与 00-GPN 这类不同尺寸当成近似线索 —— 甲方更正后必须剔除；详见 build_model_aliases.mjs）
  const near = (x) => x.digits === g.digits && (x.tok.includes(g.tok) || g.tok.includes(x.tok));
  const sameCust = (byCustomer.get(g.customer) ?? []).find(near);
  const otherCust = sameCust ? null : seeds.find(near);
  const reason = sameCust
    ? '命名不一致：同客户有近似价源（写法包含关系，数字部分完全一致）'
    : (otherCust ? '命名不一致：其它客户文件夹有近似价源（数字部分完全一致，需甲方裁定是否可作为通用价）'
      : '无任何可对应的价源（该型号族只出现在计划单里）');
  reasonByRows[reason] = (reasonByRows[reason] ?? 0) + g.n;
  reasonByGroups[reason] = (reasonByGroups[reason] ?? 0) + 1;
  out.push([g.customer, g.name, g.n, g.files.size, reason,
    sameCust ? (sameCust.customer + ' / ' + sameCust.product + ' @' + sameCust.price + '（' + (sameCust.date || '无日期') + '）')
      : (otherCust ? (otherCust.customer + ' / ' + otherCust.product + ' @' + otherCust.price + '（' + (otherCust.date || '无日期') + '）') : ''),
    [...g.files][0] ?? '']);
}
out.sort((a, b) => b[2] - a[2]);

const csvFile = path.join(OUT_DIR, 'price_gap_analysis.csv');
fs.writeFileSync(csvFile, '\uFEFF' + [['客户', '计划单产品写法', '缺价行数', '来源文件数', '原因', '疑似对应价源（只作线索，未自动匹配）', '来源示例文件'], ...out]
  .map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');

const lines = [
  '剩余缺价原因分析（tools/ziliao/analyze_price_gap.mjs）',
  '=====================================================',
  '计划单切片：' + slices.filter((s) => s.kind === 'plan').length + ' 份　计划单产品行 ' + planRows,
  '已按报价种子命中（归一写法完全相同）：' + hitRows + ' 行',
  '仍未命中：' + (planRows - hitRows) + ' 行 / ' + missGroups.size + ' 种产品写法',
  '',
  '按**行数**的原因分布：',
  ...Object.entries(reasonByRows).sort((a, b) => b[1] - a[1]).map(([k, v]) => '  ' + String(v).padStart(5) + ' 行  ' + k),
  '',
  '按**产品写法数**的原因分布：',
  ...Object.entries(reasonByGroups).sort((a, b) => b[1] - a[1]).map(([k, v]) => '  ' + String(v).padStart(5) + ' 条  ' + k),
  '',
  '缺价行最多的 30 种产品写法：',
  ...out.slice(0, 30).map((r) => '  ' + String(r[2]).padStart(4) + ' 行  ' + r[0] + '  ' + r[1] + (r[5] ? '   ← 疑似 ' + r[5] : '')),
  '',
  '结论（不臆造）：',
  '  · 缺价的主因是**产品型号写法在各单据族之间不统一**（计划单写 "1-1-101"、合同写 "Victor 乙炔割嘴 1-1-101"），',
  '    而不是报价缺失或管线故障：报价种子里的产品名与计划单里的产品名**字面不同**时，服务端的取价规则（归一后必须完全相等）不会命中；',
  '  · 缓解办法有两条，都需要甲方给一份**对照表**（脚本不替甲方合并、不跨客户编价）：',
  '      ① 同客户内：把计划单写法与采购单/合同写法做成「型号别名」，导入同客户的报价即可命中；',
  '      ② 跨客户（安宝合同 → 嵊州海田计划单）：把安宝的成交价作为**通用价**（客户名称留空）导入 —— 这是业务决定，',
  '         本脚本只给出线索清单，不会自动生成。',
];
fs.writeFileSync(path.join(OUT_DIR, 'price_gap_summary.txt'), lines.join('\r\n') + '\r\n', 'utf8');

console.log('');
console.log('计划单产品行 ' + planRows + '　已命中 ' + hitRows + '　仍缺价 ' + (planRows - hitRows));
for (const [k, v] of Object.entries(reasonByRows).sort((a, b) => b[1] - a[1])) console.log('   按行 ' + String(v).padStart(5) + '  ' + k);
console.log('产出：' + csvFile);
console.log('      ' + path.join(OUT_DIR, 'price_gap_summary.txt'));
