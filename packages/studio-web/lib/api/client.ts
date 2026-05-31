// ============================================================================
// API 客户端 — 真实 fetch 调用
// 所有数据都走 Next.js Route Handler (app/api/v1/**)。
// 后端接管时只需替换 route 实现或加代理，本文件零改动。
// ============================================================================

import type {
  AgentProfile,
  AutoRun,
  AutoRunCreate,
  Book,
  BookCreateInput,
  BookCreateResult,
  BookCreateStatus,
  BookDescriptionResult,
  BookFoundationValidateResult,
  BookRepairQualityBatchInput,
  BookRepairQualityBatchResult,
  BookRepairStateResult,
  BookRun,
  BookSummary,
  ChapterRevisionsResult,
  BookUpdateInput,
  ChapterStats,
  ConnectivityResult,
  DockMetrics,
  LLMProvider,
  LLMProviderCreateInput,
  LLMProviderPatch,
  Manuscript,
  MarketOpportunity,
  OutlineAct,
  PlotProgress,
  ProjectPrefs,
  PublishChannel,
  QualityMetrics,
  RelationshipGraph,
  RewriteProposal,
  RoleQueueItem,
  StyleFingerprint,
  SystemHealth,
  WikiNode,
  WikiResponse,
  WorkflowContract,
  WorkflowSnapshot,
  WriteNextChapterInput,
  WriteNextChapterResult,
  WorldNode,
} from "./types"
import { ENDPOINTS } from "./types"
import type {
  Agent,
  AgentLog,
  Cast,
  Chapter,
  MemoryItem,
  ReviewIssue,
} from "@/lib/studio-data"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"

type Asset = {
  id: string
  name: { zh: string; en: string }
  type: "doc" | "image" | "audio" | "video"
}

export class ApiClientError extends Error {
  readonly method: string
  readonly url: string
  readonly status: number
  readonly payload: unknown

  constructor(
    method: string,
    url: string,
    status: number,
    message: string,
    payload: unknown,
  ) {
    super(`[api] ${method} ${url} -> ${status}${message ? `: ${message}` : ""}`)
    this.name = "ApiClientError"
    this.method = method
    this.url = url
    this.status = status
    this.payload = payload
  }
}

// ----------------------------------------------------------------------
// 通用 fetch 包装：统一错误处理 + GET in-flight 去重
// ----------------------------------------------------------------------
const inflightGetRequests = new Map<string, Promise<unknown>>()

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const key = init?.signal ? null : `GET ${url}`
  const inflight = key ? inflightGetRequests.get(key) : null

  if (inflight) return inflight as Promise<T>

  const request = fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  }).then(async (res) => {
    if (!res.ok) {
      throw await apiError("GET", url, res)
    }
    return res.json() as Promise<T>
  })

  if (!key) return request

  inflightGetRequests.set(key, request)
  try {
    return await request
  } finally {
    if (inflightGetRequests.get(key) === request) {
      inflightGetRequests.delete(key)
    }
  }
}

async function postJSON<T>(
  url: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
    ...init,
  })
  if (!res.ok) {
    throw await apiError("POST", url, res)
  }
  return res.json() as Promise<T>
}

async function patchJSON<T>(
  url: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
    ...init,
  })
  if (!res.ok) {
    throw await apiError("PATCH", url, res)
  }
  return res.json() as Promise<T>
}

async function apiError(method: string, url: string, response: Response) {
  const text = await response.text().catch(() => "")
  const payload = parseApiErrorPayload(text)
  const detail = apiErrorDetail(payload, text)
  return new ApiClientError(method, url, response.status, detail, payload)
}

function parseApiErrorPayload(text: string) {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function apiErrorDetail(payload: unknown, text: string) {
  if (!text.trim()) return ""
  if (!isPlainObject(payload)) return text.slice(0, 240)

  const error = payload.error
  if (typeof error === "string" && error.trim()) return error
  if (isPlainObject(error) && typeof error.message === "string") {
    return error.message
  }

  return [payload.failureReason, payload.suggestion, payload.status]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ----------------------------------------------------------------------
// Agent / 工作流
// ----------------------------------------------------------------------
export function fetchAgents(): Promise<Agent[]> {
  return getJSON<Agent[]>(ENDPOINTS.agentList())
}

export function fetchWorkflow(bookId: string): Promise<WorkflowSnapshot> {
  return getJSON<WorkflowSnapshot>(ENDPOINTS.workflow(bookId))
}

export function fetchAgentLogs(
  bookId: string,
  chapter: number,
  agentId?: string,
): Promise<AgentLog[]> {
  return getJSON<AgentLog[]>(ENDPOINTS.agentLogs(bookId, chapter, agentId))
}

export function fetchRoleQueue(
  bookId: string,
  chapter: number,
): Promise<RoleQueueItem[]> {
  return getJSON<RoleQueueItem[]>(ENDPOINTS.roleQueue(bookId, chapter))
}

/** 推进工作流到下一阶段（POST） */
export function advanceWorkflow(
  bookId: string,
  body: { targetStage?: string; reason?: string },
): Promise<{ ok: true }> {
  return postJSON<{ ok: true }>(`${ENDPOINTS.workflow(bookId)}/advance`, body)
}

/** 推进章节到下一状态（POST） */
export function proceedChapter(
  bookId: string,
  chapterNum: number,
  body: { nextStatus: string },
): Promise<{ ok: true }> {
  return postJSON<{ ok: true }>(
    `${ENDPOINTS.chapter(bookId, chapterNum)}/proceed`,
    body,
  )
}

/** 触发续写 / 创作（POST） — 真正的流式由 SSE 推回 */
export function triggerContinue(
  bookId: string,
  chapterNum: number,
): Promise<{ ok: true; runId: string }> {
  return postJSON(ENDPOINTS.chapterContinue(bookId, chapterNum))
}

export function triggerPause(
  bookId: string,
  chapterNum: number,
): Promise<{ ok: true }> {
  return postJSON(ENDPOINTS.chapterPause(bookId, chapterNum))
}

export function triggerRewrite(
  bookId: string,
  chapterNum: number,
  body: { style?: string; range?: { from: number; to: number } },
): Promise<{ ok: true; runId: string }> {
  return postJSON(ENDPOINTS.chapterRewrite(bookId, chapterNum), body)
}

export function triggerReview(
  bookId: string,
  chapterNum: number,
): Promise<{ ok: true; runId: string }> {
  return postJSON(ENDPOINTS.chapterReview(bookId, chapterNum))
}

export function triggerPublish(
  bookId: string,
  chapterNum: number,
): Promise<{ ok: true }> {
  return postJSON(ENDPOINTS.chapterPublish(bookId, chapterNum))
}

// ----------------------------------------------------------------------
// 书 / 章节
// ----------------------------------------------------------------------
export function fetchBook(bookId: string): Promise<Book> {
  return getJSON<Book>(ENDPOINTS.bookDetail(bookId))
}

export function fetchBooks(): Promise<BookSummary[]> {
  return getJSON<BookSummary[]>(ENDPOINTS.bookList())
}

export function createBook(
  input: BookCreateInput,
): Promise<BookCreateResult> {
  return postJSON<BookCreateResult>(ENDPOINTS.bookCreate(), input)
}

/** 取消进行中的建书(停 run、释放写锁、abort job)。后端无进行中任务会返回 409。 */
export function cancelBookCreate(
  bookId: string,
): Promise<{ ok?: boolean; status?: string }> {
  return postJSON(ENDPOINTS.bookCreateCancel(bookId))
}

/** 删除整本书(含半成品):取消未完成工作流 + 删本地目录。 */
export function deleteBook(bookId: string): Promise<{ ok?: boolean; bookId?: string }> {
  return postJSON(ENDPOINTS.bookDetail(bookId), undefined, { method: "DELETE" })
}

export function updateBook(
  bookId: string,
  input: BookUpdateInput,
): Promise<Book> {
  return patchJSON<Book>(ENDPOINTS.bookDetail(bookId), input)
}

export function bookExportUrl(bookId: string, format = "txt") {
  return ENDPOINTS.bookExport(bookId, format)
}

export function fetchBookDescription(
  bookId: string,
): Promise<BookDescriptionResult> {
  return getJSON<BookDescriptionResult>(ENDPOINTS.bookDescription(bookId))
}

export function generateBookDescription(
  bookId: string,
): Promise<BookDescriptionResult> {
  return postJSON<BookDescriptionResult>(ENDPOINTS.bookDescription(bookId), {
    useLLM: true,
  })
}

export function validateBookFoundation(
  bookId: string,
): Promise<BookFoundationValidateResult> {
  return postJSON<BookFoundationValidateResult>(
    ENDPOINTS.bookFoundationValidate(bookId),
  )
}

export function fetchBookCreateStatus(bookId: string): Promise<BookCreateStatus> {
  return getJSON<BookCreateStatus>(ENDPOINTS.bookCreateStatus(bookId))
}

export async function waitForBookCreateStatus(
  bookId: string,
  options: {
    runId?: string
    timeoutMs?: number
    intervalMs?: number
    onStatus?: (status: BookCreateStatus) => void
  } = {},
): Promise<BookCreateStatus> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? 2_000
  const deadline = Date.now() + timeoutMs
  let latest = await fetchCreateStatusOrRunFallback(bookId, options.runId)
  options.onStatus?.(latest)

  while (isPendingBookCreateStatus(latest.status) && Date.now() < deadline) {
    await delay(intervalMs)
    latest = await fetchCreateStatusOrRunFallback(bookId, options.runId, latest)
    options.onStatus?.(latest)
  }

  if (isPendingBookCreateStatus(latest.status)) {
    const stalled: BookCreateStatus = {
      ...latest,
      status: "stalled",
      warning: "建书状态轮询超时，已停止前端等待；请查看运行记录或重试建书。",
    }
    options.onStatus?.(stalled)
    return stalled
  }

  return latest
}

async function fetchCreateStatusOrRunFallback(
  bookId: string,
  runId?: string,
  previous?: BookCreateStatus,
): Promise<BookCreateStatus> {
  try {
    const status = await fetchBookCreateStatus(bookId)
    if (!isPendingBookCreateStatus(status.status)) return status
    const runStatus = await resolveCreateRunStatus(bookId, runId, status)
    return runStatus ?? status
  } catch (error) {
    const runStatus = await resolveCreateRunStatus(bookId, runId, previous)
    if (runStatus) return runStatus
    if (previous) {
      return {
        ...previous,
        status: "stalled",
        warning: error instanceof Error ? error.message : String(error),
      }
    }
    throw error
  }
}

async function resolveCreateRunStatus(
  bookId: string,
  runId?: string,
  status?: BookCreateStatus,
): Promise<BookCreateStatus | null> {
  if (!runId) return null
  try {
    const run = await fetchAutoRun(runId)
    if (run.status === "failed" || run.status === "paused" || run.status === "cancelled") {
      return {
        ...status,
        bookId,
        runId,
        status: run.status === "paused" ? "stalled" : "error",
        stage: run.currentStage ?? status?.stage,
        agent: run.currentAgentId ?? status?.agent,
        error: run.error ?? status?.error,
        failureReason: run.failureReason ?? status?.failureReason,
        suggestion: run.suggestion ?? status?.suggestion,
      }
    }
    if (run.status === "completed") {
      return {
        ...status,
        bookId,
        runId,
        status: "created",
        stage: run.currentStage ?? status?.stage,
        agent: run.currentAgentId ?? status?.agent,
      }
    }
  } catch {
    return null
  }
  return null
}

function isPendingBookCreateStatus(status: string) {
  return ["creating", "queued", "running"].includes(status)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function fetchChapters(bookId: string): Promise<Chapter[]> {
  return getJSON<Chapter[]>(ENDPOINTS.chapters(bookId))
}

/** 逐章读者信号(读者评审官产出:愿意追更 / hook / 沉浸 / 清晰度 …) */
export type ReaderSignal = {
  chapter: number
  title: string
  quality: number | null
  readerScore: number | null
  verdict: string
  hook: number | null
  immersion: number | null
  clarity: number | null
  readOn: number | null
}
export type ReaderFeedback = {
  signals: ReaderSignal[]
  summary: { count: number; avgReadOn: number; willFollowPct: number }
}

type RawBookQuality = {
  chapters?: {
    chapterNumber?: number
    title?: string
    quality?: {
      total?: number
      reader?: {
        total?: number
        verdict?: string
        metrics?: { hook?: number; immersion?: number; clarity?: number; readOn?: number }
      }
    }
  }[]
}

export async function fetchReaderFeedback(bookId: string): Promise<ReaderFeedback> {
  const raw = await getJSON<RawBookQuality>(`/api/v1/books/${encodeURIComponent(bookId)}/quality`)
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const signals: ReaderSignal[] = (raw.chapters ?? [])
    .filter((c) => c.quality?.reader)
    .map((c) => {
      const r = c.quality?.reader
      const m = r?.metrics ?? {}
      return {
        chapter: n(c.chapterNumber) ?? 0,
        title: String(c.title ?? "").replace(/\.md$/, ""),
        quality: n(c.quality?.total),
        readerScore: n(r?.total),
        verdict: String(r?.verdict ?? "—"),
        hook: n(m.hook),
        immersion: n(m.immersion),
        clarity: n(m.clarity),
        readOn: n(m.readOn),
      }
    })
    .sort((a, b) => a.chapter - b.chapter)
  const withReadOn = signals.filter((s) => s.readOn != null)
  const avgReadOn = withReadOn.length
    ? Math.round(withReadOn.reduce((s, x) => s + (x.readOn as number), 0) / withReadOn.length)
    : 0
  const willFollow = signals.filter((s) => s.verdict.includes("愿意追更")).length
  const willFollowPct = signals.length ? Math.round((willFollow / signals.length) * 100) : 0
  return { signals, summary: { count: signals.length, avgReadOn, willFollowPct } }
}

/** 总编(Editor-in-Chief)整章编辑裁决 */
export type EditorialReworkTarget = { agent: string; what: string }
export type EditorialReview = {
  verdict: "pass" | "rework"
  editorialScore: number | null
  rationale: string
  strengths: string[]
  risks: string[]
  reworkTargets: EditorialReworkTarget[]
  nextDirection: string
  chapterNumber?: number
  machineTotal?: number | null
  gateTarget?: number
  gatePass?: boolean
  model?: string
  skill?: string | null
  generatedAt?: string
}
export function fetchEditorialReview(
  bookId: string,
  num: number,
): Promise<{ review: EditorialReview | null; cached: boolean }> {
  return getJSON(`/api/v1/books/${encodeURIComponent(bookId)}/chapters/${num}/editorial-review`)
}
export function generateEditorialReview(
  bookId: string,
  num: number,
): Promise<{ review: EditorialReview }> {
  return postJSON(`/api/v1/books/${encodeURIComponent(bookId)}/chapters/${num}/editorial-review`, {})
}

/** 每章交接(handoff)透明面板:谁做了什么 · 读了什么(有界注入)· 是否回写传给下一章 */
export type HandoffTone = "ok" | "warn" | "risk" | "info"
export type HandoffAgent = { id: string; role: string; did: string; signal: string; tone: HandoffTone }
export type HandoffSource = { source: string; reason: string; preview: string }
export type ChapterHandoff = {
  bookId: string
  chapterNumber: number
  title: string
  generatedAt: string
  agents: HandoffAgent[]
  reads: {
    captured: boolean
    capturedAt: string
    stale: boolean
    truthSources: string[]
    recentSummaries: number[]
    hookCount: number
    totalChapters: number
    sources: HandoffSource[]
    boundedNote: string
  }
  writeback: { summaryWritten: boolean; currentStateUpdatedAt: string; note: string }
  opinions: {
    audit: { severity: string; category: string; message: string }[]
    reader: { verdict: string; total: number | null; metrics: Record<string, number> } | null
    editorial: { verdict: string; editorialScore: number | null; rationale: string; reworkTargets: EditorialReworkTarget[]; nextDirection: string } | null
  }
  quality: { total: number | null; band: string; gate: { target: number | null; pass: boolean; blockers: string[] }; metrics: Record<string, number> }
}
export function fetchChapterHandoff(bookId: string, num: number): Promise<ChapterHandoff> {
  return getJSON(`/api/v1/books/${encodeURIComponent(bookId)}/chapters/${num}/handoff`)
}

/** 本章修订快照(写手原稿→定稿 + 每轮修复 before/after),供评审视图做红删/绿增 diff */
export function fetchChapterRevisions(
  bookId: string,
  num: number,
): Promise<ChapterRevisionsResult> {
  return getJSON<ChapterRevisionsResult>(ENDPOINTS.chapterRevisions(bookId, num))
}

/** 活的故事知识图谱(实体 + 时序关系,矛盾自纠错)。前端交互式图谱 + 实体详情页消费。 */
export type StoryGraphNode = {
  id: string
  name: string
  type: string
  summary: string
  aliases: string[]
  firstChapter: number
  lastChapter: number
  degree: number
  state: { predicate: string; object: string }[]
}
export type StoryGraphEdge = { source: string; target: string; predicate: string; sinceChapter: number }
export type StoryGraph = {
  bookId: string
  stats: { entities: number; relations: number; activeRelations: number }
  nodes: StoryGraphNode[]
  edges: StoryGraphEdge[]
  fallback?: string
  source?: string
  unavailable?: boolean
}
export function fetchStoryGraph(bookId: string): Promise<StoryGraph> {
  return getJSON(`/api/v1/books/${encodeURIComponent(bookId)}/story-graph`)
}

/** 作品分析(含 token 用量统计)——后端 computeAnalytics,只读 */
export type BookTokenStats = {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  avgTokensPerChapter: number
  recentTrend: { chapter: number; totalTokens: number }[]
}
export type BookAnalytics = {
  bookId: string
  totalChapters?: number
  totalWords?: number
  avgWordsPerChapter?: number
  tokenStats?: BookTokenStats
}
export function fetchBookAnalytics(bookId: string): Promise<BookAnalytics> {
  return getJSON(`/api/v1/books/${encodeURIComponent(bookId)}/analytics`)
}

export type StoryEntityRelation = { predicate: string; subject: string; object: string; objectIsEntity: boolean; sinceChapter: number; incoming: boolean }
export type StoryEntityDetail = {
  bookId: string
  entity: { id: string; name: string; type: string; summary: string; aliases: string; firstChapter: number; lastChapter: number }
  state: { predicate: string; object: string; sinceChapter: number }[]
  relations: StoryEntityRelation[]
  neighbors: { id: string; name: string; type: string; summary: string }[]
  fallback?: string
  source?: string
  unavailable?: boolean
}
export function fetchStoryEntity(bookId: string, name: string): Promise<StoryEntityDetail> {
  return getJSON(`/api/v1/books/${encodeURIComponent(bookId)}/story-graph/entity/${encodeURIComponent(name)}`)
}

/** 多平台成品(内容库) */
export type ContentDraft = {
  id: string
  contentType: string
  platformLabel: string
  title: string
  brief: string
  finalScore: number | null
  revised: boolean
  chars: number
  createdAt: string
  excerpt: string
  markdown: string
}
export function fetchContentDrafts(): Promise<{ drafts: ContentDraft[]; total: number }> {
  return getJSON("/api/v1/content-drafts")
}
export function deleteContentDraft(id: string): Promise<{ ok: boolean }> {
  return getJSON(`/api/v1/content-drafts/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export function startWriteNextChapter(
  bookId: string,
  input: WriteNextChapterInput = {},
): Promise<WriteNextChapterResult> {
  return postJSON<WriteNextChapterResult>(ENDPOINTS.bookWriteNext(bookId), input)
}

/**
 * 连续写 N 章:每章写完按质量门槛(targetScore)把关,达不到先自动原地复修,
 * 修不到就停在那一章(不会硬往下写)。这是"设定连续写 N 章、不够分就停"的真实入口。
 */
export function startWriteBatch(
  bookId: string,
  input: { chapters: number; targetScore?: number; wordCount?: number; maxRewritesPerChapter?: number },
): Promise<{ status?: string; runId?: string; total?: number }> {
  return postJSON(ENDPOINTS.bookWriteBatch(bookId), input)
}

/**
 * 拉取本书真实任务运行(后端 task_runs)。用于判断"是否正在写作 / 当前 agent / 当前阶段"。
 * 替代 404 的 auto-runs 引擎 —— 这是写作状态的唯一真相来源。
 */
export async function fetchBookRuns(
  bookId: string,
  limit = 8,
): Promise<BookRun[]> {
  const data = await getJSON<{ runs?: BookRun[] } | BookRun[]>(
    ENDPOINTS.bookRuns(bookId, limit),
  )
  return Array.isArray(data) ? data : (data.runs ?? [])
}

/** 停止本书全部进行中的工作流(真实端点 /workflow/stop) */
export function stopBookWorkflow(
  bookId: string,
  reason?: string,
): Promise<{ ok?: boolean; cancelled?: number; releasedLocks?: number }> {
  return postJSON(ENDPOINTS.bookWorkflowStop(bookId), reason ? { reason } : {})
}

export function repairBookState(
  bookId: string,
  body: { forceTakeover?: boolean } = {},
): Promise<BookRepairStateResult> {
  return postJSON<BookRepairStateResult>(ENDPOINTS.bookRepairState(bookId), body)
}

export function startRepairQualityBatch(
  bookId: string,
  input: BookRepairQualityBatchInput = {},
): Promise<BookRepairQualityBatchResult> {
  return postJSON<BookRepairQualityBatchResult>(
    ENDPOINTS.bookRepairQualityBatch(bookId),
    input,
  )
}

// ----------------------------------------------------------------------
// 关系图谱（从书里提取）
// ----------------------------------------------------------------------
export function fetchRelationshipGraph(
  bookId: string,
  focusId?: string,
): Promise<RelationshipGraph> {
  const url = focusId
    ? `${ENDPOINTS.relationshipGraph(bookId)}?focusId=${encodeURIComponent(focusId)}`
    : ENDPOINTS.relationshipGraph(bookId)
  return getJSON<RelationshipGraph>(url)
}

// ----------------------------------------------------------------------
// 剧情推进
// ----------------------------------------------------------------------
export function fetchPlotProgress(bookId: string): Promise<PlotProgress> {
  return getJSON<PlotProgress>(ENDPOINTS.plotProgress(bookId))
}

// ----------------------------------------------------------------------
// 记忆
// ----------------------------------------------------------------------
export function fetchMemory(
  bookId: string,
  kind?: MemoryItem["kind"],
): Promise<MemoryItem[]> {
  const url = kind
    ? `${ENDPOINTS.memory(bookId)}?kind=${encodeURIComponent(kind)}`
    : ENDPOINTS.memory(bookId)
  return getJSON<MemoryItem[]>(url)
}

// ----------------------------------------------------------------------
// 风格 / 质量 / 市场 / Dock / 系统
// ----------------------------------------------------------------------
export function fetchStyleFingerprint(
  bookId: string,
): Promise<StyleFingerprint> {
  return getJSON<StyleFingerprint>(ENDPOINTS.styleFingerprint(bookId))
}

export function fetchQuality(
  bookId: string,
  chapter: number,
): Promise<QualityMetrics> {
  return getJSON<QualityMetrics>(ENDPOINTS.quality(bookId, chapter))
}

/** 章节质量原始 payload（含 9 维 metrics + gate + reasons），可带用户设定的达标分 */
export type ChapterQualityRaw = {
  title?: string
  quality?: {
    total?: number
    band?: string
    metrics?: Record<string, number>
    stats?: Record<string, number>
    reasons?: string[]
    gate?: { pass?: boolean; target?: number; blockers?: string[]; rule?: string }
  }
  auditIssues?: string[]
}

export function fetchChapterQualityRaw(
  bookId: string,
  chapter: number,
  targetScore?: number,
): Promise<ChapterQualityRaw> {
  const base = ENDPOINTS.quality(bookId, chapter)
  const url =
    typeof targetScore === "number" && targetScore > 0
      ? `${base}?targetScore=${encodeURIComponent(String(targetScore))}`
      : base
  return getJSON<ChapterQualityRaw>(url)
}

export function fetchOpportunities(): Promise<MarketOpportunity[]> {
  return getJSON<MarketOpportunity[]>(ENDPOINTS.marketOpportunities())
}

export function fetchDockMetrics(bookId: string): Promise<DockMetrics> {
  return getJSON<DockMetrics>(ENDPOINTS.dockMetrics(bookId))
}

export function fetchSystemHealth(): Promise<SystemHealth> {
  return getJSON<SystemHealth>(ENDPOINTS.systemHealth())
}

// ----------------------------------------------------------------------
// 角色 / 世界 / 资产 / 大纲 / 渠道 / 正文 / 改写 / 章节统计 / 审稿
// ----------------------------------------------------------------------
export function fetchCast(bookId: string): Promise<Cast[]> {
  return getJSON<Cast[]>(ENDPOINTS.cast(bookId))
}

export function fetchWorld(bookId: string): Promise<WorldNode[]> {
  return getJSON<WorldNode[]>(ENDPOINTS.world(bookId))
}

export function fetchAssets(bookId: string): Promise<Asset[]> {
  return getJSON<Asset[]>(ENDPOINTS.assets(bookId))
}

export function fetchOutline(bookId: string): Promise<OutlineAct[]> {
  return getJSON<OutlineAct[]>(ENDPOINTS.outline(bookId))
}

export function fetchPublishChannels(
  bookId: string,
): Promise<PublishChannel[]> {
  return getJSON<PublishChannel[]>(ENDPOINTS.publishChannels(bookId))
}

export function fetchManuscript(
  bookId: string,
  chapterNum: number,
): Promise<Manuscript> {
  return getJSON<Manuscript>(ENDPOINTS.manuscript(bookId, chapterNum))
}

export function saveManuscript(
  bookId: string,
  chapterNum: number,
  input: { content: string; locale?: "zh" | "en" },
): Promise<Manuscript> {
  return patchJSON<Manuscript>(ENDPOINTS.manuscript(bookId, chapterNum), input)
}

export function fetchChapterStats(
  bookId: string,
  chapterNum: number,
): Promise<ChapterStats> {
  return getJSON<ChapterStats>(ENDPOINTS.chapterStats(bookId, chapterNum))
}

export function fetchReviewIssues(
  bookId: string,
  chapterNum: number,
): Promise<ReviewIssue[]> {
  return getJSON<ReviewIssue[]>(ENDPOINTS.reviewIssues(bookId, chapterNum))
}

export function fetchRewriteProposal(
  bookId: string,
  chapterNum: number,
  style?: string,
): Promise<RewriteProposal> {
  return getJSON<RewriteProposal>(
    ENDPOINTS.rewriteProposal(bookId, chapterNum, style),
  )
}

// ----------------------------------------------------------------------
// 自动续写引擎
// ----------------------------------------------------------------------
export function fetchAutoRuns(): Promise<AutoRun[]> {
  return getJSON<AutoRun[]>(ENDPOINTS.autoRuns())
}

export function fetchAutoRun(id: string): Promise<AutoRun> {
  return getJSON<AutoRun>(ENDPOINTS.autoRun(id))
}

export function createAutoRun(input: AutoRunCreate): Promise<AutoRun> {
  return postJSON<AutoRun>(ENDPOINTS.autoRuns(), input)
}

export function pauseAutoRun(id: string): Promise<AutoRun> {
  return postJSON<AutoRun>(ENDPOINTS.autoRunPause(id))
}

export function resumeAutoRun(id: string): Promise<AutoRun> {
  return postJSON<AutoRun>(ENDPOINTS.autoRunResume(id))
}

export function cancelAutoRun(id: string): Promise<AutoRun> {
  return postJSON<AutoRun>(ENDPOINTS.autoRunCancel(id))
}

// ----------------------------------------------------------------------
// Agent Lab
// ----------------------------------------------------------------------
export function fetchAgentProfiles(): Promise<AgentProfile[]> {
  return getJSON<AgentProfile[]>(ENDPOINTS.agentProfiles())
}
export function fetchAgentProfile(id: string): Promise<AgentProfile> {
  return getJSON<AgentProfile>(ENDPOINTS.agentProfile(id))
}
export function updateAgentProfile(
  id: string,
  patch: Partial<AgentProfile>,
  note?: string,
): Promise<AgentProfile> {
  return patchJSON<AgentProfile>(ENDPOINTS.agentProfile(id), { patch, note })
}
export function restoreAgentProfileVersion(
  id: string,
  versionId: string,
): Promise<AgentProfile> {
  return patchJSON<AgentProfile>(ENDPOINTS.agentProfile(id), {
    action: "restore",
    versionId,
  })
}
export function testAgentProfile(id: string): Promise<ConnectivityResult> {
  return postJSON<ConnectivityResult>(ENDPOINTS.agentConnectivityOne(id))
}
export function testAllAgentProfiles(): Promise<ConnectivityResult[]> {
  return postJSON<ConnectivityResult[]>(ENDPOINTS.agentConnectivity())
}
export function fetchWorkflowContract(): Promise<WorkflowContract> {
  return getJSON<WorkflowContract>(ENDPOINTS.workflowContract())
}

// ----------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------
export function fetchLLMProviders(): Promise<LLMProvider[]> {
  return getJSON<LLMProvider[]>(ENDPOINTS.llmProviders())
}
export function fetchLLMProvider(id: string): Promise<LLMProvider> {
  return getJSON<LLMProvider>(ENDPOINTS.llmProvider(id))
}
export function updateLLMProvider(
  id: string,
  patch: LLMProviderPatch,
): Promise<LLMProvider> {
  return patchJSON<LLMProvider>(ENDPOINTS.llmProvider(id), patch)
}
export function createLLMProvider(
  input: LLMProviderCreateInput,
): Promise<LLMProvider> {
  return postJSON<LLMProvider>(ENDPOINTS.llmProviders(), input)
}
export function testLLMProvider(
  id: string,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  return postJSON<{ ok: boolean; latencyMs: number; error?: string }>(
    ENDPOINTS.llmProviderTest(id),
  )
}
export function fetchProjectPrefs(): Promise<ProjectPrefs> {
  return getJSON<ProjectPrefs>(ENDPOINTS.projectPrefs())
}
export function updateProjectPrefs(
  patch: Partial<ProjectPrefs>,
): Promise<ProjectPrefs> {
  return patchJSON<ProjectPrefs>(ENDPOINTS.projectPrefs(), patch)
}

// ----------------------------------------------------------------------
// Wiki
// ----------------------------------------------------------------------
export function fetchWiki(bookId: string): Promise<WikiResponse> {
  return getJSON<WikiResponse>(ENDPOINTS.wiki(bookId))
}
export function updateWikiNode(
  bookId: string,
  nodeId: string,
  patch: Partial<Pick<WikiNode, "body" | "title" | "tags">>,
): Promise<WikiNode> {
  return patchJSON<WikiNode>(ENDPOINTS.wikiNode(bookId, nodeId), patch)
}

export type WikiAgentFeedResult = {
  ok: boolean
  agentId: string
  bookId: string
  result?: unknown
}

export function feedWikiNodeToAgent(
  agentId: string,
  input: {
    bookId: string
    node: WikiNode
    text?: string
    reason?: string
    expiresInMinutes?: number
  },
): Promise<WikiAgentFeedResult> {
  return postJSON<WikiAgentFeedResult>(ENDPOINTS.agentProfileFeed(agentId), input)
}

// ----------------------------------------------------------------------
// SSE 实时事件订阅（仅浏览器端）
//
// 所有 agent / workflow / metric / log / token 事件通过单一 SSE 通道推送，
// 由 type 字段区分。后端按 docs/API.md 中的事件契约实现即可。
// ----------------------------------------------------------------------
type AgentEventMeta = {
  ts: string
  rawEvent?: string
  runId?: string
  bookId?: string
  chapterNumber?: number
  payload?: Record<string, unknown>
}

export type AgentEvent =
  | (AgentEventMeta & { type: "agent-status"; agentId: string; status: string; load?: number })
  | (AgentEventMeta & { type: "stage-update"; stage: string; progress: number })
  | (AgentEventMeta & { type: "log"; agentId: string; level: "info" | "warn" | "error"; message: string })
  | (AgentEventMeta & { type: "token"; agentId: string; chapter: number; text: string; stage?: string })
  | (AgentEventMeta & { type: "metric"; key: string; value: number | string })
  | (AgentEventMeta & { type: "memory-add"; id: string })
  | (AgentEventMeta & { type: "graph-update"; bookId: string; version: number })
  | (AgentEventMeta & {
      type: "verdict"
      agentId: string
      chapter: number
      verdict: string
      score?: number
      rationale: string
    })
  | (AgentEventMeta & {
      type: "audit"
      agentId: string
      chapter: number
      passed: boolean
      summary?: string
      issues?: number
      score?: number
    })
  | (AgentEventMeta & { type: "ping" })

const SSE_EVENT_NAMES = [
  "workflow:status",
  "workflow:stopped",
  "watchdog:stale",
  "book:create:materialized",
  "write:queued",
  "write:start",
  "write:complete",
  "write:needs-repair",
  "write:error",
  "write:auto-repair:start",
  "write:blocked-foundation",
  "write:blocked-quality-gate",
  "batch:start",
  "batch:chapter:start",
  "batch:auto-repair:start",
  "batch:needs-repair",
  "batch:complete",
  "batch:error",
  "batch:blocked-foundation",
  "chapter:quality-repair:start",
  "chapter:quality-repair:stage",
  "chapter:quality-repair",
  "chapter:quality-repair:error",
  "quality-batch:start",
  "quality-batch:done",
  "quality-batch:check",
  "quality-batch:repair",
  "quality-batch:chapter-pass",
  "quality-batch:needs-repair",
  "quality-batch:blocked-foundation",
  "quality-batch:blocked-quality-gate",
  "quality-batch:write:start",
  "quality-batch:write-repair",
  "quality-batch:write:needs-recovery",
  "quality-batch:complete",
  "quality-batch:error",
  "quality-batch:lessons",
  "quality-gate:auto-heal",
  "prompt-governance:applied",
  "state-repair:start",
  "state-repair:done",
  "state-repair:complete",
  "state-repair:error",
  "agent:start",
  "agent:stage",
  "agent:complete",
  "agent:error",
  "audit:start",
  "audit:complete",
  "audit:error",
  "editor-in-chief:verdict",
  "thinking:start",
  "thinking:delta",
  "thinking:end",
  "llm:delta",
  "llm:progress",
  "run:heartbeat",
  // 管线日志流(后端 createLogger 的 SSE sink 广播 broadcast("log",...)):
  // 不在此订阅,前端 EventSource 不会注册 "log" 监听 → 所有 logWarn/logStage 永远到不了前台。
  "log",
  "ping",
] as const

export async function fetchAgentEvents(bookId: string): Promise<AgentEvent[]> {
  const rows = await getJSON<unknown[]>(ENDPOINTS.bookAgentEvents(bookId))
  return rows.map(normalizeAgentEvent).filter((event): event is AgentEvent => Boolean(event))
}

export function subscribeAgentEvents(
  bookId: string,
  onEvent: (e: AgentEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  if (typeof window === "undefined") return () => {}
  const url = `/api/v1/books/${encodeURIComponent(bookId)}/events`
  const es = new EventSource(url)

  const handleEvent = (msg: MessageEvent) => {
    try {
      const event = normalizeAgentEvent(JSON.parse(msg.data))
      if (event) onEvent(event)
    } catch {
      // ignore malformed
    }
  }
  es.onmessage = handleEvent
  SSE_EVENT_NAMES.forEach((name) => es.addEventListener(name, handleEvent))
  if (onError) es.onerror = onError
  return () => es.close()
}

function normalizeAgentEvent(raw: unknown): AgentEvent | null {
  if (!isPlainObject(raw)) return null
  const type = typeof raw.type === "string" ? raw.type : ""
  const data = isPlainObject(raw.data) ? raw.data : {}
  const eventName = stringValue(raw.event)
  const ts =
    stringValue(raw.ts) ||
    stringValue(raw.time) ||
    stringValue(raw.timestamp) ||
    new Date().toISOString()
  const meta = eventMeta(raw, data, eventName, ts)

  if (isKnownAgentEvent(raw, type, ts)) {
    return "agentId" in raw && typeof raw.agentId === "string"
      ? { ...raw, ...meta, agentId: toFrontendAgentId(raw.agentId), ts } as AgentEvent
      : { ...raw, ...meta, ts } as AgentEvent
  }
  if (type === "ping" || raw.event === "ping") return { type: "ping", ...meta, ts }

  const agentId = toFrontendAgentId(
    stringValue(raw.agentId) ||
      stringValue(raw.roleId) ||
      stringValue(data.agent) ||
      stringValue(data.roleId) ||
      stringValue(data.role) ||
      "system",
  )
  const stage =
    stringValue(raw.stage) ||
    stringValue(data.stage) ||
    (type && !isTypedBackendEvent(type) ? type : "") ||
    stringValue(raw.summary) ||
    stringValue(eventName) ||
    "状态更新"
  const content =
    stringValue(raw.content) ||
    stringValue(data.text) ||
    stringValue(data.output) ||
    stringValue(data.detail) ||
    stringValue(data.message) ||
    stringValue(raw.summary) ||
    stringValue(data.failureReason) ||
    stringValue(data.error)
  const progress = numberValue(data.progress) ?? numberValue(raw.progress) ?? 0

  // 总编整章裁决 —— 通过/返工 + 总编批语 + 评分。
  if (eventName === "editor-in-chief:verdict" || type === "verdict") {
    const chapter =
      numberValue(data.chapterNumber) ??
      numberValue(data.chapter) ??
      numberValue(raw.chapterNumber) ??
      numberValue(raw.chapter) ??
      0
    return {
      type: "verdict",
      ...meta,
      agentId: "editor-in-chief",
      chapter,
      chapterNumber: chapter || meta.chapterNumber,
      verdict:
        stringValue(data.verdict) ||
        stringValue(raw.verdict) ||
        stringValue(data.decision) ||
        "",
      score:
        numberValue(data.editorialScore) ??
        numberValue(raw.editorialScore) ??
        numberValue(data.score),
      rationale:
        stringValue(data.rationale) ||
        stringValue(raw.rationale) ||
        stringValue(data.note) ||
        content,
      ts,
    }
  }

  // 连续性审稿结论 —— 审稿官（continuity auditor）。agentId 复用前端「审稿官」=editor。
  if (eventName === "audit:complete" || type === "audit") {
    const chapter =
      numberValue(data.chapter) ??
      numberValue(data.chapterNumber) ??
      numberValue(raw.chapter) ??
      numberValue(raw.chapterNumber) ??
      0
    const passedRaw = data.passed ?? raw.passed
    return {
      type: "audit",
      ...meta,
      agentId: toFrontendAgentId("auditor"),
      chapter,
      chapterNumber: chapter || meta.chapterNumber,
      passed: passedRaw === true || passedRaw === "true",
      summary:
        stringValue(data.summary) ||
        stringValue(raw.summary) ||
        content ||
        undefined,
      issues:
        numberValue(data.issues) ??
        numberValue(raw.issues) ??
        (Array.isArray(data.issues) ? data.issues.length : undefined),
      score: numberValue(data.score) ?? numberValue(raw.score),
      ts,
    }
  }

  if (eventName === "llm:delta" || eventName === "token" || type === "token") {
    const chapter =
      numberValue(data.chapterNumber) ??
      numberValue(data.currentChapter) ??
      numberValue(data.chapter) ??
      numberValue(raw.chapterNumber) ??
      numberValue(raw.currentChapter) ??
      numberValue(raw.chapter) ??
      0
    return {
      type: "token",
      ...meta,
      agentId,
      chapter,
      chapterNumber: chapter || meta.chapterNumber,
      text: content,
      stage,
      ts,
    }
  }

  if (eventName === "llm:progress" || type === "metric") {
    return {
      type: "metric",
      ...meta,
      key: stage,
      value: content || progress,
      ts,
    }
  }

  if (stage) {
    return {
      type: "stage-update",
      ...meta,
      stage: [agentId !== "system" ? agentId : "", stage, content]
        .filter(Boolean)
        .join(" · "),
      progress,
      ts,
    }
  }

  // 统一日志/错误归类:任何 *:error 事件一律 error 级;log 事件用其自带 level;
  // 其余退回 severity 推断。确保错误真的以 error 级别浮到前台(toast/错误面板)。
  const rawLevel = stringValue(data.level) || stringValue(raw.level)
  const isErrorEvent = eventName.endsWith(":error") || eventName === "watchdog:stale"
  const level: "info" | "warn" | "error" = isErrorEvent
    ? "error"
    : rawLevel === "error" || rawLevel === "warn" || rawLevel === "info"
      ? rawLevel
      : severityToLevel(raw.severity)
  return {
    type: "log",
    ...meta,
    agentId,
    level,
    message: content || eventName || "状态更新",
    ts,
  }
}

function eventMeta(
  raw: Record<string, unknown>,
  data: Record<string, unknown>,
  eventName: string,
  ts: string,
): AgentEventMeta {
  const chapterNumber =
    numberValue(data.chapterNumber) ??
    numberValue(data.currentChapter) ??
    numberValue(data.chapter) ??
    numberValue(raw.chapterNumber) ??
    numberValue(raw.currentChapter) ??
    numberValue(raw.chapter)
  return {
    ts,
    rawEvent: eventName || stringValue(raw.type),
    runId: stringValue(data.runId) || stringValue(raw.runId) || undefined,
    bookId: stringValue(data.bookId) || stringValue(raw.bookId) || undefined,
    chapterNumber,
    payload: data,
  }
}

function isKnownAgentEvent(
  raw: Record<string, unknown>,
  type: string,
  ts: string,
): raw is AgentEvent {
  if (
    type === "agent-status" &&
    typeof raw.agentId === "string" &&
    typeof raw.status === "string"
  ) return true
  if (type === "stage-update" && typeof raw.stage === "string") return true
  if (type === "log" && typeof raw.agentId === "string" && typeof raw.message === "string") return true
  if (type === "token" && typeof raw.agentId === "string" && typeof raw.text === "string") return true
  if (type === "metric" && typeof raw.key === "string") return true
  if (type === "memory-add" && typeof raw.id === "string") return true
  if (type === "graph-update" && typeof raw.bookId === "string") return true
  if (type === "verdict" && typeof raw.verdict === "string") return true
  if (type === "audit" && typeof raw.passed === "boolean") return true
  if (type === "ping") {
    raw.ts = ts
    return true
  }
  return false
}

function isTypedBackendEvent(type: string) {
  return ["agent-status", "stage-update", "log", "token", "metric", "memory-add", "graph-update", "verdict", "audit", "ping"].includes(type)
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function severityToLevel(value: unknown): "info" | "warn" | "error" {
  if (value === "error") return "error"
  if (value === "warning" || value === "warn") return "warn"
  return "info"
}
