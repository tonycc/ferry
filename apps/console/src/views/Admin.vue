<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { api, ApiError, type AdminAppView } from "../api";
import { appStatus, time, VISIBILITY } from "../labels";

const apps = ref<AdminAppView[]>([]);
const loading = ref(true);
const forbidden = ref(false);
const filter = ref("");

/** 停用的排最前,然后是在线、未上线,已下线的放最后 */
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return apps.value
    .filter((a) => !q || [a.name, a.ownerName, ...a.departmentNames].some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => appStatus(a)[2] - appStatus(b)[2] || a.name.localeCompare(b.name));
});

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

async function act(name: string, action: "disable" | "enable", body: object) {
  try {
    await api.post(`/api/admin/apps/${encodeURIComponent(name)}/${action}`, body);
    ElMessage.success(action === "disable" ? `已停用 ${name}` : `已恢复 ${name}`);
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

onMounted(load);
</script>

<template>
  <div class="page-title"><h2>管理全部应用</h2></div>
  <el-result v-if="forbidden" icon="warning" title="只有平台管理员可以使用这个页面" />
  <el-card v-else shadow="never">
    <div class="bar">
      <el-input v-model="filter" clearable placeholder="按应用名、负责人或部门筛选" style="max-width: 320px" />
      <span class="muted">共 {{ apps.length }} 个应用<template v-if="filter.trim()">,显示 {{ shown.length }} 个</template></span>
    </div>
    <el-table v-loading="loading" :data="shown">
      <el-table-column label="应用" min-width="150">
        <template #default="{ row }"><a :href="row.url" target="_blank" rel="noopener">{{ row.name }}</a></template>
      </el-table-column>
      <el-table-column prop="ownerName" label="负责人" width="110" />
      <el-table-column label="负责人部门" min-width="140">
        <template #default="{ row }">{{ row.departmentNames.join("、") || "—" }}</template>
      </el-table-column>
      <el-table-column label="谁能看" width="90">
        <template #default="{ row }">{{ VISIBILITY[row.visibility as keyof typeof VISIBILITY] }}</template>
      </el-table-column>
      <el-table-column label="状态" min-width="140">
        <template #default="{ row }">
          <el-tag :type="appStatus(row)[1]" disable-transitions>{{ appStatus(row)[0] }}</el-tag>
          <div v-if="row.disabled && row.disabledReason" class="muted">{{ row.disabledReason }}</div>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="110">
        <template #default="{ row }"><span class="muted">{{ time(row.createdAt).split(" ")[0] }}</span></template>
      </el-table-column>
      <el-table-column width="90" align="right">
        <template #default="{ row }">
          <el-button v-if="row.disabled" size="small" @click="enable(row)">恢复</el-button>
          <el-button v-else size="small" type="danger" plain @click="disable(row)">停用</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
</style>
