<script setup lang="ts">
import { TopRight } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api, type AppView } from "../api";
import AppAvatar from "../components/AppAvatar.vue";
import StatCards, { type StatKey } from "../components/StatCards.vue";
import StatusTag from "../components/StatusTag.vue";
import TableFooter from "../components/TableFooter.vue";
import VisibilityChip from "../components/VisibilityChip.vue";
import { useLocalPagination } from "../composables/useLocalPagination";
import { appStatKey, appStatus } from "../labels";

const router = useRouter();
const apps = ref<AppView[]>([]);
const loading = ref(true);
/** 点统计卡片只看这一种状态的应用,再点一次取消 */
const stat = ref<StatKey>();

const counts = computed(() => {
  const result: Record<StatKey, number> = { live: 0, pending: 0, offline: 0, disabled: 0 };
  for (const app of apps.value) result[appStatKey(app)]++;
  return result;
});

const STAT_LABEL: Record<StatKey, string> = { live: "在线的应用", pending: "未上线的应用", offline: "已下线的应用", disabled: "已停用的应用" };

const sorted = computed(() =>
  apps.value
    .filter((a) => !stat.value || appStatKey(a) === stat.value)
    .sort((a, b) => appStatus(a)[2] - appStatus(b)[2] || a.name.localeCompare(b.name)),
);

const { currentPage, pageSize, total, pagedItems } = useLocalPagination(sorted, [stat]);

const reachable = (app: AppView) => app.live && !app.disabled && !app.unpublished;

onMounted(async () => {
  try {
    apps.value = await api.get<AppView[]>("/api/apps");
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="ops-page">
    <StatCards v-if="apps.length > 0" :counts="counts" :selected="stat" @select="(k) => (stat = k)" />

    <div class="content-panel">
      <div class="panel-toolbar">
        <div class="panel-title">{{ stat ? STAT_LABEL[stat] : "全部应用" }}</div>
        <el-button v-if="stat" link type="primary" @click="stat = undefined">看全部应用</el-button>
      </div>
      <el-table
        v-loading="loading"
        class="data-table"
        :data="pagedItems"
        row-class-name="clickable"
        @row-click="(row: AppView) => router.push(`/apps/${row.name}`)"
      >
        <el-table-column label="应用" min-width="200">
          <template #default="{ row }">
            <div class="app-cell">
              <AppAvatar :name="row.name" :muted="!reachable(row)" />
              <router-link class="app-cell-name" :to="`/apps/${row.name}`" @click.stop>{{ row.name }}</router-link>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="访问地址" min-width="260">
          <template #default="{ row }">
            <a v-if="reachable(row)" class="url-link" :href="row.url" target="_blank" rel="noopener" @click.stop>
              {{ row.url }}<el-icon><TopRight /></el-icon>
            </a>
            <span v-else class="muted">{{ row.url }}</span>
          </template>
        </el-table-column>
        <el-table-column label="谁能看" width="120">
          <template #default="{ row }"><VisibilityChip :value="row.visibility" /></template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <StatusTag :type="appStatus(row)[1]">{{ appStatus(row)[0] }}</StatusTag>
          </template>
        </el-table-column>
        <template #empty>
          <div v-if="!loading" class="empty">
            <p class="empty-title">{{ stat ? "没有这种状态的应用" : "你还没有应用" }}</p>
            <p v-if="!stat" class="muted">告诉你的 agent 要做什么应用,它会通过 Ferry 发布,发布后就会出现在这里。agent 怎么接入见“个人令牌”。</p>
          </div>
        </template>
      </el-table>
      <TableFooter v-model:current-page="currentPage" v-model:page-size="pageSize" :total="total" unit="个应用" />
    </div>
  </section>
</template>

<style scoped>
:deep(.clickable) { cursor: pointer; }
.empty { padding: 28px 0; line-height: 1.6; }
.empty p { margin: 4px 0; }
.empty-title { color: var(--color-text-heading); font-size: var(--font-size-title); font-weight: 600; }
</style>
