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

## 读取日志

- `deployment.readLogs?deploymentId=&tail=`:构建日志和一次性命令的输出。失败时把它交给 agent。
- `application.readLogs?applicationId=&tail=&since=&search=`:应用运行时的日志。

## 删除

**`project.remove` 只删除 Dokploy 里的记录,不会停止和删除项目下的应用、数据库容器。** 实测删除项目后,
应用仍在运行,通过域名仍能访问;数据库的数据卷、Traefik 的路由文件也都留着。而且记录没了之后,
就再也无法通过接口删除它们,只能手动 `docker service rm`、删数据卷、删 `/etc/dokploy` 下的文件。

所以 Ferry 下线应用时(任务 2.6)要按这个顺序:先删定时任务(`schedule.delete`),再 `application.delete`、
`postgres.remove`,最后才 `project.remove`。实测按这个顺序删除后,服务、路由文件、应用文件都清理干净了。

**`postgres.remove` 不删除数据库的数据卷**(`<数据库 appName>-data`)。下线后要保留数据时这正好合适;
真正要删除数据时(如保留期满),需要另外删除这个数据卷,目前没有找到对应的接口。

## 停止、启动和其他

`application.stop`、`application.start`、`application.reload`、`postgres.stop` 等接口都存在,还没有逐个实测。

## 本机环境的问题

- Docker 配置了镜像加速(daocloud),部分镜像拉不下来:`minio/minio` 返回 403,`quay.io/minio/minio` 返回 401。
  `node:22-alpine`、`postgres:16`、Dokploy 自己的镜像都正常。
- 本机通过 `http://<名称>.apps.localhost` 访问应用,curl 和浏览器都能直接解析到本机。
