<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { api } from "./api";
import { loadMe, me } from "./session";

const route = useRoute();
const active = computed(() => "/" + (route.path.split("/")[1] ?? "apps"));

onMounted(() => loadMe().catch((err: Error) => ElMessage.error(err.message)));

async function logout() {
  await api.post("/auth/logout").catch(() => {});
  location.href = "/login";
}
</script>

<template>
  <el-container class="layout">
    <el-header class="header">
      <div class="brand">Ferry 控制台</div>
      <el-menu mode="horizontal" :default-active="active" router :ellipsis="false" class="menu">
        <el-menu-item index="/apps">我的应用</el-menu-item>
        <el-menu-item index="/tokens">个人令牌</el-menu-item>
        <el-menu-item v-if="me?.isAdmin" index="/admin">管理全部应用</el-menu-item>
        <el-menu-item v-if="me?.isAdmin" index="/audit">审计日志</el-menu-item>
      </el-menu>
      <div class="user" v-if="me">
        <span>{{ me.name }}</span>
        <el-button link @click="logout">退出登录</el-button>
      </div>
    </el-header>
    <el-main class="main">
      <router-view v-if="me" />
    </el-main>
  </el-container>
</template>

<style>
body { margin: 0; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f7fa; }
.layout { min-height: 100vh; }
.header { display: flex; align-items: center; gap: 24px; background: #fff; border-bottom: 1px solid var(--el-border-color-light); }
.brand { font-weight: 600; font-size: 17px; white-space: nowrap; }
.menu { flex: 1; border-bottom: none !important; }
.user { display: flex; align-items: center; gap: 12px; white-space: nowrap; color: var(--el-text-color-regular); }
.main { max-width: 1120px; width: 100%; margin: 0 auto; box-sizing: border-box; }
.page-title { display: flex; align-items: center; justify-content: space-between; margin: 4px 0 16px; }
.page-title h2 { margin: 0; font-size: 20px; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
@media (max-width: 640px) {
  .header { flex-wrap: wrap; height: auto; padding: 8px 16px; gap: 4px; }
  .menu { order: 3; flex-basis: 100%; }
  .main { padding: 12px; }
}
</style>
