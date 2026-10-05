#!/usr/bin/env node
/**
 * 「文件夹=客户」资料同步脚本 —— 客户清单 + 包装（唛头）模板清单 → 云端 FMS（**只调用既有 HTTP 接口**）
 * =====================================================================================================
 * 甲方裁定口径（脚本严格遵守）：
 *   1. 客户 = 顶层客户文件夹，客户名 = 文件夹名；**不做跨文件夹合并、不做别名归一**。
 *   2. 二级子文件夹不是客户 → 由 build_folder_lists.py 输出备查清单（本脚本不导入）。
 *   3. 本厂（供方）名称绝不进客户表 → 本脚本的客户来源只有 customer_folders.csv（文件夹名）。
 *   4. 结算方式/账期天数在资料里没有证据 → 导入时一律留空，不臆造。
 *
 * 输入（由 tools/ziliao/build_folder_lists.py 生成）：
 *   --customers  <csv>  customer_folders.csv（列：客户名称, …）
 *   --packs      <csv>  pack_template_candidates.csv（列：客户文件夹, 模板名, label内容, 字符数, 来源文件）
 *
 * 调用的既有接口：
 *   客户：  POST /api/auth/login → POST /api/master-data/import/preview → POST /api/master-data/import/commit
 *   唛头：  POST /api/auth/login → GET  /api/pack-templates（取已有，做幂等）→ POST /api/pack-templates
 *
 * 环境变量：
 *   FMS_BASE   默认 http://127.0.0.1/api （云端部署时替换为云端地址，如 https://fms.example.com/api）
 *   FMS_TOKEN  已有 JWT 时直接使用（优先；不填则用账号密码登录）
 *   FMS_USER / FMS_PASS   默认 admin / Fms@2026
 *
 * 用法：
 *   # 1) 只预览不写库（强烈建议先跑这个）
 *   node tools/ziliao/sync_folder_data.mjs --customers <customer_folders.csv> --packs <pack_template_candidates.csv> --dry-run
 *   # 2) 正式同步（先 preview，再 commit；客户部分会自动再 commit 一次验证幂等）
 *   node tools/ziliao/sync_folder_data.mjs --customers ... --packs ...
 *   # 3) 只同步其中一类
 *   node tools/ziliao/sync_folder_data.mjs --customers ... --skip-pack
 *   node tools/ziliao/sync_folder_data.mjs --packs ... --skip-customers
 *
 * 幂等说明：
 *   · 客户：master-data 导入自带「同名（去空格后）」去重 —— 复跑时 summary.new=0、全部落入 skip，
 *     库中不会出现重复客户；脚本会自动复跑一次并把两次的 summary 都打印出来作为证据。
 *   · 唛头：先 GET /pack-templates 取已有模板名，已存在的直接 skip（按「模板名」精确匹配，模板名含客户文件夹前缀，不会跨客户误判）；
 *     该接口没有服务端唯一约束，所以幂等由本脚本的「先查后插」保证 —— 复跑时 created=0、skipped=全部。
 *   · 两类操作都不会删除/覆盖任何既有数据；master-data 用 insert-only 模式。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(path.resolve(__dirname, '../../apps/api'), 'package.json'));
const ExcelJS = require('exceljs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CUSTOMERS_CSV = arg('--customers');
const PACKS_CSV = arg('--packs');
const OUT = arg('--out', path.resolve(__dirname, '../../.scratch/ziliao-sync'));
const DRY = process.argv.includes('--dry-run');
const SKIP_CUSTOMERS = process.argv.includes('--skip-customers');
const SKIP_PACK = process.argv.includes('--skip-pack');
const BASE = (arg('--base') ?? process.env.FMS_BASE ?? 'http://127.0.0.1/api').replace(/\/+$/, '');
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
const TOKEN = process.env.FMS_TOKEN ?? '';

if (!CUSTOMERS_CSV && !PACKS_CSV) {
  console.error('用法: node sync_folder_data.mjs --customers <customer_folders.csv> --packs <pack_template_candidates.csv> [--dry-run] [--skip-customers|--skip-pack]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

/** 极简 CSV 解析（引号包裹 + 双引号转义 + 字段内换行） */
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
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

async function login() {
  if (TOKEN) { console.log('鉴权：使用环境变量 FMS_TOKEN'); return TOKEN; }
  const r = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error('登录失败（' + r.status + '）：' + JSON.stringify(j));
  console.log('鉴权：' + BASE + '/auth/login 登录成功（账号 ' + USER + '）');
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

/** 分类统计打印：新增/更新/跳过/错误 */
function printSummary(tag, res) {
  const s = res.body && res.body.summary;
  console.log('  [' + tag + '] HTTP ' + res.status + (s
    ? '  共 ' + s.total + ' 行：新增 ' + s.new + ' / 更新 ' + s.update + ' / 跳过 ' + s.skip + ' / 错误 ' + s.error
    : '  ' + JSON.stringify(res.body).slice(0, 200)));
  const fails = (res.body && res.body.failures) || [];
  if (fails.length) {
    console.log('  失败行（前 5）：');
    for (const f of fails.slice(0, 5)) console.log('    - 第' + f.rowNo + '行 ' + (f.name ?? '') + '：' + f.reason);
  }
  return s || null;
}

const report = { base: BASE, dryRun: DRY, at: new Date().toISOString(), customers: null, packs: null };

// ============ ① 客户清单（顶层文件夹 = 客户） ============
async function syncCustomers(token) {
  const rows = parseCsv(fs.readFileSync(CUSTOMERS_CSV, 'utf8'));
  const H = rows[0];
  const iName = H.findIndex((h) => /客户名称|名称/.test(h));
  if (iName < 0) throw new Error('客户清单缺少「客户名称」列：' + JSON.stringify(H));
  const picks = rows.slice(1).map((r) => (r[iName] || '').trim()).filter(Boolean);
  console.log('\n【客户主数据】候选 ' + picks.length + ' 家（客户名 = 顶层文件夹名）：' + picks.join('、'));

  // 生成标准导入 xlsx（表头严格按 FMS 模板；结算方式/账期天数留空，不臆造）
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('客户导入');
  ws.addRow(['客户名称', '联系人', '结算方式', '账期天数']);
  for (const n of picks) ws.addRow([n, '', '', '']);
  const xlsxPath = path.join(OUT, 'customers_import.xlsx');
  fs.writeFileSync(xlsxPath, Buffer.from(await wb.xlsx.writeBuffer()));
  console.log('  导入文件：' + xlsxPath);

  const b64 = fs.readFileSync(xlsxPath).toString('base64');
  const payload = {
    target: 'customers', mode: 'insert-only',
    file: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + b64,
    fileName: 'customers_import.xlsx',
  };
  const out = { input: CUSTOMERS_CSV, names: picks, xlsx: xlsxPath, preview: null, commit1: null, commit2: null };
  const pv = await req('POST', '/master-data/import/preview', payload, token);
  out.preview = { status: pv.status, summary: pv.body && pv.body.summary, failures: pv.body && pv.body.failures, columns: pv.body && pv.body.columns };
  console.log('--- preview（不写库）---');
  printSummary('preview', pv);
  if (pv.status >= 300) throw new Error('preview 失败：' + JSON.stringify(pv.body).slice(0, 300));
  if (DRY) { console.log('  （--dry-run：到此为止，未写库）'); report.customers = out; return out; }

  const c1 = await req('POST', '/master-data/import/commit', payload, token);
  out.commit1 = { status: c1.status, summary: c1.body && c1.body.summary, created: c1.body && c1.body.created, failures: c1.body && c1.body.failures };
  console.log('--- commit #1（写库）---');
  printSummary('commit#1', c1);
  if (c1.status >= 300) throw new Error('commit 失败：' + JSON.stringify(c1.body).slice(0, 300));

  const c2 = await req('POST', '/master-data/import/commit', payload, token);
  out.commit2 = { status: c2.status, summary: c2.body && c2.body.summary };
  console.log('--- commit #2（幂等复跑：应全部 skip）---');
  printSummary('commit#2', c2);
  report.customers = out;
  return out;
}

// ============ ② 包装（唛头）模板 ============
async function syncPacks(token) {
  const rows = parseCsv(fs.readFileSync(PACKS_CSV, 'utf8'));
  const H = rows[0];
  const idx = (re) => H.findIndex((h) => re.test(h));
  const iName = idx(/模板名/), iContent = idx(/label内容/), iSrc = idx(/来源文件/), iChars = idx(/字符数/), iCust = idx(/客户文件夹/);
  const cands = rows.slice(1).map((r) => ({
    name: (r[iName] || '').trim(), label: (r[iContent] || '').trim(),
    src: (r[iSrc] || '').trim(), chars: (r[iChars] || '').trim(), customer: iCust >= 0 ? (r[iCust] || '').trim() : '',
  })).filter((x) => x.name && x.label);
  console.log('\n【包装（唛头）模板】候选 ' + cands.length + ' 条');

  const existingRes = await req('GET', '/pack-templates', undefined, token);
  if (existingRes.status >= 300) throw new Error('读取 /pack-templates 失败：' + JSON.stringify(existingRes.body).slice(0, 200));
  const existing = new Set((existingRes.body || []).map((p) => String(p.name)));
  console.log('  库中已有模板 ' + existing.size + ' 条（幂等判重依据：模板名）');

  // 防御性判重：候选内部同名（不同二级文件夹下的同名唛头文件）会让云端出现同名模板且无法按名幂等
  const seenInBatch = new Set();
  const dupInBatch = cands.filter((c) => (seenInBatch.has(c.name) ? true : (seenInBatch.add(c.name), false)));
  if (dupInBatch.length) {
    console.log('  ⚠️ 候选内部模板名重复 ' + dupInBatch.length + ' 条（将跳过重复项；建议先用 build_folder_lists.py 重新生成带后缀的唯一名）：'
      + dupInBatch.slice(0, 5).map((x) => x.name).join('、'));
  }

  const out = { input: PACKS_CSV, total: cands.length, existing: existing.size, dupInBatch: dupInBatch.length, created: [], skipped: [], failed: [] };
  const landed = new Set();
  for (const c of cands) {
    if (landed.has(c.name)) { out.skipped.push({ name: c.name, reason: '候选内部同名，已跳过重复项' }); continue; }
    landed.add(c.name);
    if (existing.has(c.name)) { out.skipped.push({ name: c.name, reason: '模板名已存在' }); continue; }
    const body = {
      name: c.name.slice(0, 80),
      pack: { label: c.label },
      note: '来源文件：' + c.src + '｜提取字符数：' + c.chars + '｜客户文件夹：' + c.customer + '｜由 tools/ziliao 从资料包唛头文档自动提取，待人工核对',
    };
    if (DRY) { out.skipped.push({ name: c.name, reason: 'dry-run 未写库' }); continue; }
    const r = await req('POST', '/pack-templates', body, token);
    if (r.status >= 200 && r.status < 300) out.created.push({ id: r.body && r.body.id, name: r.body && r.body.name });
    else out.failed.push({ name: c.name, status: r.status, err: r.body });
  }
  console.log('  created=' + out.created.length + '  skipped=' + out.skipped.length + '  failed=' + out.failed.length + (DRY ? '（--dry-run 未写库）' : ''));
  if (out.failed.length) console.log('  失败示例：' + JSON.stringify(out.failed.slice(0, 3)));
  report.packs = out;
  return out;
}

// ============ 主流程 ============
try {
  console.log('目标接口：' + BASE + (DRY ? '（--dry-run 只预览不写库）' : ''));
  const token = await login();
  if (CUSTOMERS_CSV && !SKIP_CUSTOMERS) await syncCustomers(token);
  if (PACKS_CSV && !SKIP_PACK) await syncPacks(token);
  report.ok = true;
} catch (e) {
  report.ok = false;
  report.error = String(e && e.message ? e.message : e);
  console.error('同步中断：' + report.error);
  process.exitCode = 1;
}
const file = path.join(OUT, (DRY ? 'sync_dryrun_report.json' : 'sync_report.json'));
fs.writeFileSync(file, JSON.stringify(report, null, 1));
console.log('\n报告：' + file);
