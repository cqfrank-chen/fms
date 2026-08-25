# 02 · AI 接入方案调研

Type: research
Status: open
Blocked by: —

## Question

为系统调研 AI 全面接入的实现路径。能力全集：订单解析、自然语言查数、排产建议、异常预警、报表生成。

1. 订单解析：邮件/Excel/图片 → 结构化计划单草稿——多模态 LLM 直出 vs OCR+LLM 流水线，准确率与兜底校验设计
2. 自然语言查数：Text-to-SQL vs 基于后端 API 的工具调用（function calling），权限与只读安全
3. 排产建议与异常预警：与排期数据底座的结合方式（规则引擎+LLM 解释 vs 纯 LLM）
4. 报表生成：模板化渲染 + LLM 摘要
5. 模型选型：国内可用性、API 成本、上下文长度、多模态能力；API vs 私有化部署

产出：带引用的调研报告，每项能力给出实现路径推荐与大致成本，写到 `.scratch/factory-management-system/research/02-ai-integration.md`。
