@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ============================================================
REM  工厂管理系统 FMS · 傻瓜式一键安装（含 Docker Desktop）
REM  用法：双击本文件即可（自动请求管理员权限）
REM  流程：提权 → 装/启 Docker Desktop → 生成 .env → 构建 →
REM        启动服务 → 显示访问地址
REM  离线：把 "Docker Desktop Installer.exe" 放进本目录 docker\
REM        子目录即可免下载（约 500MB）
REM  排障：set FMS_DRYRUN=1 后运行 = 只打印不执行
REM ============================================================

REM ---- 0. 管理员提权（非管理员时自动 UAC 拉起自己）----
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo  正在请求管理员权限，请在弹出窗口点「是」...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

REM ---- 定位系统目录（发布包 system\ 子目录 或 直接仓库根）----
set "ROOT=%~dp0"
if exist "%ROOT%system\docker-compose.yml" (
  set "SYS=%ROOT%system"
) else (
  set "SYS=%ROOT%"
)
set "DOCKER_BIN=C:\Program Files\Docker\Docker\resources\bin"
set "DOCKER_EXE=C:\Program Files\Docker\Docker\Docker Desktop.exe"
set "DD_URL=https://desktop.docker.com/win/main/amd64/Docker%%20Desktop%%20Installer.exe"
set "DRYRUN=0"
if defined FMS_DRYRUN set "DRYRUN=1"
set "NEED_REBOOT=0"

cd /d "%SYS%"
echo.
echo  ============================================
echo    工厂管理系统 FMS · 傻瓜式一键安装
echo  ============================================
echo.
echo  系统目录：%SYS%
if !DRYRUN!==1 echo  [DRY-RUN] 演练模式：只打印将执行的步骤，不实际安装
echo.

REM ---- 1. Docker 引擎是否已可用 ----
REM ---- 0. 应用国内 Docker 镜像源（daemon.json）----
if exist "%ROOT%docker\daemon.json" (
  if not exist "%USERPROFILE%\.docker" mkdir "%USERPROFILE%\.docker" >nul 2>nul
  copy /y "%ROOT%docker\daemon.json" "%USERPROFILE%\.docker\daemon.json" >nul
  echo  [0/8] 已配置 Docker 国内镜像源（daemon.json）
  docker info >nul 2>nul
  if not errorlevel 1 (
    echo        检测到 Docker 正在运行：重启以让镜像源生效（约 30 秒）...
    docker desktop restart >nul 2>nul
    if errorlevel 1 (
      taskkill /f /im "Docker Desktop.exe" >nul 2>nul
      ping -n 4 127.0.0.1 >nul
      if exist "%DOCKER_EXE%" start "" "%DOCKER_EXE%"
    )
  )
) else (
  echo  [0/8] 未找到 docker\daemon.json，跳过镜像源配置（可能拉不动镜像）
)

echo  [1/8] 检查 Docker 引擎...
set "PATH=%PATH%;%DOCKER_BIN%"
docker info >nul 2>nul
if errorlevel 1 goto need_docker
echo        Docker 已在运行，跳过安装步骤
goto prep_env

REM ================= 需要安装/启动 Docker =================
:need_docker
echo        Docker 未运行或未安装，进入准备流程
echo.

REM ---- 2. Docker Desktop 是否已安装 ----
echo  [2/8] 检查 Docker Desktop 安装...
if exist "%DOCKER_EXE%" (
  echo        已安装（未启动）
  goto start_docker
)
echo        未安装 → 准备安装 Docker Desktop

REM ---- 2a. 定位/下载安装器 ----
set "INSTALLER=%ROOT%docker\Docker Desktop Installer.exe"
  if not exist "%INSTALLER%" (
    echo  [下载] 本目录无安装器，尝试联网下载（约 630MB）...
    if not exist "%ROOT%docker" mkdir "%ROOT%docker"
    if !DRYRUN!==1 (
      echo  [DRY] 将执行: curl → BITS → Invoke-WebRequest 依次尝试下载
    ) else (
      curl -L -o "%INSTALLER%" "%DD_URL%" --fail --retry 2 --progress-bar 2>nul
      if not exist "%INSTALLER%" powershell -NoProfile -Command "try { Start-BitsTransfer -Source '%DD_URL%' -Destination '%INSTALLER%' -ErrorAction Stop } catch { exit 1 }"
      if not exist "%INSTALLER%" powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%DD_URL%' -OutFile '%INSTALLER%' -TimeoutSec 1800 } catch { exit 1 }"
      if exist "%INSTALLER%" for %%F in ("%INSTALLER%") do set "ISIZE=%%~zF"
      if exist "%INSTALLER%" if !ISIZE! LSS 300000000 (
        echo  [警告] 下载文件仅 !ISIZE! 字节，疑似不完整，已删除。
        del /q "%INSTALLER%" 2>nul
      )
      if not exist "%INSTALLER%" (
        echo  [错误] Docker Desktop 下载失败（desktop.docker.com 连接被重置/超时，国内网络常见）。
        echo         用能上外网的电脑或手机热点下载后，把安装器放到：
        echo           %INSTALLER%
        echo         再重新双击 setup.bat（有本地安装器就不会联网下载）。
        pause
        exit /b 1
      )
      echo        下载完成
    )
  ) else (
    echo        使用本地安装器：%INSTALLER%（无需联网）
  )

REM ---- 2b. 启用 WSL2 所需 Windows 功能（幂等）----
echo  [3/8] 启用 WSL2 所需 Windows 功能（子系统 Linux / 虚拟机平台）...
if !DRYRUN!==1 (
  echo  [DRY] 将执行: Enable-WindowsOptionalFeature Microsoft-Windows-Subsystem-Linux,VirtualMachinePlatform
) else (
  powershell -NoProfile -Command "$r = Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux,VirtualMachinePlatform -All -NoRestart -ErrorAction SilentlyContinue; if ($r -and $r.RestartNeeded) { exit 7 } else { exit 0 }"
  if errorlevel 7 set "NEED_REBOOT=1"
REM ---- WSL2 内核更新包（国内常拉不动官方源，包内自带则离线安装）----
if exist "%ROOT%docker\wsl_update_x64.msi" (
  echo        安装 WSL2 内核更新包（离线）...
  msiexec /i "%ROOT%docker\wsl_update_x64.msi" /qn /norestart
)
)

REM ---- 2c. 静默安装 Docker Desktop ----
echo  [4/8] 静默安装 Docker Desktop（约 2-5 分钟，请耐心）...
if !DRYRUN!==1 (
  echo  [DRY] 将执行: "%INSTALLER%" install --quiet --accept-license --backend=wsl-2
) else (
  "%INSTALLER%" install --quiet --accept-license --backend=wsl-2
  if errorlevel 1 (
    echo  [错误] Docker Desktop 安装失败（错误码 !errorlevel!）。
    echo         请确认系统已开启虚拟化（BIOS 中启用 VT-x/AMD-V）后重试。
    pause
    exit /b 1
  )
)

REM ---- 2d. 是否需要重启 ----
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending" >nul 2>nul
if errorlevel 1 reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\PendingFileRenameOperations" >nul 2>nul
if not errorlevel 1 set "NEED_REBOOT=1"
if "!NEED_REBOOT!"=="1" (
  echo.
  echo  ============================================================
  echo    系统需要【重启一次】才能完成 WSL2 环境配置。
  echo    请重启电脑后，再双击运行本文件一次即可（会自动续装）。
  echo  ============================================================
  pause
  exit /b 2
)

REM ---- 2e. 启动 Docker Desktop 并等待引擎就绪 ----
:start_docker
echo  [5/8] 启动 Docker Desktop 并等待引擎就绪（首次约 1-3 分钟）...
if !DRYRUN!==1 (
  echo  [DRY] 将执行: 启动 Docker Desktop 并轮询 docker info（最长 10 分钟）
  goto prep_env
)
if exist "%DOCKER_EXE%" start "" "%DOCKER_EXE%"
call :wait_engine
if errorlevel 1 (
  echo  [错误] Docker 引擎长时间未就绪。请打开 Docker Desktop 查看状态后重试。
  pause
  exit /b 1
)
echo        Docker 引擎就绪

REM ================= 系统安装 =================
:prep_env
echo.
echo  [6/8] 配置环境变量...
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo        已生成 .env（默认配置）。如需改端口/AI key，编辑 .env 后重跑本脚本
) else (
  echo        .env 已存在，沿用当前配置
)
echo.

echo  [7/8] 构建服务镜像并启动（首次 5-15 分钟，请耐心）...
if !DRYRUN!==1 (
  echo  [DRY] 将执行: REM ---- 记录构建提交号（设置页「系统更新」据此比对 GitHub 版本）----
set "SHA="
if exist "..\REVISION.txt" for /f "tokens=3" %%a in ('findstr /b "构建提交" "..\REVISION.txt" 2^>nul') do set "SHA=%%a"
if not defined SHA for /f "delims=" %%a in ('git rev-parse HEAD 2^>nul') do set "SHA=%%a"
if not defined SHA set "SHA=unknown"
powershell -NoProfile -Command "$f='.env'; $l=@(); if (Test-Path $f) { $l=@(Get-Content $f | Where-Object { $_ -notmatch '^FMS_BUILD_SHA=' }) }; $l+='FMS_BUILD_SHA=%SHA%'; Set-Content -Path $f -Value $l -Encoding UTF8"
echo        构建提交：%SHA%
docker compose build  然后  docker compose up -d
  echo  [DRY] 演练结束（未实际安装）
  pause
  exit /b 0
)
docker compose build
if errorlevel 1 (
  echo  [错误] 镜像构建失败，请检查网络后重试。
  pause
  exit /b 1
)
docker compose up -d
if errorlevel 1 (
  echo  [错误] 服务启动失败。
  pause
  exit /b 1
)
call :wait_db

echo.
echo  [8/8] 绑定本地域名（http://fms.local 免记 IP）...
if exist "%SYS%\deploy\set-domain.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SYS%\deploy\set-domain.ps1"
  if errorlevel 1 echo  [警告] 域名绑定失败，可稍后双击 system\set-domain.bat 手动绑定
) else (
  echo        未找到域名脚本，跳过（可稍后双击 system\set-domain.bat）
)

echo.
echo  ============================================
echo    安装完成！服务状态：
echo  ============================================
docker compose ps
echo.
echo  ▸ 本机访问：  http://fms.local   （已绑定域名）
echo  ▸ 厂内访问：  http://fms.local   （其它电脑运行 system\set-domain.bat -Ip 服务器IP）
echo  ▸ 备用地址：  http://localhost / http://本机局域网IP
echo  ▸ 查看 IP：   ipconfig 查 IPv4；或 设置→网络→属性
echo.
echo  ▸ AI 功能：   默认演示模式。编辑 .env 填入 AI_API_KEY 后重跑本脚本即切真实模型
echo  ▸ 数据备份：  双击 system\backup.bat 手动备份；建议加入计划任务每日自动执行
echo  ▸ 升级系统：  拿到新版 system\ 后运行 system\upgrade.bat
echo.
pause
exit /b 0

REM ================= 子程序 =================
:wait_engine
set /a tries=0
:wait_engine_loop
ping -n 6 127.0.0.1 >nul
set /a tries+=1
set /a mod=!tries! %% 20
if !mod!==0 echo        ...仍在等待引擎（已 !tries!0 秒）...
docker info >nul 2>nul
if errorlevel 1 (
  if !tries! LSS 120 goto wait_engine_loop
  exit /b 1
)
exit /b 0

:wait_db
echo  等待数据库就绪...
set /a tries=0
:wait_db_loop
ping -n 4 127.0.0.1 >nul
set /a tries+=1
docker exec fms-postgres pg_isready -U fms >nul 2>nul
if errorlevel 1 (
  if !tries! LSS 20 goto wait_db_loop
  echo  [警告] 数据库未在预期时间内就绪，请查看: docker compose logs postgres
) else (
  echo        数据库已就绪
)
exit /b 0
