#!/usr/bin/env node
/**
 * 产品档案「同型号 + 同 size」去重合并 + 类型以目录为准
 * =============================================================================
 * 甲方规则（最高优先级）：
 *   ① 型号前后带的数字 / # 号后的数字 = **size**；同一 (基础型号, size) 的多种写法
 *      （如 0-1-101 ≡ "1-101 割嘴 0#" ≡ "1-101 #0"）是**同一个产品**，合并为一条；
 *   ② 0 / 00 / 000 是**不同 size，绝不合并**（数字指纹逐字符一致，沿用既有安全口径）；
 *   ③ 无法解析 size、或型号未锚定到官方目录的档案 —— **保持现状**，只列清单，不猜。
 *
 * 做什么（一个事务内）：
 *   1) 用 tools/catalog 的目录锚定能力把每条产品档案解析为 (系列, 基础型号 catalog_model, size)；
 *   2) 按 (catalog_model, size) 分组，组内多条档案**合并为一条**（存活记录见下）；
 *   3) **重挂所有引用 products 的外键**（order_lines / plan_sheet_lines / goods_receipt_lines /
 *      outbound_lines / stocktakes / product_quotes / inventory / product_processes）→ 指向存活记录，
 *      再删除被合并的档案；
 *   4) 类型以目录为准：matched 档案的 series / gas_type / **type** 一律按目录推导
 *      （ACE→ACETYLENE、LPG→LPG；款式 → 美式 us_* / 英式 uk_*），其余保持 tbd 并标记，不臆造。
 *
 * 存活记录选择规则（固定、可复算、不随机）：
 *   ① 优先 catalog_anchor = matched（本脚本只对 matched + size 明确的组做合并，组内天然全 matched）；
 *   ② 其次「字段最全」：完整度打分 = type 具体(+2) + 默认包装(+1) + 默认工序路线(+1) + 安全库存>0(+1)；
 *   ③ 其次 id 最小（最早建档）。
 *   另外**不丢信息**：存活记录为空的 默认包装 / 默认工序路线 从被合并记录里按 id 升序补齐，
 *   安全库存取组内最大值；被合并的写法全部记入存档 CSV + 存活记录的 catalog_note。
 *
 * 命名口径（**重要，不臆造**）：
 *   目录对产品的命名 = catalog_model + size_spec，这两列一律以目录为准；
 *   显示名 name **保留存活记录的原文**，不改写 —— 甲方原始写法里带着「包装 / 刻字 / 重量 / 货号」
 *   等目录里没有的信息，改名会把这些信息抹掉（如需统一改成「型号 size」标准名，属主观判断，
 *   已列入报告「待甲方确认」，脚本提供可选开关 --canonical-name 供甲方确认后再用）。
 *
 * 幂等：目标值是「由产品名 + 目录解析出来的纯函数结果」，第二次跑差异必然为 0（--apply 后自校验）。
 * 默认 dry-run（只报告不写库）；--apply 才写库，且**单事务**，失败自动回滚。
 *
 * 用法：
 *   node tools/catalog/dedupe_products.mjs --dsn postgres://fms:fms@localhost:15433/fms_catalog
 *   node tools/catalog/dedupe_products.mjs --dsn <DSN> --apply
 * 参数：
 *   --dsn <url>        数据库连接串（也可 DATABASE_URL / DB_HOST+DB_PORT+DB_NAME+DB_USER+DB_PASSWORD）
 *   --apply            真正写库（不加 = dry-run）
 *   --csv <path>       把「被合并清单」写到 CSV（默认 dry-run 不写，--apply 时默认写
 *                      tools/catalog/dedupe_product_merges.csv）
 *   --limit N          只处理前 N 个合并组（联调 / 抽样验收）
 *   --sample N         控制台打印的合并样例条数（默认 15）
 *   --quiet            只打印汇总
 *   --canonical-name   【可选，默认关闭】把存活记录的 name 改成目录标准名「<型号> <size>#」
 *                      （甲方原始写法里的包装/刻字/重量信息会丢，**必须甲方确认后再开**）
 *
 * 硬约束（脚本自身实现，不靠人记）：
 *   · 只对 catalog_anchor='matched' 且 size_spec 非空的行做合并；未锚定 / 未写尺寸的一律不动；
 *   · 永不合并不同 size（分组键含 size 原文，逐字符比较）；
 *   · 引用表只 update 指向 products 的那一列，不删业务行
 *     （唯一约束冲突的重复行除外：inventory 的 (product_id,batch_no) 与 product_processes 的
 *      (product_id,process_id) 会先跳过冲突行、再删除被合并记录里剩下的那几行，逐条计数上报）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildModelIndex } from './lib/product-model.mjs';
import {
  CATALOG_FIELDS, canonicalName, dedupeKeyOf, norm, planDedupe, richness, targetOf,
} from './lib/dedupe-core.mjs';
// 重挂引用 products 的外键：与 normalize_products.mjs **共用同一实现**（lib/rehang.mjs），
// 保证两条合并路径的口径完全一致。
import { buildFkPlan, qi, rehangReference } from './lib/rehang.mjs';

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
const SAMPLE = Number(valOf('--sample') ?? 15) || 0;
const QUIET = has('--quiet');
const CANONICAL_NAME = has('--canonical-name');
const CSV_PATH = valOf('--csv') ?? (APPLY ? path.join(__dirname, 'dedupe_product_merges.csv') : null);
// 「未合并清单」存档（型号未锚定 / 名字没写 size）——无论 dry-run 还是 apply 都写，便于甲方逐族确认
const CSV_UNMERGED = valOf('--csv-unmerged') ?? path.join(__dirname, 'dedupe_unmerged_products.csv');

if (!DSN) {
  console.error('缺少数据库连接：请给 --dsn <url> 或设置 DATABASE_URL / DB_HOST 等环境变量。');
  console.error('（本脚本故意不设默认库，避免误连生产/云端。）');
  process.exit(2);
}

// ==================== 目录锚定（与 apps/api/src/ai/product-model.ts 同算法） ====================
// 判定逻辑集中在 lib/dedupe-core.mjs（纯函数，可被单测直接验证）；本文件只做读库 / 写库 / 报告
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_models.json'), 'utf8'));
const idx = buildModelIndex(cat);

// ==================== 引用 products 的外键（运行时从库里查，不写死） ====================
// 具体实现见 lib/rehang.mjs（与 normalize_products.mjs 共用）

// ==================== 主流程 ====================
async function main() {
  const client = new pg.Client({ connectionString: DSN });
  await client.connect();
  const who = await client.query('select current_database() as db, inet_server_addr()::text as host');
  console.log('目标库：' + who.rows[0].db + ' @ ' + (who.rows[0].host ?? 'local') + '   模式：'
    + (APPLY ? 'APPLY（真写库）' : 'DRY-RUN（只报告）'));

  const fkPlan = await buildFkPlan(client);
  if (!fkPlan.length) { console.error('库里没有引用 products 的外键 —— 是否还没跑迁移？'); await client.end(); process.exit(3); }
  const prodCols = (await client.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='products'",
  )).rows.map((r) => r.column_name);
  for (const c of ['catalog_model', 'size_spec', 'series', 'gas_type', 'catalog_anchor']) {
    if (!prodCols.includes(c)) {
      console.error('products 缺少目录列 ' + c + ' —— 请先跑迁移 0023_catalog_anchor.sql');
      await client.end(); process.exit(3);
    }
  }

  const rows = (await client.query(
    'select id, name, type, catalog_model, size_spec, series, gas_type, orifice_mm, thickness_range,'
    + ' catalog_anchor, catalog_note, default_packaging, default_routing, safety_stock'
    + ' from products order by id',
  )).rows;

  // ---- ① 逐行解析目录锚定 + ② 分组 / 选存活记录（纯函数，见 lib/dedupe-core.mjs） ----
  const { parsed, stat, groups, mergeGroups, singleGroups } = planDedupe(rows, idx);
  const planGroups = LIMIT > 0 ? mergeGroups.slice(0, LIMIT) : mergeGroups;
  const plannedDupIds = new Set();
  for (const g of planGroups) for (const m of g.merged) plannedDupIds.add(m.row.id);

  // ---- ③ 重挂引用：dry-run 统计（真实行数） ----
  const dupIds = [...plannedDupIds];
  const refMove = {};
  const refDrop = {};
  const orderLineDup = [];
  if (dupIds.length) {
    for (const fk of fkPlan) {
      const r = await client.query(
        'select ' + fk.column + ' as pid, count(*)::int as n from ' + fk.table
        + ' where ' + fk.column + ' = any($1) group by 1', [dupIds]);
      const pointing = r.rows.reduce((s, x) => s + x.n, 0);   // 指向「将被合并档案」的全部行
      refDrop[fk.table] = 0;
      if (fk.uniq.length) {
        const keyCols = fk.uniq[0].other;
        const sel = keyCols.map(qi).join(', ');
        const pcol = qi(fk.column);
        const dupKey = await client.query(
          'select ' + pcol + ' as pid, ' + sel + ' from ' + fk.table + ' where ' + pcol + ' = any($1)', [dupIds]);
        const liveIds = [...new Set(planGroups.map((g) => g.survivor.row.id))];
        const liveKey = await client.query(
          'select ' + pcol + ' as pid, ' + sel + ' from ' + fk.table + ' where ' + pcol + ' = any($1)', [liveIds]);
        const conflictOf = new Map();
        for (const r2 of liveKey.rows) {
          const k = keyCols.map((c) => norm(r2[c])).join('|');
          if (!conflictOf.has(r2.pid)) conflictOf.set(r2.pid, new Set());
          conflictOf.get(r2.pid).add(k);
        }
        const survivorOf = new Map();
        for (const g of planGroups) for (const m of g.merged) survivorOf.set(m.row.id, g.survivor.row.id);
        for (const r2 of dupKey.rows) {
          const live = survivorOf.get(r2.pid);
          const k = keyCols.map((c) => norm(r2[c])).join('|');
          if (conflictOf.get(live)?.has(k)) refDrop[fk.table] += 1;
        }
      }
      // 「重挂行数」= 真正改指存活记录的行数（撞唯一约束、按设计删除的行另计）—— 与 --apply 的写入计数同口径
      refMove[fk.table] = pointing - refDrop[fk.table];
    }
    // 同一订单重挂后出现同产品多行（业务上允许，但要检查并报告）
    // 判定口径：把合并组内所有成员（存活 + 被合并）的订单行放在一起按订单分组，>1 行即为「同单同产品多行」
    if (fkPlan.some((f) => f.table === 'order_lines')) {
      const memberIds = [...new Set(planGroups.flatMap((g) => [g.survivor.row.id, ...g.merged.map((m) => m.row.id)]))];
      const r = await client.query(
        'select o.order_no as order_no, o.id as order_id, count(*)::int as n'
        + ' from order_lines ol join orders o on o.id = ol.order_id'
        + ' where ol.product_id = any($1) group by 1, 2 having count(*) > 1 order by 1', [memberIds]);
      orderLineDup.push(...r.rows);
    }
  }

  // ---- ④ 目录列差异（含 type 以目录为准） ----
  const typeChanges = {};
  let typeChangeCount = 0;
  const catalogFieldChanges = {};
  const noteWrites = [];

  for (const p of parsed) {
    const t = p.target;
    const isDup = plannedDupIds.has(p.row.id);   // 被合并档案将被删除，不计入「改动列」统计
    if (!isDup) {
      for (const f of CATALOG_FIELDS) {
        if (norm(p.row[f]) !== norm(t[f])) catalogFieldChanges[f] = (catalogFieldChanges[f] ?? 0) + 1;
      }
      // type：**只对 matched 行以目录为准**；未锚定行保持现状（不臆造，也不擅自降级成 tbd）
      if (t.catalog_anchor === 'matched' && p.row.type !== t.type) {
        typeChangeCount += 1;
        const k = p.row.type + ' -> ' + t.type;
        typeChanges[k] = (typeChanges[k] ?? 0) + 1;
      }
    }
    // catalog_note：未锚定写原因；matched-未写尺寸写提示；合并组写合并说明；其余不动（幂等关键）
    if (t.catalog_anchor === 'unmatched' && norm(p.row.catalog_note) !== norm(t.catalog_note)) {
      noteWrites.push({ id: p.row.id, note: t.catalog_note });
    }
  }

  // 未合并清单（保持现状，脚本不猜）：型号未锚定目录 / 名字没写 size 两类
  const unmergedRecords = parsed
    .filter((p) => p.key == null)
    .map((p) => ({
      category: p.target.catalog_anchor === 'matched' ? '名称未写 size（型号已锚定）' : '型号未锚定目录',
      id: p.row.id,
      name: p.row.name,
      model: p.target.catalog_model,
      reason: p.target.catalog_anchor === 'matched' ? '名称未写尺寸（size 待人工确认）' : p.target.catalog_note,
    }));

  const survivorUpdates = [];
  const mergeRecords = [];
  let fillFieldCount = 0;
  for (const g of planGroups) {
    const s = g.survivor.row;
    const t = g.survivor.target;
    const mergedNames = g.merged.map((m) => ({ id: m.row.id, name: m.row.name }));
    const note = '已合并同一「型号+尺寸」的 ' + g.merged.length + ' 条档案（'
      + mergedNames.map((m) => '#' + m.id).join('、') + '），存活 #' + s.id
      + '；目录：' + t.catalog_model + ' size ' + t.size_spec;
    const fillPkg = norm(s.default_packaging) ?? norm(g.merged.map((m) => m.row.default_packaging).find((v) => norm(v)));
    const fillRoute = norm(s.default_routing) ?? norm(g.merged.map((m) => m.row.default_routing).find((v) => norm(v)));
    const maxSafety = Math.max(Number(s.safety_stock ?? 0), ...g.merged.map((m) => Number(m.row.safety_stock ?? 0)));
    const sets = {
      catalog_model: t.catalog_model, size_spec: t.size_spec, series: t.series, gas_type: t.gas_type,
      orifice_mm: t.orifice_mm, thickness_range: t.thickness_range, catalog_anchor: 'matched',
      type: t.type, catalog_note: note,
    };
    if (CANONICAL_NAME) sets.name = canonicalName(t.catalog_model, t.size_spec);
    const extra = {};
    if (norm(fillPkg) && norm(fillPkg) !== norm(s.default_packaging)) { extra.default_packaging = fillPkg; fillFieldCount += 1; }
    if (norm(fillRoute) && norm(fillRoute) !== norm(s.default_routing)) { extra.default_routing = fillRoute; fillFieldCount += 1; }
    if (maxSafety !== Number(s.safety_stock ?? 0)) { extra.safety_stock = maxSafety; fillFieldCount += 1; }
    survivorUpdates.push({ id: s.id, sets, extra, type: t.type });
    mergeRecords.push({
      key: g.key, size: t.size_spec, series: t.series, gas_type: t.gas_type, type: t.type,
      survivor_id: s.id, survivor_name: s.name, merged: mergedNames,
    });
  }

  // ==================== 报告 ====================
  const afterTotal = stat.total - dupIds.length;
  console.log('');
  console.log('=== 一、扫描与分组 ===');
  console.log('  产品档案总数              ' + stat.total);
  console.log('  目录锚定成功（matched）   ' + stat.matched + '（其中 size 明确 ' + stat.matchedSized + '）');
  console.log('  —— matched 但未写尺寸     ' + stat.sizeUnknown + '（保持现状，不猜 size）');
  console.log('  —— 未锚定（unmatched）    ' + stat.unmatched + '（保持现状）');
  console.log('  可合并分组（matched+size）' + groups.size + ' 组');
  console.log('  —— 组内 >1 条的组         ' + mergeGroups.length + ' 组（涉及 ' + mergeGroups.reduce((s, g) => s + g.merged.length, 0) + ' 条待合并档案）');
  console.log('  —— 组内 =1 条的组         ' + singleGroups.length + ' 组（无需合并）');
  console.log('  本次计划处理的组          ' + planGroups.length + (LIMIT > 0 ? '（--limit ' + LIMIT + '）' : ''));
  console.log('  合并前档案数              ' + stat.total);
  console.log('  合并后档案数（预计）      ' + afterTotal + '（减少 ' + dupIds.length + '）');

  console.log('');
  console.log('=== 二、重挂引用（引用 products 的外键） ===');
  for (const fk of fkPlan) {
    const moved = refMove[fk.table] ?? 0;
    const dropped = refDrop[fk.table] ?? 0;
    console.log('  ' + fk.table.padEnd(20) + ' 重挂 ' + String(moved).padStart(6) + ' 行'
      + (dropped ? '  ⚠ 唯一约束冲突删除 ' + dropped + ' 行（' + fk.uniq.map((u) => u.index).join(',') + '）' : '')
      + '   引用列 ' + fk.column);
  }
  const totalMoved = Object.values(refMove).reduce((s, n) => s + n, 0);
  const totalDropped = Object.values(refDrop).reduce((s, n) => s + n, 0);
  console.log('  合计：重挂 ' + totalMoved + ' 行，删除冲突重复行 ' + totalDropped + ' 行');
  // 同一订单出现同产品多行：**业务上允许**（同一订单里同产品不同刻字/包装分行），重挂不会新增订单行，
  // 这里只做检查与提示（重挂前已存在的形态保持原样，不是错误）。
  if (!orderLineDup.length) {
    console.log('  同一订单出现同产品的行检查：无');
  } else {
    const top = [...orderLineDup].sort((a, b) => b.n - a.n).slice(0, 5)
      .map((x) => x.order_no + '×' + x.n).join('、');
    console.log('  同一订单出现同产品的行检查：' + orderLineDup.length + ' 张订单（业务上允许：同产品不同刻字/包装分行；'
      + '重挂不新增订单行）。最多行的：' + top);
  }

  console.log('');
  console.log('=== 三、类型以目录为准（matched 行） ===');
  console.log('  需要改 type 的档案        ' + typeChangeCount);
  for (const [k, n] of Object.entries(typeChanges).sort((a, b) => b[1] - a[1])) {
    console.log('    ' + k.padEnd(28) + ' ' + n);
  }
  console.log('  保持 tbd 的原因：既有枚举承载不了（日/法/澳/巴西式）或目录查不到 —— 见报告「待甲方确认」');

  console.log('');
  console.log('=== 三b、未合并清单（保持现状，脚本不猜） ===');
  {
    const byCat = {};
    for (const u of unmergedRecords) byCat[u.category] = (byCat[u.category] ?? 0) + 1;
    for (const [k, n] of Object.entries(byCat)) console.log('  ' + k.padEnd(26) + n + ' 条');
    console.log('  合计 ' + unmergedRecords.length + ' 条 → 明细写入 ' + CSV_UNMERGED);
  }

  console.log('');
  console.log('=== 四、目录列差异 ===');
  for (const f of CATALOG_FIELDS) console.log('  ' + f.padEnd(18) + (catalogFieldChanges[f] ?? 0));
  console.log('  ' + 'type'.padEnd(16) + typeChangeCount);
  console.log('  存活记录字段补齐（默认包装/工序路线/安全库存）  ' + fillFieldCount);

  if (!QUIET && mergeRecords.length) {
    console.log('');
    console.log('=== 五、合并样例（前 ' + Math.min(SAMPLE, mergeRecords.length) + ' 组） ===');
    for (const mr of mergeRecords.slice(0, SAMPLE)) {
      console.log('  [' + mr.key + ']  系列 ' + (mr.series ?? '—') + ' / 气体 ' + (mr.gas_type ?? '—') + ' / 类型 ' + mr.type);
      console.log('      存活 #' + mr.survivor_id + '  ' + JSON.stringify(String(mr.survivor_name ?? '').slice(0, 60)));
      for (const m of mr.merged.slice(0, 6)) console.log('      并入 #' + m.id + '  ' + JSON.stringify(String(m.name ?? '').slice(0, 60)));
      if (mr.merged.length > 6) console.log('      …… 其余 ' + (mr.merged.length - 6) + ' 条见 CSV');
    }
  }

  // ==================== 写入（单事务） ====================
  if (!APPLY) {
    console.log('');
    console.log('（dry-run）未写库。确认无误后加 --apply 真正写入。');
    if (CSV_PATH && mergeRecords.length) {
      writeCsv(CSV_PATH, mergeRecords, totalMoved, totalDropped);
      console.log('被合并清单已写出：' + CSV_PATH + '（' + mergeRecords.reduce((s, m) => s + m.merged.length, 0) + ' 行）');
    }
    writeUnmergedCsv(CSV_UNMERGED, unmergedRecords);
    console.log('未合并清单已写出：' + CSV_UNMERGED + '（' + unmergedRecords.length + ' 行）');
    await client.end();
    return;
  }

  let movedTotal = 0;
  let droppedTotal = 0;
  let updatedProducts = 0;
  let deletedProducts = 0;
  let typeWrites = 0;
  try {
    await client.query('begin');

    // ① 写「非合并」行的目录列 + type
    for (const p of parsed) {
      if (plannedDupIds.has(p.row.id)) continue;
      const t = p.target;
      const sets = [];
      const params = [];
      // 占位符编号：params[0] 预留为 $1（存活/目标 id），因此每个值的编号 = 入队后长度 + 1
      const push = (col, val) => { params.push(val); sets.push(col + ' = $' + (params.length + 1)); };
      if (t.catalog_anchor === 'unmatched') {
        // 未锚定行：**不动目录列**（只兜底标记 anchor + 写明原因；与 apply_catalog_correction 同值 → 幂等）
        if (norm(p.row.catalog_anchor) !== 'unmatched') push('catalog_anchor', 'unmatched');
        if (norm(p.row.catalog_note) !== norm(t.catalog_note)) push('catalog_note', t.catalog_note);
      } else {
        for (const f of CATALOG_FIELDS) {
          if (norm(p.row[f]) === norm(t[f])) continue;
          push(f, t[f]);
        }
        if (p.row.type !== t.type) { push('type', t.type); typeWrites += 1; }
        // matched 但名称没写尺寸：写「size 待人工确认」提示（size_spec 仍为 null，绝不猜）
        if (t.size_spec == null && norm(p.row.catalog_note) !== norm(t.catalog_note)) push('catalog_note', t.catalog_note);
      }
      if (!sets.length) continue;
      params.unshift(p.row.id);
      const res = await client.query('update products set ' + sets.join(', ') + ', updated_at = now() where id = $1', params);
      updatedProducts += res.rowCount ?? 0;
    }

    // ② 存活记录：目录列 + type + 合并说明 + 字段补齐
    for (const u of survivorUpdates) {
      const sets = [];
      const params = [];
      // 占位符编号：params[0] 预留为 $1（存活记录 id），因此每个值的编号 = 入队后长度 + 1
      for (const [col, val] of Object.entries(u.sets)) { params.push(val); sets.push(col + ' = $' + (params.length + 1)); }
      for (const [col, val] of Object.entries(u.extra)) { params.push(val); sets.push(col + ' = $' + (params.length + 1)); }
      params.unshift(u.id);
      const res = await client.query('update products set ' + sets.join(', ') + ', updated_at = now() where id = $1', params);
      updatedProducts += res.rowCount ?? 0;
      typeWrites += 1;
    }

    // ③ 重挂引用 + 删除被合并档案
    for (const g of planGroups) {
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
  console.log('  products 删除行数         ' + deletedProducts + '（目标 ' + dupIds.length + '）');
  console.log('  引用重挂行数合计          ' + movedTotal);
  console.log('  唯一约束冲突删除行数      ' + droppedTotal);
  console.log('  type 写入行数             ' + typeWrites);

  // ---- 幂等自校验 ----
  const again = (await client.query(
    'select id, name, type, catalog_model, size_spec, series, gas_type, orifice_mm, thickness_range,'
    + ' catalog_anchor, catalog_note from products order by id',
  )).rows;
  const stillDup = new Map();
  let residual = 0;
  for (const r of again) {
    const t = targetOf(r.name, idx);
    let bad = false;
    if (t.catalog_anchor === 'unmatched') {
      // 未锚定行：只要求 anchor 兜底 + 原因写明（目录列保持现状，不比对）
      if (norm(r.catalog_anchor) !== 'unmatched' || norm(r.catalog_note) !== norm(t.catalog_note)) bad = true;
    } else {
      for (const f of CATALOG_FIELDS) if (norm(r[f]) !== norm(t[f])) { bad = true; break; }
      if (!bad && r.type !== t.type) bad = true;
      // matched 且名称未写尺寸：要求写明提示；已写尺寸的行 catalog_note 由合并说明占用，不比对
      if (!bad && t.size_spec == null && norm(r.catalog_note) !== norm(t.catalog_note)) bad = true;
    }
    if (bad) residual += 1;
    const k = dedupeKeyOf(t);
    if (k) stillDup.set(k, (stillDup.get(k) ?? 0) + 1);
  }
  const dupLeft = [...stillDup.values()].filter((n) => n > 1).length;
  const post = await client.query('select catalog_anchor, count(*)::int as n from products group by 1 order by 1 nulls first');
  console.log('  products 现有行数         ' + again.length);
  console.log('  复跑残留差异行数          ' + residual + (residual === 0 ? '  ✅ 幂等（第二次跑应改 0 行）' : '  ❌ 请检查'));
  console.log('  仍有多条的合并组          ' + dupLeft + (dupLeft === 0 ? '  ✅ 全部（型号+尺寸）唯一' : '  ❌ 请检查'));
  console.log('  catalog_anchor 分布：' + post.rows.map((x) => (x.catalog_anchor ?? '(null)') + '=' + x.n).join('  '));
  // 被合并清单：只在**本次确实有合并**时写，避免复跑（0 合并）把上一轮的存档清空
  if (CSV_PATH && mergeRecords.length) {
    writeCsv(CSV_PATH, mergeRecords, movedTotal, droppedTotal);
    console.log('  被合并清单已写出：' + CSV_PATH + '（' + mergeRecords.reduce((s, m) => s + m.merged.length, 0) + ' 行）');
  } else if (CSV_PATH) {
    console.log('  本次无合并，保留上一轮的被合并清单存档：' + CSV_PATH);
  }
  writeUnmergedCsv(CSV_UNMERGED, unmergedRecords);
  console.log('  未合并清单已写出：' + CSV_UNMERGED + '（' + unmergedRecords.length + ' 行）');
  await client.end();
  if (residual !== 0 || dupLeft !== 0) process.exit(5);
}

/**
 * 未合并清单 CSV —— **保持现状、不猜**的两类档案：
 *   ① 型号未锚定目录（目录里没有该型号 / 边界不干净 / 尺寸有歧义，原因逐条写明）
 *   ② 型号已锚定但名字没写 size（size 未定死，绝不默认成某个档位）
 * 供甲方逐族确认后，再决定建立型号别名或补 size。
 */
function writeUnmergedCsv(file, records) {
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['类别,id,产品名,目录型号,原因'];
  for (const r of records) lines.push([r.category, r.id, r.name, r.model, r.reason].map(esc).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String.fromCharCode(0xFEFF) + lines.join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10), 'utf8');
}

/** 被合并清单 CSV（存活记录 + 被并入的每条：id 与原始名字） */
function writeCsv(file, mergeRecords, movedTotal, dropTotal) {
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['分组键,系列,气体类型,目录类型,存活id,存活名字,被合并id,被合并名字,引用重挂行数,唯一约束冲突删除行数'];
  for (const mr of mergeRecords) {
    for (const m of mr.merged) {
      lines.push([mr.key, mr.series, mr.gas_type, mr.type, mr.survivor_id, mr.survivor_name, m.id, m.name,
        movedTotal, dropTotal].map(esc).join(','));
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}

main().catch((e) => { console.error(e); process.exit(1); });
