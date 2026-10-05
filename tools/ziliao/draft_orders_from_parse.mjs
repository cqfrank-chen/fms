#!/usr/bin/env node
/**
 * 批量「落草稿订单」（I17）—— 把识单结果（含 .doc 切片 CSV 管线结果）**批量**变成草稿订单
 * =====================================================================================
 * 与单个入径的关系：
 *   · 界面：AI 导入预览里的「存为草稿（缺项标待补）」= 单份（Excel/CSV/.doc 切片都一样）；
 *   · 本脚本：对一整个目录的切片 CSV 批量走「识别 → POST /orders/draft」，用于 .doc 计划单族（嵊州海田/正恒）批量落草稿。
 *
 * 关键口径（甲方裁定 + I17）：
 *   · 客户由**文件夹名**决定（folderCustomer = 路径第一段），不做别名合并；
 *   · 缺价/缺交期/缺数量/产品未建档/客户未建档**都不阻断落库**，由服务端逐项写成中文待补项；
 *   · 缺交期 → 服务端用哨兵日 2099-12-31 + due_date_tbd=true（界面显示「待定」），不改 NOT NULL 约束；
 *   · 缺价 → 服务端按「文件夹客户 + 产品」查**报价记录**自动补价并标 price_from='quote'（裁定④），
 *     未命中保持待补；所以先导入报价记录，落草稿时的缺价率会明显下降；
 *   · 待补项未清空前订单不能确认（服务端 confirmOrder 拦截），因此批量落草稿不会污染计划单/应收。
 *
 * 用法（FMS_BASE 指向目标环境；**先用 --dry-run 看统计**）：
 *   node tools/ziliao/draft_orders_from_parse.mjs --csvdir D:/futures/_work/doc_csv_sz --csvdir D:/futures/_work/doc_csv_zh --dry-run
 *   $env:FMS_BASE = "https://<云端地址>/api"
 *   node tools/ziliao/draft_orders_from_parse.mjs --csvdir <目录A> --csvdir <目录B> --out D:/futures/_work/doc_draft_all
 *   node tools/ziliao/draft_orders_from_parse.mjs --csvdir <目录> --limit 20     # 先小批试跑
 *
 * 环境变量：FMS_BASE（默认 http://127.0.0.1/api；也可用 --base 覆盖）、FMS_USER/FMS_PASS（默认 admin/Fms@2026）、FMS_TOKEN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argsOf = (k) => process.argv.reduce((a, v, i) => (v === k && process.argv[i + 1] ? [...a, process.argv[i + 1]] : a), []);
const CSV_DIRS = argsOf('--csvdir');
const OUT = argsOf('--out')[0] ?? path.resolve(__dirname, '../../.scratch/ziliao-draft');
const LIMIT = Number(argsOf('--limit')[0] ?? 0) || 0;
const DRY = process.argv.includes('--dry-run');
const BASE = (argsOf('--base')[0] ?? process.env.FMS_BASE ?? 'http://127.0.0.1/api').replace(/\/+$/, '');
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
const TOKEN = process.env.FMS_TOKEN ?? '';

if (!CSV_DIRS.length) {
  console.error('用法: node draft_orders_from_parse.mjs --csvdir <切片CSV目录> [--csvdir ...] [--limit N] [--dry-run] [--out 目录] [--base 地址]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

async function login() {
  if (TOKEN) return TOKEN;
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
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

/** 切片 CSV 文件名 = 原始相对路径把 "/" 换成 "__" → 顶层文件夹 = 第一段（文件夹=客户） */
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
console.log('目标接口：' + BASE + (DRY ? '（--dry-run 只识别/试算，不建单）' : ''));
console.log('切片 CSV：' + files.length + ' 份');
const token = await login();

const recs = [];
let nDraft = 0, nFail = 0, nPending = 0, nPendingItems = 0;
const pendingCount = {};
// dry-run 统计（识单层面）：客户是否已建档 / 报价补价行 / 仍缺价行 / 缺数量行 / 未建档产品行
const dry = { files: 0, customerFiled: 0, customerUnfiled: 0, lines: 0, quoteFilledLines: 0, priceMissingLines: 0, qtyMissingLines: 0, productUnfiledLines: 0, noProductLines: 0, dueDateMissing: 0 };
const byTop = {};

for (const it of files) {
  const b64 = fs.readFileSync(it.csv).toString('base64');
  const parsed = await req('POST', '/ai/orders/parse', {
    file: 'data:text/csv;base64,' + b64,
    fileName: path.basename(it.csv).replace(/\.csv$/i, '.csv'),
    folderCustomer: it.top,
  }, token);
  if (parsed.status >= 300) {
    nFail += 1;
    recs.push({ rel: it.rel, top: it.top, stage: 'parse', status: parsed.status, error: parsed.body });
    continue;
  }
  const p = parsed.body;
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const rec = {
    rel: it.rel, top: it.top, parseSource: p.parseSource, poNo: p.poNo ?? null, dueDate: p.dueDate ?? null,
    customerId: p.customerId ?? null, customerName: p.customerName ?? null,
    lineCount: lines.length, quoteFilled: p.quoteFilledCount ?? 0,
  };
  // ---- dry-run：按识单结果预估落草稿统计（最终以待补标记为准） ----
  dry.files += 1;
  if (p.customerId) dry.customerFiled += 1; else dry.customerUnfiled += 1;
  if (!p.dueDate) dry.dueDateMissing += 1;
  dry.lines += lines.length;
  dry.quoteFilledLines += p.quoteFilledCount ?? 0;
  for (const l of lines) {
    if (l.unitPrice === undefined || l.unitPrice === null) dry.priceMissingLines += 1;
    if (l.quantity === undefined || l.quantity === null || l.quantity <= 0) dry.qtyMissingLines += 1;
    if (l.productId === null || l.productId === undefined) dry.productUnfiledLines += 1;
  }
  if (!lines.length) dry.noProductLines += 1;
  byTop[it.top] = byTop[it.top] ?? { files: 0, lines: 0, quoteFilled: 0, priceMissing: 0 };
  byTop[it.top].files += 1;
  byTop[it.top].lines += lines.length;
  byTop[it.top].quoteFilled += p.quoteFilledCount ?? 0;
  byTop[it.top].priceMissing += lines.filter((l) => l.unitPrice === undefined || l.unitPrice === null).length;

  if (DRY) {
    rec.stage = 'dry-run';
    recs.push(rec);
    continue;
  }
  // 落草稿：数量/单价可空（服务端按报价补价 + 标待补）；客户优先用识别到的档案 id，否则用文件夹名（未建档时挂占位档案）
  const draft = await req('POST', '/orders/draft', {
    customerId: p.customerId ?? null,
    customerName: p.customerId ? null : (p.customerName ?? it.top),
    folderCustomer: it.top,
    poNo: p.poNo ?? null,
    dueDate: p.dueDate ?? null,
    note: '由 tools/ziliao/draft_orders_from_parse.mjs 批量落草稿（来源：' + it.rel + '）',
    lines: lines.map((l) => ({
      productId: l.productId ?? null,
      productName: l.productId ? null : (l.productName ?? null),
      quantity: l.quantity ?? null,
      unitPrice: l.unitPrice ?? null,
      currency: l.currency,
      engraving: l.engraving || undefined,
      packaging: l.packaging && Object.keys(l.packaging).length ? l.packaging : undefined,
      priceFrom: l.priceFrom === 'quote' ? 'quote' : null,
      quoteId: l.quoteId ?? null,
    })),
  }, token);
  if (draft.status >= 300) {
    nFail += 1;
    rec.stage = 'draft';
    rec.status = draft.status;
    rec.error = draft.body;
    recs.push(rec);
    continue;
  }
  const items = Array.isArray(draft.body.pendingItems) ? draft.body.pendingItems : [];
  nDraft += 1;
  if (items.length) nPending += 1;
  nPendingItems += items.length;
  for (const x of items) pendingCount[x.code] = (pendingCount[x.code] ?? 0) + 1;
  rec.stage = 'draft';
  rec.orderId = draft.body.id;
  rec.orderNo = draft.body.orderNo;
  rec.dueDateTbd = draft.body.dueDateTbd;
  rec.pendingCodes = items.map((x) => x.code);
  recs.push(rec);
}

const summary = {
  base: BASE, dryRun: DRY, files: files.length, drafts: nDraft, failed: nFail,
  draftsWithPending: nPending, pendingItemsTotal: nPendingItems, pendingByCode: pendingCount,
  dryRunStats: DRY ? dry : undefined, byCustomerFolder: byTop,
};
console.log('');
console.log('================ 批量落草稿汇总 ================');
console.log('文件 ' + files.length + '　' + (DRY ? '（dry-run 未建单）' : '落草稿成功 ' + nDraft) + '　失败 ' + nFail);
if (DRY) {
  console.log('--- 识单层面预估（最终待补标记以服务端为准）---');
  console.log('客户已建档 ' + dry.customerFiled + ' 份 / 未建档 ' + dry.customerUnfiled + ' 份（客户按文件夹名匹配客户档案）');
  console.log('产品行合计 ' + dry.lines + '　其中：报价补价 ' + dry.quoteFilledLines + ' 行 / 仍缺价 ' + dry.priceMissingLines + ' 行 / 缺数量 ' + dry.qtyMissingLines + ' 行 / 产品未建档 ' + dry.productUnfiledLines + ' 行');
  console.log('缺交期 ' + dry.dueDateMissing + ' 份　无产品行 ' + dry.noProductLines + ' 份');
  console.log('按文件夹客户：');
  for (const [k, v] of Object.entries(byTop)) {
    console.log('  ' + k + '：文件 ' + v.files + '　行 ' + v.lines + '　已按报价补价 ' + v.quoteFilled + '　仍缺价 ' + v.priceMissing);
  }
  console.log('提示：先跑 tools/ziliao/import_quotes_cloud.mjs 导入报价记录，再正式落草稿，「仍缺价」行数会随报价覆盖度下降。');
} else {
  console.log('其中带待补项 ' + nPending + ' 份（待补项合计 ' + nPendingItems + ' 条）');
  console.log('待补项分布: ' + JSON.stringify(pendingCount));
  console.log('提示：到 FMS「订单 → 订单列表」勾选「仅看有未补全项的草稿单」即可逐项补全（补价可一键从报价记录取价；');
  console.log('      「显示占位档案」开关可排查挂在占位客户/产品下的单据）');
}
const file = path.join(OUT, DRY ? 'draft_dryrun_report.json' : 'draft_report.json');
fs.writeFileSync(file, JSON.stringify({ summary, records: recs }, null, 1));
console.log('报告：' + file);
if (nFail) process.exitCode = 1;
