import postgres from "postgres";
import { sql } from "drizzle-orm";
import { openDatabase, PostgresStore, type Database } from "../db/postgres-store";
import { MemoryStore, type Store } from "../workflow/store";

/**
 * 让同一组测试分别跑在内存存储和 PostgreSQL 存储上。
 *
 * 设置了 TEST_DATABASE_URL 才会跑 PostgreSQL(例如本地开发库
 * postgres://ferry:ferry-dev@127.0.0.1:55432/ferry)。每个测试文件用自己的一个数据库,
 * 各文件并行执行也不会互相干扰;每个测试开始前清空所有表。
 */
export interface StoreCase {
  name: string;
  /** 在 beforeAll 里调用 */
  init(): Promise<void>;
  /** 在 beforeEach 里调用:清空数据 */
  reset(): Promise<void>;
  /** 返回一个指向当前数据的存储 */
  create(): Store;
  /** 在 afterAll 里调用 */
  close(): Promise<void>;
}

export function storeCases(testDbName: string): StoreCase[] {
  const cases: StoreCase[] = [
    { name: "内存", init: async () => {}, reset: async () => {}, create: () => new MemoryStore(), close: async () => {} },
  ];
  const url = process.env.TEST_DATABASE_URL;
  if (url) cases.push(postgresCase(url, testDbName));
  return cases;
}

function postgresCase(adminUrl: string, dbName: string): StoreCase {
  let database: Database | undefined;
  return {
    name: "PostgreSQL",
    async init() {
      const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
      await admin.end();
      const testUrl = new URL(adminUrl);
      testUrl.pathname = `/${dbName}`;
      database = await openDatabase(testUrl.toString());
    },
    async reset() {
      await requireDb().db.execute(sql`TRUNCATE uploads, releases, apps RESTART IDENTITY CASCADE`);
    },
    create: () => new PostgresStore(requireDb().db),
    async close() {
      await database?.close();
    },
  };

  function requireDb(): Database {
    if (!database) throw new Error("测试数据库还没有初始化");
    return database;
  }
}
