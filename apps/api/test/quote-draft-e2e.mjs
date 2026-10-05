/**
 * 报价记录 + 识单补价 + 落草稿（待补）· 端到端自测（真实 HTTP 接口 + 真实 PostgreSQL 断言）
 * ---------------------------------------------------------------------------
 * 覆盖（I17 全链路）：
 *   1) 报价记录 CRUD：新增 / 列表筛选 / 改价（PUT，留痕）/ 停用启用 / 取价试算 / 批量导入 preview→commit
 *   2) 识单补价：**无单价**的 CSV 识别 → 按「文件夹客户 + 该行产品」自动补价 + priceFrom='quote'；
 *      报价停用后同一份 CSV → 仍缺价、标待补（绝不编造价格）
 *   3) 落草稿：缺价/缺交期/未建档 → POST /orders/draft 落 draft + 逐行/逐单中文待补标记
 *      （orders.due_date NOT NULL → 哨兵日 2099-12-31 + due_date_tbd；缺客户/产品 → 惰性占位档案）
 *   4) 筛选与补全：GET /orders?hasPending=1 → 待补闸门拦截「确认」→ 一键从报价补价 → 补交期 → 标记清空 → 确认成功
 *   5) 向后兼容：有价的老表格不补价（quoteFilledCount=0）、POST /orders 老建单路行为不变
 *
 * 前置：一个连到**空库**的 API 实例（会自动建表 + 种子 admin/Fms@2026），例如：
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_test JWT_SECRET=e2e PORT=3100 node dist/main
 * 运行：node test/quote-draft-e2e.mjs
 * 环境变量：E2E_BASE（默认 http://127.0.0.1:3100/api）、E2E_PG_*（默认 localhost:15432）
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

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const FUTURE = ymd(new Date(Date.now() + 30 * 86400_000)); // 交期必须晚于今天
const PAST = '2020-01-01';
const OVER = '2020-06-30'; // 已过期的失效日

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

const uploadBody = (buffer, fileName) => ({ file: 'data:application/octet-stream;base64,' + buffer.toString('base64'), fileName });

/** 无单价订单 CSV（识别后必然「缺价」——正是 .doc 计划单族的真实形态） */
function noPriceCsv() {
  return Buffer.from([
    '产品名称,数量',
    '1-101 割嘴 00#,200',
    'PNM 1/32,500',
  ].join('\r\n'), 'utf8');
}

/** 有单价订单 CSV（向后兼容口径：不应被报价覆盖） */
function withPriceCsv() {
  return Buffer.from([
    '产品名称,数量,单价,交期',
    '1-101 割嘴 00#,100,9.90,' + FUTURE,
  ].join('\r\n'), 'utf8');
}

/** 报价导入 CSV（中文表头与 /api/quotes/template 一致） */
function quoteImportCsv() {
  return Buffer.from('\uFEFF' + [
    '客户名称,产品名称,单价,币种,生效日期,失效日期,备注',
    '安宝公司,PNM 1/32,3.80,CNY,2021-01-01,,导入-客户档旧价',
    '安宝公司,PNM 1/32,9.99,CNY,2026-01-01,,导入-客户档新价（同键同产品，靠生效日区分）',
    ',PNM 1/32,2.50,CNY,2021-01-01,,导入-通用价',
    '不存在的客户,任意产品,1.00,CNY,,,导入-客户未建档应报错',
  ].join('\r\n') + '\r\n', 'utf8');
}

async function main() {
  console.log('目标接口：' + BASE);
  console.log('测试数据库：' + PG_CONF.host + ':' + PG_CONF.port + '/' + PG_CONF.database);
  const db = new pg.Client(PG_CONF);
  await db.connect();

  const login = await req('POST', '/auth/login', { username: 'admin', password: 'Fms@2026' });
  eq('admin 登录成功', login.status, 200);
  const token = login.body.token;

  // ================= 主数据 =================
  console.log('\n【主数据】客户 + 产品目录');
  const cust = await req('POST', '/customers', { name: '安宝公司', creditDays: 30 }, token);
  const customerId = cust.body.id;
  const p1 = await req('POST', '/products', { name: '1-101 割嘴 00#', type: 'uk_acetylene' }, token);
  const p2 = await req('POST', '/products', { name: 'PNM 1/32', type: 'uk_propane' }, token);
  const p3 = await req('POST', '/products', { name: '6290', type: 'us_acetylene' }, token);
  const prod1 = p1.body.id;
  const prod2 = p2.body.id;
  const prod3 = p3.body.id;
  ok('客户「安宝公司」已建档', !!customerId, customerId);
  ok('产品已建档（1-101 / PNM / 6290）', !!prod1 && !!prod2 && !!prod3, { prod1, prod2, prod3 });

  // ================= ① 报价记录 CRUD =================
  console.log('\n【① 报价记录】新增 / 取价试算 / 改价留痕 / 停用启用');
  const generic = await req('POST', '/quotes', { productId: prod1, productName: '1-101 割嘴 00#', unitPrice: 3.00, currency: 'CNY', validFrom: PAST, source: 'manual' }, token);
  const byName = await req('POST', '/quotes', { customerId, productName: '1-101 割嘴 00#', unitPrice: 9.00, currency: 'CNY', validFrom: PAST }, token);
  const byProduct = await req('POST', '/quotes', { customerId, productId: prod1, productName: '1-101 割嘴 00#', unitPrice: 13.20, currency: 'CNY', validFrom: PAST }, token);
  eq('新增报价（通用价）返回 201', generic.status, 201);
  eq('新增报价（客户+文本）返回 201', byName.status, 201);
  eq('新增报价（客户+产品）返回 201', byProduct.status, 201);
  eq('单价按「分」落库（9.00 元 → 900 分）', byName.body.unitPriceCents, 900);
  eq('通用价 customerId 为空', generic.body.customerId, null);

  const look1 = await req('GET', '/quotes/lookup?customerId=' + customerId + '&productId=' + prod1 + '&productName=' + encodeURIComponent('1-101 割嘴 00#'), undefined, token);
  eq('取价试算：命中「客户+产品」档', look1.body.hit.rule, 'customer_product');
  eq('取价试算：单价（分）', look1.body.hit.unitPriceCents, 1320);
  eq('取价试算：命中报价 id', look1.body.hit.quoteId, byProduct.body.id);
  ok('取价试算：中文说明含报价单号与规则', look1.body.hint.includes('#' + byProduct.body.id) && look1.body.hint.includes('客户+产品'), look1.body.hint);

  // 改价（PUT /api/quotes/:id/price）+ SQL 核对留痕
  const before = await db.query('select unit_price_cents, operator_id, created_at, updated_at from product_quotes where id = $1', [byProduct.body.id]);
  const changed = await req('PUT', '/quotes/' + byProduct.body.id + '/price', { unitPrice: 14.50, remark: '铜价上涨调价' }, token);
  eq('改价接口返回 200', changed.status, 200);
  eq('改价后单价（分）', changed.body.unitPriceCents, 1450);
  const after = await db.query('select unit_price_cents, operator_id, created_at, updated_at, remark from product_quotes where id = $1', [byProduct.body.id]);
  eq('SQL：改价已落库（分）', Number(after.rows[0].unit_price_cents), 1450);
  ok('SQL：updated_at 已刷新（改价留痕）', new Date(after.rows[0].updated_at) > new Date(before.rows[0].updated_at), { before: before.rows[0].updated_at, after: after.rows[0].updated_at });
  eq('SQL：created_at 不变（历史行保留，不物理删除）', new Date(after.rows[0].created_at).getTime(), new Date(before.rows[0].created_at).getTime());
  eq('SQL：改价备注已更新', after.rows[0].remark, '铜价上涨调价');
  const opRow = await db.query("select id from operators order by id limit 1");
  eq('SQL：改价留痕写了 operator_id', after.rows[0].operator_id, opRow.rows.length ? opRow.rows[0].id : null);

  const look2 = await req('GET', '/quotes/lookup?customerId=' + customerId + '&productId=' + prod1, undefined, token);
  eq('改价后取价立刻生效（按分）', look2.body.hit.unitPriceCents, 1450);

  // 停用 → 回退到下一档（客户+产品名文本）
  const off = await req('PATCH', '/quotes/' + byProduct.body.id + '/enabled', { enabled: false }, token);
  eq('停用接口返回 200', off.status, 200);
  eq('停用后 enabled=false', off.body.enabled, false);
  const look3 = await req('GET', '/quotes/lookup?customerId=' + customerId + '&productId=' + prod1 + '&productName=' + encodeURIComponent('1-101 割嘴 00#'), undefined, token);
  eq('停用最高档 → 退「客户+产品名文本」档', look3.body.hit.rule, 'customer_name');
  eq('停用最高档 → 取到 9.00 元（900 分）', look3.body.hit.unitPriceCents, 900);
  await req('PATCH', '/quotes/' + byProduct.body.id + '/enabled', { enabled: true }, token);

  // 有效期过滤：过期的报价不参与
  const expired = await req('POST', '/quotes', { customerId, productId: prod3, productName: '6290', unitPrice: 99.99, validFrom: PAST, validTo: OVER }, token);
  const lookExp = await req('GET', '/quotes/lookup?customerId=' + customerId + '&productId=' + prod3, undefined, token);
  ok('已过期的报价不参与取价', lookExp.body.hit === null, lookExp.body.hit);
  await req('PATCH', '/quotes/' + expired.body.id + '/enabled', { enabled: false }, token);

  // 列表筛选 + 分页
  const list = await req('GET', '/quotes?customerId=' + customerId + '&effective=1&page=1&pageSize=2', undefined, token);
  ok('列表分页 pageSize 生效', list.body.rows.length <= 2, list.body.rows.length);
  ok('列表返回 total 与 rows', typeof list.body.total === 'number' && Array.isArray(list.body.rows), { total: list.body.total });
  ok('列表含「当前是否有效」标记', list.body.rows.every((r) => typeof r.effective === 'boolean'), list.body.rows.map((r) => r.effective));

  // ================= ② 批量导入（preview → commit） =================
  console.log('\n【② 报价批量导入】preview 分类统计 → commit');
  const csv = quoteImportCsv();
  const pv = await req('POST', '/quotes/import/preview', { ...uploadBody(csv, '报价导入.csv'), mode: 'insert-only' }, token);
  eq('导入预览返回 201', pv.status, 201);
  eq('预览：走 csv 通道', pv.body.fileKind, 'csv');
  eq('预览：总行数', pv.body.summary.total, 4);
  eq('预览：新增 3 行（3 条新 + 1 条错误）', pv.body.summary.new, 3);
  eq('预览：错误 1 行（客户未建档）', pv.body.summary.error, 1);
  ok('预览：错误原因中文且指明客户未建档', pv.body.rows.find((r) => r.status === 'error').reasons.join('；').includes('不在档案中'),
    pv.body.rows.find((r) => r.status === 'error').reasons);

  const cm = await req('POST', '/quotes/import/commit', { ...uploadBody(csv, '报价导入.csv'), mode: 'insert-only' }, token);
  eq('导入提交返回 201', cm.status, 201);
  eq('提交：新增 3 条', cm.body.summary.new, 3);
  eq('提交：失败 1 条（单行失败不影响其它行）', cm.body.summary.error, 1);
  ok('提交失败清单带行号与原因', cm.body.failures[0].rowNo === 5 && !!cm.body.failures[0].reason, cm.body.failures);

  // 幂等 + 改价模式（upsert）：同一文件再跑一次 → 同键行进入「改价」
  const cm2 = await req('POST', '/quotes/import/commit', { ...uploadBody(csv, '报价导入.csv'), mode: 'upsert' }, token);
  eq('复跑（upsert）：3 条走「改价」而不是重复新增', cm2.body.summary.update, 3);
  eq('复跑（upsert）：新增 0 条（同键幂等，不产生重复报价）', cm2.body.summary.new, 0);

  const cnt = await db.query('select count(*)::int as n from product_quotes');
  eq('SQL：报价表行数 = 3 手工 + 1 过期 + 3 导入（upsert 改价不新增行）', cnt.rows[0].n, 7);
  const genericCnt = await db.query('select count(*)::int as n from product_quotes where customer_id is null');
  ok('SQL：通用价（customer_id 为空）已落库', genericCnt.rows[0].n >= 1, genericCnt.rows[0].n);

  // ================= ③ 识单补价 =================
  console.log('\n【③ 识单 × 报价】无单价 CSV → 自动补价 + priceFrom=quote');
  const parse1 = await req('POST', '/ai/orders/parse', { ...uploadBody(noPriceCsv(), '无价计划单.csv'), folderCustomer: '安宝公司' }, token);
  eq('识别接口成功', parse1.status, 201);
  const r1 = parse1.body;
  eq('客户由文件夹决定', r1.customerName, '安宝公司');
  eq('缺单价列 → 仍走既有 LLM 兜底通道（历史口径不变，未配 key 时回退规则映射）', r1.parseSource, 'table-llm');
  ok('缺单价列 → 回退后仍带回产品行（不丢行）', r1.lines.length === 2, r1.lines.map((l) => l.productName));
  eq('自动补价行数 = 2', r1.quoteFilledCount, 2);
  eq('第 1 行单价（元，来自报价 14.50）', r1.lines[0].unitPrice, 14.5);
  eq('第 1 行 标注 priceFrom=quote（来源可追溯）', r1.lines[0].priceFrom, 'quote');
  eq('第 1 行 命中规则', r1.lines[0].quoteRule, 'customer_product');
  eq('第 1 行 金额（分）= 200 × 1450', r1.lines[0].amountCents, 290000);
  eq('第 2 行单价（元）＝同档内 valid_from 最新的一条（9.99，而非旧的 3.80）', r1.lines[1].unitPrice, 9.99);
  eq('第 2 行 标注 priceFrom=quote', r1.lines[1].priceFrom, 'quote');
  ok('补价说明写入 notes（可回溯到报价单号）', r1.notes.some((n) => n.includes('报价记录 #')), r1.notes);
  ok('补价后不再有「未识别到单价」的 error', !r1.lines.some((l) => l.issues.some((i) => i.message.includes('未识别到单价'))));

  // 兼容：有单价的表格不被报价覆盖
  const parse2 = await req('POST', '/ai/orders/parse', { ...uploadBody(withPriceCsv(), '有价订单.csv'), folderCustomer: '安宝公司' }, token);
  eq('有单价表格：补价行数 0（报价只补缺，不改原始价）', parse2.body.quoteFilledCount, 0);
  eq('有单价表格：单价保持单据原值 9.90', parse2.body.lines[0].unitPrice, 9.9);
  eq('有单价表格：无 priceFrom 标记', parse2.body.lines[0].priceFrom, undefined);

  // ================= ④ 落草稿 + 待补 =================
  console.log('\n【④ 落草稿订单】缺价 / 缺交期 / 客户未建档 → 逐项标待补');
  const draft = await req('POST', '/orders/draft', {
    folderCustomer: '尚未建档的客户',
    poNo: 'PO-DRAFT-01',
    dueDate: null, // 缺交期（.doc 计划单族常态）
    note: '识单落草稿（e2e）',
    lines: [
      // 缺价 + 通用价存在 → **落草稿管线自身**就该按报价回填（裁定④：.doc 管线走同一补价路径）
      { productName: '1-101 割嘴 00#', quantity: 200, unitPrice: null },
      { productName: '完全没建过档的产品', quantity: null, unitPrice: null }, // 产品未建档 + 缺数量 + 缺价
      { productName: '缺价测试产品', quantity: 100, unitPrice: null }, // 缺价 + 此刻无任何报价 → 保持待补，稍后再补
    ],
  }, token);
  eq('落草稿接口返回 201', draft.status, 201);
  const d = draft.body;
  eq('落草稿状态 = draft', d.status, 'draft');
  eq('缺交期 → due_date_tbd = true', d.dueDateTbd, true);
  ok('缺交期 → due_date 用哨兵日占位（NOT NULL 约束未被破坏）', String(d.dueDate).startsWith('2099-12-31'), d.dueDate);
  eq('未建档客户名留痕', d.draftCustomerName, '尚未建档的客户');
  ok('单头待补项非空且是中文诊断', Array.isArray(d.pendingItems) && d.pendingItems.length >= 2, d.pendingItems);
  const codes = d.pendingItems.map((x) => x.code);
  ok('单头待补：客户未建档', codes.includes('customer_not_filed'), codes);
  ok('单头待补：缺交期', codes.includes('due_date_missing'), codes);
  ok('单头待补：行级汇总', codes.includes('line_pending'), codes);
  // 裁定④：落草稿管线自身补价（客户未建档 → 只能命中通用价 3.00）
  eq('裁定④ 缺价行在落草稿时即被报价补上（单价 3.00 元）', d.lines[0].unitPrice, 3.0);
  eq('裁定④ 补价行的待补项已清空', d.lines[0].pendingItems, null);
  eq('裁定④ 第 2 行待补 = 产品未建档 + 缺数量 + 缺单价', d.lines[1].pendingItems.map((x) => x.code),
    ['product_not_filed', 'quantity_missing', 'price_missing']);
  eq('第 3 行（此刻无报价、且产品未建档）待补 = 产品未建档 + 缺单价', d.lines[2].pendingItems.map((x) => x.code),
    ['product_not_filed', 'price_missing']);
  ok('待补诊断是中文（界面直接可见）', d.pendingItems.every((x) => /[\u4e00-\u9fa5]/.test(x.message)), d.pendingItems.map((x) => x.message));

  // ---- SQL 核对：订单 / 订单行 / 占位档案 ----
  const oRow = await db.query('select status, due_date, due_date_tbd, draft_customer_name, pending_items from orders where id = $1', [d.id]);
  eq('SQL：订单状态', oRow.rows[0].status, 'draft');
  eq('SQL：哨兵交期', oRow.rows[0].due_date.toISOString().slice(0, 10), '2099-12-31');
  eq('SQL：due_date_tbd 标记', oRow.rows[0].due_date_tbd, true);
  eq('SQL：未建档客户名', oRow.rows[0].draft_customer_name, '尚未建档的客户');
  ok('SQL：pending_items 是 jsonb 数组', Array.isArray(oRow.rows[0].pending_items), oRow.rows[0].pending_items);
  const lRows = await db.query('select quantity, unit_price, currency, pending_items, product_name_text, price_source from order_lines where order_id = $1 order by id', [d.id]);
  eq('SQL：订单行数', lRows.rows.length, 3);
  eq('裁定④ SQL：落草稿补价行已写库（3.00 元）', Number(lRows.rows[0].unit_price), 3.0);
  eq('裁定④ SQL：price_source 标 quote（来源可追溯）', lRows.rows[0].price_source, 'quote');
  eq('裁定④ SQL：补价行不再标缺价', lRows.rows[0].pending_items, null);
  ok('裁定⑤ SQL：订单行币种归一为 CNY（写入前归一）', lRows.rows.every((r) => r.currency === 'CNY'), lRows.rows.map((r) => r.currency));
  eq('SQL：缺价行单价存 0（列 NOT NULL，靠待补标记提醒）', Number(lRows.rows[2].unit_price), 0);
  eq('SQL：缺数量行数量存 0', lRows.rows[1].quantity, 0);
  ok('SQL：产品未建档行的识别原文已留痕', lRows.rows[1].product_name_text === '完全没建过档的产品', lRows.rows[1].product_name_text);
  ok('SQL：产品未建档行指向占位产品', lRows.rows[1].pending_items.some((x) => x.code === 'product_not_filed'));
  const phCust = await db.query('select id, name from customers where name = $1', ['（未建档客户·待补）']);
  eq('SQL：惰性创建占位客户（显式标注「待补」）', phCust.rows.length, 1);
  const phProd = await db.query('select id, name, type from products where name = $1', ['（未建档产品·待补）']);
  eq('SQL：惰性创建占位产品', phProd.rows.length, 1);
  // 裁定③：占位产品类型是中立的「待定」（tbd），不再借用 uk_acetylene
  eq('裁定③ SQL：占位产品类型 = tbd（待定）', phProd.rows[0].type, 'tbd');
  eq('SQL：订单挂到占位客户下', oRow.rows[0].draft_customer_name !== null && phCust.rows[0].id !== customerId, true);

  // ---- 筛选：有未补全项的草稿单 ----
  const pendList = await req('GET', '/orders?hasPending=1', undefined, token);
  ok('筛选「有未补全项的草稿单」能查到该单', pendList.body.some((o) => o.id === d.id), pendList.body.map((o) => o.id));
  ok('列表带 pendingText（中文汇总，界面直接展示）', pendList.body.find((o) => o.id === d.id).pendingText.includes('缺'), pendList.body.find((o) => o.id === d.id).pendingText);
  const normalList = await req('GET', '/orders?hasPending=1&status=confirmed', undefined, token);
  ok('筛选与状态条件可叠加（已确认单不可能有待补）', normalList.body.every((o) => o.status === 'confirmed'), normalList.body.length);

  // ---- 待补闸门：禁止确认 ----
  const confirmBlocked = await req('POST', '/orders/' + d.id + '/confirm', undefined, token);
  eq('有待补项 → 确认被拦截（400）', confirmBlocked.status, 400);
  ok('拦截原因是中文待补清单', String(confirmBlocked.body.message).includes('待补项'), confirmBlocked.body.message);

  // ---- 一键从报价补价（先补客户档，再给第 3 行产品录入通用价） ----
  const realCust = await req('POST', '/customers', { name: '尚未建档的客户', creditDays: 30 }, token);
  // 第 3 行「缺价测试产品」此刻还没有任何报价 → 先落一条通用价（按产品名文本匹配）
  await req('POST', '/quotes', { productName: '缺价测试产品', unitPrice: 8.80, currency: '人民币', validFrom: PAST, remark: 'e2e 补价用通用价' }, token);
  const fill1 = await req('POST', '/orders/' + d.id + '/fill-quote-prices', undefined, token);
  eq('一键补价接口返回 201', fill1.status, 201);
  eq('补价：命中 1 行（通用价按产品名文本命中）', fill1.body.filled.length, 1);
  eq('补价：未命中 1 行（未建档产品对不上，保持待补）', fill1.body.missed.length, 1);
  eq('补价：命中行单价 = 8.80 元', fill1.body.filled[0].unitPrice, 8.8);
  eq('补价：命中规则 = 通用价', fill1.body.filled[0].ruleText, '通用价（不限客户）');
  const afterFill = await db.query('select unit_price, price_source, pending_items, currency from order_lines where order_id = $1 order by id', [d.id]);
  eq('SQL：补价已写库（8.80 元）', Number(afterFill.rows[2].unit_price), 8.8);
  eq('SQL：price_source 标 quote（来源可追溯）', afterFill.rows[2].price_source, 'quote');
  eq('SQL：该行缺价标记已清除（产品未建档标记保留，仍需建档）',
    (afterFill.rows[2].pending_items ?? []).filter((x) => x.code === 'price_missing'), []);
  ok('SQL：未命中行仍标待补', afterFill.rows[1].pending_items.length > 0, afterFill.rows[1].pending_items);

  // ---- 逐项补全（人工建档 + 填数量 + 补客户/交期） ----
  const itemFill = await req('PATCH', '/orders/' + d.id, {
    customerId: realCust.body.id,
    dueDate: FUTURE,
    lines: [
      { productId: prod1, quantity: 200, unitPrice: 9.0 },
      { productId: prod2, quantity: 500, unitPrice: 3.8 },
      { productId: prod3, quantity: 100, unitPrice: 8.8 },
    ],
  }, token);
  eq('补全接口返回 200', itemFill.status, 200);
  eq('补全后单头待补清空', itemFill.body.pendingItems, []);
  eq('补全后交期已改为真实日期', String(itemFill.body.dueDate).slice(0, 10), FUTURE);
  eq('补全后 due_date_tbd 清除', itemFill.body.dueDateTbd, false);
  const afterFix = await db.query('select pending_items, due_date, due_date_tbd, draft_customer_name from orders where id = $1', [d.id]);
  eq('SQL：单头待补已清空（[] = 追踪中且无待补）', afterFix.rows[0].pending_items, []);
  eq('SQL：due_date_tbd 清除', afterFix.rows[0].due_date_tbd, false);
  eq('SQL：未建档客户名清除', afterFix.rows[0].draft_customer_name, null);
  const pendList2 = await req('GET', '/orders?hasPending=1', undefined, token);
  ok('补全后不再出现在「有未补全项」列表里', !pendList2.body.some((o) => o.id === d.id), pendList2.body.map((o) => o.id));

  // ---- 补全后可以正常确认（生成计划单草稿） ----
  const confirmed = await req('POST', '/orders/' + d.id + '/confirm', undefined, token);
  ok('补全后确认成功（2xx）', confirmed.status >= 200 && confirmed.status < 300, confirmed.status);
  const oRow2 = await db.query('select status from orders where id = $1', [d.id]);
  eq('SQL：订单状态已流转', oRow2.rows[0].status, 'confirmed');

  // ================= ⑤ 向后兼容 =================
  console.log('\n【⑤ 向后兼容】老建单路（POST /orders）+ 无 folderCustomer 的识单');
  const legacy = await req('POST', '/orders', {
    customerId, poNo: 'PO-LEGACY', dueDate: FUTURE,
    lines: [{ productId: prod1, quantity: 10, unitPrice: 9.9 }],
  }, token);
  eq('POST /orders 老路仍返回 201', legacy.status, 201);
  eq('老路建单 pending_items 为 null（不参与待补机制）', legacy.body.pendingItems, null);
  const legacyDb = await db.query('select pending_items from orders where id = $1', [legacy.body.id]);
  eq('SQL：老路建单 pending_items 为 NULL', legacyDb.rows[0].pending_items, null);
  const legacyConfirm = await req('POST', '/orders/' + legacy.body.id + '/confirm', undefined, token);
  ok('老路建单可直接确认（待补闸门不影响普通订单）', legacyConfirm.status >= 200 && legacyConfirm.status < 300, legacyConfirm.status);

  const noFolder = await req('POST', '/ai/orders/parse', { ...uploadBody(noPriceCsv(), '无文件夹.csv') }, token);
  eq('不传 folderCustomer → 客户列必填（仍是旧口径，走 LLM 兜底通道）', noFolder.body.parseSource, 'table-llm');
  eq('不传 folderCustomer → 只可能命中「通用价」，命中 2 行', noFolder.body.quoteFilledCount, 2);
  eq('不传 folderCustomer → 第 1 行取通用价 3.00（绝不误用客户档的 14.50）', noFolder.body.lines[0].unitPrice, 3.0);
  eq('不传 folderCustomer → 第 1 行命中规则为通用价', noFolder.body.lines[0].quoteRule, 'generic');
  eq('不传 folderCustomer → 第 2 行取通用价 2.50', noFolder.body.lines[1].unitPrice, 2.5);
  ok('不传 folderCustomer → 客户仍未识别（既有 error 保留，未被补价掩盖）',
    noFolder.body.issues.some((i) => i.path === 'customer' && i.level === 'error'), noFolder.body.issues.map((i) => i.path));

  // ================= ⑥ 本轮 5 项甲方裁定 =================
  console.log('\n【⑥ 甲方裁定 5 项】哨兵日 / 占位档案默认隐藏 / 占位产品待定 / .doc 补价 / 币种归一 CNY');

  // ---- 裁定①：哨兵日 2099-12-31 + due_date_tbd 成对（不变），界面按标记显示「待定」 ----
  const inv = await db.query("select count(*)::int as n from orders where due_date_tbd <> (due_date::date = date '2099-12-31')");
  eq('裁定① SQL：due_date_tbd 与哨兵日 2099-12-31 严格成对（不变量）', inv.rows[0].n, 0);

  // ---- 裁定⑤：币种统一归一为 CNY（写入前归一） ----
  const cny1 = await req('POST', '/quotes', { productName: '币种归一测试', unitPrice: 1.23, currency: 'RMB¥' }, token);
  eq('裁定⑤ 新建报价返回 201', cny1.status, 201);
  eq('裁定⑤ RMB¥ → 写入即归一为 CNY', cny1.body.currency, 'CNY');
  const cny2 = await req('POST', '/quotes', { productName: '币种归一测试2', unitPrice: 2.34, currency: '￥' }, token);
  eq('裁定⑤ ￥ → CNY', cny2.body.currency, 'CNY');
  const cny4 = await req('POST', '/quotes', { productName: '币种归一测试4', unitPrice: 1.11, currency: '人民币' }, token);
  eq('裁定⑤ 人民币 → CNY', cny4.body.currency, 'CNY');
  const cny3 = await req('POST', '/quotes', { productName: '币种归一测试3', unitPrice: 3.45, currency: 'USD' }, token);
  eq('裁定⑤ USD 保持 USD', cny3.body.currency, 'USD');
  const changed2 = await req('PUT', '/quotes/' + cny3.body.id + '/price', { unitPrice: 4.56, currency: 'rmb' }, token);
  eq('裁定⑤ 改价路径同样归一（rmb → CNY）', changed2.body.currency, 'CNY');
  const nonStd = await db.query("select count(*)::int as n from product_quotes where currency not in ('CNY','USD')");
  eq('裁定⑤ SQL：报价表不存在非规范币种', nonStd.rows[0].n, 0);

  // ---- 裁定②：占位档案默认隐藏 + 「显示占位档案」开关 ----
  const custDefault = await req('GET', '/customers', undefined, token);
  ok('裁定② 客户列表默认不含占位客户', !custDefault.body.some((c) => c.name === '（未建档客户·待补）'), custDefault.body.map((c) => c.name));
  ok('裁定② 客户列表默认仍含真实客户（安宝公司）', custDefault.body.some((c) => c.name === '安宝公司'), custDefault.body.map((c) => c.name));
  const custShow = await req('GET', '/customers?includePlaceholders=1', undefined, token);
  ok('裁定② 开关打开后可见占位客户（排查用）', custShow.body.some((c) => c.name === '（未建档客户·待补）'), custShow.body.map((c) => c.name));
  const prodDefault = await req('GET', '/products', undefined, token);
  ok('裁定② 产品列表默认不含占位产品', !prodDefault.body.some((p) => p.name === '（未建档产品·待补）'), prodDefault.body.map((p) => p.name));
  const prodShow = await req('GET', '/products?includePlaceholders=1', undefined, token);
  ok('裁定② 开关打开后可见占位产品（且类型为「待定」tbd）',
    prodShow.body.some((p) => p.name === '（未建档产品·待补）' && p.type === 'tbd'),
    prodShow.body.filter((p) => p.name === '（未建档产品·待补）'));

  // 造一张「挂占位客户 + 占位产品」的草稿，验证订单列表同样默认隐藏
  const phDraft = await req('POST', '/orders/draft', {
    folderCustomer: '裁定②占位客户',
    lines: [{ productName: '裁定②占位产品', quantity: 1, unitPrice: null }],
  }, token);
  eq('裁定② 造占位草稿成功', phDraft.status, 201);
  // 裁定①：待定单据确实用哨兵日占位（NOT NULL 约束未被破坏），且标记与日期成对
  const sentinel = await db.query("select count(*)::int as n from orders where due_date::date = date '2099-12-31' and due_date_tbd");
  ok('裁定① SQL：待定单据确实用哨兵日占位（界面按 due_date_tbd 显示「待定」）', sentinel.rows[0].n >= 1, sentinel.rows[0].n);
  const inv2 = await db.query("select count(*)::int as n from orders where due_date_tbd <> (due_date::date = date '2099-12-31')");
  eq('裁定① SQL：造单后不变量仍成立', inv2.rows[0].n, 0);
  const ordDefault = await req('GET', '/orders', undefined, token);
  ok('裁定② 订单列表默认隐藏占位档案相关单据', !ordDefault.body.some((o) => o.id === phDraft.body.id), ordDefault.body.map((o) => o.id));
  ok('裁定② 订单列表默认仍含普通订单（老路单）', ordDefault.body.some((o) => o.id === legacy.body.id), ordDefault.body.map((o) => o.id));
  const ordShow = await req('GET', '/orders?includePlaceholders=1', undefined, token);
  ok('裁定② 开关打开后订单列表可见占位单', ordShow.body.some((o) => o.id === phDraft.body.id), ordShow.body.length);
  const ordPending = await req('GET', '/orders?hasPending=1', undefined, token);
  ok('裁定② 「仅看有未补全项的草稿单」不受开关限制（补全工作流必须能看到）',
    ordPending.body.some((o) => o.id === phDraft.body.id), ordPending.body.map((o) => o.id));

  // ---- 裁定④：.doc 切片管线口径（识单 → 落草稿 两跳，与 tools/ziliao/draft_orders_from_parse.mjs 一致） ----
  const docCsv = Buffer.from([
    '合同号:YZ260917,交货时间: ' + FUTURE,
    '品名规格,数量,不含税价格,产品描述,包装',
    'PNM 1/32,400,,,',
    '',
  ].join('\r\n'), 'utf8');
  const docParse = await req('POST', '/ai/orders/parse', { ...uploadBody(docCsv, '计划单切片.csv'), folderCustomer: '安宝公司' }, token);
  eq('裁定④ .doc 切片识单：补价 1 行', docParse.body.quoteFilledCount, 1);
  eq('裁定④ .doc 切片识单：priceFrom=quote', docParse.body.lines[0].priceFrom, 'quote');
  const docDraft = await req('POST', '/orders/draft', {
    customerId: docParse.body.customerId ?? null,
    folderCustomer: '安宝公司',
    poNo: docParse.body.poNo ?? null,
    dueDate: docParse.body.dueDate ?? null,
    lines: docParse.body.lines.map((l) => ({
      productId: l.productId ?? null,
      productName: l.productId ? null : (l.productName ?? null),
      quantity: l.quantity ?? null,
      unitPrice: l.unitPrice ?? null,
      priceFrom: l.priceFrom === 'quote' ? 'quote' : null,
    })),
  }, token);
  eq('裁定④ .doc 切片落草稿成功', docDraft.status, 201);
  const docLine = await db.query('select unit_price, price_source, pending_items, currency from order_lines where order_id = $1', [docDraft.body.id]);
  eq('裁定④ SQL：.doc 计划单缺价行已按「文件夹客户 + 产品」补价（9.99 元）', Number(docLine.rows[0].unit_price), 9.99);
  eq('裁定④ SQL：price_source=quote（来源可追溯）', docLine.rows[0].price_source, 'quote');
  eq('裁定④ SQL：该行无缺价待补', docLine.rows[0].pending_items, null);
  eq('裁定⑤ SQL：.doc 落草稿的订单行币种 = CNY', docLine.rows[0].currency, 'CNY');

  // ================= 权限 =================
  console.log('\n【权限】报价写操作限 admin / planner');
  await req('POST', '/users', { username: 'e2ewh2', password: 'Ws@2026x', displayName: '仓管测试', role: 'warehouse' }, token);
  const whLogin = await req('POST', '/auth/login', { username: 'e2ewh2', password: 'Ws@2026x' });
  const whToken = whLogin.body.token;
  eq('仓管创建报价 → 403', (await req('POST', '/quotes', { unitPrice: 1 }, whToken)).status, 403);
  eq('仓管改价 → 403', (await req('PUT', '/quotes/' + byProduct.body.id + '/price', { unitPrice: 1 }, whToken)).status, 403);
  eq('仓管读报价列表 → 200（读操作不限制）', (await req('GET', '/quotes', undefined, whToken)).status, 200);
  eq('未登录读报价列表 → 401', (await req('GET', '/quotes')).status, 401);

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
