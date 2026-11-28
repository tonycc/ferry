<script setup lang="ts">
import { ArrowRight, CopyDocument, Grid, Key, List, Refresh, Search, TopRight } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api, type AppView } from "../api";
import { copyText } from "../clipboard";
import AppAvatar from "../components/AppAvatar.vue";
import StatCards, { type StatKey } from "../components/StatCards.vue";
import StatusTag from "../components/StatusTag.vue";
import TableFooter from "../components/TableFooter.vue";
import VisibilityChip from "../components/VisibilityChip.vue";
import { useLocalPagination } from "../composables/useLocalPagination";
import { appStatKey, appStatus } from "../labels";

const router = useRouter();
const apps = ref<AppView[]>([]);
const loading = ref(true);
const refreshing = ref(false);
/** 点统计卡片只看这一种状态的应用,再点一次取消 */
const stat = ref<StatKey>();
const keyword = ref("");
const viewMode = ref<"cards" | "table">((localStorage.getItem("ferry:apps-view") as "cards" | "table") || "cards");

function setViewMode(mode: "cards" | "table") {
  viewMode.value = mode;
  localStorage.setItem("ferry:apps-view", mode);
}

const counts = computed(() => {
  const result: Record<StatKey, number> = { live: 0, pending: 0, offline: 0, disabled: 0 };
  for (const app of apps.value) result[appStatKey(app)]++;
  return result;
});

const STAT_LABEL: Record<StatKey, string> = {
  live: "在线运行的应用",
  pending: "未上线的应用",
  offline: "已下线的应用",
  disabled: "已停用的应用",
};

const sorted = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  return apps.value
    .filter((a) => !stat.value || appStatKey(a) === stat.value)
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.url.toLowerCase().includes(q))
    .sort((a, b) => appStatus(a)[2] - appStatus(b)[2] || a.name.localeCompare(b.name));
});

const filtering = computed(() => !!stat.value || !!keyword.value.trim());
const { currentPage, pageSize, total, pagedItems } = useLocalPagination(sorted, [stat, keyword], 12);

const reachable = (app: AppView) => app.live && !app.disabled && !app.unpublished;

const EXAMPLE_PROMPTS = [
  "用 Ferry 的模板帮我做一个部门周报汇总小工具，支持提交和按周查看，完成后发布给本部门同事用。",
  "帮我做一个活动报名与签到登记页面，支持导出表格，用 Ferry 发布到公司内网。",
];

async function load(isRefresh = false) {
  if (isRefresh) refreshing.value = true;
  else loading.value = true;
  try {
    apps.value = await api.get<AppView[]>("/api/apps");
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <section class="ops-page">
    <StatCards v-if="apps.length > 0" :counts="counts" :selected="stat" @select="(k) => (stat = k)" />

    <!-- 新手零应用极速上手引导 -->
    <div v-if="!loading && apps.length === 0" class="content-panel onboarding">
      <div class="onboarding-hero">
        <span class="onboarding-pill">3 分钟上手</span>
        <h2>把你用 AI 做的小工具，一键“渡”给同事使用</h2>
        <p>无需懂服务器、数据库、域名或证书。在你的 AI Agent 里对话完成开发，说一句“发布”，Ferry 会自动搞定构建、建库、域名与登录鉴权。</p>
        <div class="onboarding-cta">
          <el-button type="primary" size="large" @click="router.push('/tokens')">
            第一步：生成个人令牌 <el-icon class="el-icon--right"><ArrowRight /></el-icon>
          </el-button>
        </div>
      </div>

      <div class="step-grid">
        <div class="step-card">
          <span class="step-num">01</span>
          <h3>领取个人令牌</h3>
          <p>在“个人令牌”页生成你的专属令牌，用来向 Ferry 确认发布者身份。</p>
        </div>
        <div class="step-card">
          <span class="step-num">02</span>
          <h3>接入常用 Agent</h3>
          <p>复制一条命令，即可接入 Claude Code、Antigravity、Codex 或其他支持 MCP 的客户端。</p>
        </div>
        <div class="step-card">
          <span class="step-num">03</span>
          <h3>对话创建并发布</h3>
          <p>向 Agent 描述你想做的内部应用，确认发布后几分钟内就能拿到可直接分享的内网地址。</p>
        </div>
      </div>

      <div class="prompt-box">
        <div class="prompt-title">试试这样对 Agent 说（点击复制）</div>
        <div class="prompt-list">
          <button
            v-for="prompt in EXAMPLE_PROMPTS"
            :key="prompt"
            type="button"
            class="prompt-item"
            @click="copyText(prompt, '已复制示例提示词')"
          >
            <span>“{{ prompt }}”</span>
            <el-icon><CopyDocument /></el-icon>
          </button>
        </div>
      </div>
    </div>

    <!-- 应用列表面板 -->
    <div v-else class="content-panel" v-loading="loading">
      <div class="panel-toolbar">
        <div class="filter-bar">
          <div class="panel-title">{{ stat ? STAT_LABEL[stat] : "全部应用" }}</div>
          <el-button v-if="stat" link type="primary" @click="stat = undefined">查看全部</el-button>
        </div>
        <div class="filter-bar">
          <el-input
            v-model="keyword"
            clearable
            :prefix-icon="Search"
            placeholder="搜索应用名或访问地址"
            style="width: 240px"
          />
          <div class="view-switch" role="group" aria-label="切换视图">
            <button type="button" :class="{ active: viewMode === 'cards' }" title="卡片视图" @click="setViewMode('cards')">
              <el-icon><Grid /></el-icon>
            </button>
            <button type="button" :class="{ active: viewMode === 'table' }" title="表格视图" @click="setViewMode('table')">
              <el-icon><List /></el-icon>
            </button>
          </div>
          <el-button :icon="Refresh" :loading="refreshing" @click="load(true)">刷新</el-button>
          <el-button type="primary" :icon="Key" @click="router.push('/tokens')">配置 Agent 令牌</el-button>
        </div>
      </div>

      <!-- 卡片视图 -->
      <template v-if="viewMode === 'cards'">
        <div v-if="pagedItems.length > 0" class="app-grid">
          <article
            v-for="row in pagedItems"
            :key="row.name"
            class="app-card"
            :class="{ muted: !reachable(row) }"
            @click="router.push(`/apps/${row.name}`)"
          >
            <div class="app-card-top">
              <div class="app-cell">
                <AppAvatar :name="row.name" :size="38" :muted="!reachable(row)" />
                <div class="stack-cell">
                  <router-link class="app-cell-name" :to="`/apps/${row.name}`" @click.stop>{{ row.name }}</router-link>
                  <StatusTag :type="appStatus(row)[1]" :pulse="reachable(row)">{{ appStatus(row)[0] }}</StatusTag>
                </div>
              </div>
              <VisibilityChip :value="row.visibility" />
            </div>

            <div class="app-card-url" @click.stop>
              <a v-if="reachable(row)" class="url-link" :href="row.url" target="_blank" rel="noopener">
                {{ row.url }}<el-icon><TopRight /></el-icon>
              </a>
              <span v-else class="url-link muted">{{ row.url }}</span>
              <button
                type="button"
                class="copy-icon-btn"
                title="复制访问地址"
                @click="copyText(row.url, '已复制应用访问地址')"
              >
                <el-icon><CopyDocument /></el-icon>
              </button>
            </div>

            <p v-if="row.disabled && row.disabledReason" class="app-card-reason">停用原因：{{ row.disabledReason }}</p>

            <div class="app-card-footer" @click.stop>
              <router-link :to="`/apps/${row.name}`" class="card-action">
                管理详情 <el-icon><ArrowRight /></el-icon>
              </router-link>
              <el-button
                v-if="reachable(row)"
                tag="a"
                :href="row.url"
                target="_blank"
                rel="noopener"
                size="small"
                type="primary"
                plain
              >
                打开应用
              </el-button>
            </div>
          </article>
        </div>
        <div v-else-if="!loading" class="empty">
          <p class="empty-title">没有符合条件的应用</p>
          <p class="muted">可以清空搜索关键词或取消状态筛选查看全部应用。</p>
          <el-button v-if="filtering" link type="primary" @click="stat = undefined; keyword = ''">重置筛选</el-button>
        </div>
      </template>

      <!-- 表格视图 -->
      <el-table
        v-else
        class="data-table"
        :data="pagedItems"
        row-class-name="clickable"
        @row-click="(row: AppView) => router.push(`/apps/${row.name}`)"
      >
        <el-table-column label="应用" min-width="200">
          <template #default="{ row }">
            <div class="app-cell">
              <AppAvatar :name="row.name" :muted="!reachable(row)" />
              <div class="stack-cell">
                <router-link class="app-cell-name" :to="`/apps/${row.name}`" @click.stop>{{ row.name }}</router-link>
                <span v-if="row.disabled && row.disabledReason" class="status-note">停用：{{ row.disabledReason }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="访问地址" min-width="280">
          <template #default="{ row }">
            <div class="url-row" @click.stop>
              <a v-if="reachable(row)" class="url-link" :href="row.url" target="_blank" rel="noopener">
                {{ row.url }}<el-icon><TopRight /></el-icon>
              </a>
              <span v-else class="url-link muted">{{ row.url }}</span>
              <button
                type="button"
                class="copy-icon-btn"
                title="复制访问地址"
                @click="copyText(row.url, '已复制应用访问地址')"
              >
                <el-icon><CopyDocument /></el-icon>
              </button>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="谁能看" width="120">
          <template #default="{ row }"><VisibilityChip :value="row.visibility" /></template>
        </el-table-column>
        <el-table-column label="状态" width="115">
          <template #default="{ row }">
            <StatusTag :type="appStatus(row)[1]" :pulse="reachable(row)">{{ appStatus(row)[0] }}</StatusTag>
          </template>
        </el-table-column>
        <el-table-column width="100" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="router.push(`/apps/${row.name}`)">管理</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div v-if="!loading" class="empty">
            <p class="empty-title">没有符合条件的应用</p>
            <el-button v-if="filtering" link type="primary" @click="stat = undefined; keyword = ''">重置筛选</el-button>
          </div>
        </template>
      </el-table>

      <TableFooter
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[12, 24, 48]"
        unit="个应用"
        :summary="filtering ? `筛选出 ${total} 个，共 ${apps.length} 个应用` : undefined"
      />
    </div>
  </section>
</template>

<style scoped>
:deep(.clickable) { cursor: pointer; }

.view-switch {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-page);
}
.view-switch button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.view-switch button.active {
  background: #fff;
  color: var(--color-brand);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}

/* ---- 卡片网格 ---- */
.app-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
@media (max-width: 1120px) { .app-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 680px) { .app-grid { grid-template-columns: 1fr; } }

.app-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: #fff;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
.app-card:hover {
  transform: translateY(-2px);
  border-color: var(--color-brand-border);
  box-shadow: var(--shadow-card-hover);
}
.app-card.muted { background: #FAFBFC; }
.app-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.app-card-url {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 9px;
  background: var(--color-bg-page);
  border: 1px solid #EEF2F6;
  font-size: 12px;
}
.app-card-reason {
  margin: -4px 0 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: #FEF2F2;
  color: #B91C1C;
  font-size: 12px;
  line-height: 1.5;
}
.app-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid #F1F5F9;
}
.card-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.card-action:hover { color: var(--color-brand); text-decoration: none; }

/* ---- 新手引导 ---- */
.onboarding {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 28px;
  background:
    radial-gradient(500px 260px at 100% 0%, rgba(96, 165, 250, 0.08), transparent 65%),
    radial-gradient(460px 240px at 0% 0%, rgba(59, 130, 246, 0.06), transparent 65%),
    #fff;
}
.onboarding-hero { max-width: 640px; }
.onboarding-pill {
  display: inline-block;
  margin-bottom: 10px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: 12px;
  font-weight: 700;
}
.onboarding-hero h2 {
  margin: 0 0 8px;
  color: var(--color-text-heading);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.onboarding-hero p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1.7;
}
.onboarding-cta { margin-top: 18px; }

.step-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
@media (max-width: 800px) { .step-grid { grid-template-columns: 1fr; } }
.step-card {
  padding: 16px 18px;
  border: 1px solid #E2E8F0;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.85);
}
.step-num {
  display: inline-block;
  margin-bottom: 8px;
  padding: 2px 8px;
  border-radius: 7px;
  background: var(--gradient-brand);
  color: #fff;
  font-family: "SF Mono", Menlo, monospace;
  font-size: 11px;
  font-weight: 700;
}
.step-card h3 { margin: 0 0 6px; color: var(--color-text-heading); font-size: 14px; font-weight: 700; }
.step-card p { margin: 0; color: var(--color-text-secondary); font-size: 13px; line-height: 1.6; }

.prompt-box {
  padding: 16px 18px;
  border: 1px dashed var(--color-brand-border-strong);
  border-radius: 14px;
  background: var(--color-brand-surface);
}
.prompt-title { margin-bottom: 10px; color: var(--color-text-heading); font-size: 13px; font-weight: 600; }
.prompt-list { display: grid; gap: 8px; }
.prompt-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--color-brand-border);
  border-radius: 10px;
  background: #fff;
  color: var(--color-text-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.prompt-item:hover { border-color: var(--color-brand); background: var(--color-brand-soft); color: var(--color-brand-dark); }

.empty { padding: 36px 0; text-align: center; line-height: 1.6; }
.empty p { margin: 4px 0; }
.empty-title { color: var(--color-text-heading); font-size: var(--font-size-title); font-weight: 600; }
</style>
