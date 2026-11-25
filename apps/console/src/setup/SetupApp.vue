<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  canOpen,
  type CertificateResult,
  type DomainResult,
  setupApi,
  type SetupStatus,
  sleep,
  waitForRestart,
} from "./api";
import CheckResult from "./CheckResult.vue";
import Icon from "./Icon.vue";

/**
 * 设置向导(docs/setup-wizard.md,界面按 docs/mockups/setup-wizard.html 的原型)。
 * 第 6 步的自检还没做(阶段 3b),现在只能跳过。
 * 现在在哪一步由 /api/setup/status 算出来,刷新页面、Ferry 重启后都能接着做。
 */

type View = "loading" | "code" | "domain" | "certificate" | "switch" | "after" | "admin" | "selfcheck" | "done";
const STEPS = ["设置码", "域名", "证书", "切换地址", "管理员", "自检", "完成"];

const view = ref<View>("loading");
const status = ref<SetupStatus>();
const error = ref("");
const busy = ref(false);

const stepOf: Record<View, number> = {
  loading: 1,
  code: 1,
  domain: 2,
  certificate: 3,
  switch: 4,
  after: 4,
  admin: 5,
  selfcheck: 6,
  done: 7,
};
const step = computed(() => stepOf[view.value]);
const wizard = computed(() => status.value?.wizard);
const skipped = computed(() => wizard.value?.certificateSkipped === true);

// ---------- 进入页面:算出现在在哪一步 ----------
async function load() {
  error.value = "";
  phase.value = "";
  // 从服务器 IP 交接过来:先去掉地址栏里的令牌,再用同源 POST 换成这个地址上的会话
  const handoff = new URLSearchParams(location.search).get("handoff");
  if (handoff) {
    history.replaceState(null, "", "/setup");
    await setupApi.redeem(handoff).catch((err: Error) => (error.value = err.message));
  }
  try {
    status.value = await setupApi.status();
  } catch (err) {
    error.value = (err as Error).message;
    view.value = "code";
    return;
  }
  const s = status.value;
  if (!s.session) return go("code");
  const w = s.wizard;
  if (w?.publicUrl) {
    // 已经切换过:在正式地址上(或者跳过证书、确认过 http 地址能打开)是后面几步;否则是第 4 步重启之后
    const ready = location.origin === new URL(w.publicUrl).origin || (w.publicUrl.startsWith("http://") && w.httpConfirmed);
    return go(ready ? laterStep() : "after");
  }
  if (w?.domain && (w.certificateSkipped || certificateCovers())) return go("switch");
  if (w?.domain) return go("certificate");
  go("domain");
}

/** 第 5 到 7 步做到哪了 */
function laterStep(): View {
  const w = wizard.value;
  if (!w?.admin) return "admin";
  if (!w.selfCheck) return "selfcheck";
  return "done";
}

function go(next: View) {
  view.value = next;
  window.scrollTo(0, 0);
  if (next === "domain") fillDomainForm();
  if (next === "after") void afterSwitch();
}

function certificateCovers(): boolean {
  const w = wizard.value;
  if (!w?.domain || !w.certificate) return false;
  return w.certificate.domains.includes(w.domain.ferryHost) && w.certificate.domains.includes(`*.${w.domain.appsDomain}`);
}

onMounted(load);

// ---------- 第 1 步:设置码 ----------
const code = ref("");
async function submitCode() {
  busy.value = true;
  error.value = "";
  try {
    await setupApi.code(code.value);
    await load();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

// ---------- 第 2 步:域名 ----------
const form = reactive({ domain: "", ferrySub: "ferry", appsSub: "apps", serverIp: "" });
const domainResult = ref<DomainResult>();
function fillDomainForm() {
  const d = wizard.value?.domain;
  if (d) {
    form.domain = d.domain;
    form.ferrySub = d.ferryHost.split(".")[0]!;
    form.appsSub = d.appsDomain.split(".")[0]!;
    form.serverIp = d.serverIp;
  } else if (!form.serverIp) {
    form.serverIp = status.value?.suggestedIp ?? "";
  }
  domainResult.value = undefined;
}
const names = computed(() => {
  const domain = form.domain.trim().toLowerCase() || "example.com";
  return { domain, ferry: `${form.ferrySub.trim() || "ferry"}.${domain}`, apps: `${form.appsSub.trim() || "apps"}.${domain}` };
});
async function checkDomain() {
  busy.value = true;
  error.value = "";
  domainResult.value = undefined;
  try {
    domainResult.value = await setupApi.domain({ ...form });
    if (domainResult.value.ok) status.value = await setupApi.status();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

// ---------- 第 3 步:证书 ----------
const files = reactive<{ chain?: { name: string; text: string }; key?: { name: string; text: string } }>({});
const certResult = ref<CertificateResult>();
const confirmSkip = ref(false);
async function pick(kind: "chain" | "key", event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  files[kind] = { name: file.name, text: await file.text() };
  certResult.value = undefined;
}
async function installCertificate() {
  if (!files.chain || !files.key) return;
  busy.value = true;
  error.value = "";
  certResult.value = undefined;
  try {
    certResult.value = await setupApi.certificate(files.chain.text, files.key.text);
    if (certResult.value.ok) status.value = await setupApi.status();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
async function skipCertificate() {
  busy.value = true;
  error.value = "";
  try {
    await setupApi.skipCertificate();
    status.value = await setupApi.status();
    confirmSkip.value = false;
    go("switch");
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

// ---------- 第 4 步:切到正式地址 ----------
const officialUrl = computed(() => {
  const d = wizard.value?.domain;
  return wizard.value?.publicUrl ?? (d ? `${skipped.value ? "http" : "https"}://${d.ferryHost}` : "");
});
const appsUrl = computed(() => {
  const d = wizard.value?.domain;
  return d ? `${skipped.value ? "http" : "https"}://应用名.${d.appsDomain}` : "";
});
/** 第 4 步的进度:restarting 重启中;stuck 没起来;checking 检查电脑能否打开;unreachable 打不开;confirm 跳过证书时请人自己确认 */
const phase = ref<"" | "restarting" | "stuck" | "checking" | "unreachable" | "confirm" | "redirecting">("");
const waitedSeconds = ref(0);

async function switchAddress() {
  busy.value = true;
  error.value = "";
  try {
    const before = (await setupApi.ping().catch(() => undefined))?.instance;
    await setupApi.switchAddress();
    await restartAndReload(before);
  } catch (err) {
    error.value = (err as Error).message;
    busy.value = false;
  }
}

/** 等 Ferry 重启完再重新读状态;等不到时停在“没起来”,人处理后刷新页面接着做。then:起来后直接去这一步 */
async function restartAndReload(before: string | undefined, then?: View) {
  phase.value = "restarting";
  if (!(await waitForRestart(before))) {
    phase.value = "stuck";
    busy.value = false;
    return;
  }
  busy.value = false;
  await load();
  if (then && view.value !== "code") go(then);
}

async function afterSwitch() {
  if (skipped.value) {
    phase.value = "confirm";
    return;
  }
  phase.value = "checking";
  waitedSeconds.value = 0;
  // 解析刚生效、Traefik 刚加载时可能要等一会:每 10 秒查一次,最多两分钟
  for (let i = 0; i < 12; i++) {
    if (await canOpen(officialUrl.value)) {
      phase.value = "redirecting";
      try {
        const { token } = await setupApi.handoff();
        location.href = `${officialUrl.value}/setup?handoff=${encodeURIComponent(token)}`;
      } catch (err) {
        error.value = (err as Error).message;
        phase.value = "unreachable";
      }
      return;
    }
    await sleep(10_000);
    waitedSeconds.value += 10;
  }
  phase.value = "unreachable";
}

async function undoSwitch() {
  busy.value = true;
  error.value = "";
  try {
    const before = (await setupApi.ping().catch(() => undefined))?.instance;
    await setupApi.undoSwitch();
    await restartAndReload(before, "domain");
  } catch (err) {
    error.value = (err as Error).message;
    busy.value = false;
  }
}

/** 跳过证书时:人在新标签页里确认 http 的正式地址能打开。记到服务器上,刷新页面不用再确认 */
async function confirmHttp() {
  busy.value = true;
  error.value = "";
  try {
    await setupApi.confirmHttp();
    status.value = await setupApi.status();
    go(laterStep());
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

// ---------- 第 5 步:公司和管理员 ----------
const admin = reactive({ orgName: "", name: "", mobile: "", password: "", password2: "" });
async function createAdmin() {
  error.value = "";
  if (admin.password.length < 8 || /^\d+$/.test(admin.password)) return void (error.value = "密码至少 8 位,不能全是数字");
  if (admin.password !== admin.password2) return void (error.value = "两次输入的密码不一样");
  busy.value = true;
  try {
    await setupApi.admin({ orgName: admin.orgName, name: admin.name, mobile: admin.mobile, password: admin.password });
    admin.password = admin.password2 = "";
    status.value = await setupApi.status();
    go(laterStep());
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

// ---------- 第 6 步:自检 ----------
const confirmSkipCheck = ref(false);
async function skipSelfCheck() {
  busy.value = true;
  error.value = "";
  try {
    await setupApi.skipSelfCheck();
    status.value = await setupApi.status();
    confirmSkipCheck.value = false;
    go("done");
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

// ---------- 第 7 步:完成 ----------
/** 点“进入控制台”时才写入完成:之后向导关闭,服务器 IP 上也打不开了,所以跳到正式地址(不是当前地址) */
async function complete() {
  busy.value = true;
  error.value = "";
  try {
    const { publicUrl } = await setupApi.complete();
    location.href = `${publicUrl}/`;
  } catch (err) {
    error.value = (err as Error).message;
    busy.value = false;
  }
}

// ---------- 小工具 ----------
async function copy(text: string) {
  await navigator.clipboard?.writeText(text).catch(() => {});
}
const date = (iso?: string) => (iso ? iso.slice(0, 10) : "");
const LOGS = "sudo docker compose -f /opt/ferry/docker-compose.yml logs ferry --tail 50";
const BACKUP_CMD = "sudo cp /opt/ferry/.env ~/ferry-env-backup";
const CODE_CMD = "sudo docker compose -f /opt/ferry/docker-compose.yml exec ferry cat /data/state/setup-code";
</script>

<template>
  <main class="card">
    <div class="head">
      <div class="logo"><Icon name="ferry" /></div>
      <h1>设置 Ferry</h1>
      <span class="count">第 {{ step }} / 7 步</span>
    </div>
    <ol class="stepper">
      <li
        v-for="(name, i) in STEPS"
        :key="name"
        :class="{
          done: i + 1 < step,
          now: i + 1 === step,
          skipped: i === 2 && skipped && step > 3,
        }"
      >
        <span class="dot">
          <template v-if="i === 2 && skipped && step > 3">–</template>
          <Icon v-else-if="i + 1 < step" name="check" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="name">{{ i === 2 && skipped && step > 3 ? "证书(跳过)" : name }}</span>
      </li>
    </ol>

    <p v-if="view === 'loading'" class="busy"><span class="spin" />正在读取设置进度……</p>

    <!-- ===== 第 1 步 ===== -->
    <form v-else-if="view === 'code'" @submit.prevent="submitCode">
      <h2>输入设置码</h2>
      <p class="lead">设置码在安装结束时显示过,用来确认是你在设置这台服务器。</p>
      <div class="note warn"><Icon name="alert" /><span>浏览器提示“不安全”是正常的,第 4 步换成正式证书后就不会了。</span></div>
      <label for="code">设置码</label>
      <input id="code" v-model="code" type="text" class="mono" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX" required autofocus />
      <p v-if="error" class="msg bad">{{ error }}</p>
      <details>
        <summary>找不到设置码?</summary>
        <div class="body">
          在服务器上运行:
          <div class="cmd"><pre>{{ CODE_CMD }}</pre><button type="button" class="copy" title="复制" @click="copy(CODE_CMD)"><Icon name="copy" /></button></div>
        </div>
      </details>
      <div class="actions"><span class="spacer" /><button class="btn pri" type="submit" :disabled="busy">继续 <Icon name="arrow" /></button></div>
    </form>

    <!-- ===== 第 2 步 ===== -->
    <section v-else-if="view === 'domain'">
      <h2>设置域名</h2>
      <p class="lead">在公司域名下加两条解析记录,指向这台服务器。</p>
      <div class="grid3">
        <div><label for="domain">公司域名</label><input id="domain" v-model="form.domain" type="text" placeholder="example.com" /></div>
        <div><label for="ferrySub">Ferry 子域名</label><input id="ferrySub" v-model="form.ferrySub" type="text" /></div>
        <div><label for="appsSub">应用子域名</label><input id="appsSub" v-model="form.appsSub" type="text" /></div>
      </div>
      <label for="ip">服务器内网 IP <small v-if="status?.suggestedIp">已按打开本页的地址填好</small></label>
      <input id="ip" v-model="form.serverIp" type="text" placeholder="10.0.0.5" />
      <label>要添加的记录</label>
      <table class="records">
        <thead><tr><th>主机记录</th><th>类型</th><th>记录值</th><th>用途</th></tr></thead>
        <tbody>
          <tr>
            <td><code>{{ form.ferrySub || "ferry" }}</code> <button type="button" class="copy" title="复制" @click="copy(form.ferrySub)"><Icon name="copy" /></button></td>
            <td>A</td><td>{{ form.serverIp }}</td><td class="what">{{ names.ferry }}</td>
          </tr>
          <tr>
            <td><code>*.{{ form.appsSub || "apps" }}</code> <button type="button" class="copy" title="复制" @click="copy(`*.${form.appsSub}`)"><Icon name="copy" /></button></td>
            <td>A</td><td>{{ form.serverIp }}</td><td class="what">所有应用,如 expense.{{ names.apps }}</td>
          </tr>
        </tbody>
      </table>
      <details>
        <summary>在阿里云上怎么加</summary>
        <div class="body"><ol>
          <li>云解析 DNS → 找到 <b>{{ names.domain }}</b> → 解析设置。</li>
          <li>添加记录:类型 A,主机记录和记录值按上表填,其余默认。两条都加。</li>
          <li>通常一两分钟生效。</li>
        </ol></div>
      </details>
      <p v-if="busy" class="busy"><span class="spin" />正在服务器上检测解析……</p>
      <CheckResult v-if="domainResult" :title="domainResult.ok ? '检测通过' : '检测没通过'" :items="domainResult.items">
        <template v-if="domainResult.hint">{{ domainResult.hint }}</template>
      </CheckResult>
      <p v-if="error" class="msg bad">{{ error }}</p>
      <div class="actions">
        <span class="spacer" />
        <button v-if="domainResult?.ok" class="btn pri" @click="go('certificate')">下一步 <Icon name="arrow" /></button>
        <button v-else class="btn pri" :disabled="busy || !form.domain || !form.serverIp" @click="checkDomain">检测</button>
      </div>
    </section>

    <!-- ===== 第 3 步 ===== -->
    <section v-else-if="view === 'certificate'">
      <h2>上传证书</h2>
      <p class="lead">证书要同时覆盖 <code>{{ wizard?.domain?.ferryHost }}</code> 和 <code>*.{{ wizard?.domain?.appsDomain }}</code>。</p>
      <div class="grid2">
        <div>
          <label>证书文件</label>
          <label class="drop" :class="{ filled: files.chain }">
            <span class="ic"><Icon name="file" /></span>
            <span><b>{{ files.chain?.name ?? "选择文件" }}</b><small>{{ files.chain ? "点击更换" : ".pem / .crt" }}</small></span>
            <input type="file" accept=".pem,.crt,.cer" @change="pick('chain', $event)" />
          </label>
        </div>
        <div>
          <label>私钥文件</label>
          <label class="drop" :class="{ filled: files.key }">
            <span class="ic"><Icon name="key" /></span>
            <span><b>{{ files.key?.name ?? "选择文件" }}</b><small>{{ files.key ? "点击更换" : ".key" }}</small></span>
            <input type="file" accept=".key,.pem" @change="pick('key', $event)" />
          </label>
        </div>
      </div>
      <details>
        <summary>怎么申请证书</summary>
        <div class="body"><ol>
          <li>阿里云 → 数字证书管理服务 → 购买支持<b>通配符</b>的 DV 证书(免费证书不支持泛域名)。</li>
          <li>申请时填上面两个域名,按提示完成验证。</li>
          <li>下载时选 <b>Nginx</b> 格式,得到 .pem 和 .key。</li>
        </ol></div>
      </details>
      <p class="note info" style="margin-top: 14px"><Icon name="info" /><span>私钥只交给服务器上的 Traefik,Ferry 不保存。</span></p>
      <p v-if="busy" class="busy"><span class="spin" />正在检查证书,装好后会实际连一次确认……</p>
      <CheckResult
        v-if="certResult"
        :title="certResult.ok ? (certResult.items.some((i) => i.state === 'warn') ? '已安装,证书快到期' : '已安装') : certResult.installed ? '安装后验证没通过' : '证书不能用'"
        :items="certResult.items"
      >
        <template v-if="certResult.ok && certResult.items.some((i) => i.state === 'warn')">可以先继续;到期前记得换新证书。</template>
        <template v-else-if="!certResult.ok && certResult.items.at(-1)?.key === 'install'">Traefik 可能还没加载新证书,等半分钟再试一次。</template>
      </CheckResult>
      <CheckResult v-if="confirmSkip" kind="warn" title="先用 HTTP?" :items="[
        { key: 'a', state: 'warn', message: '密码、agent 令牌在内网明文传输' },
        { key: 'b', state: 'ok', message: '之后在控制台“证书”页上传,自动换成 HTTPS' },
      ]">
        <div class="actions" style="margin-top: 4px">
          <button class="btn ghost" @click="confirmSkip = false">取消</button>
          <button class="btn pri" :disabled="busy" @click="skipCertificate">先用 HTTP</button>
        </div>
      </CheckResult>
      <p v-if="error" class="msg bad">{{ error }}</p>
      <div class="actions">
        <button class="btn ghost" @click="go('domain')">上一步</button>
        <button v-if="!confirmSkip" class="link" @click="confirmSkip = true">暂时不用 HTTPS</button>
        <span class="spacer" />
        <button v-if="certResult?.ok" class="btn pri" @click="go('switch')">下一步 <Icon name="arrow" /></button>
        <button v-else class="btn pri" :disabled="busy || !files.chain || !files.key" @click="installCertificate">检查并安装</button>
      </div>
    </section>

    <!-- ===== 第 4 步:切换前 ===== -->
    <section v-else-if="view === 'switch'">
      <h2>切到正式地址</h2>
      <p class="lead">{{ skipped ? "保存后 Ferry 会重启(约十几秒),然后请在新标签页里确认能打开。" : "保存后 Ferry 会重启(约十几秒),然后自动跳到正式地址。" }}</p>
      <dl class="summary">
        <dt>Ferry</dt><dd>{{ officialUrl }}</dd>
        <dt>应用</dt><dd>{{ appsUrl }}</dd>
        <dt>证书</dt>
        <dd v-if="skipped" style="color: var(--warn)">未启用 HTTPS</dd>
        <dd v-else>{{ date(wizard?.certificate?.notAfter) }} 到期</dd>
      </dl>
      <p v-if="phase === 'restarting'" class="busy"><span class="spin" />正在保存并重启 Ferry……</p>
      <CheckResult v-if="phase === 'stuck'" kind="bad" title="Ferry 重启后没有响应">
        查看日志,处理后刷新本页继续:
        <div class="cmd"><pre>{{ LOGS }}</pre><button type="button" class="copy" title="复制" @click="copy(LOGS)"><Icon name="copy" /></button></div>
        本机开发(pnpm dev)不会自动拉起,要手动重启。
      </CheckResult>
      <p v-if="error" class="msg bad">{{ error }}</p>
      <div class="actions">
        <button class="btn ghost" :disabled="busy" @click="go('certificate')">上一步</button>
        <span class="spacer" />
        <button class="btn pri" :disabled="busy" @click="switchAddress">保存并切换</button>
      </div>
    </section>

    <!-- ===== 第 4 步:重启之后(还在服务器 IP 上) ===== -->
    <section v-else-if="view === 'after'">
      <h2>切到正式地址</h2>
      <p class="lead">Ferry 已经按新地址重启。</p>
      <dl class="summary">
        <dt>Ferry</dt><dd>{{ officialUrl }}</dd>
        <dt>应用</dt><dd>{{ appsUrl }}</dd>
      </dl>
      <p v-if="phase === 'checking'" class="busy">
        <span class="spin" />检查你的电脑能否打开 {{ officialUrl }}<template v-if="waitedSeconds">(已等 {{ waitedSeconds }} 秒)</template>……
      </p>
      <p v-if="phase === 'redirecting'" class="busy"><span class="spin" />可以打开了,正在跳转……</p>
      <CheckResult v-if="phase === 'confirm'" kind="ok" title="Ferry 已重启">
        在新标签页打开 <a :href="officialUrl" target="_blank" rel="noopener">{{ officialUrl }} <Icon name="external" /></a>,能看到页面就继续。
      </CheckResult>
      <CheckResult v-if="phase === 'unreachable'" kind="bad" :title="`打不开 ${officialUrl}`" :items="[
        { key: 'a', state: 'warn', message: `解析还没生效:运行 nslookup ${wizard?.domain?.ferryHost} 看是否为 ${wizard?.domain?.serverIp}` },
        { key: 'b', state: 'warn', message: '电脑用了别的 DNS(如 8.8.8.8):改回公司默认 DNS' },
        { key: 'e', state: 'warn', message: '电脑不信任证书:公司内部 CA 签发的,要先把 CA 根证书装到电脑上' },
        { key: 'c', state: 'warn', message: `路由器拦截内网地址:请 IT 把 ${wizard?.domain?.domain} 加入允许列表` },
        { key: 'd', state: 'warn', message: `浏览器走了代理:把 *.${wizard?.domain?.domain} 加入代理例外` },
      ]" />
      <p v-if="phase === 'restarting'" class="busy"><span class="spin" />正在撤销并重启 Ferry……</p>
      <CheckResult v-if="phase === 'stuck'" kind="bad" title="Ferry 重启后没有响应">
        查看日志,处理后刷新本页继续:
        <div class="cmd"><pre>{{ LOGS }}</pre><button type="button" class="copy" title="复制" @click="copy(LOGS)"><Icon name="copy" /></button></div>
        本机开发(pnpm dev)不会自动拉起,要手动重启。
      </CheckResult>
      <p v-if="error" class="msg bad">{{ error }}</p>
      <div class="actions">
        <button v-if="phase === 'unreachable' || phase === 'confirm'" class="btn ghost" :disabled="busy" @click="undoSwitch">回到域名设置</button>
        <span class="spacer" />
        <button v-if="phase === 'unreachable' && !skipped" class="btn pri" @click="afterSwitch">再检查一次</button>
        <button v-if="phase === 'confirm'" class="btn pri" :disabled="busy" @click="confirmHttp">能打开,继续 <Icon name="arrow" /></button>
        <button v-if="phase === 'unreachable' && skipped" class="btn pri" :disabled="busy" @click="confirmHttp">已解决,继续</button>
      </div>
      <p v-if="phase === 'confirm'" style="margin: 12px 0 0"><button class="link" @click="phase = 'unreachable'">打不开?</button></p>
    </section>

    <!-- ===== 第 5 步:公司和管理员 ===== -->
    <section v-else-if="view === 'admin'">
      <h2>公司和管理员</h2>
      <p class="lead">建立公司(最上级部门)和第一个平台管理员。</p>
      <form @submit.prevent="createAdmin">
        <label for="co">公司名称</label><input id="co" v-model="admin.orgName" type="text" placeholder="如:某某科技" maxlength="50" required>
        <div class="grid2">
          <div><label for="nm">管理员姓名</label><input id="nm" v-model="admin.name" type="text" maxlength="50" required></div>
          <div><label for="ph">手机号 <small>用来登录</small></label><input id="ph" v-model="admin.mobile" type="tel" autocomplete="username" required></div>
          <div><label for="pw">密码 <small>至少 8 位,不能全是数字</small></label><input id="pw" v-model="admin.password" type="password" autocomplete="new-password" required></div>
          <div><label for="pw2">再输一次</label><input id="pw2" v-model="admin.password2" type="password" autocomplete="new-password" required></div>
        </div>
        <p v-if="error" class="msg bad">{{ error }}</p>
        <div class="actions"><span class="spacer" /><button class="btn pri" type="submit" :disabled="busy">创建 <Icon name="arrow" /></button></div>
      </form>
    </section>

    <!-- ===== 第 6 步:自检(阶段 3b 再做,现在只能跳过) ===== -->
    <section v-else-if="view === 'selfcheck'">
      <h2>自检</h2>
      <p class="lead">发布一个测试应用,确认能上线、未登录会跳到登录页,然后删掉它。</p>
      <div class="note info"><Icon name="info" /><span>自检还在开发中,这一版请先跳过。</span></div>
      <CheckResult v-if="confirmSkipCheck" kind="warn" title="跳过自检?" :items="[{ key: 'a', state: 'warn', message: '跳过会记在审计日志里' }]">
        <div class="actions" style="margin-top: 10px">
          <button class="btn ghost" @click="confirmSkipCheck = false">取消</button>
          <button class="btn pri" :disabled="busy" @click="skipSelfCheck">确定跳过</button>
        </div>
      </CheckResult>
      <p v-if="error" class="msg bad">{{ error }}</p>
      <div v-if="!confirmSkipCheck" class="actions" style="margin-top: 20px">
        <span class="spacer" />
        <button class="btn pri" @click="confirmSkipCheck = true">跳过自检</button>
      </div>
    </section>

    <!-- ===== 第 7 步:完成 ===== -->
    <section v-else-if="view === 'done'">
      <div class="done-hero">
        <div class="badge"><Icon name="check" /></div>
        <h2>设置完成</h2>
        <p class="lead" style="margin-bottom: 22px">点“进入控制台”后,这个向导会永久关闭。</p>
      </div>
      <div v-if="skipped" class="note warn" style="margin-bottom: 10px"><Icon name="alert" /><span><b>还没启用 HTTPS</b>:之后到控制台“证书”页上传证书。</span></div>
      <div class="note warn"><Icon name="alert" /><span><b>请备份服务器上的 .env</b>:里面的 SECRETS_KEY 丢了,所有应用的密钥都无法解密。</span></div>
      <div class="cmd"><pre>{{ BACKUP_CMD }}</pre><button type="button" class="copy" title="复制" @click="copy(BACKUP_CMD)"><Icon name="copy" /></button></div>
      <dl class="summary" style="margin-top: 16px">
        <dt>控制台</dt><dd>{{ officialUrl }}</dd>
        <dt>管理员</dt><dd>{{ wizard?.admin?.name }} · {{ wizard?.admin?.orgName }}</dd>
        <dt>证书</dt><dd>{{ skipped ? "未启用 HTTPS" : `${date(wizard?.certificate?.notAfter)} 到期` }}</dd>
      </dl>
      <p v-if="error" class="msg bad">{{ error }}</p>
      <div class="actions"><span class="spacer" /><button class="btn pri" :disabled="busy" @click="complete">进入控制台 <Icon name="arrow" /></button></div>
    </section>
  </main>
</template>
