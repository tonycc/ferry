#!/bin/bash
# 卸载 setup-local.sh 在本机安装的 Dokploy,并关闭 Swarm。
#
# 会删除:Dokploy 的服务、Traefik 容器、密钥、网络、数据卷(Dokploy 的数据库和配置),
# 以及通过 Dokploy 部署的所有应用和数据库服务(关闭 Swarm 时一并删除)。
# 不影响用 docker run 或 docker compose 启动的其他容器。
set -uo pipefail

read -r -p "将删除本机 Dokploy 及其部署的所有服务和数据,并关闭 Swarm。继续吗?[y/N] " answer
[ "$answer" = "y" ] || { echo "已取消"; exit 0; }

docker service rm dokploy dokploy-postgres 2>/dev/null
docker rm -f dokploy-traefik 2>/dev/null
# 等服务的容器退出,否则网络和数据卷还在被占用
sleep 5
docker secret rm dokploy_postgres_password dokploy_auth_secret 2>/dev/null
docker network rm dokploy-network 2>/dev/null
docker volume rm dokploy dokploy-postgres 2>/dev/null
docker swarm leave --force
# 清空 Docker Desktop 虚拟机里的 /etc/dokploy
docker run --rm --entrypoint sh -v /etc/dokploy:/x postgres:16 -c 'rm -rf /x/* /x/.[!.]*' 2>/dev/null

echo "已卸载"
