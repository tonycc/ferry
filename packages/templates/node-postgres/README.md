# node-postgres

TypeScript(Node.js 标准库的 http 模块)加 PostgreSQL 的网页应用。适合表单、登记、清单、台账、报表这类需要保存数据的应用。

## 文件

- `app.yaml`:发布清单。`name` 改成应用名,`visibility` 改成用户选定的可见范围(self 仅自己、department 本部门、company 全公司)。
- `src/server.ts`:应用代码。`/healthz` 是健康检查接口,要保留,数据库连不上时返回非 200。
- `src/migrate.ts`:执行迁移的脚本,每次发布都会运行,一般不用改。
- `migrations/`:数据库结构变更,按文件名顺序执行,每个文件只执行一次。改表结构时新增一个文件(如 `002_add_amount.sql`),不要改已经发布过的文件。
- `package.json`:依赖。运行时用的写在 `dependencies`,只在编译时用的(类型定义等)写在 `devDependencies`,版本号要真实存在。
- `tsconfig.json`:TypeScript 设置(严格模式),一般不用改。
- `Dockerfile`:构建时先做类型检查并编译到 `dist/`,类型错误会让发布失败。一般不用改。

## 发布前先自己检查

本地有 Node.js 时,发布前在应用目录里运行:

```bash
npm install && npx tsc --noEmit
```

没有报错再打包发布,类型错误(字段名写错、参数类型不对)在这一步就能发现。
打包时不要把 `node_modules` 和 `dist` 打进代码包。

## 约定

- 端口从 `PORT` 环境变量读取,数据库连接串从 `DATABASE_URL` 读取,不要写死。
- 发布顺序是先启动新代码、再执行迁移:启动阶段不要查询业务表(`server.ts` 在收到请求时才查询),
  否则用到这次迁移才建的表时,应用会一启动就崩溃。
- 不要做注册登录:访问者是谁从请求头读取,见 `server.ts` 里的 `visitor()`。
- 页面可以直接在 `server.ts` 里拼 HTML(记得用 `escapeHtml` 转义用户输入),
  也可以在页面里用浏览器端的 JavaScript 调用应用自己的 JSON 接口。
