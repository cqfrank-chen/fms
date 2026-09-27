════════════════════════════════════════
  工厂管理系统 FMS · 离线安装器存放目录
════════════════════════════════════════

把 “Docker Desktop Installer.exe”（约 630MB）放在本目录，
再双击上一级的 setup.bat，即可【全程离线安装】，不会联网下载。

【网络下载地址】（需能访问外网）
  https://www.docker.com/products/docker-desktop/
  直链：https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe

【提示“连接被重置 / 下载失败”时】
  国内网络访问 desktop.docker.com 常被 TLS 重置。解决办法：
  1) 用手机热点或能上外网的电脑下载后，拷到本目录，再重跑 setup.bat；
  2) 已装过 Docker 的机器：从 C:\Users\<用户名>\Downloads 拷现成安装器；
  3) 只要本目录存在 “Docker Desktop Installer.exe”，setup.bat 就跳过下载。

【本目录内容】
  Docker Desktop Installer.exe   安装器（存在则跳过联网下载）
  README.txt                     本说明（UTF-8 with BOM）
