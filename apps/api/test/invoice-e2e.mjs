/**
 * 开票（I16）· 端到端自测脚本（真实 HTTP 接口 + 真实 PostgreSQL 断言 + SQL 复算）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) 客户/产品/订单 → 订单确认（开订单级应收）→ 第一张票（部分开票）→ 订单已开票/未开票断言
 *   2) 第二张票（结清）→ 开票数目统计（张数/含税/不含税/税额 + 按客户/按月）断言
 *   3) 作废一张 → 统计回落、订单可见金额变化、作废记录仍可查、重复作废中文提示
 *   4) 重复发票号 → 中文冲突提示；作废后同号可重开（未作废唯一）
 *   5) 金额三兄弟校验（税额/含税不一致、负数、零、非整数）中文提示
 *   6) 编辑（备注/日期/关联订单可改；金额关键字段拒绝=作废后重开）、超额开票 warning
 *   7) 开票与收款两条线独立：收款核销后订单对账可见已收/未收，且开票统计不受影响
 *   8) 鉴权 401 / 角色 403（workshop 禁写、accounting 可写）
 *   9) 全部关键金额用 SQL 复算核对（张数、含税/不含税/税额合计、三金额恒等式、税额=round(不含税×税率)）
 *
 * 前置：一个连到**空库**的 API 实例（会自动建表 + 种子 admin/Fms@2026），例如：
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_test JWT_SECRET=e2e PORT=3100 node dist/main
 * 运行：node test/invoice-e2e.mjs
 * 环境变量：E2E_BASE（默认 http://127.0.0.1:3100/api）、E2E_PG_*（默认 localhost:15432 / fms_test）
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

/** 断言并打印（中文标签 + 实测值） */
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

/** 逐条断言（assert 失败即记录，不中断后续用例） */
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

/** 与后端 money.ts 同口径：万分点定点 + 整数半进位（脚本独立复算，避免“用被测实现自证”） */
const RATE_SCALE = 10000;
const rateToBp = (rate) => Math.round(rate * RATE_SCALE);
const taxCentsOf = (exclCents, rate) => {
  const p = Math.round(exclCents) * rateToBp(rate);
  const r = p % RATE_SCALE;
  const q = (p - r) / RATE_SCALE;
  return r * 2 >= RATE_SCALE ? q + 1 : q;
};
/** 造一张票的三金额（分）：不含税给定，税率给定，税额/含税由定点算法推出 */
const amountsOf = (exclCents, rate) => {
  const tax = taxCentsOf(exclCents, rate);
  return { amountExclCents: exclCents, taxRate: rate, taxCents: tax, amountInclCents: exclCents + tax };
};

const STATE = {
  customerId: null,
  otherCustomerId: null,
  orderId: null,
  orderNo: '',
  invoice1: null, // 部分开票（有效）
  invoice2: null, // 结清（将被作废）
  invoice3: null, // 超额开票（warning）
  receivableId: null,
};

async function main() {
  console.log('目标接口：' + BASE);
  console.log('测试数据库：' + PG_CONF.host + ':' + PG_CONF.port + '/' + PG_CONF.database);
  const db = new pg.Client(PG_CONF);
  await db.connect();

  // ---------- 鉴权 ----------
  console.log('\n【鉴权】登录与角色');
  const login = await req('POST', '/auth/login', { username: 'admin', password: 'Fms@2026' });
  eq('admin 登录成功', login.status, 200);
  const token = login.body.token;
  ok('拿到 JWT', typeof token === 'string' && token.length > 20);

  // ---------- 主数据 ----------
  console.log('\n【主数据】客户 / 产品 / 订单');
  const cust = await req('POST', '/customers', { name: '开票测试客户甲', creditDays: 30, settlement: 'monthly_30' }, token);
  STATE.customerId = cust.body?.id;
  ok('客户甲已建档（id=' + STATE.customerId + '）', !!STATE.customerId);
  const cust2 = await req('POST', '/customers', { name: '开票测试客户乙' }, token);
  STATE.otherCustomerId = cust2.body?.id;
  const prod = await req('POST', '/products', { name: '开票测试产品ANM', type: 'uk_acetylene' }, token);
  const productId = prod.body?.id;
  ok('产品已建档（id=' + productId + '）', !!productId);

  // 订单：2000 × 4.00 元 = 8000.00 元（800000 分）
  const orderRes = await req('POST', '/orders', {
    customerId: STATE.customerId, poNo: 'PO-INV-001',
    dueDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
    lines: [{ productId, quantity: 2000, unitPrice: 4, currency: 'RMB' }],
  }, token);
  STATE.orderId = orderRes.body?.id;
  STATE.orderNo = orderRes.body?.orderNo;
  ok('订单已创建 ' + STATE.orderNo, !!STATE.orderId);
  const confirm = await req('POST', `/orders/${STATE.orderId}/confirm`, undefined, token);
  eq('订单确认（生成计划单+订单级应收）状态', confirm.status, 201);

  const ORDER_CENTS = 800000; // 8000.00 元
  const recvRow = await db.query(
    "select id, amount, settled_amount from receivables where source_type = 'order' and source_id = $1 and status <> 'voided'",
    [STATE.orderId]);
  STATE.receivableId = recvRow.rows[0]?.id;
  eq('库中订单级应收金额(元)', Number(recvRow.rows[0]?.amount), 8000);
  ok('拿到应收 id=' + STATE.receivableId, !!STATE.receivableId);

  // 订单列表：初始 已开票 0 / 未开票 = 订单金额（实时聚合）
  const list0 = await req('GET', '/orders', undefined, token);
  const order0 = list0.body.find((o) => o.id === STATE.orderId);
  eq('订单列表：订单金额(分)', order0.totalAmountCents, ORDER_CENTS);
  eq('订单列表：初始已开票(分)', order0.invoicedCents, 0);
  eq('订单列表：初始未开票(分)', order0.uninvoicedCents, ORDER_CENTS);

  // ---------- 1) 第一张票：部分开票 ----------
  console.log('\n【开票 1】部分开票（关联订单）');
  // 不含税 3539.82 元 × 13% → 税额 460.18 元 → 含税 4000.00 元（400000 分，恰为订单金额一半）
  const a1 = amountsOf(353982, 0.13);
  eq('脚本自算：税额按 13% 四舍五入（分）', a1.taxCents, 46018);
  eq('脚本自算：含税（分）', a1.amountInclCents, 400000);

  const inv1 = await req('POST', '/invoices', {
    invoiceNo: 'INV-2026-0001', invoiceType: 'vat_special', customerId: STATE.customerId,
    ...a1, issueDate: today(), orderIds: [STATE.orderId], remark: '第一批货款',
  }, token);
  eq('第一张票创建成功', inv1.status, 201);
  STATE.invoice1 = inv1.body;
  eq('返回：不含税(分)', inv1.body.amountExclCents, 353982);
  eq('返回：税额(分)', inv1.body.taxCents, 46018);
  eq('返回：含税(分)', inv1.body.amountInclCents, 400000);
  eq('返回：状态', inv1.body.status, 'normal');
  eq('返回：关联订单号', inv1.body.orderNos, [STATE.orderNo]);
  ok('部分开票不产生 warning', inv1.body.warning === undefined, inv1.body.warning ?? null);

  const st1 = await req('GET', `/invoices/order-status?orderId=${STATE.orderId}`, undefined, token);
  eq('订单进度：订单金额(分)', st1.body.orderAmountCents, ORDER_CENTS);
  eq('订单进度：已开票(分)', st1.body.invoicedCents, 400000);
  eq('订单进度：未开票余额(分)', st1.body.uninvoicedCents, 400000);
  eq('订单进度：未超额', st1.body.overInvoiced, false);
  eq('订单进度：有效发票张数', st1.body.invoiceCount, 1);
  eq('订单进度：已收/未收（此时未收款）', [st1.body.receivedCents, st1.body.unreceivedCents], [0, ORDER_CENTS]);
  eq('订单进度：发票清单张数', st1.body.invoices.length, 1);

  // ---------- 2) 第二张票：结清 ----------
  console.log('\n【开票 2】结清（同订单再开一张）');
  const a2 = amountsOf(353982, 0.13);
  const inv2 = await req('POST', '/invoices', {
    invoiceNo: 'INV-2026-0002', invoiceType: 'vat_general', customerId: STATE.customerId,
    ...a2, issueDate: today(), orderIds: [STATE.orderId], remark: '第二张（将作废）',
  }, token);
  eq('第二张票创建成功', inv2.status, 201);
  STATE.invoice2 = inv2.body;

  const st2 = await req('GET', `/invoices/order-status?orderId=${STATE.orderId}`, undefined, token);
  eq('结清后：已开票(分)', st2.body.invoicedCents, 800000);
  eq('结清后：未开票余额(分)', st2.body.uninvoicedCents, 0);
  eq('结清后：发票张数', st2.body.invoiceCount, 2);

  // ---------- 开票数目统计 ----------
  console.log('\n【开票数目】统计接口 + SQL 复算');
  const sum1 = await req('GET', '/invoices/summary', undefined, token);
  eq('统计：张数', sum1.body.count, 2);
  eq('统计：不含税合计(分)', sum1.body.amountExclCents, 353982 * 2);
  eq('统计：税额合计(分)', sum1.body.taxCents, 46018 * 2);
  eq('统计：含税合计(分)', sum1.body.amountInclCents, 800000);

  const sqlTotals = await db.query(
    "select count(*)::int as n, coalesce(sum(amount_excl_cents),0)::bigint as excl,"
    + " coalesce(sum(tax_cents),0)::bigint as tax, coalesce(sum(amount_incl_cents),0)::bigint as incl"
    + " from invoices where status = 'normal'");
  const sq = sqlTotals.rows[0];
  eq('SQL 复算：有效发票张数', Number(sq.n), sum1.body.count);
  eq('SQL 复算：不含税合计(分)', Number(sq.excl), sum1.body.amountExclCents);
  eq('SQL 复算：税额合计(分)', Number(sq.tax), sum1.body.taxCents);
  eq('SQL 复算：含税合计(分)', Number(sq.incl), sum1.body.amountInclCents);

  const sqlIdentity = await db.query(
    "select count(*)::int as bad from invoices"
    + " where amount_incl_cents <> amount_excl_cents + tax_cents"
    + " or tax_cents <> round(amount_excl_cents * tax_rate)"
    + " or amount_excl_cents < 0 or tax_cents < 0 or amount_incl_cents < 0 or amount_incl_cents <= 0");
  eq('SQL 复算：三金额恒等式 + 非负 + 含税>0 全部成立（违规行数）', Number(sqlIdentity.rows[0].bad), 0);

  const byCust = await db.query(
    "select c.name, count(*)::int as n, coalesce(sum(i.amount_incl_cents),0)::bigint as incl"
    + " from invoices i join customers c on c.id = i.customer_id where i.status = 'normal'"
    + " group by c.name order by c.name");
  eq('统计按客户：行数与 SQL 一致', sum1.body.byCustomer.length, byCust.rows.length);
  eq('统计按客户：客户甲含税合计(分)', Number(byCust.rows[0]?.incl), sum1.body.byCustomer[0].amountInclCents);
  const byMonth = await db.query(
    "select to_char(issue_date,'YYYY-MM') as m, count(*)::int as n, coalesce(sum(amount_incl_cents),0)::bigint as incl"
    + " from invoices where status = 'normal' group by 1 order by 1");
  eq('统计按月：月份条目数与 SQL 一致', sum1.body.byMonth.length, byMonth.rows.length);
  eq('统计按月：本月含税合计(分)', sum1.body.byMonth[0].amountInclCents, Number(byMonth.rows[0]?.incl));

  const sumToday = await req('GET', `/invoices/summary?from=${today()}&to=${today()}`, undefined, token);
  eq('统计：按开票日期区间（今天）张数', sumToday.body.count, 2);
  const sumFuture = await req('GET', '/invoices/summary?from=2099-01-01', undefined, token);
  eq('统计：未来区间张数=0', sumFuture.body.count, 0);

  // ---------- 3) 作废 ----------
  console.log('\n【作废】置状态留痕（不物理删除、不计入统计、记录可查）');
  const void1 = await req('POST', `/invoices/${STATE.invoice2.id}/void`, { reason: '开错客户，需重开' }, token);
  eq('作废接口成功', void1.status, 201);
  eq('作废后状态', void1.body.status, 'voided');
  eq('作废原因已留痕', void1.body.voidReason, '开错客户，需重开');
  ok('作废时间已留痕', !!void1.body.voidedAt, void1.body.voidedAt);

  const voidAgain = await req('POST', `/invoices/${STATE.invoice2.id}/void`, { reason: '重复作废' }, token);
  eq('重复作废 → 400', voidAgain.status, 400);
  ok('重复作废中文提示', String(voidAgain.body.message).includes('已作废'), voidAgain.body.message);

  const voidNoReason = await req('POST', `/invoices/${STATE.invoice1.id}/void`, {}, token);
  eq('缺少作废原因 → 400', voidNoReason.status, 400);
  ok('缺原因中文提示', JSON.stringify(voidNoReason.body.message).includes('作废原因'), voidNoReason.body.message);

  const sum2 = await req('GET', '/invoices/summary', undefined, token);
  eq('作废后统计：张数', sum2.body.count, 1);
  eq('作废后统计：含税合计(分)', sum2.body.amountInclCents, 400000);
  eq('作废后统计：税额合计(分)', sum2.body.taxCents, 46018);

  const st3 = await req('GET', `/invoices/order-status?orderId=${STATE.orderId}`, undefined, token);
  eq('作废后订单进度：已开票(分)', st3.body.invoicedCents, 400000);
  eq('作废后订单进度：未开票余额(分)', st3.body.uninvoicedCents, 400000);
  eq('作废后订单进度：有效张数/作废张数', [st3.body.invoiceCount, st3.body.voidedCount], [1, 1]);

  const listVoided = await req('GET', '/invoices?status=voided&page=1&pageSize=50', undefined, token);
  eq('作废记录仍在（可按状态查）', listVoided.body.items.length, 1);
  eq('作废记录票号', listVoided.body.items[0].invoiceNo, 'INV-2026-0002');
  eq('作废记录仍在库中（未被物理删除）', Number((await db.query('select count(*)::int as n from invoices where id = $1', [STATE.invoice2.id])).rows[0].n), 1);

  const sqlVoided = await db.query("select count(*)::int as n from invoices where status = 'voided'");
  eq('SQL 复算：作废发票数', Number(sqlVoided.rows[0].n), 1);

  // ---------- 4) 发票号唯一 ----------
  console.log('\n【唯一性】重复票号中文提示 + 作废后同号可重开');
  const dup = await req('POST', '/invoices', {
    invoiceNo: 'INV-2026-0001', invoiceType: 'electronic', customerId: STATE.customerId, ...amountsOf(10000, 0.13),
  }, token);
  eq('重复票号（未作废）→ 400', dup.status, 400);
  ok('重复票号中文提示含票号与「未作废」', String(dup.body.message).includes('INV-2026-0001') && String(dup.body.message).includes('已存在（未作废）'), dup.body.message);

  const reopen = await req('POST', '/invoices', {
    invoiceNo: 'INV-2026-0002', invoiceType: 'electronic', customerId: STATE.customerId,
    ...amountsOf(10000, 0.13), issueDate: today(), orderIds: [STATE.orderId], remark: '原票作废后重开',
  }, token);
  eq('作废后同号可重开（未作废范围唯一）', reopen.status, 201);
  eq('重开票状态', reopen.body.status, 'normal');
  STATE.invoice3 = reopen.body;
  const dupAfterReopen = await req('POST', '/invoices', {
    invoiceNo: 'INV-2026-0002', invoiceType: 'electronic', customerId: STATE.customerId, ...amountsOf(10000, 0.13),
  }, token);
  eq('重开后再次重复同号 → 400', dupAfterReopen.status, 400);

  // ---------- 5) 金额三兄弟校验 ----------
  console.log('\n【金额校验】三兄弟恒等式（中文提示含字段/期望/实际）');
  const badTax = await req('POST', '/invoices', {
    invoiceNo: 'INV-BAD-TAX', invoiceType: 'other', customerId: STATE.customerId,
    amountExclCents: 10000, taxRate: 0.13, taxCents: 1200, amountInclCents: 11200,
  }, token);
  eq('税额与税率不一致 → 400', badTax.status, 400);
  ok('税额提示含期望与实际', String(badTax.body.message).includes('税额') && String(badTax.body.message).includes('1300 分') && String(badTax.body.message).includes('1200 分'), badTax.body.message);

  const badIncl = await req('POST', '/invoices', {
    invoiceNo: 'INV-BAD-INCL', invoiceType: 'other', customerId: STATE.customerId,
    amountExclCents: 10000, taxRate: 0.13, taxCents: 1300, amountInclCents: 11200,
  }, token);
  eq('含税 ≠ 不含税 + 税额 → 400', badIncl.status, 400);
  ok('含税提示含期望与实际', String(badIncl.body.message).includes('含税金额') && String(badIncl.body.message).includes('11300 分') && String(badIncl.body.message).includes('11200 分'), badIncl.body.message);

  const neg = await req('POST', '/invoices', {
    invoiceNo: 'INV-BAD-NEG', invoiceType: 'other', customerId: STATE.customerId,
    amountExclCents: -100, taxRate: 0.13,
  }, token);
  eq('负数金额 → 400', neg.status, 400);
  ok('负数中文提示', String(neg.body.message).includes('不能为负'), neg.body.message);

  const zero = await req('POST', '/invoices', {
    invoiceNo: 'INV-BAD-ZERO', invoiceType: 'other', customerId: STATE.customerId,
    amountExclCents: 0, taxRate: 0,
  }, token);
  eq('含税金额为 0 → 400', zero.status, 400);
  ok('零金额中文提示', String(zero.body.message).includes('必须大于 0'), zero.body.message);

  const frac = await req('POST', '/invoices', {
    invoiceNo: 'INV-BAD-FRAC', invoiceType: 'other', customerId: STATE.customerId,
    amountExclCents: 100.5, taxRate: 0.13,
  }, token);
  eq('非整数「分」→ 400', frac.status, 400);
  ok('非整数中文提示', String(frac.body.message).includes('整数'), frac.body.message);

  const badRate = await req('POST', '/invoices', {
    invoiceNo: 'INV-BAD-RATE', invoiceType: 'other', customerId: STATE.customerId,
    amountExclCents: 10000, taxRate: 13,
  }, token);
  eq('税率越界（13 当 13%）→ 400', badRate.status, 400);
  ok('税率中文提示', String(badRate.body.message).includes('0 ~ 1'), badRate.body.message);

  const noNo = await req('POST', '/invoices', {
    invoiceNo: '', invoiceType: 'other', customerId: STATE.customerId, ...amountsOf(10000, 0.13),
  }, token);
  eq('票号缺失 → 400', noNo.status, 400);
  ok('票号中文提示', JSON.stringify(noNo.body.message).includes('发票号码'), noNo.body.message);

  // ---------- 6) 编辑 ----------
  console.log('\n【编辑】非金额字段可改 / 金额关键字段拒绝');
  const edited = await req('PUT', `/invoices/${STATE.invoice1.id}`, {
    remark: '改后备注：第一批货款（改）', issueDate: today(), orderIds: [STATE.orderId],
  }, token);
  eq('编辑备注/日期/关联订单成功', edited.status, 200);
  eq('编辑后备注', edited.body.remark, '改后备注：第一批货款（改）');
  eq('编辑后金额未变（分）', [edited.body.amountExclCents, edited.body.taxCents, edited.body.amountInclCents], [353982, 46018, 400000]);

  const a09 = amountsOf(353982, 0.09); // 3539.82 元 × 9% → 税额 318.58 元、含税 3858.40 元
  const editRate = await req('PUT', `/invoices/${STATE.invoice1.id}`, { taxRate: a09.taxRate, taxCents: a09.taxCents, amountInclCents: a09.amountInclCents }, token);
  eq('改税率（服务端按定点助手重算税额/含税）成功', editRate.status, 200);
  eq('改税率后：税额(分)', editRate.body.taxCents, a09.taxCents);
  eq('改税率后：含税(分)', editRate.body.amountInclCents, a09.amountInclCents);
  // 还原为 13%，保证后续统计断言口径一致
  const restore = await req('PUT', `/invoices/${STATE.invoice1.id}`, { taxRate: 0.13, taxCents: 46018, amountInclCents: 400000 }, token);
  eq('税率还原 13% 成功', restore.status, 200);
  eq('还原后含税(分)', restore.body.amountInclCents, 400000);

  const editAmount = await req('PUT', `/invoices/${STATE.invoice1.id}`, { amountExclCents: 999999 }, token);
  eq('改不含税金额 → 400', editAmount.status, 400);
  ok('金额不可改中文提示（作废后重开）', String(editAmount.body.message).includes('请先作废') && String(editAmount.body.message).includes('重新开票'), editAmount.body.message);

  const editVoided = await req('PUT', `/invoices/${STATE.invoice2.id}`, { remark: 'x' }, token);
  eq('编辑已作废发票 → 400', editVoided.status, 400);
  ok('已作废不可改中文提示', String(editVoided.body.message).includes('已作废'), editVoided.body.message);

  const editRateBad = await req('PUT', `/invoices/${STATE.invoice1.id}`, { taxRate: 0.13, taxCents: 9999 }, token);
  eq('编辑时税额与税率不一致 → 400', editRateBad.status, 400);
  ok('编辑税额提示含期望与实际', String(editRateBad.body.message).includes('46018') && String(editRateBad.body.message).includes('9999'), editRateBad.body.message);

  // ---------- 7) 超额开票 warning（不阻断） ----------
  console.log('\n【超额开票】提示但不阻断');
  // 动态取「当前未开票余额」→ 再开一张约为其 2 倍的票，必然超额（作废票不计入，故不能写死金额）
  const beforeOver = await req('GET', `/invoices/order-status?orderId=${STATE.orderId}`, undefined, token);
  const overExcl = Math.max(10000, beforeOver.body.uninvoicedCents * 2);
  const over = await req('POST', '/invoices', {
    invoiceNo: 'INV-2026-0003', invoiceType: 'vat_general', customerId: STATE.customerId,
    ...amountsOf(overExcl, 0.13), issueDate: today(), orderIds: [STATE.orderId], remark: '超额测试',
  }, token);
  eq('超额开票仍创建成功（业务弹性）', over.status, 201);
  ok('返回 warning 说明超额', typeof over.body.warning === 'string' && over.body.warning.includes('超出订单金额'), over.body.warning);
  const stOver = await req('GET', `/invoices/order-status?orderId=${STATE.orderId}`, undefined, token);
  eq('订单进度：已超额标记', stOver.body.overInvoiced, true);
  eq('订单进度：未开票余额不为负', stOver.body.uninvoicedCents, 0);
  ok('订单进度：warning 与超额一致', String(stOver.body.warning).includes('超出'), stOver.body.warning);
  // 作废该超额票，恢复确定口径
  const voidOver = await req('POST', `/invoices/${over.body.id}/void`, { reason: '超额测试票，作废' }, token);
  eq('超额票作废成功', voidOver.status, 201);
  const overVoided = await req('POST', `/invoices/${over.body.id}/void`, { reason: '再作废' }, token);
  eq('超额票重复作废 → 400', overVoided.status, 400);

  // ---------- 8) 关联订单校验 ----------
  console.log('\n【关联订单】跨客户 / 不存在');
  const cross = await req('POST', '/invoices', {
    invoiceNo: 'INV-CROSS', invoiceType: 'other', customerId: STATE.otherCustomerId,
    ...amountsOf(10000, 0.13), orderIds: [STATE.orderId],
  }, token);
  eq('关联他人订单 → 400', cross.status, 400);
  ok('跨客户中文提示', String(cross.body.message).includes('不一致'), cross.body.message);

  const missing = await req('POST', '/invoices', {
    invoiceNo: 'INV-MISSING', invoiceType: 'other', customerId: STATE.customerId,
    ...amountsOf(10000, 0.13), orderIds: [999999],
  }, token);
  eq('关联不存在订单 → 400', missing.status, 400);
  ok('订单不存在中文提示', String(missing.body.message).includes('关联订单不存在'), missing.body.message);

  const badOrderQuery = await req('GET', '/invoices/order-status?orderId=abc', undefined, token);
  eq('orderId 非法 → 400', badOrderQuery.status, 400);
  const notFoundOrder = await req('GET', '/invoices/order-status?orderId=999999', undefined, token);
  eq('订单不存在 → 404', notFoundOrder.status, 404);

  // ---------- 9) 开票与收款两条线独立 ----------
  console.log('\n【两条线】收款核销不影响开票统计；订单对账同屏可见');
  const sumBeforeCollect = await req('GET', '/invoices/summary', undefined, token);
  const collect = await req('POST', '/collection-slips', {
    partyId: STATE.customerId, mode: 'settle', amount: 3000,
    lines: [{ id: STATE.receivableId, amount: 3000 }], note: '收款（与开票无关）',
  }, token);
  eq('收款核销成功（既有逻辑未被改动）', collect.status, 201);
  const stPaid = await req('GET', `/invoices/order-status?orderId=${STATE.orderId}`, undefined, token);
  eq('订单对账：已收款(分)', stPaid.body.receivedCents, 300000);
  eq('订单对账：未收(分)', stPaid.body.unreceivedCents, 500000);
  const sumAfterCollect = await req('GET', '/invoices/summary', undefined, token);
  eq('收款后开票统计：张数不变', sumAfterCollect.body.count, sumBeforeCollect.body.count);
  eq('收款后开票统计：含税合计不变(分)', sumAfterCollect.body.amountInclCents, sumBeforeCollect.body.amountInclCents);

  // ---------- 10) 列表筛选 / 分页 / 关键字 ----------
  console.log('\n【列表】筛选 / 分页 / 关键字');
  const pageAll = await req('GET', '/invoices?page=1&pageSize=2', undefined, token);
  eq('分页：每页 2 条', pageAll.body.items.length, 2);
  const sqlInvCount = await db.query('select count(*)::int as n from invoices');
  eq('分页：total 覆盖全部（含作废，= SQL 计数）', pageAll.body.total, Number(sqlInvCount.rows[0].n));
  const byCustomer = await req('GET', `/invoices?customerId=${STATE.customerId}`, undefined, token);
  ok('按客户筛选全部命中', byCustomer.body.items.every((i) => i.customerId === STATE.customerId), byCustomer.body.items.length);
  const byStatus = await req('GET', '/invoices?status=voided', undefined, token);
  ok('按状态筛选：全部为已作废', byStatus.body.items.length > 0 && byStatus.body.items.every((i) => i.status === 'voided'), byStatus.body.items.length);
  const byKw = await req('GET', '/invoices?keyword=INV-2026-0001', undefined, token);
  eq('按票号关键字命中 1 张', byKw.body.items.length, 1);
  const byOrder = await req('GET', `/invoices?orderId=${STATE.orderId}`, undefined, token);
  ok('按订单筛选：命中挂在该订单上的发票', byOrder.body.items.length >= 2, byOrder.body.items.length);
  const sqlJunction = await db.query('select count(*)::int as n from invoice_orders where order_id = $1', [STATE.orderId]);
  eq('SQL 复算：该订单的发票关联行数（含作废）', Number(sqlJunction.rows[0].n), byOrder.body.total);

  // ---------- 11) 鉴权 / 权限 ----------
  console.log('\n【权限】401 与 403（读开放、写限 admin/accounting）');
  const anonList = await req('GET', '/invoices');
  eq('未登录读列表 → 401', anonList.status, 401);
  const anonCreate = await req('POST', '/invoices', { invoiceNo: 'X', invoiceType: 'other', customerId: STATE.customerId, amountExclCents: 100, taxRate: 0 });
  eq('未登录新建 → 401', anonCreate.status, 401);
  const anonVoid = await req('POST', `/invoices/${STATE.invoice1.id}/void`, { reason: 'x' });
  eq('未登录作废 → 401', anonVoid.status, 401);

  await req('POST', '/users', { username: 'invworkshop', password: 'Ws@20261x', displayName: '车间开票测试', role: 'workshop' }, token);
  await req('POST', '/users', { username: 'invaccount', password: 'Ac@20261x', displayName: '账务开票测试', role: 'accounting' }, token);
  const wsToken = (await req('POST', '/auth/login', { username: 'invworkshop', password: 'Ws@20261x' })).body.token;
  const acToken = (await req('POST', '/auth/login', { username: 'invaccount', password: 'Ac@20261x' })).body.token;
  ok('workshop / accounting 测试账号已就绪', !!wsToken && !!acToken);

  const wsRead = await req('GET', '/invoices', undefined, wsToken);
  eq('workshop 可读发票列表（读操作登录即可）', wsRead.status, 200);
  const wsCreate = await req('POST', '/invoices', {
    invoiceNo: 'INV-WS-FORBID', invoiceType: 'other', customerId: STATE.customerId, ...amountsOf(10000, 0.13),
  }, wsToken);
  eq('workshop 新建 → 403', wsCreate.status, 403);
  ok('403 中文原因含所需角色', String(wsCreate.body.message).includes('需要'), wsCreate.body.message);
  const wsVoid = await req('POST', `/invoices/${STATE.invoice1.id}/void`, { reason: '越权作废' }, wsToken);
  eq('workshop 作废 → 403', wsVoid.status, 403);
  const wsEdit = await req('PUT', `/invoices/${STATE.invoice1.id}`, { remark: '越权编辑' }, wsToken);
  eq('workshop 编辑 → 403', wsEdit.status, 403);
  const wsSummary = await req('GET', '/invoices/summary', undefined, wsToken);
  eq('workshop 可读开票数目', wsSummary.status, 200);

  const acCreate = await req('POST', '/invoices', {
    invoiceNo: 'INV-AC-0001', invoiceType: 'electronic', customerId: STATE.customerId,
    ...amountsOf(50000, 0.06), issueDate: today(), remark: '账务角色开票',
  }, acToken);
  eq('accounting 新建 → 201（权限矩阵：开票写操作 admin/accounting）', acCreate.status, 201);
  const acVoid = await req('POST', `/invoices/${acCreate.body.id}/void`, { reason: '账务角色作废测试' }, acToken);
  eq('accounting 作废 → 201', acVoid.status, 201);

  // ---------- 12) 收尾 SQL 复算 ----------
  console.log('\n【SQL 复算】最终口径与接口一致');
  const finalApi = await req('GET', '/invoices/summary', undefined, token);
  const finalSql = await db.query(
    "select count(*)::int as n, coalesce(sum(amount_incl_cents),0)::bigint as incl,"
    + " coalesce(sum(amount_excl_cents),0)::bigint as excl, coalesce(sum(tax_cents),0)::bigint as tax"
    + " from invoices where status = 'normal'");
  eq('最终：有效张数（接口=SQL）', finalApi.body.count, Number(finalSql.rows[0].n));
  eq('最终：含税合计（接口=SQL）', finalApi.body.amountInclCents, Number(finalSql.rows[0].incl));
  eq('最终：不含税合计（接口=SQL）', finalApi.body.amountExclCents, Number(finalSql.rows[0].excl));
  eq('最终：税额合计（接口=SQL）', finalApi.body.taxCents, Number(finalSql.rows[0].tax));
  const orderInvSql = await db.query(
    "select coalesce(sum(i.amount_incl_cents),0)::bigint as incl, count(*)::int as n"
    + " from invoice_orders io join invoices i on i.id = io.invoice_id"
    + " where io.order_id = $1 and i.status = 'normal'", [STATE.orderId]);
  const finalOrder = await req('GET', `/invoices/order-status?orderId=${STATE.orderId}`, undefined, token);
  eq('最终：订单已开票（接口=SQL）', finalOrder.body.invoicedCents, Number(orderInvSql.rows[0].incl));
  eq('最终：订单发票张数（接口=SQL）', finalOrder.body.invoiceCount, Number(orderInvSql.rows[0].n));
  const orphan = await db.query(
    'select count(*)::int as n from invoices i where not exists (select 1 from invoice_orders io where io.invoice_id = i.id)');
  ok('未关联订单的发票允许存在（SQL 计数）', Number(orphan.rows[0].n) >= 1, Number(orphan.rows[0].n));

  await db.end();
  console.log('\n================ 结果 ================');
  console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
  if (failCount) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
}

/** 本地业务日 YYYY-MM-DD（与 API 容器的 TZ=Asia/Shanghai 口径一致） */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

main().catch((e) => {
  console.error('自测脚本异常中断：', e);
  process.exitCode = 1;
});
