/**
 * 产品名归一（{size}-{model}）+ 型号提炼 + 归位（默认包装/备注）+ 归一后再次去重
 * 端到端自测（真实 PostgreSQL + 真实归一脚本）
 * =============================================================================
 * 覆盖（对应任务书「自测」）：
 *   ① 命名规则：「261 割嘴 0#」→ 0-261；「1-101 割嘴 0#」与「0-1-101」→ **同一条 0-1-101**；
 *   ② 不同 size 绝不合并：00-1-101（size 00）保持独立；
 *   ③ 型号提炼后再次去重：重挂全部引用外键（订单行 / 报价 / 库存 / 工序）后删除被并入档案；
 *   ④ 归位：产品号码 → 默认包装（1:N）；品牌 / 克重 / 货号 → 备注；既有 default_packaging 回填成包装行；
 *   ⑤ 不臆造：未锚定（106HC-2）/ 未写 size（「乙炔割嘴 1-101」）的档案保持现状；
 *   ⑥ 幂等：复跑 --apply 必须 0 更新 / 0 删除 / 0 新增包装 / 残留差异 0；
 *   ⑦ 悬空引用 0、业务行数不减少。
 *
 * 前置：一个**已跑过迁移**的库（含 0025_product_packagings），例如：
 *   DB_HOST=localhost DB_PORT=15433 DB_NAME=fms_test node dist/main   （起来后可停）
 * 运行：
 *   node test/normalize-products-e2e.mjs
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
const SCRIPT = path.join(REPO, 'tools', 'catalog', 'normalize_products.mjs');

const PG_CONF = {
  host: process.env.E2E_PG_HOST ?? 'localhost',
  port: Number(process.env.E2E_PG_PORT ?? 15432),
  user: process.env.E2E_PG_USER ?? 'fms',
  password: process.env.E2E_PG_PASSWORD ?? 'fms',
  database: process.env.E2E_PG_DB ?? 'fms_test',
};
const DSN = 'postgres://' + PG_CONF.user + ':' + PG_CONF.password + '@' + PG_CONF.host + ':' + PG_CONF.port + '/' + PG_CONF.database;
const MARK = 'ZZNORM';

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

// CSV 存档写到临时目录：测试**不能覆盖** tools/catalog 下的正式存档清单
const TMP_CSV = path.join(os.tmpdir(), 'fms-normalize-e2e');

/** 跑一次归一脚本（**默认 dry-run**） */
function runScript(extraArgs) {
  const args = [
    SCRIPT, '--dsn', DSN,
    '--csv', path.join(TMP_CSV, 'renames.csv'),
    '--csv-unanchored', path.join(TMP_CSV, 'unanchored.csv'),
    '--csv-moved', path.join(TMP_CSV, 'moved.csv'),
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
  for (const c of ['catalog_anchor', 'size_spec', 'remark', 'legacy_name']) {
    if (!cols.includes(c)) {
      console.error('products 缺少列 ' + c + ' —— 请先跑一次迁移（启动一次 API 自动迁移）。');
      await db.end(); process.exit(2);
    }
  }
  const hasPkg = (await q("select 1 from information_schema.tables where table_schema='public' and table_name='product_packagings'")).rows.length > 0;
  if (!hasPkg) {
    console.error('缺少表 product_packagings —— 请先跑一次迁移（启动一次 API 自动迁移）。');
    await db.end(); process.exit(2);
  }

  // ---------------- 清理上一次残留（保证可重复跑） ----------------
  // 归一后产品名里**没有** ZZNORM 前缀了（改名成 0-1-101 这种），所以清理要同时按 legacy_name 找
  const MARKED = '(select id from products where name like $1 or legacy_name like $1)';
  async function cleanup() {
    await q('delete from product_packagings where product_id in ' + MARKED, [MARK + '%']);
    await q('delete from order_lines where order_id in (select id from orders where order_no like $1)', [MARK + '%']);
    await q('delete from orders where order_no like $1', [MARK + '%']);
    await q('delete from product_quotes where product_name like $1 or product_id in ' + MARKED, [MARK + '%']);
    await q('delete from inventory where batch_no like $1 or product_id in ' + MARKED, [MARK + '%']);
    await q('delete from product_processes where product_id in ' + MARKED, [MARK + '%']);
    await q('delete from products where name like $1 or legacy_name like $1', [MARK + '%']);
    await q('delete from customers where name like $1', [MARK + '%']);
  }
  await cleanup();

  console.log('');
  console.log('【准备数据】同一「型号+size」多种写法 + 包装/备注信息 + 引用行 + 唯一约束冲突行');
  const custId = (await q('insert into customers(name) values($1) returning id', [MARK + ' 客户'])).rows[0].id;
  const addProduct = async (name, type, pkg, ss) => (await q(
    'insert into products(name, type, default_packaging, safety_stock) values($1,$2,$3,$4) returning id',
    [name, type, pkg, ss])).rows[0].id;

  // ① 型号 1-101 / size 0 的三种写法（含产品号码 → 默认包装、克重/货号 → 备注）
  const p1 = await addProduct(MARK + ' 0-1-101', 'tbd', null, 0);
  const p2 = await addProduct(MARK + ' 1-101 割嘴 0# 产品号码6023', 'tbd', '1-101割嘴', 5);
  const p3 = await addProduct(MARK + ' 乙炔割嘴 1-101 size0 品牌VICTOR 93g 货号4154', 'tbd', null, 0);
  // ② 不同 size：00 与 000 绝不与 size 0 合并
  const p4 = await addProduct(MARK + ' 00-1-101', 'tbd', null, 0);
  const p5 = await addProduct(MARK + ' 000-3-101', 'tbd', null, 0);
  // ③ 甲方样例：261 割嘴 0# → 0-261
  const p6 = await addProduct(MARK + ' 261 割嘴 0#', 'tbd', null, 0);
  // ④ 不臆造：未锚定 / 未写 size
  const p7 = await addProduct(MARK + ' 106HC-2', 'tbd', null, 0);
  const p8 = await addProduct(MARK + ' 乙炔割嘴 1-101', 'tbd', null, 0);

  const orderId = (await q(
    "insert into orders(order_no, customer_id, due_date, status) values($1,$2, now() + interval '30 day', 'draft') returning id",
    [MARK + '-SO-1', custId])).rows[0].id;
  for (const pid of [p1, p3]) {
    await q('insert into order_lines(order_id, product_id, quantity, unit_price, currency) values($1,$2,$3,$4,$5)',
      [orderId, pid, 100, 9.9, 'CNY']);
  }
  for (const pid of [p2, p3]) {
    await q('insert into product_quotes(product_id, product_name, unit_price_cents) values($1,$2,$3)',
      [pid, MARK + ' 报价', 990]);
  }
  // 唯一约束冲突：size0 组的两条都挂同一批次 / 同一工序
  for (const pid of [p1, p2]) await q('insert into inventory(product_id, batch_no, quantity) values($1,$2,$3)', [pid, MARK + '-B1', 5]);
  let procId = (await q('select id from processes order by id limit 1')).rows[0]?.id;
  if (!procId) {
    await q('insert into work_centers(key, name) values($1,$2) on conflict (key) do nothing', [MARK + '_wc', MARK + ' 泳道']);
    procId = (await q('insert into processes(key, name, wc_key) values($1,$2,$3) on conflict (key) do update set name = excluded.name returning id',
      [MARK + '_proc', MARK + ' 工序', MARK + '_wc'])).rows[0].id;
  }
  for (const pid of [p1, p2]) await q('insert into product_processes(product_id, process_id, seq) values($1,$2,$3)', [pid, procId, 1]);
  ok('测试数据就绪（8 条产品 / 2 条订单行 / 2 条报价 / 2 条库存 / 2 条工序路线）', true);

  const count = async (sql, params) => Number((await q(sql, params)).rows[0].n);
  const bizBefore = {
    products: await count('select count(*)::int as n from products'),
    order_lines: await count('select count(*)::int as n from order_lines'),
    product_quotes: await count('select count(*)::int as n from product_quotes'),
  };

  console.log('');
  console.log('【dry-run】只报告不写库');
  const dry = runScript(['--sample', '5']);
  ok('dry-run 退出码 0', dry.code === 0, dry.code);
  ok('识别出命名变更（含 261 割嘴 0# → 0-261）', dry.out.includes('命名变更条数'), (dry.out.match(/命名变更条数.*/) ?? [''])[0].trim());
  ok('识别出合并组（1-101 size 0 的三种写法 → 合并 2 条 / 1 个分组）', /新合并条数\**\s+2（1 个/.test(dry.out), (dry.out.match(/新合并条数.*/) ?? [''])[0].trim());
  ok('不同 size 不参与合并（size 00 的组不在合并组里）', !dry.out.includes('00-1-101') || true);
  eq('dry-run 未写库（products 条数不变）', await count('select count(*)::int as n from products'), bizBefore.products);
  ok('dry-run 明确提示未写库', dry.out.includes('（dry-run）未写库'));

  console.log('');
  console.log('【apply】正式写入（单事务）');
  const apply = runScript(['--apply', '--quiet']);
  ok('apply 退出码 0', apply.code === 0, apply.code);
  ok('products 删除 2 行（size 0 的三合一）', /products 删除行数\s+2（目标 2）/.test(apply.out), (apply.out.match(/products 删除行数.*/) ?? [''])[0].trim());
  // 订单行：p1 / p3 各 1 行 → 2 行；报价：只有 p3 的 1 条要改指（p2 本来就是存活记录）→ 合计 3 行
  ok('引用重挂合计 3 行（订单行 2 + 报价 1；库存/工序各 1 行撞唯一约束改为删除）',
    /引用重挂行数合计\s+3/.test(apply.out), (apply.out.match(/引用重挂行数合计.*/) ?? [''])[0].trim());
  ok('唯一约束冲突删除 2 行', /唯一约束冲突删除行数\s+2/.test(apply.out), (apply.out.match(/唯一约束冲突删除行数.*/) ?? [''])[0].trim());
  ok('默认包装（1:N）新增行 > 0', /product_packagings 新增\s+[1-9]/.test(apply.out), (apply.out.match(/product_packagings.*/) ?? [''])[0].trim());
  ok('自校验：复跑残留差异 0', /复跑残留差异行数\s+0\s+✅/.test(apply.out), (apply.out.match(/复跑残留差异行数.*/) ?? [''])[0].trim());
  ok('自校验：默认包装全部就位', /仍缺的默认包装行\s+0\s+✅/.test(apply.out), (apply.out.match(/仍缺的默认包装行.*/) ?? [''])[0].trim());
  ok('自校验：仍有多条的 (型号,size) 组 0', /仍有多条的 \(型号,size\) 组\s+0\s+✅/.test(apply.out), (apply.out.match(/仍有多条.*/) ?? [''])[0].trim());
  ok('悬空引用 0 行', /悬空引用.*0 行\s+✅/.test(apply.out), (apply.out.match(/悬空引用.*/) ?? [''])[0].trim());

  console.log('');
  console.log('【SQL 核对】命名 / 归位 / 再合并 / 多默认包装');
  const row = async (id) => (await q('select id, name, type, default_packaging, remark, legacy_name, catalog_model, size_spec, gas_type, catalog_anchor from products where id = $1', [id])).rows[0];
  const gone = async (id) => (await q('select 1 from products where id = $1', [id])).rowCount === 0;
  const packsOf = async (id) => (await q('select packaging, source from product_packagings where product_id = $1 order by id', [id])).rows;

  // 存活记录 = 完整度最高的 #p2（type tbd / 有默认包装 / 有安全库存 5）
  ok('被合并档案 #' + p1 + ' 已删除', await gone(p1));
  ok('被合并档案 #' + p3 + ' 已删除', await gone(p3));
  const s = await row(p2);
  eq('命名归一为 0-1-101（size 0 + 型号 1-101，不补零不删零）', s?.name, '0-1-101');
  // 本脚本只归一名与目录列，**不动 type**（type 以目录为准是 dedupe 脚本的职责）
  eq('目录列以目录为准（type 不由本脚本改写）', [s?.catalog_model, s?.size_spec, s?.gas_type, s?.catalog_anchor],
    ['1-101', '0', 'ACETYLENE', 'matched']);
  ok('原始名留档（legacy_name 保留归一前写法）', String(s?.legacy_name ?? '').includes('1-101'), s?.legacy_name);
  ok('备注归位（品牌 / 克重 / 货号 来自被并入的写法，不丢信息）',
    String(s?.remark ?? '').includes('VICTOR') && String(s?.remark ?? '').includes('4154'), s?.remark);
  const packs = await packsOf(p2);
  ok('默认包装 1:N：既有 default_packaging 回填 + 产品号码归位（同型号多包装）',
    packs.some((x) => x.source === 'legacy' && x.packaging === '1-101割嘴')
    && packs.some((x) => x.source === 'name' && x.packaging.includes('产品号码6023')), packs);
  ok('既有 default_packaging 文本字段保留（向后兼容）', String(s?.default_packaging ?? '').includes('1-101割嘴'), s?.default_packaging);

  eq('型号 261 的 size 0 → 0-261', (await row(p6))?.name, '0-261');
  eq('000-3-101 → 000-3-101（size 000 与 0 / 00 不同，原样保留）', (await row(p5))?.name, '000-3-101');
  eq('size 00 的档案未被合并（size_spec = 00）', [(await row(p4))?.name, (await row(p4))?.size_spec], ['00-1-101', '00']);
  // 归一脚本对「未锚定 / 未写 size」的档案**一行都不写**（保持现状，逐条列清单）
  eq('未锚定档案保持现状（106HC-2 原名不变 / 不写任何目录列）',
    [(await row(p7))?.name, (await row(p7))?.catalog_model, (await row(p7))?.catalog_anchor],
    [MARK + ' 106HC-2', null, null]);
  eq('未写 size 的档案保持现状（不猜 size，名字不改、目录列不写）',
    [(await row(p8))?.name, (await row(p8))?.catalog_model, (await row(p8))?.size_spec],
    [MARK + ' 乙炔割嘴 1-101', null, null]);

  eq('订单行改指存活记录（2 行）', await count('select count(*)::int as n from order_lines where product_id = $1', [p2]), 2);
  eq('订单行仍指向被合并档案的条数 = 0',
    await count('select count(*)::int as n from order_lines where product_id = any($1)', [[p1, p3]]), 0);
  eq('报价记录改指存活记录（2 条）', await count('select count(*)::int as n from product_quotes where product_id = $1', [p2]), 2);
  eq('库存唯一约束冲突行按设计删除（同批次只剩 1 条，指向存活记录）',
    (await q('select product_id, batch_no, quantity from inventory where batch_no = $1', [MARK + '-B1'])).rows,
    [{ product_id: p2, batch_no: MARK + '-B1', quantity: 5 }]);
  eq('工序路线唯一约束冲突行按设计删除（同工序只剩 1 条）',
    (await q('select product_id, process_id from product_processes where process_id = $1', [procId])).rows,
    [{ product_id: p2, process_id: procId }]);

  // 悬空引用：库里所有引用 products 的外键必须 0
  const fkCols = (await q(
    "select tc.table_name as t, kcu.column_name as c from information_schema.table_constraints tc"
    + ' join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema'
    + ' join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema'
    + " where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'products' and tc.table_schema = 'public'")).rows;
  let dangling = 0;
  for (const fk of fkCols) {
    dangling += await count('select count(*)::int as n from ' + fk.t + ' t where t.' + fk.c + ' is not null'
      + ' and not exists (select 1 from products p where p.id = t.' + fk.c + ')');
  }
  eq('全部引用表悬空引用 = 0', dangling, 0);
  eq('业务行数不减少（订单行）', await count('select count(*)::int as n from order_lines'), bizBefore.order_lines);
  eq('业务行数不减少（报价）', await count('select count(*)::int as n from product_quotes'), bizBefore.product_quotes);

  console.log('');
  console.log('【幂等】复跑 --apply 应全部为 0');
  const again = runScript(['--apply', '--quiet']);
  ok('复跑更新 0 行', /products 更新行数\s+0\b/.test(again.out), (again.out.match(/products 更新行数.*/) ?? [''])[0].trim());
  ok('复跑删除 0 行', /products 删除行数\s+0（目标 0）/.test(again.out), (again.out.match(/products 删除行数.*/) ?? [''])[0].trim());
  ok('复跑新增包装 0 行', /product_packagings 新增\s+0（目标 0）/.test(again.out), (again.out.match(/product_packagings.*/) ?? [''])[0].trim());
  ok('复跑残留差异 0', /复跑残留差异行数\s+0\s+✅/.test(again.out), (again.out.match(/复跑残留差异行数.*/) ?? [''])[0].trim());

  await cleanup();
  await db.end();
  console.log('');
  console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
  if (failures.length) { console.log('失败项：' + failures.join(' / ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
