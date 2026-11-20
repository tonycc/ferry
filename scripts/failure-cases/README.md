# 典型失败案例(任务 2.5)

用来检查 Ferry 在发布失败时给 agent 的信息够不够它自己修好。案例都从 node-postgres 模板(TypeScript)改出来,每个只埋一个问题:

| 编号 | 问题 | 预期的错误类型 |
|---|---|---|
| c01 | 依赖版本不存在(`pg@^8.99.0`) | build_failed |
| c02 | Dockerfile 的 CMD 指向不存在的文件 | start_failed |
| c03 | 启动时查询不存在的表 | start_failed |
| c04 | 迁移 SQL 拼错(`alter tabel`) | migration_failed |
| c05 | 迁移给不存在的字段建索引 | migration_failed |
| c06 | app.yaml 的 migrate 指向不存在的 npm 脚本 | migration_failed |
| c07 | 端口写死成 8080 | healthcheck_failed(502) |
| c08 | 只监听 127.0.0.1 | healthcheck_failed(502) |
| c09 | app.yaml 的 healthcheck 路径不存在 | healthcheck_failed(404) |
| c10 | 健康检查接口查询不存在的表 | healthcheck_failed(500) |
| c11 | 线上已有正常版本,新版本启动即崩溃 | start_failed,线上恢复为旧版本(ROLLED_BACK) |
| c12 | TypeScript 类型错误(属性名拼错) | build_failed,logs 里有 文件(行,列): error TS… |
| c13 | 数据库连接串写死了密码(作为 DATABASE_URL 的后备值) | scan_failed |
| c14 | 钉钉群机器人 webhook 写死在代码里(新增记录时发通知) | scan_failed |

## 用法

先按 README 起本机 Dokploy 和 Ferry(`FERRY_PLATFORM=dokploy`、`NOTIFY_VIA=log`),跑案例时把
`MAX_APPS_PER_USER` 调大。每轮用新的应用名:下线的应用重新发布时会恢复原来的数据库,同名重跑会受上一轮影响。

```bash
python3 -I scripts/failure-cases/make_cases.py packages/templates/node-postgres <案例目录>
```

- **看 Ferry 返回的错误**:`run_case.py` 像 agent 一样走 prepare、上传、发布、轮询,把最终的发布状态存成 JSON。
  同时构建的应用不要超过三四个,否则构建变慢,可能误判。
- **盲测 agent**:把一个案例的 `app` 目录复制到空目录,在那里运行
  `claude -p "帮我把 <目录> 里的应用发布上去……直接发布,不用再问我" --strict-mcp-config --mcp-config <只含 ferry 的配置>`,
  再到 Ferry 的数据库里看这个应用的发布记录。

## 2026-11-18 的结果(模板还是 JavaScript 时)

改进前,直接发布看 Ferry 返回的错误:

- 启动即崩溃和构建失败都报“构建或启动失败”,要等 3 分钟启动超时,日志是几次重启的输出混在一起(5 千到 6 千字)。
- 健康检查失败一律报“没有通过”,分不清是没监听端口、路径不对还是接口报错。
- 机器忙时 Dokploy 创建数据库只等 45 秒就报错,发布以 `internal_error` 结束,也没有提示。
- 线上已有版本时新版本启动即崩溃,应用直接不可用(Swarm 回滚用的是同一个镜像标签),Ferry 却只报普通的可修复失败。

改进后,用 Claude Code 盲测全部 11 个案例,都在没有人工提示的情况下上线:

- 7 个在第一次发布前就被 agent 读代码发现并修好(c01 c04 c05 c06 c07 c08 c10);
- 4 个靠 Ferry 返回的错误修好(c02、c03、c09、c11),每个最多失败两次。

这一轮还发现两个问题并已修复:start_failed 的提示让 agent 把建表语句加进迁移,但迁移在启动之后才执行,解决不了
(改为说明发布顺序);启动即崩溃的容器会短暂显示为运行中,被当成启动成功(改为要连续运行 8 秒)。
修复后重跑 c03、c11:c03 在发布前就按说明改好,c11 失败一次、线上恢复为旧版本、第二次上线。

## 2026-11-20 密钥扫描(任务 3.1)

- 两个模板和 c01 到 c12 用真实的 gitleaks 扫描都没有误报;c13、c14 都被拦下,logs 只有文件、行号和密钥种类。
- Claude Code 盲测:c13 在发布前就去掉了写死的连接串,一次上线。c14 第一轮 agent 发布前发现了 webhook,
  停下来问用户,选项里还有“原样发布”(扫描一定会拦)。原因是给 agent 的使用说明只写了不要写密钥,
  没说会被拦截,也没说第三方密钥怎么办;补上后重跑,agent 发布前就改为从 DINGTALK_WEBHOOK 读取、没配置时不发通知,直接上线。
  另一轮让 agent 不检查代码直接打包:被 scan_failed 拦下后按提示做了同样的修改,第二次上线。
