/**
 * 登录页(手机号 + 密码,初始密码登录后先改密码)。控制台之外只有这一个页面。
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
<form id="login">
  <label for="account">手机号</label>
  <input id="account" autocomplete="username" required>
  <label for="password">密码</label>
  <input id="password" type="password" autocomplete="current-password" required>
  <button type="submit">登录</button>
  <p class="hint">第一次登录用平台管理员给你的初始密码。忘记密码请找平台管理员重置。</p>
</form>
<form id="change" hidden>
  <p class="hint">这是初始密码,请先设置你自己的密码(至少 8 位,不能全是数字)。</p>
  <label for="new1">新密码</label>
  <input id="new1" type="password" autocomplete="new-password" required>
  <label for="new2">再输一次</label>
  <input id="new2" type="password" autocomplete="new-password" required>
  <button type="submit">设置并登录</button>
</form>
<p id="msg"></p>
<script>
${POST}
  let ticket = "";
  const $ = (id) => document.getElementById(id);
  const msg = (text, cls) => { $("msg").textContent = text; $("msg").className = cls || ""; };
  // 登录后回到原来要去的页面;只接受站内路径
  const done = () => {
    const next = new URLSearchParams(location.search).get("next") || "/console/";
    location.href = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\\\") ? next : "/console/";
  };
  $("login").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try {
      const data = await post("/auth/login", { account: $("account").value, password: $("password").value });
      if (!data.mustChange) return done();
      ticket = data.ticket;
      $("login").hidden = true; $("change").hidden = false; $("new1").focus();
    } catch (err) { msg(err.message, "error"); }
  });
  $("change").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    if ($("new1").value !== $("new2").value) return msg("两次输入的密码不一样", "error");
    try {
      await post("/auth/change-password", { ticket, newPassword: $("new1").value });
      done();
    } catch (err) {
      msg(err.message, "error");
      // 票据过期:回到登录
      if (err.message.includes("重新登录")) { $("change").hidden = true; $("login").hidden = false; $("password").value = ""; }
    }
  });
</script>
</body></html>`;
