<script setup lang="ts">
import { CopyDocument, Key, Plus, Refresh, Search } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { api, ApiError, type AdminDepartment, type AdminOrg, type AdminUser } from "../api";
import { copyText } from "../clipboard";
import StatusTag from "../components/StatusTag.vue";
import TableFooter from "../components/TableFooter.vue";
import { useLocalPagination } from "../composables/useLocalPagination";
import { me } from "../session";

const users = ref<AdminUser[]>([]);
const departments = ref<AdminDepartment[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const forbidden = ref(false);
const filter = ref("");
const status = ref<"active" | "inactive" | "all">("active");
const busy = ref<string>();

const PASSWORD: Record<AdminUser["password"], [string, "info" | "warning" | "success"]> = {
  none: ["没设密码", "info"],
  initial: ["初始密码，未修改", "warning"],
  set: ["已设置", "success"],
};

const departmentName = computed(() => new Map(departments.value.map((d) => [d.id, d.name])));
const namesOf = (u: AdminUser) => u.departmentIds.map((id) => departmentName.value.get(id) ?? id);

interface TreeNode {
  value: string;
  label: string;
  children: TreeNode[];
}
const tree = computed<TreeNode[]>(() => {
  const nodes = new Map(departments.value.map((d) => [d.id, { value: d.id, label: d.name, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const d of departments.value) {
    const node = nodes.get(d.id)!;
    const parent = d.parentId ? nodes.get(d.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
});

const counts = computed(() => ({
  active: users.value.filter((u) => u.active).length,
  inactive: users.value.filter((u) => !u.active).length,
}));

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return users.value
    .filter((u) => status.value === "all" || (status.value === "active") === u.active)
    .filter((u) => !q || [u.name, u.mobile ?? "", u.jobNumber ?? "", ...namesOf(u)].some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "zh-CN"));
});

const { currentPage, pageSize, total, pagedItems } = useLocalPagination(shown, [status, filter]);

async function load(manual = false) {
  if (manual) refreshing.value = true;
  try {
    const org = await api.get<AdminOrg>("/api/admin/org");
    users.value = org.users;
    departments.value = org.departments;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) forbidden.value = true;
    else ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

const userPath = (u: AdminUser, action = "") => `/api/admin/users/${encodeURIComponent(u.id)}${action}`;

async function confirm(message: string, title: string, button: string, type: "info" | "warning" = "warning") {
  try {
    await ElMessageBox.confirm(message, title, { confirmButtonText: button, cancelButtonText: "取消", type });
    return true;
  } catch {
    return false;
  }
}

async function run(user: AdminUser, action: () => Promise<unknown>, done?: string) {
  busy.value = user.id;
  try {
    await action();
    if (done) ElMessage.success(done);
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    busy.value = undefined;
  }
}

// ---- 专属初始密码展示弹窗(一键复制密码或整段私信指引) ----
const passwordModal = reactive({
  open: false,
  name: "",
  account: "",
  password: "",
});

function showPassword(user: AdminUser, password: string) {
  passwordModal.name = user.name;
  passwordModal.account = user.mobile ?? user.jobNumber ?? "";
  passwordModal.password = password;
  passwordModal.open = true;
}

const handoffMessage = computed(() => {
  const loginUrl = `${location.origin}/login`;
  return [
    `${passwordModal.name} 你好，这是你的 Ferry 登录凭据：`,
    `- 登录地址：${loginUrl}`,
    ...(passwordModal.account ? [`- 登录账号：${passwordModal.account}`] : []),
    `- 初始密码：${passwordModal.password}`,
    `首次登录后系统会提示你修改为自己的密码。`,
  ].join("\n");
});

async function reset(user: AdminUser) {
  const again = user.password !== "none";
  const ok = await confirm(
    again
      ? `给 ${user.name} 重新生成初始密码：原来的密码立即失效，已经登录的地方都会退出；个人令牌不受影响。`
      : `给 ${user.name} 生成初始密码。`,
    "生成初始密码",
    "生成",
    again ? "warning" : "info",
  );
  if (!ok) return;
  await run(user, async () => {
    const { password } = await api.post<{ password: string }>(userPath(user, "/reset-password"));
    showPassword(user, password);
  });
}

async function deactivate(user: AdminUser) {
  const ok = await confirm(
    `把 ${user.name} 标记为离职：立即不能登录，已经登录的地方都会退出，个人令牌和密码作废${user.isAdmin ? "，管理员身份取消" : ""}。\n\n` +
      "他负责的应用照常运行、同事照常访问；不再需要的应用请在“管理全部应用”里停用或删除。以后可以恢复在职。",
    "标记离职",
    "标记离职",
  );
  if (ok) await run(user, () => api.post(userPath(user, "/deactivate")), `${user.name} 已标记为离职`);
}

async function reactivate(user: AdminUser) {
  const ok = await confirm(
    `恢复 ${user.name} 为在职：还是原来的账号和应用，恢复后是普通员工。密码和个人令牌已经作废，要重新生成初始密码，本人登录后重新领令牌。`,
    "恢复在职",
    "恢复",
    "info",
  );
  if (ok) await run(user, () => api.post(userPath(user, "/reactivate")), `${user.name} 已恢复在职`);
}

async function toggleAdmin(user: AdminUser) {
  const make = !user.isAdmin;
  const ok = await confirm(
    make
      ? `把 ${user.name} 设为平台管理员：可以管理全部应用（停用、删除）、人员和部门，查看审计日志，并接收告警。`
      : `取消 ${user.name} 的平台管理员身份。`,
    make ? "设为管理员" : "取消管理员",
    make ? "设为管理员" : "取消管理员",
  );
  if (ok) await run(user, () => api.post(userPath(user, "/admin"), { isAdmin: make }), make ? "已设为管理员" : "已取消管理员");
}

function onCommand(user: AdminUser, command: string) {
  if (command === "admin") void toggleAdmin(user);
  else if (command === "deactivate") void deactivate(user);
  else if (command === "reactivate") void reactivate(user);
}

// ---- 新增和修改 ----
const dialog = reactive({
  open: false,
  saving: false,
  editing: undefined as AdminUser | undefined,
  form: { name: "", mobile: "", jobNumber: "", departmentIds: [] as string[], isAdmin: false },
});

function openCreate() {
  dialog.editing = undefined;
  dialog.form = { name: "", mobile: "", jobNumber: "", departmentIds: [], isAdmin: false };
  dialog.open = true;
}

function openEdit(user: AdminUser) {
  dialog.editing = user;
  dialog.form = {
    name: user.name,
    mobile: user.mobile ?? "",
    jobNumber: user.jobNumber ?? "",
    departmentIds: [...user.departmentIds],
    isAdmin: user.isAdmin,
  };
  dialog.open = true;
}

async function save() {
  if (dialog.saving) return;
  const { name, mobile, jobNumber, departmentIds, isAdmin } = dialog.form;
  const body = { name, mobile, jobNumber, departmentIds };
  dialog.saving = true;
  try {
    if (dialog.editing) {
      await api.post(userPath(dialog.editing), body);
      dialog.open = false;
      ElMessage.success("已保存");
      await load();
      return;
    }
    const { id } = await api.post<{ id: string }>("/api/admin/users", { ...body, isAdmin });
    dialog.open = false;
    await load();
    const created = users.value.find((u) => u.id === id);
    if (created && (await confirm(`已添加 ${created.name}。现在给他生成初始密码吗？`, "已添加", "生成初始密码", "info"))) {
      const { password } = await api.post<{ password: string }>(userPath(created, "/reset-password"));
      showPassword(created, password);
      await load();
    }
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    dialog.saving = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="ops-page">
    <el-result v-if="forbidden" icon="warning" title="只有平台管理员可以使用这个页面" />
    <template v-else>
      <div class="content-panel">
        <div class="panel-toolbar">
          <div class="filter-bar">
            <el-radio-group v-model="status">
              <el-radio-button value="active">在职 {{ counts.active }}</el-radio-button>
              <el-radio-button value="inactive">已离职 {{ counts.inactive }}</el-radio-button>
              <el-radio-button value="all">全部 {{ users.length }}</el-radio-button>
            </el-radio-group>
            <el-input
              v-model="filter"
              clearable
              :prefix-icon="Search"
              placeholder="按姓名、手机号、工号或部门筛选"
              style="width: 280px"
            />
          </div>
          <div class="filter-bar">
            <el-button :icon="Refresh" :loading="refreshing" @click="load(true)">刷新</el-button>
            <el-button type="primary" :icon="Plus" :disabled="loading || departments.length === 0" @click="openCreate">新增人员</el-button>
          </div>
        </div>
        <el-table v-loading="loading" class="data-table" :data="pagedItems" :empty-text="loading ? ' ' : status === 'inactive' ? '没有已离职的人员' : '还没有人员'">
          <el-table-column label="姓名" min-width="180">
            <template #default="{ row }">
              <div class="person-cell">
                <span class="person-avatar" :class="{ muted: !row.active }">{{ Array.from(row.name)[0] ?? "?" }}</span>
                <div>
                  <span :class="{ muted: !row.active }" class="person-name">{{ row.name }}</span>
                  <StatusTag v-if="row.isAdmin" type="primary" class="tag">
                    {{ row.fixedAdmin ? "管理员(配置)" : "管理员" }}
                  </StatusTag>
                  <StatusTag v-if="!row.active" type="info" class="tag">已离职</StatusTag>
                  <StatusTag v-if="row.id === me?.id" type="info" plain class="tag">我</StatusTag>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="手机号" width="135">
            <template #default="{ row }"><span class="mono">{{ row.mobile ?? "—" }}</span></template>
          </el-table-column>
          <el-table-column label="工号" width="110">
            <template #default="{ row }"><span class="mono">{{ row.jobNumber ?? "—" }}</span></template>
          </el-table-column>
          <el-table-column label="部门" min-width="160">
            <template #default="{ row }">{{ namesOf(row).join("、") || "—" }}</template>
          </el-table-column>
          <el-table-column label="登录密码" width="155">
            <template #default="{ row }">
              <StatusTag v-if="row.active" :type="PASSWORD[row.password as AdminUser['password']][1]">
                {{ PASSWORD[row.password as AdminUser["password"]][0] }}
              </StatusTag>
              <span v-else class="muted">不能登录</span>
            </template>
          </el-table-column>
          <el-table-column width="260" align="right">
            <template #default="{ row }">
              <el-button size="small" :disabled="!!busy" @click="openEdit(row)">编辑</el-button>
              <el-button v-if="row.active" size="small" :loading="busy === row.id" :disabled="!!busy && busy !== row.id" @click="reset(row)">
                {{ row.password === "none" ? "生成初始密码" : "重置密码" }}
              </el-button>
              <el-dropdown trigger="click" :disabled="!!busy" @command="(c: string) => onCommand(row, c)">
                <el-button size="small" :disabled="!!busy">更多</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <template v-if="row.active">
                      <el-dropdown-item command="admin" :disabled="row.fixedAdmin || (row.isAdmin && row.id === me?.id)">
                        {{ row.isAdmin ? "取消管理员" : "设为管理员" }}
                      </el-dropdown-item>
                      <el-dropdown-item command="deactivate" :disabled="row.id === me?.id || row.fixedAdmin" divided>标记离职</el-dropdown-item>
                    </template>
                    <el-dropdown-item v-else command="reactivate">恢复在职</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-table-column>
        </el-table>
        <TableFooter v-model:current-page="currentPage" v-model:page-size="pageSize" :total="total" unit="人" />
      </div>
    </template>

    <!-- 初始密码一键复制弹窗 -->
    <el-dialog
      v-model="passwordModal.open"
      title="初始密码已生成"
      width="min(460px, 92vw)"
      :close-on-click-modal="false"
      @closed="passwordModal.password = ''"
    >
      <div class="pw-modal-body">
        <el-alert type="warning" :closable="false" show-icon title="此密码仅展示这一次，请私下转交本人，切勿发在公开群聊中。" />
        <div class="pw-display">
          <div class="pw-display-label"><el-icon><Key /></el-icon> {{ passwordModal.name }} 的初始密码</div>
          <div class="pw-display-code">
            <code>{{ passwordModal.password }}</code>
            <el-button type="primary" size="small" :icon="CopyDocument" @click="copyText(passwordModal.password, '已复制初始密码')">
              复制密码
            </el-button>
          </div>
        </div>
        <div class="handoff-box">
          <div class="handoff-head">
            <span>发给员工的登录指引（可一键复制私信）</span>
            <el-button link type="primary" :icon="CopyDocument" @click="copyText(handoffMessage, '已复制完整登录指引')">复制整段</el-button>
          </div>
          <pre>{{ handoffMessage }}</pre>
        </div>
      </div>
      <template #footer>
        <el-button type="primary" @click="passwordModal.open = false">我已妥善记录</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑人员 -->
    <el-dialog v-model="dialog.open" :title="dialog.editing ? `编辑 ${dialog.editing.name}` : '新增人员'" width="min(480px, 92vw)" :close-on-click-modal="false">
      <el-form label-width="76px" @submit.prevent="save">
        <el-form-item label="姓名" required>
          <el-input v-model="dialog.form.name" maxlength="40" placeholder="员工真实姓名" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="dialog.form.mobile" maxlength="20" placeholder="登录用，和工号至少填一个" />
        </el-form-item>
        <el-form-item label="工号">
          <el-input v-model="dialog.form.jobNumber" maxlength="32" placeholder="选填，也可以用来登录" />
        </el-form-item>
        <el-form-item label="部门" required>
          <el-tree-select
            v-model="dialog.form.departmentIds"
            :data="tree"
            multiple
            check-strictly
            default-expand-all
            :render-after-expand="false"
            placeholder="选择所属部门（可多选）"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item v-if="!dialog.editing" label="">
          <el-checkbox v-model="dialog.form.isAdmin">设为平台管理员</el-checkbox>
        </el-form-item>
        <p v-if="dialog.editing && dialog.editing.departmentIds.join() !== dialog.form.departmentIds.join()" class="status-note">
          换部门后，“本部门可见”的应用对他是否可见、他的应用对谁可见，都将立即按新部门判定。
        </p>
      </el-form>
      <template #footer>
        <el-button @click="dialog.open = false">取消</el-button>
        <el-button type="primary" :loading="dialog.saving" @click="save">{{ dialog.editing ? "保存修改" : "确认添加" }}</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.person-cell { display: flex; align-items: center; gap: 10px; }
.person-avatar {
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: 12px;
  font-weight: 700;
}
.person-avatar.muted { background: var(--color-bg-subtle); color: var(--color-text-muted); }
.person-name { font-weight: 600; color: var(--color-text-heading); }
.person-name.muted { font-weight: 400; color: var(--color-text-muted); }
.mono { font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
.tag { margin-left: 6px; }

.pw-modal-body { display: flex; flex-direction: column; gap: 14px; }
.pw-display {
  padding: 14px 16px;
  border: 1px solid var(--color-brand-border-strong);
  border-radius: 12px;
  background: var(--color-brand-surface);
}
.pw-display-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: var(--color-brand-dark);
  font-size: 12px;
  font-weight: 700;
}
.pw-display-code { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.pw-display-code code {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--color-brand-border);
  background: #fff;
  color: var(--color-text-heading);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.handoff-box {
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-bg-page);
}
.handoff-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.handoff-box pre {
  margin: 0;
  color: var(--color-text-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
}
</style>
