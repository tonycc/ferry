<script setup lang="ts">
import {
  Check,
  Close,
  CopyDocument,
  Download,
  Lock,
  Plus,
  Refresh,
  Search,
  TopRight,
} from "@element-plus/icons-vue";
import { secretNameProblem } from "@ferry/manifest/secrets";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, type AppDetail, type ReleaseState, type ReleaseSummary, type ReleaseView, type SecretView, type Visibility } from "../api";
import { copyText } from "../clipboard";
import AppAvatar from "../components/AppAvatar.vue";
import StatusTag from "../components/StatusTag.vue";
import TableFooter from "../components/TableFooter.vue";
import VisibilityChip from "../components/VisibilityChip.vue";
import { useLocalPagination } from "../composables/useLocalPagination";
import { appStatus, relativeTime, STATE, time, VISIBILITY, VISIBILITY_HINT } from "../labels";

const props = defineProps<{ name: string }>();

const app = ref<AppDetail>();
const loading = ref(true);
const refreshing = ref(false);
const visibility = ref<Visibility>("self");
const savingVisibility = ref(false);
const tab = ref<"releases" | "logs" | "secrets">(location.hash === "#secrets" ? "secrets" : "releases");
const releaseLogs = ref<Record<string, string>>({});
const logs = ref("");
const logLines = ref(200);
const logFilter = ref("");
const autoRefreshLogs = ref(false);
const loadingLogs = ref(false);
const logBoxRef = ref<HTMLElement>();
let timer: ReturnType<typeof setTimeout> | undefined;
let logTimer: ReturnType<typeof setInterval> | undefined;

/** 应用密钥:值只在这里输入,保存后不再显示 */
const secrets = ref<SecretView[]>([]);
const secretForm = ref<{ name: string; value: string }>({ name: "", value: "" });
/** 替换已有密钥时锁定名称 */
const replacing = ref(false);
const savingSecret = ref(false);
const secretDialog = ref(false);
/** 正在进行的操作;下线要等容器停止,可能要十几秒 */
const acting = ref<"rollback" | "unpublish">();

/** 发布历史从新到旧,接口最多返回最近 50 条 */
const releases = computed(() => app.value?.releases ?? []);
const latestRelease = computed(() => releases.value[0]);
const { currentPage: releasePage, pageSize: releasePageSize, total: releaseTotal, pagedItems: pagedReleases } = useLocalPagination(releases, [], 10);
watch(releaseTotal, (next, prev) => {
  if (next > prev) releasePage.value = 1;
});

const running = computed(() => app.value?.releases.some((r) => !r.done) ?? false);
const canRollback = computed(() => !!app.value && app.value.live && !app.value.disabled && !app.value.unpublished && !running.value);
const canUnpublish = computed(() => !!app.value && !app.value.unpublished && !running.value);
const reachable = computed(() => !!app.value && app.value.live && !app.value.disabled && !app.value.unpublished);

// ---- 可视化发布流水线阶段 ----
const PIPELINE_STEPS: { state: ReleaseState; label: string }[] = [
  { state: "VALIDATING", label: "检查代码" },
  { state: "PROVISIONING", label: "准备资源" },
  { state: "BUILDING", label: "构建部署" },
  { state: "MIGRATING", label: "迁移数据库" },
  { state: "VERIFYING", label: "健康检查" },
];

type StepStatus = "done" | "active" | "failed" | "waiting";
const pipelineSteps = computed(() => {
  const r = latestRelease.value;
  if (!r) return [];
  const order = PIPELINE_STEPS.map((s) => s.state);
  const failedStage = r.error?.stage;
  const currentIndex = order.indexOf(r.state);
  const failedIndex = failedStage ? order.indexOf(failedStage) : -1;

  return PIPELINE_STEPS.map((step, idx) => {
    let status: StepStatus = "waiting";
    if (r.state === "LIVE") {
      status = "done";
    } else if (r.done && failedIndex >= 0) {
      if (idx < failedIndex) status = "done";
      else if (idx === failedIndex) status = "failed";
    } else if (r.state === "PENDING") {
      status = idx === 0 ? "active" : "waiting";
    } else if (currentIndex >= 0) {
      if (idx < currentIndex) status = "done";
      else if (idx === currentIndex) status = "active";
    }
    return { ...step, status };
  });
});

// ---- 日志搜索过滤 ----
const filteredLogs = computed(() => {
  const raw = logs.value;
  const q = logFilter.value.trim().toLowerCase();
  if (!q || !raw) return raw;
  const matched = raw.split("\n").filter((line) => line.toLowerCase().includes(q));
  return matched.length > 0 ? matched.join("\n") : `(没有包含 “${logFilter.value.trim()}” 的日志行)`;
});
const matchedLogCount = computed(() => {
  const q = logFilter.value.trim().toLowerCase();
  if (!q || !logs.value) return 0;
  return logs.value.split("\n").filter((line) => line.toLowerCase().includes(q)).length;
});

async function load(manual = false) {
  if (manual) refreshing.value = true;
  try {
    app.value = await api.get<AppDetail>(`/api/apps/${encodeURIComponent(props.name)}`);
    if (!savingVisibility.value) visibility.value = app.value.visibility;
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
  clearTimeout(timer);
  if (running.value) timer = setTimeout(() => void load(), 5000);
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
    secretForm.value.value = "";
    savingSecret.value = false;
  }
}

async function deleteSecret(name: string) {
  try {
    await ElMessageBox.confirm(`删除后，应用下次发布或回滚时就读不到 ${name} 了。`, "删除密钥", {
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
      `改为“${VISIBILITY[visibility.value]}”：${VISIBILITY_HINT[visibility.value]}。立即生效。`,
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
    ElMessage.success("可见范围已更新");
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
      "把应用恢复到上一个上线过的版本。只恢复代码，不恢复数据库：旧代码会运行在现在的数据库上。",
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
      `下线后访问地址立即失效，同事都无法再访问。数据库会停止，但数据保留；以后用同一个应用名重新发布即可恢复。` +
        `长期不用的已下线应用，平台管理员可能会彻底删除，删除后数据无法恢复。请输入应用名 ${props.name} 确认：`,
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

async function expand(row: ReleaseSummary) {
  if (!row.error || row.releaseId in releaseLogs.value) return;
  try {
    const view = await api.get<ReleaseView>(`/api/releases/${row.releaseId}`);
    releaseLogs.value[row.releaseId] = view.error?.logs || "(没有日志)";
  } catch (err) {
    releaseLogs.value[row.releaseId] = (err as Error).message;
  }
}

/** 把失败摘要、建议和日志整理成结构化文本,方便员工直接发给 Agent 修复 */
async function copyFailureForAgent(row: ReleaseSummary) {
  if (!row.error) return;
  if (!(row.releaseId in releaseLogs.value)) await expand(row);
  const stageLabel = STATE[row.error.stage]?.[0] ?? row.error.stage;
  const text = [
    `我的应用 ${props.name} 在 Ferry 发布失败，请帮我排查并修复后重新发布：`,
    `- 失败阶段：${stageLabel}`,
    `- 错误信息：${row.error.message}`,
    ...(row.error.hint ? [`- 平台建议：${row.error.hint}`] : []),
    `- 错误日志：`,
    "```",
    releaseLogs.value[row.releaseId] || "(无日志)",
    "```",
  ].join("\n");
  await copyText(text, "已复制报错上下文，可直接粘贴给 Agent 修复");
}

async function loadLogs(scrollToBottom = false) {
  loadingLogs.value = true;
  try {
    const result = await api.get<{ logs: string }>(`/api/apps/${encodeURIComponent(props.name)}/logs?lines=${logLines.value}`);
    logs.value = result.logs || "(没有日志)";
    if (scrollToBottom) {
      await nextTick();
      if (logBoxRef.value) logBoxRef.value.scrollTop = logBoxRef.value.scrollHeight;
    }
  } catch (err) {
    logs.value = (err as Error).message;
  } finally {
    loadingLogs.value = false;
  }
}

function downloadLogs() {
  const blob = new Blob([logs.value || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${props.name}-logs.log`;
  a.click();
  URL.revokeObjectURL(url);
}

function duration(r: ReleaseSummary): string {
  if (!r.finishedAt) return running.value && !r.done ? "进行中…" : "—";
  const s = Math.round((Date.parse(r.finishedAt) - Date.parse(r.createdAt)) / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

watch(tab, (t) => {
  if (t === "logs" && !logs.value) void loadLogs(true);
  if (t === "secrets") void loadSecrets();
  if (t !== "logs") autoRefreshLogs.value = false;
});

watch(autoRefreshLogs, (on) => {
  clearInterval(logTimer);
  if (on) logTimer = setInterval(() => void loadLogs(true), 5000);
});

watch(() => props.name, () => {
  loading.value = true;
  logs.value = "";
  logFilter.value = "";
  autoRefreshLogs.value = false;
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
  clearInterval(logTimer);
});
</script>

<template>
  <section v-loading="loading" class="ops-page">
    <template v-if="app">
      <el-alert
        v-if="app.disabled"
        type="error"
        :closable="false"
        show-icon
        title="应用已被管理员停用：同事无法访问，也不能发布。请联系平台管理员。"
        :description="app.disabledReason ? `原因：${app.disabledReason}` : undefined"
      />
      <el-alert
        v-else-if="app.unpublished"
        type="info"
        :closable="false"
        show-icon
        title="应用已下线，数据保留。让 Agent 用同一个应用名重新发布即可恢复。"
        description="长期不用的已下线应用，平台管理员可能会彻底删除，删除后数据无法恢复。"
      />

      <!-- 顶部 Hero 概览卡 -->
      <div class="content-panel hero-panel">
        <div class="hero-top">
          <div class="hero-identity">
            <AppAvatar :name="app.name" :size="48" :muted="!reachable" />
            <div class="hero-title-wrap">
              <div class="hero-name-row">
                <h1>{{ app.name }}</h1>
                <StatusTag :type="appStatus(app)[1]" :pulse="reachable || running">{{ appStatus(app)[0] }}</StatusTag>
                <VisibilityChip :value="app.visibility" />
              </div>
              <div class="hero-url-row">
                <a v-if="reachable" class="url-link" :href="app.url" target="_blank" rel="noopener">
                  {{ app.url }}<el-icon><TopRight /></el-icon>
                </a>
                <span v-else class="muted">{{ app.url }}</span>
                <button
                  type="button"
                  class="copy-icon-btn"
                  title="复制访问地址"
                  @click="copyText(app.url, '已复制应用访问地址')"
                >
                  <el-icon><CopyDocument /></el-icon>
                </button>
              </div>
            </div>
          </div>

          <div class="actions">
            <el-button :icon="Refresh" :loading="refreshing" @click="load(true)">刷新</el-button>
            <el-button v-if="reachable" tag="a" :href="app.url" target="_blank" rel="noopener" type="primary">
              打开应用 <el-icon class="el-icon--right"><TopRight /></el-icon>
            </el-button>
            <el-button :disabled="!canRollback || !!acting" :loading="acting === 'rollback'" @click="rollback">回到上一版本</el-button>
            <el-button :disabled="!canUnpublish || !!acting" :loading="acting === 'unpublish'" type="danger" plain @click="unpublish">
              {{ acting === "unpublish" ? "正在下线…" : "下线应用" }}
            </el-button>
          </div>
        </div>

        <!-- 运行环境摘要胶囊 -->
        <div class="meta-strip">
          <div class="meta-item">
            <span class="meta-label">监听端口</span>
            <span class="meta-value code-val">{{ app.port ?? "—" }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">健康检查</span>
            <span class="meta-value code-val">{{ app.healthcheck ?? "—" }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">数据库</span>
            <span class="meta-value">{{ app.database === "postgres" ? "PostgreSQL" : app.database ? "无数据库" : "—" }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">创建时间</span>
            <span class="meta-value" :title="time(app.createdAt)">{{ relativeTime(app.createdAt) }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">累计发布</span>
            <span class="meta-value">{{ releases.length }} 次</span>
          </div>
        </div>

        <!-- 可视化发布流水线(有发布记录且正在进行或最近失败时展示) -->
        <div v-if="latestRelease && (!latestRelease.done || latestRelease.error)" class="pipeline-card">
          <div class="pipeline-head">
            <div class="pipeline-title">
              <span>最近一次{{ latestRelease.kind === "rollback" ? "回滚" : "发布" }}进度</span>
              <StatusTag :type="STATE[latestRelease.state][1]" :pulse="!latestRelease.done">
                {{ STATE[latestRelease.state][0] }}
              </StatusTag>
            </div>
            <span class="status-note">
              {{ !latestRelease.done ? "页面每 5 秒自动刷新" : `耗时 ${duration(latestRelease)}` }}
            </span>
          </div>
          <div class="pipeline-steps">
            <div v-for="(step, i) in pipelineSteps" :key="step.state" class="pipeline-step" :class="step.status">
              <span class="step-dot">
                <el-icon v-if="step.status === 'done'"><Check /></el-icon>
                <el-icon v-else-if="step.status === 'failed'"><Close /></el-icon>
                <span v-else>{{ i + 1 }}</span>
              </span>
              <span class="step-label">{{ step.label }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 访问控制(卡片化选择) -->
      <div class="content-panel">
        <div class="panel-toolbar">
          <div>
            <div class="panel-title">谁能访问这个应用</div>
            <p class="vis-sub">
              {{
                app.visibilityPinned
                  ? "以这里的设置为准，Agent 重新发布时 app.yaml 里的 visibility 不再覆盖。"
                  : "首次上线前按 app.yaml 设置；在这里修改一次后将锁定以控制台为准。"
              }}
            </p>
          </div>
          <div v-if="visibility !== app.visibility" class="vis-actions">
            <el-button @click="visibility = app.visibility">取消</el-button>
            <el-button type="primary" :loading="savingVisibility" @click="saveVisibility">保存并立即生效</el-button>
          </div>
        </div>
        <div class="vis-cards">
          <button
            v-for="(label, key) in VISIBILITY"
            :key="key"
            type="button"
            class="vis-card"
            :class="{ active: visibility === key }"
            :disabled="savingVisibility"
            @click="visibility = key"
          >
            <div class="vis-card-head">
              <VisibilityChip :value="key" />
              <span v-if="app.visibility === key" class="vis-current">当前生效</span>
            </div>
            <p>{{ VISIBILITY_HINT[key] }}</p>
          </button>
        </div>
      </div>

      <!-- 详情功能区:发布历史 / 密钥 / 运行日志 -->
      <div class="content-panel tabs-panel">
        <el-tabs v-model="tab">
          <el-tab-pane :label="`发布历史 (${releases.length})`" name="releases">
            <el-table :data="pagedReleases" class="data-table" row-key="releaseId" @expand-change="expand">
              <el-table-column type="expand">
                <template #default="{ row }">
                  <div class="expand">
                    <template v-if="row.error">
                      <div class="expand-error-head">
                        <div>
                          <p class="expand-msg">{{ row.error.message }}</p>
                          <p v-if="row.error.hint" class="muted">处理建议：{{ row.error.hint }}</p>
                        </div>
                        <el-button size="small" type="primary" plain :icon="CopyDocument" @click="copyFailureForAgent(row)">
                          复制报错给 Agent 修复
                        </el-button>
                      </div>
                      <div class="terminal-box">
                        <div class="terminal-header">
                          <span class="terminal-dots"><i /><i /><i /></span>
                          <span>失败日志</span>
                        </div>
                        <pre class="terminal-body expand-logs">{{ releaseLogs[row.releaseId] ?? "读取中…" }}</pre>
                      </div>
                    </template>
                    <p v-else class="muted">版本哈希：<code>{{ row.version }}</code></p>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="时间" width="180">
                <template #default="{ row }">
                  <span :title="time(row.createdAt)">{{ relativeTime(row.createdAt) }}</span>
                  <div class="status-note">{{ time(row.createdAt) }}</div>
                </template>
              </el-table-column>
              <el-table-column label="类型" width="84">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.kind === 'rollback' ? 'warning' : 'info'" effect="plain">
                    {{ row.kind === "rollback" ? "回滚" : "发布" }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="结果" width="210">
                <template #default="{ row }">
                  <StatusTag :type="STATE[row.state as keyof typeof STATE][1]" :pulse="!row.done">
                    {{ STATE[row.state as keyof typeof STATE][0] }}
                  </StatusTag>
                  <StatusTag v-if="row.live" type="success" plain class="live">线上版本</StatusTag>
                </template>
              </el-table-column>
              <el-table-column label="用时" width="100">
                <template #default="{ row }">{{ duration(row) }}</template>
              </el-table-column>
              <el-table-column label="说明" min-width="220" show-overflow-tooltip>
                <template #default="{ row }">
                  <span v-if="row.error" class="err-summary">{{ row.error.message }}</span>
                  <span v-else class="status-note">版本 {{ row.version.slice(0, 8) }}</span>
                </template>
              </el-table-column>
              <template #empty>还没有发布记录</template>
            </el-table>
            <TableFooter v-model:current-page="releasePage" v-model:page-size="releasePageSize" :total="releaseTotal" unit="次发布" :page-sizes="[10, 20, 50]" />
          </el-tab-pane>

          <el-tab-pane :label="secrets.length ? `应用密钥 (${secrets.length})` : '应用密钥'" name="secrets">
            <div class="secret-banner">
              <div class="secret-banner-icon"><el-icon><Lock /></el-icon></div>
              <div>
                <div class="secret-banner-title">安全注入第三方密钥，Agent 无法触碰明文</div>
                <p>
                  大模型 API Key、群机器人 Webhook 等敏感配置请填在这里，在代码中通过 <code>process.env.名称</code> 读取。
                  密钥经加密存储且保存后不再显示，<b>新增、替换或删除会在下次发布或回滚后生效</b>。
                </p>
              </div>
              <el-button type="primary" :icon="Plus" @click="openSecret()">添加密钥</el-button>
            </div>
            <el-table :data="secrets" class="data-table" row-key="name">
              <el-table-column label="环境变量名称" min-width="240">
                <template #default="{ row }">
                  <div class="url-row">
                    <code>{{ row.name }}</code>
                    <button
                      type="button"
                      class="copy-icon-btn"
                      title="复制 process.env 引用代码"
                      @click="copyText(`process.env.${row.name}`, `已复制 process.env.${row.name}`)"
                    >
                      <el-icon><CopyDocument /></el-icon>
                    </button>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="更新时间" width="200">
                <template #default="{ row }">
                  <span :title="time(row.updatedAt)">{{ relativeTime(row.updatedAt) }}</span>
                  <span class="status-note"> · {{ time(row.updatedAt) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="" width="150" align="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openSecret(row.name)">替换值</el-button>
                  <el-button link type="danger" @click="deleteSecret(row.name)">删除</el-button>
                </template>
              </el-table-column>
              <template #empty>还没有配置应用密钥</template>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="运行日志" name="logs">
            <div class="log-toolbar">
              <div class="filter-bar">
                <el-input
                  v-model="logFilter"
                  clearable
                  :prefix-icon="Search"
                  placeholder="按关键字过滤日志行…"
                  style="width: 240px"
                />
                <span v-if="logFilter.trim()" class="status-note">匹配 {{ matchedLogCount }} 行</span>
                <el-select v-model="logLines" style="width: 110px" @change="loadLogs(true)">
                  <el-option v-for="n in [100, 200, 500, 1000]" :key="n" :value="n" :label="`最近 ${n} 行`" />
                </el-select>
              </div>
              <div class="filter-bar">
                <el-switch v-model="autoRefreshLogs" active-text="每 5 秒刷新" />
                <el-button :icon="Refresh" :loading="loadingLogs" @click="loadLogs(true)">刷新</el-button>
                <el-button :icon="CopyDocument" :disabled="!logs" @click="copyText(filteredLogs, '已复制当前日志')">复制</el-button>
                <el-button :icon="Download" :disabled="!logs" @click="downloadLogs">下载</el-button>
              </div>
            </div>
            <div class="terminal-box">
              <div class="terminal-header">
                <span class="terminal-dots"><i /><i /><i /></span>
                <span>{{ app.name }} · stdout / stderr</span>
                <span>{{ autoRefreshLogs ? "自动轮询中" : `显示最近 ${logLines} 行` }}</span>
              </div>
              <pre ref="logBoxRef" class="terminal-body tall-logs">{{ filteredLogs || (loadingLogs ? "正在拉取运行日志…" : "(没有日志)") }}</pre>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </template>

    <el-dialog
      v-model="secretDialog"
      :title="replacing ? `替换密钥 ${secretForm.name}` : '添加应用密钥'"
      width="min(480px, 92vw)"
      @closed="secretForm = { name: '', value: '' }"
    >
      <el-form label-position="top" @submit.prevent="saveSecret">
        <el-form-item label="环境变量名称" :error="secretNameError">
          <el-input v-model.trim="secretForm.name" :disabled="replacing" placeholder="如 LLM_API_KEY、DINGTALK_WEBHOOK" autocomplete="off" spellcheck="false" />
        </el-form-item>
        <el-form-item label="密钥值">
          <el-input v-model="secretForm.value" type="password" show-password placeholder="单行文本，保存后不再显示明文" autocomplete="new-password" spellcheck="false" />
        </el-form-item>
        <p v-if="!replacing && secrets.some((s) => s.name === secretForm.name)" class="status-note">已有同名密钥，保存将会覆盖原值。</p>
      </el-form>
      <template #footer>
        <el-button @click="secretDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingSecret" :disabled="!secretForm.name || !!secretNameError || !secretForm.value" @click="saveSecret">保存密钥</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.hero-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.hero-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
}
.hero-identity { display: flex; align-items: center; gap: 14px; min-width: 0; }
.hero-title-wrap { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hero-name-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.hero-name-row h1 {
  margin: 0;
  color: var(--color-text-heading);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.hero-url-row { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.actions .el-button + .el-button { margin-left: 0; }

.meta-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #EEF2F6;
  border-radius: 12px;
  background: var(--color-bg-page);
}
@media (max-width: 900px) { .meta-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.meta-item { display: flex; flex-direction: column; gap: 3px; }
.meta-label { color: var(--color-text-muted); font-size: 11px; font-weight: 500; }
.meta-value { color: var(--color-text-heading); font-size: 13px; font-weight: 600; }
.code-val { font-family: "SF Mono", Menlo, monospace; }

/* ---- 可视化发布流水线 ---- */
.pipeline-card {
  padding: 14px 16px;
  border: 1px solid var(--color-brand-border);
  border-radius: 12px;
  background: linear-gradient(135deg, var(--color-brand-surface), var(--color-brand-soft));
}
.pipeline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}
.pipeline-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-heading);
  font-size: 13px;
  font-weight: 700;
}
.pipeline-steps {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}
@media (max-width: 680px) { .pipeline-steps { grid-template-columns: 1fr; } }
.pipeline-step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #E2E8F0;
  border-radius: 10px;
  background: #fff;
  font-size: 12px;
  color: var(--color-text-muted);
}
.step-dot {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #F1F5F9;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.pipeline-step.done { border-color: #A7F3D0; color: #047857; }
.pipeline-step.done .step-dot { background: #10B981; color: #fff; }
.pipeline-step.active {
  border-color: var(--color-brand);
  box-shadow: 0 0 0 3px var(--color-brand-soft);
  color: var(--color-brand);
  font-weight: 600;
}
.pipeline-step.active .step-dot { background: var(--gradient-brand); color: #fff; }
.pipeline-step.failed { border-color: #FECACA; background: #FEF2F2; color: #B91C1C; font-weight: 600; }
.pipeline-step.failed .step-dot { background: #EF4444; color: #fff; }

/* ---- 卡片化可见范围 ---- */
.vis-sub { margin: 4px 0 0; color: var(--color-text-muted); font-size: 12px; }
.vis-actions { display: flex; gap: 8px; }
.vis-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 768px) { .vis-cards { grid-template-columns: 1fr; } }
.vis-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #fff;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.vis-card:hover { border-color: var(--color-brand-border-strong); background: var(--color-brand-surface); }
.vis-card.active {
  border-color: var(--color-brand);
  background: var(--color-brand-surface);
  box-shadow: 0 0 0 3px var(--color-brand-soft);
}
.vis-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.vis-current { color: #059669; font-size: 11px; font-weight: 600; }
.vis-card p { margin: 0; color: var(--color-text-secondary); font-size: 12px; line-height: 1.5; }

/* ---- 标签页、密钥与日志 ---- */
.tabs-panel { padding-top: 8px; }
.live { margin-left: 6px; }
.err-summary { color: #B91C1C; }
.expand { padding: 8px 16px; }
.expand-error-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}
.expand-msg { margin: 0 0 4px; color: #B91C1C; font-weight: 600; }
.expand-logs { max-height: 320px; }

.secret-banner {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin: 4px 0 16px;
  padding: 14px 16px;
  border: 1px solid var(--color-brand-border);
  border-radius: 12px;
  background: var(--color-brand-surface);
}
.secret-banner-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  flex-shrink: 0;
}
.secret-banner > div:nth-child(2) { flex: 1; min-width: 240px; }
.secret-banner-title { color: var(--color-text-heading); font-size: 13px; font-weight: 700; margin-bottom: 3px; }
.secret-banner p { margin: 0; color: var(--color-text-secondary); font-size: 12px; line-height: 1.6; }

.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.tall-logs { max-height: 540px; min-height: 180px; }
</style>
