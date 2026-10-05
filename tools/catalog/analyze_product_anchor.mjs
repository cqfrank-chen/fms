#!/usr/bin/env node
/**
 * 产品档案 → 官方目录**锚定分析**（任务二第 1 步：把每条产品名解析为 (系列, 基础型号, size)）
 * =============================================================================
 * 输入：tools/ziliao/products_candidates.csv（客户资料包抽出的 1444 条产品建档候选）
 * 输出：
 *   product_anchor.csv        逐条锚定结果（含未锚定原因）
 *   product_anchor_report.md  锚定覆盖率报告 + 未锚定分类（**待甲方确认清单**）
 *
 * 口径（宁缺勿错）：
 *   · 只有「型号锚定到官方目录 + size（若写了）逐字符等于目录档位」才算 matched；
 *   · 型号没写尺寸 → size 列留空、sizeKnown=no，**不等于任意尺寸**（匹配时不会跨尺寸命中）；
 *   · 锚定不到的一律**不猜**：保持现状，标记 unmatched 并给出原因，进「待甲方确认清单」。
 *
 * 用法：node tools/catalog/analyze_product_anchor.mjs [--products <csv>] [--out <目录>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModelIndex, explainProductModel } from './lib/product-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const argsOf = (k) => process.argv.reduce((a, v, i) => (v === k && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
const PRODUCTS = argsOf('--products')[0] ?? path.join(REPO, 'tools', 'ziliao', 'products_candidates.csv');
const OUT = argsOf('--out')[0] ?? __dirname;

const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_models.json'), 'utf8'));
const idx = buildModelIndex(cat);

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

const rows = parseCsv(fs.readFileSync(PRODUCTS, 'utf8'));
const head = rows[0].map((h) => h.trim());
const ci = (n) => head.indexOf(n);
const items = rows.slice(1).map((r) => ({
  name: (r[ci('产品名称')] ?? '').trim(),
  suggestType: (r[ci('建议产品类型')] ?? '').trim(),
  count: Number(r[ci('出现次数')] ?? 0) || 0,
  files: Number(r[ci('来源文件数')] ?? 0) || 0,
}));

const out = [];
const stats = {
  total: items.length, matched: 0, sizeKnown: 0, unmatched: 0,
  tbdTotal: 0, tbdMatched: 0, tbdMatchedSize: 0,
  bySeries: {}, byGas: {}, byReason: {}, typeConflict: 0,
};
const unmatchedFamilies = new Map();

for (const it of items) {
  const ex = explainProductModel(it.name, idx);
  const p = ex.result;
  if (p) {
    stats.matched += 1;
    if (p.sizeKnown) stats.sizeKnown += 1;
    const key = p.series.replace(' STYLE CUTTING TIP', '');
    stats.bySeries[key] = (stats.bySeries[key] ?? 0) + 1;
    stats.byGas[p.gasType ?? '未标注'] = (stats.byGas[p.gasType ?? '未标注'] ?? 0) + 1;
    if (it.suggestType === '待定') {
      stats.tbdTotal += 1; stats.tbdMatched += 1;
      if (p.sizeKnown) stats.tbdMatchedSize += 1;
    }
    const gasWord = p.gasType === 'ACETYLENE' ? 'acetylene' : (p.gasType === 'LPG' ? 'propane' : null);
    if (gasWord && it.suggestType && it.suggestType !== '待定' && !it.suggestType.endsWith(gasWord)) stats.typeConflict += 1;
  } else {
    stats.unmatched += 1;
    const reason = (ex.reason ?? '未锚定').replace(/（[^）]*）/g, '');
    stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
    const toks = it.name.match(/[0-9A-Za-z][0-9A-Za-z\-_.\/]*/g) ?? [];
    const fam = (toks.sort((a, b) => b.length - a.length)[0] ?? '(无数号)').toUpperCase();
    if (!unmatchedFamilies.has(fam)) unmatchedFamilies.set(fam, { fam, n: 0, rows: 0, samples: [] });
    const f = unmatchedFamilies.get(fam);
    f.n += 1; f.rows += it.count;
    if (f.samples.length < 6) f.samples.push(it.name.replace(/\s+/g, ' ').slice(0, 46));
    if (it.suggestType === '待定') stats.tbdTotal += 1;
  }
  out.push([it.name.replace(/\s+/g, ' '), p ? 'matched' : 'unmatched',
    p ? p.series : '', p ? p.seriesCode : '', p ? p.model : '', p ? (p.size ?? '') : '',
    p ? (p.sizeKnown ? 'yes' : 'no') : '', p ? (p.gasType ?? '') : '',
    p ? (p.orificeMm ?? '') : '', p ? (p.thicknessRange ?? '') : '',
    (ex.reason ?? ''), it.suggestType, it.count, it.files]);
}

const HEADER = ['产品名称', '锚定状态', '系列', '系列编号', '基础型号', 'size', 'size是否明确', '气体类型',
  'orifice_mm', 'thickness_range', '未锚定原因', '现有建议产品类型', '出现次数', '来源文件数'];
fs.writeFileSync(path.join(OUT, 'product_anchor.csv'),
  '\uFEFF' + [HEADER, ...out].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');

const fams = [...unmatchedFamilies.values()].sort((a, b) => b.rows - a.rows);
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0') + '%';
const md = [];
md.push('# 产品档案 → 官方目录锚定报告（任务二：用目录做锚定）');
md.push('');
md.push('> 口径：**型号必须锚定到官方目录（6 系列 / 37 型号）**；size 必须逐字符等于该型号的目录档位');
md.push('> （0 ≠ 00 ≠ 000），且与型号之间有分隔符。锚定不到就**保持现状并标记**，绝不臆造。');
md.push('');
md.push('- 输入：`' + path.relative(REPO, PRODUCTS).replace(/\\/g, '/') + '`（' + stats.total + ' 条产品建档候选）');
md.push('- 脚本：`tools/catalog/analyze_product_anchor.mjs`；逐条结果：`tools/catalog/product_anchor.csv`');
md.push('');
md.push('## 一、锚定覆盖率');
md.push('');
md.push('| 指标 | 条数 | 占比 |');
md.push('| --- | --- | --- |');
md.push('| 产品候选总数 | ' + stats.total + ' | 100% |');
md.push('| **锚定成功（matched）** | **' + stats.matched + '** | ' + pct(stats.matched, stats.total) + ' |');
md.push('| —— 其中 size 明确（写明了尺寸档位） | ' + stats.sizeKnown + ' | ' + pct(stats.sizeKnown, stats.total) + ' |');
md.push('| 未锚定（unmatched，保持现状并标记） | ' + stats.unmatched + ' | ' + pct(stats.unmatched, stats.total) + ' |');
md.push('');
md.push('### 按「现建议产品类型」看锚定（重点：1173 条 tbd 能消掉多少）');
md.push('');
md.push('| 指标 | 条数 |');
md.push('| --- | --- |');
md.push('| 现有档案里建议类型为「待定」的 | ' + stats.tbdTotal + ' |');
md.push('| —— 其中**被目录锚定**（可据此填系列 / 气体类型） | **' + stats.tbdMatched + '** |');
md.push('| —— 其中 size 也明确 | ' + stats.tbdMatchedSize + ' |');
md.push('| 既有类型与目录气体**冲突**（如标 us_propane 但目录该型号是 ACE） | ' + stats.typeConflict + ' |');
md.push('');
md.push('### 锚定成功的系列 / 气体分布');
md.push('');
md.push('| 系列 | 条数 |');
md.push('| --- | --- |');
for (const [k, v] of Object.entries(stats.bySeries).sort((a, b) => b[1] - a[1])) md.push('| ' + k + ' | ' + v + ' |');
md.push('| **合计** | **' + stats.matched + '** |');
md.push('');
md.push('| 气体类型 | 条数 |');
md.push('| --- | --- |');
for (const [k, v] of Object.entries(stats.byGas).sort((a, b) => b[1] - a[1])) md.push('| ' + k + ' | ' + v + ' |');
md.push('');
md.push('## 二、未锚定原因分布');
md.push('');
md.push('| 原因 | 条数 |');
md.push('| --- | --- |');
for (const [k, v] of Object.entries(stats.byReason).sort((a, b) => b[1] - a[1])) md.push('| ' + k + ' | ' + v + ' |');
md.push('');
md.push('## 三、待甲方确认清单（未锚定按「型号族」聚合）');
md.push('');
md.push('这些型号族**不在 2026 版目录里**（或目录里的写法与单据不同），脚本一律不猜。');
md.push('请甲方确认每个族与目录型号的对应关系后，再决定是否建立「型号别名」。');
md.push('');
md.push('| # | 型号族（疑似） | 条数 | 累计出现次数 | 写法样例 | 判断线索 |');
md.push('| --- | --- | --- | --- | --- | --- |');
const HINTS = {
  W: '目录没有 W 族（加热/焊接件？），需确认是否属于切割嘴目录范围',
  MFA: '加热/钎焊系列，本期目录（6 系列 37 型号）不含',
  MFN: '同 MFA，本期目录不含',
  '106HC': '目录有 106（KOIKE 日式），但 106HC 是另一贸易代号 —— 需确认 106HC ≡ 106 还是独立型号',
  '102HC': '同 106HC：目录有 102',
  PNME: '目录有 PNME，但单据写 PNME18 / PNME9（后缀数字不在目录档位）—— 需确认后缀含义',
  PNM: '疑为目录 PNME 的简写（缺 E）—— 需确认',
  ANM: '疑为目录 ANME 的简写（缺 E）—— 需确认',
  '6290VVC': '目录有 6290 / 6290AC / 6290NX / 6290NFF，没有 VVC —— 需确认',
  GPP: '目录有 GPN（丙烷）；GPP 是否为另一型号？需确认',
  R3P: '目录没有该族',
  '1-GPN': '合同里同时写了前导数字与 # 号数（如「割嘴 1-GPN 2#」）→ 尺寸歧义，脚本不猜',
};
fams.slice(0, 40).forEach((f, i) => {
  md.push('| ' + (i + 1) + ' | ' + f.fam + ' | ' + f.n + ' | ' + f.rows + ' | '
    + f.samples.slice(0, 3).map((s) => '`' + s + '`').join(' / ') + ' | ' + (HINTS[f.fam] ?? '—') + ' |');
});
if (fams.length > 40) {
  const rest = fams.slice(40);
  md.push('| … | 其余 ' + rest.length + ' 个族 | ' + rest.reduce((n, f) => n + f.n, 0) + ' | '
    + rest.reduce((n, f) => n + f.rows, 0) + ' | 见 product_anchor.csv | — |');
}
md.push('');
md.push('## 四、口径与实现');
md.push('');
md.push('1. **型号识别**：把名字压成「紧凑键」（只留字母数字、小写），在其中定位目录型号；');
md.push('   连字符 / 空格 / 点号 / 斜杠差异因此自动等价（3GPN ↔ 3-GPN、MC12 ↔ MC-12、6290NX ↔ 6290-NX）；');
md.push('2. **size 识别**（甲方规则：型号前 / 型号后 / # 后的数字 = size）：');
md.push('   型号前 N- 或 N#-、型号后 -N / 空格N / N# / #N，以及隔一段描述后的 N# / #N；');
md.push('3. **安全守卫**：');
md.push('   · size 必须**逐字符**命中该型号目录档位（0 / 00 / 000 是三档，绝不互相顶替）；');
md.push('   · 型号必须在边界上（左侧是分隔符/串首，右侧是分隔符/串尾或紧跟合法 size），否则作废');
md.push('     —— 所以货号 4154 不会被当成型号 41、1380 不会被当成 138 的 size 0；');
md.push('   · 型号前后**同时**出现数字且不同 → 「尺寸有歧义」，不出结论（如 割嘴 1-GPN 2#）；');
md.push('   · 型号锚定到了、但旁边数字不是目录档位（PNME18 的 18）→ 同样不锚定（尺寸未定死）。');
md.push('4. **服务端与工具侧同算法双实现**，由 `tools/catalog/verify_parity.mjs` 逐条比对防漂移。');
md.push('');
fs.writeFileSync(path.join(OUT, 'product_anchor_report.md'), md.join('\n') + '\n', 'utf8');

console.log('产品候选 ' + stats.total + '：锚定 ' + stats.matched + '（size 明确 ' + stats.sizeKnown + '），未锚定 ' + stats.unmatched);
console.log('  待定可消掉：' + stats.tbdMatched + ' / ' + stats.tbdTotal + '；既有类型与目录气体冲突 ' + stats.typeConflict);
console.log('  按系列：' + JSON.stringify(stats.bySeries));
console.log('  按气体：' + JSON.stringify(stats.byGas));
console.log('  未锚定族（前 12）：' + fams.slice(0, 12).map((f) => f.fam + 'x' + f.n).join(', '));
console.log('产出：' + path.join(OUT, 'product_anchor.csv'));
console.log('      ' + path.join(OUT, 'product_anchor_report.md'));
