/**
 * 登录页(手机号 + 密码,初始密码登录后先改密码)。控制台之外只有这一个页面。
 * 页面不引用任何外部资源;所有请求发往同一来源,浏览器会带上 Origin 和 cookie。
 */

// 和控制台(apps/console/src/styles.css)用同一套轻钴蓝品牌色、字号和圆角;
// 页面只有一列,body 本身就是居中的轻透明卡片,背后是柔和晴空渐变。登录网关的报错页(gateway/gateway.ts)也用它
export const PAGE_STYLE = `
  html { min-height: 100%; background:
    radial-gradient(880px 520px at 14% 8%, rgba(59,130,246,.11), transparent 62%),
    radial-gradient(760px 500px at 88% 18%, rgba(56,189,248,.10), transparent 60%),
    radial-gradient(820px 600px at 50% 108%, rgba(147,197,253,.11), transparent 60%), #F9FBFE; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.6; color: #334155;
    -webkit-font-smoothing: antialiased; max-width: 432px; margin: 11vh auto 48px; padding: 38px 36px 34px; box-sizing: border-box;
    background: rgba(255,255,255,.92); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); border: 1px solid rgba(226,236,248,.92); border-radius: 22px;
    box-shadow: 0 24px 52px -28px rgba(30,64,175,.18), 0 1px 2px rgba(15,23,42,.03); }
  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 800; letter-spacing: -0.02em; color: #1E293B; }
  h1::before { content: ""; display: block; width: 46px; height: 46px; margin-bottom: 18px; border-radius: 14px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 17c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0'/%3E%3Cpath d='M5 13l1-5h12l1 5'/%3E%3Cpath d='M9 8V5h6v3'/%3E%3Cpath d='M4 13h16'/%3E%3C/svg%3E") center / 25px no-repeat, linear-gradient(135deg, #3B82F6, #60A5FA);
    box-shadow: 0 8px 18px -8px rgba(59,130,246,.65); }
  .subtitle { margin: 0 0 22px; color: #76869B; font-size: 13px; }
  h2 { font-size: 16px; color: #1E293B; margin: 24px 0 8px; }
  label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 600; color: #334155; }
  .field { position: relative; }
  input { width: 100%; height: 44px; padding: 0 13px; font-size: 14px; font-family: inherit; color: #1E293B; box-sizing: border-box; background: #fff;
    border: 1px solid #D5DFEB; border-radius: 11px; outline: none; transition: border-color .15s, box-shadow .15s; }
  .field input { padding-right: 46px; }
  input:focus { border-color: #3B82F6; box-shadow: 0 0 0 4px #DBEAFE; }
  .eye { position: absolute; top: 50%; right: 6px; transform: translateY(-50%); width: auto; height: 30px; margin: 0; padding: 0 9px;
    border: 0; border-radius: 7px; background: transparent; box-shadow: none; color: #76869B; font-size: 12px; font-weight: 600; cursor: pointer; }
  .eye:hover { background: #F2F6FA; color: #1E293B; filter: none; }
  button[type="submit"] { width: 100%; height: 44px; margin-top: 22px; padding: 0 18px; font-size: 14px; font-family: inherit; font-weight: 600; cursor: pointer;
    color: #fff; background: #3B82F6; border: 0; border-radius: 11px; box-shadow: 0 8px 18px -8px rgba(59,130,246,.55); transition: background-color .15s, transform .1s; }
  button[type="submit"]:hover { background: #2563EB; }
  button[type="submit"]:active { transform: translateY(1px); }
  button[type="submit"]:disabled { opacity: .55; cursor: default; transform: none; box-shadow: none; }
  .hint { margin: 14px 0 0; color: #76869B; font-size: 12px; line-height: 1.65; }
  #msg { margin: 16px 0 0; padding: 10px 13px; border-radius: 10px; font-size: 13px; line-height: 1.55; }
  #msg:empty { display: none; }
  #msg.error { background: #FEF2F2; border: 1px solid #FECACA; color: #DC2626; }
  #msg.ok { background: #ECFDF5; border: 1px solid #A7F3D0; color: #059669; }
  .error { color: #DC2626; } .ok { color: #059669; }
  .rule-box { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; background: #F8FBFF; border: 1px solid #DBEAFE; color: #526277; font-size: 12px; }
  code { background: #F2F6FA; padding: 1px 6px; border-radius: 5px; font-family: "SF Mono", Menlo, monospace; font-size: 12px; word-break: break-all; }
  pre { background: #F9FBFE; border: 1px solid #E8EEF5; border-radius: 10px; padding: 10px 12px; font-family: "SF Mono", Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; } td, th { text-align: left; padding: 8px 4px; border-bottom: 1px solid #E8EEF5; font-size: 13px; }
  th { color: #76869B; font-weight: 600; }
  @media (max-width: 480px) { body { margin: 0; min-height: 100vh; border: 0; border-radius: 0; box-shadow: none; padding: 32px 20px; } }
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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%233B82F6'/%3E%3Cstop offset='1' stop-color='%2360A5FA'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='36' height='36' rx='10' fill='url(%23g)'/%3E%3Cg transform='translate(6,6)' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 17c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0'/%3E%3Cpath d='M5 13l1-5h12l1 5'/%3E%3Cpath d='M9 8V5h6v3'/%3E%3Cpath d='M4 13h16'/%3E%3C/g%3E%3C/svg%3E">
<title>登录 Ferry</title><style>${PAGE_STYLE}</style></head>
<body>
<h1>登录 Ferry</h1>
<p class="subtitle">企业内部 AI 应用发布与访问平台</p>
<form id="login">
  <label for="account">手机号或工号</label>
  <input id="account" autocomplete="username" placeholder="请输入手机号或工号" required>
  <label for="password">密码</label>
  <div class="field">
    <input id="password" type="password" autocomplete="current-password" placeholder="请输入登录密码" required>
    <button type="button" class="eye" data-for="password" aria-label="显示或隐藏密码">显示</button>
  </div>
  <button id="loginBtn" type="submit">登录</button>
  <p class="hint">首次登录请使用管理员提供的初始密码；忘记密码请联系平台管理员重置。</p>
</form>
<form id="change" hidden>
  <div class="rule-box">当前为初始密码，请先设置你自己的密码：长度至少 8 位，且不能全部为纯数字。</div>
  <label for="new1">新密码</label>
  <div class="field">
    <input id="new1" type="password" autocomplete="new-password" placeholder="至少 8 位，不能全为数字" required>
    <button type="button" class="eye" data-for="new1" aria-label="显示或隐藏密码">显示</button>
  </div>
  <label for="new2">确认新密码</label>
  <div class="field">
    <input id="new2" type="password" autocomplete="new-password" placeholder="再输入一次新密码" required>
    <button type="button" class="eye" data-for="new2" aria-label="显示或隐藏密码">显示</button>
  </div>
  <button id="changeBtn" type="submit">设置并登录</button>
</form>
<p id="msg" role="alert"></p>
<script>
${POST}
  let ticket = "";
  const $ = (id) => document.getElementById(id);
  const msg = (text, cls) => { $("msg").textContent = text; $("msg").className = cls || ""; };
  document.querySelectorAll(".eye").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.for);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "隐藏" : "显示";
      input.focus();
    });
  });
  // 登录后回到原来要去的页面;只接受站内路径
  const done = () => {
    const next = new URLSearchParams(location.search).get("next") || "/console/";
    location.href = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\\\") ? next : "/console/";
  };
  $("login").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    const btn = $("loginBtn"); btn.disabled = true; btn.textContent = "登录中…";
    try {
      const data = await post("/auth/login", { account: $("account").value, password: $("password").value });
      if (!data.mustChange) return done();
      ticket = data.ticket;
      $("login").hidden = true; $("change").hidden = false; $("new1").focus();
    } catch (err) { msg(err.message, "error"); }
    finally { btn.disabled = false; btn.textContent = "登录"; }
  });
  $("change").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    if ($("new1").value !== $("new2").value) return msg("两次输入的密码不一样", "error");
    const btn = $("changeBtn"); btn.disabled = true; btn.textContent = "提交中…";
    try {
      await post("/auth/change-password", { ticket, newPassword: $("new1").value });
      done();
    } catch (err) {
      msg(err.message, "error");
      // 票据过期:回到登录
      if (err.message.includes("重新登录")) { $("change").hidden = true; $("login").hidden = false; $("password").value = ""; }
    } finally { btn.disabled = false; btn.textContent = "设置并登录"; }
  });
</script>
</body></html>`;

/**
 * 设置向导(docs/setup-wizard.md)。现在只有第 1 步:输入设置码;后面的步骤在之后的版本里加上。
 * 只在未初始化时能打开,完成初始化后 404。
 */
export const SETUP_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>设置 Ferry</title><style>${PAGE_STYLE}</style></head>
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
  const status = () => fetch("/api/setup/status").then((r) => r.json()).then((s) => show(Boolean(s.session))).catch(() => show(false));
  // 从服务器 IP 交接过来:先去掉地址栏里的令牌,再用同源 POST 换成这个地址上的向导会话
  const handoff = new URLSearchParams(location.search).get("handoff");
  if (handoff) {
    history.replaceState(null, "", "/setup");
    post("/api/setup/handoff/redeem", { token: handoff }).catch((err) => msg(err.message, "error")).finally(status);
  } else status();
  $("code").addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try {
      await post("/api/setup/code", { code: $("value").value });
      show(true);
    } catch (err) { msg(err.message, "error"); }
  });
</script>
</body></html>`;
