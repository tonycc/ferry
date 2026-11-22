#!/usr/bin/env bash
# 防火墙示例(任务 3.2 留到部署时处理的部分)。**没有在真实的 Linux 服务器上验证过**,上线前要按实际网络改好、实测。
#
# 网络隔离后,员工应用连不到 dokploy-network 里的 Dokploy 和 Ferry,但还能经宿主机的地址绕过去:
# Dokploy 的 3000 端口默认发布在宿主机所有网卡上。这里在 Docker 的 DOCKER-USER 链上拦住
# “从容器发往宿主机 3000 端口”的连接。Ferry 的数据库不发布端口,不用另外处理。
#
# 另外建议:Dokploy 管理页面只对管理网段开放(云服务器用安全组,或者在下面加一条按来源网段放行的规则)。
#
# 用法:sudo deploy/firewall.example.sh
# 这些规则重启后不保留,要用 iptables-persistent 之类保存,或者写进开机脚本。
set -euo pipefail

# 宿主机上所有本机地址(容器经这些地址都能到宿主机)
HOST_ADDRS=$(ip -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -v ':')

# Docker 把发布的端口做了 DNAT:容器经宿主机地址访问 3000 时,到 DOCKER-USER 链时目标地址已经改成 Dokploy 容器的地址。
# 所以按 conntrack 记下的“改写前的目标”来认:原始目标是宿主机地址、原始端口是 3000、并且是从容器的网桥进来的,才拒绝。
# - 只认宿主机地址:Traefik 访问应用容器(包括监听 3000 的模板应用)的原始目标是容器地址,不受影响;
# - 只认容器网桥(docker0、br-*、docker_gwbridge):管理员从外面访问 Dokploy 是从物理网卡进来的,不受影响。
for iface in docker0 'br-+' docker_gwbridge; do
  for addr in $HOST_ADDRS; do
    rule=(-i "$iface" -p tcp -m conntrack --ctorigdst "$addr" --ctorigdstport 3000 --ctdir ORIGINAL -j REJECT)
    iptables -C DOCKER-USER "${rule[@]}" 2>/dev/null || iptables -I DOCKER-USER "${rule[@]}"
  done
done

echo "已添加。验证(三项都要做):"
echo "  1. 在一个员工应用的容器里 curl http://<宿主机地址>:3000,应该连不上;"
echo "  2. 已上线的应用(包括监听 3000 端口的模板应用)照常能打开;"
echo "  3. 管理员从管理网段仍能打开 Dokploy。"
