════════════════════════════════════════
  工厂管理系统 FMS · 离线安装资源目录
════════════════════════════════════════

本目录用于放置【国内网络下安装 Docker / WSL2 所需的一切】，
配合上一级的 setup.bat 可实现全程离线或仅走国内镜像。

【1】Docker Desktop 安装器（必需，约 630MB）
  文件名：Docker Desktop Installer.exe
  有它 → setup.bat 跳过联网下载，直接静默安装。
  下载：https://www.docker.com/products/docker-desktop/
  直链：https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe
  （国内直连常被重置；用手机热点或能上外网的机器下载后拷入本目录）

【2】Docker 国内镜像源（daemon.json，自动安装）
  文件名：daemon.json（本目录已自带）
  setup.bat 会把它复制到 %USERPROFILE%\.docker\daemon.json 并重启 Docker，
  作用：docker pull / compose build 走国内镜像站，不再卡在 Docker Hub。
  已配置镜像：docker.m.daocloud.io、docker.1panel.live、hub.rat.dev、
              dockerproxy.net、docker.mirrors.ustc.edu.cn
  注：国内镜像站时有变动，某天拉不动时可自行增删该文件的 registry-mirrors 数组。

【3】WSL2 内核更新包（可选，约 15MB）
  文件名：wsl_update_x64.msi
  适用：老版本 Windows 10 在启用「适用于 Linux 的 Windows 子系统 / 虚拟机平台」后，
        还需要安装 WSL2 内核；该 msi 官方源在国内也常拉不动。
  setup.bat 检测到本文件时会自动静默安装（msiexec /i ... /qn）。
  官方地址：https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi
  若你的系统是 Win11 / 较新 Win10，通常无需该文件（内核已内置）。

【4】离线镜像（可选，彻底不依赖网络）
  目录：images\*.tar（docker save 导出）
  放入后 install.bat 会先 docker load 再启动，全程不联网。
  生成方式（在做好的机器上执行）：
    docker save -o images\fms-images.tar factory-management-system-app factory-management-system-nginx postgres:18
