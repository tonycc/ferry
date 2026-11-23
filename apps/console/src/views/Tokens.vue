<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { api, type TokenView } from "../api";
import { time } from "../labels";

const tokens = ref<TokenView[]>([]);
const label = ref("");
const creating = ref(false);
/** 刚生成的令牌,只显示这一次 */
const created = ref<string>();

const mcpUrl = `${location.origin}/mcp`;
const cli = computed(
  () => `claude mcp add --transport http --scope user ferry ${mcpUrl} --header "Authorization: Bearer ${created.value}"`,
);
const agy = computed(() => `agy mcp add --header "Authorization: Bearer ${created.value}" ferry ${mcpUrl}`);
const codex = computed(
  () => `[mcp_servers.ferry]\nurl = "${mcpUrl}"\nhttp_headers = { "Authorization" = "Bearer ${created.value}" }`,
);
const json = computed(() =>
  JSON.stringify({ mcpServers: { ferry: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${created.value}` } } } }, null, 2),
);

async function load() {
  tokens.value = await api.get<TokenView[]>("/api/tokens");
}

async function create() {
  creating.value = true;
  try {
    const result = await api.post<{ token: string }>("/api/tokens", { label: label.value.trim() || undefined });
    created.value = result.token;
    label.value = "";
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    creating.value = false;
  }
}

async function revoke(token: TokenView) {
  try {
    await ElMessageBox.confirm(`作废令牌“${token.label}”后,用它的 agent 立即无法再连接 Ferry。`, "作废令牌", {
      confirmButtonText: "作废",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    await api.post(`/api/tokens/${token.id}/revoke`);
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("复制失败,请手动选中复制");
  }
}

onMounted(() => load().catch((err: Error) => ElMessage.error(err.message)));
</script>

<template>
  <div class="page-title"><h2>个人令牌</h2></div>
  <el-card shadow="never" class="card">
    <p class="intro">
      个人令牌给 agent 用:填进 agent 的 MCP 配置,作为请求头 <code>Authorization: Bearer 令牌</code>。
      令牌等同于你本人,只在生成时显示一次;不用了或泄露了就作废,再生成一个新的。离职后自动失效。
    </p>
    <div class="create">
      <el-input v-model="label" maxlength="60" placeholder="令牌名称,如“我的笔记本上的 Claude Code”" style="max-width: 360px" @keyup.enter="create" />
      <el-button type="primary" :loading="creating" @click="create">生成令牌</el-button>
    </div>
  </el-card>

  <el-card v-if="created" shadow="never" class="card new">
    <el-alert type="success" :closable="false" show-icon title="新令牌只显示这一次,请现在按下面的方式配好 agent" />
    <h4>令牌</h4>
    <div class="snippet"><pre>{{ created }}</pre><el-button size="small" @click="copy(created!)">复制</el-button></div>
    <h4>Claude Code:在终端里运行(<code>--scope user</code> 表示在你电脑上的所有项目里都能用)</h4>
    <div class="snippet"><pre>{{ cli }}</pre><el-button size="small" @click="copy(cli)">复制</el-button></div>
    <h4>Antigravity:在终端里运行(对所有目录都生效)</h4>
    <div class="snippet"><pre>{{ agy }}</pre><el-button size="small" @click="copy(agy)">复制</el-button></div>
    <h4>Codex:加到 <code>~/.codex/config.toml</code> 末尾(没有就新建),保存后重开 Codex</h4>
    <div class="snippet"><pre>{{ codex }}</pre><el-button size="small" @click="copy(codex)">复制</el-button></div>
    <h4>WorkBuddy:把 <code>ferry</code> 这一项加到 <code>~/.workbuddy/mcp.json</code> 的 <code>mcpServers</code> 里,保存后重开 WorkBuddy;其他支持 MCP 的 agent:添加一个 HTTP 类型的 MCP 服务</h4>
    <div class="snippet"><pre>{{ json }}</pre><el-button size="small" @click="copy(json)">复制</el-button></div>
    <el-button class="done" @click="created = undefined">我已配好</el-button>
  </el-card>

  <el-card shadow="never" class="card">
    <el-table :data="tokens">
      <el-table-column prop="label" label="名称" min-width="200" />
      <el-table-column label="生成时间" width="190">
        <template #default="{ row }">{{ time(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="最近使用" width="190">
        <template #default="{ row }">
          <el-tag v-if="row.revoked" type="info" disable-transitions>已作废</el-tag>
          <span v-else>{{ time(row.lastUsedAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column width="100" align="right">
        <template #default="{ row }">
          <el-button v-if="!row.revoked" link type="danger" @click="revoke(row)">作废</el-button>
        </template>
      </el-table-column>
      <template #empty>还没有令牌</template>
    </el-table>
  </el-card>
</template>

<style scoped>
.card { margin-bottom: 16px; }
.intro { margin-top: 0; line-height: 1.7; color: var(--el-text-color-regular); }
.create { display: flex; gap: 8px; flex-wrap: wrap; }
.new h4 { margin: 16px 0 6px; font-weight: 500; font-size: 14px; }
.snippet { display: flex; gap: 8px; align-items: flex-start; }
.snippet pre { flex: 1; margin: 0; background: #f6f8fa; padding: 10px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.done { margin-top: 16px; }
code { background: #f6f8fa; padding: 1px 5px; border-radius: 4px; }
</style>
