<script setup lang="ts">
/** Ferry 的标志:渐变圆角方块里一艘渡船。size 是方块边长(px) */
withDefaults(defineProps<{ size?: number }>(), { size: 34 });
</script>

<template>
  <span class="ferry-logo" :style="{ width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size * 0.3)}px` }">
    <svg viewBox="0 0 24 24" :width="Math.round(size * 0.58)" :height="Math.round(size * 0.58)" aria-hidden="true">
      <path d="M3 17c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0" />
      <path d="M5 13l1-5h12l1 5" />
      <path d="M9 8V5h6v3" />
      <path d="M4 13h16" />
    </svg>
  </span>
</template>

<style scoped>
.ferry-logo {
  display: inline-grid;
  flex-shrink: 0;
  place-items: center;
  background: var(--gradient-brand);
  box-shadow: 0 5px 12px -5px rgba(59, 130, 246, 0.52);
  color: #fff;
}
svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
</style>
