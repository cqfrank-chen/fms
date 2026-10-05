#!/usr/bin/env node
/**
 * 任务三：**型号对照候选**（用于解锁计划单缺价，但必须安全 —— 只给候选，绝不自动应用）
 * =============================================================================
 * 背景：计划单里的产品写法与合同/采购单里的写法不一致（例：计划单写 \`1-1-101\`，
 * 合同写 \`Victor 乙炔割嘴 1-1-101\`）。服务端取价要求「产品名归一后完全相同」才命中，
 * 于是这些行一直缺价。本脚本把「**只差描述/品牌前缀**」的写法配成对照候选，交人工确认。
 *
 * 🔒 安全口径（甲方更正 2026，最高优先级）：
 *   ① **数字部分（含前导零、位数、后缀号数）必须逐字符完全一致** —— digitSignature 相等是硬门槛，
 *      不满足一律不成为候选（0-GPN 与 00-GPN 永不互为候选）；
 *   ② 只允许「描述/品牌前缀差异」：一方的归一写法必须是另一方的**子串**；
 *   ③ **不做无约束子串匹配去凑覆盖率**：任何一边多出/少掉数字都不算候选；宁缺勿错；
 *   ④ 脚本**只产出候选清单供人工确认**，不会写库、不会改报价、不会自动应用对照关系。
 *
 * 输入：
 *   · --seeds   tools/ziliao/contract_price_seeds.csv（历史成交价种子，含单价）
 *   · --csvdir  切片目录（默认 D:/futures/_work/doc_csv_sz + doc_csv_zh）
 * 输出：
 *   model_alias_candidates.csv          型号对照候选（计划单写法 ↔ 候选合同写法）
 *   model_alias_summary.txt             人读摘要
 *
 * 用法：node tools/ziliao/build_model_aliases.mjs [--seeds <csv>] [--csvdir <目录> ...] [--out <目录>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DOC_SLICE_DIRS, parseCsv,
  loadDocSlices, docRowValues, isProductNoise, normalizeToken, digitSignature, topFolder,
} from './lib/ziliao-extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argsOf = (k) => process.argv.reduce((a, v, i) => (v === k && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
const SEEDS = argsOf('--seeds')[0] ?? path.join(__dirname, 'contract_price_seeds.csv');
const OUT_DIR = argsOf('--out')[0] ?? __dirname;
const DIRS = argsOf('--csvdir').length ? argsOf('--csvdir') : DEFAULT_DOC_SLICE_DIRS;

/** 与 apps/api/src/ai/order-parser.service.ts 的 normName 同口径（去空格 + 去公司后缀） */
const normName = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/(公司|有限公司|co\.?|ltd\.?|inc\.?|llc|gmbh)$/g, '');

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---- 报价种子池（候选合同写法 + 单价 + 来源） ----
const seedRows = parseCsv(fs.readFileSync(SEEDS, 'utf8'));
const seedHeader = seedRows[0].map((h) => h.trim());
const ci = (n) => seedHeader.indexOf(n);
const seeds = seedRows.slice(1).map((r) => {
  const product = (r[ci('产品名称')] ?? '').trim();
  return {
    customer: (r[ci('客户名称')] ?? '').trim(),
    product,
    price: (r[ci('单价')] ?? '').trim(),
    date: (r[ci('生效日期')] ?? '').trim(),
    tok: normalizeToken(product),
    nn: normName(product),
    digits: digitSignature(product),
  };
}).filter((x) => x.product && x.tok);
const byCustomer = new Map();
for (const s of seeds) {
  if (!byCustomer.has(s.customer)) byCustomer.set(s.customer, []);
  byCustomer.get(s.customer).push(s);
}
console.log('报价种子（候选合同写法池）：' + seeds.length + ' 条（' + SEEDS + '）');

// ---- 计划单行 ----
const slices = loadDocSlices(DIRS);
const missGroups = new Map();
let planRows = 0, hitRows = 0, sizeDiffSkipped = 0;
for (const s of slices) {
  if (s.kind !== 'plan' || s.headerRowIndex < 0) continue;
  const top = topFolder(s.rel);
  const pool = byCustomer.get(top) ?? [];
  for (const row of s.rows) {
    const v = docRowValues(row, s.columns);
    if (!v.name || isProductNoise(v.name)) continue;
    planRows += 1;
    const tok = normalizeToken(v.name);
    const digits = digitSignature(v.name);
    // ① 已在同客户种子里「归一写法完全相同且数字指纹相同」→ 已命中，不算缺价
    if (pool.some((x) => x.tok === tok && x.digits === digits)) { hitRows += 1; continue; }
    const key = top + '|' + tok + '|' + digits;
    if (!missGroups.has(key)) missGroups.set(key, { customer: top, name: v.name, tok, digits, nn: normName(v.name), n: 0, files: new Set() });
    const g = missGroups.get(key);
    g.n += 1;
    g.files.add(s.rel);
  }
}

/**
 * 候选判定（唯一允许的放宽口径）：
 *   数字指纹逐字符一致（硬门槛）+ 归一写法互为子串（只允许描述/品牌前缀差异）。
 */
function candidatesFor(g) {
  const scored = [];
  for (const x of seeds) {
    // 🔒 硬门槛 1：数字部分（含前导零/位数/号数）必须逐字符完全一致
    if (x.digits !== g.digits) { if (g.tok.includes(x.tok) || x.tok.includes(g.tok)) sizeDiffSkipped += 1; continue; }
    // 🔒 硬门槛 2：只允许子串关系（描述/品牌前缀差异），不做模糊相似度
    const sub = g.tok && x.tok && (g.tok.includes(x.tok) || x.tok.includes(g.tok));
    if (!sub) continue;
    scored.push({ ...x, sameCustomer: x.customer === g.customer });
  }
  // 同客户优先；同客户内再按「写法长度最接近」排序（越接近说明差得越少）
  const same = scored.filter((x) => x.sameCustomer);
  const others = scored.filter((x) => !x.sameCustomer);
  const rank = (a, b) => Math.abs(a.tok.length - g.tok.length) - Math.abs(b.tok.length - g.tok.length);
  same.sort(rank);
  others.sort(rank);
  return { same, others };
}

const out = [];
let withCandidate = 0, noCandidate = 0, multiCandidate = 0, crossCustomerOnly = 0, rowsWithCandidate = 0, rowsNoCandidate = 0;
for (const g of missGroups.values()) {
  const { same, others } = candidatesFor(g);
  const picked = same.length ? same : others;
  const tier = same.length ? '同客户' : (others.length ? '跨客户（需甲方裁定是否可作通用价）' : '');
  if (!picked.length) {
    noCandidate += 1; rowsNoCandidate += g.n;
    out.push([g.customer, g.name, g.digits, g.n, '无候选', '', '', '', '', '', [...g.files][0] ?? '']);
    continue;
  }
  withCandidate += 1; rowsWithCandidate += g.n;
  if (picked.length > 1) multiCandidate += 1;
  if (!same.length) crossCustomerOnly += 1;
  // 置信度（可解释规则）：
  //   高 = 同客户 + 唯一候选；中 = 同客户 + 多个候选（需人工挑）；低 = 只有跨客户候选
  const conf = same.length ? (picked.length === 1 ? '高' : '中') : '低';
  for (const p of picked.slice(0, 5)) {
    out.push([g.customer, g.name, g.digits, g.n, p.product, p.customer || '（通用价）', p.price, p.date, tier, conf, [...g.files][0] ?? '']);
  }
}
out.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(b[10]).localeCompare(String(a[10])) || b[3] - a[3]);

const csvFile = path.join(OUT_DIR, 'model_alias_candidates.csv');
fs.writeFileSync(csvFile,
  '\uFEFF' + [[
    '客户（计划单文件夹）', '计划单写法', '数字指纹（逐字符）', '缺价行数',
    '候选合同/报价写法', '候选来源客户', '候选单价', '候选生效日期', '候选来源层级', '匹配置信度',
    '数字部分是否完全一致（必须为是）', '计划单来源示例文件',
  ], ...out.map((r) => [...r.slice(0, 10), '是', r[10]])]
    .map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');

const lines = [
  '型号对照候选（tools/ziliao/build_model_aliases.mjs）',
  '=====================================================',
  '口径（🔒 甲方更正 2026）：**数字部分含前导零/位数/号数必须逐字符完全一致**才允许成为候选；',
  '  只允许「描述/品牌前缀差异」（归一写法互为子串）；**绝不为凑覆盖率做无约束子串匹配**（宁缺勿错）。',
  '  本清单**只供人工确认**，脚本不写库、不改报价、不自动应用对照关系。',
  '',
  '计划单产品行 ' + planRows + '；已按「归一写法 + 数字指纹完全相同」命中 ' + hitRows + ' 行；缺价 ' + (planRows - hitRows) + ' 行 / ' + missGroups.size + ' 种写法',
  '',
  '缺价写法中的对照候选情况：',
  '  · 有候选（同客户或跨客户）：' + withCandidate + ' 种 / ' + rowsWithCandidate + ' 行',
  '  ·   其中跨客户候选（需甲方裁定是否可作通用价）：' + crossCustomerOnly + ' 种',
  '  ·   其中有多个候选（需人工挑一个）：' + multiCandidate + ' 种',
  '  · 无候选（数字部分对不上或完全找不到）：' + noCandidate + ' 种 / ' + rowsNoCandidate + ' 行',
  '  · 因数字指纹不一致而被**主动拒绝**的子串相似对：' + sizeDiffSkipped + ' 对（这些正是「不同尺寸」，拒绝是正确行为）',
  '',
  '候选条数：' + out.length + ' 条（含「无候选」占位行 ' + noCandidate + ' 条）',
  '产出：' + csvFile,
  '',
  '下一步（人工）：逐条确认 → 把确认过的「计划单写法 ↔ 合同写法」做成同客户的型号别名/报价记录，再重新导入；',
  '  跨客户的候选是否可作通用价（客户名称留空）属于**业务决定**，本脚本不代甲方决定。',
];
fs.writeFileSync(path.join(OUT_DIR, 'model_alias_summary.txt'), lines.join('\r\n') + '\r\n', 'utf8');

console.log('');
console.log('计划单产品行 ' + planRows + '　已命中 ' + hitRows + '　缺价 ' + (planRows - hitRows));
console.log('有候选 ' + withCandidate + ' 种 / ' + rowsWithCandidate + ' 行（跨客户 ' + crossCustomerOnly + ' 种，多候选 ' + multiCandidate + ' 种）');
console.log('无候选 ' + noCandidate + ' 种 / ' + rowsNoCandidate + ' 行');
console.log('因数字指纹不一致被拒绝的子串相似对 ' + sizeDiffSkipped + ' 对（不同尺寸，拒绝正确）');
console.log('候选条数 ' + out.length + ' 条');
console.log('产出：' + csvFile);
console.log('      ' + path.join(OUT_DIR, 'model_alias_summary.txt'));
