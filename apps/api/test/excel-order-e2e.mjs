/**
 * Excel / CSV 订单导入 · 端到端自测脚本（真实 HTTP 接口 + 真实 PostgreSQL 断言）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) 多行订单 .xlsx 上传 → 解析明细（客户/产品/数量/单价/金额(分)）→ 生成草稿订单 → 库里核对
 *   2) 多行订单 .xls（BIFF8/OLE2，含合并单元格与日期序列号单元格）跑同一套断言
 *   3) CSV（UTF-8）与 CSV（GBK）各跑一遍（同一套断言）
 *   4) 边界：损坏 .xls 中文提示、.xls 内容误命名成 .xlsx 仍按 BIFF8 解析、.pdf 明确中文提示、
 *      未登录 401、workshop 角色 403、图片走 vision 分支、
 *      表头缺客户列 → LLM 兜底通道（未配 key 时回退规则映射并给中文提示）
 *
 * 前置：一个连到**空库**的 API 实例（会自动建表 + 种子 admin/Fms@2026），例如：
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_test JWT_SECRET=e2e \
 *   PORT=3100 node dist/main
 * 运行：node test/excel-order-e2e.mjs
 * 环境变量：E2E_BASE（默认 http://127.0.0.1:3100/api）、E2E_PG_*（默认 localhost:15432）
 */
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
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

/** YYYY-MM-DD → Excel 1900 日期系统序列号（写成日期单元格用；与运行时区无关） */
function excelSerial(iso) {
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse('1899-12-30T00:00:00Z')) / 86400000);
}

/**
 * 造多行订单 .xls（BIFF8 / OLE2 复合文档）：表头用别名（客户简称 / 品名 / 交货日期）验证容错，
 * 客户名跨 3 行合并（取左上值），交期用「日期序列号 + 日期格式」单元格（验证 cellDates 归一）。
 */
function buildXls() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['客户简称', '客户PO号', '品名', '数量', '单价', '交货日期', '包装要求'],
    ['杭州测试客户', 'PO-XLS-01', 'ANM 3', '2,000', '¥4.20', excelSerial(FUTURE), '纸箱'],
    ['', '', 'PNM 1/32', 500, 3.8, '', ''],
    ['', '', '6290', '1,200', '5.50', '', '纸箱包装'],
  ]);
  ws['F2'].z = 'yyyy-mm-dd'; // 日期单元格（序列号 + 日期数字格式）
  ws['!merges'] = [XLSX.utils.decode_range('A2:A4')]; // 合并单元格：只在左上角存值
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '订单明细');
  return Buffer.from(XLSX.write(wb, { bookType: 'biff8', type: 'buffer', cellDates: true }));
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
  xls: {
    poNo: 'PO-XLS-01',
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
  await runImportFlow(token, db, 'Excel(.xls BIFF8) 多行订单', buildXls(), '订单-多行.xls', EXPECTED.xls);

  // ---------- 2) CSV UTF-8 / GBK ----------
  await runImportFlow(token, db, 'CSV(UTF-8)', buildCsv('utf8'), '订单-utf8.csv', EXPECTED.csv);
  await runImportFlow(token, db, 'CSV(GBK)', buildCsv('gbk'), '订单-gbk.csv', EXPECTED.csv);

  // ---------- 2b) 本轮：按「基础型号 + 尺寸」匹配与补价（识单 + 取价） ----------
  console.log('\n【本轮】基础型号 + 尺寸：Excel/CSV 订单里的写法差异也能命中，size 必须逐字符一致');
  await req('POST', '/products', { name: '1-1-101', type: 'us_acetylene' }, token);
  // 档案可能已存在（同一实例里前面的用例也会建档）→ 一律以「名称精确命中的那条」为准
  const msProd = (await req('GET', '/products', undefined, token)).body.find((p) => p.name === '1-1-101');
  const msQuote = await req('POST', '/quotes', {
    customerId, productName: 'Victor 乙炔割嘴 1-1-101', unitPrice: 13.20, currency: 'CNY', validFrom: '2020-01-01', source: 'contract',
  }, token);
  ok('建档 1-1-101 + 合同写法报价「Victor 乙炔割嘴 1-1-101」', !!msProd.id && msQuote.status === 201, [msProd?.id, msQuote.body?.id]);

  // 计划单写法（无品牌前缀、无单价）→ 识单按「基础型号+尺寸」落到档案，并按合同写法补价
  const msCsv = Buffer.from(['产品名称,数量', '1-1-101,100', '2-1-101,200'].join('\r\n'), 'utf8');
  const msParse = await req('POST', '/ai/orders/parse', { ...uploadBody(msCsv, '计划单型号尺寸.csv'), folderCustomer: '杭州测试客户' }, token);
  eq('识单：1-1-101 → 档案「1-1-101」（基础型号+尺寸）', msParse.body.lines[0].productId, msProd.id);
  eq('识单补价：品牌前缀差异被忽略，1-1-101 → 13.20', msParse.body.lines[0].unitPrice, 13.2);
  eq('识单补价行数 = 1', msParse.body.quoteFilledCount, 1);
  ok('识单：2-1-101（另一个 size）保持缺价，不跨尺寸补价', msParse.body.lines[1].unitPrice == null, msParse.body.lines[1].unitPrice);

  // 合同写法直接出现在表里（Excel 族常见）→ 也应落到同一档案
  const brandCsv = Buffer.from(['产品名称,数量', 'Victor 乙炔割嘴 1-1-101,50'].join('\r\n'), 'utf8');
  const brandParse = await req('POST', '/ai/orders/parse', { ...uploadBody(brandCsv, '品牌写法.csv'), folderCustomer: '杭州测试客户' }, token);
  eq('识单：品牌写法 → 档案「1-1-101」', brandParse.body.lines[0].productId, msProd.id);
  eq('识单补价：品牌写法 → 13.20（与档案名不同也命中）', brandParse.body.lines[0].unitPrice, 13.2);
  eq('识单补价：品牌写法行数 = 1', brandParse.body.quoteFilledCount, 1);

  // ---------- 3) 边界与分支 ----------
  console.log('\n【分支与边界】');

  // .xls → 已支持（不再给「请另存为」提示）；只有损坏文件才报错，且为中文提示
  const brokenXls = await req('POST', '/ai/orders/parse', uploadBody(Buffer.from('d0cf11e0a1b11ae1', 'hex'), '损坏订单.xls'), token);
  eq('损坏 .xls 返回 400', brokenXls.status, 400);
  ok('损坏 .xls 中文提示（非库原始英文错误）', String(brokenXls.body.message).includes('无法读取该 .xls 文件'), brokenXls.body.message);

  // 扩展名写错：BIFF8 内容命名为 .xlsx → 仍按 magic bytes 正确解析（不再解析失败）
  const misnamed = await req('POST', '/ai/orders/parse', uploadBody(buildXls(), '误命名.xlsx'), token);
  ok('扩名谎报 .xlsx 的 .xls 内容仍能解析（2xx）', misnamed.status >= 200 && misnamed.status < 300, misnamed.status);
  eq('扩名谎报 → 仍走表头规则映射', misnamed.body.parseSource, 'table-rule');
  eq('扩名谎报 → 明细行数正确', misnamed.body.lines.length, 3);
  eq('扩名谎报 → 客户命中档案', misnamed.body.customerName, '杭州测试客户');

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
