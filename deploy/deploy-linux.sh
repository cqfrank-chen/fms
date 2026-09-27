#!/usr/bin/env bash
# ============================================================
#  工厂管理系统 FMS · Linux 一键部署（Ubuntu 22.04/24.04/26.04、Debian 12）
#  用法：sudo bash deploy-linux.sh
#  放置：随发布包位于 <包根>/system/deploy/（也可直接拷到服务器，同目录需能找到 system/docker-compose.yml）
#  特点：不在服务器上构建镜像（离线镜像 docker load + --no-build）；
#        自动建 2G swap、配国内镜像源、随机化数据库口令、健康检查
# ============================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# 定位应用目录（含 docker-compose.yml 的 system/）：兼容「发布包 deploy 子目录」与「仓库根」两种放法
pick_sys() {
  for c in "$HERE/system" "$HERE/../system" "$HERE" "$HERE/.."; do
    if [ -f "$c/docker-compose.yml" ]; then (cd "$c" && pwd); return 0; fi
  done
  return 1
}
if ! SYS="$(pick_sys)"; then
  echo "未找到 docker-compose.yml：请把本脚本放在发布包根目录，或发布包 system/deploy/ 目录下运行"
  exit 1
fi
ROOT="$(cd "$SYS/.." && pwd)"   # 发布包根目录（离线镜像位于 <包根>/docker/images/）
cd "$SYS"
log(){ echo -e "\033[1;32m[$(date +%H:%M:%S)] $*\033[0m"; }
warn(){ echo -e "\033[1;33m[警告] $*\033[0m"; }

if [ "$(id -u)" != "0" ]; then echo "请用 sudo 运行： sudo bash $0"; exit 1; fi

# ---- 1. swap（2C2G 防 OOM）----
if [ ! -f /swapfile ]; then
  log "创建 2G swap..."
  (fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048) >/dev/null 2>&1
  chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  log "swap 已启用"
else
  log "swap 已存在，跳过"
fi

# ---- 2. Docker ----
if ! command -v docker >/dev/null 2>&1; then
  log "安装 Docker（官方脚本，失败回退 apt）..."
  if ! curl -fsSL --max-time 90 https://get.docker.com | sh; then
    warn "官方脚本失败，改用 apt 安装"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y docker.io || true
    apt-get install -y docker-compose-v2 || apt-get install -y docker-compose || true
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker --version || { echo "Docker 安装失败"; exit 1; }
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else warn "compose 插件缺失，改用 docker-compose"; DC="docker-compose"; fi
log "Compose 命令：$DC"

# ---- 3. 国内镜像源 + 日志限额 ----
log "写入 /etc/docker/daemon.json（国内镜像源）"
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1panel.live", "https://hub.rat.dev", "https://dockerproxy.net"],
  "dns": ["223.5.5.5", "119.29.29.29"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl restart docker >/dev/null 2>&1 || service docker restart >/dev/null 2>&1 || warn "docker 服务重启失败，请手动执行 systemctl restart docker"
sleep 3

# ---- 4. .env（公网服务器必须换口令）----
if [ ! -f .env ]; then
  if [ -f .env.example ]; then cp .env.example .env; else echo "缺少 .env 与 .env.example，无法确定数据库配置"; exit 1; fi
fi
# Windows 上编辑过的 .env 可能带 CRLF：先去掉 \r，否则 DB_PASSWORD 会带上 \r 且随机化判定失效
sed -i 's/\r$//' .env
CURPW=$(grep -E '^DB_PASSWORD=' .env | cut -d= -f2 || true)
if [ -z "$CURPW" ] || [ "$CURPW" = "fms" ]; then
  NEWPW=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-20)
  sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$NEWPW/" .env
  grep -q "^DB_PASSWORD=" .env || echo "DB_PASSWORD=$NEWPW" >> .env
  log "数据库口令已随机化（见 $SYS/.env，请保存）"
fi
grep -q '^HTTP_PORT=' .env || echo 'HTTP_PORT=80' >> .env
grep -q '^TZ=' .env || echo 'TZ=Asia/Shanghai' >> .env
# JWT 登录密钥：为空时随机生成，避免容器重启导致全员掉线（重新登录）
CURJWT=$(grep -E '^JWT_SECRET=' .env | cut -d= -f2 || true)
if [ -z "$CURJWT" ]; then
  NEWJWT=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-48)
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$NEWJWT/" .env
  grep -q "^JWT_SECRET=" .env || echo "JWT_SECRET=$NEWJWT" >> .env
  log "JWT_SECRET 已随机生成（登录态跨容器重启保持有效；见 $SYS/.env）"
fi
PORT=$(grep -E '^HTTP_PORT=' .env | cut -d= -f2 || true)
[ -n "$PORT" ] || PORT=80

# ---- 5. 载入离线镜像并启动 ----
IMG_DIR=""
for c in "$ROOT/docker/images" "$SYS/docker/images" "$HERE/docker/images" "$HERE/images" "$ROOT/images"; do
  if ls "$c"/*.tar >/dev/null 2>&1; then IMG_DIR="$c"; break; fi
done
if [ -n "$IMG_DIR" ]; then
  for f in "$IMG_DIR"/*.tar; do log "docker load $(basename "$f")（无需联网）"; docker load -i "$f"; done
  log "启动：$DC up -d --no-build"
  $DC up -d --no-build
else
  warn "未找到离线镜像（<发布包>/docker/images/*.tar），改为本机构建（需网络与内存）"
  $DC build && $DC up -d
fi

# ---- 6. 健康检查 ----
log "等待服务就绪（最长 2 分钟）..."
OK=0
for i in $(seq 1 40); do
  sleep 3
  if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then OK=1; break; fi
done
if [ "$OK" = "1" ]; then log "健康检查通过：$(curl -s "http://127.0.0.1:$PORT/api/health")"; else warn "健康检查超时，请执行：$DC logs app --tail=50"; fi

IP=$(curl -s --max-time 6 ifconfig.me || true)
[ -n "$IP" ] || IP="公网IP"
echo
echo "============================================================"
echo " 部署完成"
echo "   访问地址   : http://$IP:$PORT/"
echo "   安全组放行 : TCP $PORT（务必把源地址限制为公司出口 IP）"
echo "   查看日志   : cd $SYS && $DC logs -f app"
echo "   数据备份   : docker exec fms-postgres pg_dump -U fms -d fms -F c > backup_$(date +%F).dump"
echo "   停止清理   : cd $SYS && $DC down   （加 -v 连数据一起删）"
echo "============================================================"
