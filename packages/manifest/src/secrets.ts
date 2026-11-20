/**
 * 应用密钥名称的规则,发布服务和控制台共用(控制台按 @ferry/manifest/secrets 引用,不带 zod 和 yaml)。
 */

/** Ferry 自己注入的环境变量,不能用作应用密钥的名称 */
export const RESERVED_ENV_NAMES: readonly string[] = ["DATABASE_URL", "PORT"];
/** 留给 Ferry 以后用的名称前缀 */
export const RESERVED_ENV_PREFIX = "FERRY_";
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** 名称有问题时返回原因,没问题返回 undefined */
export function secretNameProblem(name: string): string | undefined {
  if (!SECRET_NAME_PATTERN.test(name)) {
    return "名称只能用大写字母、数字和下划线,以字母开头,最长 64 个字符,如 LLM_API_KEY";
  }
  if (RESERVED_ENV_NAMES.includes(name) || name.startsWith(RESERVED_ENV_PREFIX)) {
    return `${name} 由 Ferry 自己设置,不能用作密钥名称(${RESERVED_ENV_PREFIX} 开头的名称也留给 Ferry)`;
  }
  return undefined;
}
