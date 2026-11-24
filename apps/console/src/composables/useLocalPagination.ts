import { computed, ref, watch, type ComputedRef, type Ref, type WatchSource } from "vue";

type CollectionRef<T> = Ref<readonly T[]> | ComputedRef<readonly T[]>;

/**
 * 前端分页(做法和 wangjia-sh admin-web 一致):接口一次返回全部数据,页面只显示当前这一页。
 * resetSources 变了(换筛选条件)回到第一页;数据变少、当前页没内容了,退到最后一页
 */
export function useLocalPagination<T>(items: CollectionRef<T>, resetSources: WatchSource[] = [], initialPageSize = 20) {
  const currentPage = ref(1);
  const pageSize = ref(initialPageSize);
  const total = computed(() => items.value.length);
  const pagedItems = computed(() => {
    const start = (currentPage.value - 1) * pageSize.value;
    return items.value.slice(start, start + pageSize.value);
  });

  watch(pageSize, () => {
    currentPage.value = 1;
  });
  for (const source of resetSources) {
    watch(source, () => {
      currentPage.value = 1;
    });
  }
  watch(total, (next) => {
    const maxPage = Math.max(1, Math.ceil(next / pageSize.value));
    if (currentPage.value > maxPage) currentPage.value = maxPage;
  });

  return { currentPage, pageSize, total, pagedItems };
}
