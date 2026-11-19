import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/** 本机开发时 Ferry 的地址;接口、登录页都转给它 */
const ferry = process.env.FERRY_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  // 构建结果由 Ferry 在 /console/ 下提供
  base: "/console/",
  plugins: [vue()],
  // Element Plus 整体打包约 280 KB(gzip),内部工具可以接受
  build: { chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    // 开发服务器的来源要加进 Ferry 的 ALLOWED_ORIGINS(http://localhost:5173),否则修改类请求会被拒绝
    proxy: { "/api": ferry, "/auth": ferry, "/login": ferry },
  },
});
