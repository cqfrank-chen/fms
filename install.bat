@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ============================================================
REM  工厂管理系统 · 一键安装脚本（I02 雏形）
REM  作用：检查 Docker Desktop → 生成 .env → 构建并启动服务
REM  要求：Windows + Docker Desktop 已安装并启动
REM ============================================================
cd /d "%~dp0"
echo.
echo  ============================================
echo    工厂管理系统 FMS · 一键安装
echo  ============================================
echo.

REM ---- 1. 检查 Docker Desktop ----
where docker >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未找到 Docker，请先安装 Docker Desktop：
  echo         https://www.docker.com/products/docker-desktop/
  echo  安装完成后启动 Docker Desktop，再重新运行本脚本。
  pause
  exit /b 1
)

echo  [1/5] 检查 Docker 服务...
docker info >nul 2>nul
if errorlevel 1 (
  echo  [错误] Docker 服务未运行，请先启动 Docker Desktop。
  pause
  exit /b 1
)
echo        Docker 运行正常
echo.

REM ---- 2. 生成 .env（不存在时从模板复制）----
echo  [2/5] 配置环境变量...
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo        已从 .env.example 生成 .env（默认 fms/fms，可自行修改）
) else (
  echo        .env 已存在，沿用当前配置
)
echo.

REM ---- 3. 构建镜像（首次约 5-15 分钟，视网络）----
echo  [3/5] 构建服务镜像（首次较慢，请耐心等待）...
docker compose build
if errorlevel 1 (
  echo  [错误] 镜像构建失败，请检查网络后重试。
  pause
  exit /b 1
)
echo.

REM ---- 4. 启动服务 ----
echo  [4/5] 启动服务...
docker compose up -d
if errorlevel 1 (
  echo  [错误] 服务启动失败。
  pause
  exit /b 1
)
echo.

REM ---- 5. 等待就绪并显示状态 ----
echo  [5/5] 等待数据库就绪...
set /a tries=0
:waitloop
ping -n 4 127.0.0.1 >nul
set /a tries+=1
docker exec fms-postgres pg_isready -U fms >nul 2>nul
if errorlevel 1 (
  if !tries! LSS 15 goto waitloop
  echo  [警告] 数据库未在预期时间内就绪，请查看日志：
  echo         docker compose logs postgres
) else (
  echo        数据库已就绪
)

REM ---- 6. 校验应用健康与迁移（只等 DB 就绪并不代表应用可用）----
echo  [6/6] 校验应用健康与数据库迁移...
set "PORT=80"
for /f "tokens=1,* delims==" %%a in ('findstr /b "HTTP_PORT=" .env 2^>nul') do set "PORT=%%b"
set /a atries=0
:appwait
ping -n 4 127.0.0.1 >nul
set /a atries+=1
curl -fsS "http://localhost:!PORT!/api/health" >nul 2>nul
if errorlevel 1 (
  if !atries! LSS 20 goto appwait
  echo  [警告] 应用未在预期时间内就绪，请查看日志：
  echo         docker compose logs app
) else (
  echo        应用已就绪（/api/health 正常）
)
echo.

echo  ============================================
echo    安装完成！服务状态：
echo  ============================================
docker compose ps
echo.
echo  ▸ 本机访问：  http://localhost
echo  ▸ 厂内访问：  http://本机局域网IP（其它电脑用）
echo  ▸ 查看 IP：   在 cmd 运行 ipconfig 查 IPv4 地址
echo.
echo  ▸ 本地域名（推荐，免记 IP）：双击运行 set-domain.bat
echo     本机绑定后即可用 http://fms.local 访问；
echo     其它电脑运行 set-domain.bat -Ip 服务器IP 指向本机；
echo     全厂可用：在路由器/内网 DNS 加 A 记录  fms.local 到服务器 IP。
echo.
pause
endlocal
