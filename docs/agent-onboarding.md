# 让 agent 接入 Ferry

员工用自己的 AI agent(Claude Code 或其他支持 MCP 的 agent)做应用,由 agent 通过 Ferry 发布到公司服务器。
接入只需要做一次:领一个个人令牌,填进 agent 的 MCP 配置。

## 前提

agent 要能在你的电脑上读写文件、执行命令(打 zip 包、用 curl 上传)。Claude Code 可以;
其他 agent 如果只能聊天、不能执行命令,目前无法上传代码包(见任务计划 P6)。

## 第一步:领取个人令牌

1. 浏览器打开 Ferry 控制台的“个人令牌”页面 `<Ferry 地址>/console/tokens`,用工号或手机号登录,验证码会通过钉钉工作通知发给你。
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

## 第三步:用起来

直接用自然语言告诉 agent 要做什么,例如:

> 帮我做一个报销登记的小应用,能填报销人、金额、事由,本部门的同事可以看到。做好后发布。

agent 连上 Ferry 时会收到一份使用说明(何时向你确认、如何打包上传、发布失败后怎么修),
并能取到应用模板,不需要你提供其他资料。发布前它会请你确认应用名和谁能看到;
发布失败时它会读日志自己修复,修不好会告诉你原因。

常用的说法:

- “我有哪些应用?” —— 列出你的应用和访问地址。
- “把 xxx 回到上一个版本” —— 回滚,只恢复代码,不恢复数据。
- “把 xxx 下线” —— 访问地址立即失效,数据保留,重新发布即可恢复。

## 给维护者

- agent 收到的使用说明是 [apps/publisher/src/mcp/agent-guide.md](../apps/publisher/src/mcp/agent-guide.md),
  作为 MCP 的 `instructions` 在连接时发出。改流程时同步改它。
- 模板来自 [packages/templates](../packages/templates),agent 通过 `list_templates` 和 `get_template` 取用,
  每个模板的 README.md 第一段是给 agent 看的简介。
- 验收方法:在一个空目录里用 `claude -p --strict-mcp-config --mcp-config <配置>` 让 Claude Code 只连 Ferry,
  不给它看 Ferry 的仓库,看它能否独立完成新建、发布和修复。
