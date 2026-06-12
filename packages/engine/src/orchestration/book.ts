/**
 * 卷舍 · 书级编排(runBook:在 runPipeline 之上的两段式解依赖扇出 + 连续性 reconcile)
 *
 * 三相:① plan —— 架构师产出全本大纲 + 为每章冻结不可变 input(章间近独立,使并行成默认);
 *       ② fanout —— 有界并发信号量扇出 N 章,各章直接复用 runPipeline,单章失败/halt 隔离不拖垮整本;
 *       ③ reconcile —— 全部落定后用 KnowledgeGraph 纯函数跨章总检(超期伏笔/悬空实体/被影响章),
 *          只对命中章定向补修(不重写整本),有界回环防越修越多。
 *
 * runBook 本体纯函数、全注入(planner/reconcile/runChapter/now/delay 注入),可确定性单测。
 * Inngest 持久化宿主放 studio 侧,绝不进引擎。
 * 诚实:吞吐真瓶颈是模型 tokens/s(provider 速率/成本),并发只把"等待"重叠;真解吞吐靠 llm baseUrl 指本机 Exo 集群。
 * 跨书并行 = 开多个 runBook 实例,runBook 自身不管跨书。
 */
import { z } from "zod"
import { RunState, RunInput, type AbortLike } from "./pipeline.js"
import { runPipeline, type PipelineDeps, type PipelineOutcome, type RunOptions } from "./driver.js"
import { KnowledgeGraph, overdueForeshadows, danglingEntityRefs } from "../state/knowledge.js"

// ── 数据模型(规划/进度/发现:zod;运行结果/依赖:TS 接口)──
export const ChapterSpec = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  goal: z.string(),
  targetWordCount: z.number().int().positive().default(3000),
  dependsOn: z.array(z.number().int().positive()).default([]),
  plantForeshadowIds: z.array(z.string()).default([]),
  payoffForeshadowIds: z.array(z.string()).default([]),
  entityIds: z.array(z.string()).default([]),
})
export type ChapterSpec = z.infer<typeof ChapterSpec>

export const BookBrief = z.object({
  bookId: z.string(),
  title: z.object({ zh: z.string(), en: z.string().optional() }),
  genreId: z.string().optional(),
  platformId: z.string().optional(),
  lang: z.enum(["zh", "en"]).default("zh"),
  premise: z.string().optional(),
  bookBible: z.string().default(""),
  targetChapters: z.number().int().nonnegative().default(0), // 0 = 未设
  chapterWordCount: z.number().int().positive().default(3000),
})
export type BookBrief = z.infer<typeof BookBrief>

export const BookPlan = z.object({
  bookId: z.string(),
  title: z.object({ zh: z.string(), en: z.string().optional() }),
  genreId: z.string().optional(),
  platformId: z.string().optional(),
  lang: z.enum(["zh", "en"]).default("zh"),
  bookBible: z.string().default(""),
  chapters: z.array(ChapterSpec).default([]),
  graph: KnowledgeGraph,
})
export type BookPlan = z.infer<typeof BookPlan>

// 每章冻结的输入快照(故意叫 FrozenChapterInput 而非 ContextPack——后者是 memory 的检索产物)
export const FrozenChapterInput = z.object({
  chapterNumber: z.number().int().positive(),
  input: RunInput,
  frozenAt: z.string(),
})
export type FrozenChapterInput = z.infer<typeof FrozenChapterInput>

export const BookProgress = z.object({
  bookId: z.string(),
  phase: z.enum(["planning", "writing", "reconciling", "done", "failed"]),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  inflight: z.array(z.number()).default([]),
  halted: z.array(z.number()).default([]),
  failed: z.array(z.number()).default([]),
  reconcilePass: z.number().int().nonnegative().default(0),
  avgScore: z.number().optional(),
  updatedAt: z.string(),
})
export type BookProgress = z.infer<typeof BookProgress>

export const ReconcileFinding = z.object({
  kind: z.enum(["overdue-foreshadow", "dangling-entity", "impacted-chapter"]),
  chapters: z.array(z.number().int().positive()),
  detail: z.string(),
  foreshadowIds: z.array(z.string()).default([]),
  entityIds: z.array(z.string()).default([]),
})
export type ReconcileFinding = z.infer<typeof ReconcileFinding>

export interface ChapterResult {
  chapterNumber: number
  status: PipelineOutcome["status"]
  reason: string
  finalState: PipelineOutcome["state"]
  chapter?: unknown // artifacts.publishing.chapter(publishing handler 产物)
  overall?: number
}
export interface BookOutcome {
  bookId: string
  status: "completed" | "partial" | "failed"
  results: ChapterResult[]
  findings: ReconcileFinding[]
  reconcilePasses: number
  graph: KnowledgeGraph
  reason: string
}

// ── 注入依赖 / 预算(与 driver 的 PipelineDeps/StageBudget 同构)──
export interface BookDeps {
  planner: (bookId: string, brief: BookBrief, signal?: AbortLike) => Promise<BookPlan>
  pipelineDepsFor: (spec: ChapterSpec) => PipelineDeps
  buildContextPack: (plan: BookPlan, spec: ChapterSpec, done: ReadonlyMap<number, ChapterResult>) => FrozenChapterInput
  /** 默认 = runPipeline;独立注入点便于 Inngest 宿主换成 step.invoke */
  runChapter?: (initial: RunState, deps: PipelineDeps, opts: RunOptions) => Promise<PipelineOutcome>
  reconcile: (plan: BookPlan, results: ReadonlyMap<number, ChapterResult>) => Promise<{ graph: KnowledgeGraph; findings: ReconcileFinding[] }>
  now: () => string
  delay: (ms: number) => Promise<void>
  persistBook?: (p: BookProgress) => Promise<void>
  onBookProgress?: (p: BookProgress) => void
}
export interface BookBudget {
  concurrency: number // 一本书内同时在跑的章上限(默认按 Exo 可并行 stream 数定)
  waveMode: "flat" | "wavefront"
  maxReconcilePasses: number
  stopOnChapterError: boolean
}

// ── 并发原语(纯,可测)─────────────────────────────────────
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettle?: (r: R, item: T) => void,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  async function runner(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++
      try {
        const r = await worker(items[idx], idx) // worker 自行 try/catch,绝不 reject
        out[idx] = r
        onSettle?.(r, items[idx])
      } catch {
        // 兜底:worker 理应不抛;万一抛,跳过该项也不让本 runner 崩,其余项继续跑。
      }
    }
  }
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.allSettled(Array.from({ length: n }, () => runner()))
  return out
}

/** Kahn 拓扑分波;检测到环则把剩余降级为一波(flat) */
export function topoWaves(specs: readonly ChapterSpec[]): number[][] {
  const nums = new Set(specs.map((s) => s.number))
  const done = new Set<number>()
  const waves: number[][] = []
  while (done.size < specs.length) {
    const frontier = specs
      .filter((s) => !done.has(s.number) && s.dependsOn.filter((d) => nums.has(d) && !done.has(d)).length === 0)
      .map((s) => s.number)
    if (!frontier.length) {
      // 环:剩余打平成一波
      waves.push(specs.filter((s) => !done.has(s.number)).map((s) => s.number))
      break
    }
    waves.push(frontier)
    frontier.forEach((n) => done.add(n))
  }
  return waves
}

export function chapterToRunState(spec: ChapterSpec, pack: FrozenChapterInput, bookId: string, now: () => string): RunState {
  return RunState.parse({
    runId: `${bookId}:ch${spec.number}`,
    bookId,
    chapterNumber: spec.number,
    input: pack.input,
    stage: "planning",
    reviseRound: 0,
    artifacts: {},
    scoreHistory: [],
    startedAt: now(),
    updatedAt: now(),
  })
}

/** 风格指纹样本(软接线):取已签发(completed)且章号小于当前章的成稿正文,
 *  旧→新排序、只留最近 ≤max 章——配合 mergeStyle 的 EMA,指纹收敛偏向最新的作者声音。
 *  只看章号在前的章是为了因果确定性:reconcile 重跑某章时,不让它"学"自己或后续章的文风。*/
export function collectStyleSamples(results: ReadonlyMap<number, ChapterResult>, beforeChapter: number, max = 5): string[] {
  return [...results.values()]
    .filter((r) => r.status === "completed" && r.chapterNumber < beforeChapter)
    .map((r) => ({ n: r.chapterNumber, text: (r.chapter as { content?: unknown } | undefined)?.content }))
    .filter((x): x is { n: number; text: string } => typeof x.text === "string" && x.text.trim().length > 0)
    .sort((a, b) => a.n - b.n)
    .slice(-max)
    .map((x) => x.text)
}

// ── 内部归一/聚合 ─────────────────────────────────────────
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const unique = (xs: number[]): number[] => [...new Set(xs)]

function toChapterResult(number: number, outcome: PipelineOutcome): ChapterResult {
  const artifacts = outcome.state.artifacts as Record<string, { chapter?: unknown }>
  return {
    chapterNumber: number,
    status: outcome.status,
    reason: outcome.reason,
    finalState: outcome.state,
    chapter: artifacts.publishing?.chapter,
    overall: outcome.state.scoreHistory.at(-1),
  }
}

function aggregateProgress(
  bookId: string, phase: BookProgress["phase"], total: number,
  results: ReadonlyMap<number, ChapterResult>, inflight: number[], now: () => string, reconcilePass = 0,
): BookProgress {
  const arr = [...results.values()]
  const halted = arr.filter((r) => r.status === "halted").map((r) => r.chapterNumber)
  const failed = arr.filter((r) => r.status === "error" || r.status === "aborted").map((r) => r.chapterNumber)
  const scores = arr.map((r) => r.overall).filter((x): x is number => typeof x === "number")
  return {
    bookId,
    phase,
    total,
    completed: arr.filter((r) => r.status === "completed").length,
    inflight,
    halted,
    failed,
    reconcilePass,
    avgScore: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : undefined,
    updatedAt: now(),
  }
}

// ── fanout 相位(有界并发扇出一批章,失败隔离)──
async function fanout(
  plan: BookPlan, specs: ChapterSpec[], deps: BookDeps, budget: BookBudget,
  opts: { signal?: AbortLike }, results: Map<number, ChapterResult>, phase: BookProgress["phase"], reconcilePass: number,
): Promise<void> {
  const runChapter = deps.runChapter ?? runPipeline
  const waves = budget.waveMode === "wavefront" ? topoWaves(specs) : [specs.map((s) => s.number)]
  const inflight = new Set<number>()
  for (const wave of waves) {
    if (opts.signal?.aborted) return
    const waveSpecs = specs.filter((s) => wave.includes(s.number))
    await mapWithConcurrency(
      waveSpecs,
      budget.concurrency,
      async (spec) => {
        inflight.add(spec.number)
        deps.onBookProgress?.(aggregateProgress(plan.bookId, phase, plan.chapters.length, results, [...inflight], deps.now, reconcilePass))
        let cr: ChapterResult
        try {
          const pack = deps.buildContextPack(plan, spec, results)
          // 风格指纹软接线:buildContextPack 未自带样本时,把已签发章正文带进 RunInput
          // (writing 在 ≥3 篇时才提炼指纹,前几章天然保持现状)。
          const styleSamples = pack.input.styleSamples?.length ? pack.input.styleSamples : collectStyleSamples(results, spec.number)
          const packed = styleSamples.length ? { ...pack, input: { ...pack.input, styleSamples } } : pack
          const initial = chapterToRunState(spec, packed, plan.bookId, deps.now)
          const outcome = await runChapter(initial, deps.pipelineDepsFor(spec), { signal: opts.signal })
          cr = toChapterResult(spec.number, outcome)
        } catch (e) {
          // 兜底 finalState 绝不能再调可能抛错的 buildContextPack/RunState.parse——否则 catch 二次抛 →
          // worker reject → mapWithConcurrency 里 out[idx] 与 results.set 都不执行 → 整章从结果里静默消失。
          cr = {
            chapterNumber: spec.number,
            status: "error",
            reason: errText(e),
            finalState: {
              runId: `${plan.bookId}:ch${spec.number}`,
              bookId: plan.bookId,
              chapterNumber: spec.number,
              input: { targetWordCount: spec.targetWordCount, lang: plan.lang } as RunInput,
              stage: "planning",
              reviseRound: 0,
              artifacts: {},
              scoreHistory: [],
              startedAt: deps.now(),
              updatedAt: deps.now(),
            },
          }
        }
        results.set(spec.number, cr)
        return cr
      },
      (cr) => {
        inflight.delete(cr.chapterNumber)
        deps.onBookProgress?.(aggregateProgress(plan.bookId, phase, plan.chapters.length, results, [...inflight], deps.now, reconcilePass))
      },
    )
    if (budget.stopOnChapterError && [...results.values()].some((r) => r.status === "error")) return
  }
}

// ── 主函数 ────────────────────────────────────────────────
export async function runBook(
  brief: BookBrief, deps: BookDeps, budget: BookBudget, opts: { signal?: AbortLike } = {},
): Promise<BookOutcome> {
  const emptyGraph: KnowledgeGraph = { bookId: brief.bookId, entities: [], relations: [], foreshadows: [], timeline: [], chapterDeps: {} }

  // 相位一:plan
  let plan: BookPlan
  try {
    plan = await deps.planner(brief.bookId, brief, opts.signal)
  } catch (e) {
    return { bookId: brief.bookId, status: "failed", results: [], findings: [], reconcilePasses: 0, graph: emptyGraph, reason: `建书(plan)失败:${errText(e)}` }
  }
  await deps.persistBook?.(aggregateProgress(plan.bookId, "planning", plan.chapters.length, new Map(), [], deps.now))

  // 相位二:fanout
  const results = new Map<number, ChapterResult>()
  await fanout(plan, plan.chapters, deps, budget, opts, results, "writing", 0)

  // 相位三:reconcile(有界回环)
  let graph = plan.graph
  let findings: ReconcileFinding[] = []
  let pass = 0
  for (; pass < budget.maxReconcilePasses; pass++) {
    if (opts.signal?.aborted) break
    const rec = await deps.reconcile(plan, results)
    graph = rec.graph
    findings = rec.findings
    if (!findings.length) break
    const impacted = unique(findings.flatMap((f) => f.chapters))
    const specs = plan.chapters.filter((c) => impacted.includes(c.number))
    if (!specs.length) break
    // 把 finding 注入待补修章的 goal,让重跑知道补什么
    const patched: BookPlan = {
      ...plan,
      chapters: plan.chapters.map((c) => {
        const f = findings.find((x) => x.chapters.includes(c.number))
        return f ? { ...c, goal: `${c.goal}\n【补修】${f.detail}` } : c
      }),
    }
    await deps.persistBook?.(aggregateProgress(plan.bookId, "reconciling", plan.chapters.length, results, [], deps.now, pass + 1))
    await fanout(patched, specs, deps, budget, opts, results, "reconciling", pass + 1)
  }

  const arr = [...results.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
  const hasBad = arr.some((r) => r.status === "error" || r.status === "halted" || r.status === "aborted")
  const status: BookOutcome["status"] = !hasBad && findings.length === 0 ? "completed" : "partial"
  const reason = status === "completed"
    ? `全本 ${arr.length} 章完成`
    : `部分完成:${arr.filter((r) => r.status === "completed").length}/${arr.length} 章达标` + (findings.length ? `,残留 ${findings.length} 处连续性问题(已达 reconcile 上限)` : "")
  await deps.persistBook?.(aggregateProgress(plan.bookId, "done", plan.chapters.length, results, [], deps.now, pass))
  return { bookId: plan.bookId, status, results: arr, findings, reconcilePasses: pass, graph, reason }
}
