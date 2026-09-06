# I10 · 甘特库技术验证

Type: task（技术验证）
Status: open → resolved
Phase: ④ 排期AI线
Blocked by: —
Spec: spec.md §5.3

## Objective

验证甘特库选型：frappe-gantt（MIT 开源）vs dhtmlx-gantt（商业），满足排程看板核心要求。

## Scope

- 候选验证：frappe-gantt / dhtmlx-gantt
- 核心要求：拖拽改时间、自定义列（显示单号/产品/客户）、事件回调（拖完触发核验）
- 行级任务块（一计划单行一块）渲染验证
- 与 React 19 + AntD 6 集成验证

## Acceptance

- [x] 选定方案并给出理由：**自研 React 泳道甘特**（许可证/集成成本最简；验证记录 research/10-gantt-selection.md）
- [x] 行级任务块可拖拽（改开始日）、事件回调可用（拖完 POST schedule）
- [x] 决策折进 I11（SchedulingPage 甘特 + 分层/周视图/超期/覆盖 UI）

## 实施摘要

frappe-gantt（MIT）与 dhtmlx-gantt（商业）对比后选型自研：I11 实现 6 泳道 React 甘特（贪心分层、拖拽改期、日/周缩放、周末灰化、超期红框、覆盖紫虚线），2026-09-06 随 I06 工序推进修订继续扩展（生产任务保留池内、块标 [工序 x/y] 随报工换泳道）。

## Ref

- ADR-0001（排期风险点）
- spec.md §5.3
- research/10-gantt-selection.md
