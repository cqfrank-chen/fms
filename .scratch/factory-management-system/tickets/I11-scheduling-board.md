# I11 · 排程看板（甘特图拖排）

Type: task
Status: open → resolved
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
- [x] 横轴缩放（日/周可切，周=44px/格 + 周一分隔线 + 周一标注 MM-DD）
- [x] 待排区可筛选（单号/产品/客户/刻字关键字）+ 按交期升序
- [x] 任务简介「查看完整订单」可跳完整订单（共享订单详情组件）

## 实施摘要

- **DB**（迁移 0007）：work_centers(6 泳道) / processes(13 工序字典) / product_processes(产品×工序路线·单件耗时·换型) + plan_sheet_lines 加 wc_key/start_date/cover_days；种子：6 泳道 + 13 工序
- **API**：SchedulingModule 6 端点（work-centers/processes/tasks/verify + 排期/取消 POST/DELETE）
- **WEB**：SchedulingPage（待排区 + 自研 React 泳道甘特 + ScheduleModal 排期面板 + TaskModal 简介），贪心分层、拖拽改开始日、超期红框、报工驱动色标（蓝/黄/绿）、覆盖紫虚线
- **验收**：
  - research/i11-scheduling-board.png — 看板 3 任务分层 + 紫虚线覆盖 + 周末灰化
  - research/i11-schedule-modal.png — 排期面板（verify 实时计算 + 工期提示）
- **关键 bug**（已修）：ScheduleModal DatePicker 传 string 触发 AntD 6 `qT(...).isValid is not a function`，改为 dayjs 对象包装
- **v2 完善**（I11 续推）：
  - 横轴真缩放：`scale` 接进 GanttLane，PX_DAY day=92 / week=44；周视图周一分隔线 + 周一格标 MM-DD、其余空格透明占位，周末灰化保留；layout/拖拽 effect 依赖加 scale
  - 待排区筛选：关键字（单号/产品/客户/刻字）+ 按交期升序（池空显示「无匹配/池空了」）
  - TaskModal「查看完整订单」：fetch /orders/:id → 打开共享 OrderDetailModal（单头+全部行）
  - 组件抽取：订单详情弹窗上移为 `components/OrderDetailModal.tsx`（OrdersPage 列表「详情」与 SchedulingPage 共用），消除两处重复实现
  - 验收：research/i11-board-day.png（92px/格）、i11-board-week.png（44px/格 周分隔）
  - DOM 断言（research/i11-dom-check.cjs）：day 92/week 44 格宽切换、周一 MM-DD 标注、筛选框存在、任务条→任务简介→「查看完整订单」→订单详情 全链路无 console 错误；OrdersPage「详情」回归通过（SO-20260905-04）
- **v3 工序推进联动**（I06 修订，2026-09-06）：排期池条件 confirmed → confirmed+production（生产中的行保留在看板逐道推进，不因首报退池）；任务返回 routeSeq/routeTotal/stepIdx/currentStepName；甘特块标注 [当前工序 x/y]、黄=已推进（routeSeq>1 或部分成品）、随报工自动换道顺延；待排区可含生产中任务；排期面板提示当前工序与"建议排入当前工序泳道"
- **v4 拖拽手感 + 入口 Provider 修复**（用户反馈"拖动手感很差"，2026-09-06）：
  - **选中浮起**（pointerdown）：原块 opacity 0.35 留位 + 浮层出现（scale 1.05 + 大阴影 + cursor grabbing + zIndex 20 + pointerEvents:none 穿透）；记录像素级 grabOffPx 供平滑跟手；拖动 effect 依赖 axis/scale 用 onMoveBarRef 闭包拿最新回调（无 stale 风险）
  - **拖动跟手**（window pointermove，ref 直改 DOM 零 React 重渲染）：浮层 left 平滑像素级跟随指针、落点日期提示条浮在块上方、泳道落点指示竖线（display:block，mousedown 时显示）
  - **松手落定**（window pointerup + pointercancel）：未移→原位放下（不调接口）；已移→浮层吸附目标日 phase:'settle' + suppressClick 抑制 600ms 内 click（防误弹详情）+ 调 onMoveBar → 列表刷新后原块已渲染在新位置（无跳变感）
  - **入口 Provider 修复**（隐藏多年的 bug）：main.tsx 包 `<AntApp>` Provider。**此前 useApp 拿到残缺 message → 排程保存成功/失败提示一直在 console 抛 `a.error is not a function`**（自首版 I11 上线起所有 message 调用都没真正显示过，但用户没察觉因为没听过成功提示声）
  - **点块详情修复**（隐藏 bug 顺手）：拿起的原块**不再设 pointerEvents:none**——puppeteer/物理 click hit-test 在 preventDefault 后若原块 none 会穿透到泳道容器，click target 错位使点块弹不出详情（回归 STEP5 抓到）；拖动误弹由 suppressClick 抑制，块仍需 pointer-events:auto
  - **moveBar 错误透传**：加 `res.ok` 检查 → 失败 throw Error(message) → catch message.error 真正显示（修好 Provider 后才能正常报错）
  - **验收**：research/repro-i11-drag-feel.cjs 5 步全绿（拿起浮起 / 拖动跟手+落点线+目标日 / 松手落位+不误弹 / 拖回原位 / 轻点弹详情）+ research/shots-i11-drag/{s1-lift,s2-restored,s3-click-detail}.png

## Ref

- spec.md §5
- 原型 index.html（排程看板）
- research/10-gantt-selection.md（自研决策）
