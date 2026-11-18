/**
 * 登录页和“我的个人令牌”页。只是能用的最小页面,完整的控制台在任务 2.7。
 * 页面不引用任何外部资源;所有请求发往同一来源,浏览器会带上 Origin 和 cookie。
 */

const STYLE = `
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; max-width: 560px; margin: 48px auto; padding: 0 16px; color: #1f2328; }
  h1 { font-size: 22px; } label { display: block; margin: 16px 0 6px; }
  input { width: 100%; padding: 8px 10px; font-size: 16px; box-sizing: border-box; }
  button { margin-top: 12px; padding: 8px 16px; font-size: 15px; cursor: pointer; }
  .hint { color: #59636e; font-size: 14px; } .error { color: #cf222e; } .ok { color: #1a7f37; }
  code { background: #f6f8fa; padding: 2px 6px; word-break: break-all; }
  pre { background: #f6f8fa; padding: 10px; font-size: 13px; white-space: pre-wrap; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; } td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid #d1d9e0; font-size: 14px; }
`;

const POST = `
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "请求失败");
    return data;
  }
`;

export const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 Ferry</title><style>${STYLE}</style></head>
<body>
<h1>登录 Ferry</h1>
<p class="hint">输入工号或手机号,验证码会通过工作通知发到你本人的钉钉上。</p>
<form id="step1">
  <label for="account">工号或手机号</label>
  <input id="account" autocomplete="username" required>
  <button type="submit">发送验证码</button>
</form>
<form id="step2" hidden>
  <p id="sent" class="hint"></p>
  <label for="code">验证码</label>
  <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
  <button type="submit">登录</button>
  <button type="button" id="again">重新获取</button>
</form>
<p id="msg"></p>
<script>
${POST}
  let challengeId = "";
  const msg = (text, cls) => { const el = document.getElementById("msg"); el.textContent = text; el.className = cls || ""; };
  document.getElementById("step1").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try {
      const data = await post("/auth/code", { account: document.getElementById("account").value });
      challengeId = data.challengeId;
      document.getElementById("sent").textContent = data.message;
      document.getElementById("step1").hidden = true; document.getElementById("step2").hidden = false;
      document.getElementById("code").focus();
    } catch (err) { msg(err.message, "error"); }
  });
  document.getElementById("step2").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try {
      await post("/auth/verify", { challengeId, code: document.getElementById("code").value });
      // 登录后回到原来要去的页面;只接受站内路径
      const next = new URLSearchParams(location.search).get("next") || "/me";
      location.href = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\\\") ? next : "/me";
    } catch (err) { msg(err.message, "error"); }
  });
  document.getElementById("again").addEventListener("click", () => {
    document.getElementById("step2").hidden = true; document.getElementById("step1").hidden = false; msg("");
  });
</script>
</body></html>`;

export const TOKENS_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>我的个人令牌</title><style>${STYLE}</style></head>
<body>
<h1>我的个人令牌</h1>
<p id="who" class="hint"></p>
<p class="hint">个人令牌给 agent 用:填进 agent 的 MCP 配置,作为请求头 <code>Authorization: Bearer 令牌</code>。
令牌只在生成时显示一次;不用了或泄露了就作废,再生成一个新的。离职后自动失效。</p>
<form id="create">
  <label for="label">令牌名称(方便你区分,如“我的电脑上的 agent”)</label>
  <input id="label" maxlength="60">
  <button type="submit">生成令牌</button>
</form>
<div id="new" hidden><p class="ok">新令牌(只显示这一次,请现在复制):</p><p><code id="token"></code></p>
<p class="hint">Claude Code:在终端里运行下面这条命令(<code>--scope user</code> 表示在你电脑上的所有项目里都能用):</p>
<pre id="cli"></pre>
<p class="hint">其他支持 MCP 的 agent:按下面的配置添加一个 HTTP 类型的 MCP 服务(不同 agent 的配置文件位置不同,字段含义一样):</p>
<pre id="json"></pre></div>
<table><thead><tr><th>名称</th><th>生成时间</th><th>最近使用</th><th></th></tr></thead><tbody id="list"></tbody></table>
<p><button type="button" id="logout">退出登录</button></p>
<p id="msg"></p>
<script>
${POST}
  const msg = (text, cls) => { const el = document.getElementById("msg"); el.textContent = text; el.className = cls || ""; };
  const time = (iso) => iso ? new Date(iso).toLocaleString() : "—";
  async function load() {
    const me = await fetch("/api/me");
    if (me.status === 401) { location.href = "/login"; return; }
    const user = await me.json();
    document.getElementById("who").textContent = "当前登录:" + user.name;
    const tokens = await (await fetch("/api/tokens")).json();
    const list = document.getElementById("list"); list.textContent = "";
    for (const t of tokens) {
      const tr = document.createElement("tr");
      for (const text of [t.label, time(t.createdAt), t.revoked ? "已作废" : time(t.lastUsedAt)]) {
        const td = document.createElement("td"); td.textContent = text; tr.appendChild(td);
      }
      const td = document.createElement("td");
      if (!t.revoked) {
        const b = document.createElement("button"); b.textContent = "作废";
        b.onclick = async () => {
          try {
            await post("/api/tokens/" + t.id + "/revoke");
            document.getElementById("new").hidden = true;
            for (const id of ["token", "cli", "json"]) document.getElementById(id).textContent = "";
            await load();
          } catch (err) { msg(err.message, "error"); }
        };
        td.appendChild(b);
      }
      tr.appendChild(td); list.appendChild(tr);
    }
  }
  document.getElementById("create").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try {
      const t = await post("/api/tokens", { label: document.getElementById("label").value });
      const mcp = location.origin + "/mcp";
      document.getElementById("token").textContent = t.token;
      document.getElementById("cli").textContent =
        "claude mcp add --transport http --scope user ferry " + mcp + ' --header "Authorization: Bearer ' + t.token + '"';
      document.getElementById("json").textContent = JSON.stringify(
        { mcpServers: { ferry: { type: "http", url: mcp, headers: { Authorization: "Bearer " + t.token } } } }, null, 2);
      document.getElementById("new").hidden = false;
      await load();
    } catch (err) { msg(err.message, "error"); }
  });
  document.getElementById("logout").addEventListener("click", async () => { await post("/auth/logout"); location.href = "/login"; });
  load().catch((err) => msg(err.message, "error"));
</script>
</body></html>`;
