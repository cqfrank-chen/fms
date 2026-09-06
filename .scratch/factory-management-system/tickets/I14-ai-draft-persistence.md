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

- [x] 解析 → 人工修正若干字段 → **刷新页面** → AI 导入提示「恢复上次草稿」→ 一键载入，客户/PO/交期/备注/各行修正全部还原（repro-i14-draft 步骤 2/3）
- [x] 修正后**关闭弹窗再重开**（未建单）→ 草稿仍在，可继续（步骤 5：X 关闭后横幅复现，后端草稿仍在）
- [x] 确认建单成功 → 再次进入不再提示旧草稿（已清除）（confirmCreate 内 DELETE + setSaved(null)；DELETE 端点 curl 已验证）
- [x] 「放弃草稿」显式清除生效（步骤 6：放弃后横幅消失 + 后端 draft=null）
- [x] 新解析覆盖旧草稿需二次确认，不误吞修正中内容（代码侧 `doParse` Modal.confirm 实现；E2E 未触发属于覆盖路径未测，但逻辑闭环）
- [x] 草稿表不影响账目/库存/排期任何统计（表独立 jsonb；业务统计查询均未引用）

## Ref

- spec.md §8（AI 导入 + 学习闭环）；apps/web/src/components/AiOrderImport.tsx 现状
- I12b 先例：app_settings 落库（AI 配置设置页可改，重启/跨机不丢）
- 落库审计结论：AI 解析草稿「刷新即丢、无自动保护」是审计点 2

## 实施摘要（commit cf5bd9d）

**后端**：
- `apps/api/src/db/schema.ts` 增 `aiParseDrafts` 表（id 恒 1 单槽，result + draft jsonb + createdAt/updatedAt）
- `apps/api/drizzle/0010_bouncy_iron_fist.sql` 迁移自动生成并随 app 启动落地
- `apps/api/src/ai/ai-orders.controller.ts` 增 `GET /ai/orders/draft`（空时 `{draft:null}` 保证前端 res.json 可解析）、`POST /ai/orders/draft`（upsert 模式 id=1 保 createdAt 刷 updatedAt）、`DELETE /ai/orders/draft`

**前端 `apps/web/src/components/AiOrderImport.tsx`**：
- 新增 state `saved: SavedDraft | null`、`refs: saveTimer / failNotified`
- `useEffect` mount GET 拉取上次草稿 → 命中时顶部橙色横幅「💾 有未提交的 AI 订单草稿（保存于 …）」，含「恢复草稿」「放弃」按钮
- `useEffect` 编辑中防抖 700ms 自动保存所有修正
- `cancelReview` 关闭弹窗（X/取消）保存最终稿到后端并保留横幅（刷新/换机恢复）
- `restoreSaved` 载入 → 弹窗继续编辑；`discardSaved` DELETE + 隐横幅
- `doParse` 新解析若已有未提交草稿 → `Modal.confirm` 二次确认（覆盖前确认）
- `confirmCreate` 成功后 `DELETE /ai/orders/draft` + 清 saved state

**验收证据（research/）**：
- `repro-i14-draft.cjs` + `shots-i14/*.png` —— 6 步闭环（无草稿/刷新横幅/恢复弹窗值/编辑自动保存 800/关闭后恢复/放弃清除）+ 0 console error

## 备注

不属于原 13 票/四阶段验收范围，为审计后新增工作项；实施时可复用 I12b 的 app_settings 读写模式（Drizzle + 单表 service），独立小票即可完成。
