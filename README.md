# Ferry

把员工用 agent 做出的应用“渡”到企业内部服务器上。员工在 agent 里确认发布,Ferry 自动完成
密钥扫描、建数据库、绑域名、构建部署、数据库迁移和健康检查,最后返回访问地址。
发布不需要任何人审批;平台管理员可以随时停用任意应用。

Ferry 是夹在 agent 和 Dokploy 之间的发布编排层:只有它持有平台凭据,agent 和员工都只和它打交道。

文档:[产品设计方案](docs/product-design.md) · [任务规划](docs/task-plan.md)

## 当前状态

这是项目骨架。发布流程的逻辑是完整的并有测试覆盖,但**所有外部系统都还是内存假实现**:

| 部分 | 状态 |
|---|---|
| 发布状态机、配额、可见范围判定、失败回传与回滚 | 已实现,有测试 |
| 管理员停用和恢复应用(后端接口) | 已实现,有测试 |
| 代码包上传(一次性上传地址、本地目录存储、用旧包回滚) | 已实现,有测试,本地用真实 zip 验证过 |
| REST 接口、MCP 工具(7 个) | 已实现,本地验证过 |
| Dokploy 对接(`adapters/dokploy.ts`)、真实健康检查 | 已实现,对本机 Dokploy 的集成测试通过;经 MCP 完整发布模板应用已验证(M1 验收) |
| 密钥扫描、通知 | 只有假实现 |
| 持久化(PostgreSQL) | 已实现,有测试;设置 `DATABASE_URL` 后启用,启动时自动执行数据库迁移。不设置时用内存存储 |
| 服务重启后继续执行未完成的发布 | 已实现,有测试(需要 PostgreSQL 存储;假定同一时间只运行一个 Ferry 实例) |
| 验证码登录、agent 个人令牌 | 已实现,有测试。验证码目前只能打印在日志里(`NOTIFY_VIA=log`,本地开发用),钉钉工作通知待 P5。开发用的 `x-ferry-user` 请求头身份默认关闭 |
| 登录网关(访问应用要先登录,按可见范围放行,把访问者身份传给应用) | 已实现,有测试,在本机 Dokploy 上端到端验证过。Ferry 停了时所有应用都无法访问 |
| 组织架构与“本部门可见”判定(同部门或上级部门) | 已实现,有测试。组织架构定时从数据源同步(本地用 `ORG_FILE` 指向的文件,示例 `infra/dev-org.json`),存进 PostgreSQL,重启后直接恢复;有问题的快照整份拒绝。钉钉数据源待 P5 |
| 手动回滚和下线(`rollback_app`、`unpublish_app`) | 已实现,有测试,在本机 Dokploy 上端到端验证过。下线 30 天后自动删除数据还没有实现(任务 2.12) |
| 控制台 | 只有应用列表页,没有管理页面 |
| 生产部署配置 | 未写 |

## 目录结构

```
apps/
  publisher/            发布编排服务
    src/api/            REST 接口、登录网关的 /authz、MCP 入口
    src/mcp/            给 agent 的 MCP 工具
    src/workflow/       发布状态机(engine)、状态定义、存储接口
    src/adapters/       外部系统接口(types)、假实现(fake)、代码包存储、Dokploy 适配器(未实现)和客户端
    src/authz/          应用访问权限判定
    src/db/             PostgreSQL 表结构(尚未接入)
    src/service.ts      REST 和 MCP 共用的业务入口
  console/              “我的应用”网页
packages/
  manifest/             app.yaml 的结构定义与校验
  templates/            给 agent 用的应用模板
infra/                  本地开发依赖和登录网关配置示例
```

## 发布流程

```
PENDING → VALIDATING → PROVISIONING → BUILDING → MIGRATING → VERIFYING → LIVE
```

- 可修复的失败(扫描、构建、迁移、健康检查)进入 `FAILED_FIXABLE`,错误里带日志和修复提示,agent 改完代码重新发布。
- 健康检查失败且有上一个版本时,自动把上一个版本部署回去,进入 `ROLLED_BACK`。只回滚代码,不动数据库。
- 同一应用连续失败 3 次,或遇到不可修复的错误,进入 `FAILED` 并通知负责人。
- 没有审批环节。每一步开始前会检查应用是否已被管理员停用,停用后发布立即终止并停止服务。
- 每一步都先检查资源是否已创建,所以重新发布不会建出第二个数据库。例外:建好资源、还没记下 ID 时进程退出,
  恢复后会再建一个,旧的成为孤儿资源。接 Dokploy 时改为按名称查找已有资源(任务 1.4、1.5)。
- 服务重启后自动继续执行上次没跑完的发布。迁移中断时重跑迁移但不重复备份;
  健康检查阶段中断时退回构建,重新部署这次的版本(中断时可能正在回滚到旧版本)。

agent 的调用顺序:`prepare_app` → 把应用目录打成 zip 上传到返回的 `uploadUrl` → 用返回的 `version` 调用 `publish_app` → 轮询 `get_publish_status`。
每次发布都要重新走一遍,因为上传地址只能用一次,默认 15 分钟过期。员工不参与这些步骤,只需要确认发布。

```bash
curl -T app.zip "<uploadUrl>"
```

## 本地运行

需要 Node.js 22 以上和 pnpm。

```bash
pnpm install
```

启动本地 PostgreSQL(Docker,主机端口 55432):

```bash
pnpm db:up
```

配置写在项目根目录的 `.env` 里(从 `.env.example` 复制),`pnpm dev` 启动时自动读取;
终端里已设置的同名环境变量优先。`.env` 不会提交到 git,API key 等密钥只放在这里。

```bash
cp .env.example .env
```

在 `.env` 里取消 `DATABASE_URL` 那一行的注释后:

```bash
pnpm dev
```

不设置 `DATABASE_URL` 时用内存存储,重启后数据丢失。数据库迁移在服务启动时自动执行;
修改 `apps/publisher/src/db/schema.ts` 后,用 `pnpm --filter @ferry/publisher db:generate` 生成新的迁移文件。

服务监听 `http://127.0.0.1:8080`,MCP 入口是 `POST /mcp`。默认全部使用假实现,发布会立刻成功。
管理员的用户 ID 通过环境变量 `ADMIN_USERS` 指定(逗号分隔)。管理员登录后打开 `/admin` 可以查看全部应用、停用和恢复;
接口在 `/api/admin/apps` 下。
每个应用和它的数据库默认最多用 1 核 CPU、512 MB 内存(`APP_CPU_LIMIT`、`APP_MEMORY_LIMIT_MB`、`DB_CPU_LIMIT`、`DB_MEMORY_LIMIT_MB`,设为 0 不限制),
在每次发布时生效。
上传的代码包保存在 `ARCHIVE_DIR`(默认 `apps/publisher/data/archives`),单个上限 `MAX_ARCHIVE_MB`(默认 100)。
每次发布结束后清理该应用的代码包:保留线上版本、最近两个上线过的版本、进行中的发布用到的版本,以及 `ARCHIVE_GRACE_HOURS`(默认 24)小时内上传的。
迁移前备份存在 Dokploy 所在服务器的 `/etc/dokploy/ferry-backups/<数据库>/`,每个数据库保留最新 `BACKUP_KEEP`(默认 5)份。

```bash
pnpm dev:console
```

```bash
pnpm test
```

推送到 main 和每个 PR 都会在 GitHub Actions 上自动跑类型检查和下面两套测试(`.github/workflows/ci.yml`);
对接 Dokploy 的集成测试只在本机跑。

上面只跑内存存储。下面这条把存储相关的测试在 PostgreSQL 上再跑一遍(需要先 `pnpm db:up`),
每个测试文件会建一个自己的测试库:

```bash
pnpm test:pg
```

下面这条对本机 Dokploy 跑适配器的集成测试(需要先用 `infra/dokploy/setup-local.sh` 安装,并在 `.env` 里配好
`DOKPLOY_URL`、`DOKPLOY_API_KEY`)。会建一个临时项目、数据库并真实构建两次,约 3 分钟,结束时自动删除(包括数据库的数据卷和备份文件):

```bash
pnpm test:dokploy
```

```bash
pnpm typecheck
```

### 登录和身份

- **网页**:打开 http://127.0.0.1:8080/login ,输入工号或手机号,把收到的验证码填回去。本地开发时验证码打印在服务日志里
  (`NOTIFY_VIA=log`,形如 `[通知 → dingtalk:alice] Ferry 登录验证码:123456`)。登录后在 http://127.0.0.1:8080/me 生成个人令牌。
- **agent**:把个人令牌配进 agent 的 MCP 配置,请求头 `Authorization: Bearer fry_...`。MCP 只认个人令牌。
- **开发用请求头**:`DEV_AUTH=true` 时,没带凭据的请求可以用 `x-ferry-user` 自称是谁,方便调试;默认关闭。
- 所属部门一律从组织架构查。示例组织架构 `infra/dev-org.json`(工号在括号里):`dingtalk:alice`(财务部,A001)、
  `dingtalk:bob`(财务部,A002,手机号 13800000002)、`dingtalk:dave`(财务部下的应付组,A003)、`dingtalk:carol`(销售部,B001)、
  `dingtalk:admin`(信息部,IT01)。改了文件后最长 `ORG_SYNC_MINUTES`(默认 60)分钟生效,或重启服务立即生效。
- **访问员工应用**:Ferry 启动时(`FERRY_PLATFORM=dokploy`)把登录网关写进 Traefik,并给所有在线应用的域名挂上。
  没登录的访问者会被带到 Ferry 登录,再带着一次性票据回到应用,拿到只对这个应用有效的 cookie(12 小时,`GATEWAY_COOKIE_HOURS`)。
  应用从请求头 `X-Ferry-User-Id`、`X-Ferry-User-Name`(百分号编码)、`X-Ferry-User-Departments` 读到访问者,见模板。
  Traefik 访问 `/authz` 的地址默认是 `http://host.docker.internal:<PORT>/authz`(`GATEWAY_AUTH_URL`);
  建议设置固定的 `GATEWAY_SECRET`,否则每次重启后访问者要重新跳转一次。**Ferry 停了时所有应用都无法访问。**
- 组织架构为空时谁都无法登录(包括管理员),所以接入真实环境前要先能同步到组织架构。
- 登录 cookie 只发给 Ferry 自己的域名,不发给员工应用;用 cookie 做修改操作时要求请求来自 Ferry 自己的页面
  (来源不是 `PUBLIC_URL` 时,加到 `ALLOWED_ORIGINS`)。

配置项见 `apps/publisher/src/config.ts`。

### 对接本机 Dokploy 完整发布一次

先用 `infra/dokploy/setup-local.sh` 装好 Dokploy,在 `.env` 里配好 `DOKPLOY_URL`、`DOKPLOY_API_KEY`、`DATABASE_URL`,
并取消 `FERRY_PLATFORM=dokploy`、`APPS_DOMAIN=apps.localhost`、`APPS_URL_SCHEME=http` 的注释,然后 `pnpm dev`。
下面这条模拟 agent,经 MCP 把模板应用发布为 `ledger-demo`,成功后访问 http://ledger-demo.apps.localhost:

```bash
FERRY_TOKEN=fry_你的个人令牌 python3 -I scripts/mcp-publish.py http://127.0.0.1:8080 packages/templates/node-postgres ledger-demo /tmp
```

## 建议的下一步

详见[任务规划](docs/task-plan.md)。最先可以做的:

1. 在真实 Dokploy 实例上确认上传部署、执行命令、按需备份三个接口,再实现 `adapters/dokploy.ts`。
   上传部署接口如果不能用 API key 调用,Ferry 这一侧的上传不受影响,但需要另找办法把代码包交给 Dokploy。
