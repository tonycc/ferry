<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { api, ApiError, type AdminAppView } from "../api";
import AppAvatar from "../components/AppAvatar.vue";
import StatCards, { type StatKey } from "../components/StatCards.vue";
import StatusTag from "../components/StatusTag.vue";
import TableFooter from "../components/TableFooter.vue";
import VisibilityChip from "../components/VisibilityChip.vue";
import { useLocalPagination } from "../composables/useLocalPagination";
import { appStatKey, appStatus, time } from "../labels";

const apps = ref<AdminAppView[]>([]);
const loading = ref(true);
const forbidden = ref(false);
const filter = ref("");
/** 点统计卡片只看这一种状态的应用,再点一次取消 */
const stat = ref<StatKey>();
/** 正在删除的应用;删除要停数据库、删数据卷,可能要十几秒 */
const deleting = ref<string>();
/** 正在停用或恢复的应用:恢复要等部署平台把服务启动起来,也要十几秒 */
const acting = ref<{ name: string; action: "disable" | "enable" }>();
const busy = computed(() => !!deleting.value || !!acting.value);

const counts = computed(() => {
  const result: Record<StatKey, number> = { live: 0, pending: 0, offline: 0, disabled: 0 };
  for (const app of apps.value) result[appStatKey(app)]++;
  return result;
});

/** 停用的排最前,然后是在线、未上线,已下线的放最后 */
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return apps.value
    .filter((a) => !stat.value || appStatKey(a) === stat.value)
    .filter((a) => !q || [a.name, a.ownerName, ...a.departmentNames].some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => appStatus(a)[2] - appStatus(b)[2] || a.name.localeCompare(b.name));
});

const { currentPage, pageSize, total, pagedItems } = useLocalPagination(shown, [filter, stat]);
const filtering = computed(() => !!filter.value.trim() || !!stat.value);

async function load() {
  try {
    apps.value = await api.get<AdminAppView[]>("/api/admin/apps");
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) forbidden.value = true;
    else ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

async function disable(app: AdminAppView) {
  let reason: string;
  try {
    ({ value: reason } = await ElMessageBox.prompt(
      "访问地址立即失效,负责人不能再发布;数据保留,可以随时恢复。停用原因会通知负责人:",
      `停用 ${app.name}`,
      { confirmButtonText: "确认停用", cancelButtonText: "取消", type: "warning", inputPlaceholder: "停用原因", inputValidator: (v: string) => (v ?? "").length <= 200 || "最多 200 字" },
    ));
  } catch {
    return;
  }
  await act(app.name, "disable", reason?.trim() ? { reason: reason.trim() } : {});
}

async function enable(app: AdminAppView) {
  try {
    await ElMessageBox.confirm("恢复后同事可以重新访问,负责人也能再次发布。", `恢复 ${app.name}`, {
      confirmButtonText: "确认恢复",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  await act(app.name, "enable", {});
}

/** 已下线多少天 */
function offlineDays(app: AdminAppView): number | undefined {
  if (!app.unpublishedAt) return undefined;
  return Math.floor((Date.now() - Date.parse(app.unpublishedAt)) / 86_400_000);
}

async function remove(app: AdminAppView) {
  try {
    await ElMessageBox.prompt(
      `彻底删除 ${app.name}:删除它的数据库(全部数据)、备份、代码包和发布记录,应用名释放给别人使用。` +
        `删除后无法恢复。负责人是 ${app.ownerName},删除后会通知负责人。请输入应用名 ${app.name} 确认:`,
      "删除应用",
      {
        confirmButtonText: "彻底删除",
        cancelButtonText: "取消",
        type: "error",
        confirmButtonClass: "el-button--danger",
        inputValidator: (value: string) => value === app.name || "应用名不一致",
      },
    );
  } catch {
    return;
  }
  deleting.value = app.name;
  try {
    await api.post(`/api/admin/apps/${encodeURIComponent(app.name)}/delete`);
    ElMessage.success(`已删除 ${app.name}`);
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    deleting.value = undefined;
  }
}

async function act(name: string, action: "disable" | "enable", body: object) {
  acting.value = { name, action };
  try {
    await api.post(`/api/admin/apps/${encodeURIComponent(name)}/${action}`, body);
    ElMessage.success(action === "disable" ? `已停用 ${name}` : `已恢复 ${name}`);
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    acting.value = undefined;
  }
}

onMounted(load);
</script>

<template>
  <section class="ops-page">
    <el-result v-if="forbidden" icon="warning" title="只有平台管理员可以使用这个页面" />
    <StatCards v-if="!forbidden && apps.length > 0" :counts="counts" :selected="stat" @select="(k) => (stat = k)" />
    <div v-if="!forbidden" class="content-panel">
      <div class="panel-toolbar">
        <div class="filter-bar">
          <el-input v-model="filter" clearable placeholder="按应用名、负责人或部门筛选" style="width: 280px" />
        </div>
      </div>
      <el-table v-loading="loading" class="data-table" :data="pagedItems" :empty-text="loading ? ' ' : '没有应用'">
        <el-table-column label="应用" min-width="190">
          <template #default="{ row }">
            <div class="app-cell">
              <AppAvatar :name="row.name" :muted="!row.live || row.disabled || row.unpublished" />
              <div class="stack-cell">
                <a class="app-cell-name" :href="row.url" target="_blank" rel="noopener">{{ row.name }}</a>
                <router-link class="status-note" :to="{ path: '/audit', query: { app: row.name } }">操作记录</router-link>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="ownerName" label="负责人" width="110" />
        <el-table-column label="负责人部门" min-width="140">
          <template #default="{ row }">{{ row.departmentNames.join("、") || "—" }}</template>
        </el-table-column>
        <el-table-column label="谁能看" width="110">
          <template #default="{ row }"><VisibilityChip :value="row.visibility" /></template>
        </el-table-column>
        <el-table-column label="状态" min-width="140">
          <template #default="{ row }">
            <div class="stack-cell">
              <span>
                <StatusTag v-if="acting?.name === row.name" type="primary">
                  {{ acting?.action === "disable" ? "正在停用…" : "正在恢复…" }}
                </StatusTag>
                <StatusTag v-else :type="appStatus(row)[1]">{{ appStatus(row)[0] }}</StatusTag>
              </span>
              <span v-if="acting?.name === row.name && acting?.action === 'enable'" class="status-note">要等服务重新启动,大约十几秒</span>
              <span v-if="row.disabled && row.disabledReason" class="status-note">{{ row.disabledReason }}</span>
              <span v-if="offlineDays(row) !== undefined" class="status-note">已下线 {{ offlineDays(row) }} 天</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="110">
          <template #default="{ row }"><span class="status-note">{{ time(row.createdAt).split(" ")[0] }}</span></template>
        </el-table-column>
        <el-table-column width="150" align="right">
          <template #default="{ row }">
            <el-button v-if="row.disabled" size="small" :loading="acting?.name === row.name" :disabled="busy && acting?.name !== row.name" @click="enable(row)">恢复</el-button>
            <el-button v-else size="small" type="danger" plain :loading="acting?.name === row.name" :disabled="busy && acting?.name !== row.name" @click="disable(row)">停用</el-button>
            <el-button
              v-if="row.disabled || row.unpublished"
              size="small"
              type="danger"
              :loading="deleting === row.name"
              :disabled="busy && deleting !== row.name"
              @click="remove(row)"
            >删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <TableFooter
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        unit="个应用"
        :summary="filtering ? `筛选出 ${total} 个,共 ${apps.length} 个应用` : undefined"
      />
    </div>
  </section>
</template>
