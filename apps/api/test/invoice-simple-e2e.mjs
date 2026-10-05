/**
 * 开票「交互简化」端到端自测（I16 简化）· 真实 HTTP + 真实 PostgreSQL + SQL 复算
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) 订单三状态：未开票(none) / 部分开票(partial) / 已开完(done)；已开票超过价格仍为「已开完」且不报错
 *   2) 简化开票：只传 invoiceNo + amountInclCents + issueDate + orderIds 即成功，
 *      返回 amountExclCents == amountInclCents、taxCents == 0、taxRate == 0（SQL 核对）
 *   3) 票号可选：不传自动生成占位号「待补号-…」；占位号可随后补录真实票号，真实票号不可再改
 *   4) 快捷开完：按「价格 − 已开票」的剩余金额开票 → 订单变为「已开完」、未开票余额 0
 *   5) 兼容：既有完整入参（amountExclCents + taxRate + taxCents + amountInclCents）仍可用
 *   6) 鉴权：未登录 401 / workshop 写操作 403
 *
 * 前置：一个连到**空库**的 API 实例（自动建表 + 种子 admin/Fms@2026），例如：
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_test JWT_SECRET=e2e PORT=3100 node dist/main
 * 运行：node test/invoice-simple-e2e.mjs
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

/** 建单：数量 × 单价（元），返回 { id, orderNo, totalAmountCents, invoiceState } */
async function createOrder(token, priceYuan, qty = 1) {
  const res = await req('POST', '/orders', {
    customerId: S.customerId,
    dueDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
    lines: [{ productId: S.productId, quantity: qty, unitPrice: priceYuan / qty, currency: 'RMB' }],
  }, token);
  assert.equal(res.status, 201, '建单失败：' + JSON.stringify(res.body));
  await req('POST', `/orders/${res.body.id}/confirm`, undefined, token);
  return res.body.id;
}

/** 从订单列表取某订单（含 invoiceState/invoicedCents/uninvoicedCents） */
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
  S.customerId = (await req('POST', '/customers', { name: '简化开票客户', creditDays: 30 }, token)).body.id;
  S.productId = (await req('POST', '/products', { name: '简化开票产品', type: 'uk_acetylene' }, token)).body.id;
  S.o1 = await createOrder(token, 1000, 1000);   // 1000 × 1.00 = 1000.00 元 = 100000 分
  S.o2 = await createOrder(token, 500, 100);     // 100 × 5.00
  S.o3 = await createOrder(token, 200, 200);     // 200 × 1.00
  ok('三张订单已确认', !!S.o1 && !!S.o2 && !!S.o3, [S.o1, S.o2, S.o3]);

  // ================= 1) 订单三状态 =================
  console.log('\n【1. 订单三状态】未开票 / 部分开票 / 已开完');
  let row = await orderRow(token, S.o1);
  eq('新订单价格(分)', row.totalAmountCents, 100000);
  eq('新订单已开票(分)', row.invoicedCents, 0);
  eq('新订单开票状态', row.invoiceState, 'none');
  eq('新订单未开票余额(分)', row.uninvoicedCents, 100000);

  // 部分开票 300.00 元（简化入参：只给含税金额）
  const partial = await req('POST', '/invoices', {
    invoiceNo: 'SIM-0001', amountInclCents: 30000, issueDate: today(), orderIds: [S.o1],
  }, token);
  eq('部分开票成功', partial.status, 201);
  row = await orderRow(token, S.o1);
  eq('部分开票后 已开票(分)', row.invoicedCents, 30000);
  eq('部分开票后 开票状态', row.invoiceState, 'partial');
  eq('部分开票后 未开票余额(分)', row.uninvoicedCents, 70000);

  const stPartial = await req('GET', `/invoices/order-status?orderId=${S.o1}`, undefined, token);
  eq('订单进度接口 开票状态', stPartial.body.invoiceState, 'partial');

  // 结清剩余 700.00 元
  const rest = await req('POST', '/invoices', {
    invoiceNo: 'SIM-0002', amountInclCents: 70000, issueDate: today(), orderIds: [S.o1],
  }, token);
  eq('结清开票成功', rest.status, 201);
  row = await orderRow(token, S.o1);
  eq('已开完 已开票(分)', row.invoicedCents, 100000);
  eq('已开完 开票状态', row.invoiceState, 'done');
  eq('已开完 未开票余额(分)', row.uninvoicedCents, 0);
  eq('已开完 是否超额', row.overInvoiced, false);

  // 超过价格：默认阻止（I16 收敛⑤），只有「高级」显式勾选「允许超开」才继续
  const overBlocked = await req('POST', '/invoices', {
    invoiceNo: 'SIM-0003', amountInclCents: 5000, issueDate: today(), orderIds: [S.o1],
  }, token);
  eq('默认超开被阻止 → 400', overBlocked.status, 400);
  const over = await req('POST', '/invoices', {
    invoiceNo: 'SIM-0003', amountInclCents: 5000, issueDate: today(), orderIds: [S.o1],
    allowOverInvoiced: true,
  }, token);
  eq('高级勾选允许超开后仍成功（不报错）', over.status, 201);
  ok('超额开票返回 warning', typeof over.body.warning === 'string' && over.body.warning.includes('超出订单金额'), over.body.warning);
  row = await orderRow(token, S.o1);
  eq('超额后 已开票(分)', row.invoicedCents, 105000);
  eq('超额后 开票状态仍为已开完', row.invoiceState, 'done');
  eq('超额后 未开票余额(分，不为负)', row.uninvoicedCents, 0);
  eq('超额后 是否超额', row.overInvoiced, true);
  const stOver = await req('GET', `/invoices/order-status?orderId=${S.o1}`, undefined, token);
  eq('超额后 订单进度接口状态', stOver.body.invoiceState, 'done');

  // ================= 2) 简化开票（只传含税金额） =================
  console.log('\n【2. 简化开票】只传 invoiceNo + amountInclCents + issueDate + orderIds');
  const simple = await req('POST', '/invoices', {
    invoiceNo: 'SIM-SIMPLE-1', amountInclCents: 12345, issueDate: today(), orderIds: [S.o3],
  }, token);
  eq('简化开票成功（未传税率/不含税/税额）', simple.status, 201);
  eq('返回 含税金额(分)', simple.body.amountInclCents, 12345);
  eq('返回 不含税金额(分) == 含税', simple.body.amountExclCents, 12345);
  eq('返回 税额(分)', simple.body.taxCents, 0);
  eq('返回 税率 默认 0', Number(simple.body.taxRate), 0);
  eq('返回 票种 默认 vat_general', simple.body.invoiceType, 'vat_general');

  const sqlSimple = await db.query(
    'select amount_excl_cents, tax_cents, amount_incl_cents, tax_rate from invoices where id = $1', [simple.body.id]);
  const sr = sqlSimple.rows[0];
  eq('SQL 核对：不含税(分)', Number(sr.amount_excl_cents), 12345);
  eq('SQL 核对：税额(分)', Number(sr.tax_cents), 0);
  eq('SQL 核对：含税(分)', Number(sr.amount_incl_cents), 12345);
  eq('SQL 核对：税率', Number(sr.tax_rate), 0);
  const identity = await db.query(
    'select count(*)::int as bad from invoices where amount_incl_cents <> amount_excl_cents + tax_cents');
  eq('SQL 核对：全库三金额恒等式违规行数', Number(identity.rows[0].bad), 0);

  // 票号可选：不传 → 自动占位号
  const noNo = await req('POST', '/invoices', { amountInclCents: 5000, issueDate: today(), orderIds: [S.o3] }, token);
  eq('不传票号仍成功', noNo.status, 201);
  ok('自动生成占位票号（待补号-YYYYMMDD-NN）', String(noNo.body.invoiceNo).startsWith('待补号-'), noNo.body.invoiceNo);
  eq('占位票号已入库', Number((await db.query("select count(*)::int as n from invoices where invoice_no like '待补号-%'")).rows[0].n), 1);

  // 占位票号可补录真实票号；真实票号不可再改
  const fill = await req('PUT', `/invoices/${noNo.body.id}`, { invoiceNo: 'SIM-REAL-9' }, token);
  eq('占位票号补录成功', fill.status, 200);
  eq('补录后票号', fill.body.invoiceNo, 'SIM-REAL-9');
  const reNo = await req('PUT', `/invoices/${noNo.body.id}`, { invoiceNo: 'SIM-REAL-10' }, token);
  eq('真实票号不可再改 → 400', reNo.status, 400);
  ok('票号不可改中文提示', String(reNo.body.message).includes('不可修改'), reNo.body.message);

  // 兼容：既有完整入参方式
  console.log('\n【2b. 兼容】完整入参（不含税 + 税率 + 税额 + 含税）仍可用');
  const full = await req('POST', '/invoices', {
    invoiceNo: 'SIM-FULL-1', invoiceType: 'vat_special', customerId: S.customerId,
    amountExclCents: 10000, taxRate: 0.13, taxCents: 1300, amountInclCents: 11300, issueDate: today(),
  }, token);
  eq('完整入参成功', full.status, 201);
  eq('完整入参：不含税/税额/含税(分)', [full.body.amountExclCents, full.body.taxCents, full.body.amountInclCents], [10000, 1300, 11300]);
  const fullOnlyIncl = await req('POST', '/invoices', {
    invoiceNo: 'SIM-FULL-2', customerId: S.customerId, amountInclCents: 11300, taxRate: 0.13, issueDate: today(),
  }, token);
  eq('只给含税 + 13% 也能反解成功', fullOnlyIncl.status, 201);
  eq('反解结果：不含税/税额(分)', [fullOnlyIncl.body.amountExclCents, fullOnlyIncl.body.taxCents], [10000, 1300]);

  // ================= 3) 快捷开完 =================
  console.log('\n【3. 快捷开完】按「价格 − 已开票」带出剩余金额 → 一键结清');
  const p2 = await req('POST', '/invoices', {
    invoiceNo: 'SIM-Q-1', amountInclCents: 20000, issueDate: today(), orderIds: [S.o2],
  }, token);
  eq('先部分开票 200.00 元', p2.status, 201);
  let row2 = await orderRow(token, S.o2);
  eq('O2 部分开票状态', row2.invoiceState, 'partial');
  const remain2 = row2.uninvoicedCents;
  eq('O2 剩余未开票(分)（= 首页按钮带入值）', remain2, 30000);

  const quick = await req('POST', '/invoices', {
    invoiceNo: 'SIM-Q-2', amountInclCents: remain2, issueDate: today(), orderIds: [S.o2],
  }, token);
  eq('快捷开票（剩余金额）成功', quick.status, 201);
  row2 = await orderRow(token, S.o2);
  eq('快捷开完后 开票状态', row2.invoiceState, 'done');
  eq('快捷开完后 已开票(分)', row2.invoicedCents, 50000);
  eq('快捷开完后 未开票余额(分)', row2.uninvoicedCents, 0);
  eq('快捷开完后 不产生 warning（未超额）', quick.body.warning, undefined);
  const st2 = await req('GET', `/invoices/order-status?orderId=${S.o2}`, undefined, token);
  eq('订单进度接口：状态与张数', [st2.body.invoiceState, st2.body.invoiceCount], ['done', 2]);

  // ================= 4) 鉴权 =================
  console.log('\n【4. 鉴权】未登录 401 / workshop 403');
  const anon = await req('POST', '/invoices', { amountInclCents: 100, orderIds: [S.o3] });
  eq('未登录简化开票 → 401', anon.status, 401);
  await req('POST', '/users', { username: 'simworkshop', password: 'Ws@20261y', displayName: '简化票测试车间', role: 'workshop' }, token);
  const wsToken = (await req('POST', '/auth/login', { username: 'simworkshop', password: 'Ws@20261y' })).body.token;
  const wsPost = await req('POST', '/invoices', { amountInclCents: 100, issueDate: today(), orderIds: [S.o3] }, wsToken);
  eq('workshop 简化开票 → 403', wsPost.status, 403);
  eq('workshop 仍可读订单（含开票状态字段）', (await req('GET', '/orders', undefined, wsToken)).status, 200);

  // ================= 5) 汇总口径 =================
  console.log('\n【5. 汇总】开票数目与 SQL 复算（含占位号与作废能力未受影响）');
  const summary = await req('GET', '/invoices/summary', undefined, token);
  const sql = await db.query(
    "select count(*)::int as n, coalesce(sum(amount_incl_cents),0)::bigint as incl,"
    + " coalesce(sum(amount_excl_cents),0)::bigint as excl, coalesce(sum(tax_cents),0)::bigint as tax"
    + " from invoices where status = 'normal'");
  eq('统计张数 = SQL', summary.body.count, Number(sql.rows[0].n));
  eq('统计含税合计 = SQL', summary.body.amountInclCents, Number(sql.rows[0].incl));
  eq('统计不含税合计 = SQL', summary.body.amountExclCents, Number(sql.rows[0].excl));
  eq('统计税额合计 = SQL', summary.body.taxCents, Number(sql.rows[0].tax));

  const voidRes = await req('POST', `/invoices/${p2.body.id}/void`, { reason: '简化交互作废测试' }, token);
  eq('作废接口仍可用（不受简化影响）', voidRes.status, 201);
  const row2AfterVoid = await orderRow(token, S.o2);
  eq('作废一张后 O2 状态回落到部分开票', row2AfterVoid.invoiceState, 'partial');
  eq('作废一张后 O2 已开票(分)', row2AfterVoid.invoicedCents, 30000);

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
  // 异常时立即退出：避免 pg 连接挂住事件循环导致脚本“假死”不返回
  process.exit(1);
});
