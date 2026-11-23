/**
 * 给某人生成初始密码;组织架构里还没有这个人时,可以顺便建成平台管理员(第一个管理员只能这样建)。
 *
 *   pnpm set-password <手机号、工号或用户 ID>
 *   pnpm set-password <手机号> --name <姓名> [--org <公司名>]
 *
 * 连接 .env 里的 DATABASE_URL。带 --name 时:这个手机号已经是在职的人,就把他设为管理员;
 * 否则新建这个人(组织架构是空的时候先建最上级部门,名称用 --org,默认“公司”)并设为管理员。
 * 运行中的 Ferry 每分钟从数据库重读一次组织架构,新建的人最多一分钟后就能登录。
 * 生成一次性初始密码并打印出来;这个人原有的登录会话作废,第一次登录后必须改成自己的密码。记审计日志。
 */
import { parseArgs } from "node:util";
import { MemoryDirectory } from "../adapters/directory";
import { AuditLog } from "../audit/log";
import { AuthService } from "../auth/service";
import { loadConfig } from "../config";
import { PostgresAuditStore } from "../db/postgres-audit-store";
import { PostgresAuthStore } from "../db/postgres-auth-store";
import { PostgresOrgStore } from "../db/postgres-org-store";
import { openDatabase } from "../db/postgres-store";
import { Organization } from "../org/service";

const USAGE = "用法:pnpm set-password <手机号、工号或用户 ID>\n      pnpm set-password <手机号> --name <姓名> [--org <公司名>](建管理员)";
let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { name: { type: "string" }, org: { type: "string" } } });
} catch {
  console.error(USAGE);
  process.exit(1);
}
const account = parsed.positionals[0]?.trim();
if (!account || parsed.positionals.length > 1) {
  console.error(USAGE);
  process.exit(1);
}
const config = loadConfig();
if (!config.DATABASE_URL) {
  console.error("没有设置 DATABASE_URL。内存存储时不用这个命令:Ferry 启动时会建一个管理员,初始密码打印在日志里");
  process.exit(1);
}

const database = await openDatabase(config.DATABASE_URL);
try {
  const orgStore = new PostgresOrgStore(database.db);
  const directory = new MemoryDirectory();
  const audit = new AuditLog(new PostgresAuditStore(database.db), directory);
  const fixedAdmins = new Set(config.ADMIN_USERS.split(",").map((id) => id.trim()).filter(Boolean));
  const organization = new Organization(orgStore, directory, audit, { fixedAdmins });
  await organization.reload();

  let userId: string | undefined;
  if (parsed.values.name !== undefined) {
    const result = await organization.bootstrapAdmin({ name: parsed.values.name, mobile: account, orgName: parsed.values.org });
    userId = result.userId;
    console.log(result.created ? "已新建并设为平台管理员。" : "这个手机号已经是在职的人,已设为平台管理员。");
    if (result.created) console.log("运行中的 Ferry 最多一分钟后读到新建的人,之后就能登录。");
  } else {
    const view = await organization.view();
    userId = (await directory.findLogin(account)) ?? view.users.find((u) => u.id === account && u.active)?.id;
    if (!userId) {
      throw new Error(
        `组织架构里找不到在职的 ${account}。要建第一个管理员:pnpm set-password <手机号> --name <姓名>;其他人请管理员在控制台“人员”页添加`,
      );
    }
  }
  const auth = new AuthService(new PostgresAuthStore(database.db), directory, {}, audit);
  const password = await auth.resetPassword(undefined, userId);
  console.log(`${(await directory.nameOf(userId)) ?? userId}(${userId})的初始密码:${password}`);
  console.log("第一次登录后要改成自己的密码。这个密码只显示这一次。");
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await database.close();
}
