#!/usr/bin/env bash
# 给某人生成初始密码(第一个管理员登录控制台之前只能用这个办法)。在服务器上运行:
#   deploy/set-password.sh <手机号、工号或用户 ID>
# 在运行中的 Ferry 容器里执行,用的是容器里的 tsx,不联网。
set -euo pipefail
if [ $# -ne 1 ]; then
  echo "用法:$0 <手机号、工号或用户 ID>" >&2
  exit 1
fi
cd "$(dirname "$0")"
exec docker compose exec ferry node_modules/.bin/tsx src/cli/set-password.ts "$1"
