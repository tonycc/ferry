#!/usr/bin/env bash
# 宿主机容器出站与管理面隔离防火墙(任务 3.2 纵深加固)。
# **上线前请结合企业实际网段验证**,特别是存在内网 npm / 镜像仓库代理时需配置白名单。
#
# 防护目标(同时覆盖 IPv4 iptables 与 IPv6 ip6tables,幂等可重复执行):
# 1. 禁止容器网桥(含 docker build 默认网桥 docker0、自定义网桥 br-*、Swarm overlay 出口 docker_gwbridge)
#    经宿主机本机地址(直连 INPUT 或 DNAT 转发)绕过网络隔离访问 Dokploy 管理端口(默认 3000);
# 2. 禁止容器访问云厂商元数据与链路本地地址(169.254.0.0/16、阿里云 100.100.100.200、fe80::/10、fd00:ec2::254);
# 3. 默认禁止容器经宿主机物理网卡主动连接企业内网私网网段(10/8、172.16/12、192.168/16、100.64/10、fc00::/7),
#    阻断员工应用或构建期向企业 OA / 内网中间件发起横向探测与 SSRF:
#    - 已建立连接(ESTABLISHED,RELATED)先放行,内网员工浏览器访问应用、管理员访问 Dokploy 的回包不受影响;
#    - 容器网络内部东西向流量(-o docker0 / br-+ / docker_gwbridge)交还 Docker 自有隔离链处理,不影响 Traefik 转发与应用连库;
#    - 默认放行容器发起的 DNS 查询(UDP/TCP 53),避免内网 DNS 无法解析。
#
# 可选环境变量:
#   DOKPLOY_PORT=3000                    要对容器封禁的宿主机管理端口(默认 3000)
#   BLOCK_PRIVATE_EGRESS=1               设为 0 可关闭对企业私网网段的出站拦截(默认 1 开启)
#   ALLOW_EGRESS_V4_CIDRS="10.10.2.10/32" 允许容器访问的内网 IPv4 地址/网段(空格或逗号分隔,如内网镜像/npm 代理)
#   ALLOW_EGRESS_V6_CIDRS=""             允许容器访问的内网 IPv6 地址/网段(空格或逗号分隔)
#
# 用法:sudo deploy/firewall.example.sh
# 规则重启后不保留,长期生效请用 iptables-persistent / netfilter-persistent 保存或写入开机脚本。
set -euo pipefail

DOKPLOY_PORT="${DOKPLOY_PORT:-3000}"
BLOCK_PRIVATE_EGRESS="${BLOCK_PRIVATE_EGRESS:-1}"
ALLOW_V4="${ALLOW_EGRESS_V4_CIDRS:-}"
ALLOW_V4="${ALLOW_V4//,/ }"
ALLOW_V6="${ALLOW_EGRESS_V6_CIDRS:-}"
ALLOW_V6="${ALLOW_V6//,/ }"

CONTAINER_IFACES=(docker0 'br-+' docker_gwbridge)

# 创建或清空独立子链,并确保挂载在父链第 1 条(重复运行不会堆积重复规则,且保持从上到下的匹配顺序)
reset_chain() {
  local bin="$1" parent="$2" chain="$3"
  "$bin" -nL "$parent" >/dev/null 2>&1 || return 1
  "$bin" -N "$chain" 2>/dev/null || "$bin" -F "$chain"
  while "$bin" -D "$parent" -j "$chain" 2>/dev/null; do :; done
  "$bin" -I "$parent" 1 -j "$chain"
}

# ---- IPv4 (iptables) ----
command -v iptables >/dev/null || { echo "找不到 iptables" >&2; exit 1; }

HOST_V4_ADDRS=$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true)

reset_chain iptables INPUT FERRY-HOST-INPUT
iptables -A FERRY-HOST-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for iface in "${CONTAINER_IFACES[@]}"; do
  iptables -A FERRY-HOST-INPUT -i "$iface" -p tcp --dport "$DOKPLOY_PORT" -j REJECT
done
iptables -A FERRY-HOST-INPUT -j RETURN

# Docker 启动前可能还没有 DOCKER-USER,只在链存在时挂载(Docker 装好运行后必有)
if reset_chain iptables DOCKER-USER FERRY-ISOLATION; then
  # 1. 放行已建立连接的回包(内网浏览器访问 Traefik、管理员从管理网段访问 Dokploy)
  iptables -A FERRY-ISOLATION -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

  # 2. 拦截容器经宿主机任意本机地址(DNAT 改写前原始目标)访问 Dokploy 端口
  for iface in "${CONTAINER_IFACES[@]}"; do
    for addr in $HOST_V4_ADDRS; do
      iptables -A FERRY-ISOLATION -i "$iface" -p tcp -m conntrack --ctorigdst "$addr" --ctorigdstport "$DOKPLOY_PORT" --ctdir ORIGINAL -j REJECT
    done
  done

  # 3. 拦截容器访问云元数据与链路本地地址(AWS/GCP/OpenStack/腾讯云 169.254.169.254、阿里云 100.100.100.200)
  for iface in "${CONTAINER_IFACES[@]}"; do
    for cidr in 169.254.0.0/16 100.100.100.200/32; do
      iptables -A FERRY-ISOLATION -i "$iface" -d "$cidr" -j REJECT
    done
  done

  # 4. 容器网络内部东西向流量交还 Docker 自有的 DOCKER-ISOLATION 链(同网络互通、跨网络隔离)
  for out_iface in lo "${CONTAINER_IFACES[@]}"; do
    iptables -A FERRY-ISOLATION -o "$out_iface" -j RETURN
  done

  # 5. 拦截容器向宿主机外部发起的企业私网横向连接(保留 DNS 53 端口及显式白名单网段)
  if [ "$BLOCK_PRIVATE_EGRESS" = 1 ]; then
    for iface in "${CONTAINER_IFACES[@]}"; do
      iptables -A FERRY-ISOLATION -i "$iface" -p udp --dport 53 -j RETURN
      iptables -A FERRY-ISOLATION -i "$iface" -p tcp --dport 53 -j RETURN
      for cidr in $ALLOW_V4; do
        iptables -A FERRY-ISOLATION -i "$iface" -d "$cidr" -j RETURN
      done
      for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
        iptables -A FERRY-ISOLATION -i "$iface" -d "$cidr" -j REJECT
      done
    done
  fi

  iptables -A FERRY-ISOLATION -j RETURN
fi

# ---- IPv6 (ip6tables:系统启用了 IPv6 时同步封堵,避免经 IPv6 绕过) ----
if command -v ip6tables >/dev/null && ip6tables -nL INPUT >/dev/null 2>&1; then
  HOST_V6_ADDRS=$(ip -6 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true)

  reset_chain ip6tables INPUT FERRY-HOST-INPUT
  ip6tables -A FERRY-HOST-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for iface in "${CONTAINER_IFACES[@]}"; do
    ip6tables -A FERRY-HOST-INPUT -i "$iface" -p tcp --dport "$DOKPLOY_PORT" -j REJECT
  done
  ip6tables -A FERRY-HOST-INPUT -j RETURN

  # Docker 未开启 IPv6 时可能没有 DOCKER-USER 链,退回挂在 FORWARD 链顶部兜底
  V6_FORWARD_PARENT="DOCKER-USER"
  ip6tables -nL DOCKER-USER >/dev/null 2>&1 || V6_FORWARD_PARENT="FORWARD"
  if reset_chain ip6tables "$V6_FORWARD_PARENT" FERRY-ISOLATION; then
    ip6tables -A FERRY-ISOLATION -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

    for iface in "${CONTAINER_IFACES[@]}"; do
      for addr in $HOST_V6_ADDRS; do
        ip6tables -A FERRY-ISOLATION -i "$iface" -p tcp -m conntrack --ctorigdst "$addr" --ctorigdstport "$DOKPLOY_PORT" --ctdir ORIGINAL -j REJECT
      done
    done

    for iface in "${CONTAINER_IFACES[@]}"; do
      for cidr in fe80::/10 fd00:ec2::254/128; do
        ip6tables -A FERRY-ISOLATION -i "$iface" -d "$cidr" -j REJECT
      done
    done

    for out_iface in lo "${CONTAINER_IFACES[@]}"; do
      ip6tables -A FERRY-ISOLATION -o "$out_iface" -j RETURN
    done

    if [ "$BLOCK_PRIVATE_EGRESS" = 1 ]; then
      for iface in "${CONTAINER_IFACES[@]}"; do
        ip6tables -A FERRY-ISOLATION -i "$iface" -p udp --dport 53 -j RETURN
        ip6tables -A FERRY-ISOLATION -i "$iface" -p tcp --dport 53 -j RETURN
        for cidr in $ALLOW_V6; do
          ip6tables -A FERRY-ISOLATION -i "$iface" -d "$cidr" -j RETURN
        done
        ip6tables -A FERRY-ISOLATION -i "$iface" -d fc00::/7 -j REJECT
      done
    fi

    ip6tables -A FERRY-ISOLATION -j RETURN
  fi
fi

echo "已添加 IPv4/IPv6 容器隔离防火墙规则。上线前请逐项验证:"
echo "  1. 在员工应用容器里 curl http://<宿主机地址>:$DOKPLOY_PORT 和 http://169.254.169.254,都应连不上;"
echo "  2. 在员工应用容器里访问企业内网其他机器(非白名单地址),应连不上;如有内网 npm/镜像代理,设 ALLOW_EGRESS_V4_CIDRS 后可正常拉包;"
echo "  3. 已上线的应用(包括监听 3000 端口的模板应用)经域名照常打开,管理员从管理网段仍能打开 Dokploy。"
