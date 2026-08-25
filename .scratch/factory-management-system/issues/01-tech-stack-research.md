# 01 · 技术栈与架构调研

Type: research
Status: resolved
Blocked by: —

## Question

为「一体化工厂管理系统」（单厂自用、代理自建、Windows 开发环境、后续接 AI，覆盖订单→计划单、排期、仓储、账目统计四域）调研并推荐技术栈与基础架构：

1. 前端框架与管理端组件库选型
2. 后端框架与语言在「代理协作开发」下的优劣
3. 数据库与 ORM 选型
4. 部署形态（Docker Compose 单机 / 云服务器）与基本网络拓扑（工厂内网/公网访问）
5. 从零自研 vs 基于开源 ERP/MES（Odoo、ERPNext 等）二次开发：许可证、定制自由度、四域覆盖度、长期可维护性

产出：带引用的调研报告与明确推荐（含备选），写到 `.scratch/factory-management-system/research/01-tech-stack.md`。

## Answer

推荐从零自研，技术栈定版：前端 React 19 + TypeScript + Ant Design 6（脚手架 Ant Design Pro V6，官方 MCP/CLI 对代理友好）；后端 NestJS 11；数据库 PostgreSQL 18；ORM 用 Drizzle（SQL-first、零 codegen、迁移可审查，2026-08 npm 周下载已反超 Prisma）。部署为单机 Docker Compose（nginx + app + postgres，库不出公网），服务器放厂内、远程经 frp/WireGuard 穿透，Windows 开发用 Docker Desktop 小企业免费档。

核心依据：代理自建视角下 TypeScript 是 AI 生成代码质量与全栈类型贯通的最优解；开源 ERP 二开（Odoo 好功能含 AI 全在企业版付费墙后、ERPNext 绑 Frappe 生态）恰在排期拖排与账目口径两处最不贴合本项目，且把代理按进小众框架的学习曲线。备选：前端 Vue 3.5 + Element Plus、后端 FastAPI（AI 重推理时）、ORM Prisma 7、路线翻案条件为需要完整财务/成熟 MRP/极短上线时限（届时优先 ERPNext）。

报告全文：[../research/01-tech-stack.md](../research/01-tech-stack.md)
