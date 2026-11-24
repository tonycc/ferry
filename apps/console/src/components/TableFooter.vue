<script setup lang="ts">
/**
 * 表格底部:左边总数,右边分页。配合 useLocalPagination 使用;没有数据时不显示。
 * summary 替换左边默认的“共 N 条”(如筛选时写成“筛选出 3 个,共 12 个应用”)
 */
withDefaults(defineProps<{ total: number; unit?: string; summary?: string; pageSizes?: number[] }>(), {
  unit: "条",
  pageSizes: () => [10, 20, 50, 100],
});
const currentPage = defineModel<number>("currentPage", { required: true });
const pageSize = defineModel<number>("pageSize", { required: true });
</script>

<template>
  <div v-if="total > 0" class="table-footer">
    <span class="footer-total">{{ summary ?? `共 ${total} ${unit}` }}</span>
    <el-pagination
      v-model:current-page="currentPage"
      v-model:page-size="pageSize"
      :page-sizes="pageSizes"
      :total="total"
      :pager-count="5"
      :hide-on-single-page="total <= pageSizes[0]!"
      background
      layout="sizes, prev, pager, next"
      size="small"
    />
  </div>
</template>
