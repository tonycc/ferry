<script setup lang="ts">
import { computed } from "vue";
import type { CheckItem } from "./api";
import Icon from "./Icon.vue";

/** 一组检查结果:标题、逐项的对错、一句话怎么改 */
const props = defineProps<{ title: string; items?: CheckItem[]; kind?: "ok" | "bad" | "warn" }>();
const kind = computed(() => props.kind ?? (props.items?.some((i) => i.state === "bad") ? "bad" : props.items?.some((i) => i.state === "warn") ? "warn" : "ok"));
const icon = (state: string) => (state === "ok" ? "check" : state === "bad" ? "x" : "alert");
</script>

<template>
  <div class="result" :class="kind">
    <div class="title"><Icon :name="icon(kind)" />{{ title }}</div>
    <ul v-if="items?.length" class="checks">
      <li v-for="item in items" :key="item.key + item.message" :class="item.state">
        <Icon :name="icon(item.state)" /><span>{{ item.message }}</span>
      </li>
    </ul>
    <div v-if="$slots.default" class="fix"><slot /></div>
  </div>
</template>
