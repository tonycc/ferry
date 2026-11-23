<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api, type AppView } from "../api";
import { appStatus, VISIBILITY } from "../labels";

const router = useRouter();
const apps = ref<AppView[]>([]);
const loading = ref(true);

const sorted = computed(() =>
  [...apps.value].sort((a, b) => appStatus(a)[2] - appStatus(b)[2] || a.name.localeCompare(b.name)),
);

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
  <div class="page-title"><h2>我的应用</h2></div>
  <el-card shadow="never">
    <el-table
      v-loading="loading"
      :data="sorted"
      row-class-name="clickable"
      @row-click="(row: AppView) => router.push(`/apps/${row.name}`)"
    >
      <el-table-column label="应用" min-width="160">
        <template #default="{ row }">
          <router-link :to="`/apps/${row.name}`" @click.stop>{{ row.name }}</router-link>
        </template>
      </el-table-column>
      <el-table-column label="访问地址" min-width="240">
        <template #default="{ row }">
          <a v-if="row.live && !row.disabled && !row.unpublished" :href="row.url" target="_blank" rel="noopener" @click.stop>{{ row.url }}</a>
          <span v-else class="muted">{{ row.url }}</span>
        </template>
      </el-table-column>
      <el-table-column label="谁能看" width="110">
        <template #default="{ row }">{{ VISIBILITY[row.visibility as keyof typeof VISIBILITY] }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="appStatus(row)[1]" disable-transitions>{{ appStatus(row)[0] }}</el-tag>
        </template>
      </el-table-column>
      <template #empty>
        <div v-if="!loading" class="empty">
          <p>你还没有应用。</p>
          <p class="muted">告诉你的 agent 要做什么应用,它会通过 Ferry 发布,发布后就会出现在这里。agent 怎么接入见“个人令牌”。</p>
        </div>
      </template>
    </el-table>
  </el-card>
</template>

<style scoped>
:deep(.clickable) { cursor: pointer; }
.empty { padding: 24px 0; line-height: 1.6; }
</style>
