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
HOST_ADDRS=$(ip -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -v ':' )

for addr in $HOST_ADDRS; do
  # 容器发往宿主机地址的 3000 端口:拒绝。-I 插到最前面,已存在时跳过
  iptables -C DOCKER-USER -d "$addr" -p tcp --dport 3000 -j REJECT 2>/dev/null \
    || iptables -I DOCKER-USER -d "$addr" -p tcp --dport 3000 -j REJECT
done

# Docker 把发布的端口做了 DNAT,容器经宿主机地址访问时目标地址在 DOCKER-USER 里已经改成 Dokploy 容器的地址。
# 所以还要按“改写前的目标端口”拦一次(conntrack 记着原始目标)
iptables -C DOCKER-USER -p tcp -m conntrack --ctorigdstport 3000 --ctdir ORIGINAL -j REJECT 2>/dev/null \
  || iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 3000 --ctdir ORIGINAL -j REJECT

echo "已添加。验证:在一个员工应用的容器里 curl http://<宿主机地址>:3000 应该连不上;管理员从管理网段仍能打开 Dokploy。"
echo "注意:上面第二条也会拦住外部访问宿主机 3000 端口的请求,管理员访问 Dokploy 要按来源网段另外放行(写在它前面)。"
