import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory("/console/"),
  routes: [
    { path: "/", redirect: "/apps" },
    { path: "/apps", component: () => import("./views/AppList.vue"), meta: { title: "我的应用" } },
    { path: "/apps/:name", component: () => import("./views/AppDetail.vue"), props: true, meta: { title: "应用详情", back: { label: "我的应用", to: "/apps" } } },
    { path: "/tokens", component: () => import("./views/Tokens.vue"), meta: { title: "个人令牌" } },
    { path: "/admin", component: () => import("./views/Admin.vue"), meta: { title: "管理全部应用" } },
    { path: "/audit", component: () => import("./views/Audit.vue"), meta: { title: "审计日志" } },
    { path: "/certificate", component: () => import("./views/Certificate.vue"), meta: { title: "证书" } },
    { path: "/users", component: () => import("./views/Users.vue"), meta: { title: "人员" } },
    { path: "/departments", component: () => import("./views/Departments.vue"), meta: { title: "部门" } },
    { path: "/:rest(.*)*", redirect: "/apps" },
  ],
});

router.afterEach((to) => {
  document.title = `${(to.meta.title as string | undefined) ?? "控制台"} - Ferry`;
});
