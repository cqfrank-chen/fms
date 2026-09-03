# 工厂管理系统 FMS

单厂自有工厂自用的生产管理系统：订单 → 计划单、排期、仓储、账目统计四域一体化（含 AI 接入）。
面向厂内单机部署：**Windows + Docker Desktop**，浏览器通过厂内 IP 访问，免登录。

> 术语以 `CONTEXT.md` 为准；技术决策见 `docs/adr/`；可建规格见 `.scratch/factory-management-system/spec.md`。
> 实施票据按阶段推进：①地基 → ②订单线 → ③仓储账目线 → ④排期AI线（见 `spec.md §11`）。

---

## 一、系统组成

| 组件 | 技术 | 端口 | 说明 |
|---|---|---|---|
| nginx | nginx:alpine | **80**（可用 `.env` 改） | 托管前端静态页 + `/api` 反向代理 |
| app | NestJS 11（TypeScript） | 3000（仅内网） | REST API；启动时自动执行数据库迁移 |
| postgres | PostgreSQL 18 | **不暴露** | 数据存 Docker 卷 `pgdata`，双备份见下 |

浏览器访问 `http://<厂内IP>` 即可使用，无登录。

---

## 二、首次安装（一键）

1. 安装 **Docker Desktop**（https://www.docker.com/products/docker-desktop/）并启动；
2. 双击运行根目录 **`install.bat`**；
3. 脚本自动：检查 Docker → 生成 `.env`（默认账号 fms/fms）→ 构建镜像 → 启动服务 → 等待数据库就绪；
4. 浏览器打开 `http://localhost`（本机）或 `http://<本机局域网IP>`（厂内其它电脑）。

> 首次构建需拉取镜像（已配国内加速源），约 5–15 分钟。镜像已有则只需数十秒。

---

## 三、升级 / 重启

- **升级到新版本**：拿到新代码包后双击 **`upgrade.bat`**（重新构建镜像并重启，数据卷保留，启动时自动迁移数据库）。
- **手动**：`docker compose up -d --build`
- **看日志**：`docker compose logs -f app`
- **停机**：`docker compose down`（数据仍在卷里；`down -v` 会清空数据，慎用）

---

## 四、数据备份（双备份约定）

| 频率 | 内容 | 方式 |
|---|---|---|
| 每日 | 数据库全量 | 备份脚本执行 `docker exec fms-postgres pg_dump -U fms -d fms` 到本地备份目录 |
| 每周 | 整库 | 移动硬盘拷贝（连 Docker 卷或 pg_dump 文件一并） |

> 备份脚本为后续票据交付项；切换真实数据前必须先把备份跑起来。

---

## 五、目录速览

```
├── install.bat / upgrade.bat   一键安装 / 升级脚本
├── .env.example                 环境变量模板（复制为 .env）
├── docker-compose.yml           服务编排（nginx + app + postgres）
├── deploy/
│   ├── Dockerfile               前端构建 + nginx 镜像
│   └── nginx.conf               静态页 + /api 反向代理
├── apps/
│   ├── api/                     NestJS 11 后端（src/，Drizzle schema 在 src/db/schema.ts）
│   └── web/                     React 19 + AntD 6 前端（Vite）
├── docs/adr/                    架构决策记录
└── .scratch/factory-management-system/   决策地图、规格、实施票据
```

---

## 六、开发模式（改代码）

前置：Node 22 + 本地 PostgreSQL（或放开 compose 里 postgres 的 5432 端口注释）。

```bash
# 后端（热重载）
cd apps/api && npm install && npm run start:dev

# 前端（Vite 代理 /api → localhost:3000，见 vite.config.ts）
cd apps/web && npm install && npm run dev
```

数据库结构改动流程：改 `apps/api/src/db/schema.ts` → `npx drizzle-kit generate`（生成 SQL）→ 重启 app（自动迁移）。
