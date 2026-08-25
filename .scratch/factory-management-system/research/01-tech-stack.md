# 01 · 技术栈与架构调研报告

> 调研日期：2026-08-26。票据：`issues/01-tech-stack-research.md`。
> 结论速览：**从零自研；React 19 + Ant Design 6 + NestJS 11（TypeScript 全栈）+ PostgreSQL 18 + Drizzle ORM；单机 Docker Compose 部署。** 详见文末「推荐」与「备选」。

---

## 0. 调研口径

- 项目特征：单厂自有工厂自用、单租户（数据模型预留多厂字段）、**代理自建**（由 AI 代理逐票写代码）、Windows 开发环境、后续接 AI。
- 四个业务域：订单→计划单、排期（APS 建模先行，界面人工拖排）、仓储、账目统计（经营统计+往来账款；标准财务做账出界）。
- 现状：Excel/纸单管理，需数据迁移。
- 「代理协作开发」是本次选型的第一视角：**语言/框架的 LLM 语料丰富度、类型系统对代理的纠错能力、生态是否为 AI 代理提供一等公民接口**，权重高于传统团队视角下的招聘、社区规模等因素。

---

## 1. 前端框架与管理端组件库

### 1.1 框架现状（2026-08）

| 框架 | 当前版本 | 备注 |
|---|---|---|
| React | 19.2.8（2026-07-21 补丁） | 19.2.x 线持续优化 Server Components 解码性能 |
| Vue | 3.5.41（2026-08-05 补丁）；3.6 处于 beta（Vapor Mode） | 3.5 线稳定；Vuex 已退役，官方仅推荐 Pinia |
| Angular | v21 | 信号、新控制流、企业级全家桶 |

来源：[React vs Vue TypeScript Setup 2026（tech-insider.org）](https://tech-insider.org/react-vs-vue-typescript-setup-2026/)、[React vs Vue State Management 2026](https://tech-insider.org/react-vs-vue-state-management-2026/)、[React vs Angular vs Vue in 2026（beadaptify.com）](https://beadaptify.com?p=14285/)

三者对 TypeScript 支持都成熟。对代理而言，React 生态的语料量与模式一致性最高（大量后台管理代码以 React+AntD 形态存在），生成代码的「模式可预测性」好；Vue 3 Composition API + SFC 亦是高质量语料，且模板语法约束更强、出错面更小。二者都可行，**不建议 Angular**（模板式大框架，AI 生成的样板量大、迭代慢，且国内中后台组件库生态明显偏向 React/Vue 两系）。

### 1.2 管理端组件库

国内企业中后台场景的主流共识：复杂表格、表单、筛选、权限密集的系统优先在 **Ant Design、Element Plus、Arco Design** 中选择；字节 Arco 与腾讯 TDesign 亦提供开箱即用的中后台脚手架（Arco Design Pro 有 React/Vue 双版本，TDesign Starter 有 Vue/React 版本）。来源：[产品经理如何选 UI 框架（网易号）](https://www.163.com/dy/article/KV75RLKN0511805E.html)、[国内互联网大厂开源中后台解决方案（网易号）](https://www.163.com/dy/article/H2DTKF1K055312ZP.html)

对本项目最关键的新事实是 **Ant Design 6 的 AI 优先路线**：

- **Ant Design 6.0**（2026-05-08 发布，当前 6.6.1/2026-08-17）主打「为 AI 时代的应用开发提供基础」，开放样式算法与语义化结构让 AI 定制主题，还支持一句话生成主题。来源：[Ant Design 官网](https://ant.design/)、[antd GitHub 发版记录（releasealert.dev）](https://releasealert.dev/github/ant-design/ant-design)
- **Ant Design Pro V6**：脱胎换骨的版本，React 19 + antd 6 + utoo 技术栈，构建速度提升 42%，**AI 助手开箱即用**——即官方中后台脚手架已内置面向 AI 代理的协作能力。来源：[Ant Design 官网公告](https://ant.design/)
- **Ant Design CLI**：官方终端工具，可查 API、做迁移，并带**官方 MCP 服务**，可直接挂进代码代理工作流。来源：[Ant Design 官网](https://ant.design/)

对比其他候选：

| 候选 | 技术栈 | 亮点 | 短板（本项目视角） |
|---|---|---|---|
| **Ant Design 6**（推荐） | React | 组件最全（表格/表单/级联/拖拽场景成熟）、Pro V6 脚手架、官方 MCP/CLI、99.1K stars | 无原生甘特图组件 |
| Element Plus | Vue 3 | 国内 Vue 后台事实标准 | React 生态下不可用 |
| Arco Design | React/Vue | 字节系，设计+研发一体化，有 Pro 脚手架 | 社区规模小于 AntD |
| TDesign | Vue/React | 腾讯系，跨端一致 | 桌面端组件丰富度略逊 AntD |
| Naive UI | Vue 3 | 轻量、类型好 | 中后台复杂组件积累少 |
| HeroUI / shadcn 系 | React | 视觉现代 | 面向 C 端/AI 工具风，管理端重表格表单场景组件薄 |

来源：[HeroUI 分析（微信/自媒体稿）](https://www.163.com/dy/article/KV75RLKN0511805E.html)、[7个大厂设计组件库分享（搜狐）](https://www.sohu.com/a/736901655_121845107)

**前端结论**：React 19 + TypeScript + Ant Design 6，脚手架直接用 Ant Design Pro V6（权限、布局、国际化、mock 齐全，省掉代理搭骨架的票）。排期域的甘特/拖排界面 AntD 无原生组件，需引入甘特库（dhtmlx-gantt、frappe-gantt 一类）或自研基于表格的拖排交互——这是前端侧唯一需要额外技术验证的点，留给排期域票据处理。

---

## 2. 后端框架与语言（代理协作开发视角）

### 2.1 语言：AI 生成代码质量排行

综合 GitHub Copilot、通义灵码、Claude Code 三大主流工具的实测维度（生成准确率、纠错成本、规范性、补全流畅度），2026 年的排名：

| 语言 | 综合得分（/10） | 要点 |
|---|---|---|
| **TypeScript** | 9.1 | 强类型兜底、三大工具表现一致优秀、返工最少 |
| **Python** | 8.8 | 语料最丰富，算法/脚本/AI 代码开箱即用 |
| JavaScript | 8.3 | 无类型约束偶有隐性 bug |
| Go | 7.5 | 骨架/CRUD 稳，并发逻辑易出小错 |
| Java | 7.3 | 模板代码标准，复杂业务易冗余跑偏 |
| C# | 7.1 | 语法糖多，AI 细节把控一般 |
| Rust / C++ | 6.7 / 6.0 | 所有权/内存是重灾区 |

来源：[AI 写代码准确率质量 开发语言排行榜（CSDN，2026）](https://blog.csdn.net/zhangfeng1133/article/details/161521219)。工具侧交叉印证：Cursor 对 React/TS 全栈理解最佳，Claude Code 在「长代码、项目级架构、TS 全栈项目」上是强项。来源：[12 Best AI Coding Agents 2026（techsy.io）](https://techsy.io/cs/blog/best-ai-coding-agents-2026)

对本项目的直接推论：**前端既然是 TS（React），后端继续 TS 可以让代理在单一语言、单一类型系统内跨端工作**——DTO 从数据库一路类型贯通到界面，代理改一个字段时编译器能同时约束前后端，这比「两个语言、两套工具链」的纠错成本低得多。

### 2.2 框架：NestJS vs FastAPI vs Go/.NET

| 项 | NestJS（TS） | FastAPI（Python） | Go（1.27） | .NET 10 |
|---|---|---|---|---|
| 当前版本 | 11.2.1（2026-08-15） | 0.136.x（2026-05） | 1.27（2026-08-19） | LTS |
| 许可 | MIT | MIT | BSD | MIT |
| 结构性 | 模块/控制器/服务/DI 强约定 | 装饰器路由+Pydantic，文件极简 | 标准库即可，无框架负担 | 全家桶 |
| 代理视角 | 结构清晰利于代理定位代码；v12 路线将原生支持 Zod/Valibot/ArkType 校验 | 语料极大、OpenAPI 文档自动生成 | 语法极简，但并发逻辑 AI 易出小错 | 语料质量好但国内工厂场景社区小 |
| AI/后续接 AI | TS 生态调用 LLM SDK 顺滑；类型贯通前端 | **若后续 AI 重（本地模型、数据分析）Python 生态最强** | 部署最简单（单二进制） | — |

版本与事实来源：NestJS 11（GA 2025-01-16，Express 5 默认适配器）与 v12 路线见 [NestJS v11 综述（hivebook.wiki）](https://hivebook.wiki/wiki/nestjs-v11-node-js-framework-express-5-fastify-5-defaults-path-to-regexp-v8-routes-json-logger-parsedatepipe-intrinsicexception-microservices-unwrap-on-status-appmodule-less-bootstrap-typed-cqrs-v11-0-to-v11-1-19-v12-esm-roadmap) 及 [@nestjs/core 发版记录（releasealert.dev，2026-08-15）](https://releasealert.dev/npmjs/@nestjs/core)；FastAPI 0.136.3、98.6K stars、月下载 4.885 亿次见 [FastAPI vs NestJS（solodevstack.com）](https://solodevstack.com/blog/fastapi-vs-nestjs-solo-developers)；Go 1.27（2026-08-19）见 [Go 官方 Release History](https://go.dev/doc/devel/release) 与 [Go Blog](https://blog.go.dev/)；.NET 10 LTS 见 [Ubuntu 官方博客](https://ubuntu.com//blog/from-jammy-to-resolute-how-ubuntus-toolchains-have-evolved)。

**后端结论**：**NestJS 11**。理由：
1. 单人（代理）开发下，NestJS 的强约定结构（module/controller/service）是给代理的「护栏」，逐票开发时代理能精准定位改动点；FastAPI 的自由结构在项目变大后更依赖人的架构自觉。
2. 与前端同语言同类型系统，代理跨栈工作零切换。
3. 内置能力覆盖本项目全部形态：REST API、WebSocket（未来异常预警推送）、任务调度（对账单/统计报表定时生成）、守卫式鉴权。
4. v12 的 Standard Schema（Zod 等）将进一步降低校验层样板。

FastAPI 是有力备选（若「后续接 AI」升级为重本地模型/数据分析，Python 生态无敌），但本项目 AI 形态是「订单解析、自然语言查数、报表生成」这类调 API + prompt 工程为主的场景，TS 调用 LLM SDK 完全够用。

---

## 3. 数据库与 ORM

### 3.1 数据库：PostgreSQL 18

**PostgreSQL 18**（2025-09-25 发布，当前小版本 18.4/2026-05-14，预计 EOL 2030-11）是当前首选：新异步 I/O 子系统读性能最高提升 3 倍；`uuidv7()` 原生函数（时间有序，适合分布式单据号与索引局部性）；虚拟生成列（查询时计算，账目统计的派生指标可用）；多列 B-tree 索引 skip scan；OAuth 2.0 认证。来源：[PostgreSQL 18 官方新闻稿](https://www.postgresql.org/about/press/presskit18)、[pgpedia.info PostgreSQL 18 条目](https://pgpedia.info/postgresql-versions/postgresql-18.html)

选 PG 而非 MySQL 的理由（本项目视角）：
- 经营统计/往来账款域大量**复杂聚合、CTE、窗口函数**（对账单、账龄分析、利润视图），PG 的 SQL 能力面更宽。
- 严格的类型与约束（含 `NUMERIC` 精确小数用于金额）对代理生成的 schema 错误更不宽容——错误早暴露，符合「类型兜底」思路。
- JSONB 可承载订单/计划单的弹性字段（包装要求、备注类半结构化数据），替代「EAV 表」这类反模式。
- Odoo 亦只支持 PostgreSQL，未来若走二开路线不换库。来源：[Odoo 综述（hivebook.wiki）](https://hivebook.wiki/wiki/odoo-open-core-business-apps-suite)

单厂单租户数据量（订单/库存流水/账目，年增大概率在百万行级）远低于 PG 单机能力上限，无分库分表需求，**预留多厂用 `org_id` 字段即可**。

### 3.2 ORM：Drizzle（推荐）vs Prisma

2026-08 的关键事实：**Drizzle npm 周下载 1817 万，首次反超 Prisma 的 1600 万**；GitHub stars 35.4K vs 47.5K（Prisma 仍领先），增长曲线呈交叉态势。来源：[Prisma vs Drizzle 深度对比（2026-08，含 npm/GitHub 数据声明）](https://juejin.cn/)（原文见中文社区转载，数据来源标注为 GitHub API 与 npm 2026-08）

| 维度 | Drizzle | Prisma（7.x） |
|---|---|---|
| 心智模型 | SQL-first：链式 API 就是 SQL 结构，复杂聚合/窗口函数完全可控 | 声明式对象 API，复杂查询需 `$queryRaw` 逃生口 |
| 类型来源 | TS 实时推断，**零 codegen** | `prisma generate` 代码生成步骤 |
| 迁移 | 生成 SQL 迁移文件，**可审查可手改** | 全自动 diff（省心但黑箱） |
| 引擎 | 纯 TS，无原生二进制 | 已从 Rust 原生引擎转向 Wasm 内嵌 + driver adapters |
| AI 代理友好度 | 表定义即 TS 代码，代理读改一体 | **官方把 AI 代理当一等公民**：AGENTS.md/CLAUDE.md、MCP server 且故意不暴露 `migrate-reset` 等破坏性命令、危险命令关卡 |

Prisma 的 AI 基础设施细节（AGENTS.md、ai-safety.ts、MCP 安全设计）来源：[Prisma GitHub 项目深度解析（Apache 2.0）](https://github.com/prisma/prisma)

**ORM 结论**：**Drizzle ORM** 为主选。理由：
1. 账目统计域是全系统查询最重的域（对账单、账龄、利润视图、多维聚合），Drizzle 的 SQL 透明性让代理写出的查询「所见即所得」，性能问题可直接翻译为 SQL 优化，而 Prisma 在这类场景会频繁掉进 raw SQL 逃生口，抵消类型收益。
2. 无 codegen 步骤：代理改 schema → 类型立即更新，减少一个代理容易忘记执行的中间步骤（忘记 `prisma generate` 是经典事故）。
3. 迁移文件是可读 SQL，符合「数据库变更是严肃操作、须可审查」的工程判断，也便于人工复核代理的 schema 变更。

Prisma 7 为备选（若团队更看重 CRUD 开发速度与关联加载的自动化，或想用其 MCP 安全关卡约束代理）。附注：Prisma 官方的「危险命令关卡 + MCP 不暴露破坏性操作」设计值得本项目借鉴到自己的工具链里。

---

## 4. 部署形态与网络拓扑

### 4.1 许可与成本前提（Windows 开发机）

Docker Desktop 对**小型企业（员工 < 250 人且年收入 < 1000 万美元）、个人、教育、非商业开源项目免费**；超出则需付费订阅（Pro 涨价后 $9/月/用户、Team $15/月/用户）。来源：[Docker 订阅条款（官方 FAQ 转载）](https://ima.qq.com/wiki/?shareId=ad15ec1f830c0f1c49d4d53319c061b2265106744fd0819c3eafa310cede72a6&mediaId=markdown_7f7207bdf5432c9b145cd578de9e4659_acd7c45f20e472c9a238ea7f529ef85c7354323751169497&action=openDetailDrawer&webFrom=10000171)、[Docker Desktop 收费报道（搜狐）](https://www.sohu.com/a/487109785_115128)、[Docker 订阅调价（网易号）](https://www.163.com/dy/article/JC6T6PPN0511B8LM.html)

单厂自用形态基本必然落在免费档内；且**生产部署不依赖 Docker Desktop**——Linux 服务器上直接用开源的 Docker Engine + Docker Compose（v2），无许可问题。

### 4.2 部署形态：单机 Docker Compose（推荐）

单厂自用、单租户、用户数个位数到几十，**一台服务器 + 一个 docker-compose.yml 足够**，不引入 K8s：

```
服务器（厂内工控机/塔式服务器，或 1 台云服务器 2C8G 起）
└─ docker compose
   ├─ nginx / Caddy（反向代理，80/443，静态前端 + API 转发）
   ├─ app（NestJS，容器化）
   ├─ postgres:18（仅 compose 内网暴露，不映射公网端口）
   └─ (预留) ai-worker（后续接 AI 的独立服务容器，便于单独迭代）
```

要点：
- postgres 不暴露宿主机端口，仅 app 网络可达；备份用 `pg_dump` 定时任务（备份策略是地图「Not yet specified」项，另票处理）。
- 配置全部走 `.env` + compose 文件，仓库即部署说明书，代理可完全自动执行升级（`docker compose pull && up -d`）。
- Windows 开发机上：Node 22 LTS + Docker Desktop（免费档）本地起同样 compose，开发/生产同构。

### 4.3 网络拓扑：厂内为主 + 受控远程

- **主路径（推荐）**：服务器放厂内，厂内电脑浏览器直连内网 IP/域名访问。优点：生产数据不出厂、断公网不停产、纸单/Excel 迁移阶段内网协作最顺。
- **远程访问（老板/销售外出查单）**：二选一——
  1. 云服务器做 frp/WireGuard 反向代理入厂（内网穿透，入口收敛到一台云主机，成本低）；
  2. 整个系统直接放云服务器（阿里云/腾讯云轻量，HTTPS + 账号体系），厂内走公网访问。省去穿透运维，但数据在云端、依赖公网可用性。
- **后续接 AI 的约束**：AI 票若走云端 LLM API（订单解析、报表生成），服务器需有公网出站能力——厂内服务器出站到 LLM API 即可（不开放入站），云服务器天然满足。若将来要求 AI 完全离线（本地模型），厂内服务器 + GPU 是唯一路径，云服务器方案需预留迁移。这点建议在「AI 能力分期」票里定夺。

来源（部署惯例参照）：[ERPNext 官方自托管 Docker Compose 文档模式（selfhost.directory）](https://selfhost.directory/project/erpnext)

---

## 5. 从零自研 vs 基于开源 ERP/MES 二开

### 5.1 两条开源路线的许可证事实

**Odoo 19**（2025 年秋发布，最新大版本，支持至约 2028-10）：
- 双版本模式（open-core）：**Community 版 LGPLv3 免费**（CRM/销售/库存/开票/基础 MRP/网站等约 15 个标准应用）；**Enterprise 版商业授权、按用户按应用订阅**（Standard 约 $25/用户/月起，Custom 约 $38/用户/月）。
- **Enterprise 独占**：完整财务、Studio 无代码定制、文档/电子签、OCR、**全部 AI 功能（自然语言查询、AI Agents、AI 文档处理——Odoo 19 首发原生的 AI 能力全部在企业版）**。来源：[Odoo 综述（hivebook.wiki）](https://hivebook.wiki/wiki/odoo-open-core-business-apps-suite)、[Odoo 19 CE→EE 迁移与许可指南（octurasolutions.com）](https://octurasolutions.com/resources/odoo-19-community-to-enterprise-migration-features-licensing-and-upgrade-guide)、[What is Odoo 2026 guide（techultrasolutions.com）](https://www.techultrasolutions.com/what-is-odoo)、[Odoo Community vs Enterprise（oec.sh）](https://oec.sh/odoo-pricing/community)
- 许可证含义：LGPLv3 允许私有扩展模块（自研 addon 可闭源），**但**每年一次大版本升级会破坏 API，官方迁移工具属于企业版订阅，Community 用户只能靠 OpenUpgrade 自迁移——「长期可维护性」成本高。
- 技术栈：Python + 自研 OWL 前端框架 + 自研 ORM，仅支持 PostgreSQL。定制方式是写继承式 Python addon。来源：[Odoo 综述（hivebook.wiki）](https://hivebook.wiki/wiki/odoo-open-core-business-apps-suite)

**ERPNext v16**（2026-01-12 发布，支持至 2029 底）：
- **单版本、完全开源**：ERPNext 应用层 GPLv3，底层 Frappe 框架 MIT。**无按用户收费、无功能付费墙**；自托管免费，Frappe Cloud 托管约 $5/站点/月起。来源：[ERPNext Review（erp-information.com）](http://www.erp-information.com/erpnext-erp-guide)、[ERPNext 综述（hivebook.wiki）](https://www.hivebook.wiki/wiki/erpnext-open-source-erp-on-the-frappe-framework)
- 定制模型：DocType 元数据驱动（界面加字段即自动生成 REST API），深度定制走 Custom App 模式；生命周期工具是自家的 `bench`；生产栈为 Frappe + MariaDB/Postgres + Redis + workers + Nginx，**生产环境需要较充分的内存与后台 worker 配置**。来源：[ERPNext 综述（hivebook.wiki）](https://www.hivebook.wiki/wiki/erpnext-open-source-erp-on-the-frappe-framework)
- 许可证含义：GPLv3 对**内部使用无任何传染问题**（不分发即无开源义务）；仅当未来把系统二次打包对外销售/分发时，ERPNext 衍生部分须开源。单厂自用无此风险。

### 5.2 四域覆盖度核对

| 域 | Odoo Community | ERPNext | 自研 |
|---|---|---|---|
| 订单→计划单 | Sales 模块开箱即用；计划单需定制 addon | Sales Order 齐全；计划单映射到 Work Order | 从零建，贴合「产品类型/包装要求/备注」口径 |
| 排期（APS 建模+人工拖排） | Manufacturing 基础 MRP；Gantt 视图在 Enterprise 版 | 生产计划模块有 Gantt | 需自研拖排界面（AntD+甘特库） |
| 仓储 | Inventory 强项（多仓/批次/序列号） | Stock 强项（FIFO/移动平均估值） | 从零建（单厂单仓起步，复杂度可控） |
| 账目统计 | **完整财务在 Enterprise**；Community 仅开票 | 复式记账齐全（甚至超出需求——标准做账已出界） | 按口径自建：经营统计+应收应付，不做凭证 |

来源：[Odoo Community vs Enterprise 功能对照（oec.sh）](https://oec.sh/odoo-pricing/community)、[ERPNext 模块清单（hivebook.wiki）](https://www.hivebook.wiki/wiki/erpnext-open-source-erp-on-the-frappe-framework)

开源 MES 市场横评的共识佐证：开源方案在**复杂排程（APS）与设备集成上是普遍短板**，需要二次开发弥补，且「免费」隐含自行承担部署/维护/升级/Bug 修复的运维成本。来源：[MES 系统怎么选·2026 横评（搜狐）](https://www.sohu.com/a/1055842107_121743674)、[顶级免费与开源 MES 2026（mdcplus.fi）](https://mdcplus.fi/blog/dingji-mianfei-mes-xitong-shengchan-zhixing)、[自研/开源方案对比（简道云博客）](https://www.jiandaoyun.com/nblog/128472/)

### 5.3 判决：从零自研

| 维度 | 自研（TS 全栈） | Odoo 二开 | ERPNext 二开 |
|---|---|---|---|
| 代理协作开发 | **最优**：TS 语料/AI 生成质量第一，前后端一体 | 差：代理须先精通 Odoo ORM/OWL/XML 视图/继承机制，语料虽多但框架概念深，生成质量受限 | 中：Frappe DocType 模式较规整，但 bench/元数据体系仍需学习曲线 |
| 许可证 | 自有代码，无任何约束 | LGPL 可私有 addon；但好功能在企业版（含全部 AI），要用就得按用户付费 | GPLv3 内部使用无碍；对外分发才受限 |
| 定制自由度 | **完全**：四域数据模型按 CONTEXT.md 词汇表长 | 受框架约束；每年大版本升级破坏 addon | 受 DocType/Custom App 框架约束 |
| 四域覆盖 | 需自建（但四域本质是 CRUD+调度+统计，无行业深水区） | 仓储/MRP 强；**排期 Gantt 与完整财务在企业版** | 覆盖最全且全免费；但财务强到越界（做账已出界） |
| 长期可维护性 | 代码自己写自己懂；依赖皆主流长青 | 年度大版本升级是持续税；Community 迁移靠 OpenUpgrade | bench 体系自洽，但绑死 Frappe 生态 |
| 与「后续接 AI」的关系 | **自己设计 AI 接入层，自由** | Odoo 19 AI 全在企业版，自接 AI 要绕框架 | 自由，但要在 Frappe 内接 |

决定性理由（按权重）：
1. **代理自建是本项目的前提**，而 TS 全栈是代理生产效率最高的形态（第 2.1 节语言排行 + AntD/Prisma 等生态 2026 年全面 AI 优先化）；Odoo/ERPNext 二开把代理按进小众框架的学习曲线里，恰好用短了代理的长处。
2. **排期域是核心差异点**，而开源 ERP 恰在排程/拖排上最弱（需大改），改造成本 ≈ 自研。
3. **账目统计口径是非标准的**（经营统计+往来账款、不含做账），Odoo 完整财务在企业版、ERPNext 财务强到越界，两头都不贴合。
4. 许可证上自研无任何尾巴；Odoo 好东西在付费墙后，ERPNext 的 GPLv3 虽不碍内部使用但堵死了未来任何对外产品化路径。
5. 「从 Excel/纸单迁移」的路线在自研形态下最自然：数据模型按工厂真实口径建，迁移脚本与系统同语言同仓库。

**二开路线何时翻案**：若未来需求升级为完整复式记账财务、电子签、成熟 MRP II/PLM/质量模块、或需要立即上线（数周内）而不接受分期建设，应重新评估 ERPNext（全免费、DocType 低代码定制快）而非 Odoo（付费墙）。这一条写进备选。

---

## 6. 推荐（定版建议）与备选

### 推荐（主选）

| 层 | 选型 | 版本锚点（2026-08） |
|---|---|---|
| 前端 | React + TypeScript + **Ant Design 6**，脚手架 **Ant Design Pro V6** | React 19.2.x / antd 6.6.x |
| 后端 | **NestJS 11** | 11.2.x（Express 5 默认） |
| 数据库 | **PostgreSQL 18** | 18.4 |
| ORM | **Drizzle ORM** + drizzle-kit 迁移 | 当前稳定线 |
| 部署 | **单机 Docker Compose**（nginx + app + postgres，postgres 不暴露端口），服务器放厂内，远程经 frp/WireGuard 穿透 | Compose v2 |
| 路线 | **从零自研**，四域按票据分期落地 | — |

配套要点：
- 开发环境（Windows）：Node 22 LTS + VS Code + Docker Desktop（小企业免费档）；生产（Linux）：Docker Engine + Compose。
- 类型贯通：数据库 schema（Drizzle）→ NestJS DTO → 前端接口类型尽量单一来源生成，让编译器约束代理的跨端修改。
- 排期域开工前先做甘特/拖排组件的技术验证票（AntD 无原生甘特，是唯一前端风险点）。
- 迁移策略：PostgreSQL 直接承接 Excel 数据导入（CSV/copy），账目历史数据入仓即可支持对账单。

### 备选（次选与翻案条件）

1. **前端备选**：Vue 3.5 + Element Plus（或 Naive UI）+ Vite——若实施中发现 Vue 语料下代理表现更稳，或团队偏好 Vue；功能面无损。
2. **后端备选**：FastAPI + SQLAlchemy（Python）——仅当「AI 能力分期」票把本地模型推理/深度数据分析排为一期核心时启用，届时可考虑前后端分语言。
3. **ORM 备选**：Prisma 7——若排期域/账目域实际开发中 Drizzle 的关联查询样板拖慢代理，Prisma 的自动关联加载与其 MCP 安全关卡是合理退路。
4. **路线备选（翻案条件）**：ERPNext v16 自托管二开——当需求升级为完整财务/成熟 MRP/极短上线时限时；Odoo 仅在愿意接受按用户付费获取企业版 AI 与财务能力时考虑。

---

## 参考来源汇总

- React/Vue/Angular 2026 现状：[tech-insider.org React vs Vue TS](https://tech-insider.org/react-vs-vue-typescript-setup-2026/)、[beadaptify.com](https://beadaptify.com?p=14285/)
- 组件库格局：[网易号·UI 框架选型](https://www.163.com/dy/article/KV75RLKN0511805E.html)、[网易号·大厂中后台方案](https://www.163.com/dy/article/H2DTKF1K055312ZP.html)
- Ant Design 6 / Pro V6 / CLI+MCP：[ant.design](https://ant.design/)、[antd 发版记录](https://releasealert.dev/github/ant-design/ant-design)
- AI 写码语言排行：[CSDN](https://blog.csdn.net/zhangfeng1133/article/details/161521219)；AI 编码代理工具栈：[techsy.io](https://techsy.io/cs/blog/best-ai-coding-agents-2026)
- NestJS：[hivebook.wiki v11 综述](https://hivebook.wiki/wiki/nestjs-v11-node-js-framework-express-5-fastify-5-defaults-path-to-regexp-v8-routes-json-logger-parsedatepipe-intrinsicexception-microservices-unwrap-on-status-appmodule-less-bootstrap-typed-cqrs-v11-0-to-v11-1-19-v12-esm-roadmap)、[releasealert.dev @nestjs/core](https://releasealert.dev/npmjs/@nestjs/core)、[solodevstack.com FastAPI vs NestJS](https://solodevstack.com/blog/fastapi-vs-nestjs-solo-developers)
- Go / .NET：[go.dev Release History](https://go.dev/doc/devel/release)、[Go Blog](https://blog.go.dev/)、[Ubuntu blog](https://ubuntu.com//blog/from-jammy-to-resolute-how-ubuntus-toolchains-have-evolved)
- PostgreSQL 18：[官方新闻稿](https://www.postgresql.org/about/press/presskit18)、[pgpedia.info](https://pgpedia.info/postgresql-versions/postgresql-18.html)
- Drizzle vs Prisma（2026-08 数据）：中文社区深度对比（npm 周下载 1817 万 vs 1600 万，数据来源 GitHub API/npm）；Prisma AI 基础设施：[github.com/prisma/prisma](https://github.com/prisma/prisma)
- Docker 许可：[订阅条款转载](https://ima.qq.com/wiki/?shareId=ad15ec1f830c0f1c49d4d53319c061b2265106744fd0819c3eafa310cede72a6&mediaId=markdown_7f7207bdf5432c9b145cd578de9e4659_acd7c45f20e472c9a238ea7f529ef85c7354323751169497&action=openDetailDrawer&webFrom=10000171)、[搜狐报道](https://www.sohu.com/a/487109785_115128)、[网易号·调价](https://www.163.com/dy/article/JC6T6PPN0511B8LM.html)
- Odoo：[hivebook.wiki](https://hivebook.wiki/wiki/odoo-open-core-business-apps-suite)、[techultrasolutions.com](https://www.techultrasolutions.com/what-is-odoo)、[oec.sh](https://oec.sh/odoo-pricing/community)、[octurasolutions.com](https://octurasolutions.com/resources/odoo-19-community-to-enterprise-migration-features-licensing-and-upgrade-guide)
- ERPNext：[erp-information.com](http://www.erp-information.com/erpnext-erp-guide)、[hivebook.wiki](https://www.hivebook.wiki/wiki/erpnext-open-source-erp-on-the-frappe-framework)、[selfhost.directory](https://selfhost.directory/project/erpnext)
- 开源 MES 横评与自研/二开对比：[搜狐·MES 横评](https://www.sohu.com/a/1055842107_121743674)、[mdcplus.fi](https://mdcplus.fi/blog/dingji-mianfei-mes-xitong-shengchan-zhixing)、[简道云博客](https://www.jiandaoyun.com/nblog/128472/)
