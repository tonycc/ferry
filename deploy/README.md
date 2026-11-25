# 部署 Ferry(任务 3.6)

在一台装好 Dokploy 的 Linux 服务器上,用这个目录里的配置部署 Ferry。
这套配置在本机(Mac + Docker Desktop + 本机 Dokploy)上完整验证过:用镜像启动、经 Traefik 登录、用个人令牌发布模板应用并上线、
打开应用时跳转 Ferry 登录再回到应用、重启后数据和登录都在。**真实域名和证书、Linux 上的防火墙还没有在企业环境里验证**,见文末。

> **两种部署方式:**
> - **安装命令加设置向导**(见下面“用安装命令部署”):服务器上运行 `install.sh`,再在浏览器里按向导设置域名、证书和管理员。
>   **安装命令和向导都还没在真实的 Linux 服务器上从零走过**,第一次用时留出排查的时间。
> - **手动部署**(“第一次部署”):自己装 Dokploy、在 `.env` 里写好地址,Ferry 启动时就当作已经初始化,不进向导。
>
> 两种方式不要混用:`.env` 里写了 `PUBLIC_URL`、`APPS_DOMAIN`、`APPS_URL_SCHEME` 时这些值优先,向导和证书页就改不了它们。

| 文件 | 用途 |
|---|---|
| `../Dockerfile` | Ferry 的镜像:发布服务、构建好的控制台、应用模板、固定版本的 gitleaks(按架构下载并校验) |
| `docker-compose.yml` | Ferry 和它自己的 PostgreSQL |
| `.env.example` | 配置模板,复制为 `.env` 后填写 |
| `install.sh` | 安装命令:装 Docker、Dokploy 和 Ferry,打印设置向导的地址和设置码 |
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

## 用安装命令部署

在一台全新的 Linux 服务器上(建议 4 核 8G 以上,80、443、3000 端口空着),先做这些外部的准备(安装命令不碰它们):

- 内网 DNS:`ferry.公司域名` 和 `*.apps.公司域名` 解析到这台服务器(也可以等向导第 2 步告诉你要加哪两条再加)。
- 证书(覆盖这两个名字)可以先不办:向导里能跳过,先用 HTTP,之后在控制台“证书”页补装。
- 服务器不能访问外网时,先准备 npm 和镜像仓库的内部代理(任务 1.2)。安装命令要从外网装 Docker 和拉镜像。

然后:

1. 按下面“2. 构建镜像”构建 Ferry 的镜像,拷到服务器上 `docker load`(或者推到内部镜像仓库)。
2. 把这个 `deploy` 目录拷到服务器上(比如 `/opt/ferry/deploy`),**不要**放 `.env`(安装命令会生成)。
3. 用 root 运行:

   ```bash
   cd /opt/ferry/deploy
   sudo FERRY_IMAGE=ferry:2026-11-26 ./install.sh
   ```

   它会依次:装 Docker(没有时)、开启 Swarm、装固定版本的 Dokploy(v0.31.3)、马上用接口建 Dokploy 管理员并生成给 Ferry 用的 API key
   (登录信息写进 `dokploy-admin.txt`,只有 root 能读)、改 Traefik 的配置(关掉管理接口、去掉内网用不了的 Let's Encrypt)、
   生成 `.env`(随机的数据库密码、`GATEWAY_SECRET`、`SECRETS_KEY`,不写地址)、启动 Ferry、加上防火墙规则
   (不让容器经宿主机访问 Dokploy,同 `firewall.example.sh`;不要时设 `SKIP_FIREWALL=1`)。
   最后打印设置向导的地址 `https://服务器IP/setup` 和设置码。可以重复运行:已经装好的部分跳过,已有的 `.env` 不覆盖
   (再给一个新的 `FERRY_IMAGE` 就换成新镜像,可以用来升级;不给就用 `.env` 里的)。防火墙规则加不上时只提醒,不中止安装。
4. 在浏览器里打开向导地址(证书警告点继续),按 7 步做完:设置码、域名和 DNS 检测、证书(可跳过)、切到正式地址、
   公司和管理员、自检、完成。
5. **备份 `.env`**(`SECRETS_KEY` 丢了,员工保存过的应用密钥全部解不开),以及 `dokploy-admin.txt`。

之后的日常运维(升级、备份、证书到期)和手动部署一样,见“日常运维”;证书在控制台“证书”页换。
防火墙规则重启后不保留,要长期生效用 `iptables-persistent` 之类保存。

## 第一次部署

### 1. 准备

- 一台 Linux 服务器(建议 4 核 8G 以上)。服务器的 80、443、3000 端口要空着(Traefik 和 Dokploy 用)。
- 安装 Dokploy:用 root 运行官方安装脚本 `curl -sSL https://dokploy.com/install.sh | sh`。没有 Docker 时脚本会先装好 Docker
  并初始化 Docker Swarm,不用单独装;已经装过 Docker 的,先升级到官方最新版。本机用的是 Dokploy v0.31.3,
  脚本怎么固定版本以 Dokploy 官方文档为准。(本机用的 `infra/dokploy/setup-local.sh` 是给 Mac 的,服务器上不用它。)
- 装好后用浏览器打开 `http://服务器IP:3000`,建 Dokploy 的管理员账号,再在个人设置里生成 API key(第 3 步要填)。
- 内网 DNS:`*.apps.公司域名` 和 `ferry.公司域名` 都解析到这台服务器(P2)。Ferry 的域名不要放在应用域名下面。
- 证书(P3):要同时覆盖 `ferry.公司域名` 和 `*.apps.公司域名`(一张多域名证书,或者两张)。内网用不了 Traefik 自动申请的证书
  (Let's Encrypt 要从公网访问到服务器;泛域名还要 DNS 验证,Ferry 不保存阿里云的凭据),所以由人申请后放到服务器上:
  - 证书要带中间证书(下载时选 Nginx 格式,`.pem` 里一般有两段);私钥不能有密码。
  - 装证书有两种做法:Ferry 启动后在控制台“证书”页上传(Ferry 检查后装进 Traefik,推荐);或者现在就在 Dokploy 管理页面的
    证书(Certificates)设置里添加:粘贴证书链和私钥。Dokploy 把它们写到 `/etc/dokploy/traefik/dynamic/certificates/` 下,
    **但 Traefik 不会自己加载**(见 `docs/dokploy-findings.md`),添加后运行 `docker restart dokploy-traefik`。
  - 检查:`openssl s_client -connect 服务器IP:443 -servername ferry.公司域名 </dev/null | openssl x509 -noout -subject -enddate`
    显示的应该是你的证书,不是 `TRAEFIK DEFAULT CERT`。
  - Dokploy 的 `traefik.yml` 给 `websecure` 入口设了默认的 `certResolver: letsencrypt`,内网域名的 ACME 验证永远不会成功,
    Traefik 会反复重试、刷日志。去掉它,但入口上的 `tls` 要留着:把

    ```yaml
        http:
          tls:
            certResolver: letsencrypt
    ```

    改成

    ```yaml
        http:
          tls: {}
    ```

    (整个 `tls` 删掉的话,https 应用的路由不再接 TLS 连接,应用全部打不开),再删掉文件末尾的 `certificatesResolvers` 一段,重启 Traefik。
    安装命令 `install.sh` 就是这样改的。
  - 证书没有自动续期(人工申请的证书最长约 200 天)。到期前 30 天起,Ferry 在控制台顶部给管理员提醒、日志里有告警,不到 7 天每天告警;
    换证书在控制台“证书”页上传新的。
  - **证书还没办下来**,可以先用 HTTP 部署,见下面“先用 HTTP”。
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
| `PUBLIC_URL` | Ferry 的完整地址(`https://ferry.公司域名`) |
| `APPS_DOMAIN`、`APPS_URL_SCHEME` | 应用域名后缀、`https` |
| `DOKPLOY_API_KEY` | Dokploy 管理页面 → 个人设置里生成 |
| `POSTGRES_PASSWORD`、`GATEWAY_SECRET`、`SECRETS_KEY` | 各运行一次 `openssl rand -hex 32` |
| `ADMIN_USERS` | 可以不填。固定的平台管理员(用户 ID,逗号分隔),控制台上不能取消;其余管理员在控制台“人员”页设置 |

#### 先用 HTTP(证书还没办下来时)

把这几项改成 http 的值,其他照填:

```bash
PUBLIC_URL=http://ferry.公司域名
APPS_URL_SCHEME=http
```

这时员工的登录密码、agent 的令牌在内网里是明文传输的,只适合试用。以后换成 HTTPS:

1. 在控制台“证书”页上传证书(覆盖 `ferry.公司域名` 和 `*.应用域名后缀`),Ferry 检查后装进 Traefik,确认 Traefik 用上了这张。
   (地址写在 `.env` 里时 Ferry 不会自己切换,页面上会提示下一步。)
2. 把上面两项改回 `https://ferry.公司域名` 和 `https`,运行 `docker compose up -d ferry`。之后 Ferry 会把 http 的访问跳到 https,
   启动时把已经发布的应用在 Dokploy 上的域名也改成 https。
3. 告诉员工:agent 的 MCP 地址从 `http://` 改成 `https://`(“个人令牌”页上会提示 30 天,配置方法里是新地址)。

证书到期前 30 天起,控制台顶部给管理员提醒、日志里有告警,不到 7 天每天告警。换证书也在“证书”页上传新的。
健康检查要从 Ferry 的容器里访问 Traefik 的 https 入口(默认 443 端口);Traefik 用别的端口时设 `HEALTHCHECK_TLS_PORT`。

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

从 2026-11 下旬之前的版本升级时:compose 里 Ferry 的路由改成了兜底路由(`docker compose up -d` 时一起更新),
`.env` 里的 `FERRY_HOST`、`FERRY_ENTRYPOINT`、`FERRY_TLS` 不再使用,可以删掉,留着也没有影响。
之后用服务器 IP 或其他没配置的域名访问,Ferry 回 404;应用域名下不存在的应用回“应用不存在”;
应用只开了 http 却被用 https 打开时,跳到 http 的地址。

**回退**:把 `FERRY_IMAGE` 改回旧标签再 `docker compose up -d ferry`。如果新版本加了数据库迁移,旧版本可能读不了新的表结构,
这时要用升级前的备份恢复数据库(恢复会丢掉升级之后的记录)。
回退到 2026-11 下旬之前的版本时,`docker-compose.yml` 也要换回那个版本的(`deploy/` 目录和镜像标签一起取),
`.env` 里补回 `FERRY_HOST` 等变量:旧镜像不会按域名分流,配上新的兜底路由,服务器 IP 和任何没配置的域名都能打开它的登录页。

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
  经 Dokploy 证书接口装证书、Traefik 用上它,在本机用测试证书验证过(设置向导 PR 36);用 Dokploy 管理页面添加证书没有走过。
- 在全新的 Linux 服务器上用官方脚本安装 Dokploy(本机是 Mac,用的是 `infra/dokploy/setup-local.sh`)。
- 安装命令 `install.sh`:只在本机检查过语法,改 Traefik 配置和生成 `.env` 的部分在 Debian 容器里测过(改过的配置 Traefik 能正常加载);
  装 Docker、Dokploy、注册管理员、生成 API key、防火墙这些步骤没有在 Linux 服务器上跑过。
- 先用 HTTP 再换 HTTPS 的整个过程。
- Linux 上的防火墙规则(`firewall.example.sh`)。
- 服务器能否访问外网、员工实际用的 agent 客户端能否连上 Ferry。
