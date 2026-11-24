/**
 * 登录页(手机号 + 密码,初始密码登录后先改密码)。控制台之外只有这一个页面。
 * 页面不引用任何外部资源;所有请求发往同一来源,浏览器会带上 Origin 和 cookie。
 */

// 和控制台(apps/console/src/styles.css)用同一套颜色、字号和圆角;页面只有一列,body 本身就是居中的卡片
const STYLE = `
  html { background: #F9FAFB; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.6; color: #374151;
    max-width: 440px; margin: 10vh auto 48px; padding: 32px; background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 10px; box-sizing: border-box; }
  h1 { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; font-size: 20px; font-weight: 700; color: #111827; }
  h1::before { content: "F"; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: #111827; color: #fff; font-size: 15px; }
  h2 { font-size: 16px; color: #111827; margin: 24px 0 8px; }
  label { display: block; margin: 16px 0 6px; font-size: 13px; font-weight: 500; color: #374151; }
  input { width: 100%; height: 38px; padding: 0 12px; font-size: 14px; font-family: inherit; color: #111827; box-sizing: border-box;
    border: 1px solid #D1D5DB; border-radius: 8px; outline: none; transition: border-color .15s, box-shadow .15s; }
  input:focus { border-color: #2563EB; box-shadow: 0 0 0 3px #DBEAFE; }
  button { width: 100%; height: 38px; margin-top: 20px; padding: 0 18px; font-size: 14px; font-family: inherit; font-weight: 500; cursor: pointer;
    color: #fff; background: #2563EB; border: 0; border-radius: 8px; }
  button:hover { background: #1D4ED8; } button:disabled { opacity: .6; cursor: default; }
  .hint { color: #6B7280; font-size: 13px; } .error { color: #DC2626; } .ok { color: #15803D; }
  #msg:empty { display: none; }
  code { background: #F3F4F6; padding: 1px 5px; border-radius: 4px; font-family: "SF Mono", Menlo, monospace; font-size: 12px; word-break: break-all; }
  pre { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; padding: 10px 12px; font-family: "SF Mono", Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; } td, th { text-align: left; padding: 8px 4px; border-bottom: 1px solid #E5E7EB; font-size: 13px; }
  th { color: #6B7280; font-weight: 600; }
  @media (max-width: 480px) { body { margin: 0; min-height: 100vh; border: 0; border-radius: 0; padding: 24px 16px; } }
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

/**
 * 设置向导(docs/setup-wizard.md)。现在只有第 1 步:输入设置码;后面的步骤在之后的版本里加上。
 * 只在未初始化时能打开,完成初始化后 404。
 */
export const SETUP_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>设置 Ferry</title><style>${STYLE}</style></head>
<body>
<h1>设置 Ferry</h1>
<form id="code" hidden>
  <p class="hint">设置码在安装命令结束时显示过一次;也可以在服务器上查看设置码文件(Ferry 的 SETUP_CODE_FILE 设置)。</p>
  <label for="value">设置码</label>
  <input id="value" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" required>
  <button type="submit">继续</button>
</form>
<div id="next" hidden>
  <p class="ok">设置码正确。</p>
  <p class="hint">接下来的步骤(域名和 DNS、证书、管理员)还在开发中。</p>
</div>
<p id="msg"></p>
<script>
${POST}
  const $ = (id) => document.getElementById(id);
  const msg = (text, cls) => { $("msg").textContent = text; $("msg").className = cls || ""; };
  const show = (session) => { $("code").hidden = session; $("next").hidden = !session; if (!session) $("value").focus(); };
  fetch("/api/setup/status").then((r) => r.json()).then((s) => show(Boolean(s.session))).catch(() => show(false));
  $("code").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try {
      await post("/api/setup/code", { code: $("value").value });
      show(true);
    } catch (err) { msg(err.message, "error"); }
  });
</script>
</body></html>`;
