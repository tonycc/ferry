<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { api, ApiError, type AdminDepartment, type AdminOrg } from "../api";

/**
 * 管理员的部门页:部门树的新建、改名、调整上级和删除。
 * “本部门可见”的应用按这棵树判定(同部门和上级部门的同事能看),所以调整上级会改变应用对谁可见
 */
const departments = ref<AdminDepartment[]>([]);
const loading = ref(true);
const forbidden = ref(false);
const busy = ref(false);

interface TreeNode {
  id: string;
  label: string;
  memberCount: number;
  isRoot: boolean;
  children: TreeNode[];
}

function buildTree(list: AdminDepartment[], skip?: string): TreeNode[] {
  const nodes = new Map(
    list
      .filter((d) => d.id !== skip)
      .map((d) => [d.id, { id: d.id, label: d.name, memberCount: d.memberCount, isRoot: d.parentId === null, children: [] as TreeNode[] }]),
  );
  const roots: TreeNode[] = [];
  for (const d of list) {
    const node = nodes.get(d.id);
    if (!node) continue;
    const parent = d.parentId ? nodes.get(d.parentId) : undefined;
    if (parent) parent.children.push(node);
    else if (d.parentId === null) roots.push(node);
    // 上级被跳过(编辑时排除自己这一枝)的节点不显示
  }
  const sort = (xs: TreeNode[]) => {
    xs.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    xs.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const tree = computed(() => buildTree(departments.value));
const childrenOf = (id: string) => departments.value.filter((d) => d.parentId === id);

async function load() {
  try {
    departments.value = (await api.get<AdminOrg>("/api/admin/org")).departments;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) forbidden.value = true;
    else ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

// ---- 新建、改名、调整上级 ----

const dialog = reactive({
  open: false,
  saving: false,
  editing: undefined as AdminDepartment | undefined,
  form: { name: "", parentId: null as string | null },
});

/** 编辑时上级部门的候选:排除自己和自己的下级 */
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
  if (moving.value) {
    try {
      await ElMessageBox.confirm(
        "调整上级部门后,这个部门(和它的下级部门)里的人负责的“本部门可见”的应用,对谁可见会跟着变:新上级部门的人能看到,原来上级部门的人看不到了。",
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
    await ElMessageBox.confirm(`删除部门“${node.label}”。`, "删除部门", { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" });
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

onMounted(load);
</script>

<template>
  <div class="page-title"><h2>部门</h2></div>
  <el-result v-if="forbidden" icon="warning" title="只有平台管理员可以使用这个页面" />
  <el-card v-else v-loading="loading" shadow="never">
    <p class="muted hint">
      “本部门可见”的应用,同部门和上级部门的同事能打开。最上级部门代表整个公司,不算作任何人的上级部门。
      只能删除没有下级部门、也没有人(包括已离职的人)的部门。
    </p>
    <el-empty v-if="!loading && tree.length === 0" description="还没有部门:用命令行建第一个管理员时会建好最上级部门" />
    <el-tree v-else :data="tree" node-key="id" default-expand-all :expand-on-click-node="false">
      <template #default="{ data }">
        <div class="node">
          <span>{{ data.label }}</span>
          <span class="muted count">{{ data.memberCount }} 人</span>
          <span class="spacer" />
          <el-button link size="small" :disabled="busy" @click.stop="openCreate(data.id)">新建下级部门</el-button>
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
      </template>
    </el-tree>
  </el-card>

  <el-dialog
    v-model="dialog.open"
    :title="dialog.editing ? `编辑部门“${dialog.editing.name}”` : '新建部门'"
    width="440px"
    :close-on-click-modal="false"
  >
    <el-form label-width="80px" @submit.prevent="save">
      <el-form-item label="名称" required>
        <el-input v-model="dialog.form.name" maxlength="40" />
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
      <p v-if="moving" class="muted">调整上级部门会改变这个部门里的人负责的“本部门可见”的应用对谁可见。</p>
    </el-form>
    <template #footer>
      <el-button @click="dialog.open = false">取消</el-button>
      <el-button type="primary" :loading="dialog.saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.hint { margin: 0 0 12px; }
.node { display: flex; align-items: center; gap: 8px; flex: 1; padding-right: 8px; }
.count { font-size: 12px; }
.spacer { flex: 1; }
:deep(.el-tree-node__content) { height: 36px; }
</style>
