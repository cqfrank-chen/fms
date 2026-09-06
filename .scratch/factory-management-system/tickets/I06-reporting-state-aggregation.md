# I06 · 报工（按工序推进）+ 状态机聚合

Type: task
Status: open → resolved
Phase: ② 订单线
Blocked by: I05
Spec: spec.md §4.2/§4.3, §5.2, §6（入库触发）

## Objective

计划单行报工（办公室 PC 代录）**按工序推进** → 行进度聚合 → 计划单/订单状态联动 → 触发入库单草稿。

## Scope

- **工序推进报工（本轮核心修订）**：产品配了工序路由（product_processes，I13 配置）时，报工 = 完成「当前工序」（plan_sheet_lines.route_seq 指向）；中间工序一次报满整批 → 自动推进到路由下一道（route_seq+1、wcKey 换下一道泳道、已排期则 startDate 顺延、coverDays 复位自动）；**只有末道工序报满才累计成品** completedQuantity
- 状态聚合：末道报满 → 计划单已完成 → 订单已完成 → 进归档；首道报工 → 生产中（留在排期池逐道推进）
- 报工事件触发入库单草稿（仅末道/成品直报；批次 FG-YYYYMMDD-NN，仓管确认在 I08）
- 无工序路由产品：成品直报兼容（可分批）
- 变更联动：草稿态变更自动重生成、确认后人工处置（订单不走冲销）

## Acceptance

- [x] 有路由产品：报中间工序不产成品、不触发入库；报末道才成品累计 → 计划单/订单完成 + 入库草稿（repro API 全链路：车削→钻中心孔→攻丝 3/3 走完）
- [x] 中间工序报工必须一次报满整批（数量不符 400 提示「整批逐道」）
- [x] 报工推进换泳道 + 已排期顺延（cut 2026-09-07 → drill 2026-09-08 → thread 2026-09-09）
- [x] 已完成计划单不可再报工（400）、全部完成后退出排期池
- [x] UI：报工弹窗显示当前工序（第 x/共 y）+ 整批数量固定；无路由产品提示补齐工序链（repro-i06-route-report 步骤 1/2/3 全绿）
- [x] 排程看板：生产中任务保留在池、甘特块随推进换泳道并标注 [当前工序 x/y]（黄=进行中）
- [x] 存量修正：completed 行 route_seq → 末道+1；production 无（回归单留生产中演示）

## Ref

- spec.md §4.2/§4.3/§5.2/§6
- 票 04 工序主数据 / I13 工序路线配置 / I11 排期池
- 原型 index.html（报工演示）

## 实施摘要（本轮工序推进改造）

- **DB**（migration 0011）：`plan_sheet_lines.route_seq int default 1`（当前工序序号，1-based；无路由忽略）
- **后端** `plan-sheets.service.ts`：`report` 重构 —— 无路由走 `reportDirect`（原成品直报保留）；有路由整批逐道：中间道推进（route_seq+1、wcKey=下一道泳道、coverDays=null、已排期 startDate 顺延、confirmed→production）/ 末道走 `reportDirect` 置 route_seq=L+1 并完成聚合+入库；`attachLines` 批量附加工序推进信息（routeTotal/currentStepName/requiredQty/finished）
- **后端** `scheduling.service.ts`：排期池条件 confirmed → confirmed+production（生产中任务留在看板推进）；任务返回 routeSeq/routeTotal/stepIdx/currentStepName；路由预拉含工序名
- **前端** PlansPage：报工弹窗工序引导（当前工序 Alert + 数量整批固定 + 结果消息区分推进/末道）；产品行与详情加工序进度；**SchedulingPage**：色标黄=已推进（routeSeq>1 或部分成品）、块 label 与悬浮/任务简介/排期面板显示当前工序，待排区可含生产中任务
- **存量修正**：completed 行 route_seq=末道+1（产品 1 三道路由 → 4）
- 验收证据：API 链路（PO-STEP-REGR 三道路由走完） + `research/repro-i06-route-report.cjs` + `shots-i06-route/*.png`（弹窗/推进/看板 全绿 0 console error）
- 留作演示：PS-20260906-05/-06 生产中（2/3，钻中心孔）
