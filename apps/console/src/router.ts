import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory("/console/"),
  routes: [
    { path: "/", redirect: "/apps" },
    { path: "/apps", component: () => import("./views/AppList.vue"), meta: { title: "我的应用" } },
    { path: "/apps/:name", component: () => import("./views/AppDetail.vue"), props: true, meta: { title: "应用详情" } },
    { path: "/tokens", component: () => import("./views/Tokens.vue"), meta: { title: "个人令牌" } },
    { path: "/admin", component: () => import("./views/Admin.vue"), meta: { title: "管理全部应用" } },
    { path: "/:rest(.*)*", redirect: "/apps" },
  ],
});

router.afterEach((to) => {
  document.title = `${(to.meta.title as string | undefined) ?? "控制台"} - Ferry`;
});
