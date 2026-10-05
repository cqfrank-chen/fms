#!/usr/bin/env node
/**
 * 官方产品目录解析器（零依赖，纯 Node）
 * =============================================================================
 * 输入：甲方提供的 2026 版产品目录 HTML（切割嘴 CUTTING NOZZLES）
 *       默认 D:/Dsh/project/product_catalog/Product_Model_Catalogue_photos_only.html
 * 输出（同目录）：
 *   catalog_models.json   机器可读型号矩阵：series[] → models[] → sizes[]
 *   model_matrix.csv      逐「型号 × size」一行（供人工核对 / 数据锚定）
 *   catalog_parse_report.md  解析报告（抽到多少系列/型号/size，无法解析部分）
 *
 * 目录结构（已实测）：
 *   <section class="page"> … <div class="band"><h2><span class="btag">01</span>SERIES NAME</h2>…
 *     <div class="card">
 *       <img … alt="MODEL">  <div class="phcap">MODEL</div>
 *       <tr class="hd"><th class="mh">Model</th><td class="mc">MODEL</td><td class="mc3">…</td></tr>
 *       <tr class="ch"><th>size</th><th>orifice(mm)</th><th>thickness(mm)</th></tr>
 *       <tr><td class="c-size">00</td><td class="c-or">0.8</td><td class="c-th">3-6</td></tr>…
 *       <div class="fline"><span class="gas lpg">GPN FOR L.P.G</span></div>
 *
 * 口径：
 *   · **size = 目录的 size setting**（前导零原样保留：000 / 00 / 0 是三个不同 size）；
 *   · orifice = 切割孔径(mm)；thickness = 切割厚度范围(mm)；
 *   · 气体类型从表下 "MODEL FOR L.P.G" / "MODEL FOR ACE" 标注读取（LPG / 乙炔）。
 *
 * 用法：node tools/catalog/parse_catalog.mjs [--html <路径>] [--out <目录>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argsOf = (k) => process.argv.reduce((a, v, i) => (v === k && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
const HTML = argsOf('--html')[0] ?? 'D:/Dsh/project/product_catalog/Product_Model_Catalogue_photos_only.html';
const OUT = argsOf('--out')[0] ?? __dirname;

const unescapeHtml = (s) => String(s ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const textOf = (s) => unescapeHtml(String(s ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

/** 气体类型：目录表下标注 "MODEL FOR L.P.G" / "MODEL FOR ACE" */
function gasFromLabel(label) {
  const s = String(label ?? '').toUpperCase();
  if (/L\.?\s*P\.?\s*G/.test(s)) return 'LPG';
  if (/\bACE\b|ACETYLENE/.test(s)) return 'ACETYLENE';
  return null;
}

function parse(html) {
  // 图片内联 base64 体积极大，先整体剔除，避免正则回溯
  const t = html.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, 'IMG');
  const pages = t.split('<section class="page">').slice(1);
  const series = [];
  const byName = new Map();
  const problems = [];

  pages.forEach((page, pi) => {
    const bandM = page.match(/<div class="band">([\s\S]*?)<\/div>\s*<div class="strip">/);
    if (!bandM) return;
    const codeM = bandM[1].match(/<span class="btag">([^<]*)<\/span>/);
    // 标题要去掉「系列编号」徽标与右下角角标（"(continued)" / "20 models"）——二者都不是系列名
    const title = textOf(bandM[1]
      .replace(/<span class="btag">[\s\S]*?<\/span>/, '')
      .replace(/<span class="bsub">[\s\S]*?<\/span>/, ''));
    const countM = bandM[1].match(/<span class="bsub">([^<]*)<\/span>/);
    const expected = countM && /(\d+)\s*models?/i.test(textOf(countM[1])) ? Number(RegExp.$1) : null;
    // 目录 / 封面页（CONTENTS 之类）没有 card
    const cards = page.split('<div class="card">').slice(1);
    if (!cards.length) return;

    let s = byName.get(title);
    if (!s) {
      s = { code: codeM ? textOf(codeM[1]) : '', series: title, pages: [], expectedModels: expected, models: [] };
      byName.set(title, s); series.push(s);
    }
    if (!s.pages.includes(pi)) s.pages.push(pi);

    for (const c of cards) {
      const alt = (c.match(/alt="([^"]*)"/) ?? [, ''])[1];
      const cap = textOf((c.match(/<div class="phcap">([\s\S]*?)<\/div>/) ?? [, ''])[1]);
      const mc = textOf((c.match(/<td class="mc">([\s\S]*?)<\/td>/) ?? [, ''])[1]);
      const mc3 = textOf((c.match(/<td class="mc3">([\s\S]*?)<\/td>/) ?? [, ''])[1]);
      const model = mc || cap || alt;
      if (!model) { problems.push('第 ' + (pi + 1) + ' 页有一张卡片取不到型号名'); continue; }
      if (cap && mc && cap !== mc) problems.push('型号名不一致（phcap=' + cap + ' / Model 单元格=' + mc + '）');
      const chs = [...c.matchAll(/<tr class="ch">([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<th>([^<]*)<\/th>/g)].map((x) => textOf(x[1])));
      const rows = [...c.matchAll(/<td class="c-size">([^<]*)<\/td>\s*<td class="c-or">([^<]*)<\/td>\s*<td class="c-th">([^<]*)<\/td>/g)]
        .map((m) => ({ size: unescapeHtml(m[1]).trim(), orifice: unescapeHtml(m[2]).trim(), thickness: unescapeHtml(m[3]).trim() }));
      const gasLabel = textOf((c.match(/<span class="gas [a-z]+">([^<]*)<\/span>/) ?? [, ''])[1]);
      const gas = gasFromLabel(gasLabel) ?? gasFromLabel(model);
      if (!gas) problems.push('型号 ' + model + ' 未标注气体类型（标注：' + JSON.stringify(gasLabel) + '）');
      if (!rows.length) problems.push('型号 ' + model + ' 没有任何 size 行');
      for (const r of rows) {
        if (!r.size) problems.push('型号 ' + model + ' 有一行 size 为空');
      }
      // 同一型号在目录里只应出现一次；重复出现（多页续表）时报出来，交给人工核对
      const prev = s.models.find((m) => m.model === model);
      if (prev) problems.push('型号 ' + model + ' 在系列 [' + title + '] 内出现多次（跨页续表）');
      else s.models.push({
        model, gasType: gas, gasLabel, alt, thirdCol: mc3,
        colHeaders: chs[0] ?? [], page: pi + 1, sizes: rows,
      });
    }
  });
  return { series, problems };
}

const html = fs.readFileSync(HTML, 'utf8');
const { series, problems } = parse(html);

/**
 * 型号别名：**只登记「目录印刷型号之外、但确实指同一型号的写法」**。
 * 目前只有目录里 A / M 两族的「下划线写法」（单据里出现过 A_AC / M_LPG）。
 * 其余连字符/空格/点号差异由 compactKey（去分隔符后比较）天然覆盖，不需要登记。
 */
const ALIASES = {
  'A(ACE)': ['A_AC', 'A-AC'],
  'A(LPG)': ['A_LPG', 'A-LPG'],
  'M(ACE)': ['M_AC', 'M-AC'],
  'M(LPG)': ['M_LPG', 'M-LPG'],
};
for (const s of series) for (const m of s.models) if (ALIASES[m.model]) m.aliases = ALIASES[m.model];

const totalModels = series.reduce((n, s) => n + s.models.length, 0);
const totalSizes = series.reduce((n, s) => n + s.models.reduce((k, m) => k + m.sizes.length, 0), 0);
for (const s of series) {
  s.sizeCount = s.models.reduce((k, m) => k + m.sizes.length, 0);
  if (s.expectedModels != null && s.expectedModels !== s.models.length) {
    problems.push('系列 [' + s.series + '] 目录标注 ' + s.expectedModels + ' 个型号，实际抽到 ' + s.models.length + ' 个');
  }
}

const json = {
  source: path.resolve(HTML).replace(/\\/g, '/'),
  parsedAt: new Date().toISOString().slice(0, 10),
  seriesCount: series.length,
  modelCount: totalModels,
  sizeCount: totalSizes,
  legend: { size: 'catalogue size setting', orifice: 'cutting orifice (mm)', thickness: 'cutting thickness range (mm)' },
  series,
};
fs.writeFileSync(path.join(OUT, 'catalog_models.json'), JSON.stringify(json, null, 2) + '\n', 'utf8');

const rows = [['系列编号', '系列', '型号', '气体类型', 'size', 'orifice_mm', 'thickness_range', '目录页']];
for (const s of series) for (const m of s.models) for (const r of m.sizes) {
  rows.push([s.code, s.series, m.model, m.gasType, r.size, r.orifice, r.thickness, String(m.page)]);
}
fs.writeFileSync(path.join(OUT, 'model_matrix.csv'), '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');

const md = [];
md.push('# 官方产品目录解析报告（切割嘴 CUTTING NOZZLES · 2026 版）');
md.push('');
md.push('- 来源：`' + path.resolve(HTML).replace(/\\/g, '/') + '`');
md.push('- 解析器：`tools/catalog/parse_catalog.mjs`（零依赖纯 Node）');
md.push('- 产物：`tools/catalog/catalog_models.json`（机器可读矩阵）、`tools/catalog/model_matrix.csv`（逐型号×size）');
md.push('');
md.push('## 一、总览');
md.push('');
md.push('| 指标 | 实测 | 目录封面/目录页标注 | 一致 |');
md.push('| --- | --- | --- | --- |');
md.push('| 系列数 | ' + series.length + ' | 6 | ' + (series.length === 6 ? '✅' : '❌') + ' |');
md.push('| 型号数 | ' + totalModels + ' | 37 | ' + (totalModels === 37 ? '✅' : '❌') + ' |');
md.push('| 型号×size 行数 | ' + totalSizes + ' | — | — |');
md.push('');
md.push('## 二、逐系列核对（系列 / 型号数 / 大小档数 / 气体）');
md.push('');
md.push('| 编号 | 系列 | 目录标注型号数 | 实测型号数 | size 行数 | 气体构成 | 目录页 |');
md.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const s of series) {
  const g = {};
  for (const m of s.models) g[m.gasType ?? '未标注'] = (g[m.gasType ?? '未标注'] ?? 0) + 1;
  md.push('| ' + s.code + ' | ' + s.series + ' | ' + (s.expectedModels ?? '—') + ' | ' + s.models.length + ' | ' + s.sizeCount + ' | '
    + Object.entries(g).map(([k, v]) => k + '×' + v).join('，') + ' | ' + s.pages.map((p) => p + 1).join(',') + ' |');
}
md.push('');
md.push('## 三、逐型号清单（型号 / 气体 / size 档位 / 孔径范围 / 厚度范围）');
md.push('');
md.push('| 系列 | 型号 | 气体 | size 档位（原样，含前导零） | 孔径 mm | 厚度 mm |');
md.push('| --- | --- | --- | --- | --- | --- |');
for (const s of series) for (const m of s.models) {
  const sz = m.sizes.map((r) => r.size);
  const ors = m.sizes.map((r) => r.orifice).filter((x) => x);
  const ths = m.sizes.map((r) => r.thickness).filter((x) => x);
  md.push('| ' + s.series.replace(' STYLE CUTTING TIP', '') + ' | ' + m.model + ' | ' + (m.gasType ?? '—') + ' | ' + sz.join(' / ')
    + ' | ' + (ors.length ? ors[0] + '–' + ors[ors.length - 1] : '—') + ' | ' + (ths.length ? ths[0] + ' … ' + ths[ths.length - 1] : '—') + ' |');
}
md.push('');
md.push('## 四、无法解析 / 需人工确认的部分');
md.push('');
if (!problems.length) md.push('无。全部卡片都取到了型号名、气体类型与非空 size 行。');
else { md.push('| # | 说明 |'); md.push('| --- | --- |'); problems.forEach((p, i) => md.push('| ' + (i + 1) + ' | ' + p + ' |')); }
md.push('');
md.push('## 五、口径说明（与甲方规则对齐）');
md.push('');
md.push('1. **size 是型号的尺寸档位**：目录里 000 / 00 / 0 / 1 / 2 … 各自是一档，**前导零原样保留**，');
md.push('   因此 `0-GPN`、`00-GPN`、`000-GPN` 是**同一型号（GPN）的三个不同 size**，各自是独立产品；');
md.push('2. 气体类型来自目录每个规格表下方的 `<型号> FOR L.P.G` / `<型号> FOR ACE` 标注，未标注的一律记 `未标注` 并进「待人工确认」，**不臆造**；');
md.push('3. 本报告只描述**目录本身**；把客户资料包里的产品名锚定到本目录的结论见 `product_anchor_report.md`。');
fs.writeFileSync(path.join(OUT, 'catalog_parse_report.md'), md.join('\n') + '\n', 'utf8');

console.log('系列 ' + series.length + ' 个；型号 ' + totalModels + ' 个；型号×size ' + totalSizes + ' 行');
for (const s of series) console.log('  ' + s.code + '  ' + s.series.padEnd(32) + s.models.length + ' 型号 / ' + s.sizeCount + ' size 行');
console.log('问题条目：' + problems.length);
problems.forEach((p) => console.log('  ! ' + p));
console.log('产出：' + path.join(OUT, 'catalog_models.json'));
console.log('      ' + path.join(OUT, 'model_matrix.csv'));
console.log('      ' + path.join(OUT, 'catalog_parse_report.md'));
