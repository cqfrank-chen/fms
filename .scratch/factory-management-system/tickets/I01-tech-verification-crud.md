# I01 · 技术验证票：最小全栈 CRUD

Type: task（tracer-bullet 第一票）
Status: resolved ✅ 2026-09-03
Claimed: 2026-08-28
Phase: ① 地基
Blocked by: —
Spec: spec.md §2

## Objective

跑通 React 19 + AntD 6 / NestJS 11 / PostgreSQL 18 / Drizzle 的最小全栈链路（一个简单 CRUD），验证技术选型能落地、代理能开发，再开始正式功能。

## Scope

- 脚手架：Ant Design Pro V6（前端）+ NestJS 11（后端）+ Drizzle（PG18）
- 一个演示实体（如「测试产品」）：列表 / 新增 / 编辑 / 删除
- 前后端类型贯通：Drizzle schema → NestJS DTO → 前端接口类型单一来源
- docker-compose.yml 雏形（nginx + app + postgres）

## Acceptance

- [x] 浏览器能完成：新增一条 → 列表显示 → 编辑 → 删除
- [x] 类型贯通验证：改一个字段，前后端编译器同时约束
- [x] docker compose up 本地可起全栈
- [x] 开发经验记录（选型落地是否有坑）折进后续票据

## 验收记录（2026-09-03）

全链路 docker compose 跑通（postgres healthy → app → nginx:80）：

| 验收项 | 结果 |
|---|---|
| GET /api/test-products（列表） | ✅ 200 [] |
| POST 新增（中文+规格） | ✅ 201 返回数据 |
| PATCH 编辑 id | ✅ 200 字段更新 |
| DELETE 删除 | ✅ 200 |
| class-validator 拦截（空 name） | ✅ 400 中文错误信息 |
| 前端页面 http://localhost | ✅ 200 HTML+JS bundle |
| PG18 卷挂载点修正 | ✅ /var/lib/postgresql（18+ 要求，见经验） |

## 开发经验（折进后续票据）

1. **PG18 镜像卷挂载变更**：18+ 必须挂 `/var/lib/postgresql`（内部按主版本子目录），挂 `/var/lib/postgresql/data` 直接报 "unused mount/volume" 启动失败
2. **tsconfig 必须显式 include**：无 include 时 tsc 会把根目录 drizzle.config.ts 一并编译，dist 结构变成 `dist/src/**` 导致 `node dist/main` 挂；`include: ["src/**/*.ts"]` 后输出扁平 dist
3. **NestJS 全局前缀**：`app.setGlobalPrefix('api')` 统一 /api，nginx 反代透传即可，避免每 controller 手写前缀
4. **ValidationPipe whitelist 陷阱**：whitelist:true 会剥掉 DTO 里没有 class-validator 装饰器的字段 → 裸 DTO 全字段被剥成空对象（insert 报 23502 NOT NULL）。**每个 DTO 字段必须加 @IsString/@IsOptional 等装饰器**
5. **启动自动建表**：main.ts bootstrap 里先 `await runMigrations()`（drizzle migrator 读 drizzle/*.sql，幂等），生产镜像需 COPY drizzle 目录
6. **npm safe-delete Windows 间歇失败**：EPERM/trash 错误多为 npm 10.7+ Windows 兼容问题，重试即过
7. **docker hub 直连慢**：已配 3 个国内镜像加速源（docker.1ms.run/xuanyuan.me/daocloud），postgres:18 拉取约 12 分钟

## Ref

- ADR-0001（技术栈定版）
- spec.md §2
