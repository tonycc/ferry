# 应用模板

agent 为员工新建应用时,从这里的模板起步。模板定得越死,自动部署的成功率越高。

每个模板必须满足的约定:

- 根目录有 `app.yaml`(结构见 `packages/manifest`)和 `Dockerfile`。
- 监听 `PORT` 环境变量指定的端口。
- 提供健康检查接口(默认 `/healthz`),正常时返回 200。
- 数据库连接串只从 `DATABASE_URL` 环境变量读取,不写在代码里。
- 迁移命令可以重复执行:每次发布都会跑一遍。

目前的模板:

- `node-postgres`:Node.js 加 PostgreSQL 的最小示例。
