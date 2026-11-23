# 部署 Ferry(任务 3.6)

在一台装好 Dokploy 的 Linux 服务器上,用这个目录里的配置部署 Ferry。
这套配置在本机(Mac + Docker Desktop + 本机 Dokploy)上完整验证过:用镜像启动、经 Traefik 登录、用个人令牌发布模板应用并上线、
打开应用时跳转 Ferry 登录再回到应用、重启后数据和登录都在。**真实域名和证书、Linux 上的防火墙还没有在企业环境里验证**,见文末。

| 文件 | 用途 |
|---|---|
| `../Dockerfile` | Ferry 的镜像:发布服务、构建好的控制台、应用模板、固定版本的 gitleaks(按架构下载并校验) |
| `docker-compose.yml` | Ferry 和它自己的 PostgreSQL |
| `.env.example` | 配置模板,复制为 `.env` 后填写 |
| `set-password.sh` | 建第一个平台管理员,或给某人生成初始密码 |
| `firewall.example.sh` | 防火墙示例(未验证) |

## 架构

```
浏览器、agent ──https──▶ Dokploy 的 Traefik ──▶ Ferry(ferry.公司域名)
                               │                   │  ├─ 调用 Dokploy 接口 http://dokploy:3000
                               │                   │  └─ 健康检查经 Traefik http://dokploy-traefik:80
                               │                   └─ 自己的 PostgreSQL(只在内部网络)
                               └─ 员工应用(*.apps.公司域名):每个请求先问 Ferry 的 /authz(http://ferry-publisher:8080/authz)
```

- Ferry 接入 Dokploy 的 `dokploy-network`,别名 `ferry-publisher`。员工应用不在这个网络里(任务 3.2),碰不到 Ferry 的内部地址。
- Ferry 和它的数据库都不发布宿主机端口。Ferry 自己的域名由容器标签告诉 Traefik,不用往 `/etc/dokploy` 里放文件。
  这个路由不挂登录网关,并且排除了 `/authz`:它只给 Traefik 在内部调用。
- **同一套 Dokploy 只能有一个 Ferry。** 登录网关配置、按名称复用的 Dokploy 资源、登录锁定计数、告警合并都假定只有一个实例。
  在服务器上试验时也不要另外再起一个。

## 第一次部署

### 1. 准备

- 一台 Linux 服务器(建议 4 核 8G 以上),装好 Docker,按 Dokploy 官方文档安装 Dokploy(本机用的是 v0.31.3)。
- 内网 DNS:`*.apps.公司域名` 和 `ferry.公司域名` 都解析到这台服务器(P2)。Ferry 的域名不要放在应用域名下面。
- 证书(P3):泛域名证书 `*.apps.公司域名` 和 `ferry.公司域名` 的证书。内网用不了 Let's Encrypt,
  把证书放进 Traefik 读的目录(Dokploy 的 `/etc/dokploy/traefik/dynamic`,写一份 `tls.certificates` 配置),具体按 Traefik 文档。
  Dokploy 的 `traefik.yml` 给 `websecure` 入口设了默认的 `certResolver: letsencrypt`,内网域名的 ACME 验证永远不会成功,
  Traefik 会反复重试、刷日志(之后用你放的证书)。用内部证书时,把这个默认的 certResolver 从 `traefik.yml` 里去掉,重启 Traefik。
- 关掉 Traefik 的管理接口:`/etc/dokploy/traefik/traefik.yml` 里 `api.insecure: false`,重启 Traefik(见 `docs/dokploy-findings.md`)。
- 服务器不能访问外网时,先准备 npm 和镜像仓库的内部代理(任务 1.2),员工应用构建要用。

### 2. 构建镜像

在仓库根目录:

```bash
docker build -t ferry:2026-11-22 .
```

本机是 Apple 芯片、服务器是 x86 时:

```bash
docker buildx build --platform linux/amd64 -t ferry:2026-11-22 --load .
```

镜像可以推到内部镜像仓库,或者 `docker save` 后拷到服务器上 `docker load`。镜像标签用日期或版本号,不要只用 latest,回退时才知道换回哪个。

### 3. 填写配置

把这个目录拷到服务器上(比如 `/opt/ferry/deploy`),然后:

```bash
cp .env.example .env
chmod 600 .env
```

逐项填写 `.env`:

| 配置 | 怎么填 |
|---|---|
| `FERRY_IMAGE` | 上一步的镜像名和标签(不要用 latest) |
| `FERRY_HOST`、`PUBLIC_URL` | Ferry 的域名和完整地址(`https://ferry.公司域名`) |
| `APPS_DOMAIN`、`APPS_URL_SCHEME` | 应用域名后缀、`https` |
| `FERRY_ENTRYPOINT`、`FERRY_TLS` | 有证书时 `websecure`、`true` |
| `DOKPLOY_API_KEY` | Dokploy 管理页面 → 个人设置里生成 |
| `POSTGRES_PASSWORD`、`GATEWAY_SECRET`、`SECRETS_KEY` | 各运行一次 `openssl rand -hex 32` |
| `ADMIN_USERS` | 可以不填。固定的平台管理员(用户 ID,逗号分隔),控制台上不能取消;其余管理员在控制台“人员”页设置 |

`GATEWAY_SECRET` 和 `SECRETS_KEY` 必须固定:不设置的话 compose 拒绝启动。`SECRETS_KEY` 丢了或换了,员工保存过的应用密钥全部解不开,
把 `.env` 另外备份到安全的地方。

### 4. 启动

```bash
docker compose up -d
docker compose ps
docker compose logs ferry
```

日志里应该有 `密钥扫描:gitleaks 8.30.1`、`登录网关已就绪(/authz 地址 http://ferry-publisher:8080/authz)`;第一次部署还会提示“还没有平台管理员”,按下一步建。
数据库迁移在启动时自动执行。

### 5. 第一个管理员

```bash
./set-password.sh <管理员手机号> --name <姓名> --org <公司名>
```

这条命令建好最上级部门(公司名)和第一个平台管理员,打印出的初始密码只显示一次。Ferry 每分钟从数据库重读一次组织架构,
最多一分钟后就能用它在 `https://ferry.公司域名/login` 登录,改成自己的密码。之后在控制台“部门”页建部门,在“人员”页添加员工、
生成初始密码转交本人;要多一位管理员,在“人员”页把他设为管理员。

### 6. 检查

- 用模板发布一个测试应用(按 `docs/agent-onboarding.md` 配好 agent,或者用 `scripts/mcp-publish.py`),能上线、能打开,
  打开时会先跳到 Ferry 登录再回来。
- `curl -I https://ferry.公司域名/authz` 应该是 404(不对外开放)。
- 检查完在控制台下线测试应用,再由管理员在“管理全部应用”里删除。

## 防火墙(未验证)

网络隔离后,员工应用还能经宿主机的地址访问 Dokploy 的 3000 端口(见 `docs/dokploy-findings.md`“经宿主机绕过”)。
`firewall.example.sh` 是在 Docker 的 `DOCKER-USER` 链上拦截的示例,**没有在真实服务器上验证过**,上线前要按实际网络改好、实测:
在一个员工应用的容器里访问 `http://<宿主机地址>:3000` 应该连不上,管理员从管理网段仍能打开 Dokploy。

## 日常运维

**看日志**:一期没有对外发通知的渠道,给负责人的通知和给管理员的告警都只在 Ferry 的日志里(已按 50MB × 10 份轮转)。

```bash
docker compose logs -f ferry | grep '告警'
```

**人员和部门**:在控制台“人员”“部门”页维护,改了立即生效。员工离职时在“人员”页标记离职(立即不能登录、令牌失效),
他负责的应用照常运行,不需要的在“管理全部应用”里停用或删除。所有管理员都被取消或离职时,用 `./set-password.sh <手机号> --name <姓名>` 重新设一位。

**升级**:构建或拉取新镜像,改 `.env` 里的 `FERRY_IMAGE`,然后:

```bash
docker compose up -d ferry
```

新版本启动时自动执行数据库迁移。升级前先按下面备份数据库。

**回退**:把 `FERRY_IMAGE` 改回旧标签再 `docker compose up -d ferry`。如果新版本加了数据库迁移,旧版本可能读不了新的表结构,
这时要用升级前的备份恢复数据库(恢复会丢掉升级之后的记录)。

**备份 Ferry 自己的数据**(3.4 只管员工应用的数据库,这里是 Ferry 的):

- 数据库(应用记录、发布历史、密码哈希、审计日志):

  ```bash
  docker compose exec -T postgres pg_dump -U ferry -d ferry | gzip > ferry-$(date +%F).sql.gz
  ```

  恢复(会丢掉备份之后的所有记录):

  ```bash
  docker compose stop ferry
  docker compose exec -T postgres dropdb -U ferry ferry
  docker compose exec -T postgres createdb -U ferry ferry
  gunzip -c ferry-日期.sql.gz | docker compose exec -T postgres psql -U ferry -d ferry
  docker compose start ferry
  ```
- 代码包:在命名卷 `ferry-platform_archives` 里,回滚要用。`docker run --rm -v ferry-platform_archives:/a -v "$PWD":/b alpine tar czf /b/archives-$(date +%F).tgz -C /a .`
- `.env`:里面的 `SECRETS_KEY` 丢了无法补救。

建议每天定时备份数据库,存到另一台机器上。

## 还没在企业环境验证的

- 真实域名和证书:本机用的是 `http://ferry.localhost` 和 `*.apps.localhost`,没有走 https。
- Linux 上的防火墙规则(`firewall.example.sh`)。
- 服务器能否访问外网、员工实际用的 agent 客户端能否连上 Ferry。
