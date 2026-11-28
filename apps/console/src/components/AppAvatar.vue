<script setup lang="ts">
import { computed } from "vue";

/** 应用名的首字母头像;颜色按名字固定挑一组渐变,同一个应用每次颜色一样 */
const props = withDefaults(defineProps<{ name: string; size?: number; muted?: boolean }>(), { size: 34 });

const PALETTE: [string, string][] = [
  ["#3B82F6", "#60A5FA"],
  ["#0EA5E9", "#38BDF8"],
  ["#14B8A6", "#2DD4BF"],
  ["#10B981", "#34D399"],
  ["#6366F1", "#818CF8"],
  ["#F59E0B", "#FBBF24"],
  ["#F97316", "#FB923C"],
  ["#0284C7", "#38BDF8"],
];

const style = computed(() => {
  let hash = 0;
  for (const ch of props.name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  const [from, to] = props.muted ? ["#94A3B8", "#CBD5E1"] : PALETTE[hash % PALETTE.length]!;
  return {
    width: `${props.size}px`,
    height: `${props.size}px`,
    borderRadius: `${Math.round(props.size * 0.29)}px`,
    fontSize: `${Math.round(props.size * 0.4)}px`,
    background: `linear-gradient(135deg, ${from}, ${to})`,
  };
});
const letter = computed(() => (Array.from(props.name)[0] ?? "?").toUpperCase());
</script>

<template>
  <span class="app-avatar" :style="style" aria-hidden="true">{{ letter }}</span>
</template>

<style scoped>
.app-avatar {
  display: inline-grid;
  flex-shrink: 0;
  place-items: center;
  color: #fff;
  font-weight: 700;
  line-height: 1;
}
</style>
