@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  工厂管理系统 FMS · 本地域名绑定（fms.local）
REM  用法：双击运行（会请求管理员权限，用于改 hosts）
REM        解除：set-domain.bat /remove
REM ============================================================
net session >nul 2>nul
if errorlevel 1 (
  echo  [信息] 修改 hosts 需要管理员权限，正在请求提权...
  powershell -NoProfile -Command "if ('%*' -ne '') { Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs } else { Start-Process -FilePath '%~f0' -Verb RunAs }"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\set-domain.ps1" %*
if errorlevel 1 (
  echo.
  echo  [提示] 若脚本被策略阻止，可在本目录执行：
  echo         powershell -ExecutionPolicy Bypass -File deploy\set-domain.ps1
)
echo.
pause
endlocal
