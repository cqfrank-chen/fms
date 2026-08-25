# AI 接入方案调研报告（订单解析 / 自然语言查数 / 排产建议 / 异常预警 / 报表生成）

> 票据：`issues/02-ai-integration-research.md` · 调研日期：2026-08-26
> 数据来源：各模型官方定价页（2026 年 8 月快照）+ arXiv 论文 + 行业实测报告。价格为刊例价，随官方调整变动，落地前需复核。
> 金额单位：如无说明，"元"指人民币，按每百万 tokens 计。

---

## 0. 结论速览

| 能力 | 推荐路径 | 一句话理由 | 预估月成本（单厂规模） |
|---|---|---|---|
| 订单解析（邮件/Excel/图片） | 多模态 LLM 直出 + JSON Schema 结构化输出 + 规则校验 + 低置信度转人工 | 图片场景 VLM 准确率显著高于 OCR 流水线（新版式 93% vs 61%，歪斜扫描 88% vs 44%）；邮件/Excel 本就是文本，无需 OCR | 数元级 |
| 自然语言查数 | 一期：后端 API function calling；二期：受控 Text-to-SQL（只读账号 + AST 校验 + 表白名单 + 语义层） | function calling 安全可控但表达力有限；Text-to-SQL 灵活但企业真实 schema 上准确率暴跌（Spider 2.0 仅 21-39%），必须加护栏分期上 | 数十元级 |
| 排产建议 | 确定性 APS 数据底座 + 规则/约束引擎做决策，LLM 只做方案解释、what-if 对比叙述、建议生成 | LLM 推理延迟（秒级）与排产决策实时性冲突是学界共识；等级二（人工拖排）下 LLM 定位是"参谋"不是"调度器" | 数十元级 |
| 异常预警 | 规则引擎/阈值检测触发（确定性），LLM 生成解释与处置建议 | "LLM 不应替代专用异常检测算法，价值在解释与上下文关联"（PSE 综述结论） | 数十元级 |
| 报表生成 | 模板化渲染（数字全部来自 SQL 结果）+ LLM 摘要（只解释数字、不生成数字） | "LLM 不生成数字，只解释数字"是报表自动化的第一架构决策 | 数元级 |
| 模型接入 | 国内 API 起步 + OpenAI 兼容抽象层可切换；暂不私有化 | 单厂用量远低于自建盈亏平衡点（月 5-10M tokens）；2026 年行业普涨，需保持供应商可切换 | 50-300 元/月合计 |

---

## 1. 模型选型：2026 年国内现状

### 1.1 主流模型价格与能力（官方定价页快照）

| 模型 | 上下文 | 输入价（元/M，缓存未命中） | 输出价（元/M） | 多模态 | 结构化输出/工具调用 |
|---|---|---|---|---|---|
| DeepSeek-V4-Flash | 1M | 1.5（闲时）/ 3.0（高峰） | 4.5 / 9.0 | 否 | 均支持（JSON Output、Tool Calls、Responses API、Anthropic API） |
| DeepSeek-V4-Pro | 1M | 4.5 / 9.0 | 13.5 / 27.0 | 否 | 同上 |
| qwen-plus | 128K | 0.8 | 4.8 | 否 | 支持 |
| qwen3-max（2026-01-23） | 256K | 2.5（≤32K 段） | 10 | 否 | 支持（含 Function Calling） |
| qwen3.7-max（2026-05-20） | 1M | 12 | 36 | 否 | 支持 |
| qwen3-vl-flash | 256K | ≈0.35（国际价 $0.05） | ≈2.8（国际价 $0.4） | 图片/视频 | 支持 |
| qwen3-vl-plus | 256K | ≈1.4（国际价 $0.2，≤32K 段） | ≈11（国际价 $1.6） | 图片/视频 | 支持 |
| GLM-5.3（智谱新旗舰） | 1M | 8 | 28 | 文本旗舰 | 支持 |
| GLM-5 | 200K | 4（≤32K）/ 6（≥32K） | 18 / 22 | 否 | 支持 |
| GLM-4.7-Flash | 200K | **免费** | **免费** | 否 | 支持 |
| Kimi K3（月之暗面旗舰） | 1M | 20（缓存命中 2） | 100 | 原生视觉（图片/视频输入） | 支持（JSON 模式、工具调用） |
| 豆包 doubao-seed-2.1-pro | 256K | 6 | 30 | 文本+图片+视频输入 | 支持（Function Call、结构化输出） |
| 豆包 doubao-seed-2.0-lite | 256K | 0.6（≤32K 段） | 3.6 | 音频+图片 | 支持 |

来源：
- DeepSeek：官方 API 文档定价页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing （2026-08 起峰谷计费，周末全时段按低谷价）
- Qwen：阿里云百炼模型计费 https://help.aliyun.com/zh/model-studio/model-qwen3-max 、https://www.alibabacloud.com/help/zh/model-studio/billing/ ；qwen3-vl 系列价格见国际区刊例（Batch 调用半价、上下文缓存另有折扣）
- GLM：智谱开放平台定价页 https://open.bigmodel.cn/pricing
- Kimi：官方定价说明 https://www.kimi.com/zh-cn/resources/kimi-k3-pricing
- 豆包：火山引擎模型价格文档 https://www.volcengine.com/docs/82379/1544106

### 1.2 必须知道的行业趋势：2026 年集体涨价

- 2026 年国产大模型普遍提价。DeepSeek V4-Pro 高峰输出价从 6 元涨至 27 元（+350%，缓存命中输入涨 1100%）；智谱年内三轮提价；Kimi K3 输入涨幅超 3 倍、输出近 4 倍（证券时报、新浪财经报道）。
- 摩根士丹利研报：2026Q2 中国大模型平均 API 输入价已达 4.9 元/M，输出 21.9 元/M，同比分别 +48% / +80%。
- **工程含义**：AI 分期方案必须把"模型供应商可切换"作为架构约束（统一走 OpenAI 兼容接口 + 网关层），并优先利用缓存命中（DeepSeek 缓存命中输入 0.05 元/M，是未命中的 1/30）与闲时/周末低价档（闲时半价）。

### 1.3 API vs 私有化部署

- **盈亏平衡点**：业界测算自建（含运维人力）在月 5-10M tokens 以下不划算；单厂管理系统的用量（估算见第 7 节）远低于此线，**结论：API 起步，不做私有化**。
- 私有化硬件参考（若未来合规要求变化）：7B 模型 FP16 约 16GB 显存（单张 RTX 4090 24GB 可跑）；32B 量化约 20-24GB（单张 48GB 或双 24GB 卡）；70B INT4 约 40GB（单张 A100 80GB）。生产推理框架首选 vLLM（高吞吐、连续批处理），开发验证用 Ollama。
- **Windows 开发环境注意**：vLLM 对 Windows 原生支持差，私有化生产环境须是 Linux 服务器或 WSL2——这是"暂不私有化"的又一理由（来源：元空间科技部署指南、vLLM/Ollama 生态综述）。
- 开源权重兜底选项：Qwen3-VL 全系（2B-235B，Apache 2.0）、GLM、DeepSeek、Kimi K3（权重已开放）均可在需要时转私有化，API 阶段的 prompt/工程资产可平移。

---

## 2. 订单解析：邮件/Excel/图片 → 结构化计划单草稿

### 2.1 证据：多模态 LLM 直出 vs OCR+LLM 流水线

2026 年 Document AI 实测（四类文档条件对比）：

| 文档条件 | 传统 OCR | VLM（多模态 LLM） | 胜者 |
|---|---|---|---|
| 干净结构化发票 | 94% | 95% | 持平（OCR 更便宜） |
| 全新供应商版式 | 61% | 93% | VLM（+32 分） |
| 旋转/歪斜扫描件 | 44% | 88% | VLM（+44 分） |
| 手写表单 | 38% | 84% | VLM（但专用手写 OCR 词错率 0.9% vs GPT-5 视觉 14.4%） |

其他实测：LLM 视觉抽取在原生平价 PDF 达 98-99%、高质量扫描 95-97%、手机拍照 85-92%；行项目明细（最复杂字段）88-92%。2026 年研究确认"对强 VLM，仅图片输入与 OCR+图片输入效果相当（F1 差 <1 分），OCR 文本有时反而引入传播误差"。
来源：genalphai.com Document AI 2026 对比、invoox.io 发票视觉抽取精度报告、app-lab.ai MLLM vs OCR 研究、parsli.co 2026 基准。

**结论**：
- **邮件**：邮件正文即文本，库解析（如 Python email parser）→ LLM 结构化抽取，无需 OCR。
- **Excel**：openpyxl/pandas 直读表格 → LLM 做表头语义映射与字段规范化（客户自制表头千奇百怪，正是 LLM 强项）。
- **图片（微信传单/拍照/PDF 扫描件）**：**多模态 LLM 直出**（qwen3-vl-flash/plus 或豆包 2.1，均原生支持图片输入 + JSON 结构化输出）。不建传统 OCR 流水线——工厂场景里"客户随手拍、歪斜、新格式"恰是 OCR 崩溃区（44%）而 VLM 稳定（88%）。
- 手写为主的场景（如有）预留专用 OCR（如 qwen-vl-ocr）交叉校验通道，不作为主路径。

### 2.2 兜底校验设计（关键工程，决定可用性）

生产级 IDP 的共识架构是"置信度路由 + 人工复核"，而非追求全自动：

1. **结构化输出约束**：用各 API 的 JSON Schema / 结构化输出能力强制字段、类型、枚举（DeepSeek/Qwen/GLM/Kimi/豆包均支持），从源头消灭格式幻觉。
2. **业务规则校验**（确定性代码，不经 LLM）：行项目数量×单价 加总 = 订单总额（容差内）；交期 ≥ 当前日期；物料编码/客户名在主数据中存在（不存在则自动创建草稿并标记）；数量为正；币种/单位合法。
3. **置信度路由**：对低置信度字段/单据生成"计划单草稿 + 红色标记字段"，进人工确认队列——计划单本来就是"草稿→人工确认"流程，与业务天然契合。
4. **双通道交叉校验（可选增强）**：对高价值订单图片，加一路轻量 OCR 做 VLM 结果交叉核对，两通道不一致的字段强制人工。
5. **查重**：对历史订单库做客户+品名+数量+交期组合查重，防重复录入。
6. **学习闭环**：人工修正结果回流为 few-shot 示例与校验规则，逐季提升直通率（业界基准：一个季度内直通率可达 70-90%）。

### 2.3 成本估算

按月 500 单、每单图片约 1.5K 视觉 tokens 输入 + 0.5K 输出计：月输入约 0.75M + 输出 0.25M。用 qwen3-vl-flash（约 0.35 元/M 输入、2.8 元/M 输出）≈ **1 元/月以内**；邮件/Excel 文本单用 DeepSeek-V4-Flash（闲时 1.5 元/M 输入）更便宜。订单解析的成本可忽略，真正成本在校验规则的开发与维护。

---

## 3. 自然语言查数：Text-to-SQL vs 后端 API function calling

### 3.1 Text-to-SQL 的真实水位（2026 基准）

| 基准 | 场景 | 最好成绩 | 说明 |
|---|---|---|---|
| Spider 1.0 | 学术干净 schema | ~85-90% | 近乎解决，无区分度 |
| BIRD | 脏数据+外部知识 | 75-82%（人类 92.96%） | 尚有差距 |
| Spider 2.0 / BIRD-Ent | 真实企业 schema（800+ 列） | 21-39% | "企业悬崖"：o1-preview 从 91.2% 跌到 21.3% |
| 加语义层后 | — | 57% → 78%（Snowflake 实测，+21 分） | 语义层消除约 60% 幻觉；MotherDuck 实测 58-64% 基准分对应 94-95% 实用准确率（语义层+复核） |

来源：aiworkflowlab.dev 生产指南、dreaming.press 基准分析、atlan.com 综述（含 Snowflake 语义模型实测）、upsolve.ai。

### 3.2 两条路径的本质权衡

- **function calling（后端 API 工具调用）**：LLM 只见工具菜单（如 `query_orders(customer, date_range, status)`），不见 schema；后端执行硬编码/参数化查询。优点：安全（无注入面、无越权、权限在后端强制）、结果确定、口径统一。缺点：表达力受工具集限制——实测显示复杂跨表+时间逻辑查询需要 15 层嵌套参数，模型开始幻觉（Towards AI 生产案例）。
- **Text-to-SQL**：表达力完整，但准确率依赖 schema 治理与护栏，且直接暴露库表给模型。
- **生产共识是混合路由**：意图分类器把"分析类"问题导向受控 Text-to-SQL，"操作类"导向预定义工具，写操作必须人工确认（MCP/工具层负责动作）。

### 3.3 只读与权限安全设计（若上 Text-to-SQL，缺一不可）

1. **数据库层只读**：专用只读账号/角色，物理上禁 INSERT/UPDATE/DELETE/DDL——不靠 prompt 约束（"系统提示词里写只准 SELECT"被普遍认为不可信）。
2. **三层 SQL 校验**（业界成熟方案）：① 正则快筛（拦多语句注入、DELETE/DROP 关键字，<1ms）；② AST 解析校验（`stmt.type === 'select'`，语义级保证，绕不过 `/*DELETE*/ SELECT` 这类混淆）；③ 递归表白名单（FROM/JOIN/子查询全部核对，模型无法访问白名单外的表）。
3. **EXPLAIN 预演 + 行数上限 + 超时**：防全表扫描拖垮系统。
4. **语义层**：把"本月营收""应交未交"等口径预定义为受控指标/视图，模型选指标而不是裸写口径——这是准确率提升最大的一刀（+21 分实测）。
5. **审计日志**：每次自然语言查询记录问题、生成 SQL、执行结果行数。

### 3.4 推荐路径（结合本项目）

- **一期**：function calling + 后端查询服务。工厂用户的问题域收敛（订单、库存、账款、排期四域），预定义 20-40 个参数化查询工具即可覆盖 90% 日常问数；权限走系统既有 RBAC，LLM 零权限。
- **二期**（数据积累、口径稳定后）：加受控 Text-to-SQL 通道覆盖长尾 ad-hoc 分析，全套护栏（只读账号+AST+白名单+语义层）+ 查询结果置信度展示。单厂单租户、内部可信用户是该路径的利好条件。

### 3.5 成本估算

日 50 次查询、每次约 3K 输入（含 schema/工具描述，工具描述稳定可享缓存命中）+ 1K 输出：月约 4.5M 输入 + 1.5M 输出。DeepSeek-V4-Flash（缓存命中 0.05 元/M、未命中 1.5 元/M、输出 4.5 元/M）≈ **20-40 元/月**。

---

## 4. 排产建议与异常预警

### 4.1 排产：LLM 不进决策回路，做"参谋"

证据链：

- **延迟冲突**：前沿 LLM 单次推理需数秒，而车间级调度决策周期是毫秒级——直接把 LLM 放进控制回路不可行（arXiv 2026 RACE-Sched：解法是双流架构——反应流跑确定性符号启发式规则，审议流用 LLM 离线合成/验证/演化规则后沙箱测试、原子化上线）。DSevolve 同理：LLM 离线演化调度规则组合，在线秒级自适应部署。
- **国内制造落地案例**（实在智能，袜业制造企业）："规则引擎 + 大模型"双脑——排产业务规则（同类订单合并、客户优先级、物料到货前 24 小时锁定）固化为代码约束；LLM 负责多方案生成与推荐（最小化延期/最大化产能利用率）；计划员确认后自动执行连锁更新。
- **本项目等级二定位**（APS 建模先行、界面人工拖排、自动排产二期）：与上述证据完全吻合。

**推荐架构**：
1. APS 数据底座（工序/耗时/产能模型）+ 硬约束校验器（产能、物料、交期、换型规则）= 决策核心，纯确定性。
2. LLM 职责一：**方案解释**——把一次拖排/一组调度参数的后果翻译成中文（"这样排会让 B 客户订单延 2 天，因为 3 号线周二满载"）。
3. LLM 职责二：**what-if 对比叙述**——输入由规则引擎算出的 2-3 个候选方案的结构化指标，LLM 生成对比叙述供计划员选择（数字由引擎算，LLM 不算数）。
4. LLM 职责三：**建议生成**——基于约束冲突列表生成调整建议清单，标注每条建议影响的订单与工序。
5. 二期自动排产算法落地时，LLM 可选承担"规则演化助手"角色（离线生成/调试调度启发式规则），与 RACE-Sched/DSevolve 模式一致。

### 4.2 异常预警：规则触发，LLM 解释

- 工程界明确结论：LLM 不应替代专用异常检测（对结构化数据，规则/统计方法更可靠、可审计）；LLM 的价值在**检测之后的环节**——解释异常、关联历史与上下文（维护记录、事件日志）、建议后续动作（arXiv PSE 综述 §9.4）。
- 规则引擎 vs AI 检测的对比结论：规则引擎在可解释性、可审计性、已知失效模式覆盖上是 9/10；AI 在新型异常覆盖上 8/10——**混合架构是务实路径**（PatSnap 对比分析）。
- 建筑案例（瓦萨大学 2026 论文）：SPC（统计过程控制）+ ML 异常检测 + 可解释层 + LLM 聊天界面的四层架构验证有效——LLM 引用看板数据生成自然语言解释，让系统"操作员友好"。

**推荐架构**：
1. 确定性规则引擎定义预警：交期冲突（计划完工 > 客户交期）、库存下限穿透（原料/成品低于安全水位）、超期未开工、物料齐套缺口、账款逾期——全部可配置阈值。
2. 预警触发后组装上下文包（预警详情 + 关联订单/物料/排期 + 近期同类历史），LLM 生成：异常解释、可能原因假设（列为可勾选项而非断言）、处置建议。
3. 建议始终是 advisory，处置动作由人确认（工业场景共识）。
4. 后期数据积累后可叠加统计/ML 异常检测（如销量突降），作为规则引擎之外的第二层。

### 4.3 成本估算

排产解释 + 预警合计日均 30 次事件、每次 3K 输入 + 1K 输出：月约 2.7M 输入 + 0.9M 输出，DeepSeek-V4-Flash 级别 ≈ **10-25 元/月**。

---

## 5. 报表生成：模板化渲染 + LLM 摘要

2026 年生产级报表自动化已收敛为三层共识架构：

1. **指标层（口径唯一）**：营收、成本、利润、应收应付等 KPI 各只有唯一定义（指标注册制）——杜绝"同名不同义"（国内零售 BI 落地案例的核心教训：不同报表"毛利"口径不一导致会议对不上数）。
2. **模板/渲染层（确定性）**：报表结构固定（概要、KPI 卡、趋势图、分域明细、异常标注、附录），数字全部由 SQL/查询结果填充，图表由代码渲染。
3. **LLM 叙述层（只解释、不计算）**：写执行摘要、异常解读、建议；关键约束是**每个论断锚定引用的数值，禁止因果臆测**。最佳实践包括：只把统计摘要（而非原始行）喂给模型、输出后对文中数字与源数据做核对、前 4-6 期人工全审后转抽检。

本地化实践佐证：一台约 900 美元的 14B 本地模型小主机即可驱动周报管道（说明该任务对模型要求不高）；商业方案（Power BI Copilot 等）从 $20/用户/月起——自建管道成本远低于采购。

**推荐落地**：
- 报表模板引擎（可复用订单域的打印模板体系）+ SQL 取数 + LLM 摘要（qwen-plus 或 DeepSeek-V4-Flash 足够；执行摘要级质量可切 qwen3-max/GLM-5）。
- 日报/周报/月报 + 月度经营分析；摘要提示词中强制"仅使用所给数据、不得编造数字"，并做输出数字回核。
- 异常标注节直接复用第 4 节预警引擎的输出，两能力共用底座。

**成本估算**：月 10 份报表、每份 20K 输入 + 3K 输出：月 0.2M 输入 + 0.03M 输出 ≈ **1-3 元/月**。

---

## 6. 推荐模型组合（接入层设计）

| 角色 | 首选 | 备选/可切换 | 理由 |
|---|---|---|---|
| 常规文本（查数/摘要/解释） | DeepSeek-V4-Flash | qwen-plus、GLM-4.7-Flash（免费兜底） | 闲时输入 1.5 元/M、缓存命中 0.05 元/M，1M 上下文，JSON/工具调用齐备 |
| 多模态（订单图片） | qwen3-vl-flash | qwen3-vl-plus、豆包 doubao-seed-2.1-pro（图片+视频输入）、Kimi K3 | 入门级价格（≈0.35 元/M 输入）即可达 88-93% 抽取准确率 |
| 复杂推理（排产对比、深度分析） | qwen3-max | DeepSeek-V4-Pro、GLM-5、Kimi K3 | 旗舰级质量；按需调用、量小 |
| 零成本开发测试 | GLM-4.7-Flash | Ollama + Qwen3-VL-8B 本地 | 开发期零账单 |

工程约束：
- 统一走 **OpenAI 兼容接口 + 网关层**（如 LiteLLM），模型名做成配置——2026 年涨价潮下供应商可切换是硬需求。
- 用足**上下文缓存**（系统提示/工具定义/schema 描述稳定不变，缓存命中价是未命中的 1/10~1/30）与**闲时批处理**（夜间跑报表、订单批量解析走周末低价档）。
- 多模态单据图片注意分辨率与视觉 token 计费（图片/视频 tokens 计入输入）。

---

## 7. 总成本与分期建议

**月度 API 成本估算（单厂规模：月 500 单、日 50 次问数、日均 30 次预警/解释、月 10 份报表）**：

| 能力 | 月输入 tokens | 月输出 tokens | 估算月费 |
|---|---|---|---|
| 订单解析 | ~1.5M（含视觉） | ~0.5M | 1-5 元 |
| 自然语言查数 | ~4.5M | ~1.5M | 20-40 元 |
| 排产解释+异常预警 | ~2.7M | ~0.9M | 10-25 元 |
| 报表生成 | ~0.25M | ~0.05M | 1-3 元 |
| **合计** | ~9M | ~3M | **约 30-100 元/月**（旗舰模型用量放大后上限约 300 元） |

对比私有化：一台能跑 32B 量化模型的 GPU 服务器约 2-4 万元 + 电费运维 + 人力，且 Windows 开发环境与 vLLM 生产栈不兼容——**API 成本低两个数量级，明确选 API**。

**分期建议（供"AI 能力分期"票参考）**：
1. **一期（随核心域上线）**：订单解析（直出+校验+人工确认）与报表摘要——价值最直观、护栏最简单；查数走 function calling 小工具集。
2. **二期（数据规范后）**：受控 Text-to-SQL（全套护栏）、排产 what-if 解释、规则预警 + LLM 解释。
3. **三期（数据积累后）**：与自动排产算法联动（LLM 规则演化助手）、ML 异常检测叠加。

---

## 8. 引用清单

**官方定价/模型文档（一手来源）**
1. DeepSeek API 文档·模型与价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
2. 阿里云百炼·qwen3-max 模型页：https://help.aliyun.com/zh/model-studio/model-qwen3-max
3. 阿里云·模型推理计费（含 qwen3-vl 国际价）：https://www.alibabacloud.com/help/en/model-studio/billing/
4. 智谱开放平台定价页：https://open.bigmodel.cn/pricing
5. Kimi K3 定价说明（官方）：https://www.kimi.com/zh-cn/resources/kimi-k3-pricing
6. 火山引擎·模型价格文档：https://www.volcengine.com/docs/82379/1544106
7. 火山方舟·Doubao-Seed-2.0-pro 模型详情：https://console.volcengine.com/ark/region:cn-beijing/model/detail?Id=doubao-seed-2-0-pro

**订单解析（多模态 vs OCR）**
8. genalphai·Document AI 2026: OCR vs VLM（四条件对比）：https://genalphai.com/document-ai-in-2026-vlms-ocr-and-idp-compared
9. invoox·AI Vision 发票抽取精度实测（4800 单样本）：https://invoox.io/en/blog/ai-vision-invoice-extraction-accuracy
10. app-lab.ai·MLLM 能否替代 OCR（2026 研究）：https://app-lab.ai/blog/ai-document-processing
11. parsli·LLM OCR vs 传统 OCR 2026 基准：https://parsli.co/guides/accounting-ocr
12. ortemtech·2026 IDP 与置信度路由：https://ortemtech.com/blog/intelligent-document-processing-services-2026

**自然语言查数**
13. aiworkflowlab·生产级 Text-to-SQL 指南（语义层/三层校验）：http://aiworkflowlab.dev/article/text-to-sql-llm-production-schema-linking-guardrails-2026
14. dreaming.press·Spider/BIRD 基准 vs 真实仓库：https://dreaming.press/posts/text-to-sql-accuracy-spider-vs-bird.html
15. atlan·Text-to-SQL 崩坏点综述（含 Snowflake 57%→78% 实测）：https://atlan.com/know/ai-agent/data-for-ai/text-to-sql-with-ai
16. Towards AI·28 表生产查询引擎（三层 AST 校验器实录）：https://pub.towardsai.net/how-i-built-a-production-ai-query-engine-on-28-tables-and-why-i-used-both-text-to-sql-and-5794d407d6ab
17. DigitalOcean·Guardrail 模式（工具调用 vs Text-to-SQL）：https://dev.to/digitalocean/building-an-llm-tool-calling-workflow-with-digitalocean-and-connected-databases-12op
18. hikmahtechnologies·LLM 安全接库四模式：https://hikmahtechnologies.com/blog/connect-llm-to-database-safely

**排产与异常预警**
19. arXiv·RACE-Sched 异步智能体动态调度（双流架构）：https://arxiv.org/html/2605.29262v1
20. arXiv·DSevolve LLM 演化启发式调度组合：https://arxiv.org/html/2603.27628v1
21. 实在智能·规则引擎+大模型双脑排产案例：https://www.ai-indeed.com/encyclopedia/27445.html
22. arXiv·LLMs in Process Systems Engineering（§9：LLM 不替代检测算法）：https://ar5iv.labs.arxiv.org/html/2606.11589
23. PatSnap·规则 vs AI 异常检测对比：https://www.patsnap.com/resources/blog/articles/rule-based-vs-ai-anomaly-detection-for-quality-control/
24. 瓦萨大学·SPC+ML+XAI+LLM 四层质检系统（2026）：https://osuva.uwasa.fi/items/09af6e77-7621-4911-9626-fbb3f18db818/full

**报表生成**
25. swfte·2026 自动化报表三层架构：https://www.swfte.com/prds/how-to/automate-report-generation
26. 新普软件·大模型 BI 报表与智能归因落地（指标中台案例）：https://www.xpshop.cn/articles/article-248.html
27. localaimaster·本地模型自动报表工作流：https://localaimaster.com/blog/local-ai-automated-reports
28. pingax·AI Generated Reports 2026 指南：https://pingax.com/ai-generated-reports-from-data/

**私有化与行业趋势**
29. 元空间科技·企业私有部署 DeepSeek/Qwen 选型与成本（2026）：https://www.linkmetax.com/blog/private-llm-deepseek-qwen-deployment-2026
30. rajpoot.dev·2026 自托管 LLM（vLLM/Ollama/硬件）：https://blog.rajpoot.dev/posts/ai/self-hosted-llms-vllm-ollama-2026
31. phosailabs·自建 AI 栈成本分水岭：https://phosailabs.com/blog/self-host-ai-stack-without-openai
32. 证券时报·DeepSeek 调价与行业涨价周期：https://www.stcn.com/article/detail/4103775.html
33. 新浪财经·2026Q2 国内模型均价与涨价分析：https://finance.sina.com.cn/stock/t/2026-08-18/doc-inintxxs0017289.shtml
