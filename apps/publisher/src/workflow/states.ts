export const RELEASE_STATES = [
  "PENDING",
  "VALIDATING",
  "PROVISIONING",
  "BUILDING",
  "MIGRATING",
  "VERIFYING",
  "LIVE",
  "FAILED_FIXABLE",
  "FAILED",
  "ROLLED_BACK",
] as const;

export type ReleaseState = (typeof RELEASE_STATES)[number];

/** 正常发布依次经过的步骤;全部通过后进入 LIVE */
export const STEP_ORDER = [
  "VALIDATING",
  "PROVISIONING",
  "BUILDING",
  "MIGRATING",
  "VERIFYING",
] as const satisfies readonly ReleaseState[];

export type StepState = (typeof STEP_ORDER)[number];

/**
 * 回滚只把之前上线过的代码重新部署并检查,不建资源、不迁移数据库。
 * 也要先扫描密钥:要回滚到的版本可能是在有密钥扫描之前上线的
 */
export const ROLLBACK_STEP_ORDER = ["VALIDATING", "BUILDING", "VERIFYING"] as const satisfies readonly StepState[];

export function stepOrder(kind: "publish" | "rollback"): readonly StepState[] {
  return kind === "rollback" ? ROLLBACK_STEP_ORDER : STEP_ORDER;
}

/** 发布结束后的状态:成功或失败 */
export const TERMINAL_STATES = ["LIVE", "FAILED_FIXABLE", "FAILED", "ROLLED_BACK"] as const satisfies readonly ReleaseState[];

const TERMINAL: ReadonlySet<ReleaseState> = new Set(TERMINAL_STATES);

export function isTerminal(state: ReleaseState): boolean {
  return TERMINAL.has(state);
}
