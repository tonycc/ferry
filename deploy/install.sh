#!/usr/bin/env bash
# Ferry 安装命令(docs/setup-wizard.md 阶段 4):在一台全新的 Linux 服务器上装好 Docker、Dokploy 和 Ferry,
# 最后打印设置向导的地址和设置码,剩下的(域名、证书、管理员)在浏览器里按向导做。
#
# 用法(root,在 deploy 目录里,和 docker-compose.yml 放在一起):
#   sudo FERRY_IMAGE=ferry:2026-11-26 ./install.sh
#
# 可选的环境变量:
#   FERRY_IMAGE        要运行的 Ferry 镜像(第一次必填;先 docker load 或能从镜像仓库拉到)。
#                      重复运行时可以不给,用 .env 里的;给了不同的就写进 .env,换成这个镜像
#   DOKPLOY_VERSION    Dokploy 版本,默认 v0.31.3(Ferry 是按这个版本验证的)
#   ADVERTISE_ADDR     Docker Swarm 用的本机地址,默认取默认路由的出口地址
#   SKIP_FIREWALL=1    不加防火墙规则(见下面 configure_firewall)
#
# 不操作任何外部服务(阿里云 DNS、证书等),也不保存外部服务的凭据。可以重复运行:已经装好的部分会跳过,
# 已有的 .env 不会被覆盖。生成的密码和密钥只写进文件(chmod 600),不打印。
# 只在本机检查过语法和改配置文件的部分,**没有在真实的 Linux 服务器上从零跑过**。
set -euo pipefail

DOKPLOY_VERSION="${DOKPLOY_VERSION:-v0.31.3}"
POSTGRES_IMAGE="postgres:16"
TRAEFIK_IMAGE="traefik:v3.7.16"
DOKPLOY_URL="http://127.0.0.1:3000"
TRAEFIK_YML="/etc/dokploy/traefik/traefik.yml"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
# Dokploy 管理员的登录信息(网页 http://服务器IP:3000 用)
DOKPLOY_LOGIN_FILE="$DEPLOY_DIR/dokploy-admin.txt"

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "安装没有完成:$*" >&2
  exit 1
}

check_system() {
  step "检查系统"
  [ "$(id -u)" = 0 ] || fail "请用 root 运行(sudo)"
  [ "$(uname -s)" = Linux ] || fail "只支持 Linux 服务器"
  [ -f "$DEPLOY_DIR/docker-compose.yml" ] || fail "找不到 $DEPLOY_DIR/docker-compose.yml:请在 deploy 目录里运行"
  # 第一次运行要给镜像;重复运行时 .env 里已有,给了新的就换成新的(升级)
  [ -n "${FERRY_IMAGE:-}" ] || { [ -f "$ENV_FILE" ] && [ -n "$(env_value FERRY_IMAGE)" ]; } ||
    fail "请设置 FERRY_IMAGE(如 FERRY_IMAGE=ferry:2026-11-26 ./install.sh)"
  local missing=()
  for tool in curl openssl jq; do command -v "$tool" >/dev/null || missing+=("$tool"); done
  if [ ${#missing[@]} -gt 0 ]; then
    if command -v apt-get >/dev/null; then
      apt-get update -qq && apt-get install -y -qq "${missing[@]}" >/dev/null
    elif command -v dnf >/dev/null; then
      dnf install -y -q "${missing[@]}" >/dev/null
    else
      fail "缺少 ${missing[*]},请先装好"
    fi
  fi
  # 端口:已经由 Dokploy、Traefik 占着的(重复运行时)不算
  if ! docker_ready || ! docker ps -a --format '{{.Names}}' | grep -qx dokploy-traefik; then
    for port in 80 443; do port_free "$port" || fail "端口 $port 已被占用,请先停掉占用它的程序"; done
  fi
  if ! docker_ready || ! docker service inspect dokploy >/dev/null 2>&1; then
    port_free 3000 || fail "端口 3000 已被占用,请先停掉占用它的程序"
  fi
}

docker_ready() { command -v docker >/dev/null && docker info >/dev/null 2>&1; }
port_free() { ! (ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .); }

install_docker() {
  step "安装 Docker"
  if docker_ready; then
    echo "已安装 $(docker version --format '{{.Server.Version}}'),跳过"
    return
  fi
  # Docker 官方的安装脚本(和 Dokploy 官方安装脚本的做法一样)
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  docker_ready || fail "Docker 装好了但没有运行:systemctl status docker"
}

check_compose() {
  # 系统软件源装的 Docker(如 docker.io)常常没有 compose 插件:提前发现,别等到最后启动 Ferry 才报错
  docker compose version >/dev/null 2>&1 ||
    fail "缺少 docker compose 插件:Debian/Ubuntu 运行 apt-get install docker-compose-plugin,其他系统见 Docker 官方文档"
}

setup_swarm() {
  step "开启 Docker Swarm"
  if [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" = active ]; then
    echo "已开启,跳过"
  else
    local addr="${ADVERTISE_ADDR:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')}"
    [ -n "$addr" ] || fail "找不到本机地址,请设置 ADVERTISE_ADDR"
    docker swarm init --advertise-addr "$addr" >/dev/null
  fi
  docker network inspect dokploy-network >/dev/null 2>&1 ||
    docker network create --driver overlay --attachable dokploy-network >/dev/null
}

# 和 Dokploy 官方安装脚本一样的服务,只是固定了版本(官方脚本装最新版)
install_dokploy() {
  step "安装 Dokploy $DOKPLOY_VERSION"
  mkdir -p /etc/dokploy && chmod 755 /etc/dokploy
  docker secret inspect dokploy_postgres_password >/dev/null 2>&1 ||
    openssl rand -base64 32 | tr -d "=+/" | cut -c1-32 | docker secret create dokploy_postgres_password - >/dev/null
  docker secret inspect dokploy_auth_secret >/dev/null 2>&1 ||
    openssl rand -hex 32 | docker secret create dokploy_auth_secret - >/dev/null

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
    "$POSTGRES_IMAGE" >/dev/null

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
    "dokploy/dokploy:$DOKPLOY_VERSION" >/dev/null

  echo "等 Dokploy 启动(最多 5 分钟)……"
  for _ in $(seq 1 100); do
    [ -f "$TRAEFIK_YML" ] && curl -fsS -o /dev/null "$DOKPLOY_URL" 2>/dev/null && return
    sleep 3
  done
  fail "Dokploy 没有起来:docker service logs dokploy"
}

# 建 Dokploy 的管理员、生成给 Ferry 用的 API key(docs/dokploy-findings.md“无人值守安装”)。
# 装好到注册之间,谁先打开 3000 端口谁就能注册成 owner,所以 Dokploy 一起来就注册。
# 已经有 .env 和 API key 时(重复运行)跳过
dokploy_api_key() {
  step "建 Dokploy 管理员和 API key"
  if [ -f "$ENV_FILE" ] && [ -n "$(env_value DOKPLOY_API_KEY)" ]; then
    echo ".env 里已有 DOKPLOY_API_KEY,跳过"
    return
  fi
  local jar email password status org key
  jar="$(mktemp)"
  email="${DOKPLOY_ADMIN_EMAIL:-admin@ferry.local}"
  password="$(openssl rand -base64 24 | tr -d '=+/')"
  status="$(curl -sS -o /dev/null -w '%{http_code}' -c "$jar" -H "origin: $DOKPLOY_URL" -H 'content-type: application/json' \
    -d "$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p, name: "Ferry", lastName: "Admin"}')" \
    "$DOKPLOY_URL/api/auth/sign-up/email")"
  if [ "$status" != 200 ]; then
    fail "Dokploy 管理员注册失败(HTTP $status)。如果之前已经在网页上注册过:在 Dokploy 个人设置里生成 API key,写进 $ENV_FILE 的 DOKPLOY_API_KEY 后重新运行"
  fi
  # 登录信息只写进文件,不打印
  (umask 077 && printf 'Dokploy 管理页面:http://服务器IP:3000\n邮箱:%s\n密码:%s\n' "$email" "$password" >"$DOKPLOY_LOGIN_FILE")

  org="$(curl -fsS -b "$jar" "$DOKPLOY_URL/api/trpc/organization.all" | jq -r '.result.data.json[0].id // empty')"
  [ -n "$org" ] || fail "读不到 Dokploy 的组织"
  # 一定要关掉限流:不关时每天只能调 10 次,Ferry 很快就用不了
  key="$(curl -fsS -b "$jar" -H "origin: $DOKPLOY_URL" -H 'content-type: application/json' \
    -d "$(jq -n --arg o "$org" '{json: {name: "ferry", rateLimitEnabled: false, metadata: {organizationId: $o}}}')" \
    "$DOKPLOY_URL/api/trpc/user.createApiKey" | jq -r '.result.data.json.key // empty')"
  rm -f "$jar"
  [ -n "$key" ] || fail "生成 Dokploy API key 失败"
  DOKPLOY_API_KEY_NEW="$key"
}

# 改 traefik.yml:关掉管理接口;去掉 Let's Encrypt(内网申请不到,只会反复重试、刷日志),
# 但 websecure 入口要保留 tls: {},不然应用的 https 路由不接 TLS 连接(docs/dokploy-findings.md)
patch_traefik_yml() {
  local file="$1"
  sed -i 's/^\([[:space:]]*\)insecure: true/\1insecure: false/' "$file"
  # 入口上的 tls 只有 certResolver 一项时,换成 tls: {}
  awk '
    /^[[:space:]]*tls:[[:space:]]*$/ { pending = $0; next }
    pending != "" {
      if ($0 ~ /^[[:space:]]*certResolver:[[:space:]]*letsencrypt[[:space:]]*$/) { sub(/tls:[[:space:]]*$/, "tls: {}", pending); print pending; pending = ""; next }
      print pending; pending = ""
    }
    { print }
    END { if (pending != "") print pending }
  ' "$file" >"$file.tmp" && mv "$file.tmp" "$file"
  # 去掉整个 certificatesResolvers 段(到下一个顶层键为止)
  awk '
    /^certificatesResolvers:/ { skip = 1; next }
    skip && /^[^[:space:]]/ { skip = 0 }
    !skip { print }
  ' "$file" >"$file.tmp" && mv "$file.tmp" "$file"
}

start_traefik() {
  step "配置并启动 Traefik"
  local before
  before="$(cksum <"$TRAEFIK_YML")"
  patch_traefik_yml "$TRAEFIK_YML"
  if docker ps -a --format '{{.Names}}' | grep -qx dokploy-traefik; then
    # 重复运行时配置没变就不重启:重启期间所有应用都打不开
    if [ "$before" != "$(cksum <"$TRAEFIK_YML")" ]; then
      docker restart dokploy-traefik >/dev/null
    else
      docker start dokploy-traefik >/dev/null
      echo "配置没变,不重启"
    fi
  else
    docker run -d \
      --name dokploy-traefik \
      --restart always \
      --network dokploy-network \
      -v "$TRAEFIK_YML":/etc/traefik/traefik.yml \
      -v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \
      -v /var/run/docker.sock:/var/run/docker.sock:ro \
      -p 80:80/tcp \
      -p 443:443/tcp \
      -p 443:443/udp \
      "$TRAEFIK_IMAGE" >/dev/null
  fi
}

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

# 写 .env:只在没有时新建。地址(PUBLIC_URL、APPS_DOMAIN、APPS_URL_SCHEME)不写,由设置向导设置
write_env() {
  step "生成 Ferry 的配置 $ENV_FILE"
  if [ -f "$ENV_FILE" ]; then
    echo "已存在,不覆盖"
    if [ -n "${FERRY_IMAGE:-}" ] && [ "$FERRY_IMAGE" != "$(env_value FERRY_IMAGE)" ]; then
      sed -i "s|^FERRY_IMAGE=.*|FERRY_IMAGE=$FERRY_IMAGE|" "$ENV_FILE"
      echo "镜像换成 $FERRY_IMAGE"
    fi
    if [ -n "${DOKPLOY_API_KEY_NEW:-}" ] && [ -z "$(env_value DOKPLOY_API_KEY)" ]; then
      sed -i "s/^DOKPLOY_API_KEY=.*/DOKPLOY_API_KEY=$DOKPLOY_API_KEY_NEW/" "$ENV_FILE"
      grep -q '^DOKPLOY_API_KEY=' "$ENV_FILE" || echo "DOKPLOY_API_KEY=$DOKPLOY_API_KEY_NEW" >>"$ENV_FILE"
    fi
    return
  fi
  (
    umask 077
    cat >"$ENV_FILE" <<EOF
# 由 install.sh 生成。地址、证书、管理员在设置向导里设置,不写在这里(写了的话向导和证书页就改不了)。
# GATEWAY_SECRET、SECRETS_KEY 不能改:改了所有人要重新登录、保存过的应用密钥再也解不开。把这个文件另外备份到安全的地方
FERRY_IMAGE=$FERRY_IMAGE
DOKPLOY_API_KEY=${DOKPLOY_API_KEY_NEW:-}
POSTGRES_PASSWORD=$(openssl rand -hex 32)
GATEWAY_SECRET=$(openssl rand -hex 32)
SECRETS_KEY=$(openssl rand -hex 32)
ADMIN_USERS=
EOF
  )
}

start_ferry() {
  step "启动 Ferry"
  docker image inspect "$(env_value FERRY_IMAGE)" >/dev/null 2>&1 || docker pull "$(env_value FERRY_IMAGE)" ||
    fail "没有镜像 $(env_value FERRY_IMAGE):先 docker load,或者确认能从镜像仓库拉到"
  (cd "$DEPLOY_DIR" && docker compose up -d)
  echo "等 Ferry 启动(最多 2 分钟)……"
  for _ in $(seq 1 40); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(cd "$DEPLOY_DIR" && docker compose ps -q ferry)" 2>/dev/null)" = healthy ] && return
    sleep 3
  done
  fail "Ferry 没有起来:cd $DEPLOY_DIR && docker compose logs ferry"
}

# 拦住“容器经宿主机地址访问 Dokploy 的 3000 端口”(员工应用绕过网络隔离调 Dokploy),规则同 firewall.example.sh。
# 不碰其他规则,管理员从外面访问不受影响。重启后不保留:要长期生效用 iptables-persistent 保存
configure_firewall() {
  step "防火墙:不让容器经宿主机访问 Dokploy"
  if [ "${SKIP_FIREWALL:-}" = 1 ]; then
    echo "SKIP_FIREWALL=1,跳过"
    return
  fi
  # 加不上只提醒,不中止:Ferry 已经起来了,后面还要打印设置码
  if "$DEPLOY_DIR/firewall.example.sh" >/dev/null 2>&1; then
    echo "已添加(重启后不保留,长期生效要用 iptables-persistent 保存)"
  else
    echo "没加上(可能没有 iptables,或者内核不支持 conntrack 匹配)。安装照常完成;请按 firewall.example.sh 里的说明手动处理" >&2
  fi
}

finish() {
  local ip code
  ip="${ADVERTISE_ADDR:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')}"
  code="$(cd "$DEPLOY_DIR" && docker compose exec -T ferry cat /data/state/setup-code 2>/dev/null || true)"
  echo
  if [ -z "$code" ]; then
    echo "Ferry 已经启动,并且已经完成过初始化(.env 里写了地址,或者向导已经做完),不需要设置向导。"
    return
  fi
  cat <<EOF
装好了。接下来在浏览器里完成设置:

  1. 打开 https://$ip/setup(浏览器会提示一次证书警告,继续访问即可)
  2. 输入设置码:$code

忘了设置码时:cd $DEPLOY_DIR && docker compose exec ferry cat /data/state/setup-code
Dokploy 管理页面的登录信息在 $DOKPLOY_LOGIN_FILE(只有 root 能读)。
请把 $ENV_FILE 另外备份到安全的地方:里面的 SECRETS_KEY 丢了,所有应用的密钥都无法解密。
EOF
}

main() {
  check_system
  install_docker
  check_compose
  setup_swarm
  install_dokploy
  dokploy_api_key
  # 拿到 API key 马上写进 .env:后面哪一步失败了,重新运行时 key 还在(Dokploy 管理员只能注册一次)
  write_env
  start_traefik
  start_ferry
  configure_firewall
  finish
}

# 测试时 source 这个文件只取函数,不执行
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
