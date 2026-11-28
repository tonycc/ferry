<script setup lang="ts">
import { CircleCheck, CircleClose, Lock, Upload, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { api, ApiError, type CertificateInstallResult } from "../api";
import { certificateStatus as status, loadCertificateStatus } from "../certificate";

const unavailable = ref(false);
const files = reactive<{ chain?: { name: string; text: string }; key?: { name: string; text: string } }>({});
const dragOver = reactive({ chain: false, key: false });
const result = ref<CertificateInstallResult>();
const installing = ref(false);
const switching = ref("");

async function load() {
  try {
    await loadCertificateStatus();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) unavailable.value = true;
    else ElMessage.error((err as Error).message);
  }
}
onMounted(() => void load());

const willSwitch = computed(() => !!status.value && !status.value.https && !status.value.fixedByEnv);
const levelText = computed(() => {
  const s = status.value;
  if (!s?.certificate) return { type: "info" as const, text: "还没有证书" };
  if (s.level === "expired") return { type: "danger" as const, text: "已过期" };
  if (s.level === "urgent" || s.level === "expiring") {
    return { type: s.level === "urgent" ? ("danger" as const) : ("warning" as const), text: `还有 ${s.daysLeft} 天过期` };
  }
  return { type: "success" as const, text: `剩余 ${s.daysLeft} 天有效` };
});
const date = (iso?: string) => (iso ? iso.slice(0, 10) : "");

async function loadFile(kind: "chain" | "key", file?: File) {
  if (!file) return;
  files[kind] = { name: file.name, text: await file.text() };
  result.value = undefined;
}

function pick(kind: "chain" | "key", event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  void loadFile(kind, file);
}

function onDrop(kind: "chain" | "key", event: DragEvent) {
  dragOver[kind] = false;
  const file = event.dataTransfer?.files?.[0];
  void loadFile(kind, file);
}

async function install() {
  if (!files.chain || !files.key) return;
  installing.value = true;
  result.value = undefined;
  try {
    result.value = await api.post<CertificateInstallResult>("/api/admin/certificate", {
      certificate: files.chain.text,
      privateKey: files.key.text,
    });
    if (result.value.switchedTo) return void waitAndGo(result.value.switchedTo);
    if (result.value.installed) {
      ElMessage.success("证书已安装并生效");
      await load();
    }
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    installing.value = false;
  }
}

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
  ElMessage.error(`等了两分钟 Ferry 还没起来：请查看 Ferry 的日志，处理后手动打开 ${url}`);
}
</script>

<template>
  <section class="ops-page">
    <div v-if="unavailable" class="content-panel">
      <el-empty description="当前未配置正式对外地址（本机开发模式），暂无证书可管理。" />
    </div>

    <template v-else-if="status">
      <div class="content-panel">
        <div class="panel-toolbar">
          <div class="panel-title">当前证书状态</div>
          <el-tag :type="levelText.type" effect="light" round>{{ levelText.text }}</el-tag>
        </div>

        <div class="cert-cards">
          <div class="cert-card">
            <span class="cert-label">Ferry 控制台地址</span>
            <code class="cert-val">{{ status.https ? "https" : "http" }}://{{ status.ferryHost }}</code>
          </div>
          <div class="cert-card">
            <span class="cert-label">员工应用域名模板</span>
            <code class="cert-val">{{ status.https ? "https" : "http" }}://应用名.{{ status.appsDomain }}</code>
          </div>
          <div class="cert-card">
            <span class="cert-label">到期时间</span>
            <span class="cert-val">{{ status.certificate ? date(status.certificate.notAfter) : "未安装证书" }}</span>
          </div>
        </div>

        <div v-if="status.certificate?.domains?.length" class="domains-row">
          <span class="cert-label">覆盖域名：</span>
          <el-tag v-for="d in status.certificate.domains" :key="d" size="small" effect="plain" type="info">{{ d }}</el-tag>
        </div>

        <el-alert v-if="!status.https && status.fixedByEnv" type="info" :closable="false" show-icon class="gap">
          <template #title>
            地址写在服务器的 <code>.env</code> 里：装好证书后，把 <code>PUBLIC_URL</code> 和 <code>APPS_URL_SCHEME</code> 改为 https 并重启 Ferry
          </template>
        </el-alert>
      </div>

      <div class="content-panel">
        <div class="panel-toolbar">
          <div class="panel-title">{{ status.certificate ? "替换 HTTPS 证书" : "上传 HTTPS 证书" }}</div>
        </div>
        <p class="panel-note">
          证书需同时覆盖 <code>{{ status.ferryHost }}</code> 与 <code>*.{{ status.appsDomain }}</code>（泛域名）。
          请上传完整证书链（含中间证书的 <code>.pem</code> 或 <code>.crt</code>）和私钥（<code>.key</code>），私钥直接交给 Dokploy，Ferry 不落盘保存。
          <template v-if="willSwitch">安装后 Ferry 将自动切换至 HTTPS 并重启（约十几秒），已有应用旧 HTTP 链接会自动跳转。</template>
        </p>

        <div class="files">
          <label
            class="drop-zone"
            :class="{ over: dragOver.chain, picked: !!files.chain }"
            @dragover.prevent="dragOver.chain = true"
            @dragleave="dragOver.chain = false"
            @drop.prevent="onDrop('chain', $event)"
          >
            <input type="file" accept=".pem,.crt,.cer" @change="pick('chain', $event)" />
            <span class="drop-icon">
              <el-icon><CircleCheck v-if="files.chain" /><Upload v-else /></el-icon>
            </span>
            <span class="drop-title">证书文件（.pem / .crt / .cer）</span>
            <span class="drop-sub">{{ files.chain ? `已选择：${files.chain.name}` : "点击选择或将文件拖拽到此处" }}</span>
          </label>

          <label
            class="drop-zone"
            :class="{ over: dragOver.key, picked: !!files.key }"
            @dragover.prevent="dragOver.key = true"
            @dragleave="dragOver.key = false"
            @drop.prevent="onDrop('key', $event)"
          >
            <input type="file" accept=".key,.pem" @change="pick('key', $event)" />
            <span class="drop-icon">
              <el-icon><CircleCheck v-if="files.key" /><Lock v-else /></el-icon>
            </span>
            <span class="drop-title">私钥文件（.key / .pem）</span>
            <span class="drop-sub">{{ files.key ? `已选择：${files.key.name}` : "点击选择或将文件拖拽到此处" }}</span>
          </label>
        </div>

        <el-button type="primary" :disabled="!files.chain || !files.key || !!switching" :loading="installing" @click="install">
          {{ willSwitch ? "检查并安装，同时切到 HTTPS" : "检查并安装证书" }}
        </el-button>

        <ul v-if="result" class="checks">
          <li v-for="item in result.items" :key="item.key + item.message" :class="item.state">
            <el-icon><CircleCheck v-if="item.state === 'ok'" /><CircleClose v-else-if="item.state === 'bad'" /><Warning v-else /></el-icon>
            <span>{{ item.message }}</span>
          </li>
        </ul>

        <el-alert v-if="switching" type="success" :closable="false" show-icon class="gap">
          <template #title>证书已安装，Ferry 正在切换至 HTTPS 并重启，完成后将自动跳转 {{ switching }}…</template>
        </el-alert>
      </div>
    </template>
  </section>
</template>

<style scoped>
.cert-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 780px) { .cert-cards { grid-template-columns: 1fr; } }
.cert-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid #EEF2F6;
  border-radius: 12px;
  background: var(--color-bg-page);
}
.cert-label { color: var(--color-text-muted); font-size: 12px; }
.cert-val { color: var(--color-text-heading); font-size: 13px; font-weight: 600; word-break: break-all; }
.domains-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.gap { margin-top: 14px; }

.files {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin: 6px 0 18px;
}
@media (max-width: 640px) { .files { grid-template-columns: 1fr; } }
.drop-zone {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 22px 16px;
  border: 1.5px dashed var(--color-border-strong);
  border-radius: 14px;
  background: var(--color-bg-page);
  text-align: center;
  cursor: pointer;
  transition: border-color 0.16s, background 0.16s, box-shadow 0.16s;
}
.drop-zone input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.drop-zone:hover, .drop-zone.over {
  border-color: var(--color-brand);
  background: var(--color-brand-hover);
}
.drop-zone.picked {
  border-style: solid;
  border-color: #10B981;
  background: #ECFDF5;
}
.drop-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: #fff;
  color: var(--color-brand);
  box-shadow: var(--shadow-card);
  font-size: 18px;
}
.drop-zone.picked .drop-icon { color: #059669; }
.drop-title { color: var(--color-text-heading); font-size: 13px; font-weight: 600; }
.drop-sub { color: var(--color-text-muted); font-size: 12px; word-break: break-all; }

.checks {
  list-style: none;
  padding: 12px 14px;
  margin: 16px 0 0;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-bg-page);
  display: grid;
  gap: 8px;
  font-size: 13px;
}
.checks li { display: flex; gap: 8px; align-items: flex-start; }
.checks li .el-icon { margin-top: 2px; flex-shrink: 0; }
.checks li.ok .el-icon { color: var(--el-color-success); }
.checks li.bad .el-icon { color: var(--el-color-danger); }
.checks li.warn .el-icon { color: var(--el-color-warning); }
</style>
