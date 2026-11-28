<script setup lang="ts">
import type { Visibility } from "../api";
import { VISIBILITY, VISIBILITY_HINT } from "../labels";

/** “谁能看”:带图标与语义配色的胶囊。仅自己是锁,本部门是两个人,全公司是地球 */
defineProps<{ value: Visibility }>();
</script>

<template>
  <span class="vis-chip" :class="value" :title="VISIBILITY_HINT[value]">
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <template v-if="value === 'self'">
        <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </template>
      <template v-else-if="value === 'department'">
        <circle cx="9" cy="9" r="3.5" /><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5" />
        <circle cx="17" cy="8" r="2.5" /><path d="M17 13.5c2.5 0 4.5 1.5 4.5 4" />
      </template>
      <template v-else>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a11 11 0 0 1 0 18M12 3a11 11 0 0 0 0 18" />
      </template>
    </svg>
    {{ VISIBILITY[value] }}
  </span>
</template>

<style scoped>
svg { flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
</style>
