-- =============================================================================
-- 型号归一口径审计 / SQL 核对（2026 甲方更正：前导零 = 不同尺寸，绝不合并）
-- -----------------------------------------------------------------------------
-- 甲方更正：「0-GPN 和 00-GPN 是同一型号的不同尺寸」→ 前导零 / 数字位数差异 = 不同产品，
--   绝不合并、绝不在归一化时删除前导零或折叠数字位；数字部分含前导零**逐字符比较**。
--
-- 本脚本**全部是只读查询**，用于核对「上一轮导入的 1444 条产品候选 + 2582 条成交价种子
-- 有没有把不同尺寸合并成一条」。默认不修改任何数据。
--
-- 用法（云端）：
--   psql "postgresql://fms:<密码>@47.114.92.22/fms" -f tools/ziliao/size_normalization_audit.sql
-- 用法（本地容器）：
--   docker exec -i fms-postgres psql -U fms -d fms -f - < tools/ziliao/size_normalization_audit.sql
--
-- 审计结论（2026 本地 fms_seed 实测，可作为对照）：
--   · 产品档案 1445 行 = 1444 条候选 + 1 条占位档案（未建档产品·待补）→ 无候选因去重丢失；
--   · 0-GPN / 00-GPN / 000-GPN 是三条独立档案（id 46 / 77 / 448），0-1-101 / 00-1-101 /
--     000-1-101 / 1-1-101 是四条独立档案（id 4 / 68 / 447 / 1）→ **没有发生尺寸合并**；
--   · 报价 2582 行 = 种子 CSV 2582 行 → 无报价因去重丢失；
--   · 因此**无需数据修正**：上一轮只是「疑似同产品不同写法」清单（129 组）的分类口径错了，
--     清单本身从未被用于合并（该 CSV 没有任何消费方），产品与报价都是各自建档/各自定价的。
-- =============================================================================

\echo '=== 0) 数字指纹与型号骨架辅助函数（只读，不落库） ==='
-- 数字指纹与 apps/api/src/ai/table-parser.service.ts 的 digitSignature 同口径：
-- 抽取数字段（保留前导零与位数）并用 - 连接；全角数字先转半角（属于允许的「全角半角」归一）。
CREATE OR REPLACE FUNCTION pg_temp.fms_digit_sig(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(string_agg(x, '-' ORDER BY ord), '')
  FROM (
    SELECT (g.r)[1] AS x, g.o AS ord
    FROM regexp_matches(translate(coalesce(t, ''), '０１２３４５６７８９', '0123456789'), '[0-9]+', 'g')
         WITH ORDINALITY AS g(r, o)
  ) s
$fn$;

-- 型号骨架：数字折成 # 占位（**只用于把同族写法聚到一起看**，绝不能用来判「同一产品」）
CREATE OR REPLACE FUNCTION pg_temp.fms_model_skeleton(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(
           regexp_replace(lower(translate(coalesce(t, ''),
             '（）()：:*，,。、．【】「」‘’“”－＿／　', '                        ')),
             '\s+', '', 'g'),
           '[0-9]+', '#', 'g')
$fn$;

\echo ''
\echo '=== 1) 计数核对：档案/报价有没有因去重而减少 ==='
SELECT (SELECT count(*) FROM products)  AS "产品档案总数",
       (SELECT count(*) FROM products WHERE name LIKE '%待补%') AS "占位档案数",
       (SELECT count(*) FROM products WHERE name NOT LIKE '%待补%') AS "真实产品档案数",
       (SELECT count(*) FROM product_quotes) AS "报价总数";
-- 期望：真实产品档案数 = tools/ziliao/products_candidates.csv 的候选条数（1444）
--       报价总数       = tools/ziliao/contract_price_seeds.csv 的数据行数（2582）
-- 少一条就说明有行被去重吃掉了 —— 本轮实测两者**完全相等**。

\echo ''
\echo '=== 2) 前导零型号是否各自建档（甲方点名的 0-GPN / 00-GPN） ==='
SELECT name AS "型号", id AS "档案id", type AS "类型", pg_temp.fms_digit_sig(name) AS "数字指纹"
FROM products
WHERE name IN ('0-GPN', '00-GPN', '000-GPN', '0-1-101', '00-1-101', '000-1-101', '1-1-101')
ORDER BY pg_temp.fms_digit_sig(name), name;
-- 期望：0-GPN / 00-GPN / 000-GPN 三行、数字指纹各不相同（0 / 00 / 000）→ 未被合并。

\echo ''
\echo '=== 3) 同族（型号骨架相同）的尺寸清单：证明「同型号不同尺寸」都各自在档 ==='
-- 型号骨架相同 = 同一型号族；「不同尺寸数」> 1 就是甲方说的「同一型号的不同尺寸」。
-- 期望：每个族里的每个尺寸都是**独立一行**（0-GPN / 00-GPN / 000-GPN 三行各自在档）。
SELECT pg_temp.fms_model_skeleton(name) AS "型号骨架",
       count(DISTINCT pg_temp.fms_digit_sig(name)) AS "不同尺寸数",
       count(*) AS "档案行数",
       left(string_agg(name, ' | ' ORDER BY name), 200) AS "各尺寸写法（示例·截断）"
FROM products
WHERE name NOT LIKE '%待补%'
GROUP BY 1 HAVING count(DISTINCT pg_temp.fms_digit_sig(name)) > 1
ORDER BY 2 DESC, 3 DESC LIMIT 15;

\echo ''
\echo '=== 4) 重复档案检查：同一型号是否被建了多行（>0 才需要修） ==='
SELECT name AS "型号", count(*) AS "档案行数"
FROM products
WHERE name NOT LIKE '%待补%'
GROUP BY 1 HAVING count(*) > 1
ORDER BY 2 DESC, 1 LIMIT 50;
-- 期望 0 行：同一型号被建了多条才是「重复导入」。本轮实测 0 行。
-- 说明：「同尺寸不同写法是否被判成同一档案」由应用层口径（normalizeToken + 数字指纹）决定，
--       脚本侧用第 1 节的「档案数 = 候选 CSV 行数」对齐来保证 —— 两者相等即没有行被吃掉。

\echo ''
\echo '=== 5) 报价侧：前导零型号的报价（取价不回串的前提是它们各自成行） ==='
SELECT q.id AS "报价id", c.name AS "客户", q.product_name AS "型号",
       q.unit_price_cents AS "单价(分)", q.valid_from AS "生效日",
       pg_temp.fms_digit_sig(q.product_name) AS "数字指纹"
FROM product_quotes q LEFT JOIN customers c ON c.id = q.customer_id
WHERE q.product_name ~ '^[0０]'
ORDER BY q.product_name, q.valid_from;
-- 期望：0-GPN / 00-GPN 若都存在，必然各自独立成行（不会被判成「同键改价」互相覆盖）。

\echo ''
\echo '=== 6) 危险对检查：删掉标点后文本相同、但数字指纹不同（必须靠数字守卫拦住） ==='
-- 这正是甲方更正要防的场景：归一化删标点后 1-1-101 与 111-01 会「文本假相等」，
-- 若判重/取价只看文本，就会把不同尺寸当成同一产品。服务端口径已在文本归一之外加了数字指纹守卫
--（apps/api/src/ai/table-parser.service.ts digitSignature / productIdentityKey），本查询核对数据侧。
WITH p AS (
  SELECT id, name,
         regexp_replace(lower(name), '[-_/., 　]', '', 'g') AS t,
         pg_temp.fms_digit_sig(name) AS sig
  FROM products WHERE name NOT LIKE '%待补%'
)
SELECT a.name AS "写法A", b.name AS "写法B", a.t AS "删标点后文本（相同）",
       a.sig AS "A数字指纹", b.sig AS "B数字指纹"
FROM p a JOIN p b ON a.t = b.t AND a.sig <> b.sig AND a.id < b.id
ORDER BY 1, 2 LIMIT 30;
-- 期望 0 行（现有数据里没有这种型号）；一旦出现，必须确认它们各自建档、报价不互相命中。

\echo ''
\echo '=== 7) 可选修复（本轮核对结果为 0，**默认不执行**） ==='
-- 只有当第 4 节返回行数 > 0（同一尺寸被重复建档）时才需要修复；修复动作是**保留最早的一条**、
-- 把其它重复行的引用改指过去再删除 —— 属于破坏性操作，必须在**备份后**由人工执行：
--
-- BEGIN;
--   -- ① 先看清楚要动哪些行（务必人工核对输出）
--   SELECT * FROM products WHERE pg_temp.fms_model_skeleton(name) || '#' || pg_temp.fms_digit_sig(name)
--     IN (SELECT k FROM (SELECT pg_temp.fms_model_skeleton(name) || '#' || pg_temp.fms_digit_sig(name) AS k
--                        FROM products WHERE name NOT LIKE '%待补%'
--                        GROUP BY 1 HAVING count(*) > 1) t);
--   -- ② 改指订单行/报价/库存等到保留的那条 id，再删重复行（示例，请按实际表逐张处理）
--   -- UPDATE order_lines SET product_id = <保留id> WHERE product_id = <重复id>;
--   -- UPDATE product_quotes SET product_id = <保留id> WHERE product_id = <重复id>;
--   -- DELETE FROM products WHERE id = <重复id>;
-- COMMIT;
--
-- ⚠️ 反向操作（把不同尺寸**合并**成一条）**任何情况下都不要做** —— 那正是甲方明令禁止的错误。
