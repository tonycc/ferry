<script setup lang="ts">
import { OfficeBuilding, Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { api, ApiError, type AdminDepartment, type AdminOrg } from "../api";

const departments = ref<AdminDepartment[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const forbidden = ref(false);
const busy = ref(false);

interface TreeNode {
  id: string;
  label: string;
  memberCount: number;
  subtreeCount: number;
  isRoot: boolean;
  children: TreeNode[];
}

function buildTree(list: AdminDepartment[], skip?: string): TreeNode[] {
  const nodes = new Map(
    list
      .filter((d) => d.id !== skip)
      .map((d) => [
        d.id,
        { id: d.id, label: d.name, memberCount: d.memberCount, subtreeCount: d.memberCount, isRoot: d.parentId === null, children: [] as TreeNode[] },
      ]),
  );
  const roots: TreeNode[] = [];
  for (const d of list) {
    const node = nodes.get(d.id);
    if (!node) continue;
    const parent = d.parentId ? nodes.get(d.parentId) : undefined;
    if (parent) parent.children.push(node);
    else if (d.parentId === null) roots.push(node);
  }
  const sortAndSum = (xs: TreeNode[]): number => {
    xs.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    let sum = 0;
    for (const n of xs) {
      n.subtreeCount = n.memberCount + sortAndSum(n.children);
      sum += n.subtreeCount;
    }
    return sum;
  };
  sortAndSum(roots);
  return roots;
}

const tree = computed(() => buildTree(departments.value));
const totalMembers = computed(() => departments.value.reduce((sum, d) => sum + d.memberCount, 0));
const childrenOf = (id: string) => departments.value.filter((d) => d.parentId === id);

async function load(manual = false) {
  if (manual) refreshing.value = true;
  try {
    departments.value = (await api.get<AdminOrg>("/api/admin/org")).departments;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) forbidden.value = true;
    else ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

const dialog = reactive({
  open: false,
  saving: false,
  editing: undefined as AdminDepartment | undefined,
  form: { name: "", parentId: null as string | null },
});

const parentChoices = computed(() => buildTree(departments.value, dialog.editing?.id));

function openCreate(parentId: string) {
  dialog.editing = undefined;
  dialog.form = { name: "", parentId };
  dialog.open = true;
}

function openEdit(id: string) {
  const department = departments.value.find((d) => d.id === id);
  if (!department) return;
  dialog.editing = department;
  dialog.form = { name: department.name, parentId: department.parentId };
  dialog.open = true;
}

const moving = computed(() => !!dialog.editing && dialog.editing.parentId !== null && dialog.form.parentId !== dialog.editing.parentId);

async function save() {
  if (dialog.saving) return;
  if (moving.value) {
    try {
      await ElMessageBox.confirm(
        "调整上级部门后，这个部门（和它的下级部门）里的人负责的“本部门可见”的应用，对谁可见会跟着变：新上级部门的人能看到，原来上级部门的人看不到了。",
        "调整上级部门",
        { confirmButtonText: "确定调整", cancelButtonText: "取消", type: "warning" },
      );
    } catch {
      return;
    }
  }
  dialog.saving = true;
  try {
    if (dialog.editing) await api.post(`/api/admin/departments/${encodeURIComponent(dialog.editing.id)}`, dialog.form);
    else await api.post("/api/admin/departments", dialog.form);
    dialog.open = false;
    ElMessage.success("已保存");
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    dialog.saving = false;
  }
}

async function remove(node: TreeNode) {
  try {
    await ElMessageBox.confirm(`确认删除部门“${node.label}”？`, "删除部门", { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" });
  } catch {
    return;
  }
  busy.value = true;
  try {
    await api.post(`/api/admin/departments/${encodeURIComponent(node.id)}/delete`);
    ElMessage.success("已删除");
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="ops-page">
    <el-result v-if="forbidden" icon="warning" title="只有平台管理员可以使用这个页面" />
    <template v-else>
      <div v-loading="loading" class="content-panel">
        <div class="panel-toolbar">
          <div class="filter-bar">
            <div class="panel-title">组织架构树</div>
            <span class="status-note">共 {{ departments.length }} 个部门 · {{ totalMembers }} 人次</span>
          </div>
          <el-button :icon="Refresh" :loading="refreshing" @click="load(true)">刷新</el-button>
        </div>
        <p class="panel-note">
          只能删除没有下级部门、也没有成员（含已离职成员）的空部门。调整上级部门会立即影响相关应用的访问范围。
        </p>
        <el-empty v-if="!loading && tree.length === 0" description="还没有部门：用命令行建第一个管理员时会建好最上级部门" />
        <el-tree v-else :data="tree" node-key="id" default-expand-all :expand-on-click-node="false" class="dept-tree">
          <template #default="{ data }">
            <div class="node">
              <span class="dept-icon" :class="{ root: data.isRoot }"><el-icon><OfficeBuilding /></el-icon></span>
              <span class="dept-name" :class="{ root: data.isRoot }">{{ data.label }}</span>
              <span v-if="data.isRoot" class="root-badge">根部门</span>
              <span class="count" :title="data.children.length ? `直属 ${data.memberCount} 人，含下级共 ${data.subtreeCount} 人次` : `直属 ${data.memberCount} 人`">
                {{ data.memberCount }} 人<template v-if="data.children.length && data.subtreeCount !== data.memberCount"> · 含下级 {{ data.subtreeCount }}</template>
              </span>
              <span class="spacer" />
              <div class="node-actions">
                <el-button link type="primary" size="small" :disabled="busy" @click.stop="openCreate(data.id)">新建下级</el-button>
                <el-button link size="small" :disabled="busy" @click.stop="openEdit(data.id)">{{ data.isRoot ? "改名" : "编辑" }}</el-button>
                <el-button
                  v-if="!data.isRoot"
                  link
                  size="small"
                  type="danger"
                  :disabled="busy || data.memberCount > 0 || childrenOf(data.id).length > 0"
                  @click.stop="remove(data)"
                >
                  删除
                </el-button>
              </div>
            </div>
          </template>
        </el-tree>
      </div>
    </template>

    <el-dialog
      v-model="dialog.open"
      :title="dialog.editing ? `编辑部门“${dialog.editing.name}”` : '新建下级部门'"
      width="min(440px, 92vw)"
      :close-on-click-modal="false"
    >
      <el-form label-width="80px" @submit.prevent="save">
        <el-form-item label="名称" required>
          <el-input v-model="dialog.form.name" maxlength="40" placeholder="输入部门名称" />
        </el-form-item>
        <el-form-item v-if="!dialog.editing || dialog.editing.parentId !== null" label="上级部门" required>
          <el-tree-select
            v-model="dialog.form.parentId"
            :data="parentChoices"
            :props="{ value: 'id', label: 'label', children: 'children' }"
            node-key="id"
            value-key="id"
            check-strictly
            default-expand-all
            :render-after-expand="false"
            style="width: 100%"
          />
        </el-form-item>
        <p v-if="moving" class="status-note">调整上级部门会改变这个部门里的人负责的“本部门可见”的应用对谁可见。</p>
      </el-form>
      <template #footer>
        <el-button @click="dialog.open = false">取消</el-button>
        <el-button type="primary" :loading="dialog.saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.node { display: flex; align-items: center; gap: 8px; flex: 1; padding-right: 10px; min-width: 0; }
.dept-icon {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.dept-icon.root { background: var(--color-brand-soft); color: var(--color-brand); }
.dept-name { color: var(--color-text-heading); font-weight: 500; }
.dept-name.root { font-weight: 700; }
.root-badge {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: 11px;
  font-weight: 600;
}
.count {
  padding: 1px 8px;
  border-radius: var(--radius-tag);
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  font-size: var(--font-size-badge);
  line-height: 1.6;
}
.spacer { flex: 1; }
.node-actions { display: inline-flex; align-items: center; gap: 4px; }
:deep(.el-tree-node__content) { height: 44px; border-radius: 10px; transition: background 0.14s; }
:deep(.el-tree-node__content:hover) { background: var(--color-brand-hover); }
</style>
