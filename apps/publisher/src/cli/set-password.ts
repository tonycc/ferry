/**
 * 给某人生成初始密码(第一个管理员登录控制台之前,只能用这个办法)。
 *
 *   pnpm set-password <手机号、工号或用户 ID>
 *
 * 连接 .env 里的 DATABASE_URL,按 Ferry 已经读进来的组织架构(数据库里上次同步的)找到这个人;
 * 那里没有时再看 ORG_FILE(刚加进文件、Ferry 还没重新读的人,会提示要等同步或重启 Ferry 才能登录)。
 * 生成一次性初始密码并打印出来;这个人原有的登录会话作废,第一次登录后必须改成自己的密码。记一条审计日志。
 */
import { MemoryDirectory } from "../adapters/directory";
import { FileOrgSource } from "../adapters/org-file-source";
import { AuditLog } from "../audit/log";
import { AuthService } from "../auth/service";
import { loadConfig } from "../config";
import { PostgresAuditStore } from "../db/postgres-audit-store";
import { PostgresAuthStore } from "../db/postgres-auth-store";
import { PostgresOrgStore } from "../db/postgres-org-store";
import { openDatabase } from "../db/postgres-store";
import type { OrgSnapshot } from "../org/snapshot";

const account = process.argv[2]?.trim();
if (!account) {
  console.error("用法:pnpm set-password <手机号、工号或用户 ID>");
  process.exit(1);
}
const config = loadConfig();
if (!config.DATABASE_URL) {
  console.error("没有设置 DATABASE_URL。内存存储时不用这个命令:Ferry 启动时会把管理员的初始密码打印在日志里");
  process.exit(1);
}

const database = await openDatabase(config.DATABASE_URL);
try {
  const find = async (snapshot: OrgSnapshot | undefined) => {
    if (!snapshot) return undefined;
    const directory = new MemoryDirectory();
    directory.replace(snapshot);
    const userId = (await directory.findLogin(account)) ?? (snapshot.users.some((u) => u.id === account) ? account : undefined);
    return userId ? { directory, userId } : undefined;
  };
  // 先看 Ferry 正在用的组织架构:登录时按它找人
  let found = await find(await new PostgresOrgStore(database.db).load());
  if (!found && config.ORG_FILE) {
    found = await find(await new FileOrgSource(config.ORG_FILE).fetch());
    if (found) {
      console.warn(
        `${account} 在组织架构文件里,但 Ferry 还没读进来:密码照样设置,但要等 Ferry 下次读取组织架构` +
          `(最长 ${config.ORG_SYNC_MINUTES} 分钟)或者重启 Ferry 之后才能登录`,
      );
    }
  }
  if (!found) throw new Error(`组织架构里找不到 ${account}(ORG_FILE 和 Ferry 上次同步的数据里都没有)`);
  const { directory, userId } = found;
  const auth = new AuthService(new PostgresAuthStore(database.db), directory, {}, new AuditLog(new PostgresAuditStore(database.db), directory));
  const password = await auth.resetPassword(undefined, userId);
  console.log(`${(await directory.nameOf(userId)) ?? userId}(${userId})的初始密码:${password}`);
  console.log("第一次登录后要改成自己的密码。这个密码只显示这一次。");
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await database.close();
}
