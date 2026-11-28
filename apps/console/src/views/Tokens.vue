<script setup lang="ts">
import { Check, CopyDocument, Key, Plus } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { api, type TokenView } from "../api";
import { copyText } from "../clipboard";
import StatusTag from "../components/StatusTag.vue";
import TableFooter from "../components/TableFooter.vue";
import { useLocalPagination } from "../composables/useLocalPagination";
import { relativeTime, time } from "../labels";

const tokens = ref<TokenView[]>([]);
const loading = ref(true);
const label = ref("");
const creating = ref(false);
const hideRevoked = ref(false);
/** 刚生成的令牌,只显示这一次 */
const created = ref<string>();
const clientTab = ref<"claude" | "agy" | "codex" | "workbuddy" | "json">("claude");
const copiedKey = ref<string>();

const mcpUrl = `${location.origin}/mcp`;
const httpsSince = ref<string>();
const recentlySwitched = computed(() => !!httpsSince.value && Date.now() - Date.parse(httpsSince.value) < 30 * 24 * 3600_000);

const tokenPreview = computed(() => created.value ?? "<你的个人令牌>");
const cli = computed(
  () => `claude mcp add --transport http --scope user ferry ${mcpUrl} --header "Authorization: Bearer ${tokenPreview.value}"`,
);
const agy = computed(() => `agy mcp add --header "Authorization: Bearer ${tokenPreview.value}" ferry ${mcpUrl}`);
const codex = computed(
  () => `[mcp_servers.ferry]\nurl = "${mcpUrl}"\nhttp_headers = { "Authorization" = "Bearer ${tokenPreview.value}" }`,
);
const workbuddy = computed(() =>
  `"ferry": ${JSON.stringify({ type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${tokenPreview.value}` } }, null, 2)}`,
);
const json = computed(() =>
  JSON.stringify({ mcpServers: { ferry: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${tokenPreview.value}` } } } }, null, 2),
);

const activeCount = computed(() => tokens.value.filter((t) => !t.revoked).length);
const shownTokens = computed(() => (hideRevoked.value ? tokens.value.filter((t) => !t.revoked) : tokens.value));
const { currentPage, pageSize, total, pagedItems } = useLocalPagination(shownTokens, [hideRevoked]);

async function load() {
  try {
    tokens.value = await api.get<TokenView[]>("/api/tokens");
  } finally {
    loading.value = false;
  }
}

async function create() {
  if (creating.value) return;
  creating.value = true;
  try {
    const result = await api.post<{ token: string }>("/api/tokens", { label: label.value.trim() || undefined });
    created.value = result.token;
    label.value = "";
    await load();
    currentPage.value = 1;
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    creating.value = false;
  }
}

async function revoke(token: TokenView) {
  try {
    await ElMessageBox.confirm(`作废令牌“${token.label}”后，使用它的 Agent 将立即无法连接 Ferry。`, "作废令牌", {
      confirmButtonText: "确认作废",
      cancelButtonText: "取消",
      type: "warning",
    });
  } catch {
    return;
  }
  try {
    await api.post(`/api/tokens/${token.id}/revoke`);
    ElMessage.success("令牌已作废");
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

async function copyWithState(key: string, text: string, msg = "已复制到剪贴板") {
  const ok = await copyText(text, msg);
  if (ok) {
    copiedKey.value = key;
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = undefined;
    }, 2000);
  }
}

onMounted(() => {
  load().catch((err: Error) => ElMessage.error(err.message));
  api
    .get<{ https: boolean; httpsSince?: string }>("/api/instance")
    .then((info) => (httpsSince.value = info.https ? info.httpsSince : undefined))
    .catch(() => {});
});
</script>

<template>
  <section class="ops-page">
    <el-alert v-if="recentlySwitched" type="warning" :closable="false" show-icon>
      <template #title>
        Ferry 在 {{ time(httpsSince!) }} 改用了 HTTPS。之前配好的 Agent 要把 MCP 地址更新为 <code>{{ mcpUrl }}</code>：
        建议重新生成一个令牌并按下方命令重新配置（会自动覆盖旧配置）。
      </template>
    </el-alert>

    <!-- 生成令牌 -->
    <div class="content-panel">
      <div class="panel-toolbar">
        <div class="filter-bar">
          <div class="panel-title">生成新令牌</div>
          <span class="status-note">生效中 {{ activeCount }} 个</span>
        </div>
        <div class="mcp-pill">
          <span class="mcp-pill-label">MCP 地址</span>
          <code>{{ mcpUrl }}</code>
          <button type="button" class="copy-icon-btn" title="复制 MCP 地址" @click="copyWithState('mcp', mcpUrl, '已复制 MCP 服务地址')">
            <el-icon><Check v-if="copiedKey === 'mcp'" /><CopyDocument v-else /></el-icon>
          </button>
        </div>
      </div>
      <p class="panel-note">
        个人令牌等同于你本人的发布权限，作为请求头 <code>Authorization: Bearer 令牌</code> 供 Agent 调用。
        <b>明文仅在生成时展示一次</b>；设备遗失或泄露请立即作废，员工离职后自动失效。
      </p>
      <div class="create">
        <el-input
          v-model="label"
          maxlength="60"
          placeholder="给令牌起个名字，如“公司 MacBook 上的 Claude Code”"
          style="max-width: 380px"
          @keyup.enter="create"
        />
        <el-button type="primary" :icon="Plus" :loading="creating" @click="create">生成个人令牌</el-button>
      </div>
    </div>

    <!-- 新令牌高亮 + 多客户端 Tab 接入向导 -->
    <div class="content-panel" :class="{ 'new-token-panel': created }">
      <template v-if="created">
        <el-alert
          type="success"
          :closable="false"
          show-icon
          title="个人令牌已生成，明文仅显示这一次，请立即完成下方任意客户端的配置"
        />
        <div class="token-reveal">
          <div class="token-reveal-label"><el-icon><Key /></el-icon> 你的个人令牌</div>
          <div class="token-reveal-row">
            <code>{{ created }}</code>
            <el-button type="primary" size="small" @click="copyWithState('raw', created!, '已复制令牌明文')">
              <el-icon class="el-icon--left"><Check v-if="copiedKey === 'raw'" /><CopyDocument v-else /></el-icon>
              {{ copiedKey === "raw" ? "已复制" : "复制令牌" }}
            </el-button>
          </div>
        </div>
      </template>
      <div v-else class="panel-toolbar">
        <div class="panel-title">Agent 接入命令参考</div>
        <span class="status-note">生成新令牌后，下方命令会自动填入真实令牌</span>
      </div>

      <el-tabs v-model="clientTab" class="client-tabs">
        <el-tab-pane label="Claude Code" name="claude">
          <p class="tab-desc">在终端运行下方命令（<code>--scope user</code> 表示在你电脑的所有项目目录里都生效）：</p>
          <div class="terminal-box">
            <div class="terminal-header">
              <span class="terminal-dots"><i /><i /><i /></span>
              <span>Terminal</span>
              <el-button size="small" text class="term-copy" @click="copyWithState('claude', cli)">
                <el-icon><Check v-if="copiedKey === 'claude'" /><CopyDocument v-else /></el-icon>
                {{ copiedKey === "claude" ? "已复制" : "复制命令" }}
              </el-button>
            </div>
            <pre class="terminal-body">{{ cli }}</pre>
          </div>
        </el-tab-pane>

        <el-tab-pane label="Antigravity (agy)" name="agy">
          <p class="tab-desc">在终端运行下方命令，对所有工作目录生效：</p>
          <div class="terminal-box">
            <div class="terminal-header">
              <span class="terminal-dots"><i /><i /><i /></span>
              <span>Terminal</span>
              <el-button size="small" text class="term-copy" @click="copyWithState('agy', agy)">
                <el-icon><Check v-if="copiedKey === 'agy'" /><CopyDocument v-else /></el-icon>
                {{ copiedKey === "agy" ? "已复制" : "复制命令" }}
              </el-button>
            </div>
            <pre class="terminal-body">{{ agy }}</pre>
          </div>
        </el-tab-pane>

        <el-tab-pane label="Codex" name="codex">
          <p class="tab-desc">
            追加到 <code>~/.codex/config.toml</code> 末尾（没有则新建），保存后重启 Codex。若已有 <code>[mcp_servers.ferry]</code> 请直接替换原段落：
          </p>
          <div class="terminal-box">
            <div class="terminal-header">
              <span class="terminal-dots"><i /><i /><i /></span>
              <span>~/.codex/config.toml</span>
              <el-button size="small" text class="term-copy" @click="copyWithState('codex', codex)">
                <el-icon><Check v-if="copiedKey === 'codex'" /><CopyDocument v-else /></el-icon>
                {{ copiedKey === "codex" ? "已复制" : "复制配置" }}
              </el-button>
            </div>
            <pre class="terminal-body">{{ codex }}</pre>
          </div>
        </el-tab-pane>

        <el-tab-pane label="WorkBuddy" name="workbuddy">
          <p class="tab-desc">
            打开 <code>~/.workbuddy/mcp.json</code>，将下方条目并列添加到 <code>mcpServers</code> 中（注意逗号分隔），保存后重启。文件不存在时可直接切换到“通用 JSON”新建：
          </p>
          <div class="terminal-box">
            <div class="terminal-header">
              <span class="terminal-dots"><i /><i /><i /></span>
              <span>~/.workbuddy/mcp.json</span>
              <el-button size="small" text class="term-copy" @click="copyWithState('wb', workbuddy)">
                <el-icon><Check v-if="copiedKey === 'wb'" /><CopyDocument v-else /></el-icon>
                {{ copiedKey === "wb" ? "已复制" : "复制片段" }}
              </el-button>
            </div>
            <pre class="terminal-body">{{ workbuddy }}</pre>
          </div>
        </el-tab-pane>

        <el-tab-pane label="通用 MCP (JSON)" name="json">
          <p class="tab-desc">适用于其他支持远程 HTTP MCP 的客户端（如 Cursor、Windsurf 等）：</p>
          <div class="terminal-box">
            <div class="terminal-header">
              <span class="terminal-dots"><i /><i /><i /></span>
              <span>mcp.json</span>
              <el-button size="small" text class="term-copy" @click="copyWithState('json', json)">
                <el-icon><Check v-if="copiedKey === 'json'" /><CopyDocument v-else /></el-icon>
                {{ copiedKey === "json" ? "已复制" : "复制 JSON" }}
              </el-button>
            </div>
            <pre class="terminal-body">{{ json }}</pre>
          </div>
        </el-tab-pane>
      </el-tabs>

      <div v-if="created" class="done-bar">
        <el-button type="primary" @click="created = undefined">我已完成配置，隐藏明文令牌</el-button>
      </div>
    </div>

    <!-- 我的令牌列表 -->
    <div class="content-panel">
      <div class="panel-toolbar">
        <div class="panel-title">我的令牌记录</div>
        <el-checkbox v-model="hideRevoked">仅显示生效中的令牌</el-checkbox>
      </div>
      <el-table v-loading="loading" :data="pagedItems" class="data-table">
        <el-table-column prop="label" label="名称" min-width="200">
          <template #default="{ row }">
            <span :class="{ muted: row.revoked }" class="token-name">{{ row.label }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <StatusTag v-if="row.revoked" type="info">已作废</StatusTag>
            <StatusTag v-else type="success">生效中</StatusTag>
          </template>
        </el-table-column>
        <el-table-column label="生成时间" width="190">
          <template #default="{ row }">
            <span :title="time(row.createdAt)">{{ relativeTime(row.createdAt) }}</span>
            <div class="status-note">{{ time(row.createdAt) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="最近使用" width="190">
          <template #default="{ row }">
            <span v-if="row.lastUsedAt" :title="time(row.lastUsedAt)">{{ relativeTime(row.lastUsedAt) }}</span>
            <span v-else class="muted">尚未使用</span>
          </template>
        </el-table-column>
        <el-table-column width="100" align="right">
          <template #default="{ row }">
            <el-button v-if="!row.revoked" link type="danger" @click="revoke(row)">作废</el-button>
          </template>
        </el-table-column>
        <template #empty>还没有生成过个人令牌</template>
      </el-table>
      <TableFooter v-model:current-page="currentPage" v-model:page-size="pageSize" :total="total" unit="个令牌" />
    </div>
  </section>
</template>

<style scoped>
.mcp-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #fff;
  box-shadow: var(--shadow-card);
}
.mcp-pill-label { color: var(--color-text-muted); font-size: 12px; font-weight: 600; }

.create { display: flex; gap: 10px; flex-wrap: wrap; }

.new-token-panel {
  border-color: #A7F3D0;
  box-shadow: 0 0 0 3px #ECFDF5, var(--shadow-card);
}
.token-reveal {
  margin: 14px 0 6px;
  padding: 14px 16px;
  border: 1px solid var(--color-brand-border-strong);
  border-radius: 12px;
  background: var(--color-brand-surface);
}
.token-reveal-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: var(--color-brand-dark);
  font-size: 12px;
  font-weight: 700;
}
.token-reveal-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.token-reveal-row code {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--color-brand-border);
  background: #fff;
  color: var(--color-text-heading);
  font-size: 13px;
  word-break: break-all;
}

.client-tabs { margin-top: 8px; }
.tab-desc { margin: 4px 0 10px; color: var(--color-text-secondary); font-size: 13px; line-height: 1.6; }
.term-copy { color: #CBD5E1 !important; font-size: 12px; }
.term-copy:hover { color: #fff !important; background: rgba(255, 255, 255, 0.08) !important; }
.done-bar { margin-top: 16px; display: flex; justify-content: flex-end; }
.token-name { font-weight: 600; color: var(--color-text-heading); }
.token-name.muted { font-weight: 400; color: var(--color-text-muted); text-decoration: line-through; }
</style>
