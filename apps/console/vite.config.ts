import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发时把 /api 转发给本机的 publisher
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
});
