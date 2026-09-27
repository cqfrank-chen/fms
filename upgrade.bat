@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ============================================================
REM  工厂管理系统 · 一键升级脚本（I02）
REM  作用：升级前自动备份 → 重建镜像 → 滚动重启 → 校验应用健康
REM  说明：数据库数据卷不受影响；启动时自动执行迁移
REM ============================================================
cd /d "%~dp0"
echo.
echo  ============================================
echo    工厂管理系统 FMS · 一键升级
echo  ============================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未找到 Docker，请先安装并启动 Docker Desktop。
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo  [错误] Docker 服务未运行，请先启动 Docker Desktop。
  pause
  exit /b 1
)

echo  [1/4] 升级前自动备份...
if not exist "backups" mkdir "backups"
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%i"
docker exec fms-postgres pg_dump -U fms -d fms -F c -f /tmp/fms_upgrade.dump >nul 2>nul
if errorlevel 1 (
  echo  [警告] 备份失败（数据库容器名是否为 fms-postgres？）——可先运行 backup.bat 手动备份。
) else (
  docker cp fms-postgres:/tmp/fms_upgrade.dump "backups\fms_upgrade_!STAMP!.dump" >nul
  docker exec fms-postgres rm -f /tmp/fms_upgrade.dump
  echo        已备份：backups\fms_upgrade_!STAMP!.dump
)

echo  [2/4] 重新构建镜像...
REM ---- 记录构建提交号（设置页「系统更新」据此比对 GitHub 版本）----
set "SHA="
if exist "..\REVISION.txt" for /f "tokens=3" %%a in ('findstr /b "构建提交" "..\REVISION.txt" 2^>nul') do set "SHA=%%a"
if not defined SHA for /f "delims=" %%a in ('git rev-parse HEAD 2^>nul') do set "SHA=%%a"
if not defined SHA set "SHA=unknown"
powershell -NoProfile -Command "$f='.env'; $l=@(); if (Test-Path $f) { $l=@(Get-Content $f | Where-Object { $_ -notmatch '^FMS_BUILD_SHA=' }) }; $l+='FMS_BUILD_SHA=%SHA%'; Set-Content -Path $f -Value $l -Encoding UTF8"
echo        构建提交：%SHA%
docker compose build
if errorlevel 1 (
  echo  [错误] 构建失败。已保留升级前备份，可回滚旧版本代码后重试。
  pause
  exit /b 1
)

echo  [3/4] 重启服务（数据卷保留）...
docker compose up -d
if errorlevel 1 (
  echo  [错误] 服务启动失败，请查看：docker compose logs app
  pause
  exit /b 1
)

echo  [4/4] 校验应用健康与数据库迁移...
set "PORT=80"
for /f "tokens=1,* delims==" %%a in ('findstr /b "HTTP_PORT=" .env 2^>nul') do set "PORT=%%b"
set /a tries=0
:healthloop
ping -n 4 127.0.0.1 >nul
set /a tries+=1
curl -fsS "http://localhost:!PORT!/api/health" >nul 2>nul
if errorlevel 1 (
  if !tries! LSS 20 goto healthloop
  echo  [警告] 应用未在预期时间内就绪。请检查日志：docker compose logs app
  echo        如需回滚：用升级前备份 backups\fms_upgrade_!STAMP!.dump 恢复，并切回旧版代码。
) else (
  echo        应用已就绪（/api/health 正常）
)
echo.
docker compose ps
echo.
echo  ▸ 升级完成。访问：http://localhost:!PORT!/
echo.
pause
endlocal
