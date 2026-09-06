# I05 · 订单确认 → 计划单草稿 → 审核

Type: task
Status: open → resolved
Phase: ② 订单线
Blocked by: I04
Spec: spec.md §4.2/§4.3

## Objective

订单确认 → 自动生成计划单草稿（预填目录默认值）→ 计划员审核（通过/不通过）→ 计划单状态机驱动。

## Scope

- 订单确认动作：草稿 → 已确认
- 自动生成计划单草稿：一单一计划单，行含产品/计划数量/包装要求/刻字
- 计划员审核：草稿 → 已确认（审核后计划单行进入排期池，排期 I11）
- **审核不通过（驳回重做，本轮补）**：草稿 → 计划单作废 + 来源订单退回草稿 → 订单可编辑 → 重新确认生成新计划单
- 状态机：订单五态 + 计划单五态（票 03）
- 计划单列表：状态/客户/单号筛选 + 来源订单反查弹窗
- 订单列表：草稿行补「编辑」入口（驳回后改单重确认的闭环前提）

## Acceptance

- [x] 确认订单后计划单草稿自动出现（预填正确）
- [x] 审核后计划单=已确认，状态机流转正确
- [x] 计划单列表筛选/反查生效
- [x] 草稿计划单可「审核不通过」：计划单作废（留轨迹）+ 来源订单退回草稿（repro-i05-reject-edit 步骤 1/2/3）
- [x] 退回的草稿订单可「编辑」（跳编辑模式整单预填）→ 保存(PATCH)后回列表刷新（步骤 3/4/5）
- [x] 编辑后重新「确认」生成新计划单草稿，旧作废单不挡重复确认（步骤 6）

## Ref

- spec.md §4
- 原型 index.html（计划单页）

## 实施摘要

**原链路（此前落地）**：`confirmOrder` 事务（订单 confirmed + 计划单草稿 PS-YYYYMMDD-NN + 行快照从订单行复制）；`audit` 草稿→已确认；列表状态/客户/关键字筛选 + 来源订单反查弹窗（PlansPage + OrderTraceModal）。

**本轮驳回重做闭环（commit 1a5d4cf）**：
- 后端 `POST /plan-sheets/:id/reject`（plan-sheets.service.ts `reject`）：仅草稿计划单 + 来源订单已确认时可驳；事务内 ①删计划单行快照（避免 FK 挡后续订单行编辑）②计划单置 voided ③订单回 draft
- `confirmOrder` 重复确认检测排除 voided 计划单 → 驳回后改单重确认可生成新单
- 前端 PlansPage：draft 行加红色「不通过」+ Popconfirm（明示后果：计划单作废、订单退回草稿）
- 前端 OrdersPage：draft 行加「编辑」→ 受控 Tab 切到新建卡进入编辑模式（标题「编辑订单 XX」/按钮「保存修改」/「返回列表」退出），editOrder prop 载入整单预填，PATCH 保存后 onEdited 回列表并 refreshTick 刷新；编辑模式隐藏 AI 导入卡片
- 验收证据：`research/repro-i05-reject-edit.cjs` + `shots-i05-reject/*.png`，API + UI 全链路 10 步 9 OK + 1 语义断言修正后全绿，0 console error
