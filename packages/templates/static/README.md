# static

静态网页,没有数据库。适合介绍页、说明文档、看板、只在浏览器里运行的小工具(计算器、表单生成器等)。
需要保存数据时用 node-postgres 模板。

## 文件

- `app.yaml`:发布清单。`name` 改成应用名,`visibility` 改成用户选定的可见范围(self 仅自己、department 本部门、company 全公司)。
- `public/`:页面、样式、脚本、图片都放这里,按路径原样返回(`/` 对应 `public/index.html`)。
  没有扩展名的路径找不到时也返回 `index.html`,单页应用可以用前端路由。
- `src/server.ts`:返回 `public/` 里文件的小服务,提供健康检查 `/healthz` 和访问者信息 `/whoami`,一般不用改。
- `package.json`、`tsconfig.json`、`Dockerfile`:构建设置,一般不用改。

## 约定

- 不要做注册登录:访问者是谁由 Ferry 的登录网关确认。页面里用 `fetch("/whoami")` 读取,
  返回 `{ id, name, departments }`(没有访问者信息时为 `null`),用法见 `public/app.js`。
- 页面里的脚本直接写在 `public/` 里,浏览器原样执行;不需要编译,也不要引用外网的脚本和字体(公司内网可能访问不到)。
- 本地有 Node.js 时,改了 `src/server.ts` 后可以先运行 `npm install && npx tsc --noEmit` 检查。
- 打包时不要把 `node_modules` 和 `dist` 打进代码包。
