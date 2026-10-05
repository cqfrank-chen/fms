-- =====================================================================
-- 【可选 · 默认不执行】历史订单行 / 应收快照的币种刷成 CNY
-- ---------------------------------------------------------------------
-- 背景：I17 甲方裁定「币种统一归一为 CNY」。本轮做法是：
--   · 迁移只新增：drizzle/0022_pending_enums.sql 给 currency 枚举新增 'CNY'；
--   · 所有**写入路径**在新代码里先过 common/currency.ts 归一 → 新数据一律 CNY；
--   · 历史行里已有的 'RMB' **不迁移**（避免本轮动既有数据）。
-- 若甲方要求「历史行也统一显示/存储为 CNY」，请先备份，再在维护窗口手工执行本文件。
--
-- 注意：
--   1) 本文件放在 drizzle/optional/ 下，**不在 drizzle/meta/_journal.json 里**，
--      因此 `npm run start` 启动时的自动迁移不会执行它；
--   2) RMB 与 CNY 是同一币种的不同写法，本操作**不改变任何金额数值**（只改币种标签）；
--   3) 执行后请重启 api 让连接池刷新（非必需，仅便于日志确认）。
-- =====================================================================

BEGIN;

-- 1) 订单行：RMB → CNY（金额不变）
UPDATE order_lines SET currency = 'CNY' WHERE currency = 'RMB';

-- 2) 应收快照：RMB → CNY（金额不变）
UPDATE receivables SET currency = 'CNY' WHERE currency = 'RMB';

-- 3) 报价记录：任何非规范写法 → CNY（与 common/currency.ts 的归一口径一致）
UPDATE product_quotes
   SET currency = 'CNY', updated_at = now()
 WHERE currency IS NULL
    OR upper(btrim(currency)) NOT IN ('CNY', 'USD');

-- 核对（执行前/后可各跑一次对比）
SELECT 'order_lines' AS t, currency, count(*) FROM order_lines GROUP BY currency
UNION ALL
SELECT 'receivables', currency, count(*) FROM receivables GROUP BY currency
UNION ALL
SELECT 'product_quotes', currency, count(*) FROM product_quotes GROUP BY currency
ORDER BY 1, 2;

COMMIT;
