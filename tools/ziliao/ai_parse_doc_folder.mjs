#!/usr/bin/env node
/**
 * .doc（Word97）订单资料 → 同一条识单管线（③）
 * =====================================================================================
 * 背景：嵊州海田 / 正恒公司两家**没有 Excel 合同**（正恒 xls/xlsx = 0；嵊州海田 Excel 只有 1 份且非合同），
 *       订单资料全是 .doc 计划单/采购单。本脚本**不新起识别逻辑**：
 *         ① tools/ziliao/doc_table.py 把 Word 表格切成矩阵（并补一行「抬头」：需方/合同号/交货时间）
 *         ② 矩阵以 CSV 形式上传既有 POST /api/ai/orders/parse，带 folderCustomer=<顶层客户文件夹>
 *         ③ 于是复用与 Excel 完全相同的「表头规则映射 + 抬头区扫描 + 数据行终止 + 文件夹=客户」管线
 *
 * 用法：
 *   node tools/ziliao/ai_parse_doc_folder.mjs --csvdir <切片CSV目录> [--csvdir ...] [--out 目录] [--limit N]
 * 环境变量：FMS_BASE（默认 http://127.0.0.1:3100/api）、FMS_USER / FMS_PASS
 *
 * 输出：
 *   doc_parse_report.json   逐份结果（识别行/客户/合同号/交期/诊断）
 *   控制台：总体统计（文件数、产品行、文件夹客户命中、合同号/交期命中、缺失列分布）
 *
 * ⚠️ 口径说明（不臆造）：
 *   · 计划单族**没有单价列** → 识别结果必然缺 unitPrice（管线会如实报缺失列），需人工补价；
 *   · 采购单族有「不含税价」列 → 能出完整产品行（型号/数量/单价）；
 *   · 计划单抬头只有「9/20」这种**无年份**的交期，管线按当前年份归一 → 必须人工确认年份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argsOf = (k) => process.argv.reduce((acc, v, i) => (v === k && process.argv[i + 1] ? acc.concat(process.argv[i + 1]) : acc), []);
const CSV_DIRS = argsOf('--csvdir');
const OUT = (process.argv[process.argv.indexOf('--out') + 1] && process.argv.includes('--out')) ? process.argv[process.argv.indexOf('--out') + 1] : path.resolve(__dirname, '../../.scratch/ziliao-doc');
const LIMIT = Number(process.argv.includes('--limit') ? process.argv[process.argv.indexOf('--limit') + 1] : 0) || 0;
const BASE = process.env.FMS_BASE ?? 'http://127.0.0.1:3100/api';
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
if (!CSV_DIRS.length) { console.error('用法: node ai_parse_doc_folder.mjs --csvdir <目录> [--csvdir ...] [--limit N]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

async function login() {
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error('登录失败: ' + JSON.stringify(j));
  return j.token;
}

/** 切片 CSV 文件名 = 原始相对路径把 "/" 换成 "__"，末段保留原名 → 顶层文件夹 = 第一段 */
function collect() {
  const out = [];
  for (const d of CSV_DIRS) {
    for (const f of fs.readdirSync(d)) {
      if (!f.toLowerCase().endsWith('.csv')) continue;
      const rel = f.slice(0, -4).replace(/__/g, '/');
      out.push({ rel, top: rel.split('/')[0], csv: path.join(d, f) });
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return LIMIT ? out.slice(0, LIMIT) : out;
}

const files = collect();
console.log('切片 CSV：' + files.length + ' 份 → ' + BASE);
const token = await login();
const recs = [];
let nOk = 0, nErr = 0, nLines = 0, nPriced = 0, nCustOk = 0, nPo = 0, nDue = 0, nNoRows = 0;
const missingCount = {};
const stopCount = {};
for (const it of files) {
  const b64 = fs.readFileSync(it.csv).toString('base64');
  const r = await fetch(BASE + '/ai/orders/parse', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ file: 'data:text/csv;base64,' + b64, fileName: path.basename(it.csv).replace(/\.csv$/i, '.csv'), folderCustomer: it.top }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  const lines = Array.isArray(j.lines) ? j.lines : [];
  const priced = lines.filter((l) => l.quantity != null && l.unitPrice != null);
  const custOk = j.customerName === it.top;
  if (r.status >= 300) nErr += 1; else nOk += 1;
  nLines += lines.length; nPriced += priced.length;
  if (custOk) nCustOk += 1;
  if (j.poNo) nPo += 1;
  if (j.dueDate) nDue += 1;
  if (!lines.length) nNoRows += 1;
  for (const m of (j.table && j.table.missingRequired) || []) missingCount[m] = (missingCount[m] ?? 0) + 1;
  const stop = j.table && j.table.stopReason;
  if (stop) stopCount[stop] = (stopCount[stop] ?? 0) + 1;
  recs.push({
    rel: it.rel, top: it.top, status: r.status, parseSource: j.parseSource, customerName: j.customerName, customerFromFolder: custOk,
    poNo: j.poNo, dueDate: j.dueDate, lines: lines.length, pricedLines: priced.length,
    sample: lines.slice(0, 3).map((l) => [l.productName, l.quantity, l.unitPrice]),
    requiredHits: j.table && j.table.requiredHits, requiredTotal: j.table && j.table.requiredTotal,
    missingRequired: j.table && j.table.missingRequired, stopReason: stop, headerArea: j.table && j.table.headerArea,
  });
}
const sum = {
  files: files.length, ok: nOk, err: nErr, noProductRows: nNoRows,
  lines: nLines, pricedLines: nPriced,
  customerFromFolder: nCustOk, poNoHit: nPo, dueDateHit: nDue,
  missingRequired: missingCount, stopReason: stopCount,
};
console.log('\n================ .doc 识单汇总 ================');
console.log('文件 ' + sum.files + '（成功 ' + sum.ok + ' / 失败 ' + sum.err + ' / 无产品行 ' + sum.noProductRows + '）');
console.log('产品行合计 ' + sum.lines + '（其中数量+单价齐全 ' + sum.pricedLines + '）');
console.log('客户=文件夹命中 ' + sum.customerFromFolder + '/' + sum.files
  + '　合同号命中 ' + sum.poNoHit + '/' + sum.files + '　交期命中 ' + sum.dueDateHit + '/' + sum.files);
console.log('缺失列分布: ' + JSON.stringify(sum.missingRequired));
console.log('数据行终止原因分布: ' + JSON.stringify(sum.stopReason));
console.log('\n前 12 份明细：');
for (const r of recs.slice(0, 12)) {
  console.log('  ' + r.rel);
  console.log('    行=' + r.lines + '(有值 ' + r.pricedLines + ')  客户=' + JSON.stringify(r.customerName) + (r.customerFromFolder ? ' ✅' : ' ❌')
    + '  合同号=' + JSON.stringify(r.poNo) + '  交期=' + JSON.stringify(r.dueDate)
    + '  命中=' + r.requiredHits + '/' + r.requiredTotal + '  缺=' + JSON.stringify(r.missingRequired) + '  终止=' + JSON.stringify(r.stopReason));
  if (r.sample.length) console.log('    样例行: ' + JSON.stringify(r.sample));
}
const file = path.join(OUT, 'doc_parse_report.json');
fs.writeFileSync(file, JSON.stringify({ base: BASE, summary: sum, records: recs }, null, 1));
console.log('\n报告：' + file);
