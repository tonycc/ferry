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
  "password.reset": "生成初始密码",
  "password.change": "修改密码",
  "user.create": "新增人员",
  "user.update": "修改人员",
  "user.deactivate": "标记离职",
  "user.reactivate": "恢复在职",
  "user.admin": "设置管理员",
  "department.create": "新建部门",
  "department.update": "修改部门",
  "department.delete": "删除部门",
};

const PERSON_FIELD: Record<string, string> = { name: "姓名", mobile: "手机号", jobNumber: "工号", departmentIds: "部门" };

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
    case "password.reset":
      return `给 ${String(d.name ?? d.userId ?? "")} 生成初始密码${d.via === "cli" ? "(命令行)" : ""}`;
    case "password.change":
      return d.initial ? "首次登录,把初始密码改成自己的" : "";
    case "user.create":
      return `${String(d.name ?? d.userId ?? "")}${d.isAdmin ? ",设为管理员" : ""}${d.via === "cli" ? "(命令行)" : ""}`;
    case "user.update": {
      const fields = Array.isArray(d.fields) ? d.fields.map((f) => PERSON_FIELD[String(f)] ?? String(f)) : [];
      return `${String(d.name ?? d.userId ?? "")}${fields.length ? `:改了${fields.join("、")}` : ""}`;
    }
    case "user.deactivate":
    case "user.reactivate":
      return String(d.name ?? d.userId ?? "");
    case "user.admin":
      return `${d.isAdmin ? "把" : "取消"} ${String(d.name ?? d.userId ?? "")} ${d.isAdmin ? "设为管理员" : "的管理员身份"}${d.via === "cli" ? "(命令行)" : ""}`;
    case "department.create":
    case "department.delete":
      return String(d.name ?? d.departmentId ?? "");
    case "department.update":
      return [
        d.fromName ? `“${String(d.fromName)}”改名为“${String(d.name)}”` : String(d.name ?? ""),
        d.parentId !== undefined && d.fromParentId !== undefined ? "调整了上级部门" : "",
      ]
        .filter(Boolean)
        .join(",");
    default:
      return "";
  }
}
