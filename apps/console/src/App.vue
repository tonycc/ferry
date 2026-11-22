<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "./api";
import { loadMe, me } from "./session";

const route = useRoute();
const active = computed(() => "/" + (route.path.split("/")[1] ?? "apps"));

onMounted(() => loadMe().catch((err: Error) => ElMessage.error(err.message)));

const passwordOpen = ref(false);
const pwSaving = ref(false);
const pw = reactive({ current: "", next: "", again: "" });
function resetPasswordForm() {
  Object.assign(pw, { current: "", next: "", again: "" });
}
async function changePassword() {
  if (pw.next !== pw.again) return ElMessage.error("两次输入的新密码不一样");
  pwSaving.value = true;
  try {
    await api.post("/api/me/password", { currentPassword: pw.current, newPassword: pw.next });
    ElMessage.success("密码已修改");
    passwordOpen.value = false;
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    pwSaving.value = false;
  }
}

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
        <el-menu-item v-if="me?.isAdmin" index="/users">人员</el-menu-item>
        <el-menu-item v-if="me?.isAdmin" index="/audit">审计日志</el-menu-item>
      </el-menu>
      <div class="user" v-if="me">
        <span>{{ me.name }}</span>
        <el-button link @click="passwordOpen = true">修改密码</el-button>
        <el-button link @click="logout">退出登录</el-button>
      </div>
    </el-header>
    <el-main class="main">
      <router-view v-if="me" />
    </el-main>
    <el-dialog v-model="passwordOpen" title="修改密码" width="380px" @closed="resetPasswordForm">
      <el-form label-position="top" @submit.prevent="changePassword">
        <el-form-item label="当前密码"><el-input v-model="pw.current" type="password" show-password autocomplete="current-password" /></el-form-item>
        <el-form-item label="新密码(至少 8 位,不能全是数字)"><el-input v-model="pw.next" type="password" show-password autocomplete="new-password" /></el-form-item>
        <el-form-item label="再输一次新密码"><el-input v-model="pw.again" type="password" show-password autocomplete="new-password" /></el-form-item>
        <p class="muted">改完后其他浏览器上的登录会失效,这里保持登录。个人令牌不受影响。</p>
      </el-form>
      <template #footer>
        <el-button @click="passwordOpen = false">取消</el-button>
        <el-button type="primary" :loading="pwSaving" @click="changePassword">保存</el-button>
      </template>
    </el-dialog>
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
