<script setup lang="ts">
import { CircleCheck, CircleClose, Clock, Moon } from "@element-plus/icons-vue";
import { type Component, computed, markRaw } from "vue";

/**
 * 应用状态统计:在线 / 未上线 / 已下线 / 已停用 四张卡片。
 * 点一张卡片发出 select(再点一次同一张取消),页面用它来筛选列表
 */
export type StatKey = "live" | "pending" | "offline" | "disabled";

const props = defineProps<{ counts: Record<StatKey, number>; selected?: StatKey }>();
const emit = defineEmits<{ select: [key: StatKey | undefined] }>();

const CARDS: { key: StatKey; label: string; desc: string; icon: Component }[] = [
  { key: "live", label: "在线运行", desc: "可正常访问", icon: markRaw(CircleCheck) },
  { key: "pending", label: "未上线", desc: "待首次发布", icon: markRaw(Clock) },
  { key: "offline", label: "已下线", desc: "数据已保留", icon: markRaw(Moon) },
  { key: "disabled", label: "已停用", desc: "管理员管控", icon: markRaw(CircleClose) },
];

const total = computed(() => props.counts.live + props.counts.pending + props.counts.offline + props.counts.disabled);
function percent(key: StatKey): number {
  if (total.value === 0) return 0;
  return Math.round((props.counts[key] / total.value) * 100);
}
</script>

<template>
  <div class="stat-grid">
    <button
      v-for="card in CARDS"
      :key="card.key"
      type="button"
      class="stat"
      :class="[card.key, { selected: selected === card.key, zero: counts[card.key] === 0 }]"
      :aria-pressed="selected === card.key"
      @click="emit('select', selected === card.key ? undefined : card.key)"
    >
      <span class="chip"><component :is="card.icon" /></span>
      <span class="body">
        <span class="label-row">
          <span class="label">{{ card.label }}</span>
          <span v-if="total > 0 && counts[card.key] > 0" class="pct">{{ percent(card.key) }}%</span>
        </span>
        <span class="num-row">
          <span class="num">{{ counts[card.key] }}</span>
          <span class="desc">{{ selected === card.key ? "已筛选 · 点击取消" : card.desc }}</span>
        </span>
      </span>
      <span class="bar"><span class="bar-fill" :style="{ width: `${percent(card.key)}%` }" /></span>
    </button>
  </div>
</template>

<style scoped>
.stat {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  overflow: hidden;
  padding: 15px 16px 18px;
  border: 1px solid rgba(226, 232, 240, 0.92);
  border-radius: var(--radius-card);
  background: var(--color-bg-base);
  box-shadow: var(--shadow-card);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
.stat:hover {
  transform: translateY(-2px);
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-card-hover);
}
.stat:focus-visible { outline: 2px solid var(--color-brand); outline-offset: 2px; }
.stat.selected {
  border-color: var(--tone);
  box-shadow: 0 0 0 3px var(--tone-soft), var(--shadow-card-hover);
}
.stat.zero:not(.selected) .num { color: var(--color-text-muted); }
/* 右上角一团淡色光晕 */
.stat::after {
  content: "";
  position: absolute;
  top: -32px;
  right: -32px;
  width: 100px;
  height: 100px;
  border-radius: 50%;
  background: radial-gradient(var(--tone-soft), transparent 70%);
  pointer-events: none;
}
.chip {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--tone-soft);
  color: var(--tone);
}
.chip svg { width: 20px; height: 20px; }
.body {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 3px;
}
.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-caption);
  font-weight: 500;
}
.pct {
  color: var(--tone);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.num-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.num {
  color: var(--color-text-heading);
  font-size: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.desc {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2.5px;
  background: var(--color-bg-subtle);
}
.bar-fill {
  display: block;
  height: 100%;
  background: var(--tone);
  opacity: 0.55;
  transition: width 0.35s ease;
}
.stat.selected .bar-fill { opacity: 0.9; }
.live { --tone: #10B981; --tone-soft: #ECFDF5; }
.pending { --tone: #F59E0B; --tone-soft: #FFFBEB; }
.offline { --tone: #64748B; --tone-soft: #F2F6FA; }
.disabled { --tone: #EF4444; --tone-soft: #FEF2F2; }
</style>
