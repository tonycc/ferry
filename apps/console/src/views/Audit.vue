<script setup lang="ts">
import { Refresh, Search } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError, type AuditAction, type AuditEvent, type AuditPage } from "../api";
import StatusTag from "../components/StatusTag.vue";
import { AUDIT_ACTION, auditDetail, auditTone, relativeTime, time } from "../labels";

const route = useRoute();
const router = useRouter();

const events = ref<AuditEvent[]>([]);
const nextBefore = ref<number>();
const loading = ref(false);
const forbidden = ref(false);
let requestSeq = 0;

const appInput = ref("");
const filters = computed(() => ({
  app: typeof route.query.app === "string" ? route.query.app : undefined,
  actor: typeof route.query.actor === "string" ? route.query.actor : undefined,
  action: typeof route.query.action === "string" ? (route.query.action as AuditAction) : undefined,
}));
const hasFilters = computed(() => !!(filters.value.app || filters.value.actor || filters.value.action));
const actorLabel = ref<string>();
const actions = Object.entries(AUDIT_ACTION) as [AuditAction, string][];

function query(before?: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters.value)) if (value) params.set(key, value);
  if (before) params.set("before", String(before));
  params.set("limit", "50");
  return params.toString();
}

async function load(more = false) {
  const seq = ++requestSeq;
  if (!more) {
    events.value = [];
    nextBefore.value = undefined;
  }
  loading.value = true;
  try {
    const page = await api.get<AuditPage>(`/api/admin/audit?${query(more ? nextBefore.value : undefined)}`);
    if (seq !== requestSeq) return;
    events.value = more ? [...events.value, ...page.events] : page.events;
    nextBefore.value = page.nextBefore;
  } catch (err) {
    if (seq !== requestSeq) return;
    if (err instanceof ApiError && err.status === 403) forbidden.value = true;
    else ElMessage.error((err as Error).message);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function setFilter(patch: Partial<Record<"app" | "actor" | "action", string | undefined>>) {
  const next: Record<string, unknown> = { ...route.query, ...patch };
  for (const key of Object.keys(next)) if (!next[key]) delete next[key];
  void router.replace({ query: next as typeof route.query });
}

function clearAllFilters() {
  appInput.value = "";
  actorLabel.value = undefined;
  void router.replace({ query: {} });
}

function filterActor(e: AuditEvent) {
  if (!e.actorId) return;
  actorLabel.value = e.actorName ?? e.actorId;
  setFilter({ actor: e.actorId });
}

watch(
  filters,
  (f) => {
    appInput.value = f.app ?? "";
    if (!f.actor) actorLabel.value = undefined;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <section class="ops-page">
    <el-result v-if="forbidden" icon="warning" title="只有平台管理员可以使用这个页面" />
    <template v-else>
      <div class="content-panel">
        <div class="panel-toolbar">
          <div class="filter-bar">
            <el-input
              v-model="appInput"
              clearable
              :prefix-icon="Search"
              placeholder="输入应用名按回车筛选"
              style="width: 220px"
              @keyup.enter="setFilter({ app: appInput.trim() || undefined })"
              @clear="setFilter({ app: undefined })"
            />
            <el-select
              :model-value="filters.action"
              clearable
              placeholder="全部操作类型"
              style="width: 170px"
              @update:model-value="(v: string | undefined) => setFilter({ action: v || undefined })"
            >
              <el-option v-for="[value, label] in actions" :key="value" :value="value" :label="label" />
            </el-select>
            <el-tag v-if="filters.actor" closable disable-transitions @close="setFilter({ actor: undefined })">
              操作人：{{ actorLabel ?? filters.actor }}
            </el-tag>
            <el-button v-if="hasFilters" link type="primary" @click="clearAllFilters">重置筛选</el-button>
          </div>
          <div class="filter-bar">
            <span class="status-note">点击操作人或应用名可快速过滤</span>
            <el-button :icon="Refresh" :loading="loading" @click="load(false)">刷新</el-button>
          </div>
        </div>
        <el-table v-loading="loading" class="data-table" :data="events" :empty-text="loading ? ' ' : '没有匹配的审计记录'">
          <el-table-column label="时间" width="175">
            <template #default="{ row }">
              <span :title="time(row.at)">{{ relativeTime(row.at) }}</span>
              <div class="status-note">{{ time(row.at) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="操作人" width="125">
            <template #default="{ row }">
              <el-button v-if="row.actorId" link type="primary" @click="filterActor(row)">{{ row.actorName ?? row.actorId }}</el-button>
              <span v-else class="system-actor">Ferry 系统</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="145">
            <template #default="{ row }">
              <StatusTag :type="auditTone(row.action as AuditAction)">
                {{ AUDIT_ACTION[row.action as AuditAction] ?? row.action }}
              </StatusTag>
            </template>
          </el-table-column>
          <el-table-column label="应用" min-width="155">
            <template #default="{ row }">
              <div v-if="row.appName" class="stack-cell">
                <span><el-button link @click="setFilter({ app: row.appName })">{{ row.appName }}</el-button></span>
                <span v-if="row.appOwnerId && row.appOwnerId !== row.actorId" class="status-note">
                  负责人 {{ row.appOwnerName ?? row.appOwnerId }}
                </span>
              </div>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="详情" min-width="230">
            <template #default="{ row }">{{ auditDetail(row) || "—" }}</template>
          </el-table-column>
        </el-table>
        <div v-if="nextBefore" class="load-more">
          <el-button :loading="loading" @click="load(true)">加载更早的记录</el-button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.system-actor {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 6px;
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  font-size: 12px;
}
</style>
