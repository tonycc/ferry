<script setup lang="ts">
import { CircleCheck, CircleClose, Clock, Moon } from "@element-plus/icons-vue";
import { type Component, markRaw } from "vue";

/**
 * 应用状态统计:在线 / 未上线 / 已下线 / 已停用 四张卡片。
 * 点一张卡片发出 select(再点一次同一张取消),页面用它来筛选列表
 */
export type StatKey = "live" | "pending" | "offline" | "disabled";

defineProps<{ counts: Record<StatKey, number>; selected?: StatKey }>();
const emit = defineEmits<{ select: [key: StatKey | undefined] }>();

const CARDS: { key: StatKey; label: string; icon: Component }[] = [
  { key: "live", label: "在线", icon: markRaw(CircleCheck) },
  { key: "pending", label: "未上线", icon: markRaw(Clock) },
  { key: "offline", label: "已下线", icon: markRaw(Moon) },
  { key: "disabled", label: "已停用", icon: markRaw(CircleClose) },
];
</script>

<template>
  <div class="stat-grid">
    <button
      v-for="card in CARDS"
      :key="card.key"
      type="button"
      class="stat"
      :class="[card.key, { selected: selected === card.key }]"
      :aria-pressed="selected === card.key"
      @click="emit('select', selected === card.key ? undefined : card.key)"
    >
      <span class="chip"><component :is="card.icon" /></span>
      <span class="body">
        <span class="label">{{ card.label }}</span>
        <span class="num">{{ counts[card.key] }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
.stat {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  overflow: hidden;
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-bg-base);
  box-shadow: var(--shadow-card);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.stat:hover { border-color: var(--color-border-strong); }
.stat:focus-visible { outline: 2px solid var(--color-brand); outline-offset: 2px; }
.stat.selected { border-color: var(--tone); box-shadow: 0 0 0 3px var(--tone-soft); }
/* 右上角一团淡色光晕 */
.stat::after {
  content: "";
  position: absolute;
  top: -28px;
  right: -28px;
  width: 90px;
  height: 90px;
  border-radius: 50%;
  background: radial-gradient(var(--tone-soft), transparent 70%);
  pointer-events: none;
}
.chip {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--tone-soft);
  color: var(--tone);
}
.chip svg { width: 18px; height: 18px; }
.body { display: grid; gap: 2px; }
.label { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.num {
  color: var(--color-text-heading);
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}
.live { --tone: #16A34A; --tone-soft: #DCFCE7; }
.pending { --tone: #D97706; --tone-soft: #FEF3C7; }
.offline { --tone: #64748B; --tone-soft: #F1F5F9; }
.disabled { --tone: #DC2626; --tone-soft: #FEE2E2; }
</style>
