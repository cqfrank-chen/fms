#!/usr/bin/env node
/**
 * 报价批量导入（云端）—— 调用既有 /api/quotes/import/preview → /api/quotes/import/commit
 * =====================================================================================
 * 用途：把「报价单清单」整理成的报价 CSV（中文表头，与 /api/quotes/template 一致）批量导入 FMS。
 * 本脚本**不自己解析业务规则**：分类统计、客户/产品档案匹配、同键改价全部由服务端 preview/commit 完成，
 * 保证「界面导入」与「脚本导入」是同一套口径（唯一实现见 apps/api/src/quotes/quotes.service.ts）。
 *
 * CSV 表头（可下载模板 GET /api/quotes/template）：
 *   客户名称,产品名称,单价,币种,生效日期,失效日期,来源,备注
 *   · **来源**（可选）取值 manual / import / doc / contract（也接受中文「手工/导入/单据提取/合同成交价」）；
 *     contract = 合同成交价种子、doc = 单据（.doc 采购单）提取；**留空沿用既有口径 import**（向后兼容）；
 *   · 客户名称留空 = 通用价（不限客户）；填了但不在客户档案 → 该行报错（不臆造客户）；
 *   · 产品名称可不在产品目录（此时只按名称文本匹配，product_id 留空）；
 *   · 单价必填（元，最多 2 位小数）；币种 RMB / ￥ / 人民币 等一律由服务端归一到 CNY。
 *
 * 幂等策略（重要）：
 *   服务端幂等键 = 「客户（空=通用价） + 产品（档案 id，或产品名文本归一） + 生效日期」。
 *   · --mode upsert（默认）：同键已存在 → **改价**（更新单价/币种/备注，写 updated_at 留痕），不产生重复行；
 *   · --mode insert-only：同键已存在 → 跳过（只新增）。
 *   两种模式都不会重复插入；复跑本脚本是安全的（第二次预览应显示 改价 N / 跳过 N、新增 0）。
 *
 * 用法（FMS_BASE 指向云端；**先 dry-run 看分类统计，再 commit**）：
 *   $env:FMS_BASE = "https://<云端地址>/api"
 *   node tools/ziliao/import_quotes_cloud.mjs --in tools/ziliao/quote_seed_candidates.csv --dry-run
 *   node tools/ziliao/import_quotes_cloud.mjs --in tools/ziliao/quote_seed_candidates.csv            # upsert 正式导入
 *   node tools/ziliao/import_quotes_cloud.mjs --in xxx.csv --mode insert-only --dry-run
 *
 * 环境变量：FMS_BASE（默认 http://127.0.0.1:3100/api）、FMS_TOKEN（优先）、FMS_USER / FMS_PASS（默认 admin/Fms@2026）
 * 其它参数：--in <csv>（必填）、--mode upsert|insert-only（默认 upsert）、--dry-run、--out <报告目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argsOf = (k) => process.argv.reduce((a, v, i) => (v === k && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
const IN = argsOf('--in')[0];
const MODE = (argsOf('--mode')[0] ?? 'upsert') === 'insert-only' ? 'insert-only' : 'upsert';
const DRY = process.argv.includes('--dry-run');
const OUT = argsOf('--out')[0] ?? path.resolve(__dirname, '../../.scratch/quote-import');
const BASE = (process.env.FMS_BASE ?? 'http://127.0.0.1:3100/api').replace(/\/+$/, '');
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
const TOKEN = process.env.FMS_TOKEN ?? '';

if (!IN) {
  console.error('用法: node import_quotes_cloud.mjs --in <报价CSV> [--mode upsert|insert-only] [--dry-run] [--out 目录]');
  process.exit(2);
}
if (!fs.existsSync(IN)) {
  console.error('文件不存在：' + IN);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

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

async function req(method, pathname, body, token) {
  const r = await fetch(BASE + pathname, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  return { status: r.status, body: j };
}

const buf = fs.readFileSync(IN);
// 后端按 magic bytes/扩展名判型；UTF-8 BOM 由解析层处理，这里原样上传即可
const upload = { file: 'data:application/octet-stream;base64,' + buf.toString('base64'), fileName: path.basename(IN), mode: MODE };

const token = await login();
console.log('目标接口：' + BASE + (DRY ? '（--dry-run 只预览不写库）' : ''));
console.log('输入文件：' + IN + '（' + buf.length + ' 字节）　模式：' + MODE);

const pv = await req('POST', '/quotes/import/preview', upload, token);
if (pv.status >= 300) {
  console.error('预览失败（' + pv.status + '）：' + JSON.stringify(pv.body));
  process.exit(1);
}
const s = pv.body.summary;
console.log('--- 预览（服务端分类统计）---');
console.log('  文件类型：' + pv.body.fileKind + '　表头行：# ' + (pv.body.headerRowIndex + 1));
console.log('  识别到的列：' + JSON.stringify(pv.body.columns) + (pv.body.unmappedHeaders?.length ? '　未识别列：' + JSON.stringify(pv.body.unmappedHeaders) : ''));
console.log('  共 ' + s.total + ' 行：新增 ' + s.new + ' / ' + (MODE === 'upsert' ? '改价 ' : '跳过 ') + (MODE === 'upsert' ? s.update : s.skip) + ' / 跳过 ' + s.skip + ' / 错误 ' + s.error);
const srcStat = {};
for (const row of pv.body.rows) {
  const v = row.data?.source ?? '（未填→import）';
  srcStat[v] = (srcStat[v] ?? 0) + 1;
}
console.log('  来源分布：' + JSON.stringify(srcStat));
for (const row of pv.body.rows) {
  if (row.status === 'error') console.log('  [错误] 第 ' + row.rowNo + ' 行：' + row.reasons.join('；'));
}

const report = { base: BASE, input: IN, mode: MODE, dryRun: DRY, preview: pv.body };
if (DRY) {
  console.log('（--dry-run：到此为止，未写库）');
  const f = path.join(OUT, 'quote_import_preview.json');
  fs.writeFileSync(f, JSON.stringify(report, null, 1));
  console.log('报告：' + f);
  process.exit(0);
}

const cm = await req('POST', '/quotes/import/commit', upload, token);
if (cm.status >= 300) {
  console.error('导入失败（' + cm.status + '）：' + JSON.stringify(cm.body));
  process.exit(1);
}
const c = cm.body.summary;
console.log('--- 导入完成 ---');
console.log('  新增 ' + c.new + ' / 改价 ' + c.update + ' / 跳过 ' + c.skip + ' / 失败 ' + c.error);
if (cm.body.failures?.length) {
  for (const f of cm.body.failures) console.log('  [失败] 第 ' + f.rowNo + ' 行（' + f.label + '）：' + f.reason);
}
// 幂等复核：再预览一次，upsert 模式下同键应全部进「改价」、新增 0
const pv2 = await req('POST', '/quotes/import/preview', upload, token);
if (pv2.status < 300) {
  console.log('--- 幂等复核（同一文件再预览一次）---');
  console.log('  新增 ' + pv2.body.summary.new + ' / 改价 ' + pv2.body.summary.update + ' / 跳过 ' + pv2.body.summary.skip + ' / 错误 ' + pv2.body.summary.error);
  report.previewAfterCommit = pv2.body.summary;
}
report.commit = cm.body;
const f = path.join(OUT, 'quote_import_report.json');
fs.writeFileSync(f, JSON.stringify(report, null, 1));
console.log('报告：' + f);
if (c.error) process.exitCode = 1;
