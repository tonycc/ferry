import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

// 依次执行 migrations/ 下还没执行过的 .sql 文件。可以重复运行。
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("create table if not exists _migrations (name text primary key, applied_at timestamptz default now())");
  const applied = new Set((await client.query("select name from _migrations")).rows.map((row) => row.name));
  const files = (await readdir("migrations")).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(`migrations/${file}`, "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into _migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  }
} finally {
  await client.end();
}
