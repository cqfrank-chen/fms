#!/usr/bin/env node
/**
 * 「基础型号 + size」解析算法的**双实现一致性校验**
 * =============================================================================
 * 服务端实现 apps/api/src/ai/product-model.ts（编译后 apps/api/dist/ai/product-model.js）
 * 工具侧实现 tools/catalog/lib/product-model.mjs
 * 两者是同一算法的两份代码。本脚本用**同一批真实名称**逐条跑两遍，逐字段比对；
 * 任何一边改了算法而另一边没跟上，这里立刻报差异并以非 0 退出（CI / 提交前可跑）。
 *
 * 用法：node tools/catalog/verify_parity.mjs [--limit N]
 * 前置：apps/api 已 npm run build（本脚本只读 dist，不触发构建）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildModelIndex, parseProductModel, explainProductModel } from './lib/product-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO, 'apps', 'api', 'dist', 'ai', 'product-model.js');
const require_ = createRequire(path.join(REPO, 'apps', 'api', 'package.json'));

if (!fs.existsSync(DIST)) {
  console.error('找不到服务端编译产物：' + DIST);
  console.error('请先在 apps/api 执行 npm run build（本脚本不自动构建，避免误触发长任务）。');
  process.exit(2);
}
const server = require_(DIST);

const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_models.json'), 'utf8'));
const toolIndex = buildModelIndex(cat);
const serverIndex = server.buildModelIndex(server.CATALOG_SERIES);

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

const names = [];
for (const [file, col] of [
  [path.join(REPO, 'tools', 'ziliao', 'products_candidates.csv'), 0],
  [path.join(REPO, 'tools', 'ziliao', 'contract_price_seeds.csv'), 1],
]) {
  if (!fs.existsSync(file)) continue;
  for (const r of parseCsv(fs.readFileSync(file, 'utf8')).slice(1)) if (r[col]) names.push(r[col]);
}
// 关键样例固定清单（回归护栏：这些写法的结论必须稳定）
names.push('1-1-101', '0-1-101', '00#-3-101', 'GPN-1', '1-GPN', '0-GPN', '00-GPN', '000-GPN', '0000-GPN',
  '106 #1', '106 1#', 'G1-A', 'G1-P', '1502', '1503', 'G1-P16/10', '6290NX2', '6290NX-2',
  '割嘴 1-GPN 2#', '割嘴 1-3-GPN 产品号码6031', '割嘴 2-3-GPN 产品号码6032', '1380', '4154', '货号：4154',
  'Victor 乙炔割嘴 1-1-101', '割嘴 1-101 0#', 'M(ACE) 1#', 'A(LPG) 2#', 'SC50-1', 'MC12-3', '106HC-2', 'PNME18 割嘴 1/16', 'PNM 1/32',
  // 甲方 2026 关键纠正：前缀数字优先解释为 size（两份实现必须逐条一致）
  '3-GPN', '3-GPN 割嘴 3#', '3-GPN 割嘴 2#', '3-GPN 割嘴 000#', '割嘴 3-GPN 产品号码6029', '割嘴 3#-GPN', 'GPN-3', '3-3GPN', '3-101', '0-3-GPN',
  'smith 乙炔割嘴 SC-12-4 103g', '乙炔割嘴1-101-2 102g 货号：4191', 'sm 丙烷割嘴 SC-50-A-0 93g',
  '1503 Cutting nozzles 4#', '1503 cutting nozzles #6镀铬', 'GPN CUTTING NOZZLE 2#', '6290-AC 乙炔割嘴 HARRIS品牌 2#',
  '割嘴 GPN #3  塑料盖贴：GPN-3', 'ANME 割嘴 1/16', '1-101', '00-1-101', '000-3-101');

const limit = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '').split('=')[1] ?? 0);
const uniq = [...new Set(names)];
const use = limit > 0 ? uniq.slice(0, limit) : uniq;

const fields = ['series', 'seriesCode', 'model', 'gasType', 'size', 'orificeMm', 'thicknessRange', 'sizeKnown'];
let same = 0; const diffs = [];
for (const n of use) {
  const a = parseProductModel(n, toolIndex);
  const b = server.parseProductModel(n, serverIndex);
  const ra = explainProductModel(n, toolIndex).reason;
  const rb = server.explainProductModel(n, serverIndex).reason;
  let ok = (a === null) === (b === null);
  if (ok && a && b) for (const f of fields) if (a[f] !== b[f]) ok = false;
  if (ok && (a || b) && (ra ?? '') !== (rb ?? '')) ok = false;
  if (ok) same += 1; else diffs.push({ name: n, tool: a, server: b, toolReason: ra, serverReason: rb });
}

console.log('双实现一致性校验：共 ' + use.length + ' 个名称，一致 ' + same + '，不一致 ' + diffs.length);
for (const d of diffs.slice(0, 20)) console.log('  ✗ ' + JSON.stringify(d));
console.log('（工具侧 lib/product-model.mjs ↔ 服务端 dist/ai/product-model.js）');
process.exit(diffs.length ? 1 : 0);
