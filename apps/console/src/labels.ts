import type { AppView, AuditAction, AuditEvent, ReleaseState, Visibility } from "./api";

export const VISIBILITY: Record<Visibility, string> = {
  self: "仅自己",
  department: "本部门",
  company: "全公司",
};

export const VISIBILITY_HINT: Record<Visibility, string> = {
  self: "只有你自己能打开",
  department: "同部门和上级部门的同事能打开",
  company: "公司所有同事都能打开",
};

type TagType = "success" | "warning" | "danger" | "info" | "primary";

export const STATE: Record<ReleaseState, [string, TagType]> = {
  PENDING: ["排队中", "info"],
  VALIDATING: ["检查代码", "primary"],
  PROVISIONING: ["准备资源", "primary"],
  BUILDING: ["构建部署", "primary"],
  MIGRATING: ["迁移数据库", "primary"],
  VERIFYING: ["健康检查", "primary"],
  LIVE: ["成功", "success"],
  FAILED_FIXABLE: ["失败", "danger"],
  ROLLED_BACK: ["失败,已恢复旧版本", "warning"],
  FAILED: ["失败", "danger"],
};

/** 应用状态:标签文字、颜色,以及排序用的权重 */
export function appStatus(app: AppView): [string, TagType, number] {
  if (app.disabled) return ["已停用", "danger", 0];
  if (app.unpublished) return ["已下线", "info", 3];
  if (app.live) return ["在线", "success", 1];
  return ["未上线", "warning", 2];
}

export const time = (iso?: string) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");

/** 审计日志的操作名称 */
export const AUDIT_ACTION: Record<AuditAction, string> = {
  "app.create": "创建应用",
  "app.publish": "发布",
  "app.rollback": "回滚",
  "release.finish": "发布结束",
  "app.unpublish": "下线",
  "app.visibility": "修改可见范围",
  "secret.set": "设置密钥",
  "secret.delete": "删除密钥",
  "app.disable": "停用",
  "app.enable": "恢复",
  "app.delete": "删除应用",
  "token.create": "生成令牌",
  "token.revoke": "作废令牌",
};

const shortVersion = (v: unknown) => (typeof v === "string" ? v.slice(0, 8) : "");

/** 审计记录的细节,写成一句话 */
export function auditDetail(e: AuditEvent): string {
  const d = e.detail;
  switch (e.action) {
    case "app.publish":
      return `版本 ${shortVersion(d.version)}${d.revived ? ",重新发布已下线的应用" : ""}`;
    case "app.rollback":
      return `从版本 ${shortVersion(d.fromVersion)} 回到 ${shortVersion(d.toVersion)}`;
    case "release.finish": {
      const state = STATE[d.state as ReleaseState]?.[0] ?? String(d.state);
      const what = d.kind === "rollback" ? "回滚" : "发布";
      return `${what}${state}${d.errorType ? `(${String(d.errorType)})` : ""},版本 ${shortVersion(d.version)}`;
    }
    case "app.visibility":
      return (
        `${VISIBILITY[d.from as Visibility] ?? d.from} → ${VISIBILITY[d.to as Visibility] ?? d.to}` +
        (d.source === "app.yaml" ? "(发布时按 app.yaml 设置)" : "")
      );
    case "secret.set":
    case "secret.delete":
      return String(d.name ?? "");
    case "app.disable":
      return d.reason ? `原因:${String(d.reason)}` : "";
    case "token.create":
    case "token.revoke":
      return `令牌“${String(d.label ?? "")}”`;
    default:
      return "";
  }
}
