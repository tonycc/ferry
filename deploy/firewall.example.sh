#!/usr/bin/env bash
# 宿主机容器出站与管理面隔离防火墙(任务 3.2 纵深加固)。
# **上线前请结合企业实际网段验证**,特别是存在内网 npm / 镜像代理或前置内网 SLB 时需配置白名单。
#
# 防护目标(同时覆盖 IPv4 iptables 与 IPv6 ip6tables,采用临时链构建后原子重命名切换,幂等可重复执行):
# 1. 宿主机管理面保护(FERRY-HOST-INPUT + mangle FERRY-PRE):
#    - 禁止容器网桥(docker0、br-*、docker_gwbridge)直连宿主机 SSH(22)、Dokploy(默认 3000)及其他未显式放行的本机管理端口;
#    - 禁止容器经宿主机任意过去或未来网桥/网卡地址(DNAT 转发或本机路由)绕过隔离访问 Dokploy 管理端口;
# 2. 云元数据与链路本地封堵(FERRY-ISOLATION):
#    - 禁止容器访问 169.254.0.0/16、阿里云 100.100.100.200/32、fe80::/10、fd00:ec2::254/128;
# 3. 企业私网横向出站封堵(FERRY-ISOLATION,默认开启):
#    - 禁止容器主动经宿主机外部网卡连接企业私网(10/8、172.16/12、192.168/16、100.64/10、fc00::/7);
#    - 前置放行已建立连接(ESTABLISHED,RELATED)回包与容器网络内部东西向流量;
#    - 仅对宿主机配置的实际上游 DNS 服务器地址(而非整个私网)放行 UDP/TCP 53 域名解析。
#
# 可选环境变量:
#   DOKPLOY_PORT=3000                    Dokploy 管理端口(默认 3000)
#   ALLOW_HOST_PORTS=""                  额外允许容器访问宿主机的 TCP 端口(空格或逗号分隔;80/443/53 默认放行)
#   BLOCK_PRIVATE_EGRESS=1               设为 0 关闭对企业私网网段的出站拦截(默认 1 开启)
#   ALLOW_EGRESS_V4_CIDRS=""             允许容器访问的企业内网 IPv4 地址/网段(空格或逗号分隔,如内网镜像/npm 代理、Ferry 前置内网 SLB VIP)
#   ALLOW_EGRESS_V6_CIDRS=""             允许容器访问的企业内网 IPv6 地址/网段(空格或逗号分隔)
#   ALLOW_DNS_V4=""                      额外允许容器查询的内网 IPv4 DNS 地址(默认自动读取 /etc/resolv.conf)
#   ALLOW_DNS_V6=""                      额外允许容器查询的内网 IPv6 DNS 地址(默认自动读取 /etc/resolv.conf)
#
# 用法:sudo deploy/firewall.example.sh
# 规则重启后不保留,长期生效请用 iptables-persistent / netfilter-persistent 保存或写入开机脚本(早于 Docker 启动也可生效)。
set -euo pipefail

DOKPLOY_PORT="${DOKPLOY_PORT:-3000}"
BLOCK_PRIVATE_EGRESS="${BLOCK_PRIVATE_EGRESS:-1}"
ALLOW_V4="${ALLOW_EGRESS_V4_CIDRS:-}"
ALLOW_V4="${ALLOW_V4//,/ }"
ALLOW_V6="${ALLOW_EGRESS_V6_CIDRS:-}"
ALLOW_V6="${ALLOW_V6//,/ }"
EXTRA_HOST_PORTS="${ALLOW_HOST_PORTS:-}"
EXTRA_HOST_PORTS="${EXTRA_HOST_PORTS//,/ }"

CONTAINER_IFACES=(docker0 'br-+' docker_gwbridge)

# 提取宿主机上游非本机回环 DNS 地址(兼容 systemd-resolved 真实上游文件),避免对全私网敞开 53 端口
collect_dns() {
  local family="$1"
  for file in /etc/resolv.conf /run/systemd/resolve/resolv.conf; do
    [ -r "$file" ] || continue
    awk '$1 == "nameserver" { print $2 }' "$file"
  done | if [ "$family" = 4 ]; then
    grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -Ev '^127\.' || true
  else
    grep ':' | grep -Eiv '^::1$|^fe80:' | cut -d% -f1 || true
  fi | sort -u
}

DNS_V4="$(printf '%s\n%s\n' "$(collect_dns 4)" "${ALLOW_DNS_V4//,/ }" | awk 'NF' | sort -u)"
DNS_V6="$(printf '%s\n%s\n' "$(collect_dns 6)" "${ALLOW_DNS_V6//,/ }" | awk 'NF' | sort -u)"

# 准备临时链:所有规则先写入 *-TMP,全部成功后再由 commit_chain 原子重命名切换,避免参数写错时留下半截 Fail-Open 链
prepare_tmp_chain() {
  local bin="$1" table="$2" tmp="$3"
  "$bin" -t "$table" -F "$tmp" 2>/dev/null || true
  "$bin" -t "$table" -X "$tmp" 2>/dev/null || true
  "$bin" -t "$table" -N "$tmp"
}

commit_chain() {
  local bin="$1" table="$2" parent="$3" chain="$4" tmp="$5"
  "$bin" -t "$table" -N "$chain" 2>/dev/null || true
  "$bin" -t "$table" -I "$parent" 1 -j "$tmp"
  while "$bin" -t "$table" -D "$parent" -j "$chain" 2>/dev/null; do :; done
  "$bin" -t "$table" -F "$chain"
  "$bin" -t "$table" -X "$chain"
  "$bin" -t "$table" -E "$tmp" "$chain"
}

# ---- IPv4 (iptables) ----
command -v iptables >/dev/null || { echo "找不到 iptables" >&2; exit 1; }

# 开机脚本早于 docker.service 运行时主动预建 DOCKER-USER 并挂入 FORWARD(Docker 启动时会保留已有 DOCKER-USER 链)
if ! iptables -nL DOCKER-USER >/dev/null 2>&1; then
  iptables -N DOCKER-USER
  iptables -A DOCKER-USER -j RETURN
fi
iptables -C FORWARD -j DOCKER-USER 2>/dev/null || iptables -I FORWARD 1 -j DOCKER-USER

# 1) mangle PREROUTING(在 DNAT 之前按内核路由表动态拦截发往任意现在或未来宿主机本机地址的 Dokploy 端口与 SSH 22 端口)
if iptables -t mangle -nL PREROUTING >/dev/null 2>&1; then
  prepare_tmp_chain iptables mangle FERRY-PRE-TMP
  if iptables -t mangle -A FERRY-PRE-TMP -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN 2>/dev/null &&
     iptables -t mangle -A FERRY-PRE-TMP -i docker0 -m addrtype --dst-type LOCAL -p tcp --dport "$DOKPLOY_PORT" -j DROP 2>/dev/null; then
    iptables -t mangle -F FERRY-PRE-TMP
    iptables -t mangle -A FERRY-PRE-TMP -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    for iface in "${CONTAINER_IFACES[@]}"; do
      iptables -t mangle -A FERRY-PRE-TMP -i "$iface" -m addrtype --dst-type LOCAL -p tcp --dport "$DOKPLOY_PORT" -j DROP
      iptables -t mangle -A FERRY-PRE-TMP -i "$iface" -m addrtype --dst-type LOCAL -p tcp --dport 22 -j DROP
    done
    iptables -t mangle -A FERRY-PRE-TMP -j RETURN
    commit_chain iptables mangle PREROUTING FERRY-PRE FERRY-PRE-TMP
  else
    iptables -t mangle -F FERRY-PRE-TMP 2>/dev/null || true
    iptables -t mangle -X FERRY-PRE-TMP 2>/dev/null || true
  fi
fi

# 2) filter INPUT:限制容器直连宿主机本机服务(只放行已建立回包、本机 DNS 53、80/443 入口及 ALLOW_HOST_PORTS,其余新连接全部拒绝)
prepare_tmp_chain iptables filter FERRY-HOST-IN-TMP
iptables -A FERRY-HOST-IN-TMP -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for iface in "${CONTAINER_IFACES[@]}"; do
  iptables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport "$DOKPLOY_PORT" -j REJECT
  iptables -A FERRY-HOST-IN-TMP -i "$iface" -p udp --dport 53 -j RETURN
  iptables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport 53 -j RETURN
  iptables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport 80 -j RETURN
  iptables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport 443 -j RETURN
  iptables -A FERRY-HOST-IN-TMP -i "$iface" -p udp --dport 443 -j RETURN
  for port in $EXTRA_HOST_PORTS; do
    iptables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport "$port" -j RETURN
  done
  iptables -A FERRY-HOST-IN-TMP -i "$iface" -j REJECT
done
iptables -A FERRY-HOST-IN-TMP -j RETURN
commit_chain iptables filter INPUT FERRY-HOST-INPUT FERRY-HOST-IN-TMP

# 3) filter DOCKER-USER:拦截 DNAT 绕过、云元数据及企业私网横向出站
HOST_V4_GLOBAL=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | sort -u || true)
prepare_tmp_chain iptables filter FERRY-ISO-TMP
iptables -A FERRY-ISO-TMP -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

for iface in "${CONTAINER_IFACES[@]}"; do
  for cidr in 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 $HOST_V4_GLOBAL; do
    iptables -A FERRY-ISO-TMP -i "$iface" -p tcp -m conntrack --ctorigdst "$cidr" --ctorigdstport "$DOKPLOY_PORT" --ctdir ORIGINAL -j REJECT
  done
done

for iface in "${CONTAINER_IFACES[@]}"; do
  for cidr in 169.254.0.0/16 100.100.100.200/32; do
    iptables -A FERRY-ISO-TMP -i "$iface" -d "$cidr" -j REJECT
  done
done

for out_iface in lo "${CONTAINER_IFACES[@]}"; do
  iptables -A FERRY-ISO-TMP -o "$out_iface" -j RETURN
done

if [ "$BLOCK_PRIVATE_EGRESS" = 1 ]; then
  for iface in "${CONTAINER_IFACES[@]}"; do
    for dns in $DNS_V4; do
      iptables -A FERRY-ISO-TMP -i "$iface" -d "$dns" -p udp --dport 53 -j RETURN
      iptables -A FERRY-ISO-TMP -i "$iface" -d "$dns" -p tcp --dport 53 -j RETURN
    done
    for cidr in $ALLOW_V4; do
      iptables -A FERRY-ISO-TMP -i "$iface" -d "$cidr" -j RETURN
    done
    for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
      iptables -A FERRY-ISO-TMP -i "$iface" -d "$cidr" -j REJECT
    done
  done
fi
iptables -A FERRY-ISO-TMP -j RETURN
commit_chain iptables filter DOCKER-USER FERRY-ISOLATION FERRY-ISO-TMP

# ---- IPv6 (ip6tables:系统启用了 IPv6 时同步封堵) ----
if command -v ip6tables >/dev/null && ip6tables -nL INPUT >/dev/null 2>&1; then
  if ip6tables -t mangle -nL PREROUTING >/dev/null 2>&1; then
    prepare_tmp_chain ip6tables mangle FERRY-PRE-TMP
    if ip6tables -t mangle -A FERRY-PRE-TMP -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN 2>/dev/null &&
       ip6tables -t mangle -A FERRY-PRE-TMP -i docker0 -m addrtype --dst-type LOCAL -p tcp --dport "$DOKPLOY_PORT" -j DROP 2>/dev/null; then
      ip6tables -t mangle -F FERRY-PRE-TMP
      ip6tables -t mangle -A FERRY-PRE-TMP -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
      for iface in "${CONTAINER_IFACES[@]}"; do
        ip6tables -t mangle -A FERRY-PRE-TMP -i "$iface" -m addrtype --dst-type LOCAL -p tcp --dport "$DOKPLOY_PORT" -j DROP
        ip6tables -t mangle -A FERRY-PRE-TMP -i "$iface" -m addrtype --dst-type LOCAL -p tcp --dport 22 -j DROP
      done
      ip6tables -t mangle -A FERRY-PRE-TMP -j RETURN
      commit_chain ip6tables mangle PREROUTING FERRY-PRE FERRY-PRE-TMP
    else
      ip6tables -t mangle -F FERRY-PRE-TMP 2>/dev/null || true
      ip6tables -t mangle -X FERRY-PRE-TMP 2>/dev/null || true
    fi
  fi

  prepare_tmp_chain ip6tables filter FERRY-HOST-IN-TMP
  ip6tables -A FERRY-HOST-IN-TMP -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for iface in "${CONTAINER_IFACES[@]}"; do
    ip6tables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport "$DOKPLOY_PORT" -j REJECT
    ip6tables -A FERRY-HOST-IN-TMP -i "$iface" -p udp --dport 53 -j RETURN
    ip6tables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport 53 -j RETURN
    ip6tables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport 80 -j RETURN
    ip6tables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport 443 -j RETURN
    ip6tables -A FERRY-HOST-IN-TMP -i "$iface" -p udp --dport 443 -j RETURN
    for port in $EXTRA_HOST_PORTS; do
      ip6tables -A FERRY-HOST-IN-TMP -i "$iface" -p tcp --dport "$port" -j RETURN
    done
    ip6tables -A FERRY-HOST-IN-TMP -i "$iface" -j REJECT
  done
  ip6tables -A FERRY-HOST-IN-TMP -j RETURN
  commit_chain ip6tables filter INPUT FERRY-HOST-INPUT FERRY-HOST-IN-TMP

  # 清理另一条父链上可能遗留的旧跳转(例如开启 Docker IPv6 前后父链从 FORWARD 切到 DOCKER-USER)
  V6_FORWARD_PARENT="FORWARD"
  if ip6tables -nL DOCKER-USER >/dev/null 2>&1; then
    V6_FORWARD_PARENT="DOCKER-USER"
    while ip6tables -D FORWARD -j FERRY-ISOLATION 2>/dev/null; do :; done
  fi

  HOST_V6_GLOBAL=$(ip -6 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | sort -u || true)
  prepare_tmp_chain ip6tables filter FERRY-ISO-TMP
  ip6tables -A FERRY-ISO-TMP -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

  for iface in "${CONTAINER_IFACES[@]}"; do
    for cidr in ::1/128 fe80::/10 fc00::/7 $HOST_V6_GLOBAL; do
      ip6tables -A FERRY-ISO-TMP -i "$iface" -p tcp -m conntrack --ctorigdst "$cidr" --ctorigdstport "$DOKPLOY_PORT" --ctdir ORIGINAL -j REJECT
    done
  done

  for iface in "${CONTAINER_IFACES[@]}"; do
    for cidr in fe80::/10 fd00:ec2::254/128; do
      ip6tables -A FERRY-ISO-TMP -i "$iface" -d "$cidr" -j REJECT
    done
  done

  for out_iface in lo "${CONTAINER_IFACES[@]}"; do
    ip6tables -A FERRY-ISO-TMP -o "$out_iface" -j RETURN
  done

  if [ "$BLOCK_PRIVATE_EGRESS" = 1 ]; then
    for iface in "${CONTAINER_IFACES[@]}"; do
      for dns in $DNS_V6; do
        ip6tables -A FERRY-ISO-TMP -i "$iface" -d "$dns" -p udp --dport 53 -j RETURN
        ip6tables -A FERRY-ISO-TMP -i "$iface" -d "$dns" -p tcp --dport 53 -j RETURN
      done
      for cidr in $ALLOW_V6; do
        ip6tables -A FERRY-ISO-TMP -i "$iface" -d "$cidr" -j RETURN
      done
      ip6tables -A FERRY-ISO-TMP -i "$iface" -d fc00::/7 -j REJECT
    done
  fi
  ip6tables -A FERRY-ISO-TMP -j RETURN
  commit_chain ip6tables filter "$V6_FORWARD_PARENT" FERRY-ISOLATION FERRY-ISO-TMP
fi

echo "已添加 IPv4/IPv6 容器隔离防火墙规则。上线前请逐项验证:"
echo "  1. 在员工应用容器里访问宿主机 :$DOKPLOY_PORT / :22 和 http://169.254.169.254,都应连不上;"
echo "  2. 在员工应用容器里访问企业内网非白名单机器应被拒绝;若有内网 npm/镜像代理或前置内网 SLB VIP,设 ALLOW_EGRESS_V4_CIDRS 后正常可用;"
echo "  3. 已上线的应用(包括监听 3000 端口的模板应用)经域名照常打开,管理员从管理网段仍能打开 Dokploy。"
