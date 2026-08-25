# 02 · AI 接入方案调研

Type: research
Status: resolved
Blocked by: —

## Question

为系统调研 AI 全面接入的实现路径。能力全集：订单解析、自然语言查数、排产建议、异常预警、报表生成。

1. 订单解析：邮件/Excel/图片 → 结构化计划单草稿——多模态 LLM 直出 vs OCR+LLM 流水线，准确率与兜底校验设计
2. 自然语言查数：Text-to-SQL vs 基于后端 API 的工具调用（function calling），权限与只读安全
3. 排产建议与异常预警：与排期数据底座的结合方式（规则引擎+LLM 解释 vs 纯 LLM）
4. 报表生成：模板化渲染 + LLM 摘要
5. 模型选型：国内可用性、API 成本、上下文长度、多模态能力；API vs 私有化部署

产出：带引用的调研报告，每项能力给出实现路径推荐与大致成本，写到 `.scratch/factory-management-system/research/02-ai-integration.md`。

## Answer

五项能力全部建议"确定性系统为骨、LLM 为解释层"的混合架构：订单解析用多模态 LLM 直出（qwen3-vl，歪斜/新版式场景 88-93% vs OCR 44-61%）+ JSON Schema + 业务规则校验 + 低置信度转人工；查数一期走 function calling、二期再上带只读账号/AST 校验/语义层护栏的 Text-to-SQL（企业真实 schema 裸奔仅 21-39%）；排产与预警由规则引擎/APS 底座决策，LLM 只做方案解释与建议生成；报表为模板渲染 + LLM 摘要（只解释数字不生成数字）。模型选型国内 API 起步（DeepSeek-V4-Flash/qwen3-vl-flash 为主力，OpenAI 兼容网关保持供应商可切换），2026 年行业普涨是主要风险；单厂规模月成本约 30-300 元，远低于私有化（GPU 服务器 2-4 万起且与 Windows 开发环境不兼容），明确不私有化。完整证据、路径与成本表见报告。

报告：[../research/02-ai-integration.md](../research/02-ai-integration.md)
