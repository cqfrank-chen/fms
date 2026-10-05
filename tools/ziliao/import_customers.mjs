#!/usr/bin/env node
/**
 * 客户主数据试点导入（走既有 /api/master-data/import/preview|commit，不新增业务逻辑）
 *
 * 用法：
 *   node tools/ziliao/import_customers.mjs --in <候选CSV> [--out <输出目录>] [--once]
 * 环境变量：
 *   FMS_BASE  默认 http://127.0.0.1:3100/api
 *   FMS_USER / FMS_PASS  默认 admin / Fms@2026
 *
 * 行为：候选 CSV → 生成标准 .xlsx（模板表头 客户名称/联系人/结算方式/账期天数）
 *      → preview（不写库）→ commit（写库）→ 再 commit 一次验证幂等去重 → 落盘 JSON 报告
 * 说明：结算方式/账期天数一律留空 —— 资料包中没有该字段的证据，不臆造。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(path.resolve(__dirname, '../../apps/api'), 'package.json'));
const ExcelJS = require('exceljs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.resolve(__dirname, '../../.scratch/ziliao-pilot'));
const BASE = process.env.FMS_BASE ?? 'http://127.0.0.1:3100/api';
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
if (!IN) { console.error('用法: node import_customers.mjs --in <候选CSV> [--out 目录]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

/** 极简 CSV 解析（支持引号包裹与双引号转义） */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

async function login() {
  const r = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const j = await r.json();
  if (!r.ok || !j.token) throw new Error('登录失败: ' + JSON.stringify(j));
  return j.token;
}

async function call(pathname, body, token) {
  const r = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  return { status: r.status, body: j };
}

const rows = parseCsv(fs.readFileSync(IN, 'utf8'));
const header = rows[0];
const nameIdx = header.findIndex((h) => /候选名称|客户名称|名称/.test(h));
const confIdx = header.findIndex((h) => /置信度/.test(h));
const picks = rows.slice(1).map((r) => ({ name: (r[nameIdx] || '').trim(), conf: confIdx >= 0 ? (r[confIdx] || '').trim() : '' }))
  .filter((x) => x.name);
console.log('候选行数: ' + picks.length);

// ---- 生成标准导入 xlsx（表头严格按 FMS 模板） ----
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('客户导入');
ws.addRow(['客户名称', '联系人', '结算方式', '账期天数']);
for (const p of picks) ws.addRow([p.name, '', '', '']);
const xlsxPath = path.join(OUT, 'customers_import.xlsx');
fs.writeFileSync(xlsxPath, Buffer.from(await wb.xlsx.writeBuffer()));
console.log('生成导入文件: ' + xlsxPath);

const token = await login();
const payload = { target: 'customers', mode: 'insert-only', file: fs.readFileSync(xlsxPath).toString('base64'), fileName: 'customers_import.xlsx' };

const report = { base: BASE, input: IN, rows: picks.length, file: xlsxPath, preview: null, commit1: null, commit2: null };
const pv = await call('/master-data/import/preview', { ...payload, file: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + payload.file }, token);
report.preview = pv;
console.log('--- preview (status ' + pv.status + ') ---');
console.log(JSON.stringify(pv.body, null, 1).slice(0, 2500));

const c1 = await call('/master-data/import/commit', { ...payload, file: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + payload.file }, token);
report.commit1 = c1;
console.log('--- commit #1 (status ' + c1.status + ') ---');
console.log(JSON.stringify(c1.body, null, 1).slice(0, 2000));

const c2 = await call('/master-data/import/commit', { ...payload, file: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + payload.file }, token);
report.commit2 = c2;
console.log('--- commit #2 幂等复跑 (status ' + c2.status + ') ---');
console.log(JSON.stringify(c2.body, null, 1).slice(0, 2000));

fs.writeFileSync(path.join(OUT, 'import_customers_report.json'), JSON.stringify(report, null, 1));
console.log('报告: ' + path.join(OUT, 'import_customers_report.json'));
