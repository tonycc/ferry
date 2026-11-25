import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/** 本机开发时 Ferry 的地址;接口、登录页都转给它 */
const ferry = process.env.FERRY_URL ?? "http://127.0.0.1:8081";

export default defineConfig({
  // 构建结果由 Ferry 在 /console/ 下提供
  base: "/console/",
  plugins: [vue()],
  build: {
    // Element Plus 整体打包约 280 KB(gzip),内部工具可以接受
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // 两个页面:控制台,和设置向导(Ferry 在 /setup 提供 setup.html;它不用 Element Plus,包很小)
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        setup: fileURLToPath(new URL("setup.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    // 开发服务器的来源要加进 Ferry 的 ALLOWED_ORIGINS(http://localhost:5173),否则修改类请求会被拒绝
    proxy: { "/api": ferry, "/auth": ferry, "/login": ferry },
  },
});
