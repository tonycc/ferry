# 应用模板

agent 为员工新建应用时,从这里的模板起步。模板定得越死,自动部署的成功率越高。

每个模板必须满足的约定:

- 根目录有 `app.yaml`(结构见 `packages/manifest`)和 `Dockerfile`。
- 监听 `PORT` 环境变量指定的端口。
- 提供健康检查接口(默认 `/healthz`),正常时返回 200。
- 数据库连接串只从 `DATABASE_URL` 环境变量读取,不写在代码里。
- 迁移命令可以重复执行:每次发布都会跑一遍。
- 不要自己做注册登录。访问应用前 Ferry 的登录网关已经确认了访问者是谁,并按应用的可见范围放行,
  放行时把访问者身份放在请求头里:`X-Ferry-User-Id`(用户 ID)、`X-Ferry-User-Name`(姓名,UTF-8 百分号编码,
  用 `decodeURIComponent` 解码)、`X-Ferry-User-Departments`(所属部门 ID,逗号分隔)。示例见 `node-postgres/src/server.ts` 的 `visitor()`;静态页面用 `fetch("/whoami")`,见 `static/public/app.js`。
- `/__ferry/` 开头的路径是网关保留的,应用收不到这些请求。

模板只用 Node.js 一套运行环境,代码用 TypeScript,构建时做类型检查(以后内网镜像源只需要准备 npm 一套)。
每个模板的 README.md 第一段是给 agent 看的简介,`list_templates` 会返回它。

目前的模板:

- `node-postgres`:TypeScript 加 PostgreSQL,需要保存数据的网页应用。
- `static`:静态网页,没有数据库;页面通过 `/whoami` 读取访问者身份。
