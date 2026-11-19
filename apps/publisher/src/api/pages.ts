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
    if (user.isAdmin && !document.getElementById("admin")) {
      const a = document.createElement("a"); a.id = "admin"; a.href = "/admin"; a.textContent = "管理全部应用";
      document.getElementById("who").after(a);
    }
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

/** 管理页(任务 2.10):全部应用,停用和恢复。只有平台管理员能读到数据,接口自己会检查 */
export const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ferry 管理</title><style>${STYLE}
  body { max-width: 1080px; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .bar input { max-width: 320px; }
  .wrap { overflow-x: auto; }
  td button { margin: 0; padding: 4px 10px; font-size: 14px; }
  .tag { font-size: 13px; padding: 1px 8px; border-radius: 10px; background: #eef1f4; white-space: nowrap; }
  .tag.live { background: #dafbe1; color: #1a7f37; } .tag.off { background: #ffebe9; color: #cf222e; }
  .muted { color: #59636e; font-size: 13px; }
  tr.ask td { background: #fff8c5; } tr.ask input { max-width: 420px; margin-right: 8px; }
</style></head>
<body>
<h1>Ferry 管理</h1>
<p id="who" class="hint"></p>
<div class="bar"><input id="filter" placeholder="按应用名、负责人或部门筛选"><span id="count" class="hint"></span></div>
<div class="wrap"><table>
<thead><tr><th>应用</th><th>负责人</th><th>负责人部门</th><th>谁能看</th><th>状态</th><th>创建时间</th><th></th></tr></thead>
<tbody id="list"></tbody></table></div>
<p id="msg"></p>
<script>
${POST}
  const VIS = { self: "仅负责人", department: "本部门", company: "全公司" };
  const msg = (text, cls) => { const el = document.getElementById("msg"); el.textContent = text; el.className = cls || ""; };
  const cell = (tr, text, cls) => { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; tr.appendChild(td); return td; };
  let apps = [];
  /** 正在确认的操作:{ name, action } */
  let pending = null;

  function status(a) {
    if (a.disabled) return ["已停用", "off", 0];
    if (a.unpublished) return ["已下线", "", 3];
    if (a.live) return ["在线", "live", 1];
    return ["未上线", "", 2];
  }

  function render() {
    const q = document.getElementById("filter").value.trim().toLowerCase();
    const shown = apps.filter((a) => !q || [a.name, a.ownerName, ...a.departmentNames].some((t) => t.toLowerCase().includes(q)));
    document.getElementById("count").textContent = "共 " + apps.length + " 个应用" + (q ? ",显示 " + shown.length + " 个" : "");
    const list = document.getElementById("list"); list.textContent = "";
    for (const a of shown) {
      const tr = document.createElement("tr");
      const name = cell(tr, "");
      const link = document.createElement("a"); link.href = a.url; link.textContent = a.name; link.target = "_blank"; link.rel = "noopener";
      name.appendChild(link);
      cell(tr, a.ownerName);
      cell(tr, a.departmentNames.join("、") || "—");
      cell(tr, VIS[a.visibility] || a.visibility);
      const [label, cls] = status(a);
      const st = cell(tr, "");
      const tag = document.createElement("span"); tag.className = "tag " + cls; tag.textContent = label; st.appendChild(tag);
      if (a.disabled && a.disabledReason) { const r = document.createElement("div"); r.className = "muted"; r.textContent = a.disabledReason; st.appendChild(r); }
      cell(tr, new Date(a.createdAt).toLocaleDateString(), "muted");
      const act = cell(tr, "");
      const b = document.createElement("button");
      const action = a.disabled ? "enable" : "disable";
      b.textContent = a.disabled ? "恢复" : "停用";
      b.onclick = () => {
        pending = { name: a.name, action }; msg(""); render();
        // 只在展开时聚焦一次;筛选时会重画列表,不能每次都抢走输入框的焦点
        const first = document.querySelector("tr.ask input, tr.ask button"); if (first) first.focus();
      };
      act.appendChild(b);
      list.appendChild(tr);
      if (pending && pending.name === a.name) list.appendChild(confirmRow(a.name, pending.action));
    }
  }

  /** 在应用下面展开一行确认:停用要填原因(会通知负责人) */
  function confirmRow(name, action) {
    const tr = document.createElement("tr"); tr.className = "ask";
    const td = document.createElement("td"); td.colSpan = 7; tr.appendChild(td);
    const text = document.createElement("p");
    text.textContent = action === "disable"
      ? "停用 " + name + ":访问地址立即失效,负责人不能再发布;数据保留,可以随时恢复。"
      : "恢复 " + name + ":同事可以重新访问,负责人也能再次发布。";
    td.appendChild(text);
    let reason;
    if (action === "disable") {
      reason = document.createElement("input"); reason.placeholder = "停用原因(会通知负责人)"; reason.maxLength = 200;
      td.appendChild(reason);
    }
    const ok = document.createElement("button"); ok.textContent = action === "disable" ? "确认停用" : "确认恢复";
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await post("/api/admin/apps/" + encodeURIComponent(name) + "/" + action, reason && reason.value.trim() ? { reason: reason.value.trim() } : {});
        pending = null;
        msg((action === "disable" ? "已停用 " : "已恢复 ") + name, "ok");
        await load();
      } catch (err) { ok.disabled = false; msg(err.message, "error"); }
    };
    const cancel = document.createElement("button"); cancel.textContent = "取消"; cancel.type = "button";
    cancel.onclick = () => { pending = null; render(); };
    td.append(ok, " ", cancel);
    return tr;
  }

  async function load() {
    const res = await fetch("/api/admin/apps");
    if (res.status === 401) { location.href = "/login?next=/admin"; return; }
    if (res.status === 403) { msg("只有平台管理员可以使用这个页面", "error"); return; }
    if (!res.ok) throw new Error("读取应用列表失败");
    // 停用的排最前,然后是在线、未上线,已下线的放最后
    apps = (await res.json()).sort((x, y) => status(x)[2] - status(y)[2] || x.name.localeCompare(y.name));
    render();
  }

  fetch("/api/me").then((r) => r.ok ? r.json() : null).then((me) => { if (me) document.getElementById("who").textContent = "当前登录:" + me.name; });
  document.getElementById("filter").addEventListener("input", render);
  load().catch((err) => msg(err.message, "error"));
</script>
</body></html>`;
