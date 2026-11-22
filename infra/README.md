# infra

本地开发用的依赖和脚本。在服务器上部署 Ferry 见 [deploy/README.md](../deploy/README.md)(任务 3.6)。

- `docker-compose.dev.yml`:本地开发用的 PostgreSQL,主机端口 55432(避开本机已有的 5432)。
  publisher 设置 `DATABASE_URL` 后使用它,`pnpm test:pg` 也用它建测试库。
- `dokploy/setup-local.sh`:在本机 Docker Desktop(macOS)上安装 Dokploy,仅用于本地开发。
  会开启 Docker 的 Swarm 模式;管理页面在 http://localhost:3000,Traefik 占用 80 和 443。
  官方安装脚本只支持 Linux,这里照着它手动执行,差别写在脚本注释里。可以重复运行,已存在的部分会跳过。
  `/etc/dokploy` 在 Docker Desktop 虚拟机里而不在 macOS 上,Docker Desktop 重启后可能丢失,届时重新运行本脚本。
- `dokploy/teardown-local.sh`:卸载上面安装的 Dokploy 并关闭 Swarm(会删除 Dokploy 部署的所有服务和数据,运行时要求确认)。
- `traefik/forward-auth.example.yml`:在 Traefik 上给 `*.apps.<域名>` 统一挂登录和权限判定的示例,
  没有在真实环境验证过,域名和地址都是占位符。
