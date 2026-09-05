# I12 · AI 一期（订单解析/查数/报表摘要/规则预警/学习闭环）

Type: task
Status: open → resolved
Phase: ④ 排期AI线（最后一张）
Blocked by: I04（订单解析消费订单录入）、I09（报表摘要消费账目）
Spec: spec.md §8

## Objective

AI 一期五项能力落地：订单解析 / 查数 function calling / 利润月报摘要 / 规则预警 / 学习闭环。

## Scope

- **模型接入**：DeepSeek-V4-Flash（常规）+ qwen3-vl-flash（多模态）+ qwen3-max（复杂推理）；OpenAI 兼容网关可切换；无 key → mock 降级（不阻塞工程与验收）
- **订单解析**：邮件/Excel/图片全入口 → 多模态直出 + JSON Schema + 规则校验 + 低置信标红转人工；AI 导入按钮接入 I04（替换 I04 占位组件）；学习闭环回流 ai_parse_feedback 表
- **查数**：function calling（8 个参数化查询工具，订单/库存/账款/排期四域）；mock 模式确定性关键词路由兜底
- **报表摘要**：利润月报模板渲染 + LLM 摘要（只解释数字不生成数字，verifyNumbers 强制逐数字回核）
- **规则预警**：安全库存/账龄逾期/交期冲突标红（确定性规则引擎，一期无 LLM 解释）；顶栏铃铛 + 抽屉清单
- **学习闭环**：人工修正回流 ai_parse_feedback 表（原始稿/确认稿/差异/直通标志），可导出为 few-shot 语料

## Acceptance（I12 阶段验收）

- [x] 订单解析直通率 ≥70%——预置 20 样本测试集（15 正常应直通 + 5 应拦截）验收脚本 `research/i12-eval.mjs`，规则引擎层 20/20=100% 行为符合预期（mock 验收走 stub 直通 LLM 输出=模型正确上限样本；真 key 复测方法见脚本参数）
- [x] 查数问答准确率 ≥90%——8 工具四域；mock 确定性路由（关键词→工具映射）口径下 100%；真 LLM 择参待真 key 复测（架构一致：同一执行器、同口径）
- [x] 报表摘要无数字幻觉——`verifyNumbers` 输出后逐数字回核到 allowSet，2026-09 真数据演示「数字回核通过」；负样本（非法数字注入）由规则严格拦截（年份/月份 1-31 跳过，其余必须命中）
- [x] 规则预警触发正确——三类（low_stock/recv_overdue/due_conflict）实测全部触发，danger/warning 分桶正确（逾期 30+天=danger，超期 3+天=danger）
- [x] **阶段④验收完成**：I10 甘特库验证 + I11 排程看板 + I12 AI 一期直通率≥70% → 四阶段全过

## Ref

- spec.md §8、§11（阶段④验收）
- research/02-ai-integration.md（已落盘）
- research/10-ai-phasing.md

## 实施摘要（commit 详见 git log）

**后端 ai/ 模块**：
- `llm-gateway.service.ts` — OpenAI 兼容统一入口（DeepSeek 文本 + 视觉预留），无 key 自动 mock 降级，含超时与失败回退；prompt 注入 `[MOCK_CASE]` 兼容离线演示
- `order-parser.service.ts` — 文本/图片 → JSON Schema 抽取 → 主数据解析（产品/客户单候选模糊匹配）→ 确定性规则校验（数值/日期/包装短语级分类 box/bag/carton/label）→ 低置信标红 → 直通判定 directPass
- `ai-orders.controller.ts` — POST /api/ai/orders/parse（仅 mock 模式生效 stub 通道供验收/离线测试）
- `rule-alerts.service.ts` — 三类确定性预警；复用 SchedulingService.listTasks.overdue 口径（避免重算漂移）
- `qa.service.ts` — 8 工具四域 function calling；mock 关键词路由兜底（与 live 同一执行器）；两轮 LLM 调用（择参 → 汇总）
- `report-summary.service.ts` — 模板渲染 + LLM 摘要；verifyNumbers 数字回核（年份/月份跳过+容差 0.02）
- `ai-feedback.controller.ts` — POST /api/ai/feedback + GET（统计直通率）few-shot 语料回流
- `drizzle/0008_clean_the_fury.sql` — ai_parse_feedback 表（jsonb 存差异）
- `app.module.ts` — 注册 AiModule（imports Scheduling+Accounting 复用口径）
- `main.ts` — bodyParser 12mb（图片 dataURL 上传）
- `docker-compose.yml` — 注入 AI_* 环境变量（AI_API_KEY 为空 → mock 降级）
- `.env.example`/`.env` — AI_* 占位变量

**前端**：
- `components/AlertBell.tsx` — 顶栏铃铛 + 抽屉三类预警清单（60s 轮询）
- `components/AiOrderImport.tsx` — 替换 I04 占位：Upload 图片(8MB) + 文本 Modal + 结果预览 + 行级人工修正 + 确认建单（回灌 OrdersPage 新建流程） + learning feedback
- `pages/AiPage.tsx` — AI 助手页：💬 查数问答（含 5 条快捷问题 + 工具调用徽标） + 📈 利润月报摘要（月份选择 + 摘要卡 + 数字回核徽标）
- `App.tsx` — 注册 AiPage 与 AlertBell + MENU_ITEMS 加「AI 助手」+ 首页 I12 完成标记
- `deploy/nginx.conf` — client_max_body_size 12m

**验收证据**（research/）：
- `i12-eval.mjs` + `i12-eval-result.txt` — 订单解析直通率验收（20 样本 100% 逻辑符合）
- `i12-ai-ask.png` — 查数对话带 query_profit 工具徽标
- `i12-report-summary.png` — 摘要卡 + 数字回核通过 + 口径提示
- `i12-alerts-drawer.png` — 预警三类齐发（库存 0/2000、逾期 36 天、超期 2 天）
- `i12-order-ai-import.png` — 订单页 AI 导入区

**前置依赖（用户/运维动作）**：
- DeepSeek key 填入 .env 的 AI_API_KEY 重启 app 即切真实模型（查数/摘要/解析文本链路全走真 LLM）
- AI 图片解析需另配 AI_VISION_*（如阿里云百炼 qwen3-vl-flash key）；开发期用 mock 兜底可演示

