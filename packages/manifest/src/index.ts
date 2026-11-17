import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** 应用可见范围:仅自己 / 本部门 / 全公司 */
export const visibilitySchema = z.enum(["self", "department", "company"]);
export type Visibility = z.infer<typeof visibilitySchema>;

/**
 * app.yaml 的结构。agent 在代码根目录生成它,Publisher 只依据它来部署。
 */
export const manifestSchema = z.object({
  /** 决定域名 <name>.<APPS_DOMAIN>,所以只允许小写字母、数字和连字符 */
  name: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, "只能包含小写字母、数字和连字符,且以字母开头"),
  template: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(3000),
  healthcheck: z.string().startsWith("/").default("/healthz"),
  database: z.enum(["none", "postgres"]).default("none"),
  /** 数据库迁移命令;database 为 none 时忽略 */
  migrate: z.string().min(1).optional(),
  visibility: visibilitySchema.default("self"),
});

export type Manifest = z.infer<typeof manifestSchema>;

export type ParseResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: string[] };

/** 解析并校验 app.yaml 文本,错误信息写成 agent 能直接据此修复的形式 */
export function parseManifest(yamlText: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return { ok: false, errors: [`app.yaml 不是合法的 YAML: ${(err as Error).message}`] };
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(
        (issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, manifest: result.data };
}
