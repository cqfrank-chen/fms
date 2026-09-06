# I13 · 产品工序路线配置（product_processes 写入口，决定排期工期）

Type: task
Status: open → resolved
Phase: 后续增强（落库审计补票，13 张实施票之外）
Blocked by: 无（需主数据产品/工序字典已就位——已满足）
Spec: spec.md §6.3（工序产能池）；research/04-process-data.md（工序模板种子）

## 背景（为什么补这张票）

落库全量审计发现：`product_processes`（产品×工序：seq 顺序 / unitSeconds 单件耗时 / changeoverMinutes 换型）**表已建、排期已在只读消费，但全后端没有任何写端点**——没有 controller/service 提供录入，前端 SchedulingPage 只能显示「未配置」。即「决定排期工期的工序耗时」目前**无法录入**，属尚未落地的功能。

现状锚点：
- 表定义：`apps/api/src/db/schema.ts` `productProcesses`（唯一索引 product_id+process_id，删产品级联）
- 只读消费方：`apps/api/src/scheduling/scheduling.service.ts`
  - `unitMap`（listTasks 预拉，L71-78）——按 `productId:wcKey` 取首条 seq 的 unitSeconds
  - `unitSecondsFor`（L194-201）
  - `computeAutoDays`（L203-209）——unitSeconds 为 null/≤0 时占位返回 1 天
- 前端只读展示：`apps/web/src/pages/SchedulingPage.tsx` L351「单价耗时（unitSeconds）：{… ?? '未配置'}」
- 工序字典 13 道种子 + 产品×工序序列模板：research/04-process-data.md

## Scope

- **后端**：产品工序路线整表替换或行级 upsert 的写端点（事务），GET 读端点
  - 校验：同产品不允许重复工序；seq 从 1 起连续；unitSeconds 可空（空=未填走占位）、填则 >0；changeoverMinutes ≥0 默认 0
  - 整表替换语义（前端一次保存整条路线）最贴合「主数据配置」使用方式，删除遗漏工序随保存自动移除
- **前端**：设置页（SetupPage 主数据区）新增「工序路线」配置入口——按产品打开路线编辑器：13 道工序字典勾选/排序（上移下移），逐行填单件耗时（秒）+ 换型（分钟）；未配置产品提供「套用 research/04 字典模板」一键预填兜底
- **排期联动验证**：配置耗时后，新建计划单行 → 甘特/看板工期按 `qty × unitSeconds / machines / SHIFT_MIN` 推算生效
- **口径确认（实施时一次）**：`unitMap`/`unitSecondsFor` 按 `productId + wcKey` 取**首条 seq** 的口径，若同泳道出现多道工序（如 drill_c + drill_p 归属不同 wcKey 则无碍）需核对是否应改为按泳道**累加**；以 04 模板 + 05 泳道定义为准，必要时单列说明

## Acceptance

- [ ] 后端写端点落库成功：配置 N 道工序 → product_processes 行数正确；重复工序被拒；未勾选工序从该产品移除
- [ ] 前端编辑器可用：产品选择 → 勾选/排序/填耗时 → 保存后重开可见；未配置产品一键套模板可用
- [ ] 排期生效：为演示产品配置完整路线 → 该产品计划单行不再显示「未配置」，工期按耗时推算；无耗时的产品/工序仍 1 天占位不回归
- [ ] 删除产品 → 其路线级联清除（已由 schema onDelete cascade 保证，回归确认）
- [ ] 数据回归：既有计划单、已排期行、订单/账目数据不受影响（本票只增写路径，不改动现有读逻辑语义）

## Ref

- research/04-process-data.md（工序字典 13 道种子 + 产品×工序序列模板）
- spec.md §6.3；scheduling.service.ts 工期推算现状
- 落库审计结论：product_processes 无写端点是当前唯一「表存在但无法录入」的主数据缺口

## 备注

不属于原 13 票/四阶段验收范围，为审计后新增工作项；开工前无需重走 wayfinder（域模型已在票 04/05 敲定），按「主数据写路径 + 排期联动」直出小票实施。
