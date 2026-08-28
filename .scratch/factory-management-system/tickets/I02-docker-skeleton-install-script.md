# I02 · 骨架：Docker Compose + 一键安装脚本雏形

Type: task
Status: open
Phase: ① 地基
Blocked by: I01
Spec: spec.md §2, §11

## Objective

Docker Compose 骨架（nginx + app + postgres，postgres 不暴露端口）跑起来 + 一键安装脚本雏形（能起环境）。

## Scope

- docker-compose.yml 正式版：nginx 反代（80，静态前端 + API 转发）、app（NestJS）、postgres:18（仅 compose 内网）
- .env 配置化
- 安装脚本雏形（Windows .bat：装 Docker Desktop + 拉镜像 + 起服务）
- 首页可访问（健康检查）

## Acceptance

- [ ] docker compose up 成功，首页可访问
- [ ] postgres 不暴露宿主机端口
- [ ] 安装脚本能在干净环境起系统

## Ref

- ADR-0001
- spec.md §2（部署）、§11（阶段①验收）
