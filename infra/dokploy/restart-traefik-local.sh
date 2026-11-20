#!/bin/bash
# 本机 Docker Desktop:重启 dokploy-traefik,并保住端口转发和它接入的网络(Linux 服务器上不需要)。
#
# Docker Desktop 只给启动时主网络是 bridge 的容器转发端口。Traefik 接着 overlay 网络(dokploy-network、
# 各应用的 ferry-<应用名>)重启后,从 macOS 访问 80、443 就没有响应了(实测)。
# 做法:记下接入的网络 → 断开所有 overlay 网络 → 重启 → 再接回去。改了 traefik.yml 后用它重启。
set -euo pipefail
T=dokploy-traefik

nets=$(docker inspect "$T" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')
case " $nets " in *" dokploy-network "*) ;; *) nets="$nets dokploy-network" ;; esac

for n in $nets; do
  if [ "$n" != bridge ] && docker inspect "$T" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | grep -qx "$n"; then
    docker network disconnect "$n" "$T"
  fi
done
docker restart "$T" >/dev/null
for n in $nets; do
  if [ "$n" != bridge ] && docker network inspect "$n" >/dev/null 2>&1; then
    docker network connect "$n" "$T"
  fi
done
echo "已重启 $T,接入的网络: $(docker inspect "$T" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
