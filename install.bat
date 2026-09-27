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
REM ---- 离线镜像：包内 docker\images\*.tar 存在则先 docker load（全程不联网）----
set "IMGDIR="
if exist "..\docker\images\*.tar" set "IMGDIR=..\docker\images"
if not defined IMGDIR if exist "docker\images\*.tar" set "IMGDIR=docker\images"
if defined IMGDIR (
  echo        检测到离线镜像，正在载入（可能需要几分钟）...
  for %%F in ("!IMGDIR!\*.tar") do (
    echo          载入 %%~nxF ...
    docker load -i "%%F"
  )
)

REM ---- 记录构建提交号（设置页「系统更新」据此比对 GitHub 版本）----
set "SHA="
if exist "..\REVISION.txt" for /f "tokens=3" %%a in ('findstr /b "构建提交" "..\REVISION.txt" 2^>nul') do set "SHA=%%a"
if not defined SHA for /f "delims=" %%a in ('git rev-parse HEAD 2^>nul') do set "SHA=%%a"
if not defined SHA set "SHA=unknown"
powershell -NoProfile -Command "$f='.env'; $l=@(); if (Test-Path $f) { $l=@(Get-Content $f | Where-Object { $_ -notmatch '^FMS_BUILD_SHA=' }) }; $l+='FMS_BUILD_SHA=%SHA%'; Set-Content -Path $f -Value $l -Encoding UTF8"
echo        构建提交：%SHA%
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
REM ---- 7. 本地域名绑定（可选，默认绑定）----
echo.
echo  [7/7] 绑定本地域名（http://fms.local，免记 IP）...
if exist "deploy\set-domain.ps1" (
  set "BIND=Y"
  set /p "BIND=     是否绑定 http://fms.local 到本机？(Y/n，直接回车=是) "
  if /i "!BIND!"=="N" (
    echo        已跳过；日后可双击 set-domain.bat 绑定。
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "deploy\set-domain.ps1"
    if errorlevel 1 echo        [警告] 绑定失败（可能非管理员），可双击 set-domain.bat 手动绑定。
  )
) else (
  echo        未找到域名脚本，跳过（可稍后双击 set-domain.bat）。
)

echo.
echo  ============================================
echo    安装完成！服务状态：
echo  ============================================
docker compose ps
echo.
echo  ▸ 本机访问：  http://fms.local   （已绑定域名）
echo  ▸ 厂内访问：  http://fms.local   （其它电脑运行 set-domain.bat -Ip 服务器IP）
echo  ▸ 备用地址：  http://localhost / http://本机局域网IP
echo  ▸ 查看 IP：   在 cmd 运行 ipconfig 查 IPv4 地址
echo.
pause
endlocal
