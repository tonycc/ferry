#!/bin/bash
# 在本机 Docker Desktop(macOS)上安装 Dokploy,仅用于本地开发。
#
# 官方安装脚本(https://dokploy.com/install.sh)只支持 Linux 服务器,在 macOS 上会直接退出。
# 这里照着它的步骤手动执行,去掉了只适用于 Linux 的部分:端口检查用的 ss、自动安装 Docker、
# 探测公网 IP,以及开头的 `docker swarm leave --force`(会删掉已有的 Swarm 服务)。
#
# 注意:
# - /etc/dokploy 不在 macOS 上,而是在 Docker Desktop 虚拟机内部。Docker Desktop 重启后它可能丢失,
#   届时重新运行本脚本即可(已存在的服务、密钥、网络会跳过)。
# - 卸载见同目录的 teardown-local.sh。
set -euo pipefail

DOKPLOY_VERSION="${DOKPLOY_VERSION:-v0.31.3}"
POSTGRES_IMAGE="postgres:16"
TRAEFIK_IMAGE="traefik:v3.7.16"
# 用一个一次性容器读写 Docker Desktop 虚拟机里的 /etc/dokploy
HELPER_IMAGE="${HELPER_IMAGE:-$POSTGRES_IMAGE}"

in_vm() {
  docker run --rm --entrypoint sh -v /etc/dokploy:/etc/dokploy "$HELPER_IMAGE" -c "$1"
}

port_in_use() { nc -z 127.0.0.1 "$1" 2>/dev/null; }
echo "== 检查端口 80、443、3000(已由 Dokploy 自己占用的跳过)"
if ! docker ps -a --format '{{.Names}}' | grep -qx dokploy-traefik; then
  for port in 80 443; do
    if port_in_use "$port"; then echo "端口 $port 已被占用,请先停掉占用它的程序" >&2; exit 1; fi
  done
fi
if ! docker service inspect dokploy >/dev/null 2>&1 && port_in_use 3000; then
  echo "端口 3000 已被占用,请先停掉占用它的程序" >&2
  exit 1
fi

echo "== 开启 Swarm"
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" = "active" ]; then
  echo "已开启,跳过"
else
  docker swarm init ${DOCKER_SWARM_INIT_ARGS:-}
fi

echo "== 创建网络 dokploy-network"
docker network inspect dokploy-network >/dev/null 2>&1 \
  || docker network create --driver overlay --attachable dokploy-network

echo "== 准备 /etc/dokploy(在 Docker Desktop 虚拟机里)"
in_vm 'mkdir -p /etc/dokploy && chmod 755 /etc/dokploy'

echo "== 创建密钥(值只写进 Docker Secret,不输出)"
docker secret inspect dokploy_postgres_password >/dev/null 2>&1 \
  || openssl rand -base64 32 | tr -d "=+/" | cut -c1-32 | docker secret create dokploy_postgres_password - >/dev/null
docker secret inspect dokploy_auth_secret >/dev/null 2>&1 \
  || openssl rand -hex 32 | docker secret create dokploy_auth_secret - >/dev/null

echo "== 启动 dokploy-postgres"
docker service inspect dokploy-postgres >/dev/null 2>&1 || docker service create \
  --name dokploy-postgres \
  --constraint 'node.role==manager' \
  --network dokploy-network \
  --env POSTGRES_USER=dokploy \
  --env POSTGRES_DB=dokploy \
  --secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
  --mount type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data \
  --detach \
  "$POSTGRES_IMAGE"

echo "== 启动 dokploy $DOKPLOY_VERSION"
docker service inspect dokploy >/dev/null 2>&1 || docker service create \
  --name dokploy \
  --replicas 1 \
  --network dokploy-network \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount type=bind,source=/etc/dokploy,target=/etc/dokploy \
  --mount type=volume,source=dokploy,target=/root/.docker \
  --secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
  --secret source=dokploy_auth_secret,target=/run/secrets/dokploy_auth_secret \
  --publish published=3000,target=3000,mode=host \
  --update-parallelism 1 \
  --update-order stop-first \
  --constraint 'node.role == manager' \
  -e RELEASE_TAG=latest \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
  -e BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret \
  --detach \
  "dokploy/dokploy:$DOKPLOY_VERSION"

# Traefik 把 traefik.yml 当作单个文件挂载。文件还不存在时启动,Docker 会在那里建一个目录,
# Traefik 就起不来。所以先等 Dokploy 首次启动时把它生成出来。
echo "== 等待 Dokploy 生成 traefik.yml(最多 5 分钟)"
for _ in $(seq 1 100); do
  if in_vm 'test -f /etc/dokploy/traefik/traefik.yml'; then
    echo "已生成"
    break
  fi
  sleep 3
done
if ! in_vm 'test -f /etc/dokploy/traefik/traefik.yml'; then
  echo "Dokploy 没有生成 traefik.yml,请查看日志: docker service logs dokploy" >&2
  exit 1
fi

# 关掉 Traefik 的管理接口(Dokploy 默认 api.insecure: true,在容器的 8080 端口)。网络隔离后 Traefik 接入了
# 每个应用的网络,不关的话所有应用都能读到全部路由配置。Dokploy 自己不依赖它(实测)
echo "== 关闭 Traefik 管理接口"
in_vm "sed -i 's/^\\([[:space:]]*\\)insecure: true/\\1insecure: false/' /etc/dokploy/traefik/traefik.yml"

# 和官方脚本不同:先接默认的 bridge 网络,再接入 dokploy-network。
# Docker Desktop 不会把端口转发给主网络是 Swarm overlay 的容器,直接接 dokploy-network 的话
# 从 macOS 访问 80、443 会一直没有响应。
# 注意:如果在 Dokploy 管理页面里重建了 Traefik,它会回到官方的网络设置,需要重新运行本脚本。
echo "== 启动 dokploy-traefik"
if docker ps -a --format '{{.Names}}' | grep -qx dokploy-traefik; then
  # 已经接着 overlay 网络,直接启动的话端口转发会失效,见 restart-traefik-local.sh
  "$(dirname "$0")/restart-traefik-local.sh"
else
  docker run -d \
    --name dokploy-traefik \
    --restart always \
    --network bridge \
    -v /etc/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml \
    -v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -p 80:80/tcp \
    -p 443:443/tcp \
    -p 443:443/udp \
    "$TRAEFIK_IMAGE" >/dev/null
  docker network connect dokploy-network dokploy-traefik
fi

echo
echo "完成。打开 http://localhost:3000 创建 Dokploy 管理员账号。"
