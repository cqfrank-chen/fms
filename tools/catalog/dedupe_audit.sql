-- =============================================================================
-- 产品档案去重合并 · 只读核对 SQL（tools/catalog/dedupe_products.mjs 配套）
-- -----------------------------------------------------------------------------
-- 用途：合并后核对 ① 条数下降 ② 无悬空引用 ③ 每个「型号+尺寸」只剩 1 条
--       ④ 不同 size（0 / 00 / 000）仍然各自独立 ⑤ 类型以目录为准的填充情况
-- **全部是只读查询**，不修改任何数据。
--
-- 用法（本地）：
--   docker exec -i fms-ziliao-pg psql -U fms -d fms_dedupe -f - < tools/catalog/dedupe_audit.sql
-- 用法（云端，由甲方执行）：
--   psql "postgresql://fms:<密码>@<云端主机>:5432/fms" -v ON_ERROR_STOP=1 -f tools/catalog/dedupe_audit.sql
-- =============================================================================

\echo '=== 1) 计数：products 与各引用表（合并只应减少 products，不应减少业务行） ==='
SELECT 'products' AS "表", count(*) AS "行数" FROM products
UNION ALL SELECT 'order_lines',        count(*) FROM order_lines
UNION ALL SELECT 'plan_sheet_lines',   count(*) FROM plan_sheet_lines
UNION ALL SELECT 'goods_receipt_lines',count(*) FROM goods_receipt_lines
UNION ALL SELECT 'outbound_lines',     count(*) FROM outbound_lines
UNION ALL SELECT 'stocktakes',         count(*) FROM stocktakes
UNION ALL SELECT 'inventory',          count(*) FROM inventory
UNION ALL SELECT 'product_processes',  count(*) FROM product_processes
UNION ALL SELECT 'product_quotes',     count(*) FROM product_quotes
ORDER BY 1;

\echo ''
\echo '=== 2) 悬空引用检查（每个引用表都应为 0 行） ==='
SELECT 'order_lines' AS "表", count(*) AS "悬空引用行数" FROM order_lines t
  LEFT JOIN products p ON p.id = t.product_id WHERE t.product_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'plan_sheet_lines', count(*) FROM plan_sheet_lines t
  LEFT JOIN products p ON p.id = t.product_id WHERE t.product_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'goods_receipt_lines', count(*) FROM goods_receipt_lines t
  LEFT JOIN products p ON p.id = t.product_id WHERE t.product_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'outbound_lines', count(*) FROM outbound_lines t
  LEFT JOIN products p ON p.id = t.product_id WHERE t.product_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'stocktakes', count(*) FROM stocktakes t
  LEFT JOIN products p ON p.id = t.product_id WHERE t.product_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'inventory', count(*) FROM inventory t
  LEFT JOIN products p ON p.id = t.product_id WHERE t.product_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'product_processes', count(*) FROM product_processes t
  LEFT JOIN products p ON p.id = t.product_id WHERE t.product_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'product_quotes', count(*) FROM product_quotes t
  LEFT JOIN products p ON p.id = t.product_id WHERE t.product_id IS NOT NULL AND p.id IS NULL
ORDER BY 1;

\echo ''
\echo '=== 3) 同一「型号 + size」仍是多条的组（应为 0 组） ==='
SELECT catalog_model AS "型号", size_spec AS "size", count(*) AS "档案数"
FROM products
WHERE catalog_anchor = 'matched' AND size_spec IS NOT NULL
GROUP BY 1, 2 HAVING count(*) > 1
ORDER BY 3 DESC, 1
LIMIT 30;
-- 期望 0 行 —— 每个「基础型号 + size」只剩一条档案。

\echo ''
\echo '=== 4) 不同 size 仍各自独立（甲方点名的 0 / 00 / 000） ==='
SELECT catalog_model AS "型号", size_spec AS "size", count(*) AS "档案数",
       string_agg('#' || id || ' ' || left(replace(name, E'\n', ' '), 26), ' | ' ORDER BY id) AS "存活档案"
FROM products
WHERE catalog_model IN ('GPN', '1-101') AND size_spec IN ('000', '00', '0', '1', '2')
GROUP BY 1, 2 ORDER BY 1, 2;
-- 期望：GPN 的 000 / 00 / 0 三行各自独立（不是一行）；1-101 同理。

\echo ''
\echo '=== 5) 类型以目录为准：系列 × 气体 × 类型 分布 ==='
SELECT series AS "系列", gas_type AS "气体", type AS "类型", count(*) AS "档案数"
FROM products WHERE catalog_anchor = 'matched'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo ''
\echo '=== 6) 目录列填充率 ==='
SELECT count(*) AS "档案总数",
       count(catalog_model) AS "有型号",
       count(size_spec) AS "有尺寸",
       count(series) AS "有系列",
       count(gas_type) AS "有气体",
       count(*) FILTER (WHERE catalog_anchor = 'matched') AS "已锚定",
       count(*) FILTER (WHERE catalog_anchor = 'unmatched') AS "未锚定",
       count(*) FILTER (WHERE type = 'tbd') AS "类型待定",
       count(*) FILTER (WHERE catalog_note LIKE '已合并%') AS "合并存活记录"
FROM products;

\echo ''
\echo '=== 7) 未合并清单（保持现状，脚本不猜）：matched 但没写尺寸 + 未锚定 ==='
SELECT CASE WHEN catalog_anchor IS DISTINCT FROM 'matched' THEN '型号未锚定'
            ELSE '名称未写 size（型号已锚定）' END AS "类别",
       count(*) AS "档案数",
       left(string_agg(left(replace(name, E'\n', ' '), 22), ' | ' ORDER BY id), 160) AS "样例"
FROM products
WHERE catalog_anchor IS DISTINCT FROM 'matched' OR size_spec IS NULL
GROUP BY 1 ORDER BY 2 DESC;
