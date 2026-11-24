<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError, type AuditAction, type AuditEvent, type AuditPage } from "../api";
import { AUDIT_ACTION, auditDetail, time } from "../labels";

/**
 * 审计日志(只有管理员能看):谁在什么时候对哪个应用做了什么,从新到旧。
 * 筛选条件放在地址栏里,管理页的“操作记录”链接直接带上应用名
 */
const route = useRoute();
const router = useRouter();

const events = ref<AuditEvent[]>([]);
const nextBefore = ref<number>();
const loading = ref(false);
const forbidden = ref(false);
/** 每次请求加一;返回时已经不是最新的请求就丢掉,免得慢的旧请求覆盖新筛选条件的结果 */
let requestSeq = 0;

const appInput = ref("");
const filters = computed(() => ({
  app: typeof route.query.app === "string" ? route.query.app : undefined,
  actor: typeof route.query.actor === "string" ? route.query.actor : undefined,
  action: typeof route.query.action === "string" ? (route.query.action as AuditAction) : undefined,
}));
/** 按操作人筛选时显示的姓名(从已加载的记录里找) */
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
    // 换了筛选条件:上一个条件的翻页位置不能再用
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
    <div v-else class="content-panel">
      <div class="panel-toolbar">
        <div class="filter-bar">
          <el-input
            v-model="appInput"
            clearable
            placeholder="应用名"
            style="width: 200px"
            @keyup.enter="setFilter({ app: appInput.trim() || undefined })"
            @clear="setFilter({ app: undefined })"
          />
          <el-select
            :model-value="filters.action"
            clearable
            placeholder="全部操作"
            style="width: 160px"
            @update:model-value="(v: string | undefined) => setFilter({ action: v || undefined })"
          >
            <el-option v-for="[value, label] in actions" :key="value" :value="value" :label="label" />
          </el-select>
          <el-tag v-if="filters.actor" closable disable-transitions @close="setFilter({ actor: undefined })">
            操作人:{{ actorLabel ?? filters.actor }}
          </el-tag>
        </div>
        <span class="status-note">点操作人的名字只看这个人的操作</span>
      </div>
      <el-table v-loading="loading" class="data-table" :data="events" :empty-text="loading ? ' ' : '没有记录'">
        <el-table-column label="时间" width="170">
          <template #default="{ row }"><span class="status-note">{{ time(row.at) }}</span></template>
        </el-table-column>
        <el-table-column label="操作人" width="120">
          <template #default="{ row }">
            <el-button v-if="row.actorId" link type="primary" @click="filterActor(row)">{{ row.actorName ?? row.actorId }}</el-button>
            <span v-else class="muted">Ferry</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">{{ AUDIT_ACTION[row.action as AuditAction] ?? row.action }}</template>
        </el-table-column>
        <el-table-column label="应用" min-width="150">
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
        <el-table-column label="详情" min-width="220">
          <template #default="{ row }">{{ auditDetail(row) }}</template>
        </el-table-column>
      </el-table>
      <div v-if="nextBefore" class="load-more">
        <el-button :loading="loading" @click="load(true)">加载更早的记录</el-button>
      </div>
    </div>
  </section>
</template>
