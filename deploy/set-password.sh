#!/usr/bin/env bash
# 给某人生成初始密码;带 --name 时建平台管理员(第一个管理员只能这样建)。在服务器上运行:
#   deploy/set-password.sh <手机号、工号或用户 ID>
#   deploy/set-password.sh <手机号> --name <姓名> [--org <公司名>]
# 在运行中的 Ferry 容器里执行,用的是容器里的 tsx,不联网。
set -euo pipefail
if [ $# -lt 1 ]; then
  echo "用法:$0 <手机号、工号或用户 ID>" >&2
  echo "      $0 <手机号> --name <姓名> [--org <公司名>](建管理员)" >&2
  exit 1
fi
cd "$(dirname "$0")"
exec docker compose exec ferry node_modules/.bin/tsx src/cli/set-password.ts "$@"
