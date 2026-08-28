# I10 · 甘特库技术验证

Type: task（技术验证）
Status: open
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

- [ ] 选定一个库，给出理由（许可证/能力/集成成本）
- [ ] 行级任务块可拖拽、事件回调可用
- [ ] 决策折进 I11

## Ref

- ADR-0001（排期风险点）
- spec.md §5.3
