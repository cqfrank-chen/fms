# 待补机制 / 占位档案 / 哨兵日 / 币种口径（I17 甲方裁定 2026-10-05）

> 面向使用者的口径说明。代码位置与实现细节见各节「实现位置」。
> 补充（甲方裁定 2，2026-10-05）：**选择下拉始终显示占位档案**（见 ② 末尾），列表页仍按开关默认隐藏。
> 本轮 5 项裁定全部落地，**迁移只新增**（0022 只加枚举值；数据修正在迁移事务之外幂等执行），
> 未改动任何既有列定义与既有数据（除裁定明确要求的历史占位产品类型修正）。

## ① 交期待定：哨兵日 2099-12-31 + `due_date_tbd` 标记（保持不变）

* **为什么有哨兵日**：`orders.due_date` 是 `NOT NULL`（I04 既有约束，本轮「迁移只新增」不动它）。
  识单结果没有交货日期时，用**哨兵日 `2099-12-31`** 占位，同时把 `due_date_tbd` 置 `true`。
* **两者必须成对**：任何「待定」单据都满足
  `due_date::date = DATE '2099-12-31' AND due_date_tbd = true`；
  人工补填真实交期后 `due_date_tbd` 自动清零（编辑订单时清除）。
* **界面口径**：订单列表的「交期」列**只认 `due_date_tbd`** → 显示红色「待定」标签（鼠标悬停给出解释），
  绝不把 2099-12-31 当成真实交期展示；编辑表单也不会把它预填成真实交期。
* **实现位置**：`apps/api/src/db/schema.ts` 的 `ORDERS_DUE_DATE_TBD`；
  `apps/api/src/orders/orders.service.ts`（写入/清除）；`apps/api/src/orders/pending-items.ts`（`due_date_missing` 中文诊断）。

## ② 占位档案默认隐藏 + 「显示占位档案」开关

两条占位档案平时只在**真的落了缺客户/缺产品的草稿**时惰性创建；
但客户/产品的**选项接口**带 `includePlaceholders=1` 时会幂等地保证它们存在（见下「选择下拉例外」）：

| 占位档案 | 出现时机 | 原始信息留在哪 |
| --- | --- | --- |
| `（未建档客户·待补）` | 落草稿时客户名在客户档案里找不到 | `orders.draft_customer_name` |
| `（未建档产品·待补）` | 落草稿时产品在目录里找不到 | `order_lines.product_name_text` |

* **默认隐藏**：客户列表 / 产品列表 / 订单列表默认都不展示占位档案（及相关单据）。
  后端接口参数 `includePlaceholders=1` 时才放行；数据库里的占位档案与订单引用**一律保留**（外键、内部逻辑不变）。
* **「显示占位档案」开关**：订单列表、设置页（客户档案 / 产品目录）各有一个开关，状态存浏览器
  `localStorage.fms.showPlaceholders`，打开即带上 `includePlaceholders=1`。
* **选择下拉例外：占位档案始终可选（甲方裁定 2，2026-10-05）**：客户/产品的**选择下拉**（建档下拉、
  订单/行改指、报价、开票、计划单、出库/入库、工序路线等一切档案下拉）**始终显示两个占位档案**，
  **不受开关影响** —— 目的是让人工把订单/行**改指**到正确的客户或产品，或**保留占位**以维持待补状态。
  实现上就是下拉请求**一律显式**带 `includePlaceholders=1`（前端 `optionsPath()`）；
  **该参数放行的同时还会幂等地保证两行占位档案存在**（`apps/api/src/common/pending-entities.ts`）——
  否则在「还没有任何未建档草稿」的干净库里，下拉根本选不到占位档案。
  下拉里占位档案带醒目的「⚠ 」前缀（前端 `optionLabel()`），保存后仍保留待补标记。
  **列表页口径不变**：客户/产品/订单列表仍按开关隐藏占位档案（默认隐藏）。
* **例外（刻意为之）**：订单列表按「**仅看有未补全项的草稿单**」（`hasPending=1`）筛选时**不受开关限制** ——
  这些草稿正是挂占位档案、等待补全的单据，隐藏了就没法补全。
* **实现位置**：`apps/api/src/common/placeholders.ts`、`apps/api/src/db/schema.ts`（`PENDING_ENTITY_NAMES` / `isPendingEntityName`）、
  前端 `apps/web/src/lib/placeholders.ts`（`withPlaceholders()` = 列表页按开关；`optionsPath()` / `optionLabel()` = 下拉口径）。

## ③ 占位产品的类型 = 中立「待定」（`tbd`）

* 产品类型枚举 `product_type` **新增**一个值 `tbd`（中文标签「待定」），原四种业务类型不变。
* 新创建的占位产品直接写 `tbd`（不再借用 `uk_acetylene`）；
  已有占位产品数据由启动时的幂等数据修正统一刷成 `tbd`。
* 占位产品**永远进不了生产链路**：引用它的订单一定带「产品未建档」待补项，确认订单会被拦截。
* **实现位置**：`apps/api/src/db/schema.ts`（`PRODUCT_TYPES` / `PRODUCT_TYPE_LABELS`）、
  `drizzle/0022_pending_enums.sql`、`apps/api/src/db/migrate.ts`（数据修正）、
  `apps/api/src/orders/orders.service.ts`（`ensurePendingProduct`）。

> 为什么数据修正不写在 .sql 里：drizzle 的 pg migrator 把本轮所有未执行迁移放在**同一个事务**，
> 而 PostgreSQL 不允许在同一事务里使用刚 `ADD VALUE` 的枚举值。
> 于是「新增枚举值」走迁移（0022），「用新值刷历史数据」放在迁移提交之后的幂等步骤（`migrate.ts`）。

## ④ .doc 计划单缺价 → 按报价记录自动回填历史价

* 管线：`.doc → doc_table 切片 CSV → POST /ai/orders/parse（识单）→ POST /orders/draft（落草稿）`。
* **两跳都会补价**（同一实现 `quotes/quote-pricing.ts`）：
  1. 识单阶段：缺 `unitPrice` 的行按「文件夹客户 + 该行产品」取价 → 命中即补 + `priceFrom='quote'` + 写 notes；
  2. 落草稿阶段：**任何**来源（.doc 切片、界面、脚本、直接调接口）缺价的行再补一次；已带价的行**绝不覆盖**。
* 取价优先级（逐档取，命中即止）：客户+产品 > 客户+产品名文本 > 通用价；
  同一档取 `valid_from` 最新的一条；未命中 → **保持缺价待补**，绝不编造价格。
* **客户未建档时**：只能命中「通用价」（绝不跨客户取价）；客户建档并导入报价后，客户档价格才会生效。
* **实现位置**：`apps/api/src/orders/draft-quote-fill.ts`（纯函数 + 单测）、`apps/api/src/orders/orders.service.ts`（`createDraftFromParse`）、
  `apps/api/src/ai/order-parser.service.ts`（`resolve` 第二遍补价）。

## ⑤ 币种统一归一为 CNY

* 识别到的 `RMB / RMB¥ / ￥ / ¥ / 人民币 / 元` 等一律归一到 **`CNY`** 存储与展示；`USD / 美元 / $` → `USD`；
  未填写或认不出 → `CNY`（一期单币种记账，不猜外币）。
* 归一发生在**写入前**（报价新增/修改/改价/批量导入、识单结果、订单行、应收快照），展示层同样归一。
* **实现位置**：`apps/api/src/common/currency.ts`（唯一权威实现，纯函数 + 单测）、
  `apps/api/src/quotes/quotes.service.ts`、`apps/api/src/ai/table-parser.service.ts`、`apps/api/src/ai/order-parser.service.ts`、
  `apps/api/src/orders/orders.service.ts`、`apps/api/src/plan-sheets/plan-sheets.service.ts`、前端 `apps/web/src/lib/labels.ts`。
* **已知边界（未擅自扩大改动面）**：`order_lines.currency` 是枚举，本轮**新增** `CNY` 取值（0022），
  历史行里已有的 `RMB` 不迁移（迁移只新增）——新写入一律 `CNY`；
  如需把历史行一次性刷成 `CNY`，可用 `apps/api/drizzle/optional/legacy_currency_to_cny.sql`（**默认不执行**）。

## 附：一轮完整的云端操作顺序（推荐）

1. 同步主数据：客户（4 家）→ 唛头模板（`tools/ziliao/sync_folder_data.mjs`，先 `--dry-run`）；
2. 导入报价记录：`tools/ziliao/find_quote_files.mjs` 产出候选 → 人工确认 → `tools/ziliao/import_quotes_cloud.mjs --dry-run` → 正式导入；
3. 落草稿：`tools/ziliao/draft_orders_from_parse.mjs --dry-run` → 正式落草稿；
4. 界面补全：订单列表勾选「仅看有未补全项的草稿单」逐项补全（可「一键从报价记录取价」），
   需要排查占位档案时打开「显示占位档案」开关。
