/**
 * 卷舍 · 编排核心(自研薄状态机 / 第二层)
 *
 * 设计依据(2025 研究综合):写作是"确定性 workflow"而非开放式 agent。
 * 这里用一颗**显式、可读、可测**的有向状态机表达 7 个阶段,每阶段产出经 Zod 校验,
 * 阶段间的转移由"确定性代码 + 质量门禁"决定——而不是让模型自由决定下一步。
 *
 * 三个硬指标如何落到这一层:
 *  - 快:阶段可声明 modelTier(强/快),门禁先走 L0 零成本预筛,跳过已完成阶段。
 *  - 质量:每阶段产出强类型 + evaluator-optimizer 返修回环(有界)。
 *  - 稳:每阶段 retry 策略 + token/步数预算保险丝 + 可序列化 RunState(崩溃可续)。
 *
 * 本文件只定义"骨架与契约"(类型 + 驱动循环);各阶段的具体实现与提示词在后续层。
 */
import { z } from "zod"
import { QualityScore, type AgentRoleId } from "../models/index.js"

// ── 7 个阶段(有向、可预测)──────────────────────────────
export const WriteStage = z.enum([
  "planning", // 规划:读设定/记忆 → 本章意图 + 上下文包
  "writing", // 写作:逐字生成草稿
  "reviewing", // 审稿:逻辑/连续性/读者视角,LLM-as-judge 打分
  "revising", // 修订:按门禁反馈定向改稿
  "polishing", // 润色:文字层精修 + humanize
  "verifying", // 复核:状态/伏笔/风格/字数 终检
  "publishing", // 签发:总编裁决 → 落库
])
export type WriteStage = z.infer<typeof WriteStage>

export const STAGE_ORDER: readonly WriteStage[] = [
  "planning", "writing", "reviewing", "revising", "polishing", "verifying", "publishing",
] as const

// ── 门禁判定:决定流程往哪走(evaluator-optimizer 的核心)──
export const GateVerdict = z.enum([
  "pass", // 达标,进入下一阶段
  "revise", // 不达标但可救,回修订阶段
  "regenerate", // 崩坏,回写作阶段重来
  "halt", // 退步/超预算/触底,硬停(防无限回环)
])
export type GateVerdict = z.infer<typeof GateVerdict>

export const GateDecision = z.object({
  verdict: GateVerdict,
  score: QualityScore.optional(),
  /** 给修订阶段的结构化 must-fix(Reflexion 式 episodic memory)*/
  mustFix: z.array(z.string()).default([]),
  rationale: z.string().optional(),
})
export type GateDecision = z.infer<typeof GateDecision>

// ── 预算保险丝(防 runaway,服务"稳定")──────────────────
export const StageBudget = z.object({
  maxReviseRounds: z.number().int().nonnegative().default(2), // 返修上限
  maxTokens: z.number().int().positive().optional(), // 单阶段 token 上限
  maxAttempts: z.number().int().positive().default(2), // 失败重试次数
  retryDelayMs: z.number().int().nonnegative().default(800),
})
export type StageBudget = z.infer<typeof StageBudget>

// ── 运行种子:一次写作的不可变输入(题材/平台/目标/前情/设定)──
// 各阶段 handler 据此组装提示词与上下文;不随阶段变化。
export const RunInput = z.object({
  genreId: z.string().optional(), // 题材(对应 GENRE_PROFILES)
  platformId: z.string().optional(), // 平台(对应 PLATFORM_PROFILES)
  chapterTitle: z.string().optional(),
  chapterGoal: z.string().optional(), // 本章在大纲里的目标/节拍
  priorContext: z.string().optional(), // 前情提要(上一章摘要 / 记忆)
  bookBible: z.string().optional(), // 设定集(人物/世界/风格基线)
  /** 最近成稿正文(已签发章,旧→新;书级编排注入,仅供风格指纹提炼——writing 在 ≥3 篇时启用)*/
  styleSamples: z.array(z.string()).optional(),
  targetWordCount: z.number().int().positive().default(3000),
  lang: z.enum(["zh", "en"]).default("zh"),
})
export type RunInput = z.infer<typeof RunInput>

// ── 可序列化运行态(崩溃可续 / 暂停可恢复)──────────────
export const RunState = z.object({
  runId: z.string(),
  bookId: z.string(),
  chapterNumber: z.number().int().positive(),
  /** 本次写作的不可变种子 */
  input: RunInput.default({}),
  stage: WriteStage,
  reviseRound: z.number().int().nonnegative().default(0),
  /** 各阶段的产物(草稿/审稿意见/修订/门禁分),用于恢复与审计 */
  artifacts: z.record(z.string(), z.unknown()).default({}),
  /** 累计到本阶段的门禁分历史(用于"单调上升,否则硬停")*/
  scoreHistory: z.array(z.number()).default([]),
  startedAt: z.string(),
  updatedAt: z.string(),
})
export type RunState = z.infer<typeof RunState>

// ── 阶段上下文:每个阶段实现拿到的东西 ────────────────────
export type ModelTier = "strong" | "fast" // prepareStep 按阶段切模型
/** 最小中断信号接口(不依赖 dom/node lib;运行时真实 AbortSignal 天然满足)*/
export interface AbortLike {
  readonly aborted: boolean
}
export interface StageContext {
  readonly state: RunState
  readonly budget: StageBudget
  /** 流式回调(写作/润色阶段把逐字进度推到前端 SSE)*/
  onToken?: (text: string) => void
  /** 中断信号(剧场里的"停止写作")*/
  readonly signal?: AbortLike
  /** 持久化一次快照(Inngest step 边界 / 人审插点)*/
  checkpoint?: (next: Partial<RunState>) => Promise<void>
}

// ── 阶段实现的统一契约 ─────────────────────────────────
export interface StageHandler {
  readonly stage: WriteStage
  readonly role: AgentRoleId // 这个阶段由哪个编辑部角色负责
  readonly modelTier: ModelTier
  /** 执行本阶段,返回产物 + 门禁判定(无门禁的阶段恒 pass)*/
  run(ctx: StageContext): Promise<{ artifacts: Record<string, unknown>; gate: GateDecision }>
}

// ── 下一步决策(纯函数,可单测)────────────────────────────
// 给定当前阶段 + 门禁判定 + 已修订轮次 + 分数历史,算出下一个阶段或终止。
export function nextStage(
  current: WriteStage,
  gate: GateDecision,
  reviseRound: number,
  budget: StageBudget,
  scoreHistory: readonly number[],
): { stage: WriteStage | "done"; reviseRound: number; reason: string } {
  // 触发硬停:超返修上限,或分数退步(非单调上升)
  const last = scoreHistory.at(-1)
  const prev = scoreHistory.at(-2)
  if (gate.verdict === "halt") return { stage: "done", reviseRound, reason: "门禁硬停" }
  if ((gate.verdict === "revise" || gate.verdict === "regenerate") && reviseRound >= budget.maxReviseRounds) {
    return { stage: "done", reviseRound, reason: `返修达上限(${budget.maxReviseRounds}),停在当前最好结果` }
  }
  // 仅在两个"同源"(verifying)分之间判非单调:scoreHistory 形如 [reviewing分, verifying分, verifying分…],
  // 必须 length>=3 才保证 last/prev 都来自 verifying;否则会拿 verifying 分跟首个 reviewing 分比(不同评估视角),
  // 让 verify 返修回环首轮未跑就被提前 halt。
  if (gate.verdict === "revise" && scoreHistory.length >= 3 && prev !== undefined && last !== undefined && last < prev) {
    return { stage: "done", reviseRound, reason: "返修后分数未单调上升,停止以免越改越差" }
  }
  switch (gate.verdict) {
    case "pass": {
      const idx = STAGE_ORDER.indexOf(current)
      const nx = STAGE_ORDER[idx + 1]
      // 注意:pass 不重置 reviseRound。它是"本章累计纠正轮次",必须跨
      // revising→polishing→verifying 这段 pass 持续累加,否则 verify↔revise
      // 子循环的计数永远到不了上限,只能靠硬步数兜底(白烧步数)。
      return { stage: nx ?? "done", reviseRound, reason: "达标,进入下一阶段" }
    }
    case "revise":
      return { stage: "revising", reviseRound: reviseRound + 1, reason: "不达标,定向返修" }
    case "regenerate":
      return { stage: "writing", reviseRound: reviseRound + 1, reason: "崩坏,重写本章" }
    default:
      return { stage: "done", reviseRound, reason: "未知判定,保守停止" }
  }
}
