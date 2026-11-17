import { defineConfig } from "drizzle-kit";

// 只用来从 src/db/schema.ts 生成迁移文件,不连接数据库
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
