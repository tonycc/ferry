<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { api, ApiError, type AdminUser } from "../api";

/**
 * 管理员的人员页:组织架构里在职的人,以及谁设置了登录密码。
 * 一期用手机号 + 密码登录,初始密码只能由管理员在这里生成,转交给本人;忘记密码也在这里重新生成
 */
const users = ref<AdminUser[]>([]);
const loading = ref(true);
const forbidden = ref(false);
const filter = ref("");
const busy = ref<string>();

const PASSWORD: Record<AdminUser["password"], [string, "info" | "warning" | "success"]> = {
  none: ["没设密码", "info"],
  initial: ["初始密码,还没改", "warning"],
  set: ["已设置", "success"],
};

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return users.value
    .filter((u) => !q || [u.name, u.id, u.jobNumber ?? "", ...u.departmentNames].some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
});

async function load() {
  try {
    users.value = await api.get<AdminUser[]>("/api/admin/users");
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) forbidden.value = true;
    else ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

async function reset(user: AdminUser) {
  const again = user.password !== "none";
  try {
    await ElMessageBox.confirm(
      again
        ? `给 ${user.name} 重新生成初始密码:原来的密码立即失效,已经登录的地方都会退出;个人令牌不受影响。`
        : `给 ${user.name} 生成初始密码。`,
      "生成初始密码",
      { confirmButtonText: "生成", cancelButtonText: "取消", type: again ? "warning" : "info" },
    );
  } catch {
    return;
  }
  busy.value = user.id;
  try {
    const { password } = await api.post<{ password: string }>(`/api/admin/users/${encodeURIComponent(user.id)}/reset-password`);
    await ElMessageBox.alert(
      `${user.name} 的初始密码:${password}\n\n这个密码只显示这一次,请当面或私下转交给本人(不要发在群里)。本人第一次登录后要改成自己的密码。`,
      "初始密码",
      { confirmButtonText: "我已记下", customStyle: { whiteSpace: "pre-wrap" } },
    );
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    busy.value = undefined;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-title"><h2>人员</h2></div>
  <el-result v-if="forbidden" icon="warning" title="只有平台管理员可以使用这个页面" />
  <el-card v-else shadow="never">
    <div class="bar">
      <el-input v-model="filter" clearable placeholder="按姓名、工号或部门筛选" style="max-width: 320px" />
      <span class="muted">员工用手机号和密码登录。初始密码在这里生成,转交给本人;忘记密码也在这里重新生成。</span>
    </div>
    <el-table v-loading="loading" :data="shown">
      <el-table-column prop="name" label="姓名" width="120" />
      <el-table-column label="工号" width="100">
        <template #default="{ row }">{{ row.jobNumber ?? "—" }}</template>
      </el-table-column>
      <el-table-column label="部门" min-width="160">
        <template #default="{ row }">{{ row.departmentNames.join("、") || "—" }}</template>
      </el-table-column>
      <el-table-column label="登录密码" min-width="160">
        <template #default="{ row }">
          <el-tag :type="PASSWORD[row.password as AdminUser['password']][1]" disable-transitions>
            {{ PASSWORD[row.password as AdminUser["password"]][0] }}
          </el-tag>
          <div v-if="!row.hasMobile" class="muted">组织架构里没有手机号,只能用工号登录</div>
        </template>
      </el-table-column>
      <el-table-column width="150" align="right">
        <template #default="{ row }">
          <el-button size="small" :loading="busy === row.id" :disabled="!!busy && busy !== row.id" @click="reset(row)">
            {{ row.password === "none" ? "生成初始密码" : "重置密码" }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
</style>
