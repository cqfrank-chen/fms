#!/usr/bin/env node
/**
 * 批量「落草稿订单」· Excel 合同通道（安宝公司 / 尤耐克）
 * =====================================================================================
 * 为什么需要这个脚本：
 *   上一轮的批量落草稿脚本 tools/ziliao/draft_orders_from_parse.mjs 只吃「.doc 切片 CSV」，
 *   于是**只有嵊州海田(214) + 正恒公司(63) = 277 份** Word 单据进了订单列表；
 *   安宝公司(316) / 尤耐克(254) 的 Excel 合同此前**只被抽过产品与成交价，从未落草稿**，
 *   所以这两家在订单列表里一份草稿都没有。本脚本补齐这条通道。
 *
 * 口径（与既有管线完全一致，不新起识别逻辑）：
 *   · 遍历 --dir 下的 .xls/.xlsx → POST /ai/orders/parse（**带 folderCustomer = 顶层客户文件夹名**）；
 *   · 识别结果 → POST /orders/draft 落**草稿**订单；
 *   · 缺价/缺交期/缺数量/产品未建档/客户未建档都不阻断落库，由服务端逐项写中文「待补」；
 *   · 合同自带单价与交期，因此预期「待补」明显少于 .doc 计划单族（那批表内根本没有价格列）。
 *
 * 与 .doc 脚本的差异（就是为了修掉「缓冲到最后才输出、看起来像卡住」）：
 *   · **逐份打印进度**（--progress N 可改成每 N 份一行），并且每行**同步落日志文件**，随时可 tail；
 *   · 记录 jsonl 断点：--resume 可跳过已落库的文件，中断后不用从头再来；
 *   · 落草稿前先做一次**本地非合同预判**（复用 tools/ziliao/lib/ziliao-extract.mjs 的「带单价列合同」口径，
 *     与产品/报价抽取同一口径）：非合同文件（唛头/设计稿/条码等）默认不落草稿，但**逐份列清单**，
 *     不做静默大批量跳过；确需落库用 --include-noncontract。
 *
 * 用法（**先 --dry-run 看统计**）：
 *   node tools/ziliao/draft_orders_from_excel.mjs --dir D:/futures/ziliao-data/ziliao/安宝公司 --dry-run
 *   $env:FMS_BASE = "https://<云端地址>/api"
 *   node tools/ziliao/draft_orders_from_excel.mjs --dir <安宝公司> --dir <尤耐克>
 *   node tools/ziliao/draft_orders_from_excel.mjs --dir <安宝公司> --limit 20      # 先小批试跑
 *   node tools/ziliao/draft_orders_from_excel.mjs --dir <安宝公司> --resume        # 中断续跑
 *
 * 环境变量：FMS_BASE（默认 http://127.0.0.1:3100/api；也可用 --base 覆盖）、FMS_USER/FMS_PASS（默认 admin/Fms@2026）、FMS_TOKEN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractContractFile, XLSX } from './lib/ziliao-extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argsOf = (k) => argv.reduce((a, v, i) => (v === k && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const arg1 = (k, d) => argsOf(k)[0] ?? d;

const DIRS = argsOf('--dir');
const OUT = path.resolve(arg1('--out', path.resolve(__dirname, '../../.scratch/ziliao-excel-draft')));
const LIMIT = Number(arg1('--limit', 0)) || 0;
const DRY = argv.includes('--dry-run');
const RESUME = argv.includes('--resume');
const INCLUDE_NONCONTRACT = argv.includes('--include-noncontract');
const PROGRESS_EVERY = Math.max(1, Number(arg1('--progress', 1)) || 1);
const TIMEOUT_MS = Math.max(1000, Number(arg1('--timeout', 120000)) || 120000);
const RETRIES = Math.max(0, Number(arg1('--retries', 2)) || 0);
const BASE = String(arg1('--base', process.env.FMS_BASE ?? 'http://127.0.0.1:3100/api')).replace(/\/+$/, '');
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
const TOKEN = process.env.FMS_TOKEN ?? '';
/**
 * 大文件本地瘦身阈值（MB）：超过就先把**第一个非空工作表**转成 CSV 再上传。
 * 原因：/ai/orders/parse 的上传通道有两道硬限制 —— decodeUpload 的 8MB 护栏（超了 HTTP 400「文件超过 8MB」）
 * 与 main.ts 的 12mb JSON 上限（base64 还会把体积再放大 1/3，超了 HTTP 413）。
 * 实测安宝 16 份合同（8~27.8MB，内嵌产品图片）必被挡掉；转 CSV 后矩阵与 Excel 通道逐格一致（同一套
 * sheetCellToString 口径：日期 → YYYY-MM-DD、数字 → 原样、其余 trim），识别结果不变。
 */
const CSV_FALLBACK_MB = Math.max(0, Number(arg1('--csv-fallback-mb', 6)));

if (!DIRS.length) {
  console.error('用法: node draft_orders_from_excel.mjs --dir <顶层客户文件夹> [--dir ...] [--limit N] [--dry-run]');
  console.error('      [--out 目录] [--base 地址] [--progress N] [--resume] [--include-noncontract] [--timeout ms] [--retries N]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const LOG_FILE = path.join(OUT, DRY ? 'excel_draft_dryrun.log' : 'excel_draft.log');
const JSONL_FILE = path.join(OUT, DRY ? 'excel_draft_dryrun_records.jsonl' : 'excel_draft_records.jsonl');
const REPORT_FILE = path.join(OUT, DRY ? 'excel_draft_dryrun_report.json' : 'excel_draft_report.json');

/** 进度/日志双写：stdout 立即可见（不再缓冲到最后），日志文件同步刷盘（可随时 tail） */
function say(line) {
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* 日志写失败不影响主流程 */ }
}

/** 顶层客户文件夹判定：--dir 指向的目录名即客户名（甲方裁定「文件夹=客户」）。
 *  便利处理：若 --dir 指向的是资料包容器目录（ziliao/ziliao-data/_work），则把它的每个一级子目录
 *  各当成一个客户根目录展开，避免把客户名取成「ziliao」。 */
const CONTAINER_NAMES = new Set(['ziliao', 'ziliao-data', '_work', '资料包']);
function resolveRoots(dirs) {
  const out = [];
  for (const d of dirs) {
    const abs = path.resolve(d);
    if (!fs.existsSync(abs)) { console.error('目录不存在：' + abs); process.exit(2); }
    const name = path.basename(abs);
    if (CONTAINER_NAMES.has(name)) {
      const subs = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
      if (subs.length) {
        say('提示：--dir 指向容器目录「' + abs + '」→ 按一级子目录展开为 ' + subs.length + ' 个客户根目录：' + subs.map((e) => e.name).join('、'));
        for (const e of subs) out.push({ dir: path.join(abs, e.name), folder: e.name });
        continue;
      }
    }
    out.push({ dir: abs, folder: name });
  }
  return out;
}

function walkExcel(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkExcel(p, acc);
    else if (/\.(xls|xlsx)$/i.test(e.name) && !e.name.startsWith('~$')) acc.push(p);
  }
  return acc;
}

/** 无正文的请求：带超时 + 重试（云网络抖动不该毁掉整批） */
async function req(method, pathname, body, token) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(BASE + pathname, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      const text = await r.text();
      let j; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
      return { status: r.status, body: j };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function login() {
  if (TOKEN) return TOKEN;
  const r = await req('POST', '/auth/login', { username: USER, password: PASS });
  const j = r.body ?? {};
  if (r.status >= 300 || !j.token) throw new Error('登录失败（' + r.status + '）：' + JSON.stringify(j));
  return j.token;
}

const MIME = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

/** 本地非合同预判：工作表里存不存在「产品名列 + 单价列」——与抽取产品/报价的脚本同一口径 */
function looksLikeContract(abs) {
  try {
    const r = extractContractFile(abs, path.basename(abs), '');
    return { contract: r.sheets.length > 0, pricedSheets: r.sheets.length };
  } catch (e) {
    return { contract: false, pricedSheets: 0, readError: String(e && e.message ? e.message : e) };
  }
}

/**
 * 单价归一：Excel 公式结果常带浮点表示误差（实测 8.399999999999999 / 15.400000000000002），
 * 而 POST /orders/draft 的 DTO 是「单价最多 2 位小数」、库里 unit_price 也是 numeric(10,2) ——
 * 不归一会整份单据被判 400 拒收（实测 14 份）。这里四舍五入到分，并把真的被改动的行记进报告备查。
 */
const round2 = (n) => (n === null || n === undefined ? n : Math.round(Number(n) * 100) / 100);
/** 是否带超出「分」的尾差（只在报告里留痕，不做任何臆造换算） */
const hasSubCent = (n) => n !== null && n !== undefined && Math.abs(Number(n) * 100 - Math.round(Number(n) * 100)) > 1e-6;

/** 工作表是否有内容（与服务端 readXlsMatrix 的 sheetHasData 同口径：有 !ref 即有内容） */
function sheetHasData(ws) {
  const ref = ws && ws['!ref'];
  return typeof ref === 'string' && ref.length > 0;
}

/**
 * 大文件瘦身：第一个非空工作表 → CSV（**与服务端 sheetCellToString 完全同一套单元格口径**：
 * Date → YYYY-MM-DD（UTC）、number → 原样字符串、其余 trim；空值留空）。
 * 带 UTF-8 BOM，服务端解码时走 utf-8(bom) 分支，不受系统编码影响。
 */
function toCsvFirstSheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, cellNF: false, cellText: false });
  const name = (wb.SheetNames ?? []).find((n) => sheetHasData(wb.Sheets[n]));
  if (!name) throw new Error('Excel 所有工作表都是空的');
  const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
      const p2 = (n) => String(n).padStart(2, '0');
      return v.getUTCFullYear() + '-' + p2(v.getUTCMonth() + 1) + '-' + p2(v.getUTCDate());
    }
    return String(v).trim();
  };
  const esc = (s) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const text = matrix.map((row) => (row ?? []).map((c) => esc(cell(c))).join(',')).join('\r\n');
  return { sheet: name, csv: '\ufeff' + text, rows: matrix.length };
}

// ============ 收集文件清单 ============
const roots = resolveRoots(DIRS);
const files = [];
for (const rt of roots) {
  for (const abs of walkExcel(rt.dir)) {
    const rel = path.relative(rt.dir, abs).split(path.sep).join('/');
    files.push({ abs, rel, folder: rt.folder, key: rt.folder + '/' + rel });
  }
}
files.sort((a, b) => a.key.localeCompare(b.key));
const targets = LIMIT ? files.slice(0, LIMIT) : files;

say('============================================================');
say('Excel 合同批量落草稿' + (DRY ? '（--dry-run：只识单+试算，不建单）' : '（正式：识别→落草稿）'));
say('目标接口：' + BASE);
say('客户根目录 ' + roots.length + ' 个：' + roots.map((r) => r.folder + '(' + r.dir + ')').join('、'));
say('Excel 文件 ' + files.length + ' 份' + (LIMIT ? ' → 本次处理前 ' + targets.length + ' 份（--limit ' + LIMIT + '）' : ''));
say('输出目录：' + OUT);
say('进度：' + (PROGRESS_EVERY === 1 ? '逐份打印' : '每 ' + PROGRESS_EVERY + ' 份打印一行'));
say('============================================================');

// 断点续跑：读回已完成的 jsonl
const done = new Set();
if (RESUME && fs.existsSync(JSONL_FILE)) {
  for (const line of fs.readFileSync(JSONL_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.stage === 'draft' || r.stage === 'dry-run') done.add(r.key); } catch { /* 忽略坏行 */ }
  }
  say('--resume：已完成 ' + done.size + ' 份，本次跳过');
}

const token = await login();

// ============ 统计容器 ============
const byFolder = {};
function folderStat(f) {
  byFolder[f] = byFolder[f] ?? {
    files: 0, contracts: 0, nonContract: 0, parseOk: 0, parseFail: 0, drafts: 0, skipped: 0,
    lines: 0, linesWithPrice: 0, linesWithQty: 0, productNotFiledLines: 0, quoteFilledLines: 0, priceRoundedLines: 0,
    poNoHit: 0, dueDateHit: 0, draftsWithPending: 0, pendingItems: 0,
  };
  return byFolder[f];
}
const pendingByCode = {};   // 单头（order 级）
const linePendingByCode = {}; // 行级
const skipped = { noncontract: [], contractNoLines: [], parseFail: [], draftFail: [], emptyProduct: [] };
let nParseOk = 0, nParseFail = 0, nDraft = 0, nDraftFail = 0, nSkip = 0, nContract = 0, nNonContract = 0;
/** 合同口径拆开计数：a) 表头带单价列（570）　b) 文件名含「合同」且识别到合同号（补充 6） */
let nContractByPrice = 0, nContractByName = 0;
/** 带「分」以下尾差的单价行数（Excel 浮点误差，落库前四舍五入到分） */
let nPriceRounded = 0;
let nLines = 0, nQuoteFilled = 0, nPendingItems = 0, nDraftsWithPending = 0;
const records = [];
const startedAt = Date.now();

let i = 0;
for (const it of targets) {
  i += 1;
  const st = folderStat(it.folder);
  st.files += 1;
  if (done.has(it.key)) {
    records.push({ key: it.key, rel: it.rel, folder: it.folder, stage: 'skip-resume' });
    if (PROGRESS_EVERY === 1) say('[' + String(i).padStart(4) + '/' + targets.length + '] ' + it.key + '  已落库，跳过（--resume）');
    continue;
  }
  const local = looksLikeContract(it.abs);
  const rec = {
    key: it.key, rel: it.rel, folder: it.folder, file: path.basename(it.abs),
    contractByPriceColumn: local.contract, pricedSheets: local.pricedSheets,
  };
  const t0 = Date.now();
  const buf = fs.readFileSync(it.abs);
  const sizeMb = buf.length / 1024 / 1024;

  // ---- ① 识单（大文件先本地转 CSV，绕开 8MB 上传护栏 / 12mb JSON 上限） ----
  let parsed;
  try {
    let uploadB64 = buf.toString('base64');
    let uploadName = path.basename(it.abs);
    let uploadMime = MIME[path.extname(it.abs).toLowerCase()] ?? 'application/octet-stream';
    let via = 'excel';
    if (CSV_FALLBACK_MB > 0 && sizeMb > CSV_FALLBACK_MB) {
      const slim = toCsvFirstSheet(buf);
      uploadB64 = Buffer.from(slim.csv, 'utf8').toString('base64');
      uploadName = path.basename(it.abs).replace(/\.(xls|xlsx)$/i, '') + '.csv';
      uploadMime = 'text/csv';
      via = 'csv-fallback(原表 ' + sizeMb.toFixed(1) + 'MB → 表「' + slim.sheet + '」' + slim.rows + ' 行)';
    }
    Object.assign(rec, { sizeMb: Number(sizeMb.toFixed(2)), via });
    parsed = await req('POST', '/ai/orders/parse', {
      file: 'data:' + uploadMime + ';base64,' + uploadB64,
      fileName: uploadName,
      folderCustomer: it.folder,
    }, token);
  } catch (e) {
    nParseFail += 1; st.parseFail += 1;
    rec.stage = 'parse-error'; rec.error = String(e && e.message ? e.message : e);
    skipped.parseFail.push(it.key + '：' + rec.error);
    records.push(rec);
    say('[' + String(i).padStart(4) + '/' + targets.length + '] ' + it.key + '  ❌ 识单异常：' + rec.error);
    fs.appendFileSync(JSONL_FILE, JSON.stringify(rec) + '\n');
    continue;
  }
  if (parsed.status >= 300) {
    nParseFail += 1; st.parseFail += 1;
    rec.stage = 'parse'; rec.status = parsed.status; rec.error = parsed.body;
    skipped.parseFail.push(it.key + '：【HTTP ' + parsed.status + '】' + JSON.stringify(parsed.body).slice(0, 200));
    records.push(rec);
    say('[' + String(i).padStart(4) + '/' + targets.length + '] ' + it.key + '  ❌ 识单失败 HTTP ' + parsed.status + '：' + JSON.stringify(parsed.body).slice(0, 160));
    fs.appendFileSync(JSONL_FILE, JSON.stringify(rec) + '\n');
    continue;
  }
  const p = parsed.body ?? {};
  const lines = Array.isArray(p.lines) ? p.lines : [];
  nParseOk += 1; st.parseOk += 1;
  nLines += lines.length; st.lines += lines.length;
  const withPrice = lines.filter((l) => l.unitPrice !== null && l.unitPrice !== undefined).length;
  const withQty = lines.filter((l) => l.quantity !== null && l.quantity !== undefined && l.quantity > 0).length;
  const productUnfiled = lines.filter((l) => l.productId === null || l.productId === undefined).length;
  // 带「分」以下尾差的单价行（Excel 浮点误差）：落库前四舍五入，原值列表留在报告里
  const subCent = lines.filter((l) => hasSubCent(l.unitPrice)).map((l) => [l.productName, l.unitPrice, round2(l.unitPrice)]);
  if (subCent.length) { st.priceRoundedLines += subCent.length; nPriceRounded += subCent.length; }
  st.linesWithPrice += withPrice; st.linesWithQty += withQty; st.productNotFiledLines += productUnfiled;
  st.quoteFilledLines += p.quoteFilledCount ?? 0;
  nQuoteFilled += p.quoteFilledCount ?? 0;
  if (p.poNo) st.poNoHit += 1;
  if (p.dueDate) st.dueDateHit += 1;
  Object.assign(rec, {
    parseSource: p.parseSource, poNo: p.poNo ?? null, dueDate: p.dueDate ?? null,
    customerId: p.customerId ?? null, customerName: p.customerName ?? null,
    lineCount: lines.length, linesWithPrice: withPrice, linesWithQty: withQty,
    productUnfiledLines: productUnfiled, quoteFilled: p.quoteFilledCount ?? 0,
    priceRoundedLines: subCent.length, priceRoundedSamples: subCent.slice(0, 5),
    tableStopReason: p.table ? p.table.stopReason : null,
    tableWarnings: p.table && Array.isArray(p.table.warnings) ? p.table.warnings : [],
  });

  // ---- ② 合同判定 + 落草稿前的取舍（逐份留痕，不静默跳过） ----
  // 两条独立证据，任一成立即视为「合同」（都要落草稿）：
  //   a) 表头族「带单价列合同」（与产品/报价抽取同一口径：安宝 316 + 尤耐克 254 = 570 份）；
  //   b) 文件名含「合同」且抬头区/表内识别到**合同号** —— 覆盖「含税」表头族（安宝实测 6 份：单价列写作
  //      「含税 / 总金额」，关键词表认不出单价列，但合同号/需方/交期都在）。这些是真合同，
  //      不能因为表头族不识别就丢掉；落草稿后按「缺单价」标待补，人工补价即可（不臆造价格）。
  const contractByName = /合同/.test(path.basename(it.abs)) && !!p.poNo;
  const isContract = local.contract || contractByName;
  if (isContract) {
    nContract += 1; st.contracts += 1;
    if (local.contract) nContractByPrice += 1; else nContractByName += 1;
  } else { nNonContract += 1; st.nonContract += 1; }
  Object.assign(rec, {
    contract: isContract,
    contractReason: local.contract ? '表头带单价列' : (contractByName ? '文件名含「合同」且识别到合同号' : '非合同'),
  });
  let skipReason = null;
  if (!lines.length) skipReason = isContract ? 'contract_no_lines' : 'noncontract_no_lines';
  else if (!isContract && !INCLUDE_NONCONTRACT) skipReason = 'noncontract';

  if (DRY) {
    rec.stage = 'dry-run';
    rec.pendingEstimate = {
      lineMissingPrice: lines.length - withPrice,
      lineMissingQty: lines.length - withQty,
      lineProductNotFiled: productUnfiled,
      dueDateMissing: !p.dueDate,
      customerUnfiled: !p.customerId,
    };
    if (skipReason) { rec.skipReason = skipReason; nSkip += 1; st.skipped += 1; }
    else { rec.wouldDraft = true; }
    records.push(rec);
    fs.appendFileSync(JSONL_FILE, JSON.stringify(rec) + '\n');
    if (PROGRESS_EVERY === 1 || i % PROGRESS_EVERY === 0 || i === targets.length) {
      say('[' + String(i).padStart(4) + '/' + targets.length + '] ' + it.key
        + '  行=' + lines.length + '/有价' + withPrice + '/产品未建档' + productUnfiled
        + '  交期=' + (p.dueDate ?? '—') + '  合同号=' + (p.poNo ?? '—')
        + '  通道=' + (p.parseSource ?? '?')
        + (skipReason ? '  ⏭ ' + skipReason : '  ✔ 可落草稿')
        + '  (' + (Date.now() - t0) + 'ms)');
    }
    continue;
  }

  if (skipReason) {
    nSkip += 1; st.skipped += 1;
    rec.stage = 'skip'; rec.skipReason = skipReason;
    if (skipReason.startsWith('noncontract')) skipped.noncontract.push(it.key);
    else skipped.contractNoLines.push(it.key + '（合同表但识别 0 行：' + (p.table ? p.table.stopReason : '—') + '）');
    records.push(rec);
    fs.appendFileSync(JSONL_FILE, JSON.stringify(rec) + '\n');
    if (PROGRESS_EVERY === 1 || i % PROGRESS_EVERY === 0 || i === targets.length) {
      say('[' + String(i).padStart(4) + '/' + targets.length + '] ' + it.key + '  ⏭ 跳过（' + skipReason + '）  行=' + lines.length + '  (' + (Date.now() - t0) + 'ms)');
    }
    continue;
  }

  // ---- ③ 落草稿 ----
  let draft;
  try {
    draft = await req('POST', '/orders/draft', {
      customerId: p.customerId ?? null,
      customerName: p.customerId ? null : (p.customerName ?? it.folder),
      folderCustomer: it.folder,
      poNo: p.poNo ?? null,
      dueDate: p.dueDate ?? null,
      note: '由 tools/ziliao/draft_orders_from_excel.mjs 批量落草稿（来源：' + it.key + '）',
      lines: lines.map((l) => ({
        productId: l.productId ?? null,
        productName: l.productId ? null : (l.productName ?? null),
        quantity: l.quantity ?? null,
        // 单价四舍五入到分（numeric(10,2) 口径）；带尾差的原始值在报告里留痕
        unitPrice: l.unitPrice === null || l.unitPrice === undefined ? null : round2(l.unitPrice),
        currency: l.currency,
        engraving: l.engraving || undefined,
        packaging: l.packaging && Object.keys(l.packaging).length ? l.packaging : undefined,
        priceFrom: l.priceFrom === 'quote' ? 'quote' : null,
        quoteId: l.quoteId ?? null,
      })),
    }, token);
  } catch (e) {
    nDraftFail += 1;
    rec.stage = 'draft-error'; rec.error = String(e && e.message ? e.message : e);
    skipped.draftFail.push(it.key + '：' + rec.error);
    records.push(rec);
    fs.appendFileSync(JSONL_FILE, JSON.stringify(rec) + '\n');
    say('[' + String(i).padStart(4) + '/' + targets.length + '] ' + it.key + '  ❌ 落草稿异常：' + rec.error);
    continue;
  }
  if (draft.status >= 300) {
    nDraftFail += 1;
    rec.stage = 'draft'; rec.status = draft.status; rec.error = draft.body;
    skipped.draftFail.push(it.key + '：【HTTP ' + draft.status + '】' + JSON.stringify(draft.body).slice(0, 200));
    records.push(rec);
    fs.appendFileSync(JSONL_FILE, JSON.stringify(rec) + '\n');
    say('[' + String(i).padStart(4) + '/' + targets.length + '] ' + it.key + '  ❌ 落草稿失败 HTTP ' + draft.status + '：' + JSON.stringify(draft.body).slice(0, 160));
    continue;
  }
  const d = draft.body ?? {};
  const items = Array.isArray(d.pendingItems) ? d.pendingItems : [];
  const lineItems = (Array.isArray(d.lines) ? d.lines : []).flatMap((l) => (Array.isArray(l.pendingItems) ? l.pendingItems : []));
  nDraft += 1; st.drafts += 1;
  if (items.length) { nDraftsWithPending += 1; st.draftsWithPending += 1; }
  nPendingItems += items.length; st.pendingItems += items.length;
  for (const x of items) pendingByCode[x.code] = (pendingByCode[x.code] ?? 0) + 1;
  for (const x of lineItems) linePendingByCode[x.code] = (linePendingByCode[x.code] ?? 0) + 1;
  Object.assign(rec, {
    stage: 'draft', orderId: d.id, orderNo: d.orderNo, dueDateTbd: d.dueDateTbd,
    pendingCodes: items.map((x) => x.code),
    linePendingCodes: lineItems.map((x) => x.code),
    draftCustomerName: d.draftCustomerName ?? null,
  });
  records.push(rec);
  fs.appendFileSync(JSONL_FILE, JSON.stringify(rec) + '\n');
  if (PROGRESS_EVERY === 1 || i % PROGRESS_EVERY === 0 || i === targets.length) {
    say('[' + String(i).padStart(4) + '/' + targets.length + '] ' + it.key
      + '  行=' + lines.length + '/有价' + withPrice + '/产品未建档' + productUnfiled
      + '  交期=' + (p.dueDate ?? '待定') + '  合同号=' + (p.poNo ?? '—')
      + '  → 草稿 ' + d.orderNo + (items.length ? '  待补 ' + items.length + ' 项 ' + JSON.stringify(items.map((x) => x.code)) : '  ✅ 无待补')
      + '  (' + (Date.now() - t0) + 'ms)');
  }
}

// ============ 汇总 ============
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const line = (s) => say(s);
line('');
line('================ Excel 合同批量落草稿汇总 ================');
line('目标接口：' + BASE + (DRY ? '（--dry-run：未建单）' : ''));
line('耗时 ' + elapsed + 's');
line('Excel 文件 ' + targets.length + '（合同 ' + nContract + ' = 「带单价列表头合同」' + nContractByPrice
  + ' + 另按「文件名含合同 且 识别到合同号」补充 ' + nContractByName + '；非合同 ' + nNonContract + '）');
line('识单成功 ' + nParseOk + '　识单失败 ' + nParseFail);
line('产品行合计 ' + nLines + '（有单价 ' + records.filter((r) => r.linesWithPrice !== undefined).reduce((a, r) => a + (r.linesWithPrice ?? 0), 0)
  + ' / 有数量 ' + records.reduce((a, r) => a + (r.linesWithQty ?? 0), 0)
  + ' / 产品未建档 ' + records.reduce((a, r) => a + (r.productUnfiledLines ?? 0), 0) + '）');
line('识单期按报价补价 ' + nQuoteFilled + ' 行　单价带「分」以下尾差（Excel 浮点误差）已四舍五入到分 ' + nPriceRounded + ' 行');
if (DRY) {
  const skipCount = (code) => records.filter((r) => r.skipReason === code).length;
  line('预估可落草稿 ' + records.filter((r) => r.wouldDraft).length + ' 份　跳过 ' + nSkip + ' 份（非合同 '
    + (skipCount('noncontract') + skipCount('noncontract_no_lines')) + ' = 非合同有产品行 ' + skipCount('noncontract')
    + ' + 非合同且无产品行 ' + skipCount('noncontract_no_lines') + '；合同但识别 0 行 ' + skipCount('contract_no_lines')
    + '；识单失败 ' + nParseFail + '）');
} else {
  line('落草稿成功 ' + nDraft + ' 份　落草稿失败 ' + nDraftFail + ' 份　跳过 ' + nSkip + ' 份');
  line('其中带待补项 ' + nDraftsWithPending + ' 份（单头待补项合计 ' + nPendingItems + ' 条）');
  line('待补项分布（单头）: ' + JSON.stringify(pendingByCode));
  line('待补项分布（行级）: ' + JSON.stringify(linePendingByCode));
}
line('按客户汇总：');
for (const [k, v] of Object.entries(byFolder)) {
  line('  ' + k + '：文件 ' + v.files + '（合同 ' + v.contracts + ' / 非合同 ' + v.nonContract + '）'
    + '　识单 ' + v.parseOk + ' 成功 / ' + v.parseFail + ' 失败'
    + '　行 ' + v.lines + '（有价 ' + v.linesWithPrice + ' / 有量 ' + v.linesWithQty + ' / 产品未建档 ' + v.productNotFiledLines + '）'
    + '　合同号命中 ' + v.poNoHit + '　交期命中 ' + v.dueDateHit
    + (DRY ? '　预估落草稿 ' + (v.drafts + records.filter((r) => r.folder === k && r.wouldDraft).length) : '　落草稿 ' + v.drafts + '（带待补 ' + v.draftsWithPending + '，待补项 ' + v.pendingItems + '）'));
}
if (skipped.noncontract.length) {
  line('跳过·非合同文件 ' + skipped.noncontract.length + ' 份（可用 --include-noncontract 强制落库）：');
  for (const x of skipped.noncontract) line('    ' + x);
}
if (skipped.contractNoLines.length) {
  line('跳过·合同表但识别 0 行 ' + skipped.contractNoLines.length + ' 份：');
  for (const x of skipped.contractNoLines) line('    ' + x);
}
if (skipped.parseFail.length) {
  line('识单失败 ' + skipped.parseFail.length + ' 份：');
  for (const x of skipped.parseFail) line('    ' + x);
}
if (skipped.draftFail.length) {
  line('落草稿失败 ' + skipped.draftFail.length + ' 份：');
  for (const x of skipped.draftFail) line('    ' + x);
}

const summary = {
  base: BASE, dryRun: DRY, limit: LIMIT || null, roots: roots.map((r) => ({ folder: r.folder, dir: r.dir })),
  files: targets.length, contracts: nContract, contractByPriceColumn: nContractByPrice, contractByName: nContractByName, nonContract: nNonContract,
  parseOk: nParseOk, parseFail: nParseFail, lines: nLines, quoteFilledLines: nQuoteFilled, priceRoundedLines: nPriceRounded,
  drafts: nDraft, draftFail: nDraftFail, skipped: nSkip,
  draftsWithPending: nDraftsWithPending, pendingItemsTotal: nPendingItems,
  pendingByCode, linePendingByCode, byCustomerFolder: byFolder,
  skippedLists: skipped, elapsedSeconds: Number(elapsed),
};
fs.writeFileSync(REPORT_FILE, JSON.stringify({ summary, records }, null, 1));
line('日志：' + LOG_FILE);
line('明细：' + JSONL_FILE);
line('报告：' + REPORT_FILE);
if (nParseFail || nDraftFail) process.exitCode = 1;
