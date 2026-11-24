<script setup lang="ts">
import { computed } from "vue";
import type { TagType } from "../labels";

/** 带圆点的状态标签;type 沿用 labels.ts 里 Element Plus 的标签类型,换成对应的配色 */
const props = defineProps<{ type?: TagType; plain?: boolean }>();

const TONE: Record<TagType, string> = {
  success: "success",
  primary: "processing",
  warning: "pending",
  danger: "failed",
  info: "closed",
};

const cls = computed(() => ["status-tag", TONE[props.type ?? "info"], { plain: props.plain }]);
</script>

<template>
  <span :class="cls"><slot /></span>
</template>
