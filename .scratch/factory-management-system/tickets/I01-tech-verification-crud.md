# I01 · 技术验证票：最小全栈 CRUD

Type: task（tracer-bullet 第一票）
Status: open
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

- [ ] 浏览器能完成：新增一条 → 列表显示 → 编辑 → 删除
- [ ] 类型贯通验证：改一个字段，前后端编译器同时约束
- [ ] docker compose up 本地可起全栈
- [ ] 开发经验记录（选型落地是否有坑）折进后续票据

## Ref

- ADR-0001（技术栈定版）
- spec.md §2
