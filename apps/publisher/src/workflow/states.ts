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

/** 发布结束后的状态:成功或失败 */
export const TERMINAL_STATES = ["LIVE", "FAILED_FIXABLE", "FAILED", "ROLLED_BACK"] as const satisfies readonly ReleaseState[];

const TERMINAL: ReadonlySet<ReleaseState> = new Set(TERMINAL_STATES);

export function isTerminal(state: ReleaseState): boolean {
  return TERMINAL.has(state);
}
