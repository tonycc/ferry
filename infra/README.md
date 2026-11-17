# infra

平台组件的部署配置。目前只有本地开发用的依赖和一份登录网关配置示例,
生产环境的部署(Dokploy、依赖镜像源、备份存储、内网 DNS 和证书)还没有写。

- `docker-compose.dev.yml`:本地开发用的 PostgreSQL,主机端口 55432(避开本机已有的 5432)。
  publisher 设置 `DATABASE_URL` 后使用它,`pnpm test:pg` 也用它建测试库。
- `traefik/forward-auth.example.yml`:在 Traefik 上给 `*.apps.<域名>` 统一挂登录和权限判定的示例,
  没有在真实环境验证过,域名和地址都是占位符。
