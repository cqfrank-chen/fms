/**
 * 订单列表排序 路 端到端自测脚本（真实 HTTP 接口 + 真实 PostgreSQL 断言）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) 默认排序 = 交期 DESC，且「交期待定」的哨兵日单据（2099-12-31 + due_date_tbd）
 *      被当成「无交期」恒定排在**最后**（同级再按创建时间 DESC）；
 *   2) 多列组合排序：客户 ASC + 交期 DESC、状态 ASC、开票状态 ASC、订单金额 DESC、
 *      已开票金额 DESC、待补项数量 ASC、产品行数 ASC、订单号 ASC、PO 号 ASC（空 PO 沉底）、
 *      创建时间 ASC/DESC 各自可用，并与**独立 SQL** 复算的顺序逐条一致；
 *   3) 非法 sort 字段 / 非法方向 / 格式错误 → 400 中文提示；
 *   4) 与既有力不冲突：待补筛选（hasPending）、状态筛选、摘要+展开明细的数据（lines）、
 *      占位档案开关（includePlaceholders）、开票派生列（invoiceState/uninvoicedCents）都还在。
 *
 * 前置：一个连到**空库**的 API 实例（会自建表 + 种子 admin/Fms@2026）：
 *   ⑥ 排序口径：默认 = 交期降序（不传 sort ≡ 空 sort ≡ sort=dueDate:desc）、
 *      单键可反复切换升/降序、第三次点击取消后回到默认（含前端状态机纯函数的真跑与静态核对）
 *
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_orders_sort JWT_SECRET=e2e \
 *   PORT=3100 node dist/main
 * 运行：node test/order-sort-e2e.mjs
 * 环境变量：E2E_BASE（默认 http://127.0.0.1:3100/api）、E2E_PG_*（默认 localhost:15432 fms/fms/fms_orders_sort）
 *
 * 说明：为让「同交期 → 创建时间 DESC」的断言完全确定（毫秒级同刻不抖动），
 * 造数后会用 SQL 给 5 张订单写入**显式**的 created_at（见 CREATED_AT），
 * 这也是本用例唯一一处直接改库造数的地方。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3100/api';
const PG_CONF = {
  host: process.env.E2E_PG_HOST ?? 'localhost',
  port: Number(process.env.E2E_PG_PORT ?? 15432),
  user: process.env.E2E_PG_USER ?? 'fms',
  password: process.env.E2E_PG_PASSWORD ?? 'fms',
  database: process.env.E2E_PG_DB ?? 'fms_orders_sort',
};

/** 哨兵日（与 apps/api/src/db/schema.ts 的 ORDERS_DUE_DATE_TBD 一致） */
const TBD_SENTINEL = '2099-12-31';

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

/** 逐条断言（assert 失败即抛出，由捕获统一记录） */
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

/** 列表接口：带 sort 的 GET /orders */
const listOrders = (token, query = '') => req('GET', '/orders' + (query ? '?' + query : ''), undefined, token);

/** 造数：显式 created_at（ISO 串）—— 见文件头说明 */
const CREATED_AT = {
  oA1: '2026-01-01T00:00:00.000Z',
  oA2: '2026-01-02T00:00:00.000Z',
  oB1: '2026-01-03T00:00:00.000Z',
  oB2: '2026-01-04T00:00:00.000Z',
  oA3: '2026-01-05T00:00:00.000Z',
};

async function main() {
  console.log('目标接口：' + BASE);
  console.log('测试数据库：' + PG_CONF.host + ':' + PG_CONF.port + '/' + PG_CONF.database);
  const db = new pg.Client(PG_CONF);
  await db.connect();

  // ---------- 登录 ----------
  console.log('\n【鉴权】登录 admin');
  const login = await req('POST', '/auth/login', { username: 'admin', password: 'Fms@2026' });
  eq('admin 登录成功', login.status, 200);
  const token = login.body.token;
  ok('拿到 JWT', typeof token === 'string' && token.length > 20);

  // ---------- 主数据 ----------
  console.log('\n【主数据】两个客户（名字前缀相同，只有末位 A/B 不同，排序结果不受 collation 影响）+ 一个产品');
  const custA = await req('POST', '/customers', { name: '排序客户A', creditDays: 30 }, token);
  const custB = await req('POST', '/customers', { name: '排序客户B', creditDays: 30 }, token);
  const customerA = custA.body.id;
  const customerB = custB.body.id;
  ok('客户「排序客户A」「排序客户B」已建档', !!customerA && !!customerB, [customerA, customerB]);
  const prod = await req('POST', '/products', { name: '排序测试产品', type: 'uk_acetylene', safetyStock: 0 }, token);
  const productId = prod.body.id;
  ok('产品「排序测试产品」已建档', !!productId, productId);

  // ---------- 造 5 张订单 ----------
  console.log('\n【造数】5 张订单：交期 3 档 + 2 张「缺交期草稿」（哨兵日 + due_date_tbd）');
  const createOrder = (customerId, poNo, dueDate, lines) =>
    req('POST', '/orders', { customerId, poNo, dueDate, lines }, token);

  // oA1：客户A / 2026-03-10 / 1 行 / 金额 1000 分
  const oA1 = (await createOrder(customerA, 'PO-SORT-A1', '2026-03-10', [
    { productId, quantity: 10, unitPrice: 1.00, currency: 'CNY' },
  ])).body;
  // oA2：客户A / 2026-09-20 / 2 行 / 金额 12000 分（最大）
  const oA2 = (await createOrder(customerA, 'PO-SORT-A2', '2026-09-20', [
    { productId, quantity: 20, unitPrice: 5.00, currency: 'CNY' },
    { productId, quantity: 10, unitPrice: 2.00, currency: 'CNY' },
  ])).body;
  // oB1：客户B / 2026-06-15 / 1 行 / 金额 4500 分（随后开票 2000 分 → 部分开票）
  const oB1 = (await createOrder(customerB, 'PO-SORT-B1', '2026-06-15', [
    { productId, quantity: 30, unitPrice: 1.50, currency: 'CNY' },
  ])).body;
  ok('三张普通订单已建（草稿）', [oA1.id, oA2.id, oB1.id].every((x) => !!x), [oA1.id, oA2.id, oB1.id]);

  // oB2：客户B / **缺交期**（落草稿：哨兵日 + due_date_tbd=true）/ 无 PO 号由 oA3 覆盖，这里给 PO
  const oB2 = (await req('POST', '/orders/draft', {
    customerId: customerB,
    poNo: 'PO-SORT-B2',
    lines: [{ productId, quantity: 5, unitPrice: 1.00, currency: 'CNY' }],
  }, token)).body;
  // oA3：客户A / **缺交期** / **无 PO 号**（验证 NULL/空值沉底）
  const oA3 = (await req('POST', '/orders/draft', {
    customerId: customerA,
    lines: [{ productId, quantity: 7, unitPrice: 1.00, currency: 'CNY' }],
  }, token)).body;
  ok('两张「缺交期草稿」已建', [oB2.id, oA3.id].every((x) => !!x), [oB2.id, oA3.id]);
  eq('缺交期草稿状态 = 草稿', [oB2.status, oA3.status], ['draft', 'draft']);
  eq('缺交期草稿带 due_date_tbd 标记', [oB2.dueDateTbd, oA3.dueDateTbd], [true, true]);
  eq('缺交期草稿的单头待补项', (oB2.pendingItems ?? []).map((x) => x.code), ['due_date_missing']);

  const ids = { oA1: oA1.id, oA2: oA2.id, oB1: oB1.id, oB2: oB2.id, oA3: oA3.id };
  const ourIds = Object.values(ids);

  // SQL 核对：哨兵日确实落库为 2099-12-31（排序把它当「无交期」的依据）
  const sentinel = await db.query(
    "select due_date_tbd, to_char(due_date at time zone 'UTC', 'YYYY-MM-DD') as d from orders where id = $1",
    [ids.oB2]);
  eq('SQL：缺交期草稿 due_date_tbd', sentinel.rows[0].due_date_tbd, true);
  eq('SQL：缺交期草稿 due_date = 哨兵日', sentinel.rows[0].d, TBD_SENTINEL);

  // 显式 created_at（让「同级按创建时间 DESC」可确定性断言）
  for (const [k, v] of Object.entries(CREATED_AT)) {
    await db.query('update orders set created_at = $1 where id = $2', [v, ids[k]]);
  }
  const ca = await db.query('select id, created_at from orders where id = any($1::int[]) order by id', [ourIds]);
  eq('SQL：5 张订单 created_at 已显式写入（毫秒级可分辨）', ca.rows.length, 5);

  // ---------- 1) 默认排序 = 交期 DESC，哨兵日沉底 ----------
  console.log('\n【1】默认排序 = 交期 DESC（「交期待定」= 无交期，恒定沉底）');
  const EXPECT_DUE_DESC = [ids.oA2, ids.oB1, ids.oA1, ids.oA3, ids.oB2];
  const noSort = await listOrders(token);
  eq('不带 sort → 200', noSort.status, 200);
  const idsOf = (rows, wanted) => rows.filter((r) => wanted.includes(r.id)).map((r) => r.id);
  eq('默认顺序：交期大的在前，两张待定交期排最后（同级按创建时间 DESC）',
    idsOf(noSort.body, ourIds), EXPECT_DUE_DESC);
  // 全量口径：待定交期必须在所有真实交期之后
  const allTbd = noSort.body.filter((r) => r.dueDateTbd);
  const firstTbdAt = noSort.body.findIndex((r) => r.dueDateTbd);
  eq('全量：首个「待定交期」出现在「真实交期全部之后」的位置（= 总数 − 待定数）',
    firstTbdAt, noSort.body.length - allTbd.length);
  ok('全量：末尾 N 条全是待定交期（N = 待定单数）',
    allTbd.length > 0 && noSort.body.slice(-allTbd.length).every((r) => r.dueDateTbd),
    noSort.body.map((r) => (r.dueDateTbd ? 'TBD' : String(r.dueDate).slice(0, 10))));

  const explicitDefault = await listOrders(token, 'sort=dueDate:desc');
  eq('sort=dueDate:desc 与缺省排序完全一致', idsOf(explicitDefault.body, ourIds), EXPECT_DUE_DESC);

  // SQL 复算默认顺序（独立写一遍 ORDER BY，含哨兵判定）
  const sqlDueDesc = await db.query(
    "select o.id from orders o where o.id = any($1::int[])"
    + " order by (o.due_date_tbd or o.due_date >= timestamptz '2099-12-31T00:00:00Z') asc,"
    + ' o.due_date desc, o.created_at desc, o.id desc', [ourIds]);
  eq('SQL 核对：默认排序（交期 DESC / 待定沉底 / 创建时间 DESC）',
    sqlDueDesc.rows.map((r) => r.id), EXPECT_DUE_DESC);
  eq('接口顺序 = SQL 顺序', idsOf(noSort.body, ourIds), sqlDueDesc.rows.map((r) => r.id));

  const dueAsc = await listOrders(token, 'sort=dueDate:asc');
  eq('交期 ASC：真实交期升序，待定交期仍在最后',
    idsOf(dueAsc.body, ourIds), [ids.oA1, ids.oB1, ids.oA2, ids.oA3, ids.oB2]);
  const sqlDueAsc = await db.query(
    "select o.id from orders o where o.id = any($1::int[])"
    + " order by (o.due_date_tbd or o.due_date >= timestamptz '2099-12-31T00:00:00Z') asc,"
    + ' o.due_date asc, o.created_at desc, o.id desc', [ourIds]);
  eq('SQL 核对：交期 ASC（待定同样沉底）', sqlDueAsc.rows.map((r) => r.id),
    [ids.oA1, ids.oB1, ids.oA2, ids.oA3, ids.oB2]);

  // ---------- 2) 多列组合排序 ----------
  console.log('\n【2】多列组合排序（先从第一键比较，相等再看下一键）');
  const combo = await listOrders(token, 'sort=customer:asc,dueDate:desc');
  eq('客户 ASC + 交期 DESC：客户A 组在前（组内交期 DESC、待定垫底），再客户B 组',
    idsOf(combo.body, ourIds), [ids.oA2, ids.oA1, ids.oA3, ids.oB1, ids.oB2]);
  const sqlCombo = await db.query(
    'select o.id from orders o join customers c on c.id = o.customer_id where o.id = any($1::int[])'
    + " order by (c.name is null or btrim(c.name) = '') asc, c.name collate \"C\" asc,"
    + " (o.due_date_tbd or o.due_date >= timestamptz '2099-12-31T00:00:00Z') asc,"
    + ' o.due_date desc, o.created_at desc, o.id desc', [ourIds]);
  eq('SQL 核对：客户 ASC + 交期 DESC', sqlCombo.rows.map((r) => r.id),
    [ids.oA2, ids.oA1, ids.oA3, ids.oB1, ids.oB2]);

  // 三键组合：客户 ASC + 状态 ASC + 交期 DESC（oB1 先确认 → 客户B 组内 confirmed 排在 draft 之后）
  const confirmB1 = await req('POST', '/orders/' + ids.oB1 + '/confirm', undefined, token);
  ok('确认 oB1（造出「已确认」状态，用于状态排序）', confirmB1.status >= 200 && confirmB1.status < 300, confirmB1.status);
  const three = await listOrders(token, 'sort=customer:asc,status:asc,dueDate:desc');
  const sqlThree = await db.query(
    'select o.id from orders o join customers c on c.id = o.customer_id where o.id = any($1::int[])'
    + " order by (c.name is null or btrim(c.name) = '') asc, c.name collate \"C\" asc,"
    + " case o.status when 'draft' then 1 when 'confirmed' then 2 when 'production' then 3"
    + " when 'completed' then 4 when 'cancelled' then 5 else 99 end asc,"
    + " (o.due_date_tbd or o.due_date >= timestamptz '2099-12-31T00:00:00Z') asc,"
    + ' o.due_date desc, o.created_at desc, o.id desc', [ourIds]);
  eq('SQL 核对：客户 ASC + 状态 ASC + 交期 DESC', sqlThree.rows.map((r) => r.id),
    idsOf(three.body, ourIds));
  eq('三键组合顺序（客户A 全是 draft：组内按交期 DESC = oA2 → oA1 → 待定的 oA3；客户B：draft 的 oB2 在前、已确认的 oB1 在后）',
    idsOf(three.body, ourIds), [ids.oA2, ids.oA1, ids.oA3, ids.oB2, ids.oB1]);

  // ---------- 3) 各属性单独排序（含 NULL/空值沉底） ----------
  console.log('\n【3】各属性单独排序：订单号 / PO 号 / 客户 / 状态 / 开票状态 / 金额 / 已开票 / 待补 / 创建时间 / 产品行数');
  const cases = [];

  const orderNoAsc = await listOrders(token, 'sort=orderNo:asc');
  cases.push(['订单号 ASC', idsOf(orderNoAsc.body, ourIds), [ids.oA1, ids.oA2, ids.oB1, ids.oB2, ids.oA3],
    'select o.id from orders o where o.id = any($1::int[]) order by o.order_no collate "C" asc, o.created_at desc, o.id desc']);

  // PO 号：oA3 没有 PO 号 → 无论升/降序都排在最后
  const poAsc = await listOrders(token, 'sort=poNo:asc');
  cases.push(['PO 号 ASC（空 PO 沉底）', idsOf(poAsc.body, ourIds),
    [ids.oA1, ids.oA2, ids.oB1, ids.oB2, ids.oA3],
    'select o.id from orders o where o.id = any($1::int[])'
    + " order by (o.po_no is null or btrim(o.po_no) = '') asc, o.po_no collate \"C\" asc, o.created_at desc, o.id desc"]);
  const poDesc = await listOrders(token, 'sort=poNo:desc');
  cases.push(['PO 号 DESC（空 PO 依旧沉底）', idsOf(poDesc.body, ourIds),
    [ids.oB2, ids.oB1, ids.oA2, ids.oA1, ids.oA3],
    'select o.id from orders o where o.id = any($1::int[])'
    + " order by (o.po_no is null or btrim(o.po_no) = '') asc, o.po_no collate \"C\" desc, o.created_at desc, o.id desc"]);

  const custAsc = await listOrders(token, 'sort=customer:asc');
  cases.push(['客户 ASC', idsOf(custAsc.body, ourIds),
    [ids.oA3, ids.oA2, ids.oA1, ids.oB2, ids.oB1],
    'select o.id from orders o join customers c on c.id = o.customer_id where o.id = any($1::int[])'
    + " order by (c.name is null or btrim(c.name) = '') asc, c.name collate \"C\" asc, o.created_at desc, o.id desc"]);

  const statusAsc = await listOrders(token, 'sort=status:asc');
  cases.push(['状态 ASC（业务序：草稿 → 已确认；draft 组按创建时间 DESC）', idsOf(statusAsc.body, ourIds),
    [ids.oA3, ids.oB2, ids.oA2, ids.oA1, ids.oB1],
    "select o.id from orders o where o.id = any($1::int[])"
    + " order by case o.status when 'draft' then 1 when 'confirmed' then 2 when 'production' then 3"
    + " when 'completed' then 4 when 'cancelled' then 5 else 99 end asc, o.created_at desc, o.id desc"]);

  const amountDesc = await listOrders(token, 'sort=amount:desc');
  cases.push(['订单金额 DESC（分）', idsOf(amountDesc.body, ourIds),
    [ids.oA2, ids.oB1, ids.oA1, ids.oA3, ids.oB2],
    'select o.id from orders o left join order_lines ol on ol.order_id = o.id where o.id = any($1::int[])'
    + ' group by o.id order by coalesce(sum(ol.quantity * round(ol.unit_price * 100)), 0) desc, o.created_at desc, o.id desc']);

  const pendingAsc = await listOrders(token, 'sort=pendingCount:asc');
  cases.push(['待补项数量 ASC（已补全在前）', idsOf(pendingAsc.body, ourIds),
    [ids.oB1, ids.oA2, ids.oA1, ids.oA3, ids.oB2],
    "select o.id from orders o where o.id = any($1::int[])"
    + " order by jsonb_array_length(coalesce(o.pending_items, '[]'::jsonb)) asc, o.created_at desc, o.id desc"]);

  const lineAsc = await listOrders(token, 'sort=lineCount:asc');
  cases.push(['产品行数 ASC', idsOf(lineAsc.body, ourIds),
    [ids.oA3, ids.oB2, ids.oB1, ids.oA1, ids.oA2],
    'select o.id from orders o where o.id = any($1::int[])'
    + ' order by (select count(*) from order_lines ol where ol.order_id = o.id) asc, o.created_at desc, o.id desc']);

  const createdAsc = await listOrders(token, 'sort=createdAt:asc');
  cases.push(['创建时间 ASC', idsOf(createdAsc.body, ourIds),
    [ids.oA1, ids.oA2, ids.oB1, ids.oB2, ids.oA3],
    'select o.id from orders o where o.id = any($1::int[]) order by o.created_at asc, o.id asc']);
  const createdDesc = await listOrders(token, 'sort=createdAt:desc');
  cases.push(['创建时间 DESC', idsOf(createdDesc.body, ourIds),
    [ids.oA3, ids.oB2, ids.oB1, ids.oA2, ids.oA1],
    'select o.id from orders o where o.id = any($1::int[]) order by o.created_at desc, o.id desc']);

  // 开票（放在已开票金额/开票状态断言前：给 oB1 开 2000 分 → partial）
  const today = new Date().toISOString().slice(0, 10);
  const inv = await req('POST', '/invoices', {
    invoiceNo: 'SORT-INV-1', amountInclCents: 2000, issueDate: today, orderIds: [ids.oB1],
  }, token);
  ok('给 oB1 开票 2000 分（含税）', inv.status >= 200 && inv.status < 300, [inv.status, inv.body && inv.body.invoiceNo]);

  const invoicedDesc = await listOrders(token, 'sort=invoiced:desc');
  cases.push(['已开票金额 DESC', idsOf(invoicedDesc.body, ourIds),
    [ids.oB1, ids.oA3, ids.oB2, ids.oA2, ids.oA1],
    'select o.id from orders o where o.id = any($1::int[])'
    + ' order by coalesce((select sum(i.amount_incl_cents) from invoice_orders io'
    + " join invoices i on i.id = io.invoice_id and i.status <> 'voided' where io.order_id = o.id), 0) desc,"
    + ' o.created_at desc, o.id desc']);
  const invStateAsc = await listOrders(token, 'sort=invoiceState:asc');
  cases.push(['开票状态 ASC（未开票 → 部分开票）', idsOf(invStateAsc.body, ourIds),
    [ids.oA3, ids.oB2, ids.oA2, ids.oA1, ids.oB1],
    "select o.id from orders o where o.id = any($1::int[])"
    + " order by case when coalesce((select sum(i.amount_incl_cents) from invoice_orders io"
    + " join invoices i on i.id = io.invoice_id and i.status <> 'voided' where io.order_id = o.id), 0) <= 0 then 0"
    + ' when coalesce((select sum(i.amount_incl_cents) from invoice_orders io'
    + " join invoices i on i.id = io.invoice_id and i.status <> 'voided' where io.order_id = o.id), 0)"
    + ' >= coalesce((select sum(ol.quantity * round(ol.unit_price * 100)) from order_lines ol where ol.order_id = o.id), 0)'
    + ' then 2 else 1 end asc, o.created_at desc, o.id desc']);

  for (const [label, actual, expected, sql] of cases) {
    eq(label, actual, expected);
    const rows = await db.query(sql, [ourIds]);
    eq('SQL 核对：' + label, rows.rows.map((r) => r.id), expected);
  }

  // ---------- 4) 非法参数 → 400 中文提示 ----------
  console.log('\n【4】sort 参数白名单校验（非法 → 400 中文提示）');
  const badField = await listOrders(token, 'sort=foo:asc');
  eq('非法字段 → 400', badField.status, 400);
  ok('非法字段中文提示（列出可用字段）',
    String(badField.body.message).includes('不支持的排序字段「foo」')
    && String(badField.body.message).includes('dueDate（交期）')
    && String(badField.body.message).includes('lineCount（产品行数）'),
    badField.body.message);
  const badField2 = await listOrders(token, 'sort=dueDate:desc,totalAmount:asc');
  eq('多键中夹带非法字段 → 400', badField2.status, 400);
  ok('多键非法字段中文提示', String(badField2.body.message).includes('不支持的排序字段「totalAmount」'), badField2.body.message);

  const badDir = await listOrders(token, 'sort=dueDate:up');
  eq('非法方向 → 400', badDir.status, 400);
  ok('非法方向中文提示', String(badDir.body.message).includes('排序方向「up」无效')
    && String(badDir.body.message).includes('asc（升序）'), badDir.body.message);

  const badFormat = await listOrders(token, 'sort=dueDate:desc:extra');
  eq('格式错误（多冒号）→ 400', badFormat.status, 400);
  ok('格式错误中文提示', String(badFormat.body.message).includes('格式不正确'), badFormat.body.message);

  const noDir = await listOrders(token, 'sort=amount');
  eq('只写字段名 → 按 ASC 处理（200）', noDir.status, 200);
  eq('只写字段名 = 显式 :asc', idsOf(noDir.body, ourIds), idsOf((await listOrders(token, 'sort=amount:asc')).body, ourIds));

  const upperDir = await listOrders(token, 'sort=amount:DESC');
  eq('方向大小写不敏感（DESC → desc）', upperDir.status, 200);
  const upperField = await listOrders(token, 'sort=AMOUNT:asc');
  eq('字段名区分大小写（AMOUNT 不在白名单）→ 400', upperField.status, 400);
  ok('大小写错误的中文提示', String(upperField.body.message).includes('不支持的排序字段「AMOUNT」'), upperField.body.message);

  const dupKey = await listOrders(token, 'sort=customer:asc,dueDate:asc,customer:desc');
  eq('同字段重复 → 保留第一次（customer:asc 生效）', idsOf(dupKey.body, ourIds),
    idsOf((await listOrders(token, 'sort=customer:asc,dueDate:asc')).body, ourIds));

  const emptySort = await listOrders(token, 'sort=');
  eq('sort 为空串 → 默认排序', idsOf(emptySort.body, ourIds), EXPECT_DUE_DESC);

  // ---------- 5) 既有能力不冲突 ----------
  console.log('\n【5】与既有能力不冲突：待补筛选 / 状态筛选 / 摘要+明细数据 / 占位开关 / 开票派生列');
  const pendingOnly = await listOrders(token, 'sort=pendingCount:asc&hasPending=1');
  eq('待补筛选 + 排序：只剩两张待补草稿（同序）', idsOf(pendingOnly.body, ourIds), [ids.oA3, ids.oB2]);
  const confirmedOnly = await listOrders(token, 'sort=dueDate:desc&status=confirmed');
  eq('状态筛选 + 排序：只剩已确认单', idsOf(confirmedOnly.body, ourIds), [ids.oB1]);
  const kwFiltered = await listOrders(token, 'sort=amount:desc&kw=PO-SORT-B1');
  eq('单号/PO 关键字筛选 + 排序', idsOf(kwFiltered.body, ourIds), [ids.oB1]);
  const withPlaceholders = await listOrders(token, 'sort=dueDate:desc&includePlaceholders=1');
  eq('占位档案开关仍可用（200）', withPlaceholders.status, 200);

  const first = noSort.body.find((r) => r.id === ids.oA2);
  ok('列表仍带产品行明细（摘要 N 个产品 + 展开明细的数据源）',
    Array.isArray(first.lines) && first.lines.length === 2 && first.lines.every((l) => !!l.productName),
    first.lines.map((l) => l.productName));
  eq('列表仍带订单金额（分）', first.totalAmountCents, 12000);
  eq('排序不改变开票派生列：oB1 = 部分开票（已开票 2000 分）',
    [invoicedDesc.body.find((r) => r.id === ids.oB1).invoiceState,
      invoicedDesc.body.find((r) => r.id === ids.oB1).invoicedCents],
    ['partial', 2000]);
  eq('列表仍带未开票余额（分，4500 − 2000）',
    invoicedDesc.body.find((r) => r.id === ids.oB1).uninvoicedCents, 2500);
  eq('多列组合排序不影响待补列文本', typeof noSort.body.find((r) => r.id === ids.oA3).pendingText, 'string');

  // 排序只改顺序、不改集合
  const a = new Set((await listOrders(token, 'sort=dueDate:desc')).body.map((r) => r.id));
  const b = new Set((await listOrders(token, 'sort=amount:asc,lineCount:desc')).body.map((r) => r.id));
  eq('不同排序返回的订单集合完全相同（只改顺序）', [...a].sort((x, y) => x - y), [...b].sort((x, y) => x - y));

  // =====================================================================================
  // 【2026-10-06 修复】单键排序可反复切换升降序、第三次点击取消后回到默认口径
  //   前端状态机在 apps/web/src/lib/order-sort-state.ts（纯函数，有单测），这里做两件事：
  //     ① 接口层：**不传 sort / 空 sort / sort=dueDate:desc 三者完全等价**（默认口径唯一）；
  //     ② 前端层：直接 import 那个纯函数模块跑一遍点击序列，并静态核对 OrdersPage 真的用了它
  //        （不是把逻辑抄在页面里 —— 抄一份就有两套口径）。
  // =====================================================================================
  console.log('\n【6】排序口径：默认 = 交期降序；单键可反复切换升降序、第三次点击取消回到默认');
  const noSortAgain = await listOrders(token, '');
  const emptySortAgain = await listOrders(token, 'sort=');
  const orderOf = (r) => r.body.map((x) => x.id);
  eq('不传 sort ≡ sort=dueDate:desc（默认口径唯一）', orderOf(noSortAgain), orderOf(explicitDefault));
  eq('sort= 空串 ≡ 不传 sort', orderOf(emptySortAgain), orderOf(noSortAgain));
  ok('sort=dueDate:asc 与默认（降序）顺序不同 —— 方向真的生效',
    JSON.stringify(orderOf(dueAsc)) !== JSON.stringify(orderOf(noSortAgain)), {
      默认: orderOf(noSortAgain).slice(0, 4), 升序: orderOf(dueAsc).slice(0, 4),
    });
  eq('不传 sort 与既有 EXPECT_DUE_DESC 基准一致', idsOf(noSortAgain.body, ourIds), EXPECT_DUE_DESC);

  // ---- 前端纯函数状态机（直接 import，不用正则猜源码） ----
  const UI = await import(new URL('../../web/src/lib/order-sort-state.ts', import.meta.url).href);
  const click = (prev, field, dir) => {
    const active = new Map();
    for (const k of prev) active.set(k.field, k.dir);
    if (dir) active.set(field, dir); else active.delete(field);
    return UI.nextOrderSort(prev, active);
  };
  const DEFAULT_UI = [{ field: 'dueDate', dir: 'desc' }];
  eq('前端：默认口径 = 交期 DESC，且 sort 参数**不传**（空串）',
    [UI.effectiveOrderSort([]), UI.orderSortParam([])], [DEFAULT_UI, '']);
  let k = [];
  k = click(k, 'dueDate', 'asc');
  eq('前端：第 1 次点击交期 → 升序（state = 显式 1 条）', [UI.orderSortParam(k), UI.sortDirOf(k, 'dueDate'), UI.sortIndexOf(k, 'dueDate')],
    ['dueDate:asc', 'ascend', 1]);
  k = click(k, 'dueDate', 'desc');
  eq('前端：第 2 次点击交期 → 降序', [UI.orderSortParam(k), UI.sortDirOf(k, 'dueDate')], ['dueDate:desc', 'descend']);
  k = click(k, 'dueDate', null);
  eq('前端：第 3 次点击交期 → 取消该排序项（state 清空）', [k.length, UI.isDefaultOrderSort(k)], [0, true]);
  eq('前端：取消后回到默认口径（交期降序），且 sort 参数回到不传',
    [UI.effectiveOrderSort(k), UI.orderSortParam(k), UI.sortDirOf(k, 'dueDate'), UI.sortIndexOf(k, 'dueDate')],
    [DEFAULT_UI, '', null, undefined]);
  eq('前端：取消最后一列后，其余列保持相对优先级',
    click([{ field: 'customer', dir: 'asc' }, { field: 'dueDate', dir: 'desc' }], 'dueDate', null),
    [{ field: 'customer', dir: 'asc' }]);
  ok('前端：sorter.multiple 恒为数字（否则 AntD 会退回单列排序、点第二列清掉第一列）',
    UI.ORDER_SORT_FIELDS.every((x) => typeof UI.sortMultiple([{ field: 'poNo', dir: 'desc' }], x) === 'number'),
    UI.ORDER_SORT_FIELDS.length);

  // ---- 静态核对：OrdersPage 必须用这个纯函数模块，而不是把「默认 = 已选」的逻辑抄在页面里 ----
  const pageSrc = readFileSync(fileURLToPath(new URL('../../web/src/pages/OrdersPage.tsx', import.meta.url)), 'utf8');
  ok('前端页面：排序 state 初值为**空**（默认口径不写进 state —— 原 bug 就是这里）',
    /useState<OrderSortKey\[\]>\(\[\]\)/.test(pageSrc), (pageSrc.match(/useState<OrderSortKey\[\]>\([^)]*\)/) ?? [''])[0]);
  ok('前端页面：默认判定的旧写法（keys.length === 1 && …dueDate…desc）已消失',
    !/keys\.length === 1 && keys\[0\]\.field === 'dueDate'/.test(pageSrc), '');
  ok('前端页面：表头点击走 nextOrderSort()', /setSortKeys\(nextOrderSort\(/.test(pageSrc), '');
  ok('前端页面：sort 参数走 orderSortParam() 且**空则不传**',
    /if \(sortParam\) params\.set\('sort', sortParam\)/.test(pageSrc), '');
  ok('前端页面：排序方向/优先级一律取自纯函数模块（不在页面内自己 findIndex）',
    /sortDirOf as sortDirOfKeys/.test(pageSrc) && /sortMultiple as sortMultipleOf/.test(pageSrc)
    && !/const i = sortKeys\.findIndex/.test(pageSrc), '');

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
  process.exitCode = 1;
});
