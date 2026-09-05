# I11 · 排程看板（甘特图拖排）

Type: task
Status: open
Phase: ④ 排期AI线
Blocked by: I05（已确认计划单进池）、I10（甘特库定版）
Spec: spec.md §5

## Objective

排程看板：已确认计划单行进待排区 → 甘特图排期（选工序/日期/核验）→ 报工驱动看板状态。

## Scope

- 待排区：已确认计划单的每个产品行（行级任务块，可筛选）
- 甘特图：纵轴工作中心（6 道聚合工序）、横轴时间（天级、周/月可切）
- 排期交互：点击任务块 → 排期面板（选工序 + 开始日期 + 核验：工序负载/工期/交期判断）→ 确认
- 工期推算：数量×单件耗时÷设备数，可覆盖（覆盖值色标+可恢复）；耗时未填占位提示
- 甘特分层：同工序重叠任务垂直错开
- 任务块点击弹订单行简介（可跳完整订单）
- 交期硬约束+产能软约束：超期红框可硬排
- 报工驱动：行报工→变绿/进行中/完成
- 独立排期状态字段（未排期/已排期，不进五态）

## Acceptance

- [x] 待排区→排期面板→确认全流程可走
- [x] 工期推算/覆盖正确；重叠分层；超期标红
- [x] 报工后看板状态自动变化
- [x] **阶段④验收（部分）**：甘特拖排可用

## 实施摘要

- **DB**（迁移 0007）：work_centers(6 泳道) / processes(13 工序字典) / product_processes(产品×工序路线·单件耗时·换型) + plan_sheet_lines 加 wc_key/start_date/cover_days；种子：6 泳道 + 13 工序
- **API**：SchedulingModule 6 端点（work-centers/processes/tasks/verify + 排期/取消 POST/DELETE）
- **WEB**：SchedulingPage（待排区 + 自研 React 泳道甘特 + ScheduleModal 排期面板 + TaskModal 简介），贪心分层、拖拽改开始日、超期红框、报工驱动色标（蓝/黄/绿）、覆盖紫虚线
- **验收**：
  - research/i11-scheduling-board.png — 看板 3 任务分层 + 紫虚线覆盖 + 周末灰化
  - research/i11-schedule-modal.png — 排期面板（verify 实时计算 + 工期提示）
- **关键 bug**（已修）：ScheduleModal DatePicker 传 string 触发 AntD 6 `qT(...).isValid is not a function`，改为 dayjs 对象包装

## Ref

- spec.md §5
- 原型 index.html（排程看板）
- research/10-gantt-selection.md（自研决策）
