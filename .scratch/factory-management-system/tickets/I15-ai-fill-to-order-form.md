# I15 · AI 识别结果填入新建订单 + 未建档快速建档

Type: task
Status: resolved
Phase: 后续增强（AI 导入链路体验改造，用户直接需求）
Blocked by: 无
Spec: spec.md §8（AI 一期：AI 导入 + 学习闭环）

## 背景（用户三条连续需求 → 一条链路改造）

原链路：AI 复核弹窗内强制客户/产品命中档案（未命中即 error 阻断）→ 「确认建单」直接 POST /orders。
用户反馈：
1. AI 识别结果·订单草稿应按识别结果填入，**不做限制**（未命中档案的新客户/新型号不应被拦）；
2. 复核确认后**自动填入新建订单页**（建单动作收敛到订单表单，由人工最终确认）；
3. 新建订单页做检测：客户/产品不在档案时，提供**快速客户建档 / 加入产品目录**入口。

## 方案与实现（commit 3338882）

### AiOrderImport（复核弹窗 → 纯填入）
- 移除 confirmCreate 直接 POST /orders；新增 `onReviewDone(payload)` 回调把草稿交还订单页，DB 单槽草稿随即清除
- 客户未命中档案：识别文本保留可改名，可「从档案选择」；不再强制选档案
- 产品行未命中目录：识别名文本保留可改名 / 可「改从目录选择」；不再 error 阻断
- 确认按钮文案「按识别结果填入新建订单」

### OrdersPage OrderCreateCard（承接 + 检测 + 建档）
- `fillFromAI(payload)`：setFieldsValue 预填客户/PO/交期/备注/产品行
- 顶部待处理卡：未建档客户（一键快速客户建档：name+结算方式 → POST /customers）与未建档产品（一键加入产品目录：name+制式类型 → POST /products），建档成功自动 `setFieldValue` 回填选中、刷新下拉、卡片项消失
- 产品行未建档态可视化：Select 红框 + placeholder「⚠ 识别名（未建档）」+ 必填文案动态指向建档
- `handleSave` 检测：仍有未建档/未选产品行或未建档客户 → message 拦截列出名称
- 保存成功：上报 ai/feedback（真实最终稿）+ 清除 AI 单槽草稿 + reset

### 关键技术决策
未建档产品识别文本**不进 Form store**：rc-field-form 的 `setFieldsValue` 对无对应 Form.Item 的字段（数组路径下）会丢弃（实测 l0.productName 未写入）。
→ 改用组件 state `importTexts: Record<行name, 文本>` 承载；删除行经 `deleteLine` 包装同步平移 name；建档/改选后清除对应项。

## Acceptance

- [x] AI 复核弹窗：客户/产品未命中档案不再 error 阻断，可按识别文本保留（可改名、可从档案/目录改选）
- [x] 点「按识别结果填入新建订单」→ 下方新建订单表单自动预填（客户命中即选中、PO/交期/备注/各行数量/单价/币种/刻字/包装）；DB 草稿单槽清除
- [x] 新建订单页顶部待处理卡列出未建档客户/产品；点「快速客户建档」建档后自动选用；点「加入产品目录」建档后对应行自动回填 productId、红框/⚠ 消失
- [x] 保存前检测：未建档项未处理 → 拦截提示并列出名称；处理后正常保存
- [x] 建档数据真实落库（POST /customers、/products），订单保存成功（POST /orders）并触发学习反馈上报
- [x] 回归：repro-i15-fill-build.cjs 8 步全过 + 0 console error；清理按 订单→客户→产品 顺序（FK）无残留

## Ref

- apps/web/src/components/AiOrderImport.tsx（确认→填入）
- apps/web/src/pages/OrdersPage.tsx（fillFromAI / 待处理卡 / 建档 Modal / handleSave 检测）
- 相关旧资产：research/repro-i14-draft.cjs 已标注 deprecated（原「确认建单」按钮被「填入新建订单」取代）

## 备注

- 后端无改动（/orders、/customers、/products、/ai/feedback、/ai/orders/draft 均既有）
- 仅前端两个文件 + 回归脚本；nginx 镜像重建部署
- I14「草稿恢复横幅」语义随动：确认填入（=草稿消费完成）即清除单槽
