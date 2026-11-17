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
| REST 接口、MCP 工具(5 个) | 已实现,本地验证过 |
| Dokploy 对接(`adapters/dokploy.ts`) | 未实现,只有接口和说明 |
| 密钥扫描、通知 | 只有假实现 |
| 持久化(PostgreSQL) | 已实现,有测试;设置 `DATABASE_URL` 后启用,启动时自动执行数据库迁移。不设置时用内存存储 |
| 服务重启后继续执行未完成的发布 | 已实现,有测试(需要 PostgreSQL 存储;假定同一时间只运行一个 Ferry 实例) |
| 登录(钉钉或企业微信工作通知验证码)、agent 个人令牌 | 未实现,开发时相信 `x-ferry-user` 和 `x-ferry-department` 请求头 |
| 组织架构与“本部门可见”判定(同部门或上级部门) | 判定已实现,有测试;组织架构目前在内存里,还没有从钉钉、企业微信同步 |
| 回滚和下线的对外接口(`rollback_app`、`unpublish_app`) | 未实现 |
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

```bash
DATABASE_URL=postgres://ferry:ferry-dev@127.0.0.1:55432/ferry pnpm dev
```

不设置 `DATABASE_URL` 时用内存存储,重启后数据丢失。数据库迁移在服务启动时自动执行;
修改 `apps/publisher/src/db/schema.ts` 后,用 `pnpm --filter @ferry/publisher db:generate` 生成新的迁移文件。

服务监听 `http://127.0.0.1:8080`,MCP 入口是 `POST /mcp`。默认全部使用假实现,发布会立刻成功。
管理员的用户 ID 通过环境变量 `ADMIN_USERS` 指定(逗号分隔),管理接口在 `/api/admin/apps` 下。
上传的代码包保存在 `ARCHIVE_DIR`(默认 `apps/publisher/data/archives`),单个上限 `MAX_ARCHIVE_MB`(默认 100)。

```bash
pnpm dev:console
```

```bash
pnpm test
```

上面只跑内存存储。下面这条把存储相关的测试在 PostgreSQL 上再跑一遍(需要先 `pnpm db:up`),
每个测试文件会建一个自己的测试库:

```bash
pnpm test:pg
```

```bash
pnpm typecheck
```

配置项见 `apps/publisher/src/config.ts`。

## 建议的下一步

详见[任务规划](docs/task-plan.md)。最先可以做的:

1. 在真实 Dokploy 实例上确认上传部署、执行命令、按需备份三个接口,再实现 `adapters/dokploy.ts`。
   上传部署接口如果不能用 API key 调用,Ferry 这一侧的上传不受影响,但需要另找办法把代码包交给 Dokploy。
