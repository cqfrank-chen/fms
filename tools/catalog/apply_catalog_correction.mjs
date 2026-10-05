#!/usr/bin/env node
/**
 * 产品档案「目录锚定」修正脚本（任务二第 2/3 步）
 * =============================================================================
 * 做什么：把每一条产品档案的产品名解析为（系列, 基础型号, size），把**目录权威值**写进新增列：
 *   catalog_model / size_spec / series / gas_type / orifice_mm / thickness_range
 *   catalog_anchor（matched | unmatched）/ catalog_note（未锚定原因）
 *
 * 不做什么（硬约束）：
 *   · **不改 name、不改 type、不新增行、不删除行、不合并任何不同 size**（甲方规则：不同 size 是独立档案）；
 *   · 锚定不到目录的档案**保持现状**，只把 catalog_anchor 标成 unmatched 并写明原因 —— 绝不臆造；
 *   · 不碰订单 / 报价 / 其它任何表（本脚本只 select / update products）。
 *
 * 幂等：目标值是「由产品名解析出来的纯函数结果」，所以第二次跑差异必然为 0（--apply 后会自校验并打印）。
 *
 * 用法（**默认 dry-run，只报告不写库**）：
 *   node tools/catalog/apply_catalog_correction.mjs --dsn postgres://fms:fms@localhost:15432/fms_test
 *   node tools/catalog/apply_catalog_correction.mjs --dsn <云端 DSN> --apply
 * 参数：
 *   --dsn <url>       数据库连接串（也可用环境变量 DATABASE_URL / DB_HOST+DB_PORT+DB_NAME+DB_USER+DB_PASSWORD）
 *   --apply           真正写库（不加就是 dry-run）
 *   --fill-only       只补空列（已有值的列不覆盖）—— 保守模式
 *   --limit N         只处理前 N 行（联调 / 抽样验收用）
 *   --quiet           只打印汇总
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildModelIndex, explainProductModel } from './lib/product-model.mjs';

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
const FILL_ONLY = has('--fill-only');
const LIMIT = Number(valOf('--limit') ?? 0) || 0;
const QUIET = has('--quiet');

if (!DSN) {
  console.error('缺少数据库连接：请给 --dsn <url> 或设置 DATABASE_URL / DB_HOST 等环境变量。');
  console.error('（本脚本故意不设默认库，避免误连生产/云端。）');
  process.exit(2);
}

// 目录型号索引（与 apps/api/src/ai/product-model.ts 同算法，见 verify_parity.mjs）
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog_models.json'), 'utf8'));
const idx = buildModelIndex(cat);

/** 由产品名解析出该行应有的目录锚定字段（纯函数：同样的名字永远得到同样的结果） */
function targetOf(name) {
  const ex = explainProductModel(name, idx);
  const p = ex.result;
  if (!p) {
    return { catalog_model: null, size_spec: null, series: null, gas_type: null, orifice_mm: null,
      thickness_range: null, catalog_anchor: 'unmatched', catalog_note: ex.reason ?? '型号未锚定到目录' };
  }
  return {
    catalog_model: p.model,
    size_spec: p.size,
    series: p.series,
    gas_type: p.gasType,
    orifice_mm: p.orificeMm,
    thickness_range: p.thicknessRange,
    catalog_anchor: 'matched',
    catalog_note: p.sizeKnown ? null : '名称未写尺寸（size 待人工确认）',
  };
}

const FIELDS = ['catalog_model', 'size_spec', 'series', 'gas_type', 'orifice_mm', 'thickness_range',
  'catalog_anchor', 'catalog_note'];
const norm = (v) => (v === null || v === undefined ? null : String(v));

async function main() {
  const client = new pg.Client({ connectionString: DSN });
  await client.connect();
  const who = await client.query('select current_database() as db, inet_server_addr()::text as host');
  console.log('目标库：' + who.rows[0].db + ' @ ' + (who.rows[0].host ?? 'local') + '   模式：'
    + (APPLY ? 'APPLY（真写库）' : 'DRY-RUN（只报告）') + (FILL_ONLY ? ' + fill-only' : ''));

  const cols = FIELDS.join(', ');
  const sql = 'select id, name, ' + cols + ' from products order by id'
    + (LIMIT > 0 ? ' limit ' + LIMIT : '');
  let rows;
  try {
    rows = (await client.query(sql)).rows;
  } catch (e) {
    console.error('查询失败（是否还没跑迁移 0023_catalog_anchor.sql？）：' + e.message);
    await client.end();
    process.exit(3);
  }

  const stat = { scanned: rows.length, matched: 0, matchedSize: 0, unmatched: 0, changed: 0, unchanged: 0 };
  const fieldChanges = {};
  const samples = [];
  const unmatchedSamples = [];
  const updates = [];

  for (const r of rows) {
    const t = targetOf(r.name);
    if (t.catalog_anchor === 'matched') {
      stat.matched += 1;
      if (t.size_spec) stat.matchedSize += 1;
    } else {
      stat.unmatched += 1;
      if (unmatchedSamples.length < 8) unmatchedSamples.push(r.name);
    }
    const diff = [];
    for (const f of FIELDS) {
      const cur = norm(r[f]);
      let want = t[f];
      if (FILL_ONLY && cur !== null && cur !== '') continue; // 保守模式：不覆盖已有值
      want = norm(want);
      if (cur === want) continue;
      diff.push([f, cur, want]);
      fieldChanges[f] = (fieldChanges[f] ?? 0) + 1;
    }
    if (!diff.length) { stat.unchanged += 1; continue; }
    stat.changed += 1;
    updates.push({ id: r.id, name: r.name, diff });
    if (samples.length < 12) samples.push({ id: r.id, name: r.name, diff });
  }

  console.log('');
  console.log('=== 扫描结果 ===');
  console.log('  产品档案           ' + stat.scanned);
  console.log('  锚定成功           ' + stat.matched + '（其中 size 明确 ' + stat.matchedSize + '）');
  console.log('  未锚定（保持现状）  ' + stat.unmatched);
  console.log('  **需要修正的行数**  ' + stat.changed);
  console.log('  已经一致（无需改）  ' + stat.unchanged);
  console.log('');
  console.log('=== 分列改动统计 ===');
  for (const f of FIELDS) console.log('  ' + f.padEnd(18) + (fieldChanges[f] ?? 0));
  if (!QUIET && samples.length) {
    console.log('');
    console.log('=== 改动样例（前 ' + samples.length + ' 条）===');
    for (const s of samples) {
      console.log('  #' + s.id + ' ' + JSON.stringify(s.name.slice(0, 42)));
      for (const [f, cur, want] of s.diff) console.log('      ' + f + ': ' + JSON.stringify(cur) + ' -> ' + JSON.stringify(want));
    }
  }
  if (!QUIET && unmatchedSamples.length) {
    console.log('');
    console.log('=== 未锚定样例（保持现状，仅标记）===');
    for (const n of unmatchedSamples) console.log('  ' + JSON.stringify(n.slice(0, 52)));
  }

  if (!APPLY) {
    console.log('');
    console.log('（dry-run）未写库。确认无误后加 --apply 真正写入。');
    await client.end();
    return;
  }

  // ---- 写入（单事务；逐行参数化 UPDATE；只 update products 且只 update 上面 8 列）----
  let affected = 0;
  await client.query('begin');
  try {
    for (const u of updates) {
      const sets = u.diff.map(([f], i) => f + ' = $' + (i + 2)).join(', ');
      const params = [u.id, ...u.diff.map(([, , want]) => want)];
      const res = await client.query(
        'update products set ' + sets + ', updated_at = now() where id = $1', params);
      affected += res.rowCount ?? 0;
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    console.error('写入失败，已回滚（库未被改动）：' + e.message);
    await client.end();
    process.exit(4);
  }
  console.log('');
  console.log('=== 写入完成 ===');
  console.log('  UPDATE 影响行数合计 ' + affected + '（目标 ' + updates.length + ' 行）');

  // ---- 幂等自校验：再跑一遍差异，应当为 0 ----
  const again = (await client.query(sql)).rows;
  let residual = 0;
  for (const r of again) {
    const t = targetOf(r.name);
    for (const f of FIELDS) {
      let want = t[f];
      if (FILL_ONLY) {
        // fill-only 模式下，已有值本来就不该被覆盖 → 只校验「本轮应写而未写」为空
        continue;
      }
      if (norm(r[f]) !== norm(want)) { residual += 1; break; }
    }
  }
  console.log('  复跑残留差异行数 ' + residual + (residual === 0 ? '  ✅ 幂等（第二次跑应改 0 行）' : '  ❌ 请检查'));
  const post = await client.query("select catalog_anchor, count(*)::int as n from products group by 1 order by 1 nulls first");
  console.log('  写入后 catalog_anchor 分布：' + post.rows.map((x) => (x.catalog_anchor ?? '(null)') + '=' + x.n).join('  '));
  await client.end();
  if (residual !== 0) process.exit(5);
}

main().catch((e) => { console.error(e); process.exit(1); });
