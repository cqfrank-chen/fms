/**
 * 产品档案去重合并 · 端到端自测（真实 PostgreSQL + 真实去重脚本）
 * =============================================================================
 * 覆盖（对应任务书「自测 1 / 2」）：
 *   ① 写法等价：ZZDEDUPE 0-1-101 ≡ ZZDEDUPE "1-101 割嘴 0#" ≡ ZZDEDUPE "1-101 size0" → 合并成一条；
 *   ② 不同 size 绝不合并：ZZDEDUPE 00-1-101（size 00）保持独立；
 *   ③ **重挂引用正确性**：order_lines / product_quotes / inventory / product_processes 全部改指存活记录，
 *      唯一约束冲突行（inventory 同批次、product_processes 同工序）按设计删除并计数；
 *   ④ 未锚定 / 未写尺寸的档案保持现状（不猜）：ZZDEDUPE 106HC-2 / ZZDEDUPE 1-101；
 *   ⑤ **幂等**：复跑 --apply 必须 0 改动、0 删除、残留差异 0；
 *   ⑥ **甲方点名的手工合并 --merge-ids**（同名两条 3-GPN）：存活规则沿用既有（完整度优先于 id）、
 *      存活记录身份以**库内既有值**为准（名字有歧义时不用名字重解析覆盖）、只动点名的组（不误伤别的档案）、
 *      重挂订单行 / 报价 / 默认包装、幂等复跑写 0 行、无悬空引用、业务行数不减少。
 *
 * 前置：一个**已跑过迁移**的库（随便启动一次 API 即可自动建表），例如：
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_test node dist/main   （起来后可停）
 * 运行：
 *   node test/dedupe-products-e2e.mjs
 * 环境变量：E2E_PG_HOST / E2E_PG_PORT / E2E_PG_USER / E2E_PG_PASSWORD / E2E_PG_DB
 *          （默认 localhost:15432 fms/fms fms_test，与其它 e2e 套件一致）
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO, 'tools', 'catalog', 'dedupe_products.mjs');

const PG_CONF = {
  host: process.env.E2E_PG_HOST ?? 'localhost',
  port: Number(process.env.E2E_PG_PORT ?? 15432),
  user: process.env.E2E_PG_USER ?? 'fms',
  password: process.env.E2E_PG_PASSWORD ?? 'fms',
  database: process.env.E2E_PG_DB ?? 'fms_test',
};
const DSN = 'postgres://' + PG_CONF.user + ':' + PG_CONF.password + '@' + PG_CONF.host + ':' + PG_CONF.port + '/' + PG_CONF.database;
const MARK = 'ZZDEDUPE';

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) { passCount += 1; console.log('  ✅ ' + label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail))); }
  else { failCount += 1; failures.push(label); console.log('  ❌ ' + label + '  实测：' + JSON.stringify(detail)); }
}
function eq(label, actual, expected) {
  try { assert.deepEqual(actual, expected); ok(label, true, actual); }
  catch { ok(label, false, { actual, expected }); }
}

// CSV 存档写到临时目录：测试**不能覆盖** tools/catalog 下的正式存档清单（dedupe_product_merges.csv 等）
const TMP_CSV = path.join(os.tmpdir(), 'fms-dedupe-e2e');

/** 跑一次去重脚本（**默认 dry-run**）；execFileSync 管道捕获 stdout，失败时把输出一并带出 */
function runScript(extraArgs) {
  const args = [
    SCRIPT, '--dsn', DSN,
    '--csv', path.join(TMP_CSV, 'merges.csv'),
    '--csv-unmerged', path.join(TMP_CSV, 'unmerged.csv'),
    ...extraArgs,
  ];
  try {
    return { code: 0, out: execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, cwd: REPO }) };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

async function main() {
  console.log('目标库：' + PG_CONF.host + ':' + PG_CONF.port + '/' + PG_CONF.database);
  const db = new pg.Client(PG_CONF);
  await db.connect();
  const q = (sql, params) => db.query(sql, params);

  const cols = (await q("select column_name from information_schema.columns where table_schema='public' and table_name='products'")).rows.map((r) => r.column_name);
  if (!cols.includes('catalog_anchor') || !cols.includes('size_spec')) {
    console.error('products 缺少目录列 —— 请先对 ' + PG_CONF.database + ' 跑一次迁移（启动一次 API）。');
    await db.end();
    process.exit(2);
  }

  // ---------------- 清理上一次可能的残留（保证本测试可重复跑） ----------------
  async function cleanup() {
    await q('delete from order_lines where order_id in (select id from orders where order_no like $1)', [MARK + '%']);
    await q('delete from orders where order_no like $1', [MARK + '%']);
    await q('delete from product_quotes where product_name like $1', [MARK + '%']);
    await q('delete from inventory where batch_no like $1', [MARK + '%']);
    await q('delete from product_processes where product_id in (select id from products where name like $1)', [MARK + '%']);
    await q('delete from products where name like $1', [MARK + '%']);
    await q('delete from customers where name like $1', [MARK + '%']);
  }
  await cleanup();

  console.log('');
  console.log('【准备数据】同一「型号+size」的多种写法 + 引用行 + 唯一约束冲突行');
  const custId = (await q('insert into customers(name) values($1) returning id', [MARK + ' 客户'])).rows[0].id;
  const addProduct = async (name, type, pkg, ss) => (await q(
    'insert into products(name, type, default_packaging, safety_stock) values($1,$2,$3,$4) returning id',
    [name, type, pkg, ss])).rows[0].id;

  const p1 = await addProduct(MARK + ' 0-1-101', 'tbd', null, 0);
  const p2 = await addProduct(MARK + ' 1-101 割嘴 0#', 'tbd', '塑料盒', 5);
  const p3 = await addProduct(MARK + ' 1-101 size0', 'tbd', null, 0);
  const p4 = await addProduct(MARK + ' 00-1-101', 'tbd', null, 0);
  const p5 = await addProduct(MARK + ' 106HC-2', 'tbd', null, 0);
  const p6 = await addProduct(MARK + ' 1-101', 'tbd', null, 0);

  const orderId = (await q(
    "insert into orders(order_no, customer_id, due_date, status) values($1,$2, now() + interval '30 day', 'draft') returning id",
    [MARK + '-SO-1', custId])).rows[0].id;
  for (const pid of [p1, p3, p6]) {
    await q('insert into order_lines(order_id, product_id, quantity, unit_price, currency) values($1,$2,$3,$4,$5)',
      [orderId, pid, 100, 9.9, 'CNY']);
  }
  for (const pid of [p1, p3]) {
    await q('insert into product_quotes(product_id, product_name, unit_price_cents) values($1,$2,$3)',
      [pid, MARK + ' 报价', 990]);
  }
  await q('insert into inventory(product_id, batch_no, quantity) values($1,$2,$3)', [p1, MARK + '-B1', 5]);
  await q('insert into inventory(product_id, batch_no, quantity) values($1,$2,$3)', [p2, MARK + '-B1', 7]);
  let procId = (await q('select id from processes order by id limit 1')).rows[0]?.id;
  if (!procId) {
    await q('insert into work_centers(key, name) values($1,$2) on conflict (key) do nothing', [MARK + '_wc', MARK + ' 泳道']);
    procId = (await q('insert into processes(key, name, wc_key) values($1,$2,$3) on conflict (key) do update set name = excluded.name returning id',
      [MARK + '_proc', MARK + ' 工序', MARK + '_wc'])).rows[0].id;
  }
  await q('insert into product_processes(product_id, process_id, seq) values($1,$2,$3)', [p1, procId, 1]);
  await q('insert into product_processes(product_id, process_id, seq) values($1,$2,$3)', [p2, procId, 1]);
  ok('测试数据就绪（6 条产品 / 3 条订单行 / 2 条报价 / 2 条库存 / 2 条工序路线）', true);

  const count = async (sql, params) => Number((await q(sql, params)).rows[0].n);
  const before = await count('select count(*)::int as n from products');

  console.log('');
  console.log('【dry-run】只报告不写库');
  const dry = runScript(['--sample', '3']);
  ok('dry-run 退出码 0（不写库）', dry.code === 0, dry.code);
  ok('dry-run 识别出合并组「1-101 0」', dry.out.includes('[1-101 0]'));
  ok('存活记录 = 字段最全的 #' + p2, dry.out.includes('存活 #' + p2));
  ok('order_lines 重挂 2 行', /order_lines\s+重挂\s+2\s+行/.test(dry.out), (dry.out.match(/order_lines.*/) ?? [''])[0].trim());
  ok('product_quotes 重挂 2 行', /product_quotes\s+重挂\s+2\s+行/.test(dry.out), (dry.out.match(/product_quotes.*/) ?? [''])[0].trim());
  ok('inventory 撞唯一约束需删除 1 行（不重挂）', /inventory\s+重挂\s+0\s+行\s+⚠ 唯一约束冲突删除 1 行/.test(dry.out), (dry.out.match(/inventory.*/) ?? [''])[0].trim());
  ok('product_processes 撞唯一约束需删除 1 行（不重挂）', /product_processes\s+重挂\s+0\s+行\s+⚠ 唯一约束冲突删除 1 行/.test(dry.out), (dry.out.match(/product_processes.*/) ?? [''])[0].trim());
  eq('dry-run 未写库（products 条数不变）', await count('select count(*)::int as n from products'), before);
  ok('dry-run 明确提示未写库', dry.out.includes('（dry-run）未写库'));

  console.log('');
  console.log('【apply】正式写入（单事务）');
  const apply = runScript(['--apply', '--quiet']);
  ok('apply 退出码 0', apply.code === 0, apply.code);
  ok('products 删除 2 行', /products 删除行数\s+2（目标 2）/.test(apply.out), (apply.out.match(/products 删除行数.*/) ?? [''])[0].trim());
  ok('引用重挂合计 4 行（订单行 2 + 报价 2；库存/工序那 2 行撞唯一约束改为删除）', /引用重挂行数合计\s+4/.test(apply.out), (apply.out.match(/引用重挂行数合计.*/) ?? [''])[0].trim());
  ok('唯一约束冲突删除 2 行', /唯一约束冲突删除行数\s+2/.test(apply.out), (apply.out.match(/唯一约束冲突删除行数.*/) ?? [''])[0].trim());
  ok('type 以目录为准（写入条数 > 0）', /type 写入行数\s+[1-9]/.test(apply.out), (apply.out.match(/type 写入行数.*/) ?? [''])[0].trim());
  ok('自校验：复跑残留差异 0', /复跑残留差异行数\s+0\s+✅/.test(apply.out), (apply.out.match(/复跑残留差异行数.*/) ?? [''])[0].trim());
  ok('自校验：仍有多条的合并组 0', /仍有多条的合并组\s+0\s+✅/.test(apply.out), (apply.out.match(/仍有多条的合并组.*/) ?? [''])[0].trim());

  console.log('');
  console.log('【SQL 核对】合并结果 / 重挂结果 / 无悬空引用');
  const row = async (id) => (await q('select id, name, type, default_packaging, catalog_model, size_spec, series, gas_type,'
    + ' orifice_mm, thickness_range, catalog_anchor, catalog_note from products where id = $1', [id])).rows[0];
  const gone = async (id) => (await q('select 1 from products where id = $1', [id])).rowCount === 0;

  ok('被合并档案 #' + p1 + ' 已删除', await gone(p1));
  ok('被合并档案 #' + p3 + ' 已删除', await gone(p3));
  const s2 = await row(p2);
  eq('存活记录目录列以目录为准（1-101 / size 0 / 乙炔 / us_acetylene）',
    [s2?.catalog_model, s2?.size_spec, s2?.gas_type, s2?.type, s2?.catalog_anchor],
    ['1-101', '0', 'ACETYLENE', 'us_acetylene', 'matched']);
  ok('存活记录写明合并说明（含被合并 id）',
    String(s2?.catalog_note ?? '').includes('已合并')
    && String(s2?.catalog_note ?? '').includes('#' + p1)
    && String(s2?.catalog_note ?? '').includes('#' + p3), s2?.catalog_note);

  const s4 = await row(p4);
  eq('size 00 的档案**未被合并**（仍是独立一条）', [s4?.catalog_model, s4?.size_spec], ['1-101', '00']);
  const s5 = await row(p5);
  eq('未锚定档案保持现状（anchor=unmatched，目录列仍为空）', [s5?.catalog_anchor, s5?.catalog_model, s5?.size_spec], ['unmatched', null, null]);
  const s6 = await row(p6);
  eq('未写 size 的档案保持现状（anchor=matched 但不猜 size）', [s6?.catalog_anchor, s6?.catalog_model, s6?.size_spec], ['matched', '1-101', null]);

  eq('订单行全部改指存活记录（3 行）',
    (await q('select count(*)::int as n from order_lines where order_id = $1', [orderId])).rows[0].n, 3);
  eq('订单行仍指向被合并档案的条数 = 0',
    (await q('select count(*)::int as n from order_lines where product_id = any($1)', [[p1, p3]])).rows[0].n, 0);
  eq('原指被合并档案的 2 条订单行已改指存活记录',
    (await q('select count(*)::int as n from order_lines where order_id = $1 and product_id = $2', [orderId, p2])).rows[0].n, 2);
  eq('报价记录改指存活记录（2 条）',
    (await q('select count(*)::int as n from product_quotes where product_id = $1', [p2])).rows[0].n, 2);
  eq('库存唯一约束冲突行按设计删除（同批次只剩 1 条，指向存活记录）',
    (await q('select product_id, batch_no, quantity from inventory where batch_no = $1', [MARK + '-B1'])).rows,
    [{ product_id: p2, batch_no: MARK + '-B1', quantity: 7 }]);
  eq('工序路线唯一约束冲突行按设计删除（同工序只剩 1 条）',
    (await q('select product_id, process_id from product_processes where process_id = $1', [procId])).rows,
    [{ product_id: p2, process_id: procId }]);

  const danglingSql = [
    "select 'order_lines' as t, count(*)::int as n from order_lines x left join products p on p.id = x.product_id where x.product_id is not null and p.id is null",
    "select 'plan_sheet_lines', count(*)::int from plan_sheet_lines x left join products p on p.id = x.product_id where x.product_id is not null and p.id is null",
    "select 'goods_receipt_lines', count(*)::int from goods_receipt_lines x left join products p on p.id = x.product_id where x.product_id is not null and p.id is null",
    "select 'outbound_lines', count(*)::int from outbound_lines x left join products p on p.id = x.product_id where x.product_id is not null and p.id is null",
    "select 'stocktakes', count(*)::int from stocktakes x left join products p on p.id = x.product_id where x.product_id is not null and p.id is null",
    "select 'inventory', count(*)::int from inventory x left join products p on p.id = x.product_id where x.product_id is not null and p.id is null",
    "select 'product_processes', count(*)::int from product_processes x left join products p on p.id = x.product_id where x.product_id is not null and p.id is null",
    "select 'product_quotes', count(*)::int from product_quotes x left join products p on p.id = x.product_id where x.product_id is not null and p.id is null",
  ];
  const dangling = (await q(danglingSql.join(' union all '))).rows.filter((r) => r.n > 0);
  eq('8 张引用表均无悬空指向 products 的引用', dangling, []);

  console.log('');
  console.log('【幂等】复跑 --apply 应 0 改动');
  const again = runScript(['--apply', '--quiet']);
  ok('复跑退出码 0', again.code === 0, again.code);
  ok('复跑 products 更新行数 0', /products 更新行数\s+0\b/.test(again.out), (again.out.match(/products 更新行数.*/) ?? [''])[0].trim());
  ok('复跑 products 删除行数 0', /products 删除行数\s+0（目标 0）/.test(again.out), (again.out.match(/products 删除行数.*/) ?? [''])[0].trim());
  ok('复跑引用重挂 0 行', /引用重挂行数合计\s+0/.test(again.out), (again.out.match(/引用重挂行数合计.*/) ?? [''])[0].trim());
  ok('复跑残留差异 0（幂等）', /复跑残留差异行数\s+0\s+✅/.test(again.out), (again.out.match(/复跑残留差异行数.*/) ?? [''])[0].trim());
  eq('复跑后 products 条数不再下降', await count('select count(*)::int as n from products'), before - 2);

  // =====================================================================================
  // 【本轮新增】甲方点名的手工合并 --merge-ids：同名两条（3-GPN）并成一条
  //   场景：`3-GPN` 会被解析成「型号 3GPN（未写 size）」，但另一条档案的库内身份是
  //   「GPN 的 size 3」—— 两条同名、却不在同一个 (型号,size) 自动分组里，通用去重不会碰它们。
  //   口径：存活规则沿用既有（①matched ②完整度 ③id 最小）；**存活记录的身份以库内既有值为准**
  //   （点名合并的起因就是名字有歧义，不能再用名字重解析覆盖已确认的事实）。
  //   注意：本段的存活记录 **id 更大**，靠「完整度更高」胜出 —— 证明规则②真的在生效。
  // =====================================================================================
  console.log('');
  console.log('【手工合并 --merge-ids】同名两条 3-GPN 并成一条（存活规则沿用既有 / 身份以库内既有值为准）');
  const mB = await addProduct(MARK + ' 3-GPN', 'us_propane', null, 0);                      // 先建：id 更小，身份 = 3GPN 未写 size
  const mA = await addProduct(MARK + ' 3-GPN', 'us_propane', '塑壳 蓝盖 不干胶 50只/中盒', 0); // 后建：id 更大，身份 = GPN size 3
  await q("update products set catalog_model='3GPN', size_spec=null, series='AMERICAN STYLE CUTTING TIP',"
    + " gas_type='LPG', catalog_anchor='matched', catalog_note='名称未写尺寸（size 待人工确认）' where id=$1", [mB]);
  await q("update products set catalog_model='GPN', size_spec='3', series='AMERICAN STYLE CUTTING TIP',"
    + " gas_type='LPG', orifice_mm='1.8', thickness_range='40-60', catalog_anchor='matched' where id=$1", [mA]);

  // 另有一对「本该被自动合并」的档案：用来证明 --merge-ids 模式**只动点名的组**，不误伤别的档案
  const oA = await addProduct(MARK + ' 4-GPN', 'us_propane', null, 0);
  const oB = await addProduct(MARK + ' GPN-4', 'us_propane', null, 0);

  const beforeManual = await count('select count(*)::int as n from products');
  for (const pid of [mB]) {
    await q('insert into order_lines(order_id, product_id, quantity, unit_price, currency) values($1,$2,$3,$4,$5)',
      [orderId, pid, 40, 7.7, 'CNY']);
    await q('insert into product_quotes(product_id, product_name, unit_price_cents) values($1,$2,$3)',
      [pid, MARK + ' 3-GPN 报价', 770]);
    await q('insert into product_packagings(product_id, packaging) values($1,$2)', [pid, MARK + ' 塑壳']);
  }
  ok('两条同名档案（' + mB + ' / ' + mA + '）+ 1 对自动合并档案（' + oA + ' / ' + oB + '）就绪', true);

  const manDry = runScript(['--merge-ids', String(mA) + ',' + String(mB), '--sample', '3']);
  ok('dry-run（--merge-ids）退出码 0', manDry.code === 0, manDry.code);
  ok('dry-run 打印「甲方点名的手工合并」段', manDry.out.includes('甲方点名的手工合并'), '');
  ok('dry-run 存活记录 = 完整度更高的 #' + mA + '（id 更大者胜出 → 规则②生效）', manDry.out.includes('存活 #' + mA), (manDry.out.match(/\[.*?\].*/) ?? [''])[0].trim());
  ok('dry-run 合并身份 = GPN size 3（以库内既有值为准）', manDry.out.includes('[GPN 3]'), (manDry.out.match(/\[.*?\]/) ?? [''])[0]);
  ok('dry-run 明示「其余自动分组不处理 1 组」（不误伤 4-GPN 那一对）',
    /其余自动分组不处理\s+1\s+组/.test(manDry.out), (manDry.out.match(/其余自动分组不处理.*/) ?? [''])[0].trim());
  ok('dry-run order_lines 重挂 1 行', /order_lines\s+重挂\s+1\s+行/.test(manDry.out), (manDry.out.match(/order_lines.*/) ?? [''])[0].trim());
  ok('dry-run product_quotes 重挂 1 行', /product_quotes\s+重挂\s+1\s+行/.test(manDry.out), (manDry.out.match(/product_quotes.*/) ?? [''])[0].trim());
  ok('dry-run product_packagings 重挂 1 行', /product_packagings\s+重挂\s+1\s+行/.test(manDry.out), (manDry.out.match(/product_packagings.*/) ?? [''])[0].trim());
  eq('dry-run 未写库（products 条数不变）', await count('select count(*)::int as n from products'), beforeManual);
  // 那一对「本该自动合并」的档案只用于证明 dry-run 不误伤；apply 前删掉它们，
  // 否则它们本身（同名两条未合并）会让脚本的**全局**自校验如实报「仍有多条的合并组 1」。
  await q('delete from products where id = any($1)', [[oA, oB]]);
  const beforeApply = await count('select count(*)::int as n from products');
  eq('不误伤验证用的那一对已移除（回到只差点名合并的状态）', beforeApply, beforeManual - 2);
  // apply 前快照：除点名涉及的两条外，所有档案的目录列 —— apply 后必须**逐行一致**（不误伤）
  const othersSql = 'select id, catalog_model, size_spec, series, gas_type, orifice_mm, thickness_range, catalog_anchor, catalog_note'
    + ' from products where id <> all($1) order by id';
  const othersBefore = (await q(othersSql, [[mA, mB]])).rows;

  console.log('');
  console.log('【手工合并 apply】单事务写入 + 幂等复跑');
  const manApply = runScript(['--merge-ids', String(mA) + ',' + String(mB), '--apply', '--quiet']);
  ok('apply（--merge-ids）退出码 0', manApply.code === 0, manApply.code);
  ok('products 删除行数 1（目标 1）', /products 删除行数\s+1（目标 1）/.test(manApply.out), (manApply.out.match(/products 删除行数.*/) ?? [''])[0].trim());
  ok('引用重挂合计 3 行（订单行 / 报价 / 默认包装各 1）', /引用重挂行数合计\s+3/.test(manApply.out), (manApply.out.match(/引用重挂行数合计.*/) ?? [''])[0].trim());
  ok('自校验：复跑残留差异 0', /复跑残留差异行数\s+0\s+✅/.test(manApply.out), (manApply.out.match(/复跑残留差异行数.*/) ?? [''])[0].trim());
  ok('自校验：仍有多条的合并组 0', /仍有多条的合并组\s+0\s+✅/.test(manApply.out), (manApply.out.match(/仍有多条的合并组.*/) ?? [''])[0].trim());
  ok('自校验按「库内身份」核对点名合并的存活记录（名字有歧义，跳过名字重解析）',
    manApply.out.includes('点名合并存活记录的自校验口径'), (manApply.out.match(/.*库内身份.*/) ?? [''])[0].trim());

  console.log('');
  console.log('【SQL 核对】合并结果 / 身份保持 / 重挂 / 无悬空引用 / 业务行数不减少');
  ok('被合并档案 #' + mB + ' 已删除', await gone(mB));
  const sa = await row(mA);
  eq('存活记录身份保持库内既有值（GPN / size 3 / 阈值口径未被名字重解析覆盖）',
    [sa?.catalog_model, sa?.size_spec, sa?.series, sa?.gas_type, sa?.orifice_mm, sa?.thickness_range, sa?.catalog_anchor],
    ['GPN', '3', 'AMERICAN STYLE CUTTING TIP', 'LPG', '1.8', '40-60', 'matched']);
  eq('存活记录名字未被改动（甲方未要求改名，仍是有歧义的 3-GPN）', sa?.name, MARK + ' 3-GPN');
  ok('存活记录写明「甲方点名合并」并含被合并 id #' + mB,
    String(sa?.catalog_note ?? '').includes('点名合并') && String(sa?.catalog_note ?? '').includes('#' + mB), sa?.catalog_note);
  ok('存活记录补齐了被合并档案的默认包装（信息不丢）', sa?.default_packaging === '塑壳 蓝盖 不干胶 50只/中盒', sa?.default_packaging);

  eq('订单行改指存活记录（该单 3-GPN 报价行 1 条）',
    Number((await q('select count(*)::int as n from order_lines where product_id = $1', [mA])).rows[0].n), 1);
  eq('报价记录改指存活记录', Number((await q('select count(*)::int as n from product_quotes where product_id = $1', [mA])).rows[0].n), 1);
  eq('默认包装重挂到存活记录（唯一约束 (product_id, packaging) 未冲突）',
    (await q('select product_id, packaging from product_packagings where packaging = $1', [MARK + ' 塑壳'])).rows,
    [{ product_id: mA, packaging: MARK + ' 塑壳' }]);
  eq('指向被合并档案的引用一律为 0',
    Number((await q('select count(*)::int as n from order_lines where product_id = $1', [mB])).rows[0].n), 0);
  eq('点名合并**未改动任何其它档案**的目录列（与 apply 前快照逐行一致 → --merge-ids 只动点名的组）',
    (await q(othersSql, [[mA, mB]])).rows, othersBefore);

  const dangling2 = (await q(danglingSql.join(' union all '))).rows.filter((r) => r.n > 0);
  eq('点名合并后 8 张引用表仍无悬空引用', dangling2, []);
  eq('业务行数不减少（订单行总数不变）',
    await count('select count(*)::int as n from order_lines where order_id = $1', [orderId]), 4);
  eq('products 条数 645 变 644 的口径：本次只减少 1 条', await count('select count(*)::int as n from products'), beforeApply - 1);

  const manAgain = runScript(['--merge-ids', String(mA) + ',' + String(mB), '--apply', '--quiet']);
  ok('幂等复跑退出码 0（目标 id 已不存在也不报错）', manAgain.code === 0, manAgain.code);
  ok('幂等复跑：报告「库里已不存在的 id」（上一轮已合并）', manAgain.out.includes('库里已不存在的 id'), (manAgain.out.match(/.*已不存在.*/) ?? [''])[0].trim());
  ok('幂等复跑 products 更新行数 0', /products 更新行数\s+0\b/.test(manAgain.out), (manAgain.out.match(/products 更新行数.*/) ?? [''])[0].trim());
  ok('幂等复跑 products 删除行数 0（目标 0）', /products 删除行数\s+0（目标 0）/.test(manAgain.out), (manAgain.out.match(/products 删除行数.*/) ?? [''])[0].trim());
  ok('幂等复跑引用重挂 0 行', /引用重挂行数合计\s+0/.test(manAgain.out), (manAgain.out.match(/引用重挂行数合计.*/) ?? [''])[0].trim());
  ok('幂等复跑残留差异 0', /复跑残留差异行数\s+0\s+✅/.test(manAgain.out), (manAgain.out.match(/复跑残留差异行数.*/) ?? [''])[0].trim());
  eq('幂等复跑后 products 条数不再下降', await count('select count(*)::int as n from products'), beforeApply - 1);

  await cleanup();
  const left = await count('select count(*)::int as n from products where name like $1', [MARK + '%']);
  eq('测试数据已清理（无残留）', left, 0);
  await db.end();

  console.log('');
  console.log('================ 汇总 ================');
  console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
  if (failCount) { console.log('失败项：' + failures.join(' / ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
