/**
 * 产品档案去重合并 · 端到端自测（真实 PostgreSQL + 真实去重脚本）
 * =============================================================================
 * 覆盖（对应任务书「自测 1 / 2」）：
 *   ① 写法等价：ZZDEDUPE 0-1-101 ≡ ZZDEDUPE "1-101 割嘴 0#" ≡ ZZDEDUPE "1-101 size0" → 合并成一条；
 *   ② 不同 size 绝不合并：ZZDEDUPE 00-1-101（size 00）保持独立；
 *   ③ **重挂引用正确性**：order_lines / product_quotes / inventory / product_processes 全部改指存活记录，
 *      唯一约束冲突行（inventory 同批次、product_processes 同工序）按设计删除并计数；
 *   ④ 未锚定 / 未写尺寸的档案保持现状（不猜）：ZZDEDUPE 106HC-2 / ZZDEDUPE 1-101；
 *   ⑤ **幂等**：复跑 --apply 必须 0 改动、0 删除、残留差异 0。
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

/** 跑一次去重脚本（**默认 dry-run**）；execFileSync 管道捕获 stdout，失败时把输出一并带出 */
function runScript(extraArgs) {
  const args = [SCRIPT, '--dsn', DSN, ...extraArgs];
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
  const row = async (id) => (await q('select id, name, type, default_packaging, catalog_model, size_spec, series, gas_type, catalog_anchor, catalog_note from products where id = $1', [id])).rows[0];
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
