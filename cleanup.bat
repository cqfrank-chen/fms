@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ============================================================
REM  工厂管理系统 FMS · 环境清理
REM  双击进入菜单；也可带参数直接执行：
REM    cleanup.bat /app      停服务+删容器+删网络（保留数据库）
REM    cleanup.bat /data     在 /app 基础上删除数据库卷（数据清零）
REM    cleanup.bat /images   清理本地镜像（含测试/残留镜像）
REM    cleanup.bat /all      以上全部 + 更新缓存 + 域名绑定 + 计划任务
REM    cleanup.bat /full     /all + 卸载 Docker Desktop（最彻底）
REM    任意模式追加 /whatif  只打印将执行的操作，不实际执行
REM ============================================================
cd /d "%~dp0"
set "WHATIF=0"
set "MODE=menu"
if /i "%~1"=="/app" set "MODE=app"
if /i "%~1"=="/data" set "MODE=data"
if /i "%~1"=="/images" set "MODE=images"
if /i "%~1"=="/all" set "MODE=all"
if /i "%~1"=="/full" set "MODE=full"
if /i "%~1"=="/whatif" set "WHATIF=1"
if /i "%~2"=="/whatif" set "WHATIF=1"

echo.
echo  ============================================
echo    工厂管理系统 FMS · 环境清理
echo  ============================================
echo   目录：%CD%
if "%WHATIF%"=="1" echo   [预演模式] 只打印，不实际执行
echo.

where docker >nul 2>nul
if errorlevel 1 set "HASDOCKER=0"
if not errorlevel 1 set "HASDOCKER=1"

if /i "%MODE%"=="menu" goto :menu
if /i "%MODE%"=="app" ( call :do_app & goto :done )
if /i "%MODE%"=="data" ( call :do_app & call :do_data & goto :done )
if /i "%MODE%"=="images" ( call :do_images & goto :done )
if /i "%MODE%"=="all" ( call :do_app & call :do_data & call :do_images & call :do_cache & call :do_domain & call :do_task & goto :done )
if /i "%MODE%"=="full" ( call :do_app & call :do_data & call :do_images & call :do_cache & call :do_domain & call :do_task & call :do_docker & goto :done )
goto :menu

:menu
echo   选择清理级别（回车=退出）：
echo     1) 停服务并删容器（保留数据库）        [/app]
echo     2) 1 + 删除数据库卷（数据清零！）        [/data]
echo     3) 清理本地镜像（含测试残留）           [/images]
echo     4) 2 + 3 + 更新缓存 + 域名绑定 + 计划任务 [/all]
echo     5) 4 + 卸载 Docker Desktop             [/full]
echo.
set "CH="
set /p "CH=  输入序号 1-5（直接回车退出）: "
if not defined CH goto :done
if "!CH!"=="1" ( call :do_app & goto :done )
if "!CH!"=="2" ( call :do_app & call :do_data & goto :done )
if "!CH!"=="3" ( call :do_images & goto :done )
if "!CH!"=="4" ( call :do_app & call :do_data & call :do_images & call :do_cache & call :do_domain & call :do_task & goto :done )
if "!CH!"=="5" ( call :do_app & call :do_data & call :do_images & call :do_cache & call :do_domain & call :do_task & call :do_docker & goto :done )
echo   无效输入。
goto :menu

:do_app
echo [1] 停服务并删除容器/网络（数据库卷保留）...
if "%WHATIF%"=="1" ( echo     [预演] docker compose down & exit /b 0 )
if "%HASDOCKER%"=="0" ( echo     [跳过] 未安装 Docker & exit /b 0 )
docker compose down --remove-orphans
exit /b 0

:do_data
echo [2] 删除数据库数据卷（PGDATA 清零，不可恢复）...
if "%WHATIF%"=="1" ( echo     [预演] docker volume rm fms 相关卷（pgdata） & exit /b 0 )
echo     警告：数据库将全部清空！
if "%WHATIF%"=="0" (
  set "OK=" 
  set /p "OK=    确认删除数据卷？输入 YES 继续: "
  if /i "!OK!"=="YES" ( docker volume ls --format "{{.Name}}" | findstr /i "pgdata" >nul && for /f %%V in ('docker volume ls --format "{{.Name}}" ^| findstr /i pgdata') do ( docker volume rm %%V ) ) else ( echo     已取消 )
)
exit /b 0

:do_images
echo [3] 清理本地镜像（应用镜像 + 测试/残留镜像 + 悬挂镜像）...
if "%WHATIF%"=="1" ( echo     [预演] docker rmi fms-app:local fms-nginx:local；清理 fms-*test* 与 空标签镜像 悬挂镜像 & exit /b 0 )
if "%HASDOCKER%"=="0" ( echo     [跳过] 未安装 Docker & exit /b 0 )
docker rmi fms-app:local fms-nginx:local >nul 2>nul
for /f "delims=" %%I in ('docker images --format "{{.Repository}}:{{.Tag}}" ^| findstr /i "fms-.*test fms-highfix" ') do (
  echo     删除 %%I
  docker rmi %%I >nul 2>nul
)
docker image prune -f >nul 2>nul
echo     完成。
exit /b 0

:do_cache
echo [4] 清理更新缓存（下载包/请求/日志）...
if "%WHATIF%"=="1" ( echo     [预演] 清空 updates\*.tar.gz *.zip apply.request agent.log & exit /b 0 )
if exist "updates" ( del /q "updates\*.tar.gz" "updates\*.zip" "updates\apply.request" "updates\agent.log" >nul 2>nul )
echo     完成（agent.status 保留）。
exit /b 0

:do_domain
echo [5] 解除本地域名绑定（fms.local）...
if "%WHATIF%"=="1" ( echo     [预演] set-domain.bat /remove & exit /b 0 )
if exist "set-domain.bat" ( call "set-domain.bat" /remove ) else ( echo     [跳过] 未找到 set-domain.bat )
exit /b 0

:do_task
echo [6] 移除自动更新计划任务...
if "%WHATIF%"=="1" ( echo     [预演] auto-update.bat uninstall & exit /b 0 )
if exist "auto-update.bat" ( call "auto-update.bat" uninstall ) else ( echo     [跳过] 未找到 auto-update.bat )
exit /b 0

:do_docker
echo [7] 卸载 Docker Desktop（需要管理员，最彻底）...
if "%WHATIF%"=="1" ( echo     [预演] "Docker Desktop Installer.exe" uninstall & exit /b 0 )
set "INS="
if exist "..\docker\Docker Desktop Installer.exe" set "INS=..\docker\Docker Desktop Installer.exe"
if not defined INS if exist "docker\Docker Desktop Installer.exe" set "INS=docker\Docker Desktop Installer.exe"
if not defined INS if exist "%ProgramFiles%\Docker\Docker\Docker Desktop Installer.exe" set "INS=%ProgramFiles%\Docker\Docker\Docker Desktop Installer.exe"
if not defined INS ( echo     [跳过] 未找到 Docker 安装器 & exit /b 0 )
echo     使用：!INS!
if "%WHATIF%"=="0" (
  set "OK2="
  set /p "OK2=    确认卸载 Docker Desktop？输入 YES 继续: "
  if /i "!OK2!"=="YES" ( "!INS!" uninstall ) else ( echo     已取消 )
)
exit /b 0

:done
echo.
echo  清理结束。如需重装：双击 setup.bat（或 system\install.bat）。
pause
endlocal
