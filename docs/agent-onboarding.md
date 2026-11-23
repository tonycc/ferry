# 让 agent 接入 Ferry

员工用自己的 AI agent(Claude Code、Antigravity 或其他支持 MCP 的 agent)做应用,由 agent 通过 Ferry 发布到公司服务器。
接入只需要做一次:领一个个人令牌,填进 agent 的 MCP 配置。

## 前提

agent 要能在你的电脑上读写文件、执行命令(打 zip 包、用 curl 上传)。Claude Code 可以;
其他 agent 如果只能聊天、不能执行命令,目前无法上传代码包(见任务计划 P6)。

不管用哪个 agent,它请你允许运行 `env`、`printenv` 这类列出环境变量的命令,或者读 `.env` 文件时,**选拒绝**:
里面可能有你的其他密钥,做 Ferry 的应用用不到。

## 第一步:领取个人令牌

1. 浏览器打开 Ferry 控制台的“个人令牌”页面 `<Ferry 地址>/console/tokens`,用手机号和密码登录(第一次用平台管理员给你的初始密码,登录后要改成自己的密码)。
2. 填一个名称(如“我的笔记本上的 Claude Code”),点“生成令牌”。
3. 页面会显示令牌和填好令牌的配置。**令牌只显示这一次**,请马上按第二步配好。

令牌等同于你本人:不要发给别人,不要提交到代码仓库。不用了或怀疑泄露了,在同一个页面点“作废”,再生成新的。
离职后令牌自动失效。

## 第二步:配置 agent

**Claude Code**:复制页面上的命令到终端运行,形如:

```bash
claude mcp add --transport http --scope user ferry <Ferry 地址>/mcp --header "Authorization: Bearer <令牌>"
```

运行 `claude mcp list`,看到 `ferry` 显示已连接即可。

**Antigravity**(Gemini 应用里的 `agy` 命令行):在终端运行

```bash
agy mcp add --header "Authorization: Bearer <令牌>" ferry <Ferry 地址>/mcp
```

运行 `agy mcp list`,看到 `ferry` 显示 enabled 即可。这个配置对所有目录都生效。
在 Antigravity 里第一次用 Ferry 的工具、执行打包和上传命令时,它会请你允许,允许即可。

**Codex**(OpenAI 的 Codex 命令行、桌面版和编辑器插件共用一份配置):用文本编辑器打开 `~/.codex/config.toml`
(没有就新建),在末尾加上:

```toml
[mcp_servers.ferry]
url = "<Ferry 地址>/mcp"
http_headers = { "Authorization" = "Bearer <令牌>" }
```

保存后重开 Codex,运行 `codex mcp list`(或在 Codex 里输入 `/mcp`),看到 `ferry` 即可。这个配置对所有目录都生效。

**WorkBuddy**(腾讯 WorkBuddy 桌面版):用文本编辑器打开 `~/.workbuddy/mcp.json`(没有就新建),
在 `mcpServers` 里加上 `ferry` 这一项(文件里已有其他服务的,和它们并列,别删掉原来的):

```json
{
  "mcpServers": {
    "ferry": {
      "type": "http",
      "url": "<Ferry 地址>/mcp",
      "headers": { "Authorization": "Bearer <令牌>" }
    }
  }
}
```

保存后重开 WorkBuddy,在它的 MCP 设置里看到 `ferry` 已启用即可。第一次用 Ferry 的工具时它会请你允许,允许即可。

**其他 agent**:添加一个 HTTP(Streamable HTTP)类型的 MCP 服务,地址是 `<Ferry 地址>/mcp`,
带请求头 `Authorization: Bearer <令牌>`。页面上也给出了 JSON 格式的配置:

```json
{
  "mcpServers": {
    "ferry": {
      "type": "http",
      "url": "<Ferry 地址>/mcp",
      "headers": { "Authorization": "Bearer <令牌>" }
    }
  }
}
```

配置只对新开的会话生效:已经开着的 agent 要退出重开。

## 第三步(可选):让 agent 默认用 Ferry 发布

agent 连上 Ferry 后就知道怎么用它。但你没提“发布”或“公司服务器”时(比如只说“做个网站”),
它可能按习惯推荐 Vercel 之类的外部平台。想更保险,在 agent 的全局说明文件里加一句:

> 给公司做的内部应用,一律通过 ferry MCP 发布到公司服务器,不要用其他托管平台。

| agent | 全局说明文件 |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Antigravity | `~/.gemini/GEMINI.md` |
| WorkBuddy | 在它的记忆或规则设置里加 |

## 第四步:用起来

直接用自然语言告诉 agent 要做什么,例如:

> 帮我做一个报销登记的小应用,能填报销人、金额、事由,本部门的同事可以看到。做好后发布。

agent 连上 Ferry 时会收到一份使用说明(何时向你确认、如何打包上传、发布失败后怎么修),
并能取到应用模板,不需要你提供其他资料。发布前它会请你确认应用名和谁能看到;
发布失败时它会读日志自己修复,修不好会告诉你原因。

下面这些说法 agent 都会理解成要用 Ferry,不用特意提 Ferry:

| 想做的事 | 可以这样说 |
| --- | --- |
| 新做应用 | “做个登记表/报名表/看板/台账给同事用”“部门要个网页填数据” |
| 发布 | “发布”“上线”“部署到公司服务器”“给我个链接让同事打开” |
| 查应用 | “我有哪些应用?”“xxx 的地址是多少?” |
| 排查问题 | “xxx 打不开了”“xxx 报错了” —— agent 会先看线上日志 |
| 改谁能看 | “xxx 改成全公司都能看”“xxx 只给本部门看” |
| 回滚 | “把 xxx 回到上一个版本” —— 只恢复代码,不恢复数据 |
| 下线 | “把 xxx 下线” —— 访问地址立即失效,数据保留,重新发布即可恢复 |

只说“做个网站”这类不明确的话时,agent 会先问你是不是要发布给公司同事用。
想让它直接用 Ferry,说一句“用 Ferry 发布”最稳妥。

## 给维护者

- agent 收到的使用说明是 [apps/publisher/src/mcp/agent-guide.md](../apps/publisher/src/mcp/agent-guide.md),
  作为 MCP 的 `instructions` 在连接时发出。改流程时同步改它。
- 模板来自 [packages/templates](../packages/templates),agent 通过 `list_templates` 和 `get_template` 取用,
  每个模板的 README.md 第一段是给 agent 看的简介。
- 验收方法:在一个空目录里用 `claude -p --strict-mcp-config --mcp-config <配置>` 让 Claude Code 只连 Ferry,
  不给它看 Ferry 的仓库,看它能否独立完成新建、发布和修复。
