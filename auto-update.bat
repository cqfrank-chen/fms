@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  工厂管理系统 FMS · 自动更新（宿主代理）
REM  用法：
REM    auto-update.bat install      注册计划任务（每 5 分钟检查一次更新请求）
REM    auto-update.bat run          立即执行一次（有请求才更新）
REM    auto-update.bat force        立即执行一次（无请求也重建，用于手动升级）
REM    auto-update.bat status       查看代理状态与最近结果
REM    auto-update.bat uninstall    移除计划任务
REM ============================================================
set "PS1=%~dp0deploy\fms-updater.ps1"
set "TASK=FMS Auto Update"
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=status"

if /i "%ACTION%"=="status" (
  if exist "%~dp0updates\agent.status" (
    type "%~dp0updates\agent.status"
  ) else (
    echo  尚未运行过（无 updates\agent.status）。可执行：auto-update.bat run
  )
  echo.
  echo  计划任务状态：
  schtasks /Query /TN "%TASK%" 2>nul | findstr /i "%TASK%" || echo    未安装（执行 auto-update.bat install 安装）
  if exist "%~dp0updates\apply.request" (echo. & echo  存在待处理更新请求： & type "%~dp0updates\apply.request")
  pause & exit /b 0
)

REM ---- 计划任务安装/卸载需要管理员 ----
net session >nul 2>nul
if errorlevel 1 (
  echo  [信息] 该操作需要管理员权限，正在请求提权...
  powershell -NoProfile -Command "if ('%*' -ne '') { Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs } else { Start-Process -FilePath '%~f0' -Verb RunAs }"
  exit /b
)

if /i "%ACTION%"=="install" (
  schtasks /Create /TN "%TASK%" /SC MINUTE /MO 5 /RL HIGHEST /F ^
    /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"%PS1%\"" >nul
  if errorlevel 1 (echo  [错误] 注册计划任务失败。 & pause & exit /b 1)
  echo  已安装计划任务「%TASK%」：每 5 分钟检查一次更新请求。
  echo  立即执行一次以生成状态文件...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
  pause & exit /b 0
)

if /i "%ACTION%"=="uninstall" (
  schtasks /Delete /TN "%TASK%" /F >nul 2>nul
  echo  已移除计划任务「%TASK%」。
  pause & exit /b 0
)

if /i "%ACTION%"=="force" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Force
  pause & exit /b %errorlevel%
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
echo.
echo  提示：安装为计划任务后即可在设置页「系统更新」一键更新：auto-update.bat install
pause
endlocal
