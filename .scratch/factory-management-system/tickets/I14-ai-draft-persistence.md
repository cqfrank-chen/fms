# I14 · AI 导入解析草稿自动保存与恢复

Type: task
Status: open → resolved
Phase: 后续增强（落库审计补票，13 张实施票之外）
Blocked by: 无
Spec: spec.md §8（AI 一期：学习闭环/AI 导入）

## 背景（为什么补这张票）

落库全量审计发现风险点：AI 导入（图片/文本 → 解析 → 行级人工修正 → 确认建单）的**解析草稿只存在前端 React state**，用户修正一半时刷新页面、误关弹窗、或换台电脑继续，草稿即丢——人工修正劳动可能白费。

现状锚点：
- `apps/web/src/components/AiOrderImport.tsx`：`result`/`draft` 全为 useState（L54-56）；修正弹窗 `open={!!result && !!draft}`（L192）；`confirmCreate()`（L122）POST 建单成功后无草稿残留清理语义
- 无任何草稿持久化（前端零 localStorage/sessionStorage 是全系统现状，本票为 AI 解析草稿单点补保护）
- 项目既有「设置落库」先例：AI 配置经 `app_settings` 表落库（I12b），草稿保护沿用同思路

## Scope

- **存储层（推荐 DB 单槽草稿，沿用 app_settings 落库先例）**：新建 `ai_parse_drafts` 表（单厂单操作人场景取单槽：一行即当前草稿），字段覆盖 AI 解析草稿全量：customerId / poNo / dueDate / note / lines（产品映射+数量+单价+币种+刻字+包装，jsonb 或列化） / createdAt / updatedAt
  - 方案对比已过滤：localStorage 更省事但与系统「一切落库」原则不一致，且清浏览器缓存/换机即丢，不采用
- **自动保存**：解析成功即存；此后每次人工修正（防抖 ~1s）与弹窗关闭时同步；保存失败不阻塞编辑但 toast 提示
- **恢复**：进入 AI 导入 → 检测到未提交草稿 → 明示「恢复上次草稿」（含时间戳）一键载入；也可选择继续新解析（覆盖旧草稿需二次确认）
- **生命周期闭环**：确认建单成功 → 清除草稿（事务：建单成功才清）；「放弃草稿」按钮显式清除；避免幽灵草稿反复打扰
- **边界**：草稿仅 AI 导入区可见，不参与任何业务统计/账目/库存/排期；learning feedback（ai_parse_feedback）逻辑不变

## Acceptance

- [ ] 解析 → 人工修正若干字段 → **刷新页面** → AI 导入提示「恢复上次草稿」→ 一键载入，客户/PO/交期/备注/各行修正全部还原
- [ ] 修正后**关闭弹窗再重开**（未建单）→ 草稿仍在，可继续
- [ ] 确认建单成功 → 再次进入不再提示旧草稿（已清除）
- [ ] 「放弃草稿」显式清除生效
- [ ] 新解析覆盖旧草稿需二次确认，不误吞修正中内容
- [ ] 草稿表不影响账目/库存/排期任何统计（回归：报表数字与草稿存在与否无关）

## Ref

- spec.md §8（AI 导入 + 学习闭环）；apps/web/src/components/AiOrderImport.tsx 现状
- I12b 先例：app_settings 落库（AI 配置设置页可改，重启/跨机不丢）
- 落库审计结论：AI 解析草稿「刷新即丢、无自动保护」是审计点 2

## 备注

不属于原 13 票/四阶段验收范围，为审计后新增工作项；实施时可复用 I12b 的 app_settings 读写模式（Drizzle + 单表 service），独立小票即可完成。
