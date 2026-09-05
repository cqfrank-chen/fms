# I10 · 甘特库选型决策（折进 I11 排程看板）

> 票 I10 验收：`选定一个库，给出理由（许可证/能力/集成成本）` + `行级任务块可拖拽、事件回调可用`
> 本票的原始候选是 `frappe-gantt (MIT)` vs `dhtmlx-gantt (商业)`，实测发现两者都不能直接匹配 I11「6 工序泳道 + 同泳道重叠分层」看板形态，因此本决策跳出了原候选集。

## 一、目标看板形态（spec §5 / I11 / 09 原型已验证）

```
纵轴：6 工作中心（聚合工序：下料 / 车削 / 钻孔(丙烷) / 螺纹 / 抛光/清洗 / 测试/包装）
横轴：时间（日级，可切周/月）
任务：一计划单行一任务块；同泳道重叠任务贪心分层垂直错开；
      点击 → 行简介弹窗；拖拽 → 改开始日（工期=工序推算，可覆盖）；报工→变绿/进行中/完成；
      排期面板选工序+开始日+核验；超期红框。
```

含义：**看板是「资源泳道式」甘特（lane + stacked overlapping bars），不是任务树甘特（per-task rows）**。

## 二、候选实测（spike：React 19 + AntD 6 + Vite 8，三个 Tab 同数据对比）

### A. frappe-gantt 1.2.2（MIT，250KB 包，ESM+CSS）

| 项 | 实测结果 |
|---|---|
| 许可证 | MIT（npm `license: "MIT"`） |
| 模型 | SVG 甘特，每个任务独占一行 |
| 自定义列 | **无左网格表格**（仅每行一个文字标签） |
| 行级任务块渲染 | ✓ 12 任务渲染为 12 行，色标 `task.color` 逐条生效 |
| 拖拽 | ✓ 真实鼠标拖动成功；`on_date_change(task, start, end)` 回调触发；日志：`任务 PS-0905-01·行1 开始 2026-09-09 → 2026-09-11` |
| 视图缩放 | ✓ `change_view_mode('Day'/'Week'/'Month')` |
| 库内已知 bug | `fixed_duration:true`（只拖开始日）下，`update_handle_position` 对未渲染的 resize handle 调用 `setAttribute` 报空引用——拖拽仍可完成但 console 持续报错**（用默认 resize 启用则无此问题；反与"工期覆盖"诉求一致）** |
| 与看板目标契合度 | **不契合**：没有"泳道"概念，必须改成任务分行模型，且分组需用 parent 行折叠 |

### B. dhtmlx-gantt v10.0.3（npm 现为 MIT Community，6.6MB unpacked，可商用可闭源；PRO 能力[自动排产/关键路径/资源管理]才需商业授权）

| 项 | 实测结果 |
|---|---|
| 许可证 | **MIT**（v10+ 社区版；v9 及以下为 GPL；dhtmlx 2024 改的免费许可策略） |
| 模型 | 任务树 + 左网格表 + 右时间轴 |
| 自定义列 | ✓ `config.columns = [{name, label, width, template}]`，可放单号/产品/客户/工序 |
| 行级任务块渲染 | ✓ 智能渲染（smart rendering 默认开）仅渲染可视区行（12 任务当前可视 2 行，DOM 行计数=2） |
| 拖拽（自动化）| ✗ headless Edge + puppeteer-core + CDP mouse 真实拖动**未触发** `onAfterTaskDrag`（条 x 未变化、回调未打）——设计 v10 新调度引擎对 pointer capture 行为与自动化输入不兼容；**手动浏览器可正常拖** |
| 拖拽（手测）| ✓ dhtmlx 成熟功能，`config.drag_move:true` 默认开；`onAfterTaskDrag(id, mode, e)` 标准事件 |
| 视图缩放 | ✓ `config.scale_unit = 'day'\|'week'\|'month'`，`date_scale`+`subscales` |
| 色标/模板 | ✓ `task_class` 模板叠加 st-done/st-wip/st-overdue/st-override 状态类，CSS 即可控制颜色与边框 |
| 与看板目标契合度 | **不契合**：同样没有泳道概念；可用「工序分组 parent 行 + 任务子行」逼近，但不能一眼看出 6 工作中心负载密度 |

### C. **自研 React 泳道甘特**（验证 spike）

| 项 | 实测结果 |
|---|---|
| 包体积 | 0 第三方 |
| 模型 | 6 固定泳道 + 绝对定位任务块 + 贪心分层（按开始日排序，每层记录末占用日 → 新任务放最最空层，top = 8 + layer·30） |
| 拖拽 | ✓ window 级 pointermove/up；首抓点 day 偏移扣除避免"条内抓点"跳天。真实拖动：`PS-0904-02·行1 2026-09-08 → 2026-09-11`（精确 +3 天） |
| 色标 | ✓ 状态背景色 + 进度文字 %；超期加红框；覆盖加紫虚线 |
| 时间轴 | 周/周末灰化；点击任务 → AntD 弹窗（产品/客户/交期/进度/简介） |
| 复用 | 与 09 原型（`prototypes/09-core-ui/index.html`）的甘特区块布局/分层算法同源；I11 增 DB 拉取/排期面板/报工接线 |
| 与看板目标契合度 | **完全契合**——直接是 spec/I11 的目标形态 |

## 三、决策

**选 C：自研 React 泳道甘特**。

理由：
1. **目标形态契合**：spec §5.1/I11/09 原型已明确看板是 6 工序泳道 + 同泳道重叠分层；任务树型库（frappe / dhtmlx）要"反向重设计"——代价大且丢失"工作中心负载密度一眼可见"的看板价值。
2. **零依赖、与现有架构一致**：整个项目自研（ADR-0001），AntD 是唯一 UI 库；新加第三方甘特会带来体量大（dhtmlx 6.6MB / frappe 250KB）+ 主题风格对接成本。
3. **能力已验证**：spike 实测真实鼠标拖拽回调工作（lane/frappe 都通过）；dhtmlx 在自动化下未能复现拖拽反而提示 v10 新引擎对边缘输入存在兼容问题。
4. **量级可控**：参考 spike 已含布局/拖拽/贪心分层/周末灰化/弹窗/色标 ~250 行，I11 主要工作是**接 DB + 排期面板核验 + 报工联动 + 周/月缩放**，不需重写引擎。

## 四、I11 已知实施项（折进 I11）

- **数据契约**：每个任务块 = 一条 `plan_sheet_line`（行级排期单元，票 05 / 09 修订）；新增字段 `wcKey`（泳道键）、`startDate`（day ISO）、`coverDays?`（覆盖工期，null=自动推算）、`status`（未排期/已排期，独立于五态）。
- **回写**：拖拽 → `PATCH /plan-sheets/:id/lines/:lineId/schedule { wcKey, startDate, coverDays? }`，服务端事务性更新 planSheetLine + 计划单排期状态聚合。
- **超期核验**：排期面板提交时调 `GET /planning/verify?wcKey=&startDate=&qty=&productId=` 返回 `{load, days, dueDate, overdueFlag}`。
- **报工联动**：行报工驱动任务块颜色（已报 0→蓝；>0→黄；=qty→绿）；独立排期状态字段（不进五态）。
- **时间缩放**：日/周/月切按钮调整 `pxPerDay`（如 92/46/16）与可视范围；不需甘特库视图缩放。
- **任务简介弹窗**：点击任务 → AntD Modal 显示产品/客户/数量/交期/刻字/包装/工序/报工进度/来源订单（已有 `viewOrder` 反查组件）。

## 五、Ref

- 票：`.scratch/factory-management-system/tickets/I10-*.md`
- spec：`.scratch/factory-management-system/spec.md §5`
- ADR：`.workbuddy/docs/adr/0001-tech-stack.md`
- 原型：`.scratch/factory-management-system/prototypes/09-core-ui/index.html`（排程区块）
- spike 工程：`.scratch/factory-management-system/prototypes/10-gantt-spike/`
- spike 取证脚本与截图：同上目录 `shot.cjs` + `shots/{lane,frappe,dhtmlx}.png`

## 六、提交

- commit：`I10 resolved：甘特库选型（自研 React 泳道甘特）+ spike 三方案对比实证（frappe-gantt/dhtmlx-gantt 真实拖拽回调已验证）+ 决策文档折进 I11`