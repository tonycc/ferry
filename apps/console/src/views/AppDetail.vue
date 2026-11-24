<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, type AppDetail, type ReleaseSummary, type ReleaseView, type SecretView, type Visibility } from "../api";
import AppAvatar from "../components/AppAvatar.vue";
import StatusTag from "../components/StatusTag.vue";
import TableFooter from "../components/TableFooter.vue";
import { useLocalPagination } from "../composables/useLocalPagination";
import { appStatus, STATE, time, VISIBILITY, VISIBILITY_HINT } from "../labels";
import { secretNameProblem } from "@ferry/manifest/secrets";

const props = defineProps<{ name: string }>();

const app = ref<AppDetail>();
const loading = ref(true);
const visibility = ref<Visibility>("self");
const savingVisibility = ref(false);
const tab = ref<"releases" | "logs" | "secrets">(location.hash === "#secrets" ? "secrets" : "releases");
const releaseLogs = ref<Record<string, string>>({});
const logs = ref("");
const logLines = ref(200);
const loadingLogs = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
/** 应用密钥:值只在这里输入,保存后不再显示 */
const secrets = ref<SecretView[]>([]);
const secretForm = ref<{ name: string; value: string }>({ name: "", value: "" });
/** 替换已有密钥时锁定名称 */
const replacing = ref(false);
const savingSecret = ref(false);
const secretDialog = ref(false);
/** 正在进行的操作;下线要等容器停止,可能要十几秒 */
const acting = ref<"rollback" | "unpublish">();
/** 窄屏(手机)时信息改成一列 */
const narrowQuery = window.matchMedia("(max-width: 640px)");
const narrow = ref(narrowQuery.matches);
const onNarrow = (e: MediaQueryListEvent) => (narrow.value = e.matches);
narrowQuery.addEventListener("change", onNarrow);

/** 发布历史从新到旧,接口最多返回最近 50 条 */
const releases = computed(() => app.value?.releases ?? []);
const { currentPage: releasePage, pageSize: releasePageSize, total: releaseTotal, pagedItems: pagedReleases } = useLocalPagination(releases, [], 10);
// 发布进行中页面会自动刷新,新发布排在最前面;回到第一页,免得后面几页的行一条条往下挪
watch(releaseTotal, (next, prev) => {
  if (next > prev) releasePage.value = 1;
});

const running = computed(() => app.value?.releases.some((r) => !r.done) ?? false);
const canRollback = computed(() => !!app.value && app.value.live && !app.value.disabled && !app.value.unpublished && !running.value);
const canUnpublish = computed(() => !!app.value && !app.value.unpublished && !running.value);
const reachable = computed(() => !!app.value && app.value.live && !app.value.disabled && !app.value.unpublished);

async function load() {
  try {
    app.value = await api.get<AppDetail>(`/api/apps/${encodeURIComponent(props.name)}`);
    if (!savingVisibility.value) visibility.value = app.value.visibility;
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
  // 有发布在进行时每 5 秒刷新一次
  clearTimeout(timer);
  if (running.value) timer = setTimeout(load, 5000);
}

async function loadSecrets() {
  try {
    secrets.value = await api.get<SecretView[]>(`/api/apps/${encodeURIComponent(props.name)}/secrets`);
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

function openSecret(name?: string) {
  secretForm.value = { name: name ?? "", value: "" };
  replacing.value = !!name;
  secretDialog.value = true;
}

/** 名称规则和发布服务共用 */
const secretNameError = computed(() => (secretForm.value.name ? secretNameProblem(secretForm.value.name) ?? "" : ""));

async function saveSecret() {
  const { name, value } = secretForm.value;
  if (!name || secretNameError.value || !value) return;
  savingSecret.value = true;
  try {
    secrets.value = await api.post<SecretView[]>(`/api/apps/${encodeURIComponent(props.name)}/secrets`, { name, value });
    secretDialog.value = false;
    ElMessage.success("已保存。下次发布或回滚后生效");
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    // 不管成没成功都不把值留在页面里
    secretForm.value.value = "";
    savingSecret.value = false;
  }
}

async function deleteSecret(name: string) {
  try {
    await ElMessageBox.confirm(`删除后,应用下次发布或回滚时就读不到 ${name} 了。`, "删除密钥", {
      confirmButtonText: "删除",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    secrets.value = await api.post<SecretView[]>(`/api/apps/${encodeURIComponent(props.name)}/secrets/${encodeURIComponent(name)}/delete`);
    ElMessage.success("已删除。下次发布或回滚后生效");
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

async function saveVisibility() {
  if (!app.value || visibility.value === app.value.visibility) return;
  try {
    await ElMessageBox.confirm(
      `改为“${VISIBILITY[visibility.value]}”:${VISIBILITY_HINT[visibility.value]}。立即生效。`,
      "修改谁能看",
      { confirmButtonText: "确认修改", cancelButtonText: "取消" },
    );
  } catch {
    visibility.value = app.value.visibility;
    return;
  }
  savingVisibility.value = true;
  try {
    await api.post(`/api/apps/${encodeURIComponent(props.name)}/visibility`, { visibility: visibility.value });
    ElMessage.success("已修改");
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    savingVisibility.value = false;
  }
}

async function rollback() {
  try {
    await ElMessageBox.confirm(
      "把应用恢复到上一个上线过的版本。只恢复代码,不恢复数据库:旧代码会运行在现在的数据库上。",
      "回到上一个版本",
      { confirmButtonText: "确认回滚", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }
  acting.value = "rollback";
  try {
    await api.post(`/api/apps/${encodeURIComponent(props.name)}/rollback`);
    ElMessage.success("已开始回滚");
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    acting.value = undefined;
  }
}

async function unpublish() {
  try {
    await ElMessageBox.prompt(
      `下线后访问地址立即失效,同事都无法再访问。数据库会停止,但数据保留;以后用同一个应用名重新发布即可恢复。` +
        `长期不用的已下线应用,平台管理员可能会彻底删除,删除后数据无法恢复。请输入应用名 ${props.name} 确认:`,
      "下线应用",
      {
        confirmButtonText: "下线",
        cancelButtonText: "取消",
        type: "warning",
        inputValidator: (value: string) => value === props.name || "应用名不一致",
      },
    );
  } catch {
    return;
  }
  acting.value = "unpublish";
  try {
    await api.post(`/api/apps/${encodeURIComponent(props.name)}/unpublish`);
    ElMessage.success("已下线");
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    acting.value = undefined;
  }
}

/** 展开一次发布时读取它的失败日志(只读一次) */
async function expand(row: ReleaseSummary) {
  if (!row.error || row.releaseId in releaseLogs.value) return;
  try {
    const view = await api.get<ReleaseView>(`/api/releases/${row.releaseId}`);
    releaseLogs.value[row.releaseId] = view.error?.logs || "(没有日志)";
  } catch (err) {
    releaseLogs.value[row.releaseId] = (err as Error).message;
  }
}

async function loadLogs() {
  loadingLogs.value = true;
  try {
    const result = await api.get<{ logs: string }>(`/api/apps/${encodeURIComponent(props.name)}/logs?lines=${logLines.value}`);
    logs.value = result.logs || "(没有日志)";
  } catch (err) {
    logs.value = (err as Error).message;
  } finally {
    loadingLogs.value = false;
  }
}

function duration(r: ReleaseSummary): string {
  if (!r.finishedAt) return "—";
  const s = Math.round((Date.parse(r.finishedAt) - Date.parse(r.createdAt)) / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

watch(tab, (t) => {
  if (t === "logs" && !logs.value) void loadLogs();
  if (t === "secrets") void loadSecrets();
});
watch(() => props.name, () => {
  loading.value = true;
  logs.value = "";
  releaseLogs.value = {};
  secrets.value = [];
  if (tab.value === "secrets") void loadSecrets();
  void load();
});
onMounted(() => {
  void load();
  if (tab.value === "secrets") void loadSecrets();
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  narrowQuery.removeEventListener("change", onNarrow);
});
</script>

<template>
  <section v-loading="loading" class="ops-page">
    <template v-if="app">
      <el-alert v-if="app.disabled" type="error" :closable="false" show-icon
        title="应用已被管理员停用:同事无法访问,也不能发布。请联系平台管理员。"
        :description="app.disabledReason ? `原因:${app.disabledReason}` : undefined" />
      <el-alert v-else-if="app.unpublished" type="info" :closable="false" show-icon
        title="应用已下线,数据保留。让 agent 用同一个应用名重新发布即可恢复。"
        description="长期不用的已下线应用,平台管理员可能会彻底删除,删除后数据无法恢复。" />
      <el-alert v-if="running" type="info" :closable="false" show-icon title="有一次发布正在进行,页面会自动刷新。" />

      <div class="content-panel">
        <div class="panel-toolbar">
          <div class="heading">
            <AppAvatar :name="app.name" :size="30" :muted="!reachable" />
            <span class="panel-title">基本信息</span>
            <StatusTag :type="appStatus(app)[1]">{{ appStatus(app)[0] }}</StatusTag>
          </div>
          <div class="actions">
            <el-button v-if="reachable" tag="a" :href="app.url" target="_blank" rel="noopener" type="primary">打开应用</el-button>
            <el-button :disabled="!canRollback || !!acting" :loading="acting === 'rollback'" @click="rollback">回到上一个版本</el-button>
            <el-button :disabled="!canUnpublish || !!acting" :loading="acting === 'unpublish'" type="danger" plain @click="unpublish">
              {{ acting === "unpublish" ? "正在下线" : "下线" }}
            </el-button>
          </div>
        </div>
        <el-descriptions :column="narrow ? 1 : 2" border>
          <el-descriptions-item label="访问地址" :span="narrow ? 1 : 2">
            <a v-if="reachable" :href="app.url" target="_blank" rel="noopener">{{ app.url }}</a>
            <span v-else class="muted">{{ app.url }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="谁能看" :span="narrow ? 1 : 2">
            <div class="visibility">
              <el-select v-model="visibility" style="width: 140px" :disabled="savingVisibility">
                <el-option v-for="(label, key) in VISIBILITY" :key="key" :value="key" :label="label" />
              </el-select>
              <el-button v-if="visibility !== app.visibility" type="primary" :loading="savingVisibility" @click="saveVisibility">保存</el-button>
              <span class="muted">{{ VISIBILITY_HINT[visibility] }}</span>
            </div>
            <div class="muted note">
              {{ app.visibilityPinned ? "以这里的设置为准,agent 发布时 app.yaml 里的 visibility 不再起作用。" : "应用第一次上线前,以 app.yaml 里的 visibility 为准;在这里改过之后以这里为准。" }}
            </div>
          </el-descriptions-item>
          <el-descriptions-item label="端口">{{ app.port ?? "—" }}</el-descriptions-item>
          <el-descriptions-item label="健康检查">{{ app.healthcheck ?? "—" }}</el-descriptions-item>
          <el-descriptions-item label="数据库">{{ app.database === "postgres" ? "PostgreSQL" : app.database ? "无" : "—" }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ time(app.createdAt) }}</el-descriptions-item>
        </el-descriptions>
      </div>

      <div class="content-panel tabs-panel">
        <el-tabs v-model="tab">
          <el-tab-pane label="发布历史" name="releases">
            <el-table :data="pagedReleases" class="data-table" row-key="releaseId" @expand-change="expand">
              <el-table-column type="expand">
                <template #default="{ row }">
                  <div class="expand">
                    <template v-if="row.error">
                      <p><b>{{ row.error.message }}</b></p>
                      <p v-if="row.error.hint" class="muted">处理建议:{{ row.error.hint }}</p>
                      <pre class="logs">{{ releaseLogs[row.releaseId] ?? "读取中…" }}</pre>
                    </template>
                    <p v-else class="muted">版本 {{ row.version }}</p>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="时间" width="180">
                <template #default="{ row }">{{ time(row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="类型" width="80">
                <template #default="{ row }">{{ row.kind === "rollback" ? "回滚" : "发布" }}</template>
              </el-table-column>
              <el-table-column label="结果" width="190">
                <template #default="{ row }">
                  <StatusTag :type="STATE[row.state as keyof typeof STATE][1]">{{ STATE[row.state as keyof typeof STATE][0] }}</StatusTag>
                  <StatusTag v-if="row.live" type="success" plain class="live">线上版本</StatusTag>
                </template>
              </el-table-column>
              <el-table-column label="用时" width="100">
                <template #default="{ row }">{{ duration(row) }}</template>
              </el-table-column>
              <el-table-column label="说明" min-width="220" show-overflow-tooltip>
                <template #default="{ row }">{{ row.error?.message ?? "" }}</template>
              </el-table-column>
              <template #empty>还没有发布过</template>
            </el-table>
            <TableFooter v-model:current-page="releasePage" v-model:page-size="releasePageSize" :total="releaseTotal" unit="次发布" :page-sizes="[10, 20, 50]" />
          </el-tab-pane>
          <el-tab-pane label="密钥" name="secrets">
            <p class="panel-note secret-intro">
              应用要用的第三方密钥(大模型 API key、群机器人 webhook 等)填在这里,不要写进代码。
              应用里用 <code>process.env.名称</code> 读取。值保存后不再显示,只能替换或删除;
              <b>改动在下次发布或回滚后生效</b>(改完让 agent 再发布一次)。
            </p>
            <div class="log-bar">
              <el-button type="primary" @click="openSecret()">添加密钥</el-button>
            </div>
            <el-table :data="secrets" class="data-table" row-key="name">
              <el-table-column label="名称" min-width="200">
                <template #default="{ row }"><code>{{ row.name }}</code></template>
              </el-table-column>
              <el-table-column label="更新时间" width="180">
                <template #default="{ row }">{{ time(row.updatedAt) }}</template>
              </el-table-column>
              <el-table-column label="" width="160" align="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openSecret(row.name)">替换</el-button>
                  <el-button link type="danger" @click="deleteSecret(row.name)">删除</el-button>
                </template>
              </el-table-column>
              <template #empty>还没有密钥</template>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="运行日志" name="logs">
            <div class="log-bar">
              <span class="muted">最近</span>
              <el-select v-model="logLines" style="width: 100px" @change="loadLogs">
                <el-option v-for="n in [100, 200, 500, 1000]" :key="n" :value="n" :label="`${n} 行`" />
              </el-select>
              <el-button :loading="loadingLogs" @click="loadLogs">刷新</el-button>
            </div>
            <pre class="logs tall">{{ logs }}</pre>
          </el-tab-pane>
        </el-tabs>
      </div>
    </template>

    <el-dialog v-model="secretDialog" :title="replacing ? `替换 ${secretForm.name}` : '添加密钥'" width="min(480px, 92vw)" @closed="secretForm = { name: '', value: '' }">
      <el-form label-position="top" @submit.prevent="saveSecret">
        <el-form-item label="名称" :error="secretNameError">
          <el-input v-model.trim="secretForm.name" :disabled="replacing" placeholder="如 LLM_API_KEY" autocomplete="off" spellcheck="false" />
        </el-form-item>
        <el-form-item label="值">
          <el-input v-model="secretForm.value" type="password" show-password placeholder="保存后不再显示" autocomplete="new-password" spellcheck="false" />
        </el-form-item>
        <p v-if="!replacing && secrets.some((s) => s.name === secretForm.name)" class="muted">已有同名密钥,保存会替换它。</p>
      </el-form>
      <template #footer>
        <el-button @click="secretDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingSecret" :disabled="!secretForm.name || !!secretNameError || !secretForm.value" @click="saveSecret">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.heading { display: flex; align-items: center; gap: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.actions .el-button + .el-button { margin-left: 0; }
.tabs-panel { padding-top: 6px; }
:deep(.el-descriptions__label) { white-space: nowrap; width: 88px; }
.visibility { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.note { margin-top: 6px; }
.live { margin-left: 6px; }
.expand { padding: 0 16px; }
.log-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.logs { background: #111827; color: #E5E7EB; padding: 12px 14px; border-radius: var(--radius-button); font-family: "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow: auto; margin: 8px 0 0; }
.secret-intro { margin: 4px 0 14px; }
.logs.tall { max-height: 560px; min-height: 120px; }
</style>
