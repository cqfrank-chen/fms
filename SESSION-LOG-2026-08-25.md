# 会话纪要 · 2026-08-25 ～ 08-26

> 一体化工厂管理系统项目启动会话：从需求到决策地图。本文件是完整对话记录的结构化沉淀，供后续会话接续。

## 1. 原始需求

通过 /ask-matt 提出：

> 完成一个工厂订单到生成计划单（产品类型、包装要求、备注等）、账目统计、仓储管理、排期管理等，一体化的工厂管理系统。需要包括前端、后端以及 AI 系统的接入。

经 ask-matt 路由定性为**绿地大项目**，用户选定完整路线：

```
/setup-matt-pocock-skills（基础设施） → /wayfinder（决策地图） → /to-spec → /to-tickets → /implement
```

前两步在本会话完成。

## 2. 关键决策（四轮访谈敲定）

| 决策点 | 结论 |
|---|---|
| 规格范围 | 全系统规格（四域全量，非单域切片） |
| 业务边界 | 聚焦生产四域：订单→计划单、排期、仓储、账目统计；质检只留集成接缝（IQC 挂来料入库、IPQC 挂工序报工、OQC 挂成品出库）；分拣/零售/视频流量/标准财务做账出界 |
| 租户形态 | 自有工厂自用，单租户；数据模型预留多厂/多组织字段 |
| 实施主体 | 代理自建；规格要求 agent-ready |
| 排期能力 | APS **等级二·建模先行**：工序/耗时/产能按 APS 标准建模，界面人工拖排，自动排产算法待数据积累后二期补 |
| 账目口径 | 经营统计（订单营收、物料/生产成本、利润视图）+ 往来账款（应收/应付/对账单）；标准财务做账出界 |
| 现状 | 流程主要跑在 Excel/纸单上，需数据迁移与切换设计 |
| AI | 全面接入：订单解析、自然语言查数、排产建议、异常预警、报表生成全集入图，分期另票排定 |

## 3. 工程约定

- **Issue tracker**：本地 markdown，`.scratch/factory-management-system/`（map.md + issues/NN-slug.md），Status 行记录状态，约定见 `docs/agents/issue-tracker.md`
- **Triage 标签**：默认五角色（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）
- **域文档**：单上下文，根 `CONTEXT.md`（词汇表）+ `docs/adr/`，由 /domain-modeling 懒创建；现有术语：订单（Order）、计划单（Plan Sheet）、集成接缝（Integration Seam）、账目统计
- **根指令**：`AGENTS.md`
- **Git**：main 分支，两笔提交（脚手架配置 `ea7087b`、决策地图 `65a16f0`）；仓库级身份为占位（49765 / 49765@local），**推远程前需改为真实身份**

## 4. 调研结论（票据 01、02，报告在 `research/`）

**技术栈（01）**：从零自研——React 19 + TypeScript + Ant Design 6 / NestJS 11 / PostgreSQL 18 + Drizzle ORM；Docker Compose 单机厂内部署 + frp/WireGuard 远程穿透。ERPNext 二开仅在需要完整财务/成熟 MRP 时翻案。详见 `research/01-tech-stack.md`。

**AI 接入（02）**：五项能力统一「确定性为骨、LLM 解释」——订单解析走多模态直出、查数先工具调用后受控 Text-to-SQL、排产预警走规则引擎、报表走模板+摘要；国内 API 月费约 30-300 元，不私有化。详见 `research/02-ai-integration.md`。

## 5. 决策地图与票据状态

地图：`.scratch/factory-management-system/map.md`。共 13 张票：

| # | 票据 | 类型 | 状态 | 阻塞 |
|---|---|---|---|---|
| 01 | 技术栈调研 | research | **resolved** | — |
| 02 | AI 接入调研 | research | **resolved** | — |
| 03 | 订单与计划单域模型 | grilling | **claimed**（进行中） | — |
| 04 | 工序耗时数据整理 | task | open | — |
| 05 | 排期工序建模 | grilling | open | 04 |
| 06 | 仓储域模型与质检接缝 | grilling | open | — |
| 07 | 用户角色与端形态 | grilling | open | — |
| 08 | 账目范围与模型 | grilling | open | 03, 06 |
| 09 | 核心界面原型 | prototype | open | 03, 05 |
| 10 | AI 能力分期 | grilling | open | 02, 03 |
| 11 | 技术架构决策 | grilling | open | 01, 07 |
| 12 | 数据迁移与切换 | grilling | open | 03, 06 |
| 13 | 实施顺序 | grilling | open | 09, 11, 12 |

## 6. 票据 03 进行中的访谈（待接续）

票据 03（订单与计划单域模型）已认领，第一轮前沿四问已发出、**尚未作答**：

1. **产品主数据**：建产品目录（产品类型/默认包装/默认工序路线，订单从目录选） vs 订单自由填写 vs 目录+临时新品 —— 推荐建产品目录
2. **订单结构**：一单多产品（行项目） vs 一单一产品 —— 推荐一单多产品
3. **生成粒度**：一行一计划单 vs 一单一计划单 vs 可拆可合 —— 推荐一行一计划单
4. **生成流程**：手动生成+审核 vs 自动生成+审核 vs 自动直通 —— 推荐手动生成+审核

这四问定了，第二轮再问：订单状态机、计划单状态机、订单变更如何联动已生成计划单、包装要求的具体形态（结构化字段 vs 文本）等。

## 7. 下一步

1. **接续票据 03**：新会话加载 grilling + domain-modeling 技能，从上述四问开始（或直接按推荐答案确认后进第二轮）
2. 逐张解决前沿票据（04、06、07 可并行）
3. 全部 13 票 resolved 后 → `/to-spec` 收拢规格 → `/to-tickets` 拆 tracer-bullet 票据 → `/implement` 逐票实现

## 8. 本次迁移记录

2026-08-26 00:15 应用户要求，本会话工作区（`C:\Users\49765\WorkBuddy\2026-08-25-23-23-25`）的全部项目文件（含 git 历史）迁移至本目录 `D:\futures\factory-management-system\`。会话上下文由本纪要承载。
