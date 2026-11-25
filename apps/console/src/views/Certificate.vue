<script setup lang="ts">
import { CircleCheck, CircleClose, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { api, ApiError, type CertificateInstallResult, type CertificateStatus } from "../api";

/**
 * 证书页(只给平台管理员,docs/setup-wizard.md“一并要做的”):现在的证书和到期情况;上传新证书替换;
 * 还在用 http 时,上传后自动切到 https(Ferry 重启,已有应用的域名一起改成 https)。
 */

const status = ref<CertificateStatus>();
/** 本机开发没有正式地址时没有证书页 */
const unavailable = ref(false);
const files = reactive<{ chain?: { name: string; text: string }; key?: { name: string; text: string } }>({});
const result = ref<CertificateInstallResult>();
const installing = ref(false);
/** 切到 https 后等 Ferry 重启 */
const switching = ref("");

async function load() {
  try {
    status.value = await api.get<CertificateStatus>("/api/admin/certificate");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) unavailable.value = true;
    else ElMessage.error((err as Error).message);
  }
}
onMounted(load);

/** 还在用 http、地址不是写在 .env 里:装好后自动切到 https */
const willSwitch = computed(() => !!status.value && !status.value.https && !status.value.fixedByEnv);
const levelText = computed(() => {
  const s = status.value;
  if (!s?.certificate) return { type: "info" as const, text: "还没有证书" };
  if (s.level === "expired") return { type: "danger" as const, text: "已过期" };
  if (s.level === "urgent" || s.level === "expiring") return { type: s.level === "urgent" ? ("danger" as const) : ("warning" as const), text: `还有 ${s.daysLeft} 天过期` };
  return { type: "success" as const, text: `还有 ${s.daysLeft} 天过期` };
});
const date = (iso?: string) => (iso ? iso.slice(0, 10) : "");

async function pick(kind: "chain" | "key", event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  files[kind] = { name: file.name, text: await file.text() };
  result.value = undefined;
}

async function install() {
  if (!files.chain || !files.key) return;
  installing.value = true;
  result.value = undefined;
  try {
    result.value = await api.post<CertificateInstallResult>("/api/admin/certificate", { certificate: files.chain.text, privateKey: files.key.text });
    if (result.value.switchedTo) return void waitAndGo(result.value.switchedTo);
    if (result.value.installed) await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    installing.value = false;
  }
}

/**
 * Ferry 按 https 重启:等它重新起来后跳到 https 地址(要重新登录时会先到登录页)。
 * 查的是当前地址的 /healthz(同源、能读结果;切换后 http 也照样回答它,不跳转):
 * 先看到一次连不上或者不正常(旧进程退出了),或者已经过了 3 秒(旧进程回完话 0.5 秒就退出),再正常才算起来了。
 * 不能查 https 地址:跨域只能 no-cors,Traefik 在 Ferry 重启期间回的 502 也算“请求成功”
 */
async function waitAndGo(url: string) {
  switching.value = url;
  const start = Date.now();
  let sawDown = false;
  while (Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 1500));
    const ok = await fetch("/healthz", { cache: "no-store", signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) sawDown = true;
    else if (sawDown || Date.now() - start >= 3000) {
      location.href = `${url}/console/certificate`;
      return;
    }
  }
  ElMessage.error(`等了两分钟 Ferry 还没起来:请查看 Ferry 的日志,处理后手动打开 ${url}`);
}
</script>

<template>
  <section class="ops-page">
    <div v-if="unavailable" class="content-panel">
      <p class="panel-note">Ferry 没有正式地址(本机开发),没有证书可管理。</p>
    </div>

    <template v-else-if="status">
      <div class="content-panel">
        <div class="panel-toolbar"><div class="panel-title">现在的证书</div></div>
        <dl class="summary">
          <dt>Ferry</dt>
          <dd>{{ status.https ? "https" : "http" }}://{{ status.ferryHost }}</dd>
          <dt>应用</dt>
          <dd>{{ status.https ? "https" : "http" }}://应用名.{{ status.appsDomain }}</dd>
          <dt>证书</dt>
          <dd>
            <el-tag :type="levelText.type" size="small" effect="light">{{ levelText.text }}</el-tag>
            <span v-if="status.certificate" class="muted">{{ date(status.certificate.notAfter) }} 到期 · {{ status.certificate.domains.join("、") }}</span>
          </dd>
        </dl>
        <el-alert v-if="!status.https && status.fixedByEnv" type="info" :closable="false" show-icon class="gap">
          <template #title>
            地址写在服务器的 <code>.env</code> 里:装好证书后,把 <code>PUBLIC_URL</code> 改成 https、<code>APPS_URL_SCHEME</code> 改成 https,再重启 Ferry
          </template>
        </el-alert>
      </div>

      <div class="content-panel">
        <div class="panel-toolbar"><div class="panel-title">{{ status.certificate ? "上传新证书" : "上传证书" }}</div></div>
        <p class="panel-note">
          证书要同时覆盖 <code>{{ status.ferryHost }}</code> 和 <code>*.{{ status.appsDomain }}</code>(泛域名)。
          上传证书文件(含中间证书的 .pem 或 .crt)和私钥(.key)。私钥只交给 Dokploy,Ferry 不保存。
          <template v-if="willSwitch">装好后 Ferry 会切到 https 并重启(约十几秒),已有应用的地址也一起改成 https,http 的旧链接会自动跳转。</template>
        </p>
        <div class="files">
          <label class="file">
            <span>证书文件</span>
            <input type="file" accept=".pem,.crt,.cer" @change="pick('chain', $event)" />
            <em>{{ files.chain?.name ?? "未选择" }}</em>
          </label>
          <label class="file">
            <span>私钥文件</span>
            <input type="file" accept=".key,.pem" @change="pick('key', $event)" />
            <em>{{ files.key?.name ?? "未选择" }}</em>
          </label>
        </div>
        <el-button type="primary" :disabled="!files.chain || !files.key || !!switching" :loading="installing" @click="install">
          {{ willSwitch ? "检查并安装,切到 HTTPS" : "检查并安装" }}
        </el-button>

        <ul v-if="result" class="checks">
          <li v-for="item in result.items" :key="item.key + item.message" :class="item.state">
            <el-icon><CircleCheck v-if="item.state === 'ok'" /><CircleClose v-else-if="item.state === 'bad'" /><Warning v-else /></el-icon>
            <span>{{ item.message }}</span>
          </li>
        </ul>
        <el-alert v-if="switching" type="success" :closable="false" show-icon class="gap">
          <template #title>证书已装好,Ferry 正在切到 https 并重启,好了会自动打开 {{ switching }}……</template>
        </el-alert>
      </div>
    </template>
  </section>
</template>

<style scoped>
.summary {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px 20px;
  margin: 0;
  font-size: 14px;
}
.summary dt {
  color: var(--el-text-color-secondary);
}
.summary dd {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.gap {
  margin-top: 14px;
}
.files {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin: 4px 0 16px;
}
.file {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px dashed var(--el-border-color);
  border-radius: 10px;
  cursor: pointer;
  font-size: 13px;
}
.file span {
  font-weight: 600;
}
.file input {
  font-size: 12px;
}
.file em {
  font-style: normal;
  color: var(--el-text-color-secondary);
}
.checks {
  list-style: none;
  padding: 0;
  margin: 16px 0 0;
  display: grid;
  gap: 6px;
  font-size: 13px;
}
.checks li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.checks li .el-icon {
  margin-top: 2px;
}
.checks li.ok .el-icon {
  color: var(--el-color-success);
}
.checks li.bad .el-icon {
  color: var(--el-color-danger);
}
.checks li.warn .el-icon {
  color: var(--el-color-warning);
}
@media (max-width: 640px) {
  .files {
    grid-template-columns: 1fr;
  }
}
</style>
