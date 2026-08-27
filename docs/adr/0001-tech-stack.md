# ADR-0001: 技术栈定版——从零自研、TS 全栈、单机 Docker Compose

本项目决定从零自研（而非基于 Odoo/ERPNext 二开），采用 TypeScript 全栈技术栈（React 19 + Ant Design 6 / NestJS 11 / PostgreSQL 18 + Drizzle ORM），以单机 Docker Compose 部署于厂内 Windows 机，因为项目由 AI 代理逐票开发，TS 全栈是代理生产效率最高、跨栈纠错成本最低的形态（AI 语料丰富度、类型系统对代理的纠错力、生态对代理友好度是选型第一权重）。

**Considered Options**（被否定的替代）:

- **Odoo 二开**：仓储/MRP 强，但完整财务与全部 AI 能力在企业版付费墙后，按用户月费订阅；代理须先精通 Odoo ORM/OWL/XML 继承机制，生成质量受限；每年大版本升级破坏 addon 是持续税。
- **ERPNext 二开**：全免费、DocType 低代码快，但代理学习曲线深（bench/Frappe 体系）；排期拖排仍要大改；财务强到越界（本项目标准做账出界）。
- **FastAPI（Python 后端）**：仅当本地模型推理/深度数据分析成为一期核心时启用；当前 AI 形态（调 API + prompt 工程）TS 够用。
- **Prisma ORM**：自动关联加载、MCP 安全关卡是优点，但需 codegen 步骤（代理易忘）且复杂查询掉 raw SQL；账目域查询重，Drizzle 的 SQL 透明性更贴合。

**Consequences**:

- 厂内 Windows 机装 Docker Desktop（免费档）跑同一套 compose（nginx + app + postgres，postgres 不暴露端口），开发/生产同构；厂内 IP 直连、免登录、不开放远程（见票据 07）。
- 翻案条件：厂内机配置吃不消（<2C8G）时，生产迁移到云服务器（轻量 2C8G）；上云时必须补 HTTPS 与访问控制。
- 备份基线：每日 pg_dump 到服务器本地 + 每周拷移动硬盘，双备份兑底。
- 交付物含一键安装/升级双脚本（.bat 双击即用）。
- 排期域甘特/拖排组件（AntD 无原生甘特）是唯一前端风险点，开工前须技术验证（票据 05）。

关联票据：`issues/11-tech-architecture-decision.md`、`issues/01-tech-stack-research.md`。
