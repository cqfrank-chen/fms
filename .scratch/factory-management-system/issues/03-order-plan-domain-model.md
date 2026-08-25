# 03 · 订单与计划单域模型

Type: grilling
Status: claimed
Blocked by: —

## Question

敲定「订单 → 计划单」的领域模型：

- 订单（Order）实体：客户、产品类型、数量、交期、备注等字段；状态机（草稿/确认/生产中/完成/取消？）
- 计划单（Plan Sheet）实体：从订单生成的生产计划单——产品类型、包装要求、备注字段的具体形态；一单一计划还是多单合并？
- 订单 → 计划单的生成规则与人工审核环节
- 敲定的术语同步写入根目录 CONTEXT.md（加载 grilling 与 domain-modeling 技能）
