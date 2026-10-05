/**
 * Excel / CSV 订单导入 · 端到端自测脚本（真实 HTTP 接口 + 真实 PostgreSQL 断言）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) 多行订单 .xlsx 上传 → 解析明细（客户/产品/数量/单价/金额(分)）→ 生成草稿订单 → 库里核对
 *   2) CSV（UTF-8）与 CSV（GBK）各跑一遍（同一套断言）
 *   3) 边界：.xls 明确中文提示、未登录 401、workshop 角色 403、图片走 vision 分支、
 *      表头缺客户列 → LLM 兜底通道（未配 key 时回退规则映射并给中文提示）
 *
 * 前置：一个连到**空库**的 API 实例（会自动建表 + 种子 admin/Fms@2026），例如：
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_test JWT_SECRET=e2e \
 *   PORT=3100 node dist/main
 * 运行：node test/excel-order-e2e.mjs
 * 环境变量：E2E_BASE（默认 http://127.0.0.1:3100/api）、E2E_PG_*（默认 localhost:15432）
 */
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import pg from 'pg';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3100/api';
const PG_CONF = {
  host: process.env.E2E_PG_HOST ?? 'localhost',
  port: Number(process.env.E2E_PG_PORT ?? 15432),
  user: process.env.E2E_PG_USER ?? 'fms',
  password: process.env.E2E_PG_PASSWORD ?? 'fms',
  database: process.env.E2E_PG_DB ?? 'fms_test',
};

const FUTURE = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10); // 交期必须晚于今天

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

/** 上传入口：文件 → dataURL + fileName（与前端 AiOrderImport 完全同一协议） */
function uploadBody(buffer, fileName) {
  return { file: 'data:application/octet-stream;base64,' + buffer.toString('base64'), fileName };
}

/** 造多行订单 xlsx（中文表头：客户 / 客户PO号 / 产品 / 数量 / 单价 / 交期 / 备注） */
async function buildXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('订单明细');
  ws.addRow(['客户', '客户PO号', '产品', '数量', '单价', '交期', '备注']);
  // 数量带千分位、单价带货币符号：验证归一
  ws.addRow(['杭州测试客户', 'PO-2026-0901', 'ANM 3', '2,000', '¥4.20', FUTURE, '加急']);
  ws.addRow(['', '', 'PNM 1/32', 500, 3.8, '', '']);
  ws.addRow(['', '', '6290', '1,200', '5.50', '', '纸箱包装']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const CSV_LINES = [
  '客户,客户PO号,产品,数量,单价,交期,备注',
  '杭州测试客户,PO-CSV-01,ANM 3,2000,4.20,' + FUTURE + ',加急',
  '杭州测试客户,PO-CSV-01,PNM 1/32,500,3.80,' + FUTURE + ',',
];

/** 造 CSV 字节流：encoding = utf8 | gbk */
function buildCsv(encoding) {
  const text = CSV_LINES.join('\r\n');
  return encoding === 'gbk' ? iconv.encode(text, 'gbk') : Buffer.from(text, 'utf8');
}

const EXPECTED = {
  xlsx: {
    poNo: 'PO-2026-0901',
    lines: [
      { product: 'ANM 3', qty: 2000, unitPrice: 4.2, cents: 840000 },
      { product: 'PNM 1/32', qty: 500, unitPrice: 3.8, cents: 190000 },
      { product: '6290', qty: 1200, unitPrice: 5.5, cents: 660000 },
    ],
  },
  csv: {
    poNo: 'PO-CSV-01',
    lines: [
      { product: 'ANM 3', qty: 2000, unitPrice: 4.2, cents: 840000 },
      { product: 'PNM 1/32', qty: 500, unitPrice: 3.8, cents: 190000 },
    ],
  },
};

/** 一次完整流程：上传 → 断言解析 → 生成草稿订单 → 库里核对（返回统计） */
async function runImportFlow(token, db, label, buffer, fileName, expected) {
  console.log('\n【' + label + '】上传 ' + fileName + '（' + buffer.length + ' 字节）');
  const parsed = await req('POST', '/ai/orders/parse', uploadBody(buffer, fileName), token);
  ok(label + ' 上传解析接口成功（2xx）', parsed.status >= 200 && parsed.status < 300, parsed.status);
  const r = parsed.body;
  eq(label + ' 走表头规则映射（不调 LLM）', r.parseSource, 'table-rule');
  eq(label + ' 客户命中档案', r.customerName, '杭州测试客户');
  eq(label + ' 客户主数据匹配', r.customerMatch, 'exact');
  eq(label + ' 客户 PO 号', r.poNo, expected.poNo);
  eq(label + ' 交期', r.dueDate, FUTURE);
  eq(label + ' 明细行数（一单多行）', r.lines.length, expected.lines.length);
  expected.lines.forEach((exp, i) => {
    const line = r.lines[i];
    eq(label + ' 第' + (i + 1) + '行 产品名', line.productName, exp.product);
    eq(label + ' 第' + (i + 1) + '行 数量', line.quantity, exp.qty);
    eq(label + ' 第' + (i + 1) + '行 单价', line.unitPrice, exp.unitPrice);
    eq(label + ' 第' + (i + 1) + '行 金额(分)', line.amountCents, exp.cents);
    ok(label + ' 第' + (i + 1) + '行 产品命中目录', line.productId !== null, line.productId);
  });
  eq(label + ' 合计金额(分)', r.totalCents, expected.lines.reduce((s, l) => s + l.cents, 0));
  eq(label + ' 全字段直通', r.directPass, true);

  // 生成草稿订单（复用既有 POST /orders：创建态恒为 draft）
  const created = await req('POST', '/orders', {
    customerId: r.customerId,
    poNo: r.poNo,
    dueDate: r.dueDate,
    note: r.note,
    lines: r.lines.map((l) => ({
      productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
      currency: l.currency, engraving: l.engraving, packaging: l.packaging,
    })),
  }, token);
  ok(label + ' 建单接口成功（2xx，POST 返回 201）', created.status >= 200 && created.status < 300, created.status);
  eq(label + ' 新订单状态 = 草稿（不自动确认）', created.body.status, 'draft');
  const orderId = created.body.id;
  console.log('  ℹ️  已生成草稿订单 ' + created.body.orderNo + '（id=' + orderId + '）');

  // ---- 库里核对：单头 + 明细行数 + 金额（分） ----
  const o = await db.query('select id, order_no, status, po_no from orders where id = $1', [orderId]);
  eq(label + ' 库中订单状态', o.rows[0].status, 'draft');
  const lines = await db.query(
    'select product_id, quantity, unit_price, quantity * round(unit_price * 100) as amount_cents '
    + 'from order_lines where order_id = $1 order by id', [orderId]);
  eq(label + ' 库中明细行数', lines.rows.length, expected.lines.length);
  lines.rows.forEach((row, i) => {
    const exp = expected.lines[i];
    eq(label + ' 库中第' + (i + 1) + '行 数量', row.quantity, exp.qty);
    eq(label + ' 库中第' + (i + 1) + '行 单价(2位小数)', Number(row.unit_price), exp.unitPrice);
    eq(label + ' 库中第' + (i + 1) + '行 金额(分)', Number(row.amount_cents), exp.cents);
  });
  const sum = await db.query(
    'select coalesce(sum(quantity * round(unit_price * 100)), 0) as total_cents from order_lines where order_id = $1',
    [orderId]);
  eq(label + ' 库中订单合计(分)', Number(sum.rows[0].total_cents), r.totalCents);
  return { orderId, orderNo: created.body.order_no };
}

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
  console.log('\n【主数据】客户 + 产品目录');
  const cust = await req('POST', '/customers', { name: '杭州测试客户', creditDays: 30 }, token);
  const customerId = (cust.body && cust.body.id) || (await req('GET', '/customers', undefined, token)).body.find((c) => c.name === '杭州测试客户').id;
  const prodSpecs = [['ANM 3', 'uk_acetylene'], ['PNM 1/32', 'uk_propane'], ['6290', 'us_acetylene']];
  const productIds = {};
  for (const [name, type] of prodSpecs) {
    const res = await req('POST', '/products', { name, type }, token);
    productIds[name] = res.body && res.body.id ? res.body.id : undefined;
  }
  const allProducts = (await req('GET', '/products', undefined, token)).body;
  for (const [name] of prodSpecs) {
    if (!productIds[name]) productIds[name] = allProducts.find((p) => p.name === name).id;
  }
  ok('客户已建档（id=' + customerId + '）', !!customerId);
  ok('产品已建档', Object.keys(productIds).length === 3, productIds);

  // ---------- 1) Excel 端到端 ----------
  await runImportFlow(token, db, 'Excel(.xlsx) 多行订单', await buildXlsx(), '订单-多行.xlsx', EXPECTED.xlsx);

  // ---------- 2) CSV UTF-8 / GBK ----------
  await runImportFlow(token, db, 'CSV(UTF-8)', buildCsv('utf8'), '订单-utf8.csv', EXPECTED.csv);
  await runImportFlow(token, db, 'CSV(GBK)', buildCsv('gbk'), '订单-gbk.csv', EXPECTED.csv);

  // ---------- 3) 边界与分支 ----------
  console.log('\n【分支与边界】');

  // .xls → 明确中文提示
  const xls = await req('POST', '/ai/orders/parse', uploadBody(Buffer.from('d0cf11e0a1b11ae1', 'hex'), '旧版订单.xls'), token);
  eq('.xls 返回 400', xls.status, 400);
  ok('.xls 中文提示「请另存为 .xlsx 或 .csv」', String(xls.body.message).includes('请用 Excel 另存为 .xlsx 或 .csv 后重试'), xls.body.message);

  // .pdf → 明确中文提示（原有 PDF 场景不静默失败）
  const pdf = await req('POST', '/ai/orders/parse', uploadBody(Buffer.from('%PDF-1.4 test'), '订单.pdf'), token);
  eq('.pdf 返回 400', pdf.status, 400);
  ok('.pdf 中文提示', String(pdf.body.message).includes('PDF 暂不支持直接解析'), pdf.body.message);

  // 图片分支：仍走既有 vision 通道（测试实例未配 AI key → 明确中文报错，证明分支未被表格改动影响）
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const img = await req('POST', '/ai/orders/parse', { image: 'data:image/png;base64,' + png.toString('base64') }, token);
  // 未配识图 Key 时，既有 vision 通道的报错原样透出（502 + 中文原因）；改动前后必须一致
  eq('图片分支（image 字段）状态与改动前一致 = 502', img.status, 502);
  ok('图片分支中文提示未变（识图 Key 未配置）', String(img.body.message).includes('识图 API Key 未配置'), img.body.message);
  // 新增的上传入口同样支持图片文件（前端现在统一走 file+fileName）
  const imgFile = await req('POST', '/ai/orders/parse', uploadBody(png, '订单照片.png'), token);
  eq('图片文件分支状态与改动前一致 = 502', imgFile.status, 502);
  ok('图片文件分支仍走 vision（同一中文提示）', String(imgFile.body.message).includes('识图 API Key 未配置'), imgFile.body.message);

  // 表头缺客户列 → 走 LLM 兜底通道（本实例未配对话 key → 回退规则映射并给中文提示）
  const noCustomer = Buffer.from('产品,数量,单价\nANM 3,300,4.10', 'utf8');
  const llmFallback = await req('POST', '/ai/orders/parse', uploadBody(noCustomer, '无客户列.csv'), token);
  eq('缺客户列 → parseSource=table-llm', llmFallback.body.parseSource, 'table-llm');
  eq('缺客户列 → 诊断标记 usedLlm=true', llmFallback.body.table.usedLlm, true);
  ok('缺客户列 → 仍带回规则映射的产品行',
    llmFallback.body.lines.length === 1 && llmFallback.body.lines[0].productName === 'ANM 3',
    llmFallback.body.lines.map((l) => l.productName));
  ok('缺客户列 → 中文提示回退原因', llmFallback.body.notes.join('；').includes('回退表头规则映射'), llmFallback.body.notes);

  // 鉴权：未登录 401
  const anon = await req('POST', '/ai/orders/parse', { text: 'x' });
  eq('未登录 → 401', anon.status, 401);

  // 鉴权：workshop 角色 → 403（识别订单类写操作限 planner/admin）
  await req('POST', '/users', { username: 'e2eworkshop', password: 'Ws@2026x', displayName: '车间测试', role: 'workshop' }, token);
  const wsLogin = await req('POST', '/auth/login', { username: 'e2eworkshop', password: 'Ws@2026x' });
  eq('workshop 账号登录成功', wsLogin.status, 200);
  const wsToken = wsLogin.body.token;
  const forbidden = await req('POST', '/ai/orders/parse', { text: 'x' }, wsToken);
  eq('workshop 调用识别接口 → 403', forbidden.status, 403);
  ok('403 中文原因含所需角色', String(forbidden.body.message).includes('需要'), forbidden.body.message);
  // workshop 仍可读（既有约定：读操作不限制）
  eq('workshop 仍可读取订单列表', (await req('GET', '/orders', undefined, wsToken)).status, 200);

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
