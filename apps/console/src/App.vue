<script setup lang="ts">
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  Document,
  Files,
  Grid,
  Key,
  Lock,
  Menu,
  OfficeBuilding,
  Search,
  User,
} from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { type Component, computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, type AppView } from "./api";
import { certificateStatus, loadCertificateStatus } from "./certificate";
import AppAvatar from "./components/AppAvatar.vue";
import FerryLogo from "./components/FerryLogo.vue";
import StatusTag from "./components/StatusTag.vue";
import { appStatus } from "./labels";
import { loadMe, me } from "./session";

interface NavItem {
  path: string;
  label: string;
  hint: string;
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
      { path: "/apps", label: "我的应用", hint: "查看与管理已发布应用", icon: markRaw(Grid) },
      { path: "/tokens", label: "个人令牌", hint: "配置 Claude Code / Antigravity / Codex", icon: markRaw(Key) },
    ],
  },
  {
    label: "平台管理",
    admin: true,
    items: [
      { path: "/admin", label: "管理全部应用", hint: "全局应用管控、停用与删除", icon: markRaw(Files) },
      { path: "/users", label: "人员", hint: "维护成员账号、初始密码与离职", icon: markRaw(User) },
      { path: "/departments", label: "部门", hint: "维护部门树与可见范围关系", icon: markRaw(OfficeBuilding) },
      { path: "/audit", label: "审计日志", hint: "追溯发布、停用与配置变更", icon: markRaw(Document) },
      { path: "/certificate", label: "证书", hint: "查看到期状态与上传泛域名证书", icon: markRaw(Lock) },
    ],
  },
];
const visibleGroups = computed(() => groups.filter((g) => !g.admin || me.value?.isAdmin));
const flatNavItems = computed(() => visibleGroups.value.flatMap((g) => g.items.map((item) => ({ ...item, group: g.label }))));

const route = useRoute();
const router = useRouter();
/** 应用详情页也算在“我的应用”下 */
const active = computed(() => "/" + (route.path.split("/")[1] ?? "apps"));
/** 顶栏标题:应用详情页显示应用名,其他页面用路由里的标题 */
const title = computed(() =>
  typeof route.params.name === "string" ? route.params.name : ((route.meta.title as string | undefined) ?? ""),
);
/** 顶栏面包屑的第一段:当前页面所在的导航分组 */
const activeGroup = computed(() => groups.find((g) => g.items.some((i) => i.path === active.value))?.label);
const back = computed(() => route.meta.back as { label: string; to: string } | undefined);
const initial = computed(() => Array.from(me.value?.name ?? "")[0] ?? "");
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** 窄屏时侧边栏收起,点顶栏左上角的按钮展开 */
const navOpen = ref(false);
watch(() => route.fullPath, () => (navOpen.value = false));

/** 给管理员的常驻提醒:证书快到期、已过期,或者还没启用 HTTPS。证书页上自己会显示,那里不重复 */
const certificateNotice = computed(() => {
  const c = certificateStatus.value;
  if (!c || route.path === "/certificate") return undefined;
  if (c.level === "expired") return { type: "error" as const, text: `HTTPS 证书已经过期,Ferry 和所有应用都打不开了:请尽快上传新证书` };
  if (c.level === "urgent" || c.level === "expiring") {
    return { type: c.level === "urgent" ? ("error" as const) : ("warning" as const), text: `HTTPS 证书还有 ${c.daysLeft} 天过期:请提前上传新证书` };
  }
  if (!c.https && c.certificate && c.fixedByEnv) {
    return { type: "info" as const, text: "证书已经装好,但地址写在服务器的 .env 里:把 PUBLIC_URL、APPS_URL_SCHEME 改成 https 后重启 Ferry" };
  }
  if (!c.https) return { type: "info" as const, text: "还没启用 HTTPS:上传证书后 Ferry 和应用都改用 https" };
  return undefined;
});

// ---- ⌘K / Ctrl+K 全局快速跳转 ----
const paletteOpen = ref(false);
const paletteQuery = ref("");
const paletteApps = ref<AppView[]>([]);
const paletteAppsLoaded = ref(false);
const paletteInputRef = ref<{ focus?: () => void }>();

async function openPalette() {
  paletteQuery.value = "";
  paletteOpen.value = true;
  await nextTick();
  paletteInputRef.value?.focus?.();
  if (!paletteAppsLoaded.value && me.value) {
    paletteAppsLoaded.value = true;
    paletteApps.value = await api.get<AppView[]>("/api/apps").catch(() => []);
  }
}

const filteredNav = computed(() => {
  const q = paletteQuery.value.trim().toLowerCase();
  if (!q) return flatNavItems.value;
  return flatNavItems.value.filter(
    (item) => item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q) || item.group.toLowerCase().includes(q),
  );
});

const filteredApps = computed(() => {
  const q = paletteQuery.value.trim().toLowerCase();
  const list = paletteApps.value;
  if (!q) return list.slice(0, 6);
  return list.filter((a) => a.name.toLowerCase().includes(q) || a.url.toLowerCase().includes(q)).slice(0, 8);
});

function jumpTo(path: string) {
  paletteOpen.value = false;
  void router.push(path);
}

function jumpFirst() {
  if (filteredApps.value[0] && paletteQuery.value.trim()) {
    jumpTo(`/apps/${filteredApps.value[0].name}`);
  } else if (filteredNav.value[0]) {
    jumpTo(filteredNav.value[0].path);
  }
}

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteOpen.value) paletteOpen.value = false;
    else void openPalette();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onGlobalKeydown);
  await loadMe().catch((err: Error) => ElMessage.error(err.message));
  // 本机开发没有正式地址时没有证书页(接口 404),不提醒
  if (me.value?.isAdmin) await loadCertificateStatus().catch(() => undefined);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
});

// ---- 修改密码(含实时规则校验) ----
const passwordOpen = ref(false);
const pwSaving = ref(false);
const pw = reactive({ current: "", next: "", again: "" });
const pwRules = computed(() => ({
  len: pw.next.length >= 8,
  notDigits: pw.next.length > 0 && !/^\d+$/.test(pw.next),
  same: pw.again.length > 0 && pw.next === pw.again,
}));
const pwCanSubmit = computed(() => !!pw.current && pwRules.value.len && pwRules.value.notDigits && pwRules.value.same);

function resetPasswordForm() {
  Object.assign(pw, { current: "", next: "", again: "" });
}
async function changePassword() {
  if (!pwCanSubmit.value) {
    if (pw.next !== pw.again) return ElMessage.error("两次输入的新密码不一样");
    return ElMessage.error("请按要求填写当前密码与新密码");
  }
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
      <router-link to="/apps" class="sidebar-brand">
        <FerryLogo />
        <div class="brand-copy">
          <span class="brand-name">Ferry</span>
          <span class="brand-sub">AI 应用发布台</span>
        </div>
        <span class="brand-tag">控制台</span>
      </router-link>
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
            <span
              v-if="item.path === '/certificate' && certificateStatus && (certificateStatus.level === 'expired' || certificateStatus.level === 'urgent' || certificateStatus.level === 'expiring')"
              class="nav-dot"
              :class="certificateStatus.level === 'expiring' ? 'warn' : 'danger'"
            />
          </router-link>
        </div>
      </nav>
      <div v-if="active !== '/tokens'" class="help-card">
        <div class="help-badge">MCP 接入</div>
        <div class="help-title">让 Agent 帮你一键上线</div>
        <p>生成个人令牌并配进 Claude Code、Antigravity 或 Codex，对话说一句“发布”即可自动部署。</p>
        <router-link to="/tokens" class="help-link">去配置个人令牌 <el-icon><ArrowRight /></el-icon></router-link>
      </div>
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
          <span v-if="!back && activeGroup" class="crumb-group">{{ activeGroup }} /</span>
          <span class="topbar-title">{{ title }}</span>
        </div>

        <div class="topbar-right">
          <button v-if="me" type="button" class="quick-search-btn" @click="openPalette">
            <el-icon><Search /></el-icon>
            <span class="quick-search-label">快速跳转应用或页面…</span>
            <kbd class="kbd">{{ isMac ? "⌘K" : "Ctrl K" }}</kbd>
          </button>

          <el-dropdown v-if="me" trigger="click" placement="bottom-end" @command="onUserCommand">
            <button class="user-button">
              <span class="user-avatar">{{ initial }}</span>
              <span class="user-name">{{ me.name }}</span>
              <span v-if="me.isAdmin" class="user-role-pill">管理员</span>
              <el-icon class="user-arrow"><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <div class="dropdown-user">
                <div class="dropdown-name">{{ me.name }}</div>
                <div class="dropdown-role">{{ me.isAdmin ? "平台管理员" : "企业成员" }}</div>
              </div>
              <el-dropdown-menu>
                <el-dropdown-item command="password">修改密码</el-dropdown-item>
                <el-dropdown-item command="logout" divided class="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="main">
        <el-alert v-if="certificateNotice" class="cert-notice" :type="certificateNotice.type" :closable="false" show-icon>
          <template #title>{{ certificateNotice.text }} <router-link to="/certificate">去证书页</router-link></template>
        </el-alert>
        <router-view v-if="me" v-slot="{ Component }">
          <transition name="page-fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <!-- 全局快速跳转弹窗 -->
    <el-dialog v-model="paletteOpen" :show-close="false" width="min(520px, 94vw)" class="palette-dialog" align-center>
      <div class="palette-search">
        <el-icon class="palette-search-icon"><Search /></el-icon>
        <el-input
          ref="paletteInputRef"
          v-model="paletteQuery"
          placeholder="搜索页面名称或你的应用名，按回车直达…"
          clearable
          @keyup.enter="jumpFirst"
        />
        <kbd class="kbd">ESC</kbd>
      </div>
      <div class="palette-body">
        <div v-if="filteredApps.length > 0" class="palette-section">
          <div class="palette-section-title">我的应用</div>
          <button
            v-for="app in filteredApps"
            :key="app.name"
            type="button"
            class="palette-item"
            @click="jumpTo(`/apps/${app.name}`)"
          >
            <AppAvatar :name="app.name" :size="26" :muted="!app.live || app.disabled || app.unpublished" />
            <div class="palette-item-main">
              <span class="palette-item-name">{{ app.name }}</span>
              <span class="palette-item-sub">{{ app.url }}</span>
            </div>
            <StatusTag :type="appStatus(app)[1]">{{ appStatus(app)[0] }}</StatusTag>
          </button>
        </div>

        <div v-if="filteredNav.length > 0" class="palette-section">
          <div class="palette-section-title">导航页面</div>
          <button
            v-for="item in filteredNav"
            :key="item.path"
            type="button"
            class="palette-item"
            @click="jumpTo(item.path)"
          >
            <span class="palette-icon-box"><component :is="item.icon" /></span>
            <div class="palette-item-main">
              <span class="palette-item-name">{{ item.label }}</span>
              <span class="palette-item-sub">{{ item.hint }}</span>
            </div>
            <span class="palette-group-pill">{{ item.group }}</span>
          </button>
        </div>

        <div v-if="filteredApps.length === 0 && filteredNav.length === 0" class="palette-empty">
          没有找到与“{{ paletteQuery }}”匹配的应用或页面
        </div>
      </div>
    </el-dialog>

    <!-- 修改密码弹窗 -->
    <el-dialog v-model="passwordOpen" title="修改密码" width="min(420px, 92vw)" @closed="resetPasswordForm">
      <el-form label-position="top" @submit.prevent="changePassword">
        <el-form-item label="当前密码">
          <el-input v-model="pw.current" type="password" show-password autocomplete="current-password" placeholder="输入当前登录密码" />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="pw.next" type="password" show-password autocomplete="new-password" placeholder="输入新密码" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="pw.again" type="password" show-password autocomplete="new-password" placeholder="再输入一次新密码" />
        </el-form-item>
        <ul class="pw-checklist">
          <li :class="{ ok: pwRules.len }"><el-icon><CircleCheck /></el-icon>长度至少 8 位</li>
          <li :class="{ ok: pwRules.notDigits }"><el-icon><CircleCheck /></el-icon>不能全部为纯数字</li>
          <li :class="{ ok: pwRules.same }"><el-icon><CircleCheck /></el-icon>两次输入保持一致</li>
        </ul>
        <p class="status-note">改完后其他浏览器上的登录会失效，这里保持登录；个人令牌不受影响。</p>
      </el-form>
      <template #footer>
        <el-button @click="passwordOpen = false">取消</el-button>
        <el-button type="primary" :loading="pwSaving" :disabled="!pwCanSubmit" @click="changePassword">保存新密码</el-button>
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
  width: 240px;
  height: 100vh;
  background: rgba(255, 255, 255, 0.96);
  border-right: 1px solid var(--color-border);
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 60px;
  padding: 0 18px;
  border-bottom: 1px solid rgba(241, 245, 249, 0.9);
  text-decoration: none;
}
.sidebar-brand:hover { text-decoration: none; }
.brand-copy { display: flex; flex-direction: column; line-height: 1.15; }
.brand-name { color: var(--color-text-heading); font-size: 16px; font-weight: 800; letter-spacing: -0.02em; }
.brand-sub { margin-top: 2px; color: var(--color-text-muted); font-size: 11px; }
.brand-tag {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: 11px;
  font-weight: 600;
}

.sidebar-nav { flex: 1; overflow-y: auto; padding: 8px 12px 12px; }
.nav-group + .nav-group { margin-top: 6px; }
.nav-group-label {
  padding: 12px 10px 6px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 2px 0;
  padding: 9px 11px;
  border-radius: 10px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-body);
  font-weight: 500;
  transition: background 0.14s, color 0.14s;
}
.nav-item:hover { background: var(--color-bg-subtle); color: var(--color-text-heading); text-decoration: none; }
.nav-item:focus-visible { outline: 2px solid var(--color-brand); outline-offset: -2px; }
.nav-item.active {
  background: var(--color-brand-soft);
  color: var(--color-brand-dark);
  font-weight: 600;
}
.nav-item.active::before {
  content: "";
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: -12px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--color-brand);
}
.nav-icon { flex-shrink: 0; width: 16px; height: 16px; }
.nav-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-dot {
  margin-left: auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.nav-dot.warn { background: var(--color-warning); }
.nav-dot.danger { background: var(--color-danger); }

.help-card {
  margin: 12px;
  padding: 14px;
  border: 1px solid var(--color-brand-border);
  border-radius: 14px;
  background:
    radial-gradient(120px 80px at 100% 0%, rgba(96, 165, 250, 0.14), transparent 70%),
    linear-gradient(160deg, var(--color-brand-surface), var(--color-brand-soft));
}
.help-badge {
  display: inline-block;
  margin-bottom: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.12);
  color: var(--color-brand-dark);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
}
.help-title { color: var(--color-text-heading); font-size: 13px; font-weight: 700; }
.help-card p { margin: 5px 0 10px; color: var(--color-text-secondary); font-size: 12px; line-height: 1.55; }
.help-link { display: inline-flex; align-items: center; gap: 4px; color: var(--color-brand); font-size: 12px; font-weight: 600; }

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
  height: 60px;
  padding: 0 24px;
  background: rgba(255, 255, 255, 0.82);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(226, 232, 240, 0.85);
}
.topbar-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.topbar-right { display: flex; align-items: center; gap: 10px; }
.crumb-group { color: var(--color-text-muted); font-size: var(--font-size-body); white-space: nowrap; }
.topbar-title {
  overflow: hidden;
  color: var(--color-text-heading);
  font-size: 15px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.back-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 9px 0 6px;
  border-radius: 7px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-body);
  white-space: nowrap;
}
.back-button:hover { background: var(--color-brand-soft); color: var(--color-brand); text-decoration: none; }
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.icon-button:hover { background: var(--color-bg-subtle); }
.nav-toggle { display: none; }

.quick-search-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-page);
  color: var(--color-text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.quick-search-btn:hover {
  border-color: var(--color-brand-border);
  background: #fff;
  color: var(--color-text-primary);
}
.kbd {
  padding: 1px 6px;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  background: #fff;
  color: var(--color-text-muted);
  font-family: "SF Mono", Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
}

.user-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 5px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.user-button:hover { background: var(--color-bg-subtle); border-color: var(--color-border); }
.user-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--gradient-brand);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
}
.user-name {
  max-width: 120px;
  overflow: hidden;
  color: var(--color-text-heading);
  font-size: var(--font-size-body);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-role-pill {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: 11px;
  font-weight: 600;
}
.user-arrow { color: var(--color-text-muted); }
.dropdown-user { min-width: 168px; padding: 10px 16px 8px; }
.dropdown-name { color: var(--color-text-heading); font-size: var(--font-size-body); font-weight: 600; }
.dropdown-role { margin-top: 2px; color: var(--color-text-muted); font-size: 11px; }
:global(.el-dropdown-menu__item.logout) { color: var(--color-danger); }

.main { flex: 1; width: 100%; padding: 18px 24px 32px; }
.cert-notice { margin-bottom: 16px; }

/* ---- 快速跳转弹窗 ---- */
:deep(.palette-dialog .el-dialog__header) { display: none; }
:deep(.palette-dialog .el-dialog__body) { padding: 0; }
.palette-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
}
.palette-search-icon { color: var(--color-text-muted); font-size: 16px; }
.palette-search :deep(.el-input__wrapper) { box-shadow: none !important; padding: 0 4px; background: transparent; }
.palette-body { max-height: 380px; overflow-y: auto; padding: 8px; }
.palette-section + .palette-section { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--color-bg-subtle); }
.palette-section-title { padding: 4px 10px 6px; color: var(--color-text-muted); font-size: 11px; font-weight: 600; }
.palette-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background 0.12s;
}
.palette-item:hover { background: var(--color-brand-hover); }
.palette-icon-box {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--color-bg-subtle);
  color: var(--color-brand);
  flex-shrink: 0;
}
.palette-icon-box svg { width: 14px; height: 14px; }
.palette-item-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.palette-item-name { color: var(--color-text-heading); font-size: 13px; font-weight: 600; }
.palette-item-sub { overflow: hidden; color: var(--color-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.palette-group-pill {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-bg-subtle);
  color: var(--color-text-muted);
  font-size: 11px;
}
.palette-empty { padding: 28px 12px; text-align: center; color: var(--color-text-muted); font-size: 13px; }

/* ---- 修改密码规则清单 ---- */
.pw-checklist {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  list-style: none;
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--color-bg-page);
  font-size: 12px;
  color: var(--color-text-muted);
}
.pw-checklist li { display: inline-flex; align-items: center; gap: 5px; transition: color 0.15s; }
.pw-checklist li.ok { color: #059669; font-weight: 600; }

/* ---- 窄屏:侧边栏改成抽屉 ---- */
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    z-index: 30;
    left: 0;
    transform: translateX(-100%);
    visibility: hidden;
    transition: transform 0.2s, visibility 0s linear 0.2s;
  }
  .sidebar.open { transform: none; visibility: visible; transition: transform 0.2s; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }
  .sidebar-mask { position: fixed; inset: 0; z-index: 20; background: rgba(15, 23, 42, 0.35); backdrop-filter: blur(2px); }
  .nav-toggle { display: inline-flex; }
  .topbar { padding: 0 12px; }
  .crumb-group, .user-name, .user-role-pill, .quick-search-label, .quick-search-btn .kbd { display: none; }
  .quick-search-btn { width: 34px; padding: 0; justify-content: center; }
  .main { padding: 14px 12px 24px; }
}
</style>
