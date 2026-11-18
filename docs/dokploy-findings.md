# Dokploy 接口实测结论(任务 1.1、1.3)

2026-11-17 在本机 Dokploy v0.31.3(`infra/dokploy/setup-local.sh` 安装)上,用 API key 逐个调用接口得出。
接口文档可以从实例导出:`GET /api/settings.getOpenApiDocument`(约 800KB,共 644 个接口)。

## 三个关键问题

| 问题 | 结论 | 做法 |
|---|---|---|
| 上传代码包部署能否用 API key 调用 | **能** | `application.dropDeployment`,multipart 表单,字段 `applicationId` 和 `zip` |
| 有无执行一次性命令的接口 | **没有专门的接口,但能做到** | 建一个不会自动触发的定时任务,再手动触发一次,见下文 |
| 有无按需备份的接口 | **有,但只能备份到 S3 兼容存储** | 先配置备份目的地,再给每个数据库建一条备份配置,用 `backup.manualBackupPostgres` 触发,见下文。**一期不用它**,改为备份到服务器本机,见“迁移前备份到服务器本机” |

## 鉴权

所有接口用请求头 `x-api-key` 鉴权,接口地址是 `/api/<模块>.<方法>`。读用 GET 加查询参数,写用 POST 加 JSON。
API key 在 Dokploy 管理页面的个人设置里生成,Ferry 从 `.env` 的 `DOKPLOY_API_KEY` 读取。

## 部署一个应用需要的调用

按顺序:

1. `project.create {name}`:返回 `project` 和默认的 `environment`。**应用和数据库都建在环境(environmentId)下,不是直接建在项目下。**
2. `postgres.create {name, appName, databaseName, databaseUser, databasePassword, dockerImage, environmentId}`,
   然后 `postgres.deploy {postgresId}` 才会真正启动数据库。
3. `application.create {name, appName, environmentId}`。
4. `application.saveBuildType`:设为 `dockerfile`。这个接口要求把所有字段都传上(`dockerfile`、`dockerContextPath`、
   `dockerBuildStage`、`herokuVersion`、`railpackVersion`),不需要的传空字符串或 null。
5. `application.saveEnvironment {applicationId, env, buildArgs, buildSecrets, createEnvFile}`:`env` 是 `KEY=value` 按行拼接的
   **整段文本,会覆盖原有的全部变量**,不是合并。Ferry 适配器里的 `setEnv` 要先读出原值、合并后再整体写回。
6. `domain.create {host, port, https: false, certificateType: "none", applicationId, domainType: "application"}`。
7. `application.dropDeployment`(multipart):上传 zip 并开始构建。**接口立即返回**,构建在后台进行。
8. 轮询 `deployment.all?applicationId=` 看最新一条的 `status`:`running` → `done` 或 `error`。

注意:

- **Dokploy 会给 `appName` 加随机后缀**,如传 `ferry-probe-db` 实际得到 `ferry-probe-db-mvxu36`。
  数据库在内部网络里的主机名就是这个带后缀的名字,拼连接串时要用接口返回的值。
- **连接串由 Ferry 自己拼**:`postgresql://<用户>:<密码>@<数据库 appName>:5432/<库名>`,用户名和密码是 Ferry 建库时传进去的。
- **部署显示 `done` 后,前几秒访问会返回 502**(容器还在启动)。健康检查要重试几次,不能只查一次。
- 新建应用时不用指定 `sourceType`,第一次上传代码包后会自动变成 `drop`。

## 执行一次性命令(数据库迁移)

1. `schedule.create {name, cronExpression, command, shellType: "sh", scheduleType: "application", applicationId, enabled: false}`。
   `enabled: false` 加上一个很少触发的 cron 表达式,保证它不会自动运行。
2. `schedule.runManually {scheduleId}`:**同步执行,命令结束才返回**,结果是 `{status: "done" | "error", deploymentId, logPath}`。
3. 命令以 `docker exec <应用容器> sh -c <命令>` 的方式在**正在运行的应用容器**里执行,能读到应用的环境变量(包括 `DATABASE_URL`)。

实测:`node migrate.js` 成功建表;不存在的脚本返回 `status: "error"`;用 `node -e` 写入一行数据后,应用页面显示 1 条记录。

对 Ferry 的影响:

- 迁移必须在应用容器启动之后执行,和发布状态机的顺序(BUILDING → MIGRATING)一致。
  但在迁移完成之前,新版本已经在对外提供服务,可能短暂报错(实测迁移前首页返回 500)。
- 每次执行都会留下一个定时任务记录。适配器应当每个应用只建一个“迁移”任务,之后用 `schedule.update` 改命令再触发,或执行完用 `schedule.delete` 删除。

## 按需备份数据库

Dokploy 的备份只能存到 S3 兼容存储(AWS S3、MinIO、SeaweedFS 等),不能直接存到本地磁盘或网络目录。

1. `destination.create {name, provider, accessKey, secretAccessKey, bucket, region, endpoint, additionalFlags}`:
   整个平台配一次。自建存储用 `provider: "Other"`,`additionalFlags: ["--s3-force-path-style"]`。
   可以先用 `destination.testConnection`(参数相同)检查能否连上。
2. `backup.create {schedule, enabled: false, prefix, destinationId, database, databaseType: "postgres", postgresId, backupType: "database"}`:
   每个数据库建一次,`enabled: false` 表示不定时执行。**这个接口返回 null**,`backupId` 要从 `postgres.one` 返回的 `backups` 里取。
3. `backup.manualBackupPostgres {backupId}`:执行一次备份。
4. 结果:`deployment.allByType?id=<backupId>&type=backup` 看状态,`deployment.readLogs` 看日志;
   文件在存储里的路径是 `<数据库 appName>/<prefix>/<时间>.sql.gz`,`backup.listBackupFiles` 可以列出。

实测:小数据库 0.5 秒返回,状态 `done`,存储里有一个 1177 字节的 `.sql.gz` 文件。
**还没确认大数据库时接口是否等备份完成才返回**,适配器要以 `deployment.allByType` 的状态为准,不能只看接口返回。

对 Ferry 的影响:

- 产品设计里“备份存放在独立存储上”、任务规划里的 P7(“一块独立磁盘或一个网络存储目录”)要改成
  **一个 S3 兼容存储**。企业没有现成的,可以自己部署 SeaweedFS 等开源方案。
- 发布单里记的 `backupId` 应当是这次备份的 deploymentId 或文件路径,而不是 Dokploy 的备份配置 ID,
  否则以后找不到迁移前的那一份。
- MinIO 社区版的镜像从本机已经拉不下来(见下文),本机测试改用 SeaweedFS(`chrislusf/seaweedfs`,约 1GB)。
  它不配置身份时不校验密钥,只适合本机测试。

## 迁移前备份到服务器本机(一期采用)

一期不做异地备份(不需要 S3 兼容存储),迁移前的备份改为导出到 Dokploy 所在服务器的本机磁盘。
它防不了服务器硬盘损坏,但能在迁移写坏数据时恢复。2026-11-17 实测可行:

1. `schedule.create {name, cronExpression, scheduleType: "dokploy-server", shellType: "bash", command, script, enabled: false}`。
   **`dokploy-server` 类型执行的是 `script` 字段,`command` 字段不会被执行**(但不能为空)。只填 `command` 时,
   生成的脚本里只有一行 echo,接口照样返回 `done`,什么都没做。
2. `schedule.runManually {scheduleId}`:返回 `{status: "done" | "error", deploymentId}`,脚本输出在 `deployment.readLogs` 里。
3. 脚本在 Dokploy 容器里执行,能用 `docker` 命令,`/etc/dokploy` 就是服务器上的同一个目录。实测脚本:

```bash
set -euo pipefail
mkdir -p /etc/dokploy/ferry-backups/<数据库 appName>
cid=$(docker ps -q -f name=^<数据库 appName>\. | head -n1)
docker exec "$cid" pg_dump -U <用户> -d <库名> | gzip > <文件>.tmp
mv <文件>.tmp <文件>
```

实测结果:

- 成功时状态 `done`,得到一个 796 字节的 `.sql.gz`,解压后能看到建表语句和数据;导入一个新库后数据完整。
- 库名写错时状态 `error`,日志里有 pg_dump 的报错。但 `.tmp` 文件会留下来,脚本要在失败时删掉它(如用 `trap`)。
- 数据库容器里用本地连接执行 pg_dump,不需要密码。
- 小数据库 0.2 秒返回。**还没确认大数据库时是否等导出完成才返回。**

对 Ferry 的影响:

- 平台只需要一个这样的定时任务。适配器每次用 `schedule.update` 改脚本再触发,或者执行完删除。
- 发布单里记录备份文件的完整路径,恢复时就用它。
- 文件只增不减,要定期清理(如每个应用保留最近几份),和代码包的保留策略(任务 1.6)一起做。
- 本机开发时,`/etc/dokploy` 在 Docker Desktop 虚拟机里,Docker Desktop 重启后备份可能丢失;企业服务器上是真实磁盘。
- 二期要做异地备份时,把这个目录同步到 S3 兼容存储,或改用下面 Dokploy 自带的备份。

## 部署完成不等于新容器已运行(任务 1.10 发现)

端到端发布时发现,`deployment.all` 显示 `done` 时:

- **新容器可能还没启动**。实测部署记录完成后 16 秒,容器才创建。这时执行迁移会报“找不到容器”。
- **旧容器可能还在运行**。Dokploy 先启动新容器、再停旧容器,两者会同时运行十几秒。
  这期间迁移和健康检查可能落在旧容器上,把旧版本误判为新版本可用(实测出现过:发布显示成功时新容器还没启动)。
- `docker.getServiceContainersByAppName` 返回的 `state` 是**期望状态**,还在启动的容器也是 `running`;
  实际状态要看 `currentState`(如 `Running 9 seconds ago`、`Starting 1 second ago`)。

所以适配器的 `deploy` 在部署记录完成后,还要等到:一个上传前没有的容器 `currentState` 以 `Running` 开头,
并且上传前的容器都不再运行。等不到时返回失败,附上应用日志。

## 启动即崩溃的新版本(任务 2.5 发现)

- **崩溃的容器能看到**。`docker.getServiceContainersByAppName` 也会列出已退出的任务(`currentState` 为 `Failed 3 seconds ago`,
  `error` 为 `task: non-zero exit (1)`)。Swarm 大约每 20 秒重启一次,所以新任务退出两次就可以判定为启动即崩溃,
  不必等到启动超时(原来要等 3 分钟)。
- **崩溃时线上版本也没了**。Dokploy 的服务更新配置是 `start-first` 加 `FailureAction: rollback`,
  但每个版本的镜像标签都是 `<appName>:latest`,Swarm 回滚回去的还是新的坏镜像:旧容器被停掉,服务上只剩反复崩溃的新容器。
  所以 Ferry 在新版本启动即崩溃时,要自己用保存的上一个代码包重新部署(和健康检查失败时一样)。构建失败时线上版本不受影响。
- **崩溃时读到的日志是几次启动混在一起的**。`application.readLogs` 返回所有任务的输出,每行带 Docker 的时间戳,顺序可能是乱的。
  按时间排序、只保留最后一次启动的输出后,通常只剩二三十行,第一屏就是报错。
- **`postgres.deploy` 只等 45 秒**。机器忙(多个应用同时构建)时新数据库启动更慢,接口返回 500
  (`did not converge within 45000ms`),但容器随后会正常运行。适配器在这种情况下继续等容器运行起来,不直接让发布失败。

## 健康检查(任务 1.9)

Ferry 经统一入口(Traefik,本机是 `http://127.0.0.1:80`)访问应用的健康检查路径,请求头 `Host` 设为应用域名。
这样 Ferry 所在的机器不需要能解析应用域名,也顺带验证了域名路由。部署完成后的几秒内会返回 502,
所以在限定时间内(默认 90 秒)反复检查,任意一次返回 2xx 即为健康。

接入登录网关(任务 2.3)后,未登录的请求会被拦下,健康检查请求需要网关放行。

## 登录网关(任务 2.3)

- `settings.updateTraefikFile {path, traefikConfig}` 能写 `/etc/dokploy/traefik/dynamic/` 下的文件,Traefik 自动加载。
  Ferry 启动时用它写 `ferry-gateway.yml`(中间件链:删身份头 → forwardAuth 到 `/authz` → 删健康检查口令)。
- 域名有 `middlewares` 字段(`domain.create`、`domain.update`),Ferry 给每个应用的域名挂 `ferry-gateway@file`。
  `domain.update` 需要 `domainId` 和 `host`,Ferry 每次传完整的期望状态;实测更新后路由、端口都正常。
- forwardAuth 的实测行为:
  - `/authz` 返回非 2xx 时,状态码、`Location`、`Set-Cookie` 都原样交给浏览器,所以“跳登录、回调设 cookie”可行。
  - **`/authz` 返回的相对地址会按 `/authz` 自己的地址补全**(实测跳到了 `host.docker.internal:28080/...`),所以必须返回完整地址。
  - 客户端的原始请求头(包括 Cookie、`X-Forwarded-Uri`)都会转给 `/authz`。
  - `authResponseHeaders` 只覆盖 `/authz` 返回了的请求头;**下划线写法(`X_Ferry_User_Id`)不会被删也不会被覆盖**,
    会原样到达应用,有的框架会把它当成 `X-Ferry-User-Id`。`/authz` 看到这类请求头就整个拒绝。
  - 放在 forwardAuth 之后的 headers 中间件能删掉请求头,健康检查口令就是这样不让应用收到的。
- 本机 Docker Desktop 里的容器能通过 `host.docker.internal` 访问只监听 127.0.0.1 的 Ferry。

## 读取日志

- `deployment.readLogs?deploymentId=&tail=`:构建日志和一次性命令的输出。失败时把它交给 agent。
- `application.readLogs?applicationId=&tail=&since=&search=`:应用运行时的日志。

## 删除

**`project.remove` 只删除 Dokploy 里的记录,不会停止和删除项目下的应用、数据库容器。** 实测删除项目后,
应用仍在运行,通过域名仍能访问;数据库的数据卷、Traefik 的路由文件也都留着。而且记录没了之后,
就再也无法通过接口删除它们,只能手动 `docker service rm`、删数据卷、删 `/etc/dokploy` 下的文件。

所以 Ferry 下线应用时(任务 2.6)要按这个顺序:先删定时任务(`schedule.delete`),再 `application.delete`、
`postgres.remove`,最后才 `project.remove`。实测按这个顺序删除后,服务、路由文件、应用文件都清理干净了。

**下线(任务 2.6)**:`application.delete` 删除应用和它的域名路由,之后查询容器会报“找不到服务”;
`postgres.stop` 停止数据库(约 5 秒),状态变为 `idle`,容器消失,数据卷保留。之后 `postgres.start`(约 22 秒)
或 `postgres.deploy` 都能重新启动,数据还在。Ferry 重新发布时用 `postgres.deploy`。

**`postgres.remove` 不删除数据库的数据卷**(`<数据库 appName>-data`)。下线后要保留数据时这正好合适;
真正要删除数据时(如保留期满),需要另外删除这个数据卷,目前没有找到对应的接口。

## 停止、启动和其他

- `application.stop` 后通过域名无法访问,`application.start` 后恢复,不需要重新构建(任务 1.4 的集成测试覆盖)。
- **构建失败时,线上正在运行的旧版本不受影响**,仍能正常访问。所以只有健康检查失败(新版本已经替换上线)时才需要回滚。
- `application.reload`、`postgres.stop` 等接口存在,还没有实测。

## 适配器的实现(任务 1.4)

`apps/publisher/src/adapters/dokploy.ts`,集成测试 `pnpm test:dokploy`。实现时的约定:

- 创建前先按名称查找,找到就复用。Ferry 建的项目统一加 `ferry-` 前缀,不会误用别人手动建的同名项目。
- 对外以项目 ID 作为引用,需要环境 ID 时在适配器里用 `project.one` 查默认环境。
- 部署前先等这个应用正在进行的部署结束;上传后只跟踪新出现的那条部署记录;有总的超时时间。
- 调用失败时,报错信息只有接口名和状态码,响应内容只写服务端日志:响应里可能有连接串和密码,而报错信息会经发布单传给 agent。
- 域名的 `https` 和证书类型是构造参数,本机默认 `false` 和 `none`,企业环境部署时(任务 3.6)再按证书情况设置。

任务 1.5 补充的部分:

- **数据库**:按名称 `<应用名>-db` 查找或新建,用户名和库名都是 `app`,密码随机生成。连接串用 `postgres.one` 读回的
  账号来拼,所以复用已有数据库时也能拿到。`postgres.deploy` 会等数据库启动后才返回,实测约 50 秒。
- **一次性命令**:每次新建一个定时任务、手动触发、执行完删除。执行前先找这个应用上次留下的 `ferry-command-*` 任务
  (进程中途退出时会留下),等它执行完再删掉,避免两次迁移同时作用于一个数据库。
- **迁移前备份**:同样新建、触发、删除一个 `dokploy-server` 任务。拼进脚本的名称只允许字母、数字和 `._-`。
  失败时抛出不含细节的错误(细节写服务端日志),发布终止,不会在没有备份的情况下迁移。
  返回值是备份文件在服务器上的路径,记在发布单里。
- 备份成功后,同一个脚本里删掉这个数据库更早的备份,只保留最新 `backupKeep` 份(默认 5,任务 1.6)。
- 还没处理的:进程在备份途中退出时会留下一个 `ferry-backup-*` 任务。它不会自动执行,无害,但目前没有找到按类型
  列出这类任务的接口,所以不会自动清理。

## 本机环境的问题

- Docker 配置了镜像加速(daocloud),部分镜像拉不下来:`minio/minio` 返回 403,`quay.io/minio/minio` 返回 401。
  `node:22-alpine`、`postgres:16`、Dokploy 自己的镜像都正常。
- 本机通过 `http://<名称>.apps.localhost` 访问应用,curl 和浏览器都能直接解析到本机。
