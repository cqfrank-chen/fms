@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  工厂管理系统 · 一键升级脚本（I02 雏形）
REM  作用：重新构建镜像并滚动重启（数据库数据卷不受影响）
REM  时机：拿到新版代码包后运行；日常备份见 backup 约定
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

echo  [1/3] 重新构建镜像...
docker compose build
if errorlevel 1 (
  echo  [错误] 构建失败。
  pause
  exit /b 1
)

echo  [2/3] 重启服务（数据卷保留）...
docker compose up -d
if errorlevel 1 (
  echo  [错误] 服务启动失败。
  pause
  exit /b 1
)

echo  [3/3] 服务状态：
docker compose ps
echo.
echo  ▸ 升级完成。启动时自动执行数据库迁移，请勿中途断电。
echo.
pause
endlocal
