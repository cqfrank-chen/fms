# 开票功能（I16）· 做账模块 Review + 实现报告

日期：2026-10-05 ｜ 范围：`apps/api`（NestJS 11 + Drizzle + PostgreSQL）、`apps/web`（React 19 + AntD 6）
约束遵守：只本地 commit、不 push、不碰云端；迁移只新增；金额全走 `common/money.ts` 定点助手；写接口全部留痕 `operator_id`；未改动既有收款/核销/成本逻辑。

> **追加（同日）**：客户要求「不要做的太复杂，只需要价格、已经开票价格、是否开完票」——
> 已按「只简化交互层、不删除既有能力、后端契约与既有测试保持可用」完成简化，详见文末 **第五步**。

---

## 第一步：现有做账模块 Review（未改代码，仅新增开票线）

### 1. 现状梳理

**数据模型（`apps/api/src/db/schema.ts`）**

| 域 | 表 | 关键字段 |
| --- | --- | --- |
| 主数据 | `customers` / `suppliers` / `operators` | `credit_days`（账期天数）、`settlement`（结算方式枚举） |
| 订单 | `orders` / `order_lines` | `order_no` 唯一、`status`（五态）、`quantity`、`unit_price numeric(10,2)`、`currency` |
| 账目 | `receivables` / `payables` | `recv_no`/`pay_no` 唯一、`source_type`+`source_id`（订单/来料）、`amount`、`settled_amount`、`status`（复用 `receipt_status` 三态）、`due_date` |
| 单据 | `collection_slips`+`collection_slip_lines` / `payment_slips`+`payment_slip_lines` | `collect_no`/`pay_no`、`mode`（`slip_mode`）、`amount`、`status`（`slip_status`：confirmed/voided）、`voided_at`、`operator_id` |
| 成本 | `monthly_costs` | `month`(YYYY-MM)+`category`（`cost_category` 六类）唯一、`amount` |
| 其他 | `incoming_goods`（材料成本来源）、`outbounds`、`users` 等 |  |

枚举：`order_status`(draft/confirmed/production/completed/cancelled)、`plan_status`(+voided)、`receipt_status`(draft/confirmed/voided)、`slip_status`(confirmed/voided)、`slip_mode`(settle/prepay/apply)、`cost_category`(labor/electricity/gas/rent/depreciation/other)、`user_role`(admin/planner/warehouse/accounting/workshop)。
**结论：改造前系统中不存在任何「发票 / 开票 / 税率 / 票号」概念（全仓 grep 无 `invoice`/`发票`）。**

**单据类型与模式**
- 收款单三模：`settle` 核销应收（= 确认营收）、`prepay` 预收（挂客户贷方余额，不计营收）、`apply` 预收冲抵（用已收定金核销应收，计营收、无现金流入）。
- 付款单与收款单同构（面向供应商）。一步生效（无草稿态），错误只能整单冲销。

**编号规则**：全部 `前缀-YYYYMMDD-NN`。`SO/PS/GR/OUT/IN/ST` 用 `max(substring(no from '[0-9]+$')::int)+1`；`REC/PAY` 同法；`CO/PM` 走 `accounting.service.nextSeqNo()`（`SPLIT_PART(no,'-',3)` 取 max+1，事务内取号）。编号格式与业务日强绑定（东八区 TZ 配置）。

**核销逻辑**
- 核销明细落 `collection_slip_lines(slip_id, receivable_id, amount)`；校验「核销合计 = 收款金额」、客户一致、未超应收剩余。
- 并发安全：按 id 升序 `SELECT ... FOR UPDATE` 锁应收，然后 `settled_amount = settled_amount + Δ` 原子自增（不读改写）。
- 冲销：条件更新 `WHERE id=? AND status='confirmed'` 保证重复冲销只有一次成功；回滚用 `GREATEST(0, settled_amount - Δ)`；同样按 id 升序加锁避免死锁。
- 预收余额 = Σ(prepay) − Σ(apply)（`prepayBalanceCents` 内存累加，事务内调用）；apply 时校验余额充足。
- **不支持部分冲销 / 退款**：只有整单冲销。

**营收确认口径：现金收付制**
`profit(month).revenue` = `SUM(collection_slips.amount)`，条件 `mode IN ('settle','apply') AND status='confirmed'` 且 `created_at` 落在本地月边界；预收不计营收。材料 = `incoming_goods(confirmed, createdAt 当月)`；制费 = 六类 `monthly_costs`；`profit = revenue − material − manufactureCost`。

**月度成本 / 利润视图**
- 月度成本：固定六类手填（`month+category` upsert），材料自动汇总不可手填。
- 对账单 `statements()`：按客户汇总 invoiced(Σ应收金额)/settled(Σ已核销)/prepay(预收−冲抵)/balance，并按 `due_date`（= 订单确认日 + creditDays）分账龄桶 `current/d30/d60/d90/d90p`。
- 四表 CSV 导出（出库明细/来料采购/收款明细/付款明细），带 CSV 公式注入防护。

### 2. 与订单 / 出库的关联链路

```
订单草稿 ──确认(confirmOrder)──▶ 订单已确认
                              ├─ 生成计划单草稿 PS-…
                              └─ 生成订单级应收 REC-…（source_type='order', amount=整单 Σ 数量×单价, due_date=确认日+账期）
出库(outbound shipped) ──▶ 只扣库存，不再生成应收（决策修订：应收在订单确认时开立）
出库冲销 ──▶ 按退回金额冲减该订单应收（改小 or 金额置 0 + status='voided'）
订单取消/驳回 ──▶ 未核销应收整单冲销；已核销则拒绝（要求先冲销收款单）
收款单 ──核销──▶ collection_slip_lines → receivables.settled_amount 累加（营收确认时点）
```
即：**订单是应收的锚点，出库只影响库存与应收金额的增减，资金核销独立于出库。**

### 3. 缺口与风险清单（按严重度）

| # | 严重度 | 缺口/风险 | 说明与影响 |
| --- | --- | --- | --- |
| 1 | 高 | **无开票/发票概念** | 无票号、票种、税率、税额、作废留痕；无法与税控开票记录核对，增值税申报无据 → 本次补齐（见第二步） |
| 2 | 高 | **订单金额与收款/开票无可视对账** | 只有「应收/收款」视角，没有「按订单：订单金额 / 已开票 / 未开票 / 已收款 / 未收」；出库冲销会改应收金额，订单金额与应收金额可能不一致，账务只能人工比对 |
| 3 | 高 | **金额精度路径不统一** | `orders.service.attachLines` 原用 binary64 逐行累加 `quantity*unitPrice` 作为订单总额，而 SQL 侧用 `ROUND(unit_price*100)`、`money.ts` 用整数分 → 三处口径存在 1 分尾差风险（本次将订单总额改为 `sumLineCents` 定点，并新增 cents 字段） |
| 4 | 中 | **编号并发** | `max+1` 取号无重试/无唯一冲突中文兜底，并发同秒可能撞号返回 500（开票本次用「唯一索引 + 23505 中文兜底」规避） |
| 5 | 中 | **无部分冲销 / 无红冲** | 收付款只能整单冲销，退款、部分退回、跨月红冲无模型；「作废」≠「红冲」，税务上跨月需红字发票 |
| 6 | 中 | **可审计性缺口** | 收款/付款冲销只写 `voided_at`，**没有冲销原因、没有冲销人**（`operator_id` 仍是原经办人）；无通用操作日志表；`monthly_costs` upsert 无历史版本 |
| 7 | 中 | **幂等** | 核销侧有行锁 + 条件更新（较好），但外部单号（银行流水号、发票号）无幂等键；重复提交靠业务字段唯一性约束 |
| 8 | 中 | **营收时点口径** | 营收按 `created_at timestamptz` 与月边界字符串比较（依赖容器 `TZ=Asia/Shanghai`），未使用业务日字段；预收 apply 计入营收但没有「开票/发货」锚点，营收与开票两条线无法勾稽 |
| 9 | 低 | 账龄近似 | `due_date = 确认日 + creditDays`，未实现「月结 30/60」次月起算口径 |
| 10 | 低 | 权限粒度 | 仅到角色级；无金额阈值、无二次审批 |
| 11 | 低 | 应收冲销丢金额 | 冲销时 `amount` 被置 0，历史金额仅存于之前快照，追溯变弱 |
| 12 | 低 | 导出不含发票 | 四表导出无开票数据（本次为不改既有导出契约，未扩列） |

### 4. 「开票」应挂在现有模型的哪个位置

**结论：新增独立票流 `invoices` + 多对多关联表 `invoice_orders`（挂 `orders`、客户外键 `customer_id`），不挂 `receivables`、不挂 `collection_slips`。订单「已开票金额」实时聚合、不落冗余字段。**

理由：
1. **语义不同**：发票是税务凭证（票号唯一、票种、税率、税额、作废/重开），生命周期与资金核销（settled_amount 增减、预收余额）不是同一条链；绑到 `receivables` 会把两者强行 1:1。
2. **实务形态多样**：多张订单合并开一张票、一张订单分批开多张票、先开票不挂单（预开票）、作废重开——只有「发票 ↔ 订单 多对多 + 允许空关联」能表达，`receivables` 是「一个来源一条应收」，无法容纳。
3. **订单是收入/应收的业务锚点**：应收本身由订单确认时开立，订单金额（Σ 行）是天然的「应开票总额」，用它算未开票余额可解释、可核对。
4. **两条独立线**：开票与收款各自留痕，互不阻塞（允许先开票后收款、先收款后开票），账务页同屏呈现「订单金额 / 已开票 / 未开票 / 已收款 / 未收」。
5. **不落冗余字段**：出库冲销、订单取消都会改变订单口径，若在订单上冗余 `invoiced_amount` 必然漂移，故一律实时聚合。

---

## 第二步：开票功能实现

### 1. 数据模型（迁移 `apps/api/drizzle/0018_invoices.sql`，纯新增）

新增枚举：`invoice_type`(vat_special/vat_general/electronic/other)、`invoice_status`(normal/voided)。

**`invoices`（发票主表）**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | serial PK | |
| invoice_no | text NOT NULL | 发票号码 |
| invoice_type | invoice_type NOT NULL | 票种 |
| customer_id | integer NOT NULL → customers | 购方（必填） |
| tax_rate | numeric(6,4) DEFAULT 0 NOT NULL | 税率（0.13/0.09/0.06/0.01/0） |
| amount_excl_cents | bigint NOT NULL | 不含税金额（分） |
| tax_cents | bigint DEFAULT 0 NOT NULL | 税额（分） |
| amount_incl_cents | bigint NOT NULL | 含税金额（分） |
| issue_date | date NOT NULL | 开票日期（业务日） |
| status | invoice_status DEFAULT 'normal' | normal/voided |
| void_reason / voided_at | text / timestamptz | 作废原因 / 时间 |
| operator_id | integer → operators | 开票人留痕 |
| void_operator_id | integer → operators | **作废人留痕（与开票人分开，不覆盖开票留痕）** |
| remark / created_at / updated_at | | |

索引：`invoices_no_normal_uq` = **部分唯一索引** `UNIQUE(invoice_no) WHERE status='normal'` —— 落实「未作废的同一 invoice_no 不允许重复」；作废后同号可重开（符合当月作废重开的实务）。若要票号终身唯一，只需把该索引改为普通唯一索引。

**`invoice_orders`（发票 × 订单 多对多）**：`id`、`invoice_id → invoices ON DELETE CASCADE`、`order_id → orders`、`created_at`，唯一约束 `(invoice_id, order_id)`。允许一张发票 0 个或多个订单。

### 2. 金额一致性（服务端强校验，`invoices/invoice-amount.ts` 纯函数）

- `tax_cents = round(amount_excl_cents × tax_rate)`：`money.ts` 新增 `rateToBp/taxCentsOf/inclCentsOf`，税率→万分点整数后与整数分相乘、整数取余半进位，**全程整数运算，无浮点取整判定**。
- `amount_incl_cents = amount_excl_cents + tax_cents`（整数相加）。
- 三者 ≥ 0；含税金额必须 > 0；金额必须是整数「分」；税率必须在 0~1（最多 4 位小数）。
- 校验失败 400 + 中文提示（字段、期望值、实际值），例如：
  `税额（taxCents）与不含税金额/税率不一致：100.00 元（10000 分） × 13%，期望 13.00 元（1300 分），实际 12.00 元（1200 分）`
  `含税金额（amountInclCents）不等于 不含税金额 + 税额：期望 113.00 元（11300 分）（＝ 100.00 元（10000 分） + 13.00 元（1300 分）），实际 112.00 元（11200 分）`
- 调用方可只传 `amountExclCents + taxRate`，税额与含税由服务端推定；传了就必须完全一致。

### 3. 开票数目 / 进度

- 单订单：`orderAmountCents`（SQL `Σ quantity × round(unit_price×100)` 定点）、`invoicedCents`（实时聚合未作废发票含税）、`uninvoicedCents = max(0, 差额)`、`overInvoiced`、张数；另有只读的 `receivedCents/unreceivedCents`（订单级应收已核销额）。
- 列表/详情：`orders` 接口新增 `totalAmountCents / invoicedCents / uninvoicedCents / overInvoiced`（`totalAmount` 同步改为定点求和）。
- 取消订单/冲销不影响发票数据（两条线独立）；超额开票**不阻断**，返回 `warning`。

### 4. 接口清单（前缀 `/api/invoices`）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/invoices?page&pageSize&customerId&status&from&to&keyword&orderId` | 登录即可 | 分页列表；关键字匹配票号/备注/客户名/关联订单号；返回客户名、订单号、金额（分）、状态、开票人、作废人 |
| GET | `/invoices/summary?from&to` | 登录即可 | 开票数目：张数 + 含税/不含税/税额合计 + `byCustomer` / `byMonth` 分组 |
| GET | `/invoices/order-status?orderId=` | 登录即可 | 单订单：订单金额 / 已开票 / 未开票 / 已收款 / 未收 + 发票清单（含作废）|
| GET | `/invoices/:id` | 登录即可 | 单张发票详情 |
| POST | `/invoices` | admin, accounting | 新建（支持多个 `orderIds`，可空）|
| PUT | `/invoices/:id` | admin, accounting | 仅 `remark/issueDate/orderIds/taxRate`；传 `amountExclCents` 直接拒绝并提示作废后重开；改税率时服务端按定点助手重算税额/含税 |
| POST | `/invoices/:id/void` | admin, accounting | 作废（`reason` 必填），置状态 + 原因 + 时间 + 作废人，不物理删除 |

金额一律以「分」为单位的整数字段（`amountExclCents/taxCents/amountInclCents`）在接口层交换，前端负责元↔分换算。

### 5. 权限矩阵（新增行）

| 写操作 | admin | planner | warehouse | accounting | workshop |
| --- | --- | --- | --- | --- | --- |
| 开票 新建 / 编辑 / 作废 (`invoices*`) | √ | — | — | √ | — |
| 读操作（`GET /api/invoices*`） | 任意已登录角色（含 workshop） | | | | |

### 6. 前端

- 新增 `apps/web/src/components/InvoicesPanel.tsx`：顶部 4 张统计卡（本期张数/含税/不含税/税额）→ 「按客户 / 按月」小计 Tabs → 「订单对账」卡（选订单后同屏展示 订单金额 / 已开票 / 未开票 / 已收款 / 未收 + 发票清单）→ 开票记录列表（客户/状态/日期区间/关键字筛选 + 分页）→ 新建/编辑弹窗（不含税金额 + 税率自动算税额与含税，关联订单多选）→ 作废弹窗（必填原因）。
- `AccountingPage` 新增「开票记录」Tab；`OrdersPage` 列表新增「已开票(元)/未开票(元)」列；`OrderDetailModal` 增加订单金额/已开票/未开票余额。
- 新增 `lib/money.ts`（前端定点镜像，与后端逐分一致）、`labels.ts` 增票种/状态/税率选项、`types.ts` 增开票类型。无新增依赖。

---

## 第三步：真实命令与输出（均为本机实际执行）

1. 迁移生成（只新增）
```
> npx drizzle-kit generate --name=invoices
[✓] Your SQL migration file ➜ drizzle\0018_invoices.sql 🚀
（内容：CREATE TYPE invoice_status / invoice_type；CREATE TABLE invoices / invoice_orders；外键；唯一索引 invoice_orders_inv_order_uq；部分唯一索引 invoices_no_normal_uq … WHERE status = 'normal'）
```
2. 单测 `npm test`（apps/api）
```
PASS src/invoices/invoice-amount.spec.ts
PASS src/invoices/invoice-stats.spec.ts
PASS src/master-data/master-import.service.spec.ts
PASS src/ai/ai-orders.controller.spec.ts
PASS src/ai/table-parser.spec.ts
PASS src/ai/order-parser-table.spec.ts
PASS src/app.controller.spec.ts
PASS src/common/money.spec.ts
Test Suites: 8 passed, 8 total
Tests:       98 passed, 98 total      （其中开票 2 个 suite 共 19 项）
```
3. 构建
```
apps/api  > nest build                        → exit 0
apps/web  > tsc -b && vite build              → ✓ built in 297ms（dist/assets/index-BXes2iFA.js 1,496.07 kB / gzip 463.51 kB）
apps/web  > oxlint                            → Found 38 warnings and 0 errors（既有页面的 set-state-in-effect 风格告警，无新增错误）
```
4. 端到端 `node test/invoice-e2e.mjs`（空库 API :3100 + PG :15432）
```
================ 结果 ================
通过 141 项，失败 0 项
```
覆盖：部分开票 → 订单已开票/未开票断言 → 第二张结清 → 开票数目统计（张数/不含税/税额/含税 + 按客户/按月）→ 作废后统计回落与订单可见金额变化、记录仍可查、重复作废中文提示 → 重复票号中文冲突、作废后同号可重开 → 金额三兄弟/负数/零/非整数/税率越界/票号缺失中文提示 → 编辑（备注/日期/关联订单可改，金额关键字段拒绝，改税率定点重算）→ 超额开票 warning → 跨客户/不存在订单校验 → 收款核销与开票互不影响 → 列表筛选/分页/关键字 → 401/403/accounting 可写 → **SQL 复算**（张数、含税/不含税/税额合计、三金额恒等式与 `tax = round(excl×rate)` 违规 0 行、按客户/按月、订单已开票、关联行数、作废发票数）。

5. 容器化（仓库根）
```
> docker compose up -d --build
容器：fms-app | Up ；fms-nginx | Up ；fms-postgres | healthy
docker logs fms-app   | grep ERROR → 0
docker logs fms-nginx | grep ERROR → 0
http://127.0.0.1/api/health → {"status":"ok","db":"up",...} [HTTP 200]
生产库迁移已自动执行：pg_tables 出现 invoices / invoice_orders；pg_indexes 出现 invoices_no_normal_uq（WHERE status='normal'）；drizzle.__drizzle_migrations 最新 id=19
生产接口冒烟：GET /api/invoices → {"items":[],"total":0,"page":1,"pageSize":5}；GET /api/invoices/summary → {count:0,...}；POST 非法金额 → 400「不含税金额（amountExclCents）不能为负，实际：-100 分」；未登录 → 401
```

---

## 第四步：遗留问题与未决点

1. **票号唯一口径**：采用「未作废唯一」（部分唯一索引），作废后同号可重开；若财务要求终身唯一，改索引一行即可（已说明）。
2. **税控尾差**：税额由本系统按「不含税×税率」定点重算；若税控开票系统票面存在 1 分差异，当前会被 400 拒绝（提示期望/实际）。是否需要允许 1 分容差是未决点（**建议不放开**，人工以票面为准时应保持票面三元恒等）。
3. **红字发票缺失**：只有「作废」，无跨月红冲（负数发票）。建议后续新增 `invoice_type='red'`（或 `is_red` 标记）并在统计中抵减。
4. **开票 ↔ 收款未自动勾稽**：仅同屏展示，无「按发票核销」的应收关联；如需开票-回款配对分析需再加视图。
5. **未采集发票代码**（`invoice_code`）与税控 20 位票号校验；如需对接税控可加列 + 校验。
6. **前端「按订单剩余未开票金额一键带出」已在第五步补齐**（订单行「开发票」按钮；多订单合并开票支持多选）。
7. **开票权限固定为 admin/accounting**；若计划员也需开票需扩 `@Roles`。
8. **既有缺口未在本票处理**（避免超范围改动）：收付款冲销缺原因/冲销人留痕、无部分冲销/退款、编号并发撞号重试、营收按业务日而非 created_at、月结账期口径、导出未含发票 —— 建议单独立票。
9. **前端 lint 有 38 条既有风格告警**（`set-state-in-effect` 等），本次未引入新错误也未顺带整改。

---

## 第五步：开票交互大幅简化（追加任务，2026-10-05）

客户原话：「不要做的太复杂，只需要，价格和已经开票价格，和是否开完票」。
原则：**只简化交互层，不删除既有能力**（后端契约兼容、既有 141 项 e2e 与 161 项 Excel e2e 保持全绿）。

### 1. 订单视角的三列

| 列 | 含义 | 展示 |
| --- | --- | --- |
| **价格(元)** | 订单总额 | 既有字段（`totalAmountCents`，定点求和） |
| **已开票(元)** | 该订单已开票金额合计（只算未作废发票，实时聚合） | 无开票显示 `0.00` |
| **开票状态** | 未开票 / 部分开票 / 已开完 | AntD Tag（灰 / 橙 / 绿） |

状态规则（`apps/api/src/invoices/invoice-stats.ts#orderInvoiceState`，全部按「分」整数比较）：

- 已开票 = 0 → `none`（未开票）
- 0 < 已开票 < 价格 → `partial`（部分开票）
- 已开票 ≥ 价格 → `done`（已开完；**超额开票仍判为已开完且不报错**）

订单列表 / 详情 / 订单开票进度接口（`/api/invoices/order-status`）均返回该状态；后端 `GET /api/orders` 每行新增 `invoiceState` 字段（`none|partial|done`）。
未开票余额未删除：仍保留在订单详情弹窗、开票进度接口与账务页「订单对账」中。

### 2. 新建开票：只让用户填一个金额

弹窗（`apps/web/src/components/InvoiceFormModal.tsx`，账务页与订单页共用）主字段：

- **关联订单**（多选；从订单行「开发票」按钮带入时锁定不可改）
- **开票金额（含税，元）** —— 唯一必填金额
- **开票日期**（默认今天）
- **发票号（可选）**
- **备注（可选）**

**税率默认 0%**：不含税 = 含税、税额 = 0，用户完全不用管税。
**「高级」（默认收起，能力不删除）**：票种、税率（13/9/6/1/0%）、客户（不挂单时必选，挂单时自动带入）、金额拆分（不含税/税额只读）、占位票号补录提示。
统计卡、按客户/按月小计、订单对账、明细列（票种/税率/不含税/税额/经办人）全部收进账务页的「高级：统计与明细」折叠区（默认收起，可用开关展开明细列）。
作废弹窗默认原因「作废重开」，原因输入框收进「高级：作废原因」。

**后端兼容（服务端自动补齐，既有入参方式仍可用）**：
- `amountInclCents` 单传即可：`taxRate` 缺省 0 → `amountExclCents = amountInclCents`、`taxCents = 0`，再走既有三金额恒等校验；
- 给了税率（如 13%）而只给含税金额时，服务端用定点整数算法**反解**不含税（`solveExclFromIncl`，初值 `incl×10000/(10000+bp)` + ±2 分整数试探），无整数分解时明确 400；
- 只给含税 + 税额时，不含税 = 含税 − 税额，再校验恒等式；
- 完整入参（`amountExclCents ± taxCents/amountInclCents`）行为不变（既有 141 项 e2e 全绿）；
- `customerId` 变为可选：缺省由关联订单反推（多单必须同客户，未挂单时必须显式指定）；
- `invoiceNo` 变为可选：缺省自动生成占位票号 **`待补号-YYYYMMDD-NN`**（同前缀最大序号 +1，事务内取号）；占位号可在编辑时**补录**真实票号，真实票号仍不可改（换号须作废重开）。

### 3. 快捷开票（一键开完）

订单行新增「**开发票**」按钮（已开完时置灰并提示）：

1. 打开弹窗并**自动带出该订单剩余未开票金额**（价格 − 已开票）；
2. 关联订单已带入且锁定，税率默认 0%、票种默认 `vat_general`、日期默认今天；
3. 点「确定开票」即结清 —— 成功后订单状态立即变为 **已开完**、未开票余额 0。

### 4. 本次改动的文件

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/invoices/invoice-stats.ts` | 新增 `orderInvoiceState()` 三态函数；`OrderInvoiceView` 增 `invoiceState` |
| `apps/api/src/invoices/invoice-amount.ts` | 新增 `solveExclFromIncl()`；`normalizeInvoiceAmounts` 支持「只给含税」简化入参（税率默认 0 / 反解 / 含税+税额 反解） |
| `apps/api/src/invoices/invoices.service.ts` | 新建：票号可选（占位号生成 `nextPlaceholderNo`）、票种默认、客户可由订单反推（`customerIdFromOrders`）、编辑允许补录占位票号；`orderStatus` 返回 `invoiceState`；DTO 字段全部改可选 |
| `apps/api/src/invoices/invoices.controller.ts` | CreateInvoiceDto：`invoiceNo/invoiceType/customerId/amountExclCents/taxRate` 改可选；UpdateInvoiceDto 增 `invoiceNo` |
| `apps/api/src/invoices/invoice-messages.ts` | 新增 `invoiceNoImmutableMessage()` |
| `apps/api/src/orders/orders.service.ts` | 订单列表/详情新增 `invoiceState` |
| `apps/api/src/invoices/invoice-amount.spec.ts` / `invoice-stats.spec.ts` | 新增 11 项单测（简化入参、反解、三态、边界） |
| `apps/api/test/invoice-simple-e2e.mjs` | **新增**简化交互 e2e（64 项） |
| `apps/api/test/invoice-e2e.mjs` | 仅「票号缺失」用例按新契约改写（缺省→201+占位号，断言数不变 141）；catch 改为 `process.exit(1)` 避免异常时假死 |
| `apps/web/src/lib/money.ts` | 新增 `splitInclCents()`（与后端反解同算法） |
| `apps/web/src/lib/labels.ts` | 新增 `INVOICE_STATE_LABEL/INVOICE_STATE_COLOR/INVOICE_PLACEHOLDER_PREFIX` |
| `apps/web/src/lib/types.ts` | 增 `InvoiceState`；`Order.invoiceState`、`OrderInvoiceStatus.invoiceState` |
| `apps/web/src/components/InvoiceFormModal.tsx` | **新增**简化开票弹窗（含「高级」折叠） |
| `apps/web/src/components/InvoicesPanel.tsx` | 重写为「主路径三件事 + 高级折叠区」；作废原因默认值；占位票号标记 |
| `apps/web/src/pages/OrdersPage.tsx` | 订单列表改为 价格/已开票/开票状态 三列；新增「开发票」按钮与弹窗；移除「未开票(元)」列（余额仍在详情/对账中） |
| `apps/web/src/components/OrderDetailModal.tsx` | 增「开票状态」标签 |

### 5. 真实命令与输出

```
apps/api > npm test
Test Suites: 8 passed, 8 total
Tests:       109 passed, 109 total     （开票两个 suite 共 30 项，其中新增 11 项简化相关）

apps/api > npm run build                    → exit 0
apps/web > npm run build                    → ✓ built in 329ms（dist/assets/index-OYCTu42V.js 1,508.86 kB）

apps/api > node test/invoice-simple-e2e.mjs（空库 API :3100 + PG :15432）
  【1. 订单三状态】未开票 none → 部分开票 partial（300.00/1000.00）→ 已开完 done（+700.00）
                   超额开票 201 且状态仍为 done、未开票余额 0、返回 warning（超出 50.00 元）
  【2. 简化开票】只传 invoiceNo + amountInclCents + issueDate + orderIds → 201
                   返回 amountExclCents == amountInclCents == 12345、taxCents == 0、taxRate == 0
                   SQL 核对：不含税 12345 / 税额 0 / 含税 12345 / 税率 0；全库恒等式违规行数 0
                   不传票号 → 自动占位号「待补号-20261005-01」；补录 SIM-REAL-9 成功，再改 → 400 中文提示
                   （兼容）完整入参 [10000,1300,11300] 正常；只给含税 11300 + 13% → 反解 [10000,1300]
  【3. 快捷开完】O2 先开 200.00（partial，剩余 30000 分）→ 按剩余金额开票 → done、未开票 0、无 warning
  【4. 鉴权】未登录 401；workshop 403；workshop 仍可读订单（含 invoiceState）
  【5. 汇总】张数/含税/不含税/税额 与 SQL 一致；作废接口仍可用（作废后 O2 回落到 partial）
  ================ 结果 ================
  通过 64 项，失败 0 项

apps/api > node test/invoice-e2e.mjs（回归，空库）
  通过 141 项，失败 0 项
apps/api > node test/excel-order-e2e.mjs（回归，空库）
  通过 161 项，失败 0 项

仓库根 > docker compose up -d --build
  fms-app / fms-nginx Up，fms-postgres healthy
  docker logs fms-app | grep ERROR → 0 ；docker logs fms-nginx | grep ERROR → 0
  http://127.0.0.1/api/health → 200
  生产库冒烟：GET /api/orders 每行含 invoiceState（无发票订单为 none）；GET /api/invoices 正常
```

### 6. 简化后的遗留问题

1. **占位票号**：`待补号-YYYYMMDD-NN` 是真实入库的票号（占未作废唯一名额）；月底对账需人工筛出待补号并补录（列表已用橙色「待补票号」标记）。
2. **税率 0% 为默认**：简化路径开出的票都是 0% 税率（不含税=含税、税额=0）；需要专票/含税分离时须在「高级」里改税率，或在税控系统按票面为准调整。
3. **金额仍不可改**：简化没有放宽「改金额须作废重开」的凭证约束（仅票号在占位状态下可补录）。
4. **订单列表移除「未开票(元)」列**：按客户要求只保留三列，未开票余额改在「详情」「开票弹窗提示」「账务页订单对账」查看；接口字段仍保留。
5. **快捷开票不做超额拦截**：已开完的订单按钮置灰，但仍可从账务页继续开票（按既有业务弹性，返回 warning）。
6. 既有缺口（无红字发票、开票↔收款未自动勾稽、发票代码未采集、冲销无原因/冲销人）依旧未处理，建议单独立票。

