@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ============================================================
REM  工厂管理系统 FMS · 数据备份脚本
REM  作用：pg_dump 全库备份到 backups\ 目录，自动保留最近 14 份
REM  用法：双击运行；或加入 Windows 计划任务每日自动执行
REM  每周异地：把 backups\ 里最新一份拷到移动硬盘（双备份约定）
REM ============================================================
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未找到 Docker，请确认 Docker Desktop 已启动。
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo  [错误] Docker 引擎未运行，请先启动 Docker Desktop。
  pause
  exit /b 1
)

if not exist "backups" mkdir "backups"

for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%i"
set "OUT=backups\fms_%STAMP%.dump"

echo  [1/3] 执行 pg_dump 备份...
docker exec fms-postgres pg_dump -U fms -d fms -F c -f /tmp/fms_backup.dump
if errorlevel 1 (
  echo  [错误] 备份失败（数据库容器名是否为 fms-postgres？）。
  pause
  exit /b 1
)
docker cp fms-postgres:/tmp/fms_backup.dump "%OUT%" >nul
if errorlevel 1 (
  echo  [错误] 拷贝备份文件失败。
  pause
  exit /b 1
)
docker exec fms-postgres rm -f /tmp/fms_backup.dump

echo  [2/3] 清理旧备份（保留最近 14 份）...
set /a keep=0
for /f "delims=" %%f in ('dir /b /o-d backups\fms_*.dump 2^>nul') do (
  set /a keep+=1
  if !keep! GTR 14 del "backups\%%f"
)

echo  [3/3] 完成。当前备份：
dir /b /o-d backups\fms_*.dump 2>nul
echo.
echo  ▸ 备份文件：%OUT%
echo  ▸ 建议：每周把 backups\ 最新一份拷贝到移动硬盘异地保存
echo.
pause
endlocal
