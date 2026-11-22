import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { OrgSnapshot, OrgSource } from "../org/snapshot";

const fileSchema = z.object({
  departments: z.array(
    z.object({ id: z.string().min(1), parentId: z.string().min(1).nullable(), name: z.string().min(1) }),
  ),
  users: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      active: z.boolean().default(true),
      departmentIds: z.array(z.string().min(1)).default([]),
      jobNumber: z.string().min(1).optional(),
      mobile: z.string().min(1).optional(),
    }),
  ),
});

/**
 * 从 JSON 文件读组织架构,本地开发用,格式见 infra/dev-org.json。
 * 以后接入企业通讯录时,换成从通讯录取数的数据源,接口相同。
 */
export class FileOrgSource implements OrgSource {
  constructor(private readonly path: string) {}

  async fetch(): Promise<OrgSnapshot> {
    const text = await readFile(this.path, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // 不把解析错误原样抛出:它可能带着文件里的一段内容(人名)进日志
      throw new Error("组织架构文件不是合法的 JSON");
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) throw new Error(`组织架构文件格式不对: ${parsed.error.issues[0]?.message ?? ""}`);
    return parsed.data;
  }
}
