# I07 · 计划单列表筛选/反查（订单线收尾）

Type: task
Status: open → resolved
Phase: ② 订单线
Blocked by: I06
Spec: spec.md §4.5

## Objective

计划单列表完整化：筛选（状态/客户/单号）+ 来源订单反查弹窗——订单线端到端验收。

## Scope

- 计划单列表筛选：状态（草稿/已确认/生产中/已完成/已作废）/ 客户 / 单号关键字
- 来源订单反查：点击弹窗显示完整订单详情（含产品行/刻字/包装）
- 列表展示：产品行（含刻字 ✒/已排 ⏱/已报 ✅ 标记）

## Acceptance

- [x] 三种筛选生效（PlansPage 状态含已作废筛选；驳回闭环后作废单轨迹可见，repro-i05-voided-visible 单点验证）
- [x] 反查弹窗字段齐全（OrderTraceModal 单头+单价/币种/小计/刻字/包装）
- [x] **阶段②订单线验收**：录单→审核→报工→订单完成全流程走通（含本轮驳回重做 + 工序推进修订回归）

## 实施摘要

PlansPage 筛选/详情 + OrderTraceModal 反查（共享 OrderDetailModal 关联单）；I05 驳回闭环、I06 工序推进均在其上迭代，验收覆盖见各票 repro。

## Ref

- spec.md §4.5、§11（阶段②验收）
