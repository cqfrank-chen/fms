/**
 * 主数据批量导入（客户 / 产品）· 端到端自测脚本（真实 HTTP 接口 + 真实 PostgreSQL 断言）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) 20 行客户 .xlsx（15 条有效 + 表内重复 2 + 空名称 1 + 结算方式无法识别 1 + 账期非数字 1）
 *      上传 → **预览校验**（断言 新增/跳过/错误 分类与中文原因）→ 确认导入 → SQL 核对数量与关键字段
 *   2) 再导入一次（仅新增模式）验证幂等：全部跳过、库中不产生重复；换 upsert 模式改联系人 + 新增 2 条
 *   3) 20 行产品 .xlsx（型号/类型/默认包装/安全库存）同上，并核对类型词表映射落库值
 *   4) .csv（GBK）与 .xls（BIFF8）各跑一遍客户导入（复用任务一的解析通道）
 *   5) 边界：未登录 401、workshop 角色 403（中文原因）、模板下载（CSV + BOM + 中文表头）、缺必填列 400
 *
 * 前置：一个连到**空库**的 API 实例（会自动建表 + 种子 admin/Fms@2026），例如：
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_test JWT_SECRET=e2e \
 *   PORT=3100 node dist/main
 * 运行：node test/master-data-import-e2e.mjs
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
  return { status: res.status, body: json, headers: res.headers, raw: text };
}

/** 上传入口：文件 → dataURL + fileName（与前端完全同一协议） */
function uploadBody(buffer, fileName) {
  return { file: 'data:application/octet-stream;base64,' + buffer.toString('base64'), fileName };
}

const pad2 = (n) => String(n).padStart(2, '0');

// ============ 造数据：20 行客户（15 有效 + 5 脏） ============

async function buildCustomersXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('客户导入');
  ws.addRow(['客户名称', '联系人', '结算方式', '账期天数']);
  for (let i = 1; i <= 15; i++) {
    ws.addRow(['批量客户' + pad2(i), '联系人' + i, i % 2 ? '月结30天' : '现结', i % 2 ? 30 : 0]);
  }
  ws.addRow(['批量客户01', '重复行A', '现结', 0]); // 表内重复（第 2 行已出现）
  ws.addRow(['批量客户02', '重复行B', '现结', 0]); // 表内重复
  ws.addRow(['', '无名称', '现结', 0]); // 必填为空
  ws.addRow(['批量客户98', '结算错', '货到付款', 0]); // 结算方式不在词表
  ws.addRow(['批量客户99', '账期错', '现结', '看情况']); // 账期非数字
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 第二次导入用的客户表（upsert）：沿用 15 个名称但联系人全部改名 + 新增 2 条 */
async function buildCustomersXlsxV2() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('客户导入');
  ws.addRow(['客户名称', '联系人', '结算方式', '账期天数']);
  for (let i = 1; i <= 15; i++) {
    ws.addRow(['批量客户' + pad2(i), '改版联系人' + i, i % 2 ? '月结30天' : '现结', i % 2 ? 30 : 0]);
  }
  ws.addRow(['批量客户16', '新增联系人16', '月结60天', 60]);
  ws.addRow(['批量客户17', '新增联系人17', '现结', 0]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ============ 造数据：20 行产品（15 有效 + 5 脏） ============

const TYPE_LABELS = ['英式乙炔', '英式丙烷', '美式乙炔', '美式丙烷'];
const TYPE_VALUES = ['uk_acetylene', 'uk_propane', 'us_acetylene', 'us_propane'];

async function buildProductsXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('产品导入');
  ws.addRow(['型号', '类型', '默认包装', '安全库存']);
  for (let i = 1; i <= 15; i++) {
    ws.addRow(['批量型号' + pad2(i), TYPE_LABELS[(i - 1) % 4], '包装盒×' + i, i * 10]);
  }
  ws.addRow(['批量型号01', '英式乙炔', '', 0]); // 表内重复
  ws.addRow(['批量型号02', '英式乙炔', '', 0]); // 表内重复
  ws.addRow(['批量型号97', '', '', 0]); // 必填类型为空
  ws.addRow(['批量型号98', '乙炔类', '', 0]); // 类型不在词表
  ws.addRow(['', '英式乙炔', '', 0]); // 必填型号为空
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 造 .xls（BIFF8/OLE2）：3 条新客户 */
function buildCustomersXls() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['客户简称', '联系人', '结算方式', '账期'],
    ['XLS客户A', '张三', '现结', 0],
    ['XLS客户B', '李四', '月结30天', 30],
    ['XLS客户C', '王五', '30%定金+70%发货前', 15],
  ]), '客户');
  return Buffer.from(XLSX.write(wb, { bookType: 'biff8', type: 'buffer', cellDates: true }));
}

/** 造 .csv（GBK）：2 条新客户（验证中文编码 + 分隔符自动探测） */
function buildCustomersCsvGbk() {
  const text = ['客户名称,联系人,结算方式,账期天数', 'CSV客户A,赵六,现结,0', 'CSV客户B,孙七,月结30天,30'].join('\r\n');
  return iconv.encode(text, 'gbk');
}

const base64 = (buf, name) => uploadBody(buf, name);

async function countRows(db, table, like) {
  const r = await db.query('select count(*)::int as n from ' + table + (like ? ' where name like $1' : ''), like ? [like] : []);
  return r.rows[0].n;
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

  const custBefore = await countRows(db, 'customers', '批量客户%');
  const prodBefore = await countRows(db, 'products', '批量型号%');
  eq('导入前无批量客户残留', custBefore, 0);
  eq('导入前无批量产品残留', prodBefore, 0);

  // ---------- 1) 客户导入：预览 ----------
  console.log('\n【1. 客户导入 · 预览校验（不写库）】');
  const custXlsx = await buildCustomersXlsx();
  const preview = await req('POST', '/master-data/import/preview', { ...base64(custXlsx, '客户批量.xlsx'), target: 'customers', mode: 'insert-only' }, token);
  ok('预览接口成功（2xx）', preview.status >= 200 && preview.status < 300, preview.status);
  const p = preview.body;
  eq('解析通道 = xlsx', p.fileKind, 'xlsx');
  eq('表头行下标', p.headerRowIndex, 0);
  eq('列映射', p.columns, { name: 0, contact: 1, settlement: 2, creditDays: 3 });
  eq('未映射列（无）', p.unmappedHeaders, []);
  eq('总数据行数', p.summary.total, 20);
  eq('新增 15 条', p.summary.new, 15);
  eq('跳过 0 条', p.summary.skip, 0);
  eq('错误 5 条', p.summary.error, 5);
  eq('第 1 行结论 = 新增', p.rows[0].status, 'new');
  eq('第 1 行客户名', p.rows[0].data.name, '批量客户01');
  eq('第 1 行结算方式归一', p.rows[0].data.settlement, 'monthly_30');
  eq('第 1 行账期', p.rows[0].data.creditDays, 30);
  eq('第 16 行（表内重复）结论 = 错误', p.rows[15].status, 'error');
  ok('表内重复中文原因', String(p.rows[15].reasons[0]).includes('与表内第 2 行重复'), p.rows[15].reasons);
  ok('空名称中文原因', String(p.rows[17].reasons[0]).includes('客户名称不能为空'), p.rows[17].reasons);
  ok('结算方式无法识别中文原因', String(p.rows[18].reasons[0]).includes('结算方式「货到付款」无法识别'), p.rows[18].reasons);
  ok('账期非数字中文原因', String(p.rows[19].reasons[0]).includes('不是非负整数'), p.rows[19].reasons);
  eq('预览后库中仍无批量客户（上传不写库）', await countRows(db, 'customers', '批量客户%'), 0);

  // ---------- 2) 客户导入：确认 ----------
  console.log('\n【2. 客户导入 · 确认导入】');
  const commit = await req('POST', '/master-data/import/commit', { ...base64(custXlsx, '客户批量.xlsx'), target: 'customers', mode: 'insert-only' }, token);
  ok('确认导入接口成功（2xx）', commit.status >= 200 && commit.status < 300, commit.status);
  const c = commit.body;
  eq('导入统计', c.summary, { total: 20, new: 15, update: 0, skip: 0, error: 5 });
  eq('新增明细条数', c.created.length, 15);
  eq('失败清单条数', c.failures.length, 5);
  ok('失败清单含行号与原因', c.failures.every((f) => typeof f.rowNo === 'number' && !!f.reason), c.failures[0]);
  eq('库中批量客户数量', await countRows(db, 'customers', '批量客户%'), 15);
  const custRow = await db.query("select name, contact, settlement, credit_days from customers where name = '批量客户01'");
  eq('库中客户名', custRow.rows[0].name, '批量客户01');
  eq('库中联系人', custRow.rows[0].contact, '联系人1');
  eq('库中结算方式（词表值）', custRow.rows[0].settlement, 'monthly_30');
  eq('库中账期天数', custRow.rows[0].credit_days, 30);
  const custRow2 = await db.query("select settlement, credit_days from customers where name = '批量客户02'");
  eq('库中结算方式（现结）', custRow2.rows[0].settlement, 'cash');
  eq('库中账期天数（0）', custRow2.rows[0].credit_days, 0);

  // ---------- 3) 幂等：再导入一次 ----------
  console.log('\n【3. 幂等复跑 · 仅新增模式（应全部跳过）】');
  const again = await req('POST', '/master-data/import/commit', { ...base64(custXlsx, '客户批量.xlsx'), target: 'customers', mode: 'insert-only' }, token);
  eq('二次导入统计', again.body.summary, { total: 20, new: 0, update: 0, skip: 15, error: 5 });
  eq('库中批量客户数量不变（无重复）', await countRows(db, 'customers', '批量客户%'), 15);
  eq('二次导入无新增', again.body.created.length, 0);
  eq('二次导入失败清单仍为 5 条脏数据', again.body.failures.length, 5);
  ok('二次导入失败清单不再含「重复建档」类问题', again.body.failures.every((x) => !String(x.reason).includes('已存在')), again.body.failures[0].reason);

  console.log('\n【3b. 幂等复跑 · 新增或更新模式（联系人改名 + 新增 2 条）】');
  const custXlsxV2 = await buildCustomersXlsxV2();
  const preview2 = await req('POST', '/master-data/import/preview', { ...base64(custXlsxV2, '客户批量V2.xlsx'), target: 'customers', mode: 'upsert' }, token);
  eq('upsert 预览统计', preview2.body.summary, { total: 17, new: 2, update: 15, skip: 0, error: 0 });
  eq('更新行变化字段', preview2.body.rows[0].changedFields, ['contact']);
  const commit2 = await req('POST', '/master-data/import/commit', { ...base64(custXlsxV2, '客户批量V2.xlsx'), target: 'customers', mode: 'upsert' }, token);
  eq('upsert 导入统计', commit2.body.summary, { total: 17, new: 2, update: 15, skip: 0, error: 0 });
  eq('库中批量客户数量（15 + 2）', await countRows(db, 'customers', '批量客户%'), 17);
  const upd = await db.query("select contact from customers where name = '批量客户01'");
  eq('更新后联系人已落库', upd.rows[0].contact, '改版联系人1');
  const liveCount = await db.query("select count(*)::int as n from customers where name in ('批量客户01','批量客户02')");
  eq('同名客户未被重复建档', liveCount.rows[0].n, 2);

  // ---------- 4) 产品导入 ----------
  console.log('\n【4. 产品导入 · 预览 + 确认】');
  const prodXlsx = await buildProductsXlsx();
  const pPreview = await req('POST', '/master-data/import/preview', { ...base64(prodXlsx, '产品批量.xlsx'), target: 'products', mode: 'insert-only' }, token);
  ok('产品预览接口成功（2xx）', pPreview.status >= 200 && pPreview.status < 300, pPreview.status);
  const pp = pPreview.body;
  eq('列映射', pp.columns, { name: 0, type: 1, defaultPackaging: 2, safetyStock: 3 });
  eq('产品总数据行数', pp.summary.total, 20);
  eq('产品新增 15 条', pp.summary.new, 15);
  eq('产品错误 5 条', pp.summary.error, 5);
  eq('第 1 行类型归一（英式乙炔）', pp.rows[0].data.type, 'uk_acetylene');
  eq('第 2 行类型归一（英式丙烷）', pp.rows[1].data.type, 'uk_propane');
  eq('第 3 行类型归一（美式乙炔）', pp.rows[2].data.type, 'us_acetylene');
  eq('第 4 行类型归一（美式丙烷）', pp.rows[3].data.type, 'us_propane');
  ok('产品表内重复中文原因', String(pp.rows[15].reasons[0]).includes('与表内第 2 行重复'), pp.rows[15].reasons);
  ok('类型为空中文原因', String(pp.rows[17].reasons[0]).includes('类型不能为空'), pp.rows[17].reasons);
  ok('类型无法识别中文原因', String(pp.rows[18].reasons[0]).includes('类型「乙炔类」无法识别'), pp.rows[18].reasons);
  ok('型号为空中文原因', String(pp.rows[19].reasons[0]).includes('型号不能为空'), pp.rows[19].reasons);

  const pCommit = await req('POST', '/master-data/import/commit', { ...base64(prodXlsx, '产品批量.xlsx'), target: 'products', mode: 'insert-only' }, token);
  eq('产品导入统计', pCommit.body.summary, { total: 20, new: 15, update: 0, skip: 0, error: 5 });
  eq('库中批量产品数量', await countRows(db, 'products', '批量型号%'), 15);
  const prodRow = await db.query("select name, type, default_packaging, default_routing, safety_stock from products where name = '批量型号01'");
  eq('库中产品名', prodRow.rows[0].name, '批量型号01');
  eq('库中产品类型（枚举落库值）', prodRow.rows[0].type, 'uk_acetylene');
  eq('库中默认包装', prodRow.rows[0].default_packaging, '包装盒×1');
  eq('库中安全库存', prodRow.rows[0].safety_stock, 10);
  // 第 4 行 = 美式丙烷（类型词表第 4 项，验证 i%4 轮转映射正确落库）
  const prodRow4 = await db.query("select type, safety_stock from products where name = '批量型号04'");
  eq('第 4 行类型（美式丙烷）', prodRow4.rows[0].type, 'us_propane');
  eq('第 4 行安全库存', prodRow4.rows[0].safety_stock, 40);

  console.log('\n【4b. 产品幂等复跑（仅新增 → 全部跳过）】');
  const pAgain = await req('POST', '/master-data/import/commit', { ...base64(prodXlsx, '产品批量.xlsx'), target: 'products', mode: 'insert-only' }, token);
  eq('产品二次导入统计', pAgain.body.summary, { total: 20, new: 0, update: 0, skip: 15, error: 5 });
  eq('库中批量产品数量不变', await countRows(db, 'products', '批量型号%'), 15);

  // ---------- 5) .xls / .csv 通道 ----------
  console.log('\n【5. .xls（BIFF8）与 .csv（GBK）客户导入】');
  const xlsPreview = await req('POST', '/master-data/import/preview', { ...base64(buildCustomersXls(), '客户.xls'), target: 'customers', mode: 'insert-only' }, token);
  eq('.xls 解析通道', xlsPreview.body.fileKind, 'xls');
  eq('.xls 预览新增 3', xlsPreview.body.summary.new, 3);
  const xlsCommit = await req('POST', '/master-data/import/commit', { ...base64(buildCustomersXls(), '客户.xls'), target: 'customers', mode: 'insert-only' }, token);
  eq('.xls 导入新增 3', xlsCommit.body.summary.new, 3);
  eq('库中 XLS 客户数量', await countRows(db, 'customers', 'XLS客户%'), 3);
  const xlsSettle = await db.query("select settlement, credit_days from customers where name = 'XLS客户C'");
  eq('.xls 结算方式归一', xlsSettle.rows[0].settlement, 'deposit_30_balance_before_ship');
  eq('.xls 账期', xlsSettle.rows[0].credit_days, 15);

  const csvPreview = await req('POST', '/master-data/import/preview', { ...base64(buildCustomersCsvGbk(), '客户.csv'), target: 'customers', mode: 'insert-only' }, token);
  eq('.csv 解析通道', csvPreview.body.fileKind, 'csv');
  eq('.csv 预览新增 2', csvPreview.body.summary.new, 2);
  const csvCommit = await req('POST', '/master-data/import/commit', { ...base64(buildCustomersCsvGbk(), '客户.csv'), target: 'customers', mode: 'insert-only' }, token);
  eq('.csv 导入新增 2', csvCommit.body.summary.new, 2);
  eq('库中 CSV 客户数量（GBK 中文正确）', await countRows(db, 'customers', 'CSV客户%'), 2);

  // ---------- 6) 模板与校验边界 ----------
  console.log('\n【6. 模板下载与边界】');
  const tplRes = await fetch(BASE + '/master-data/import/template?target=customers', { headers: { Authorization: 'Bearer ' + token } });
  const tplBytes = new Uint8Array(await tplRes.arrayBuffer()); // 按字节核对 BOM：res.text() 会按规范吃掉 BOM
  const tplText = Buffer.from(tplBytes).toString('utf8').replace(/^\uFEFF/, '');
  eq('模板接口 200', tplRes.status, 200);
  ok('模板 Content-Type = text/csv', String(tplRes.headers.get('content-type')).includes('text/csv'), tplRes.headers.get('content-type'));
  ok('模板含附件下载头', String(tplRes.headers.get('content-disposition')).includes('attachment'), tplRes.headers.get('content-disposition'));
  ok('模板带 UTF-8 BOM（Excel 打开不乱码）', tplBytes[0] === 0xef && tplBytes[1] === 0xbb && tplBytes[2] === 0xbf, [tplBytes[0], tplBytes[1], tplBytes[2]]);
  ok('模板中文表头', tplText.includes('客户名称,联系人,结算方式,账期天数'), tplText.slice(0, 60));
  ok('模板含示例行', tplText.includes('30%定金+70%发货前'), '');
  const tplProdRes = await fetch(BASE + '/master-data/import/template?target=products', { headers: { Authorization: 'Bearer ' + token } });
  const tplProdText = (await tplProdRes.text()).replace(/^\uFEFF/, '');
  ok('产品模板中文表头', tplProdText.startsWith('型号,类型,默认包装,默认工序路线,安全库存'), tplProdText.slice(0, 40));
  ok('产品模板含示例行', tplProdText.includes('ANM 1/32 乙炔,英式乙炔'), tplProdText.split('\r\n')[1]);

  const missingCol = await req('POST', '/master-data/import/preview', { ...base64(await (async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['联系人']);
    ws.addRow(['张三']);
    return Buffer.from(await wb.xlsx.writeBuffer());
  })(), '缺列.xlsx'), target: 'customers' }, token);
  eq('缺必填列 → 400', missingCol.status, 400);
  ok('缺必填列中文提示', String(missingCol.body.message).includes('表格缺少必填列：「客户名称」'), missingCol.body.message);

  const badTarget = await req('POST', '/master-data/import/preview', { ...base64(custXlsx, '客户.xlsx'), target: 'suppliers' }, token);
  eq('target 非法 → 400', badTarget.status, 400);
  ok('target 非法中文提示', String(badTarget.body.message).includes('target 须为 customers'), badTarget.body.message);

  const broken = await req('POST', '/master-data/import/commit', { ...base64(Buffer.from('d0cf11e0a1b11ae1', 'hex'), '坏.xls'), target: 'customers' }, token);
  eq('损坏文件确认导入 → 400', broken.status, 400);
  ok('损坏文件中文提示', String(broken.body.message).includes('无法读取该 .xls 文件'), broken.body.message);
  eq('损坏文件未产生写操作', await countRows(db, 'customers', '批量客户%'), 17);

  // ---------- 7) 鉴权 ----------
  console.log('\n【7. 鉴权】');
  const anon = await req('POST', '/master-data/import/preview', { ...base64(custXlsx, '客户.xlsx'), target: 'customers' });
  eq('未登录 → 401', anon.status, 401);
  await req('POST', '/users', { username: 'e2emdws', password: 'Ws@2026x', displayName: '车间测试2', role: 'workshop' }, token);
  const wsLogin = await req('POST', '/auth/login', { username: 'e2emdws', password: 'Ws@2026x' });
  const wsToken = wsLogin.body.token;
  const forbidden = await req('POST', '/master-data/import/preview', { ...base64(custXlsx, '客户.xlsx'), target: 'customers' }, wsToken);
  eq('workshop 预览 → 403', forbidden.status, 403);
  ok('403 中文原因含所需角色', String(forbidden.body.message).includes('需要'), forbidden.body.message);
  const forbiddenCommit = await req('POST', '/master-data/import/commit', { ...base64(custXlsx, '客户.xlsx'), target: 'customers' }, wsToken);
  eq('workshop 确认导入 → 403', forbiddenCommit.status, 403);
  const wsTpl = await fetch(BASE + '/master-data/import/template?target=products', { headers: { Authorization: 'Bearer ' + wsToken } });
  eq('workshop 仍可下载模板（读操作）', wsTpl.status, 200);

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
  // 强制退出：异常路径上 db 连接未释放会把进程挂住，导致外部看不到任何输出
  process.exit(1);
});
