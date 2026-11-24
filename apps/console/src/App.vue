<script setup lang="ts">
import { ArrowDown, ArrowLeft, Document, Files, Grid, Key, Menu, OfficeBuilding, User } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { type Component, computed, markRaw, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { api } from "./api";
import { loadMe, me } from "./session";

interface NavItem {
  path: string;
  label: string;
  icon: Component;
}
interface NavGroup {
  label: string;
  admin?: boolean;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    label: "工作台",
    items: [
      { path: "/apps", label: "我的应用", icon: markRaw(Grid) },
      { path: "/tokens", label: "个人令牌", icon: markRaw(Key) },
    ],
  },
  {
    label: "平台管理",
    admin: true,
    items: [
      { path: "/admin", label: "管理全部应用", icon: markRaw(Files) },
      { path: "/users", label: "人员", icon: markRaw(User) },
      { path: "/departments", label: "部门", icon: markRaw(OfficeBuilding) },
      { path: "/audit", label: "审计日志", icon: markRaw(Document) },
    ],
  },
];
const visibleGroups = computed(() => groups.filter((g) => !g.admin || me.value?.isAdmin));

const route = useRoute();
/** 应用详情页也算在“我的应用”下 */
const active = computed(() => "/" + (route.path.split("/")[1] ?? "apps"));
/** 顶栏标题:应用详情页显示应用名,其他页面用路由里的标题 */
const title = computed(() =>
  typeof route.params.name === "string" ? route.params.name : ((route.meta.title as string | undefined) ?? ""),
);
const back = computed(() => route.meta.back as { label: string; to: string } | undefined);
const initial = computed(() => me.value?.name.slice(0, 1) ?? "");

/** 窄屏时侧边栏收起,点顶栏左上角的按钮展开 */
const navOpen = ref(false);
watch(() => route.fullPath, () => (navOpen.value = false));

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

function onUserCommand(command: string) {
  if (command === "password") passwordOpen.value = true;
  else if (command === "logout") void logout();
}
</script>

<template>
  <div class="console-layout">
    <aside class="sidebar" :class="{ open: navOpen }">
      <div class="sidebar-brand">
        <div class="brand-logo">F</div>
        <span class="brand-name">Ferry 控制台</span>
      </div>
      <nav class="sidebar-nav" aria-label="控制台导航">
        <div v-for="group in visibleGroups" :key="group.label" class="nav-group">
          <div class="nav-group-label">{{ group.label }}</div>
          <router-link
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="nav-item"
            :class="{ active: active === item.path }"
          >
            <component :is="item.icon" class="nav-icon" />
            <span class="nav-label">{{ item.label }}</span>
          </router-link>
        </div>
      </nav>
    </aside>
    <div v-if="navOpen" class="sidebar-mask" @click="navOpen = false" />

    <div class="main-column">
      <header class="topbar">
        <div class="topbar-left">
          <button class="icon-button nav-toggle" aria-label="打开导航" @click="navOpen = true">
            <el-icon :size="18"><Menu /></el-icon>
          </button>
          <router-link v-if="back" :to="back.to" class="back-button">
            <el-icon><ArrowLeft /></el-icon>{{ back.label }}
          </router-link>
          <span class="topbar-title">{{ title }}</span>
        </div>
        <el-dropdown v-if="me" trigger="click" placement="bottom-end" @command="onUserCommand">
          <button class="user-button">
            <span class="user-avatar">{{ initial }}</span>
            <span class="user-name">{{ me.name }}</span>
            <el-icon class="user-arrow"><ArrowDown /></el-icon>
          </button>
          <template #dropdown>
            <div class="dropdown-user">
              <div class="dropdown-name">{{ me.name }}</div>
              <div v-if="me.isAdmin" class="dropdown-role">平台管理员</div>
            </div>
            <el-dropdown-menu>
              <el-dropdown-item command="password">修改密码</el-dropdown-item>
              <el-dropdown-item command="logout" divided class="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </header>

      <main class="main">
        <router-view v-if="me" />
      </main>
    </div>

    <el-dialog v-model="passwordOpen" title="修改密码" width="min(400px, 92vw)" @closed="resetPasswordForm">
      <el-form label-position="top" @submit.prevent="changePassword">
        <el-form-item label="当前密码"><el-input v-model="pw.current" type="password" show-password autocomplete="current-password" /></el-form-item>
        <el-form-item label="新密码(至少 8 位,不能全是数字)"><el-input v-model="pw.next" type="password" show-password autocomplete="new-password" /></el-form-item>
        <el-form-item label="再输一次新密码"><el-input v-model="pw.again" type="password" show-password autocomplete="new-password" /></el-form-item>
        <p class="status-note">改完后其他浏览器上的登录会失效,这里保持登录。个人令牌不受影响。</p>
      </el-form>
      <template #footer>
        <el-button @click="passwordOpen = false">取消</el-button>
        <el-button type="primary" :loading="pwSaving" @click="changePassword">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.console-layout { display: flex; min-height: 100vh; }

/* ---- 侧边栏 ---- */
.sidebar {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 220px;
  height: 100vh;
  background: var(--color-bg-base);
  border-right: 1px solid var(--color-border);
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  padding: 0 20px;
  border-bottom: 1px solid var(--color-bg-subtle);
}
.brand-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-button);
  background: var(--color-text-heading);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}
.brand-name { color: var(--color-text-heading); font-size: 14px; font-weight: 700; }

.sidebar-nav { flex: 1; overflow-y: auto; padding: 12px 0; }
.nav-group { margin-bottom: 8px; }
.nav-group-label {
  padding: 8px 20px 4px;
  color: var(--color-text-muted);
  font-size: var(--font-size-badge);
  font-weight: 600;
  letter-spacing: 0.5px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 1px 8px;
  padding: 7px 12px;
  border-radius: 6px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-body);
  transition: background 0.1s, color 0.1s;
}
.nav-item:hover { background: var(--color-bg-subtle); color: var(--color-text-primary); text-decoration: none; }
.nav-item:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
.nav-item.active { background: var(--color-primary-light); color: var(--color-primary); font-weight: 500; }
.nav-icon { flex-shrink: 0; width: 16px; height: 16px; }
.nav-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- 顶栏 ---- */
.main-column { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 56px;
  padding: 0 24px;
  background: var(--color-bg-base);
  border-bottom: 1px solid var(--color-border);
}
.topbar-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.topbar-title {
  overflow: hidden;
  color: var(--color-text-heading);
  font-size: 17px;
  font-weight: var(--font-weight-heading);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.back-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px 0 6px;
  border-radius: 6px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-title);
  white-space: nowrap;
}
.back-button:hover { background: var(--color-primary-light); color: var(--color-primary); text-decoration: none; }
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.icon-button:hover { background: var(--color-bg-subtle); }
.nav-toggle { display: none; }

.user-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.user-button:hover { background: var(--color-bg-subtle); }
.user-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.user-name {
  max-width: 120px;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-arrow { color: var(--color-text-muted); }
.dropdown-user { min-width: 160px; padding: 8px 16px 6px; }
.dropdown-name { color: var(--color-text-heading); font-size: var(--font-size-body); font-weight: 500; }
.dropdown-role { margin-top: 2px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
:global(.el-dropdown-menu__item.logout) { color: var(--color-danger); }

.main { flex: 1; width: 100%; max-width: 1280px; padding: 20px 24px 40px; }

/* ---- 窄屏:侧边栏改成抽屉 ---- */
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    z-index: 30;
    left: 0;
    transform: translateX(-100%);
    transition: transform 0.2s;
  }
  .sidebar.open { transform: none; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }
  .sidebar-mask { position: fixed; inset: 0; z-index: 20; background: rgba(17, 24, 39, 0.3); }
  .nav-toggle { display: inline-flex; }
  .topbar { padding: 0 12px; }
  .user-name { display: none; }
  .main { padding: 12px; }
}
</style>
