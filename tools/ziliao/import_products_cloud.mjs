#!/usr/bin/env node
/**
 * 产品建档候选 → FMS 批量导入（云端 / 本地均可）
 * =============================================================================
 * **复用既有接口**：POST /api/master-data/import/preview → POST /api/master-data/import/commit（target=products）。
 * 分类统计、幂等判重（按产品名归一）、枚举校验全部由服务端 master-import.service.ts 负责，
 * 脚本不自己实现业务规则 —— 保证「界面导入」与「脚本导入」是同一套口径。
 *
 * 幂等策略：服务端按产品名（trim + 全角半角 + 大小写归一）判重。
 *   · --mode insert-only（默认）：已存在 → 跳过（只新增，不覆盖人工维护过的档案）；
 *   · --mode upsert：已存在且字段有变化 → 更新（会覆盖类型/默认包装）。
 *   两种模式都不会重复建档；复跑安全（第二次预览应显示 新增 0）。
 *
 * 用法（**务必先 --dry-run 看分类统计**）：
 *   # 本地
 *   node tools/ziliao/import_products_cloud.mjs --in tools/ziliao/products_candidates.csv --dry-run
 *   node tools/ziliao/import_products_cloud.mjs --in tools/ziliao/products_candidates.csv
 *   # 云端（只改 FMS_BASE，其余命令一致）
 *   $env:FMS_BASE = "https://<云端地址>/api"
 *   node tools/ziliao/import_products_cloud.mjs --in tools/ziliao/products_candidates.csv --dry-run
 *
 * 过滤参数（默认全量导入候选清单）：
 *   --min-count N            只导入出现次数 ≥ N 的产品
 *   --exclude-low-confidence 排除「置信度=低」（只出现 1 次）的候选
 *   --exclude-tbd            排除「建议产品类型=待定」的候选（**不建议**：甲方要求先用资料补建档）
 *   --limit N                小批试跑
 *
 * 环境变量：FMS_BASE（默认 http://127.0.0.1:3100/api）、FMS_USER / FMS_PASS（默认 admin/Fms@2026）、FMS_TOKEN（优先）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './lib/ziliao-extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argsOf = (k) => process.argv.reduce((a, v, i) => (v === k && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
const IN = argsOf('--in')[0] ?? path.join(__dirname, 'products_candidates.csv');
const MODE = (argsOf('--mode')[0] ?? 'insert-only') === 'upsert' ? 'upsert' : 'insert-only';
const DRY = process.argv.includes('--dry-run');
const OUT = argsOf('--out')[0] ?? path.resolve(__dirname, '../../.scratch/product-import');
const MIN_COUNT = Number(argsOf('--min-count')[0] ?? 0) || 0;
const LIMIT = Number(argsOf('--limit')[0] ?? 0) || 0;
const EXCLUDE_LOW = process.argv.includes('--exclude-low-confidence');
const EXCLUDE_TBD = process.argv.includes('--exclude-tbd');
const BASE = (process.env.FMS_BASE ?? 'http://127.0.0.1:3100/api').replace(/\/+$/, '');
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
const TOKEN = process.env.FMS_TOKEN ?? '';

if (!fs.existsSync(IN)) { console.error('文件不存在：' + IN); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function login() {
  if (TOKEN) return TOKEN;
  const r = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error('登录失败（' + r.status + '）：' + JSON.stringify(j));
  return j.token;
}

async function req(pathname, body, token) {
  const r = await fetch(BASE + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  return { status: r.status, body: j };
}

// ---- 读候选 CSV（表头见 tools/ziliao/products_candidates.csv）----
const table = parseCsv(fs.readFileSync(IN, 'utf8'));
if (table.length < 2) { console.error('候选 CSV 没有数据行：' + IN); process.exit(2); }
const header = table[0].map((h) => h.trim());
const col = (name) => header.findIndex((h) => h === name);
const iName = col('产品名称');
const iType = col('建议产品类型');
const iPkg = col('默认包装');
const iCount = col('出现次数');
const iConf = col('置信度');
const iFiles = col('来源文件数');
if (iName < 0 || iType < 0) { console.error('候选 CSV 缺少「产品名称」或「建议产品类型」列：' + JSON.stringify(header)); process.exit(2); }

let picks = table.slice(1).map((r) => ({
  name: (r[iName] ?? '').trim(),
  type: (r[iType] ?? '').trim() || '待定',
  packaging: iPkg >= 0 ? (r[iPkg] ?? '').trim() : '',
  count: iCount >= 0 ? Number(r[iCount] ?? 0) || 0 : 0,
  conf: iConf >= 0 ? (r[iConf] ?? '').trim() : '',
  files: iFiles >= 0 ? Number(r[iFiles] ?? 0) || 0 : 0,
})).filter((x) => x.name);

const total0 = picks.length;
if (MIN_COUNT) picks = picks.filter((x) => x.count >= MIN_COUNT);
if (EXCLUDE_LOW) picks = picks.filter((x) => x.conf !== '低');
if (EXCLUDE_TBD) picks = picks.filter((x) => x.type !== '待定');
if (LIMIT) picks = picks.slice(0, LIMIT);

console.log('目标接口：' + BASE + (DRY ? '（--dry-run 只预览不写库）' : ''));
console.log('候选文件：' + IN + '　候选 ' + total0 + ' 条 → 本次导入 ' + picks.length + ' 条（模式 ' + MODE + '）');
if (MIN_COUNT) console.log('  过滤：出现次数 ≥ ' + MIN_COUNT);
if (EXCLUDE_LOW) console.log('  过滤：排除置信度=低');
if (EXCLUDE_TBD) console.log('  过滤：排除建议类型=待定');

// ---- 生成服务端模板格式的 CSV（型号 / 类型 / 默认包装）----
const importCsv = '\uFEFF' + [
  ['型号', '类型', '默认包装'],
  ...picks.map((p) => [p.name, p.type, p.packaging]),
].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const importFile = path.join(OUT, 'products_import.csv');
fs.writeFileSync(importFile, importCsv, 'utf8');
console.log('生成导入文件：' + importFile + '（' + Buffer.byteLength(importCsv) + ' 字节）');

const upload = {
  target: 'products', mode: MODE,
  file: 'data:text/csv;base64,' + Buffer.from(importCsv, 'utf8').toString('base64'),
  fileName: 'products_import.csv',
};

const token = await login();
const pv = await req('/master-data/import/preview', upload, token);
if (pv.status >= 300) { console.error('预览失败（' + pv.status + '）：' + JSON.stringify(pv.body)); process.exit(1); }
const s = pv.body.summary;
console.log('--- 预览（服务端分类统计）---');
console.log('  文件类型：' + pv.body.fileKind + '　表头行：# ' + (pv.body.headerRowIndex + 1));
console.log('  识别到的列：' + JSON.stringify(pv.body.columns) + (pv.body.unmappedHeaders?.length ? '　未识别列：' + JSON.stringify(pv.body.unmappedHeaders) : ''));
console.log('  共 ' + s.total + ' 行：新增 ' + s.new + ' / 更新 ' + s.update + ' / 跳过 ' + s.skip + ' / 错误 ' + s.error);
for (const row of pv.body.rows.filter((r) => r.status === 'error').slice(0, 20)) {
  console.log('  [错误] 第 ' + row.rowNo + ' 行「' + (row.data.name ?? '') + '」：' + row.reasons.join('；'));
}

const report = { base: BASE, input: IN, mode: MODE, dryRun: DRY, picked: picks.length, importFile, preview: { summary: s, errors: pv.body.rows.filter((r) => r.status === 'error') } };
if (DRY) {
  console.log('（--dry-run：到此为止，未写库）');
  const f = path.join(OUT, 'products_import_preview.json');
  fs.writeFileSync(f, JSON.stringify(report, null, 1));
  console.log('报告：' + f);
  process.exit(s.error ? 1 : 0);
}

const cm = await req('/master-data/import/commit', upload, token);
if (cm.status >= 300) { console.error('导入失败（' + cm.status + '）：' + JSON.stringify(cm.body)); process.exit(1); }
const c = cm.body.summary;
console.log('--- 导入完成 ---');
console.log('  新增 ' + c.new + ' / 更新 ' + c.update + ' / 跳过 ' + c.skip + ' / 失败 ' + c.error);
for (const f of (cm.body.failures ?? []).slice(0, 20)) console.log('  [失败] 第 ' + f.rowNo + ' 行「' + f.name + '」：' + f.reason);
report.commit = cm.body;

// 幂等复核：同一文件再跑一次，insert-only 模式下应全部「跳过」、新增 0
const again = await req('/master-data/import/preview', upload, token);
if (again.status < 300) {
  console.log('--- 幂等复核（同一文件再预览一次）---');
  console.log('  新增 ' + again.body.summary.new + ' / 更新 ' + again.body.summary.update + ' / 跳过 ' + again.body.summary.skip + ' / 错误 ' + again.body.summary.error);
  report.previewAfterCommit = again.body.summary;
}
const f = path.join(OUT, 'products_import_report.json');
fs.writeFileSync(f, JSON.stringify(report, null, 1));
console.log('报告：' + f);
if (c.error) process.exitCode = 1;
