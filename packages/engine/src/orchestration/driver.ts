/**
 * 卷舍 · 编排驱动(把状态机真正跑起来的循环)
 *
 * 设计:核心保持"纯"——时钟(now)、延时(delay)、持久化(persist)全部注入,
 * 不直接碰 Date.now/setTimeout 等全局,从而可确定性单测、可跑在任意宿主(Inngest/本地/测试)。
 *
 * 砸中硬指标:
 *  - 稳:每阶段按 budget 重试;门禁 nextStage 决定 pass/revise/regenerate/halt;中断信号即时退出;每步 checkpoint。
 *  - 快:阶段实现自行用 modelTier 切快/强模型(driver 不关心);已完成阶段产物留在 artifacts,恢复时不重跑。
 */
import {
  type RunState, type StageBudget, type StageHandler, type StageContext, type WriteStage,
  type AbortLike, nextStage, STAGE_ORDER,
} from "./pipeline.js"

export interface PipelineDeps {
  /** 每个阶段的实现(注入;clean 解耦,便于测试与替换)*/
  readonly handlers: Readonly<Record<WriteStage, StageHandler>>
  readonly budget: StageBudget
  /** 注入时钟(返回 ISO 字符串)——保持核心纯净、可测 */
  readonly now: () => string
  /** 注入延时(重试退避用)*/
  readonly delay: (ms: number) => Promise<void>
  /** 每步落一次快照(Inngest step 边界 / 崩溃可续 / 审计)*/
  readonly persist?: (state: RunState) => Promise<void>
  /** 进度回调(推前端:当前在哪个阶段)*/
  readonly onStage?: (stage: WriteStage, state: RunState) => void
}

export type PipelineStatus = "completed" | "halted" | "aborted" | "error"
export interface PipelineOutcome {
  readonly state: RunState
  readonly status: PipelineStatus
  readonly reason: string
}

export interface RunOptions {
  readonly signal?: AbortLike
  readonly onToken?: (text: string) => void
}

export async function runPipeline(
  initial: RunState,
  deps: PipelineDeps,
  opts: RunOptions = {},
): Promise<PipelineOutcome> {
  let state: RunState = initial

  // 防御:全流程绝对步数上限(保险丝,防任何意外的无限循环)
  const HARD_STEP_CAP = 64
  for (let step = 0; step < HARD_STEP_CAP; step++) {
    if (opts.signal?.aborted) {
      return { state, status: "aborted", reason: "用户中断写作" }
    }

    const handler = deps.handlers[state.stage]
    if (!handler) {
      return { state, status: "error", reason: `缺少阶段实现:${state.stage}` }
    }

    const ctx: StageContext = {
      state,
      budget: deps.budget,
      onToken: opts.onToken,
      signal: opts.signal,
      checkpoint: deps.persist ? (next) => deps.persist!({ ...state, ...next, updatedAt: deps.now() }) : undefined,
    }

    // ── 阶段执行 + 有界重试(退避)──
    let produced: Awaited<ReturnType<StageHandler["run"]>> | undefined
    let lastErr: unknown
    for (let attempt = 1; attempt <= deps.budget.maxAttempts; attempt++) {
      if (opts.signal?.aborted) return { state, status: "aborted", reason: "用户中断写作" }
      try {
        produced = await handler.run(ctx)
        break
      } catch (err) {
        lastErr = err
        if (attempt < deps.budget.maxAttempts) await deps.delay(deps.budget.retryDelayMs * attempt)
      }
    }
    if (!produced) {
      return { state, status: "error", reason: `阶段「${state.stage}」重试 ${deps.budget.maxAttempts} 次仍失败:${errText(lastErr)}` }
    }

    // ── 记录产物 + 分数历史 ──
    state = {
      ...state,
      artifacts: { ...state.artifacts, [state.stage]: produced.artifacts },
      updatedAt: deps.now(),
    }
    if (produced.gate.score) {
      state = { ...state, scoreHistory: [...state.scoreHistory, produced.gate.score.overall] }
    }
    deps.onStage?.(state.stage, state)
    await deps.persist?.(state)

    // ── 决定下一步(纯函数:pass/revise/regenerate/halt + 单调上升保护)──
    const decision = nextStage(state.stage, produced.gate, state.reviseRound, deps.budget, state.scoreHistory)
    if (decision.stage === "done") {
      // 真正的"完成"只有一种:走到 publishing 并签发。
      // 从任何更早阶段落到 done(门禁 halt / 返修触上限 / 分数不再上升)都是"未达标的提前停止"。
      const status: PipelineStatus = state.stage === "publishing" ? "completed" : "halted"
      return { state, status, reason: decision.reason }
    }
    // 返修/重写回到更早阶段时,清掉"目标阶段之后"的陈旧产物(保留目标阶段本身的输入稿)——
    // 否则上一轮的 polishing 草稿会在 latestDraft(polishing ?? revising ?? writing)里盖过本轮 revising
    // 的新稿,导致 verify→revise 二次定向返修被静默丢弃(质量门禁形同虚设)。
    let nextArtifacts = state.artifacts
    const targetIdx = STAGE_ORDER.indexOf(decision.stage)
    if (targetIdx >= 0 && targetIdx <= STAGE_ORDER.indexOf(state.stage)) {
      nextArtifacts = { ...state.artifacts }
      for (let i = targetIdx + 1; i < STAGE_ORDER.length; i++) delete nextArtifacts[STAGE_ORDER[i]]
    }
    state = { ...state, stage: decision.stage, reviseRound: decision.reviseRound, artifacts: nextArtifacts }
  }

  return { state, status: "halted", reason: `触及硬步数上限 ${HARD_STEP_CAP},保守停止` }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
