/**
 * 引用 products 的外键「重挂 + 冲突行清理」—— **共享实现**（去掉重复表名硬编码）
 * =============================================================================
 * 被 dedupe_products.mjs（同型号同 size 去重）与 normalize_products.mjs（产品名归一后再次去重）共用，
 * 保证两条合并路径的重挂口径**完全一致**（含唯一约束冲突行的处理），不会各自漂移。
 *
 * 口径（与既有去重脚本一致，未改动）：
 *   · 引用 products 的外键**运行时**从 information_schema 查真实清单，不写死表名；
 *   · 普通外键：直接 update 指向存活记录（**不删业务行**）；
 *   · 带唯一索引的表（inventory(product_id,batch_no) / product_processes(product_id,process_id)）：
 *     先把**不撞唯一键**的行重挂，再把被合并记录里剩下的重复行删除，逐条计数上报。
 */

/** SQL 标识符加双引号（列名来自系统目录，仍按规范转义，避免保留字/大小写意外） */
export const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';

/** 库里所有指向 products 的外键：{ table_name, column_name } */
export async function foreignKeysToProducts(client) {
  const q = 'select tc.table_name as table_name, kcu.column_name as column_name'
    + ' from information_schema.table_constraints tc'
    + ' join information_schema.key_column_usage kcu'
    + '   on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema'
    + ' join information_schema.constraint_column_usage ccu'
    + '   on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema'
    + " where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'products' and tc.table_schema = 'public'"
    + ' order by 1, 2';
  return (await client.query(q)).rows;
}

/** 某表的**唯一索引**里，除 product 列外的其余列（用于判断重挂会不会撞唯一约束） */
export async function uniqueConflictColumns(client, table, column) {
  const q = 'select i.relname as index_name,'
    + ' array(select a.attname::text from unnest(ix.indkey::int2[]) with ordinality as u(attnum, ord)'
    + '   join pg_attribute a on a.attrelid = t.oid and a.attnum = u.attnum order by u.ord) as cols'
    + ' from pg_index ix'
    + ' join pg_class i on i.oid = ix.indexrelid'
    + ' join pg_class t on t.oid = ix.indrelid'
    + ' join pg_namespace n on n.oid = t.relnamespace'
    + " where n.nspname = 'public' and t.relname = $1 and ix.indisunique";
  const rows = (await client.query(q, [table])).rows;
  const out = [];
  for (const r of rows) {
    const cols = (r.cols ?? []).map((c) => String(c));
    if (!cols.includes(column)) continue;
    const other = cols.filter((c) => c !== column);
    if (!other.length) continue;
    out.push({ index: r.index_name, other });
  }
  return out;
}

/** 一次查清所有引用表 + 各自唯一约束，供重挂阶段复用 */
export async function buildFkPlan(client) {
  const fks = await foreignKeysToProducts(client);
  const plan = [];
  for (const fk of fks) {
    const uniq = await uniqueConflictColumns(client, fk.table_name, fk.column_name);
    plan.push({ table: fk.table_name, column: fk.column_name, uniq });
  }
  return plan;
}

/**
 * 把 `dupId` 的所有引用重挂到 `liveId`（在调用方的事务 client 上执行）。
 * @returns {{moved: number, dropped: number}} moved = 真正改指的行数；dropped = 唯一约束冲突而删除的重复行数
 */
export async function rehangReference(client, fk, liveId, dupId) {
  const col = fk.column;
  const qcol = qi(col);
  if (fk.uniq.length) {
    const conflict = fk.uniq[0];
    const notExists = conflict.other.map((c) => 't2.' + qi(c) + ' = t.' + qi(c)).join(' and ');
    const res = await client.query(
      'update ' + fk.table + ' t set ' + qcol + ' = $1 where t.' + qcol + ' = $2'
      + ' and not exists (select 1 from ' + fk.table + ' t2 where t2.' + qcol + ' = $1 and ' + notExists + ')',
      [liveId, dupId]);
    const del = await client.query('delete from ' + fk.table + ' where ' + qcol + ' = $1', [dupId]);
    return { moved: res.rowCount ?? 0, dropped: del.rowCount ?? 0 };
  }
  const res = await client.query('update ' + fk.table + ' set ' + qcol + ' = $1 where ' + qcol + ' = $2', [liveId, dupId]);
  return { moved: res.rowCount ?? 0, dropped: 0 };
}
