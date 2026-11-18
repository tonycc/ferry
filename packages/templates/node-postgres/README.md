# node-postgres

Node.js(只用标准库的 http 模块)加 PostgreSQL 的网页应用。适合表单、登记、清单、小型台账这类需要保存数据的应用。

## 文件

- `app.yaml`:发布清单。`name` 改成应用名,`visibility` 改成用户选定的可见范围(self 仅自己、department 本部门、company 全公司)。
- `Dockerfile`:构建方式,一般不用改。
- `server.js`:应用代码。`/healthz` 是健康检查接口,要保留,数据库连不上时返回非 200。
- `migrations/`:数据库结构变更,按文件名顺序执行,每个文件只执行一次。改表结构时新增一个文件(如 `002_add_amount.sql`),不要改已经发布过的文件。
- `migrate.js`:执行迁移的脚本,每次发布都会运行,一般不用改。
- `package.json`:依赖。新增依赖写在 `dependencies` 里,版本号要真实存在。

## 约定

- 端口从 `PORT` 环境变量读取,数据库连接串从 `DATABASE_URL` 读取,不要写死。
- 不要做注册登录:访问者是谁从请求头读取,见 `server.js` 里的 `visitor()`。
- 本地有 Node.js 时可以先 `npm install` 检查依赖能装上;发布时不要把 `node_modules` 打进代码包。
