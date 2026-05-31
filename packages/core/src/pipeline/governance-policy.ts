/**
 * 提示词治理触发策略(质量 → 提示词自动复盘闭环的"何时触发"决策)。
 * 纯函数:根据章节质量分(及最近连续低分情况)判断是否建议触发 prompt-governance 复盘。
 *
 * 重要:这里只做**检测 + 建议**(自动、零成本、不改提示词)。真正"应用补丁"仍由
 * prompt-governance 的 Prompt Reviewer 门控 + 显式开关把关,避免坏补丁污染提示词。
 */

export type GovernanceSeverity = "none" | "watch" | "act";

export interface GovernanceRecommendation {
  readonly recommended: boolean;
  readonly severity: GovernanceSeverity;
  readonly reason: string;
}

export const DEFAULT_GOVERNANCE_THRESHOLD = 90;

export function buildGovernanceRecommendation(input: {
  /** 当前章节综合分;null = 无数据。 */
  readonly score: number | null;
  /** 通过线(默认 90,与质量门禁一致)。 */
  readonly passThreshold?: number;
  /** 最近连续低于通过线的章节数(含本章);用于把"偶发低分"升级为"持续退化"。 */
  readonly recentLowCount?: number;
}): GovernanceRecommendation {
  const threshold = input.passThreshold ?? DEFAULT_GOVERNANCE_THRESHOLD;
  const score = input.score;
  if (score == null || !Number.isFinite(score)) {
    return { recommended: false, severity: "none", reason: "无章节质量分,暂不建议治理" };
  }
  if (score >= threshold) {
    return { recommended: false, severity: "none", reason: `质量分 ${score} ≥ ${threshold},无需治理` };
  }
  const recentLow = input.recentLowCount ?? 1;
  if (recentLow >= 2) {
    return {
      recommended: true,
      severity: "act",
      reason: `连续 ${recentLow} 章低于通过线(本章 ${score}/${threshold}),强烈建议触发提示词治理复盘`,
    };
  }
  return {
    recommended: true,
    severity: "watch",
    reason: `本章质量分 ${score} 低于通过线 ${threshold},建议触发提示词治理复盘`,
  };
}

export function shouldTriggerGovernance(input: {
  readonly score: number | null;
  readonly passThreshold?: number;
  readonly recentLowCount?: number;
}): boolean {
  return buildGovernanceRecommendation(input).recommended;
}
