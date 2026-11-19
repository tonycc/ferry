import type { AppView, ReleaseState, Visibility } from "./api";

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
