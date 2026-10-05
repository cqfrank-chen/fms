#!/usr/bin/env node
/**
 * 识单复测（5 份最规整的出口产品供需合同）· 只读不建单
 * =====================================================================
 * 目的：按「文件夹=客户」口径复测 AI 识单管线的 precision / recall / 客户名 / 交期 / 合同号，
 *       给出改造前(BEFORE)与改造后(AFTER)的真实对比数字（同一脚本、同一真值、同一比较口径）。
 *
 * 真值来源：D:\\futures\\ziliao-analysis.md §3.3（逐份打开文件人工核对的产品行 (数量,单价) 多重集）
 *           交期/合同号/需方：逐份打开原始表逐行核对（见下 CASES.expect）。
 *
 * 用法：
 *   node tools/ziliao/ai_recheck_contracts.mjs [--out 目录] [--no-folder] [--label BEFORE]
 * 环境变量：
 *   FMS_BASE  默认 http://127.0.0.1:3100/api
 *   FMS_USER / FMS_PASS  默认 admin / Fms@2026
 *   ROOT      资料包根目录，默认 D:/futures/ziliao-data
 *
 * 口径说明：
 *   · 产品行比较 = (数量, 单价) 多重集；真值行必须在识别结果中一一配对（recall），
 *     识别结果中多余的即噪声（precision 惩罚）；单价容差 1e-6。
 *   · **主口径与 ziliao-analysis.md §3.3 一致**：只统计「数量与单价都非空」的识别行（有值行）；
 *     同时附「全部识别行（含只识别出片段的空值行）」口径，两个数字都打印，不做隐藏。
 *   · precision = 命中数 / 识别行数；recall = 命中数 / 真值行数。
 *   · 客户名：改造后由 folderCustomer（文件夹名）直接给出，这里断言「识别客户名 == 文件夹名」。
 *   · --no-folder 用于复现改造前的旧口径（不传 folderCustomer）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', path.resolve(__dirname, '../../.scratch/ziliao-recheck'));
const LABEL = arg('--label', 'RUN');
const USE_FOLDER = !process.argv.includes('--no-folder');
const ROOT = process.env.ROOT ?? 'D:/futures/ziliao-data';
const BASE = process.env.FMS_BASE ?? 'http://127.0.0.1:3100/api';
const USER = process.env.FMS_USER ?? 'admin';
const PASS = process.env.FMS_PASS ?? 'Fms@2026';
fs.mkdirSync(OUT, { recursive: true });

/** 真值：folder=顶层客户文件夹（甲方裁定「文件夹=客户」），buyer=抬头区「需方」原文 */
const CASES = [
  {
    rel: 'ziliao/安宝公司/美国FRONNY/订单/2025/AB25758 出口产品供需合同-一洲PO64713.xls',
    folder: '安宝公司',
    expect: {
      buyer: '宁波安宝国际贸易有限公司',
      poNo: 'AB25 758',
      dueDate: '2025-09-10',
      lines: [[500, 9.68], [1000, 9.68], [500, 9.68], [1000, 13.2], [800, 13.2], [600, 13.2], [200, 8.03], [200, 8.03]],
    },
  },
  {
    rel: 'ziliao/安宝公司/INFAR不干胶/INFRA合同/2026/AB26764.xls',
    folder: '安宝公司',
    expect: { buyer: '宁波安宝国际贸易有限公司', poNo: 'AB26 764返单AB26053', dueDate: '2026-09-30', lines: [[800, 12]] },
  },
  {
    rel: 'ziliao/尤耐克/MTL/MTL合同/LGC10801299-宁波一洲.xls',
    folder: '尤耐克',
    expect: { buyer: 'NINGBO UNITED TOOLS CO LTD', poNo: 'LGC10801299-宁波一洲', dueDate: '2021-09-18', lines: [[300, 7.9], [400, 7.9], [600, 7.9], [800, 7.9], [600, 7.9], [200, 7.9], [200, 7.9]] },
  },
  {
    rel: 'ziliao/尤耐克/MTL/MTL合同/LGC21201449宁波一洲.xlsx',
    folder: '尤耐克',
    expect: { buyer: '宁波市尤耐克工具有限公司', poNo: 'LGC21201449宁波一洲', dueDate: '2023-01-24', lines: [[500, 7.6], [800, 7.6], [600, 7.6], [200, 7.6], [200, 7.6], [400, 7.6], [200, 7.6]] },
  },
  {
    rel: 'ziliao/尤耐克/CROSSWELD文件/合同/2025/UW250307093宁波一洲.xlsx',
    folder: '尤耐克',
    expect: { buyer: '宁波市尤耐克工具有限公司', poNo: 'UW250307093宁波一洲', dueDate: '2025-04-23', lines: [[200, 13.2], [300, 13.2]] },
  },
];

const MIME = { '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv' };

async function login() {
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error('登录失败: ' + JSON.stringify(j));
  return j.token;
}

/** 多重集配对：真值 (qty,price) 逐个在识别结果中找配对，命中则从池中移除 */
function matchLines(truth, produced) {
  const pool = produced.map((l) => ({ qty: l.quantity, price: l.unitPrice, used: false }));
  let hit = 0;
  for (const [q, p] of truth) {
    const i = pool.findIndex((x) => !x.used && Number(x.qty) === q && x.price != null && Math.abs(Number(x.price) - p) < 1e-6);
    if (i >= 0) { pool[i].used = true; hit += 1; }
  }
  return hit;
}

const token = await login();
const rowsOut = [];
let agg = { truth: 0, produced: 0, producedAll: 0, hit: 0, cust: 0, due: 0, po: 0, n: 0 };

console.log('目标接口：' + BASE + (USE_FOLDER ? '（folderCustomer=文件夹名 已开启）' : '（--no-folder：旧口径，不传 folderCustomer）'));
console.log('');
for (const c of CASES) {
  const abs = path.join(ROOT, c.rel.split('/').join(path.sep));
  const ext = path.extname(abs).toLowerCase();
  const body = {
    file: 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + fs.readFileSync(abs).toString('base64'),
    fileName: path.basename(abs),
  };
  if (USE_FOLDER) body.folderCustomer = c.folder;
  const t0 = Date.now();
  const r = await fetch(BASE + '/ai/orders/parse', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  const ms = Date.now() - t0;
  const produced = Array.isArray(j.lines) ? j.lines : [];
  // 主口径（与报告 §3.3 一致）：数量与单价都非空的「有值行」
  const valued = produced.filter((l) => l.quantity !== null && l.quantity !== undefined && l.unitPrice !== null && l.unitPrice !== undefined);
  const hit = matchLines(c.expect.lines, valued);
  const precision = valued.length ? hit / valued.length : 0;
  const precisionAll = produced.length ? hit / produced.length : 0;
  const recall = c.expect.lines.length ? hit / c.expect.lines.length : 0;
  const custOk = j.customerName === c.folder;
  const dueOk = j.dueDate === c.expect.dueDate;
  const poOk = String(j.poNo ?? '').trim() === c.expect.poNo;
  agg.n += 1; agg.truth += c.expect.lines.length; agg.produced += valued.length; agg.producedAll += produced.length; agg.hit += hit;
  agg.cust += custOk ? 1 : 0; agg.due += dueOk ? 1 : 0; agg.po += poOk ? 1 : 0;
  console.log('===== ' + path.basename(c.rel) + '  [folder=' + c.folder + '] (HTTP ' + r.status + ', ' + ms + 'ms)');
  console.log('  真值行=' + c.expect.lines.length + '  有值识别行=' + valued.length + '（全部识别行 ' + produced.length + '）  命中=' + hit
    + '  漏=' + (c.expect.lines.length - hit) + '  多余=' + (valued.length - hit)
    + '  precision=' + Math.round(precision * 100) + '%（全部口径 ' + Math.round(precisionAll * 100) + '%）  recall=' + Math.round(recall * 100) + '%');
  console.log('  客户名=' + JSON.stringify(j.customerName) + '（期望文件夹名 ' + JSON.stringify(c.folder) + '）' + (custOk ? ' ✅' : ' ❌'));
  console.log('  交期=' + JSON.stringify(j.dueDate) + '（真值 ' + c.expect.dueDate + '）' + (dueOk ? ' ✅' : ' ❌')
    + '   合同号=' + JSON.stringify(j.poNo) + '（真值 ' + JSON.stringify(c.expect.poNo) + '）' + (poOk ? ' ✅' : ' ❌'));
  console.log('  parseSource=' + j.parseSource + '  表格命中=' + (j.table ? j.table.requiredHits + '/' + (j.table.requiredTotal ?? 4) + ' 缺失=' + JSON.stringify(j.table.missingRequired) : 'n/a')
    + '  终止原因=' + JSON.stringify(j.table && j.table.stopReason !== undefined ? j.table.stopReason : null)
    + '  抬头区=' + JSON.stringify(j.table && j.table.headerArea ? j.table.headerArea : null));
  console.log('  有值识别行: ' + JSON.stringify(valued.map((l) => [l.quantity, l.unitPrice])));
  const blank = produced.length - valued.length;
  if (blank) console.log('  ⚠️ 未取到数量或单价的行 ' + blank + ' 行（全部口径的噪声）');
  if (Array.isArray(j.issues) && j.issues.length) console.log('  校验提示: ' + JSON.stringify(j.issues.map((x) => x.level + ':' + x.message).slice(0, 6)));
  rowsOut.push({ rel: c.rel, folder: c.folder, status: r.status, ms, expect: c.expect, precision, precisionAll, recall, hit, valued, produced, customerName: j.customerName, dueDate: j.dueDate, poNo: j.poNo, parseSource: j.parseSource, table: j.table, issues: j.issues, notes: j.notes });
}

console.log('');
console.log('================ 合计（' + LABEL + '）================');
console.log('真值行=' + agg.truth + '  有值识别行=' + agg.produced + '（全部识别行 ' + agg.producedAll + '）  命中=' + agg.hit
  + '  → precision=' + Math.round((agg.hit / (agg.produced || 1)) * 100) + '%（有值行口径，与报告 §3.3 一致）'
  + '  precision(全部行口径)=' + Math.round((agg.hit / (agg.producedAll || 1)) * 100) + '%'
  + '  recall=' + Math.round((agg.hit / (agg.truth || 1)) * 100) + '%');
console.log('客户名正确=' + agg.cust + '/' + agg.n + '  交期正确=' + agg.due + '/' + agg.n + '  合同号正确=' + agg.po + '/' + agg.n);
const file = path.join(OUT, 'recheck_' + LABEL + '.json');
fs.writeFileSync(file, JSON.stringify({ label: LABEL, base: BASE, useFolderCustomer: USE_FOLDER, agg, cases: rowsOut }, null, 1));
console.log('报告: ' + file);
