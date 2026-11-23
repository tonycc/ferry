<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { api, ApiError, type AdminDepartment, type AdminOrg, type AdminUser } from "../api";
import { me } from "../session";

/**
 * 管理员的人员页:新增和修改人员、标记离职和恢复、设置管理员、生成初始密码。
 * 一期没有钉钉同步,人员和部门都在控制台维护;员工用手机号(或工号)和密码登录,初始密码在这里生成后转交本人
 */
const users = ref<AdminUser[]>([]);
const departments = ref<AdminDepartment[]>([]);
const loading = ref(true);
const forbidden = ref(false);
const filter = ref("");
const status = ref<"active" | "inactive" | "all">("active");
const busy = ref<string>();

const PASSWORD: Record<AdminUser["password"], [string, "info" | "warning" | "success"]> = {
  none: ["没设密码", "info"],
  initial: ["初始密码,还没改", "warning"],
  set: ["已设置", "success"],
};

const departmentName = computed(() => new Map(departments.value.map((d) => [d.id, d.name])));
const namesOf = (u: AdminUser) => u.departmentIds.map((id) => departmentName.value.get(id) ?? id);

/** 部门树(选择部门用) */
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

async function load() {
  try {
    const org = await api.get<AdminOrg>("/api/admin/org");
    users.value = org.users;
    departments.value = org.departments;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) forbidden.value = true;
    else ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

const userPath = (u: AdminUser, action = "") => `/api/admin/users/${encodeURIComponent(u.id)}${action}`;

/** 弹框确认后执行;取消时返回 false */
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

async function showPassword(name: string, password: string) {
  await ElMessageBox.alert(
    `${name} 的初始密码:${password}\n\n这个密码只显示这一次,请当面或私下转交给本人(不要发在群里)。本人第一次登录后要改成自己的密码。`,
    "初始密码",
    { confirmButtonText: "我已记下", customStyle: { whiteSpace: "pre-wrap" } },
  );
}

async function reset(user: AdminUser) {
  const again = user.password !== "none";
  const ok = await confirm(
    again
      ? `给 ${user.name} 重新生成初始密码:原来的密码立即失效,已经登录的地方都会退出;个人令牌不受影响。`
      : `给 ${user.name} 生成初始密码。`,
    "生成初始密码",
    "生成",
    again ? "warning" : "info",
  );
  if (!ok) return;
  await run(user, async () => {
    const { password } = await api.post<{ password: string }>(userPath(user, "/reset-password"));
    await showPassword(user.name, password);
  });
}

async function deactivate(user: AdminUser) {
  const ok = await confirm(
    `把 ${user.name} 标记为离职:立即不能登录,已经登录的地方都会退出,个人令牌失效。\n\n` +
      "他负责的应用照常运行、同事照常访问;不再需要的应用请在“管理全部应用”里停用或删除。以后可以恢复在职。",
    "标记离职",
    "标记离职",
  );
  if (ok) await run(user, () => api.post(userPath(user, "/deactivate")), `${user.name} 已标记为离职`);
}

async function reactivate(user: AdminUser) {
  const ok = await confirm(
    `恢复 ${user.name} 为在职:账号、应用、个人令牌都是原来的。要重新生成初始密码,本人才能登录。`,
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
      ? `把 ${user.name} 设为平台管理员:可以管理全部应用(停用、删除)、人员和部门,查看审计日志,并接收告警。`
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
    if (created && (await confirm(`已添加 ${created.name}。现在给他生成初始密码吗?`, "已添加", "生成初始密码", "info"))) {
      const { password } = await api.post<{ password: string }>(userPath(created, "/reset-password"));
      await showPassword(created.name, password);
      await load();
    }
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    dialog.saving = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-title"><h2>人员</h2></div>
  <el-result v-if="forbidden" icon="warning" title="只有平台管理员可以使用这个页面" />
  <el-card v-else shadow="never">
    <div class="bar">
      <el-radio-group v-model="status">
        <el-radio-button value="active">在职 {{ counts.active }}</el-radio-button>
        <el-radio-button value="inactive">已离职 {{ counts.inactive }}</el-radio-button>
        <el-radio-button value="all">全部</el-radio-button>
      </el-radio-group>
      <el-input v-model="filter" clearable placeholder="按姓名、手机号、工号或部门筛选" style="max-width: 280px" />
      <span class="spacer" />
      <el-button type="primary" :disabled="loading || departments.length === 0" @click="openCreate">新增人员</el-button>
    </div>
    <p class="muted hint">员工用手机号(或工号)和密码登录。新增后生成初始密码转交本人;忘记密码也在这里重新生成。部门在“部门”页维护。</p>
    <el-table v-loading="loading" :data="shown" :empty-text="loading ? ' ' : status === 'inactive' ? '没有已离职的人' : '还没有人员'">
      <el-table-column label="姓名" min-width="140">
        <template #default="{ row }">
          <span :class="{ muted: !row.active }">{{ row.name }}</span>
          <el-tag v-if="row.isAdmin" size="small" type="primary" class="tag" disable-transitions>
            {{ row.fixedAdmin ? "管理员(配置指定)" : "管理员" }}
          </el-tag>
          <el-tag v-if="!row.active" size="small" type="info" class="tag" disable-transitions>已离职</el-tag>
          <el-tag v-if="row.id === me?.id" size="small" class="tag" disable-transitions>我</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="手机号" width="130">
        <template #default="{ row }">{{ row.mobile ?? "—" }}</template>
      </el-table-column>
      <el-table-column label="工号" width="100">
        <template #default="{ row }">{{ row.jobNumber ?? "—" }}</template>
      </el-table-column>
      <el-table-column label="部门" min-width="160">
        <template #default="{ row }">{{ namesOf(row).join("、") || "—" }}</template>
      </el-table-column>
      <el-table-column label="登录密码" width="150">
        <template #default="{ row }">
          <el-tag v-if="row.active" :type="PASSWORD[row.password as AdminUser['password']][1]" disable-transitions>
            {{ PASSWORD[row.password as AdminUser["password"]][0] }}
          </el-tag>
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
                  <el-dropdown-item command="deactivate" :disabled="row.id === me?.id" divided>标记离职</el-dropdown-item>
                </template>
                <el-dropdown-item v-else command="reactivate">恢复在职</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="dialog.open" :title="dialog.editing ? `编辑 ${dialog.editing.name}` : '新增人员'" width="480px" :close-on-click-modal="false">
    <el-form label-width="72px" @submit.prevent="save">
      <el-form-item label="姓名" required>
        <el-input v-model="dialog.form.name" maxlength="40" />
      </el-form-item>
      <el-form-item label="手机号">
        <el-input v-model="dialog.form.mobile" maxlength="20" placeholder="登录用,和工号至少填一个" />
      </el-form-item>
      <el-form-item label="工号">
        <el-input v-model="dialog.form.jobNumber" maxlength="32" placeholder="选填,也可以用来登录" />
      </el-form-item>
      <el-form-item label="部门" required>
        <el-tree-select
          v-model="dialog.form.departmentIds"
          :data="tree"
          multiple
          check-strictly
          default-expand-all
          :render-after-expand="false"
          placeholder="选择所属部门(可以多选)"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item v-if="!dialog.editing" label="">
        <el-checkbox v-model="dialog.form.isAdmin">设为平台管理员</el-checkbox>
      </el-form-item>
      <p v-if="dialog.editing && dialog.editing.departmentIds.join() !== dialog.form.departmentIds.join()" class="muted">
        换部门后,“本部门可见”的应用对他是否可见、他的应用对谁可见,都按新部门判定。
      </p>
    </el-form>
    <template #footer>
      <el-button @click="dialog.open = false">取消</el-button>
      <el-button type="primary" :loading="dialog.saving" @click="save">{{ dialog.editing ? "保存" : "添加" }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.spacer { flex: 1; }
.hint { margin: 0 0 12px; }
.tag { margin-left: 6px; }
</style>
