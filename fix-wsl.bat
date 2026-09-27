@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ============================================================
REM  工厂管理系统 FMS · WSL2 修复
REM  用于 Docker Desktop 报「WSL is not installed / WSL 2 installation is incomplete」
REM  用法：fix-wsl.bat          修复（自动提权；装完请重启一次）
REM       fix-wsl.bat /check   只检查状态（不提权）
REM       fix-wsl.bat /hyperv  改用 Hyper-V 后端重装 Docker（WSL 实在不行时的替代）
REM ============================================================
cd /d "%~dp0"
if /i "%~1"=="/check" goto :check
if /i "%~1"=="/hyperv" goto :hyperv
net session >nul 2>nul
if errorlevel 1 (
  echo  [信息] 修改系统功能需要管理员权限，正在请求提权...
  powershell -NoProfile -Command "if ('%*'.Trim() -ne '') { Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs } else { Start-Process -FilePath '%~f0' -Verb RunAs }"
  exit /b
)

:check
echo  ============ WSL2 状态检查 ============
echo  [1] wsl --status :
wsl --status 2>&1
echo.
echo  [2] 内核文件（msi 装完才有）：
if exist "%SystemRoot%\System32\lxss\tools\kernel" ( echo      存在 ) else ( echo      不存在 )
echo.
echo  [3] Windows 功能状态（Enabled 才可用）：
net session >nul 2>nul
if errorlevel 1 echo      （读取功能状态需管理员权限：请直接运行 fix-wsl.bat 修复模式）
dism /online /get-featureinfo /featurename:Microsoft-Windows-Subsystem-Linux 2>nul | findstr /i "State"
dism /online /get-featureinfo /featurename:VirtualMachinePlatform 2>nul | findstr /i "State"
echo.
if /i "%~1"=="/check" ( echo  仅检查模式结束。 & pause & exit /b 0 )

echo  [4] 启用所需 Windows 功能（幂等，不影响已启用）...
dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
echo.
echo  [5] 安装 WSL2 内核更新包（离线）...
if exist "docker\wsl_update_x64.msi" ( msiexec /i "docker\wsl_update_x64.msi" /qn /norestart & echo      已用 docker\wsl_update_x64.msi ) else if exist "..\docker\wsl_update_x64.msi" ( msiexec /i "..\docker\wsl_update_x64.msi" /qn /norestart & echo      已用 ..\docker\wsl_update_x64.msi ) else ( echo      [警告] 未找到 wsl_update_x64.msi，老版 Win10 必须手动补装 )
echo.
echo  [6] 设置 WSL 默认版本为 2...
wsl --set-default-version 2 2>&1
echo.
echo  ============================================================
echo   [重要] 请【重启电脑】，然后：
echo     1) 再次运行 fix-wsl.bat /check 确认 wsl --status 正常
echo     2) 启动 Docker Desktop（开始菜单），等托盘图标变绿
echo     3) 若 Docker 仍报 WSL 错误，改用 Hyper-V 后端：fix-wsl.bat /hyperv
echo  ============================================================
pause
endlocal
exit /b 0

:hyperv
net session >nul 2>nul
if errorlevel 1 (
  echo  [信息] 需要管理员权限，正在请求提权...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '/hyperv' -Verb RunAs"
  exit /b
)
echo  ============ 改用 Hyper-V 后端重装 Docker（无需 WSL2）============
set "INS="
if exist "docker\Docker Desktop Installer.exe" set "INS=docker\Docker Desktop Installer.exe"
if not defined INS if exist "..\docker\Docker Desktop Installer.exe" set "INS=..\docker\Docker Desktop Installer.exe"
if not defined INS ( echo  [错误] 未找到 Docker Desktop Installer.exe & pause & exit /b 1 )
echo  使用安装器：!INS!
echo  前提：主板已开启虚拟化，且 Windows 10 专业版/企业版（家庭版不支持 Hyper-V）
set "OK="
set /p "OK=  确认用 Hyper-V 后端重装？输入 YES 继续: "
if /i not "!OK!"=="YES" ( echo  已取消 & pause & exit /b 0 )
"!INS!" install --quiet --accept-license --backend=hyper-v
echo  完成，请重启后启动 Docker Desktop。
pause
endlocal
