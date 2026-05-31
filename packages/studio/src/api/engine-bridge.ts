/**
 * 卷舍 · studio → @juanshe/engine 接线桥(Step 3 learnings 经验库,先落地、加法式)
 *
 * 引擎核心不碰 fs(副作用注入)。这里提供 FileLearningStore,把经验库落到
 * <workspace>/.autow/learnings.json(跨书共享),并把 recordOutcome / retrieveLearnings
 * 包成 studio 可直接调用的薄函数。learnings 的记录/检索是 **LLM-free**(纯 text-metrics +
 * UCB1 bandit + MMR),所以接线零 token、可离线验证;后续写作流水线可在 planning 处注入。
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  emptyLibrary,
  recordOutcome,
  retrieveLearnings,
  renderLearnings,
  RetrieveQuery,
  RunInput,
  createVercelLlm,
  makeHandlers,
  runPipeline,
  runBook,
  BookBrief,
  BookPlan,
  ChapterSpec,
  type LearningStore,
  type LearningDeps,
  type PatternLibrary,
  type RecordInput,
  type RetrievedPattern,
  type VercelLlmConfig,
  type RunState,
  type StageBudget,
  type AbortLike,
  type BookDeps,
  type BookBudget,
  type BookOutcome,
  type BookProgress,
  type QualityScore,
} from "@juanshe/engine"

function learningsFile(root: string): string {
  return join(root, ".autow", "learnings.json")
}

/** 经验库文件存储:落 <root>/.autow/learnings.json,跨书共享。损坏/缺失优雅降级为空库。 */
export class FileLearningStore implements LearningStore {
  constructor(private readonly root: string) {}
  async load(): Promise<PatternLibrary> {
    const empty = emptyLibrary(new Date().toISOString())
    try {
      const parsed = JSON.parse(await readFile(learningsFile(this.root), "utf-8"))
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.learnings)) {
        // 用空库做底再合并:旧版本/半截文件缺 index、stats 等字段时,不至于让下游 retrieve/record
        // 读到 undefined 而崩(整个经验子系统静默死)。已存字段以文件为准,缺的用空库默认补齐。
        return { ...empty, ...parsed } as PatternLibrary
      }
    } catch {
      /* 缺失/损坏 → 空库 */
    }
    return empty
  }
  async save(lib: PatternLibrary): Promise<void> {
    await mkdir(join(this.root, ".autow"), { recursive: true })
    // 原子写:先写临时文件再 rename,中途崩溃也不会把跨书经验库截断成非法 JSON(load 会静默当空库,等于丢光)。
    const file = learningsFile(this.root)
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(lib, null, 2), "utf-8")
    await rename(tmp, file)
  }
}

export function makeLearningDeps(root: string): LearningDeps {
  return {
    store: new FileLearningStore(root),
    now: () => new Date().toISOString(),
    newId: () => `lrn_${randomUUID().slice(0, 12)}`,
  }
}

// 按工作区 root 串行化经验写入:recordOutcome 是对同一 learnings.json 的 read-modify-write,
// 并发(多章同时记录)会各自 load 旧版本再覆盖,丢经验/bandit 奖励。用 per-root Promise 链排队。
const recordQueues = new Map<string, Promise<unknown>>()

/** 记录一章产出:高分章蒸馏可复用手法、低分章沉淀反模式 + bandit 奖励回填。LLM-free,按 root 串行。 */
export async function recordChapterLearning(root: string, input: RecordInput) {
  const prev = recordQueues.get(root) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => recordOutcome(input, makeLearningDeps(root)))
  recordQueues.set(root, next.catch(() => {})) // 队列只串行,不传播错误;真错误由本次调用的 await 抛出
  return next
}

/** 取回某「题材::平台」桶的 top-k 经验(回灌给 planning),并渲染成提示词块。LLM-free。 */
export async function retrieveChapterLearnings(
  root: string,
  opts: { genreId: string; platformId: string; k?: number },
): Promise<{ patterns: RetrievedPattern[]; prompt: string }> {
  const deps = makeLearningDeps(root)
  const query = RetrieveQuery.parse({
    genreId: opts.genreId,
    platformId: opts.platformId,
    k: opts.k ?? 4,
    now: deps.now(),
  })
  const patterns = await retrieveLearnings(query, deps)
  return { patterns, prompt: renderLearnings(patterns, "zh") }
}

/** 读经验库现状(给 /api/v1/engine/learnings 的状态展示)。 */
export async function loadLearningLibrary(root: string): Promise<PatternLibrary> {
  return new FileLearningStore(root).load()
}

// ── Step 4:用引擎自有流水线写一章(BYOK,加法式,不碰现有 core 写作)──────────
// studio 已解析出的 BYOK 字段 → 引擎 VercelLlmConfig。provider=anthropic 走原生,
// 其余(deepseek/openai/moonshot/custom…)走 openai-compatible(用 studio 给的 baseUrl)。
export interface EngineLlmFields {
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
}

function toVercelConfig(f: EngineLlmFields): VercelLlmConfig {
  const provider = (f.provider || "openai").toLowerCase()
  const cfg = {
    provider: provider === "anthropic" ? "anthropic" : provider,
    model: f.model || "",
    apiKey: f.apiKey || "",
    baseUrl: f.baseUrl || undefined,
  }
  return { strong: cfg }
}

/**
 * 从引擎各阶段 draft 里抽出"干净正文":引擎用分节标记包裹产物(=== REVISED CONTENT ===、
 * === PATCHES ===、尾部 UPDATED_STATE/HOOKS/TRACKING 等内部状态块)。这里取正文头之后、内部状态块之前的部分,
 * 与现有 core 管线落盘前的清洗口径一致——避免标记/补丁/状态泄漏进章节正文。返回 "" 表示这段不是可用散文。
 */
export function cleanChapterText(raw: unknown): string {
  if (typeof raw !== "string") return ""
  let t = raw
  // 1) 若带正文头标记,取其后内容
  const head = t.match(/===\s*(?:REVISED\s+CONTENT|FINAL\s+CONTENT|CONTENT|DRAFT|CHAPTER)\s*===/i)
  if (head && head.index !== undefined) t = t.slice(head.index + head[0].length)
  // 2) 纯补丁段(无正文头)→ 视为不可用
  if (/^\s*(?:===\s*PATCHES|---\s*PATCH|TARGET_TEXT:)/m.test(t) && !head) return ""
  // 3) 砍掉正文之后的内部状态/补丁块
  const cut = t.search(/=*\s*(?:UPDATED_STATE|UPDATED_HOOKS|UPDATED_TRACKING|STATE_DELTA|===\s*PATCHES|===\s*NOTES|===\s*METADATA)\b/)
  if (cut > 0) t = t.slice(0, cut)
  return t.trim()
}

export interface EngineWriteInput {
  genreId?: string
  platformId?: string
  chapterTitle?: string
  chapterGoal?: string
  priorContext?: string
  bookBible?: string
  targetWordCount?: number
  lang?: "zh" | "en"
}

export interface EngineWriteResult {
  status: string
  reason: string
  stage: string
  scoreHistory: number[]
  artifactStages: string[]
  draft?: string
  score?: unknown
}

/**
 * 引擎单章写作:planning→writing→reviewing→(revising)→… 全程引擎自有 handler + BYOK LLM。
 * 这是 Step 4 runBook 的"单章原语"——runBook 只是按计划并发地多次调它 + reconcile。
 * 加法式:不触碰 studio 现有 core 写作流水线;失败抛错由 onError 统一兜成 409/500。
 */
export async function writeChapterViaEngine(opts: {
  llm: EngineLlmFields
  bookId: string
  chapterNumber: number
  input: EngineWriteInput
  passThreshold?: number
  maxReviseRounds?: number
  signal?: AbortLike
  onToken?: (delta: string) => void
  /** 阶段进度回调(planning/writing/reviewing/…)——流式端点据此推"本轮接棒"式进度 */
  onStage?: (stage: string) => void
  /** 工作区根:传了就闭合 Step 3 学习环——写前检索经验注入 planner、写后记录本章产出 */
  root?: string
}): Promise<EngineWriteResult> {
  if (!opts.llm.apiKey) {
    throw new Error("Studio LLM API key not set") // onError → 409 LLM_NOT_CONFIGURED
  }
  const llm = createVercelLlm(toVercelConfig(opts.llm))
  const passT = opts.passThreshold ?? 85
  // 经验回灌:检索本「题材::平台」桶的高分手法 → 注入 planner 系统提示词
  let learnings: string | undefined
  let appliedIds: string[] = []
  if (opts.root && opts.input.genreId && opts.input.platformId) {
    try {
      const r = await retrieveChapterLearnings(opts.root, { genreId: opts.input.genreId, platformId: opts.input.platformId, k: 4 })
      learnings = r.prompt || undefined
      appliedIds = r.patterns.map((p) => p.learning.id).filter((id): id is string => !!id)
    } catch { /* 经验回灌可选,失败不阻断写作 */ }
  }
  const handlers = makeHandlers({ llm, passThreshold: passT, learnings })
  const now = () => new Date().toISOString()
  const initial: RunState = {
    runId: `run_${randomUUID().slice(0, 12)}`,
    bookId: opts.bookId,
    chapterNumber: opts.chapterNumber,
    input: RunInput.parse(opts.input ?? {}),
    stage: "planning",
    reviseRound: 0,
    artifacts: {},
    scoreHistory: [],
    startedAt: now(),
    updatedAt: now(),
  }
  const budget: StageBudget = {
    maxReviseRounds: opts.maxReviseRounds ?? 1,
    maxAttempts: 2,
    retryDelayMs: 800,
  }
  const outcome = await runPipeline(
    initial,
    { handlers, budget, now, delay: (ms) => new Promise((r) => setTimeout(r, ms)), onStage: opts.onStage ? (stage) => opts.onStage!(stage) : undefined },
    { signal: opts.signal, onToken: opts.onToken },
  )

  // 取稿:对齐引擎各 handler 真实存的字段名与优先级——writing/revising/polishing 存 `.draft`、
  // publishing 存 `.chapter.content`;顺序按"最终态优先":签发稿 → 润色 → 修订 → 初稿(原先用 .text 全 undefined,
  // 会回退到 writing 初稿,把修订/润色成果丢掉)。
  const a = outcome.state.artifacts as Record<string, any>
  // 取第一段"干净正文"(剥引擎分节标记/补丁/内部状态);最终态优先:签发 → 润色 → 修订 → 初稿
  //(revising 必须排在 writing 前:修订稿比初稿更接近成品,中途停在 revising 后不能回退到未修订的初稿)。
  const firstClean = (...cands: unknown[]): string | undefined => {
    for (const c of cands) { const t = cleanChapterText(c); if (t) return t }
    return undefined
  }
  const draft = firstClean(a.publishing?.chapter?.content, a.polishing?.draft, a.revising?.draft, a.writing?.draft)
  const score = a.verifying?.score ?? a.reviewing?.score
  // 写后记录:把本章产出喂回经验库(高分蒸馏手法/低分沉淀反模式),让后续章能回灌。闭合学习环。
  if (opts.root && opts.input.genreId && opts.input.platformId && draft && score && typeof score.overall === "number") {
    try {
      await recordChapterLearning(opts.root, {
        genreId: opts.input.genreId,
        platformId: opts.input.platformId,
        bookId: opts.bookId,
        chapterNumber: opts.chapterNumber,
        chapterText: draft,
        score: score as QualityScore,
        appliedLearningIds: appliedIds,
      })
    } catch { /* 记录可选,不阻断返回 */ }
  }
  return {
    status: outcome.status,
    reason: outcome.reason,
    stage: outcome.state.stage,
    scoreHistory: outcome.state.scoreHistory,
    artifactStages: Object.keys(outcome.state.artifacts),
    draft,
    score,
  }
}

// ── Step 4:runBook 整本/多本编排(plan → 有界并发扇出写章 → 轻量 reconcile)──────────
// 复用引擎的 runBook(纯函数、全注入、已单测);studio 这里只注入 4 件 deps:
//   planner       —— 1 次 LLM 结构化调用出章节大纲(架构师)
//   pipelineDepsFor —— 每章一条 makeHandlers 流水线(= writeChapterViaEngine 的单章原语)
//   buildContextPack —— 把章目标 + 前文梗概冻结成该章 RunInput
//   reconcile     —— v1 轻量(返回种子图,跨章伏笔补修留后续;每章自身已过质量门)
// 诚实:吞吐真瓶颈是模型 tokens/s——并发只把"等待"重叠;真提速靠 llm baseUrl 指本机算力集群。
const ChapterOutline = z.object({
  chapters: z.array(z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    goal: z.string().min(1),
  })).min(1),
})

export interface EngineRunBookInput {
  bookId: string
  titleZh: string
  genreId?: string
  platformId?: string
  premise?: string
  bookBible?: string
  targetChapters: number
  chapterWordCount?: number
  lang?: "zh" | "en"
}

export async function runBookViaEngine(opts: {
  llm: EngineLlmFields
  brief: EngineRunBookInput
  passThreshold?: number
  maxReviseRounds?: number
  concurrency?: number
  signal?: AbortLike
  onProgress?: (p: BookProgress) => void
  /** 工作区根:传了就闭合 Step 3 学习环——写前检索经验注入每章 planner、整本写完后逐章记录 */
  root?: string
}): Promise<BookOutcome> {
  if (!opts.llm.apiKey) {
    throw new Error("Studio LLM API key not set") // onError → 409 LLM_NOT_CONFIGURED
  }
  const llm = createVercelLlm(toVercelConfig(opts.llm))
  const now = () => new Date().toISOString()
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const passThreshold = opts.passThreshold ?? 85
  const lang: "zh" | "en" = opts.brief.lang === "en" ? "en" : "zh"
  // 经验回灌:整本开写前检索本「题材::平台」桶的高分手法,注入每章 planner(全书共用同一份)
  let learnings: string | undefined
  let appliedIds: string[] = []
  if (opts.root && opts.brief.genreId && opts.brief.platformId) {
    try {
      const r = await retrieveChapterLearnings(opts.root, { genreId: opts.brief.genreId, platformId: opts.brief.platformId, k: 4 })
      learnings = r.prompt || undefined
      appliedIds = r.patterns.map((p) => p.learning.id).filter((id): id is string => !!id)
    } catch { /* 可选 */ }
  }

  const brief = BookBrief.parse({
    bookId: opts.brief.bookId,
    title: { zh: opts.brief.titleZh },
    genreId: opts.brief.genreId,
    platformId: opts.brief.platformId,
    lang,
    premise: opts.brief.premise,
    bookBible: opts.brief.bookBible ?? "",
    targetChapters: opts.brief.targetChapters,
    chapterWordCount: opts.brief.chapterWordCount ?? 3000,
  })

  const deps: BookDeps = {
    planner: async (bookId, b, signal) => {
      const n = Math.max(1, Math.min(60, b.targetChapters || 3))
      const system = `你是资深小说架构师。基于设定产出一份 ${n} 章的章节大纲(${lang === "en" ? "English" : "中文"})。`
        + `每章给 number(1..${n} 顺序)、title(简短章名)、goal(这一章要完成的剧情目标,一句话、具体可写)。`
        + `要求:整体有递进与张力,章末留钩,避免空泛。只输出大纲,不要写正文。`
      const userMsg = [
        b.premise ? `【一句话设定】${b.premise}` : "",
        b.bookBible ? `【故事圣经(节选)】\n${b.bookBible.slice(0, 4000)}` : "",
        `【题材】${b.genreId ?? "通用"} 【平台】${b.platformId ?? "novel"} 【目标章数】${n} 【单章目标字数】${b.chapterWordCount}`,
      ].filter(Boolean).join("\n\n")
      // 容错:provider 可能不支持原生结构化输出(如 deepseek 退回 json_object/纯文本),
      // 返回形状可能是 {chapters:[...]} 或裸数组或不规整。尽力取数组,取不到就降级为通用章位
      // ——真正的每章规划由单章 pipeline 的 planning 阶段完成,book-planner 只需给出 N 个章位。
      let rawChapters: any[] = []
      try {
        const { data } = await llm.generateStructured({
          system: system + ` 严格只输出 JSON:{"chapters":[{"number":1,"title":"...","goal":"..."}]}。`,
          messages: [{ role: "user", content: userMsg }],
          schema: ChapterOutline,
          modelTier: "strong",
          temperature: 0.6,
          signal,
        })
        rawChapters = Array.isArray(data) ? data : (Array.isArray((data as any)?.chapters) ? (data as any).chapters : [])
      }
      catch {
        // 结构化失败 → 再试一次纯文本 + 容错解析 JSON
        try {
          const { text } = await llm.generate({
            system: system + ` 严格只输出 JSON 对象 {"chapters":[{"number":1,"title":"...","goal":"..."}]},不要任何额外文字。`,
            messages: [{ role: "user", content: userMsg }],
            modelTier: "strong",
            temperature: 0.5,
            signal,
          })
          const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
          const parsed = m ? JSON.parse(m[0]) : null
          rawChapters = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.chapters) ? parsed.chapters : [])
        }
        catch { rawChapters = [] }
      }
      let chapters = rawChapters.slice(0, n).map((ch: any, i: number) => ChapterSpec.parse({
        number: Number.isInteger(ch?.number) && ch.number > 0 ? ch.number : i + 1,
        title: String(ch?.title || `第 ${i + 1} 章`).slice(0, 60),
        goal: String(ch?.goal || ch?.summary || `推进主线第 ${i + 1} 步`).slice(0, 200),
        targetWordCount: b.chapterWordCount,
      }))
      // 降级兜底:planner 完全没取到 → 生成 N 个通用章位,runBook 仍能推进
      if (!chapters.length) {
        const seed = (b.premise || b.title.zh || "故事").slice(0, 50)
        chapters = Array.from({ length: n }, (_, i) => ChapterSpec.parse({
          number: i + 1,
          title: `第 ${i + 1} 章`,
          goal: `推进主线第 ${i + 1} 步:${seed}`,
          targetWordCount: b.chapterWordCount,
        }))
      }
      return BookPlan.parse({
        bookId,
        title: b.title,
        genreId: b.genreId,
        platformId: b.platformId,
        lang: b.lang,
        bookBible: b.bookBible,
        chapters,
        graph: { bookId, entities: [], relations: [], foreshadows: [], timeline: [], chapterDeps: {} },
      })
    },
    pipelineDepsFor: (_spec) => ({
      handlers: makeHandlers({ llm, passThreshold, learnings }),
      budget: { maxReviseRounds: opts.maxReviseRounds ?? 1, maxAttempts: 2, retryDelayMs: 800 },
      now,
      delay,
    }),
    buildContextPack: (plan, spec, _done) => {
      const prior = plan.chapters
        .filter((s) => s.number < spec.number)
        .map((s) => `第${s.number}章《${s.title}》:${s.goal}`)
        .join("\n")
      const input = RunInput.parse({
        chapterTitle: spec.title,
        chapterGoal: spec.goal,
        priorContext: prior || undefined,
        bookBible: plan.bookBible || undefined,
        targetWordCount: spec.targetWordCount,
        genreId: plan.genreId,
        platformId: plan.platformId,
        lang: plan.lang,
      })
      return { chapterNumber: spec.number, input, frozenAt: now() }
    },
    // v1 reconcile:返回种子图、不做跨章补修(每章已过自身质量门;伏笔/实体累积留后续 memory 接线)
    reconcile: async (plan) => ({ graph: plan.graph, findings: [] }),
    now,
    delay,
    onBookProgress: opts.onProgress,
  }

  const budget: BookBudget = {
    concurrency: Math.max(1, Math.min(8, opts.concurrency ?? 2)),
    waveMode: "flat",
    maxReconcilePasses: 1,
    stopOnChapterError: false,
  }

  const outcome = await runBook(brief, deps, budget, { signal: opts.signal })
  // 写后逐章记录:把整本各章产出喂回经验库(下次 run 能回灌,经验跨书累积)。串行(recordChapterLearning 内已按 root 排队),失败不阻断。
  if (opts.root && opts.brief.genreId && opts.brief.platformId) {
    for (const r of outcome.results) {
      const a = (r.finalState?.artifacts ?? {}) as Record<string, any>
      const text = cleanChapterText(a.publishing?.chapter?.content) || cleanChapterText(a.polishing?.draft) || cleanChapterText(a.revising?.draft) || cleanChapterText(a.writing?.draft)
      const sc = a.verifying?.score ?? a.reviewing?.score
      if (text && sc && typeof sc.overall === "number") {
        try {
          await recordChapterLearning(opts.root, {
            genreId: opts.brief.genreId,
            platformId: opts.brief.platformId,
            bookId: opts.brief.bookId,
            chapterNumber: r.chapterNumber,
            chapterText: text,
            score: sc as QualityScore,
            appliedLearningIds: appliedIds,
          })
        } catch { /* 可选 */ }
      }
    }
  }
  return outcome
}
