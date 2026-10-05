#!/usr/bin/env node
/**
 * AI 识单抽样验证：把选定的采购单/合同文件送 POST /api/ai/orders/parse，落盘识别结果 + 表格诊断。
 *
 * 用法：node tools/ziliao/ai_parse_batch.mjs --files <files.json> [--out 目录]
 *   files.json = [{"rel":"ziliao/...xlsx","expect":{...可选的人工核对基准...}}, ...]
 * 环境变量：FMS_BASE / FMS_USER / FMS_PASS；ROOT 资料包根目录（默认 D:\futures\ziliao-data）
 *
 * 注意：本脚本只读不写 —— 不建订单，只报告识别准确率与问题（符合「抽样验证、不全量跑」要求）。
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FILES = arg('--files');
const OUT = arg('--out', path.resolve(__dirname, '../../.scratch/ziliao-pilot'));
const ROOT = process.env.ROOT ?? 'D:/futures/ziliao-data';
const BASE = process.env.FMS_BASE ?? 'http://127.0.0.1:3100/api';
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
if (!FILES) { console.error('用法: node ai_parse_batch.mjs --files <files.json>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv' };

async function login() {
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const j = await r.json();
  if (!r.ok || !j.token) throw new Error('登录失败: ' + JSON.stringify(j));
  return j.token;
}

const list = JSON.parse(fs.readFileSync(FILES, 'utf8'));
const token = await login();
const results = [];
for (const item of list) {
  const abs = path.join(ROOT, item.rel.split('/').join(path.sep));
  const ext = path.extname(abs).toLowerCase();
  const b64 = fs.readFileSync(abs).toString('base64');
  const t0 = Date.now();
  const r = await fetch(BASE + '/ai/orders/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ file: 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + b64, fileName: path.basename(abs) }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  const rec = { rel: item.rel, status: r.status, ms: Date.now() - t0, expect: item.expect ?? null, result: j };
  results.push(rec);
  console.log('\n===== ' + item.rel + '  (HTTP ' + r.status + ', ' + rec.ms + 'ms)');
  console.log(JSON.stringify(j, null, 1).slice(0, 2600));
}
fs.writeFileSync(path.join(OUT, 'ai_parse_report.json'), JSON.stringify(results, null, 1));
console.log('\n报告: ' + path.join(OUT, 'ai_parse_report.json'));
