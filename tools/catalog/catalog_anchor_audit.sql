-- =============================================================================
-- 目录锚定核对（**只读**）—— tools/catalog/catalog_anchor_audit.sql
-- =============================================================================
-- 用途：核对「产品档案已按官方产品目录（6 系列 / 37 型号）锚定」这件事，以及
--       锚定后的字段分布是否与 tools/catalog/product_anchor_report.md 一致。
-- 用法（**直接喂文件**，不要用 PowerShell 管道 —— 管道会把 UTF-8 中文别名搞坏）：
--   psql "<DSN>" -v ON_ERROR_STOP=1 -f tools/catalog/catalog_anchor_audit.sql
--   docker cp tools/catalog/catalog_anchor_audit.sql fms-postgres:/tmp/a.sql
--   docker exec -i fms-postgres psql -U fms -d fms -f /tmp/a.sql
-- 只读：全文只有 select / \echo，没有任何写操作。
-- 期望：§1 锚定 1046 / 未锚定 398（与 product_anchor_report.md 一致）；
--       §3 GPN 的 000 / 00 / 0 三档各自独立；§4 未锚定行只标了 catalog_note。
-- =============================================================================

\encoding UTF8
\pset border 2

\echo ''
\echo '=== 1) 产品档案锚定计数 ==='
select coalesce(catalog_anchor, '(未跑修正脚本)') as anchor,
       count(*)                                    as archives,
       count(*) filter (where size_spec is not null) as with_size,
       count(distinct catalog_model)               as models
from products
group by 1
order by 1;

\echo ''
\echo '=== 1b) 总数核对（锚定 + 未锚定 = 全部档案）==='
select count(*)                                       as total_archives,
       count(*) filter (where catalog_anchor = 'matched')   as matched,
       count(*) filter (where catalog_anchor = 'unmatched') as unmatched,
       count(*) filter (where size_spec is not null)        as size_known
from products;

\echo ''
\echo '=== 2) 按系列 / 气体类型分布（只统计锚定成功的）==='
select series, gas_type, count(*) as archives
from products
where catalog_anchor = 'matched'
group by 1, 2
order by 3 desc, 1;

\echo ''
\echo '=== 3) 前导零三档必须各自独立：0-GPN / 00-GPN / 000-GPN 的 size_spec 逐字符不同 ==='
select catalog_model, size_spec, gas_type, orifice_mm, thickness_range, count(*) as archives
from products
where catalog_model = 'GPN' and size_spec in ('000', '00', '0', '1', '2')
group by 1, 2, 3, 4, 5
order by length(size_spec) desc, size_spec;

\echo ''
\echo '=== 3b) 同一基础型号的不同 size 都是独立档案（示例：1-101）==='
select size_spec, count(*) as archives
from products
where catalog_model = '1-101'
group by 1
order by length(size_spec) desc, size_spec;

\echo ''
\echo '=== 3c) 同一「型号 + size」的档案条数 ==='
\echo '（>1 表示产品档案里存在多种包装/刻字写法，属上一轮报告的「A 类重复候选」；'
\echo '  不影响锚定正确性，但会影响「按型号+尺寸挑一条档案」的唯一性 —— 需甲方决定是否合并）'
select catalog_model, size_spec, count(*) as archives
from products
where catalog_anchor = 'matched' and size_spec is not null
group by 1, 2
having count(*) > 1
order by archives desc
limit 25;

\echo ''
\echo '=== 4) 未锚定档案抽样（保持现状，仅标记 catalog_note，绝不臆造）==='
select id, left(replace(name, chr(10), ' / '), 44) as name, catalog_note
from products
where catalog_anchor = 'unmatched'
order by id
limit 20;

\echo ''
\echo '=== 5) 影响面核对（本脚本只读；只列出计数供前后比对）==='
select 'products' as tbl, count(*) as rows from products
union all select 'product_quotes', count(*) from product_quotes
union all select 'order_lines', count(*) from order_lines
union all select 'orders', count(*) from orders;

\echo ''
\echo '=== 6) 「同型号同尺寸」报价覆盖度粗核对（按 product_id 挂接的报价）==='
select p.catalog_model, p.size_spec, count(distinct q.id) as quotes
from products p
join product_quotes q on q.product_id = p.id
where p.catalog_anchor = 'matched'
group by 1, 2
order by quotes desc
limit 15;
