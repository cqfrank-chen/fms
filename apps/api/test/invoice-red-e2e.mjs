/**
 * 红字发票 / 待补票号 / 默认税率 / 超开闸门 · 端到端自测（I16 遗留项收敛 A/B/C/D）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   A 红冲：开票 → 全额红冲（净额归零、订单三态回退）→ 部分红冲（两段）→ 累计超额拒绝 →
 *           作废红字票后净额回升、最后一张作废后原票状态还原 → 已作废票不可红冲 → 红字票不可再红冲
 *   B 待补票号：?missingNo=true 过滤 + summary.pendingNoCount + 补录票号后消失
 *   C 默认税率：GET/PUT /api/invoices/settings（仅 0/1%/6%/9%/13%）+ 非 0 默认税率下反解开票
 *   D 超开闸门：默认 400 阻止；allowOverInvoiced=true（高级勾选）放行并回 warning
 *   另：未登录 401 / workshop 403；净额与 SQL 复算（status <> 'voided' 求和）
 *
 * 前置：一个连到**空库**的 API 实例（自动建表 + 种子 admin/Fms@2026），例如：
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_test JWT_SECRET=e2e PORT=3100 node dist/main
 * 运行：node test/invoice-red-e2e.mjs
 */
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3100/api';
const PG_CONF = {
  host: process.env.E2E_PG_HOST ?? 'localhost',
  port: Number(process.env.E2E_PG_PORT ?? 15432),
  user: process.env.E2E_PG_USER ?? 'fms',
  password: process.env.E2E_PG_PASSWORD ?? 'fms',
  database: process.env.E2E_PG_DB ?? 'fms_test',
};

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    passCount += 1;
    console.log('  ✅ ' + label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  } else {
    failCount += 1;
    failures.push(label);
    console.log('  ❌ ' + label + '  实测：' + JSON.stringify(detail));
  }
}

function eq(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    ok(label, true, actual);
  } catch {
    ok(label, false, { actual, expected });
  }
}

async function req(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const S = { customerId: null, productId: null, o1: null, o2: null, o3: null };

async function createOrder(token, priceYuan, qty) {
  const res = await req('POST', '/orders', {
    customerId: S.customerId,
    dueDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
    lines: [{ productId: S.productId, quantity: qty, unitPrice: priceYuan / qty, currency: 'RMB' }],
  }, token);
  assert.equal(res.status, 201, '建单失败：' + JSON.stringify(res.body));
  await req('POST', `/orders/${res.body.id}/confirm`, undefined, token);
  return res.body.id;
}

async function orderRow(token, id) {
  const list = await req('GET', '/orders', undefined, token);
  return list.body.find((o) => o.id === id);
}

async function main() {
  console.log('目标接口：' + BASE);
  console.log('测试数据库：' + PG_CONF.host + ':' + PG_CONF.port + '/' + PG_CONF.database);
  const db = new pg.Client(PG_CONF);
  await db.connect();

  const login = await req('POST', '/auth/login', { username: 'admin', password: 'Fms@2026' });
  eq('admin 登录成功', login.status, 200);
  const token = login.body.token;

  console.log('\n【准备】客户 / 产品 / 三张订单（1000.00 / 500.00 / 200.00 元）');
  S.customerId = (await req('POST', '/customers', { name: '红冲测试客户', creditDays: 30 }, token)).body.id;
  S.productId = (await req('POST', '/products', { name: '红冲测试产品', type: 'uk_acetylene' }, token)).body.id;
  S.o1 = await createOrder(token, 1000, 1000);
  S.o2 = await createOrder(token, 500, 100);
  S.o3 = await createOrder(token, 200, 200);
  ok('三张订单已确认', !!S.o1 && !!S.o2 && !!S.o3, [S.o1, S.o2, S.o3]);

  // ================= A1. 全额红冲 =================
  console.log('\n【A1 全额红冲】开票 1000.00 → 全额红冲 → 净额归零、订单回退「未开票」');
  const invA = await req('POST', '/invoices', {
    invoiceNo: 'RED-A', amountInclCents: 100000, issueDate: today(), orderIds: [S.o1],
  }, token);
  eq('原票已开（含税 1000.00）', invA.status, 201);
  eq('开票后订单状态 = 已开完', (await orderRow(token, S.o1)).invoiceState, 'done');

  const redA = await req('POST', `/invoices/${invA.body.id}/red-flush`, {
    reason: '跨月开错客户', invoiceNo: 'RED-A-R',
  }, token);
  eq('全额红冲成功', redA.status, 201);
  eq('红字票金额为负（含税 分）', redA.body.amountInclCents, -100000);
  eq('红字票不含税/税额（分）', [redA.body.amountExclCents, redA.body.taxCents], [-100000, 0]);
  eq('红字票指向原票号', redA.body.redFlushOfNo, 'RED-A');
  eq('红字票 isRed 标记', redA.body.isRed, true);
  const origA = await req('GET', `/invoices/${invA.body.id}`, undefined, token);
  eq('原票状态 = 已红冲', origA.body.status, 'red_flushed');
  eq('原票可见红字票号', origA.body.redFlushNos, ['RED-A-R']);
  eq('原票已红冲金额（分）', origA.body.redFlushedCents, 100000);
  eq('原票可红冲余额（分）', origA.body.redRemainCents, 0);

  const o1 = await orderRow(token, S.o1);
  eq('红冲后订单已开票净额（分）', o1.invoicedCents, 0);
  eq('红冲后订单状态回退「未开票」', o1.invoiceState, 'none');
  eq('红冲后未开票余额（分）', o1.uninvoicedCents, 100000);
  const stO1 = await req('GET', `/invoices/order-status?orderId=${S.o1}`, undefined, token);
  eq('订单进度：净额/状态/张数', [stO1.body.invoicedCents, stO1.body.invoiceState, stO1.body.invoiceCount], [0, 'none', 2]);

  // ================= A2. 部分红冲 + 累计上限 =================
  console.log('\n【A2 部分红冲】500.00 分两段红冲 200+200，第三次超额被拒，结清后归零');
  const invB = await req('POST', '/invoices', {
    invoiceNo: 'RED-B', amountInclCents: 50000, issueDate: today(), orderIds: [S.o2],
  }, token);
  eq('原票已开（含税 500.00）', invB.status, 201);

  const r1 = await req('POST', `/invoices/${invB.body.id}/red-flush`, { reason: '部分红冲①', invoiceNo: 'RED-B-R1', amountInclCents: 20000 }, token);
  eq('部分红冲①成功（-200.00）', [r1.status, r1.body.amountInclCents], [201, -20000]);
  eq('净额 = 300.00 → 部分开票', [(await orderRow(token, S.o2)).invoicedCents, (await orderRow(token, S.o2)).invoiceState], [30000, 'partial']);

  const r2 = await req('POST', `/invoices/${invB.body.id}/red-flush`, { reason: '部分红冲②', invoiceNo: 'RED-B-R2', amountInclCents: 20000 }, token);
  eq('部分红冲②成功（-200.00）', [r2.status, r2.body.amountInclCents], [201, -20000]);
  eq('净额 = 100.00', (await orderRow(token, S.o2)).invoicedCents, 10000);

  const r3 = await req('POST', `/invoices/${invB.body.id}/red-flush`, { reason: '部分红冲③超额', invoiceNo: 'RED-B-R3', amountInclCents: 20000 }, token);
  eq('累计红冲超额 → 400', r3.status, 400);
  ok('超额中文提示含可红冲余额', String(r3.body.message).includes('红冲金额超过可红冲余额') && String(r3.body.message).includes('还可红冲 100.00 元'), r3.body.message);

  const r3ok = await req('POST', `/invoices/${invB.body.id}/red-flush`, { reason: '部分红冲③余额', invoiceNo: 'RED-B-R3', amountInclCents: 10000 }, token);
  eq('按可红冲余额红冲成功', [r3ok.status, r3ok.body.amountInclCents], [201, -10000]);
  eq('全额红冲完 → 净额 0 / 未开票', [(await orderRow(token, S.o2)).invoicedCents, (await orderRow(token, S.o2)).invoiceState], [0, 'none']);

  // ================= A3. 作废红字票 → 净额回升、最后一张作废后原票状态还原 =================
  console.log('\n【A3 作废红字票】净额回升；全部红字票作废后原票状态由「已红冲」还原为「正常」');
  const voidR3 = await req('POST', `/invoices/${r3ok.body.id}/void`, { reason: '红字票开错，作废' }, token);
  eq('作废红字票成功', voidR3.status, 201);
  eq('净额回升 100.00 → 部分开票', [(await orderRow(token, S.o2)).invoicedCents, (await orderRow(token, S.o2)).invoiceState], [10000, 'partial']);

  await req('POST', `/invoices/${r2.body.id}/void`, { reason: '作废红字票②' }, token);
  eq('再作废一张 → 净额 300.00', (await orderRow(token, S.o2)).invoicedCents, 30000);
  const voidR1 = await req('POST', `/invoices/${r1.body.id}/void`, { reason: '作废红字票①' }, token);
  eq('最后一张红字票作废成功', voidR1.status, 201);
  eq('净额回到 500.00 → 已开完', [(await orderRow(token, S.o2)).invoicedCents, (await orderRow(token, S.o2)).invoiceState], [50000, 'done']);
  const origB = await req('GET', `/invoices/${invB.body.id}`, undefined, token);
  eq('原票状态还原为正常', origB.body.status, 'normal');
  eq('原票可红冲余额回到全额', origB.body.redRemainCents, 50000);

  // ================= A4. 已作废不可红冲 / 红字票不可再红冲 =================
  console.log('\n【A4 红冲限制】已作废票不可红冲；红字票不可再红冲');
  const invC = await req('POST', '/invoices', {
    invoiceNo: 'RED-C', amountInclCents: 10000, issueDate: today(), orderIds: [S.o3],
  }, token);
  await req('POST', `/invoices/${invC.body.id}/void`, { reason: '当月错票作废' }, token);
  const redVoided = await req('POST', `/invoices/${invC.body.id}/red-flush`, { reason: '试红冲', invoiceNo: 'RED-C-R' }, token);
  eq('已作废票红冲 → 400', redVoided.status, 400);
  ok('已作废不可红冲中文提示', String(redVoided.body.message).includes('已作废，不可红冲'), redVoided.body.message);

  const redOnRed = await req('POST', `/invoices/${redA.body.id}/red-flush`, { reason: '试再红冲', invoiceNo: 'RED-A-R2' }, token);
  eq('红字票再红冲 → 400', redOnRed.status, 400);
  ok('红字票不可再红冲中文提示', String(redOnRed.body.message).includes('不可再红冲'), redOnRed.body.message);

  const noReason = await req('POST', `/invoices/${invB.body.id}/red-flush`, { invoiceNo: 'RED-B-RX' }, token);
  eq('缺冲红原因 → 400', noReason.status, 400);
  ok('缺原因中文提示', JSON.stringify(noReason.body.message).includes('冲红原因'), noReason.body.message);
  const noNo = await req('POST', `/invoices/${invB.body.id}/red-flush`, { reason: '缺票号' }, token);
  eq('缺红字票号 → 400', noNo.status, 400);
  ok('缺票号中文提示', JSON.stringify(noNo.body.message).includes('红字发票号'), noNo.body.message);

  // ================= B. 待补票号 =================
  console.log('\n【B 待补票号】missingNo 过滤 + summary.pendingNoCount + 补录后消失');
  const pend = await req('POST', '/invoices', { amountInclCents: 5000, issueDate: today(), orderIds: [S.o3] }, token);
  eq('不传票号 → 自动占位号', [pend.status, String(pend.body.invoiceNo).startsWith('待补号-')], [201, true]);

  const missingList = await req('GET', '/invoices?missingNo=true', undefined, token);
  eq('missingNo 过滤：只剩 1 张待补票号', [missingList.body.total, missingList.body.items.length], [1, 1]);
  eq('待补票号即刚开的那张', missingList.body.items[0].id, pend.body.id);
  const sumPending = await req('GET', '/invoices/summary', undefined, token);
  eq('summary.pendingNoCount = 1', sumPending.body.pendingNoCount, 1);

  const filled = await req('PUT', `/invoices/${pend.body.id}`, { invoiceNo: 'RED-P-REAL' }, token);
  eq('补录真实票号成功', [filled.status, filled.body.invoiceNo], [200, 'RED-P-REAL']);
  const sumPending2 = await req('GET', '/invoices/summary', undefined, token);
  eq('补录后 pendingNoCount = 0', sumPending2.body.pendingNoCount, 0);
  eq('补录后 missingNo 过滤为空', (await req('GET', '/invoices?missingNo=true', undefined, token)).body.total, 0);
  const missingNoBad = await req('GET', '/invoices?missingNo=abc', undefined, token);
  eq('missingNo 非法值 → 400', missingNoBad.status, 400);

  // ================= C. 默认税率设置 =================
  console.log('\n【C 默认税率】GET/PUT /invoices/settings（仅 0/1%/6%/9%/13%）');
  const set0 = await req('GET', '/invoices/settings', undefined, token);
  eq('未配置时默认 0', [set0.status, set0.body.defaultTaxRate], [200, 0]);
  const setSave = await req('PUT', '/invoices/settings', { defaultTaxRate: 0.06 }, token);
  eq('保存默认税率 6% 成功', [setSave.status, setSave.body.defaultTaxRate], [200, 0.06]);
  eq('回读默认税率 = 0.06', (await req('GET', '/invoices/settings', undefined, token)).body.defaultTaxRate, 0.06);
  const setBad = await req('PUT', '/invoices/settings', { defaultTaxRate: 0.03 }, token);
  eq('非法默认税率 → 400', setBad.status, 400);
  ok('非法税率中文提示含允许值', String(setBad.body.message).includes('0 / 1% / 6% / 9% / 13%'), setBad.body.message);
  const sqlSetting = await db.query("select value from app_settings where key = 'invoice.default_tax_rate'");
  eq('设置已落库 app_settings（极简存储）', sqlSetting.rows[0]?.value, '0.06');

  const byDefaultRate = await req('POST', '/invoices', {
    invoiceNo: 'RED-RATE-6', amountInclCents: 10600, taxRate: 0.06, issueDate: today(), orderIds: [S.o3],
  }, token);
  eq('按默认税率 6% 开票成功', byDefaultRate.status, 201);
  eq('6% 反解：不含税 100.00 / 税额 6.00', [byDefaultRate.body.amountExclCents, byDefaultRate.body.taxCents], [10000, 600]);

  // ================= D. 超开闸门 =================
  console.log('\n【D 超开闸门】默认阻止；「高级」勾选 allowOverInvoiced 才放行');
  const o3 = await orderRow(token, S.o3);
  const overAmount = Math.max(10000, o3.uninvoicedCents + 1000);
  const blocked = await req('POST', '/invoices', {
    invoiceNo: 'RED-OVER-1', amountInclCents: overAmount, issueDate: today(), orderIds: [S.o3],
  }, token);
  eq('默认超开 → 400', blocked.status, 400);
  ok('超开中文提示指向「允许超开」', String(blocked.body.message).includes('允许超开'), blocked.body.message);
  const allowed = await req('POST', '/invoices', {
    invoiceNo: 'RED-OVER-1', amountInclCents: overAmount, issueDate: today(), orderIds: [S.o3], allowOverInvoiced: true,
  }, token);
  eq('勾选允许超开后 → 201', allowed.status, 201);
  ok('放行后仍回 warning（超出金额）', typeof allowed.body.warning === 'string' && allowed.body.warning.includes('超出订单金额'), allowed.body.warning);
  const o3After = await orderRow(token, S.o3);
  eq('订单转为超额标记 / 状态已开完', [o3After.overInvoiced, o3After.invoiceState], [true, 'done']);

  // ================= E. 鉴权 =================
  console.log('\n【E 鉴权】未登录 401；workshop 红冲/设置 403');
  const anonRed = await req('POST', `/invoices/${invB.body.id}/red-flush`, { reason: 'x', invoiceNo: 'y' });
  eq('未登录红冲 → 401', anonRed.status, 401);
  const anonSet = await req('PUT', '/invoices/settings', { defaultTaxRate: 0 });
  eq('未登录改设置 → 401', anonSet.status, 401);
  await req('POST', '/users', { username: 'redworkshop', password: 'Ws@20261z', displayName: '红冲测试车间', role: 'workshop' }, token);
  const wsToken = (await req('POST', '/auth/login', { username: 'redworkshop', password: 'Ws@20261z' })).body.token;
  eq('workshop 红冲 → 403', (await req('POST', `/invoices/${invB.body.id}/red-flush`, { reason: 'x', invoiceNo: 'y' }, wsToken)).status, 403);
  eq('workshop 改设置 → 403', (await req('PUT', '/invoices/settings', { defaultTaxRate: 0 }, wsToken)).status, 403);
  eq('workshop 可读设置', (await req('GET', '/invoices/settings', undefined, wsToken)).status, 200);

  // ================= F. 净额 SQL 复算 =================
  console.log('\n【F SQL 复算】净额 = Σ(未作废票含税)，红字票为负；订单净额与接口一致');
  const summary = await req('GET', '/invoices/summary', undefined, token);
  const sqlNet = await db.query(
    "select count(*)::int as n, coalesce(sum(amount_incl_cents),0)::bigint as incl,"
    + " coalesce(sum(amount_excl_cents),0)::bigint as excl, coalesce(sum(tax_cents),0)::bigint as tax"
    + " from invoices where status <> 'voided'");
  eq('净额张数 = SQL', summary.body.count, Number(sqlNet.rows[0].n));
  eq('净额含税合计 = SQL', summary.body.amountInclCents, Number(sqlNet.rows[0].incl));
  eq('净额不含税合计 = SQL', summary.body.amountExclCents, Number(sqlNet.rows[0].excl));
  eq('净额税额合计 = SQL', summary.body.taxCents, Number(sqlNet.rows[0].tax));
  const identity = await db.query(
    'select count(*)::int as bad from invoices where amount_incl_cents <> amount_excl_cents + tax_cents');
  eq('三金额恒等式（含红字负数）违规行数', Number(identity.rows[0].bad), 0);
  const redLink = await db.query(
    "select count(*)::int as n from invoices r join invoices o on o.id = r.red_flush_of"
    + " where r.amount_incl_cents > 0 or o.amount_incl_cents < 0");
  eq('红字票为负、原票为正（SQL 核对）', Number(redLink.rows[0].n), 0);

  for (const [label, orderId, expectCents] of [['O1', S.o1, 0], ['O2', S.o2, 50000]]) {
    const api = await req('GET', `/invoices/order-status?orderId=${orderId}`, undefined, token);
    const sql = await db.query(
      'select coalesce(sum(i.amount_incl_cents),0)::bigint as incl from invoice_orders io'
      + " join invoices i on i.id = io.invoice_id where io.order_id = $1 and i.status <> 'voided'", [orderId]);
    eq(`订单 ${label} 净额：接口 = SQL`, api.body.invoicedCents, Number(sql.rows[0].incl));
    eq(`订单 ${label} 净额期望值（分）`, api.body.invoicedCents, expectCents);
  }

  await db.end();
  console.log('\n================ 结果 ================');
  console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
  if (failCount) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('自测脚本异常中断：', e);
  process.exit(1);
});
