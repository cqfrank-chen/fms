#!/usr/bin/env node
/**
 * 产品名归一（{size}-{model}）+ 型号提炼 + 归位（默认包装 / 备注）+ 归一后再次去重
 * =============================================================================
 * 甲方规则（2026 标准化，最高优先级）：
 *   ① **产品名统一为 {size}-{model}**：size 用目录 size setting 原值（0 / 00 / 000 / 1 …，
 *      **不补零不删零**），model 用目录型号代码 —— 例：0-1-101、000-3-101、0-261；
 *      所以「261 割嘴 0#」→ 0-261，「0-1-101」与「1-101 割嘴 0#」→ 同一条 0-1-101。
 *   ② **从名称提炼型号**（只认能锚定到官方目录 37 个型号的写法）→ 归一后按 (model, size)
 *      **再次去重**：同型号同 size 合并为一条（重挂全部引用外键后删除被并入档案）。
 *   ③ **多余信息归位**：产品号码 / 塑料盖贴（塑料盖 / 贴盖 / 盖贴）→ product_packagings（1:N，**默认包装**）；
 *      其余（品牌 / 刻字 / 重量 / 货号 / 尺寸描述 / 备注性文字）→ products.remark（**备注**）。
 *   ④ **不臆造**：型号锚定不到目录、或名称没写 size 的档案**保持现状**，逐条列清单交甲方确认。
 *      其它型号写法（如 106HC / 102HC / 6290VVC）默认**不启用**，需甲方点头后放进 --aliases 文件再跑。
 *
 * 写库范围（一个事务）：
 *   · 只 update **已锚定且有 size** 的产品行：name / catalog_model / size_spec / series / gas_type /
 *     orifice_mm / thickness_range / catalog_anchor / legacy_name / remark / default_packaging(仅补空)；
 *   · 只 insert product_packagings（(product_id, packaging) 唯一，重复写入自动忽略）；
 *   · 合并组：只 update 引用表的 product_id + delete 被并入的 products 行；
 *   · **未锚定 / 未写 size 的行一行都不动**；不删任何业务行（唯一约束冲突的重复行除外，逐条计数上报）。
 *
 * 幂等：所有目标值都是「原始名（legacy_name 优先）+ 目录」的纯函数结果；第二次跑应全部为 0。
 * 默认 dry-run（只报告不写库）；--apply 才写库，且**单事务**，失败自动回滚。
 *
 * 用法：
 *   node tools/catalog/normalize_products.mjs --dsn postgres://fms:fms@localhost:15433/fms_dedupe2
 *   node tools/catalog/normalize_products.mjs --dsn <DSN> --apply
 *   node tools/catalog/normalize_products.mjs --dsn <DSN> --aliases tools/catalog/catalog_model_aliases.candidate.json
 * 参数：
 *   --dsn <url>        数据库连接串（也可 DATABASE_URL / DB_HOST+DB_PORT+DB_NAME+DB_USER+DB_PASSWORD）
 *   --apply            真正写库（不加 = dry-run）
 *   --aliases <file>   【默认不启用】额外型号别名（JSON：{"106hc":"106"}），需甲方确认后才用
 *   --limit N          只处理前 N 个合并组（联调 / 抽样）
 *   --sample N         控制台打印的样例条数（默认 10）
 *   --quiet            只打印汇总
 *   --csv <path>       命名变更清单 CSV（--apply 时默认 tools/catalog/normalize_products_renames.csv）
 *   --csv-unanchored <path> 未锚定/未写 size 清单 CSV（默认 tools/catalog/normalize_unanchored_products.csv）
 *   --csv-moved <path> 包装/备注归位清单 CSV（默认 tools/catalog/normalize_moved_info.csv）
 *   --no-legacy-packaging 不回填既有 default_packaging 到 1:N 表
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildModelIndex, withModelAliases } from './lib/product-model.mjs';
import { canonicalProductName, planNormalize, REMARK_SEP } from './lib/normalize-core.mjs';
import { buildFkPlan, rehangReference } from './lib/rehang.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const require_ = createRequire(path.join(REPO, 'apps', 'api', 'package.json'));
const pg = require_('pg');

const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const valOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const DSN = valOf('--dsn') ?? process.env.DATABASE_URL
  ?? (process.env.DB_HOST
    ? 'postgres://' + (process.env.DB_USER ?? 'fms') + ':' + (process.env.DB_PASSWORD ?? 'fms')
      + '@' + process.env.DB_HOST + ':' + (process.env.DB_PORT ?? '5432') + '/' + (process.env.DB_NAME ?? 'fms')
    : null);
const APPLY = has('--apply');
const LIMIT = Number(valOf('--limit') ?? 0) || 0;
const SAMPLE = Number(valOf('--sample') ?? 10) || 0;
const QUIET = has('--quiet');
const ALIASES_PATH = valOf('--aliases');
const LEGACY_PACKAGING = !has('--no-legacy-packaging');
const CSV_RENAMES = valOf('--csv') ?? path.join(__dirname, 'normalize_products_renames.csv');
const CSV_UNANCHORED = valOf('--csv-unanchored') ?? path.join(__dirname, 'normalize_unanchored_products.csv');
const CSV_MOVED = valOf('--csv-moved') ?? path.join(__dirname, 'normalize_moved_info.csv');

if (!DSN) {
  console.error('缺少数据库连接：请给 --dsn <url> 或设置 DATABASE_URL / DB_HOST 等环境变量。');
  console.error('（本脚本故意不设默认库，避免误连生产/云端。）');
  process.exit(2);
}

const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_models.json'), 'utf8'));
const aliases = ALIASES_PATH ? JSON.parse(fs.readFileSync(ALIASES_PATH, 'utf8')) : null;
const idx = withModelAliases(buildModelIndex(cat), aliases);

/** 产品行查询列（写库与判定都基于这些列） */
const PRODUCT_COLS = 'id, name, type, catalog_model, size_spec, series, gas_type, orifice_mm, thickness_range,'
  + ' catalog_anchor, catalog_note, default_packaging, default_routing, safety_stock, remark, legacy_name';

const norm = (v) => (v === null || v === undefined ? null : String(v));
const eq = (a, b) => norm(a) === norm(b);

async function loadProducts(client) {
  return (await client.query('select ' + PRODUCT_COLS + ' from products order by id')).rows;
}

/** 现库里的默认包装（1:N）—— 判定「要不要插」用 */
async function loadPackagings(client) {
  const rows = (await client.query('select product_id, packaging from product_packagings order by id')).rows;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.product_id)) map.set(r.product_id, new Set());
    map.get(r.product_id).add(String(r.packaging));
  }
  return map;
}

async function main() {
  const client = new pg.Client({ connectionString: DSN });
  await client.connect();
  const who = await client.query('select current_database() as db, inet_server_addr()::text as host');
  console.log('目标库：' + who.rows[0].db + ' @ ' + (who.rows[0].host ?? 'local') + '   模式：'
    + (APPLY ? 'APPLY（真写库）' : 'DRY-RUN（只报告）')
    + (aliases ? '   别名文件：' + ALIASES_PATH + '（' + Object.keys(aliases).length + ' 条）' : '   别名文件：未启用'));

  const prodCols = (await client.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='products'",
  )).rows.map((r) => r.column_name);
  for (const c of ['catalog_model', 'size_spec', 'catalog_anchor', 'remark', 'legacy_name']) {
    if (!prodCols.includes(c)) {
      console.error('products 缺少列 ' + c + ' —— 请先跑迁移 0025_product_packagings.sql（重启一次 API 即可自动迁移）。');
      await client.end(); process.exit(3);
    }
  }
  const hasPkgTable = (await client.query(
    "select 1 from information_schema.tables where table_schema='public' and table_name='product_packagings'",
  )).rows.length > 0;
  if (!hasPkgTable) {
    console.error('缺少表 product_packagings —— 请先跑迁移 0025_product_packagings.sql（重启一次 API 即可自动迁移）。');
    await client.end(); process.exit(3);
  }
  const fkPlan = await buildFkPlan(client);

  const before = await loadProducts(client);
  const pkBefore = await loadPackagings(client);
  const plan = planNormalize(before, idx);
  const planMerges = LIMIT > 0 ? plan.merges.slice(0, LIMIT) : plan.merges;
  const plannedDupIds = new Set();
  for (const g of planMerges) for (const m of g.merged) plannedDupIds.add(m.row.id);
  const survivorSet = new Set(plan.survivors.map((s) => s.survivor.row.id));

  // ---- 归位产物：默认包装行（core 已把被合并档案的包装挂到存活记录上）----
  const pkgRows = plan.packagingRows.filter(
    (p) => p.source === 'legacy' ? LEGACY_PACKAGING : survivorSet.has(p.productId));
  const pkgToInsert = pkgRows.filter((p) => !(pkBefore.get(p.productId)?.has(p.packaging)));
  const remarkTargets = new Map(plan.remarkWrites.map((r) => [r.id, r.remark]));

  // ---- 命名变更（未改名的不算） ----
  const renameRows = plan.renames.filter((r) => survivorSet.has(r.id));

  // ---- 需要写的产品行：name / 目录列 / legacy_name / remark ----
  const productUpdates = [];
  let legacyNameWrites = 0;
  let remarkWrites = 0;
  for (const s of plan.survivors) {
    const e = s.survivor;
    const row = e.row;
    if (plannedDupIds.has(row.id)) continue;
    const sets = {};
    if (!eq(row.name, e.canonical)) sets.name = e.canonical;
    for (const f of ['catalog_model', 'size_spec', 'series', 'gas_type', 'orifice_mm', 'thickness_range']) {
      const target = { catalog_model: e.parse.model, size_spec: e.parse.size, series: e.parse.series,
        gas_type: e.parse.gasType, orifice_mm: e.parse.orificeMm, thickness_range: e.parse.thicknessRange }[f];
      if (!eq(row[f], target)) sets[f] = target;
    }
    if (row.catalog_anchor !== 'matched') sets.catalog_anchor = 'matched';
    // 原始名留档：只在「名字确实变了」且还没留档时写一次（幂等）
    if (!eq(row.name, e.canonical) && !row.legacy_name) { sets.legacy_name = e.sourceName; legacyNameWrites += 1; }
    const wantRemark = remarkTargets.get(row.id) ?? null;
    if (!eq(row.remark, wantRemark)) { sets.remark = wantRemark; remarkWrites += 1; }
    // 既有文本列只补空（不覆盖甲方已有内容），保证老读取路径仍有值
    if (!String(row.default_packaging ?? '').trim()) {
      const first = pkgRows.find((p) => p.productId === row.id);
      if (first) sets.default_packaging = first.packaging;
    }
    if (Object.keys(sets).length) productUpdates.push({ id: row.id, sets });
  }

  // ==================== 报告 ====================
  const st = plan.stat;
  console.log('');
  console.log('=== 一、扫描与归一 ===');
  console.log('  产品档案总数                  ' + st.total);
  console.log('  型号 + size 都锚定（可归一）   ' + st.matchedSized);
  console.log('  —— 型号已锚定但名称未写 size   ' + st.sizeUnknown + '（保持现状，不猜 size）');
  console.log('  —— 型号未锚定目录             ' + st.unmatched + '（保持现状）');
  console.log('  **命名变更条数**              ' + renameRows.length + '（改为 {size}-{model}；已是标准名的不计）');
  console.log('  **新提炼出的型号数**          ' + st.renamedModelKinds + ' 个（model × size 组合；本次从名称提炼出型号的行 '
    + st.matchedSized + ' 条，其中库里原先没有/不一致而**新增提炼**的 ' + st.newlyExtracted + ' 条）');
  console.log('    其中命名变更（name 真被改写）  ' + renameRows.length);
  console.log('  **新合并条数**                ' + plannedDupIds.size + '（' + planMerges.length + ' 个 (model,size) 分组；不同 size 绝不合并）');
  console.log('  归一后档案数（预计）          ' + (st.total - plannedDupIds.size));
  console.log('');
  console.log('=== 二、包装 / 备注归位 ===');
  console.log('  默认包装（1:N）新增行          ' + pkgToInsert.length
    + '（其中从产品名归位 ' + pkgToInsert.filter((p) => p.source === 'name').length
    + ' ／ 既有 default_packaging 回填 ' + pkgToInsert.filter((p) => p.source === 'legacy').length + '）');
  console.log('  备注写入行数                  ' + remarkWrites);
  console.log('  原始名留档（legacy_name）      ' + legacyNameWrites);
  if (plan.legacyPackagingRows && !LEGACY_PACKAGING) console.log('  （--no-legacy-packaging：不回填既有默认包装）');
  console.log('');
  console.log('=== 三、未锚定清单（保持现状，脚本不猜） ===');
  {
    const byCat = {};
    for (const u of plan.unanchored) byCat[u.category] = (byCat[u.category] ?? 0) + 1;
    for (const [k, n] of Object.entries(byCat)) console.log('  ' + k.padEnd(28) + n + ' 条');
    console.log('  合计 ' + plan.unanchored.length + ' 条 → 明细写入 ' + CSV_UNANCHORED);
  }
  if (plan.unsafeSpans.length) {
    console.log('  ⚠ 型号紧凑匹配跨过无关文字的档案 ' + plan.unsafeSpans.length + ' 条（归位未做位置切割，整名归入包装/备注）：'
      + plan.unsafeSpans.map((x) => '#' + x.id).join('、'));
  }
  if (plan.collisions.length) {
    console.log('');
    console.log('=== 三b、归一后与既有档案重名（保持现状，交甲方确认） ===');
    for (const c of plan.collisions) {
      console.log('  归一后的名字 ' + JSON.stringify(c.name) + '：来自 #' + c.renamedId
        + '，与未改名档案 #' + c.keptIds.join('、') + ' 同名');
    }
  }

  if (!QUIET && renameRows.length) {
    console.log('');
    console.log('=== 四、命名样例（前 ' + Math.min(SAMPLE, renameRows.length) + ' 条，共 ' + renameRows.length + ' 条） ===');
    for (const r of renameRows.slice(0, SAMPLE)) {
      console.log('  #' + r.id + '  ' + JSON.stringify(String(r.from).replace(/\n/g, '\\n')) + '  →  ' + r.to);
    }
    console.log('  完整清单写入 ' + CSV_RENAMES);
    console.log('');
    console.log('=== 五、包装 / 备注归位样例 ===');
    for (const p of pkgToInsert.slice(0, SAMPLE)) {
      console.log('  包装 #' + p.productId + '  [' + p.source + ']  ' + JSON.stringify(p.packaging));
    }
    for (const [id, rm] of [...remarkTargets].slice(0, SAMPLE)) {
      if (rm) console.log('  备注 #' + id + '  ' + JSON.stringify(rm));
    }
    console.log('  完整清单写入 ' + CSV_MOVED);
  }

  // ---- CSV 存档（dry-run 也写，便于甲方先审）----
  writeCsv(CSV_RENAMES, ['id', '归一前', '归一后', '目录型号', 'size'],
    renameRows.map((r) => [r.id, r.from, r.to, r.model, r.size]));
  writeCsv(CSV_UNANCHORED, ['类别', 'id', '产品名', '目录型号', '原因'],
    plan.unanchored.map((u) => [u.category, u.id, u.name, u.model, u.reason]));
  writeCsv(CSV_MOVED, ['id', '产品名', '类型', '内容'],
    [
      ...pkgRows.map((p) => [p.productId, '', '包装(' + p.source + ')', p.packaging]),
      ...[...remarkTargets].filter(([, v]) => v).map(([id, v]) => [id, '', '备注', v]),
    ]);
  console.log('');
  console.log('  CSV：' + CSV_RENAMES + ' / ' + CSV_UNANCHORED + ' / ' + CSV_MOVED);

  // ==================== 写入（单事务） ====================
  if (!APPLY) {
    console.log('');
    console.log('（dry-run）未写库。确认无误后加 --apply 真正写入。');
    await client.end();
    return;
  }

  const countsBefore = await businessCounts(client);
  let updatedProducts = 0;
  let insertedPackagings = 0;
  let deletedProducts = 0;
  let movedTotal = 0;
  let droppedTotal = 0;
  try {
    await client.query('begin');

    // ① 产品行：命名 + 目录列 + 原始名留档 + 备注 + 补空包装
    for (const u of productUpdates) {
      const cols = Object.keys(u.sets);
      const params = [u.id, ...cols.map((c) => u.sets[c])];
      const sets = cols.map((c, i) => c + ' = $' + (i + 2)).join(', ');
      const res = await client.query('update products set ' + sets + ', updated_at = now() where id = $1', params);
      updatedProducts += res.rowCount ?? 0;
    }

    // ② 默认包装（1:N）—— (product_id, packaging) 唯一索引兜底，重复写入自然忽略
    for (const p of pkgToInsert) {
      const res = await client.query(
        'insert into product_packagings (product_id, packaging, source) values ($1, $2, $3)'
        + ' on conflict (product_id, packaging) do nothing',
        [p.productId, p.packaging, p.source]);
      insertedPackagings += res.rowCount ?? 0;
    }

    // ③ 合并：重挂全部引用外键 → 删除被并入档案
    for (const g of planMerges) {
      const live = g.survivor.row.id;
      for (const m of g.merged) {
        const dup = m.row.id;
        for (const fk of fkPlan) {
          const r = await rehangReference(client, fk, live, dup);
          movedTotal += r.moved;
          droppedTotal += r.dropped;
        }
        const del = await client.query('delete from products where id = $1', [dup]);
        deletedProducts += del.rowCount ?? 0;
      }
    }

    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    console.error('');
    console.error('写入失败，已回滚（库未被改动）：' + e.message);
    await client.end();
    process.exit(4);
  }

  console.log('');
  console.log('=== 写入完成 ===');
  console.log('  products 更新行数         ' + updatedProducts);
  console.log('  products 删除行数         ' + deletedProducts + '（目标 ' + plannedDupIds.size + '）');
  console.log('  product_packagings 新增    ' + insertedPackagings + '（目标 ' + pkgToInsert.length + '）');
  console.log('  引用重挂行数合计          ' + movedTotal);
  console.log('  唯一约束冲突删除行数      ' + droppedTotal);

  // ---- 复跑自校验：用**归一后的库**再算一次计划，差异必须为 0 ----
  const afterRows = await loadProducts(client);
  const pkAfter = await loadPackagings(client);
  const again = planNormalize(afterRows, idx);
  let residual = 0;
  for (const s of again.survivors) {
    const e = s.survivor;
    if (!eq(e.row.name, e.canonical)) residual += 1;
    if (!e.row.legacy_name && e.canonical !== e.sourceName) residual += 1;
    const want = again.remarkWrites.find((r) => r.id === e.row.id)?.remark ?? null;
    if (!eq(e.row.remark, want)) residual += 1;
  }
  const missingPkg = again.packagingRows
    .filter((p) => (LEGACY_PACKAGING || p.source !== 'legacy'))
    .filter((p) => !pkAfter.get(p.productId)?.has(p.packaging)).length;
  const dupLeft = [...again.groups.values()].filter((g) => g.length > 1).length;
  const countsAfter = await businessCounts(client);
  const dangling = await danglingRefs(client, fkPlan);

  console.log('  products 现有行数         ' + afterRows.length);
  console.log('  复跑残留差异行数          ' + residual + (residual === 0 ? '  ✅ 幂等（第二次跑应改 0 行）' : '  ❌ 请检查'));
  console.log('  仍缺的默认包装行          ' + missingPkg + (missingPkg === 0 ? '  ✅ 全部就位' : '  ❌ 请检查'));
  console.log('  仍有多条的 (型号,size) 组 ' + dupLeft + (dupLeft === 0 ? '  ✅ 全部唯一' : '  ❌ 请检查'));
  console.log('  business row counts（前 → 后）：');
  for (const k of Object.keys(countsBefore)) {
    const same = countsBefore[k] === countsAfter[k];
    console.log('    ' + k.padEnd(22) + String(countsBefore[k]).padStart(7) + ' → ' + String(countsAfter[k]).padStart(7)
      + (same ? '  ✅ 不变' : '  ' + (countsAfter[k] - countsBefore[k]) + ' 行'));
  }
  console.log('  悬空引用（引用 products 的外键）：'
    + (dangling.total === 0 ? '0 行  ✅' : JSON.stringify(dangling.byTable) + '  ❌'));
  await client.end();
  if (residual !== 0 || missingPkg !== 0 || dupLeft !== 0 || dangling.total !== 0) process.exit(5);
}

/** 业务行数（验收「业务行数不减少」） */
async function businessCounts(client) {
  const tables = ['products', 'orders', 'order_lines', 'plan_sheets', 'plan_sheet_lines', 'product_quotes',
    'inventory', 'outbound_lines', 'goods_receipt_lines', 'stocktakes', 'product_processes'];
  const out = {};
  for (const t of tables) {
    const exists = (await client.query(
      "select 1 from information_schema.tables where table_schema='public' and table_name=$1", [t])).rows.length;
    if (!exists) continue;
    out[t] = Number((await client.query('select count(*)::int as n from ' + t)).rows[0].n);
  }
  return out;
}

/** 悬空引用核对：所有引用 products 的外键表里，指向不存在产品的行数（必须为 0） */
async function danglingRefs(client, fkPlan) {
  const byTable = {};
  let total = 0;
  for (const fk of fkPlan) {
    const r = await client.query(
      'select count(*)::int as n from ' + fk.table + ' t where t.' + fk.column + ' is not null'
      + ' and not exists (select 1 from products p where p.id = t.' + fk.column + ')');
    const n = Number(r.rows[0].n);
    if (n) { byTable[fk.table] = n; total += n; }
  }
  return { total, byTable };
}

/** CSV 写出（UTF-8 BOM，Excel 直接打开） */
function writeCsv(file, header, rows) {
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [header.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

main().catch((e) => { console.error(e); process.exit(1); });
