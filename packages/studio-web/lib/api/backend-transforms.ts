import {
  AGENTS,
  WORKFLOW_STAGES,
  type AgentStatus,
  type Chapter,
  type ReviewIssue,
  type WorkflowStage,
} from "@/lib/studio-data"
import { AGENT_PROFILES_SEED } from "@/lib/agent-prompts-seed"
import { sameAgentId, toBackendAgentId, toFrontendAgentId } from "@/lib/api/agent-aliases"
import {
  LLM_PROVIDERS_SEED,
  PROJECT_PREFS_SEED,
} from "@/lib/studio-seeds"
import type {
  AgentProfile,
  AutoRun,
  AutoRunEvent,
  Book,
  BookCreateStatus,
  BookSummary,
  ChapterStats,
  ConnectivityResult,
  DockMetrics,
  LLMProvider,
  Manuscript,
  ProjectPrefs,
  QualityMetrics,
  RewriteProposal,
  RoleQueueItem,
  SystemHealth,
  WorkflowContract,
  WorkflowSnapshot,
  WikiKind,
  WikiNode,
  WikiResponse,
} from "./types"
import {
  bilingual,
  isRecord,
  pickArray,
  pickObject,
  toEpoch,
  type JsonRecord,
} from "./facade"

const ACCENTS = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-2)",
  "var(--chart-4)",
  "var(--chart-5)",
]

const BOOK_TYPES: Book["type"][] = ["novel-long", "novel-short", "story"]
const STAGE_IDS = WORKFLOW_STAGES.map((stage) => stage.id)
const DEFAULT_MODEL_HINT = "mimo-v2.5-pro"
const RECOVERABLE_RUN_TEXT_RE =
  /服务重启中断|旧锁已释放|lost in-memory owner|restart|等待继续复修|低分修复未达标|模型返回内容过短/i

export function normalizeBookSummaries(data: unknown): BookSummary[] {
  const books = records(data, ["books", "items", "data"])
  return books.map((book, index) => normalizeBookSummary(book, index))
}

export function normalizeBookCreateStatus(data: unknown): BookCreateStatus {
  const source = asRecord(data)
  const rawBook = first(source, ["book"])
  const normalizedBook = isRecord(rawBook)
    ? normalizeBookSummary(rawBook, 0, text(first(source, ["bookId", "book_id"])))
    : undefined

  return {
    ...source,
    status: text(first(source, ["status"]), "creating"),
    bookId: text(
      first(source, ["bookId", "book_id"]),
      normalizedBook?.id ?? "",
    ),
    book: normalizedBook,
  }
}

export function normalizeBookDetail(data: unknown, fallbackId: string): Book {
  const record = pickObject(data, ["book", "item", "data"])
  return toBook(normalizeBookSummary(asRecord(record), 0, fallbackId))
}

export function normalizeWikiResponse(data: unknown): WikiResponse {
  const nodes = records(data, ["nodes", "items", "data"])
  const edges = records(data, ["edges", "links", "relations"])
  const byId = new Map(nodes.map((node) => [text(first(node, ["id"])), node]))
  const outgoing = new Map<string, JsonRecord[]>()
  const incoming = new Map<string, JsonRecord[]>()

  for (const edge of edges) {
    const source = text(first(edge, ["source", "from", "sourceId"]))
    const target = text(first(edge, ["target", "to", "targetId"]))
    if (!source || !target) continue
    outgoing.set(source, [...(outgoing.get(source) ?? []), edge])
    incoming.set(target, [...(incoming.get(target) ?? []), edge])
  }

  return {
    nodes: nodes.map((node) =>
      normalizeWikiNode(
        node,
        incoming.get(text(first(node, ["id"]))) ?? [],
        outgoing.get(text(first(node, ["id"]))) ?? [],
        byId,
      ),
    ),
    layout: isRecord(first(asRecord(data), ["layout"]))
      ? (first(asRecord(data), ["layout"]) as WikiResponse["layout"])
      : undefined,
  }
}

export function normalizeChapters(data: unknown, bookId: string): Chapter[] {
  const chapters = records(data, ["chapters", "items", "data"])
  return chapters.map((chapter, index) =>
    normalizeChapterRecord(chapter, index, bookId),
  )
}

export function normalizeChapterDetail(
  data: unknown,
  bookId: string,
  chapterNum: number,
): Chapter {
  const record = pickObject(data, ["chapter", "item", "data"])
  return normalizeChapterRecord(asRecord(record), chapterNum - 1, bookId)
}

export function normalizeWorkflowSnapshot(
  data: unknown,
  bookId: string,
): WorkflowSnapshot {
  const source = asRecord(pickObject(data, ["workflow", "status", "item"]))
  const currentStage = normalizeWorkflowStage(
    first(source, ["currentStage", "stageId", "stage", "current_stage"]),
  )
  const stageProgress = normalizeWorkflowStageProgress(
    source,
    normalizeStageProgress(
      first(source, ["stageProgress", "stage_progress"]),
      currentStage,
    ),
    currentStage,
  )
  const activeAgentsByStage = normalizeActiveAgents(
    first(source, ["activeAgentsByStage", "roleQueue", "agents"]),
  )
  const startedAt = new Date(
    toEpoch(
      first(source, ["startedAt", "started_at", "updatedAt", "updated_at"]),
      Date.now(),
    ),
  ).toISOString()
  const eta = first(source, ["etaAt", "eta", "estimatedDoneAt"])

  return {
    bookId: text(first(source, ["bookId", "book_id", "id"]), bookId),
    currentStage,
    stageProgress,
    activeAgentsByStage,
    totalProgress: fraction(
      first(source, ["totalProgress", "overallProgress", "overall_progress"]),
      stageProgress[currentStage],
    ),
    startedAt,
    etaAt: eta ? new Date(toEpoch(eta)).toISOString() : undefined,
  }
}

export function normalizeManuscript(
  data: unknown,
  bookId: string,
  chapterNum: number,
): Manuscript {
  const source = asRecord(pickObject(data, ["manuscript", "chapter", "item"]))
  const directParagraphs = pickArray(source, ["paragraphs", "segments", "items"])
  const paragraphs = directParagraphs.length
    ? directParagraphs.map(paragraph)
    : text(first(source, ["content", "body", "text", "manuscript"]))
        .split(/\n{2,}/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => bilingual(item))

  return {
    bookId: text(first(source, ["bookId", "book_id"]), bookId),
    chapterNum: num(first(source, ["chapterNum", "chapterNumber", "num"]), chapterNum),
    paragraphs,
    cursorParagraph: num(
      first(source, ["cursorParagraph", "cursor", "acceptedParagraphs"]),
      paragraphs.length,
    ),
  }
}

export function normalizeChapterStats(
  data: unknown,
  bookId: string,
  chapterNum: number,
): ChapterStats {
  const source = asRecord(pickObject(data, ["stats", "chapter", "item"]))
  const chapterTarget = num(
    first(source, ["chapterTarget", "targetWords", "wordsTarget"]),
    5000,
  )
  const thisRunWords = num(
    first(source, ["thisRunWords", "currentWords", "words", "wordCount"]),
    0,
  )

  return {
    bookId: text(first(source, ["bookId", "book_id"]), bookId),
    chapterNum: num(first(source, ["chapterNum", "chapterNumber", "num"]), chapterNum),
    currentWords: num(first(source, ["bookWords", "totalWords", "currentWords"]), thisRunWords),
    todayMinutes: num(first(source, ["todayMinutes", "minutes"]), 0),
    todaySeconds: num(first(source, ["todaySeconds", "seconds"]), 0),
    chapterTarget,
    thisRunWords,
    chapterPct: percent(
      first(source, ["chapterPct", "progress", "pct"]),
      chapterTarget > 0 ? thisRunWords / chapterTarget : 0,
    ),
  }
}

export function normalizeRoleQueue(
  data: unknown,
  bookId: string,
  chapterNum: number,
): RoleQueueItem[] {
  return records(data, ["roleQueue", "queue", "agents", "items", "data"]).map(
    (item) => {
      const agentId = text(first(item, ["agentId", "agent_id", "id", "role"]), "writer")
      const output = first(item, ["output", "result", "message"])
      return {
        bookId: text(first(item, ["bookId", "book_id"]), bookId),
        chapterNum: num(
          first(item, ["chapterNum", "chapterNumber", "chapter"]),
          chapterNum,
        ),
        agentId,
        task: bilingual(
          first(item, ["task", "currentTask", "roleName", "name"]) ??
            (typeof output === "string" ? output.slice(0, 80) : agentId),
        ),
        status: normalizeAgentStatus(first(item, ["status", "state"])),
        startTime: dateString(first(item, ["startTime", "startedAt", "started_at"])),
        endTime: dateString(first(item, ["endTime", "endedAt", "ended_at"])),
        outputCount: Array.isArray(output)
          ? output.length
          : num(first(item, ["outputCount", "count"]), undefined),
      }
    },
  )
}

export function normalizeQuality(
  data: unknown,
  bookId: string,
  chapterNum: number,
): QualityMetrics {
  const root = asRecord(data)
  const source = asRecord(pickObject(data, ["quality", "item", "data"]))
  const nestedQuality = asRecord(first(source, ["quality", "score"]))
  const metrics = asRecord(
    first(source, ["metrics"]) ?? first(nestedQuality, ["metrics"]),
  )
  const stats = asRecord(first(source, ["stats"]) ?? first(nestedQuality, ["stats"]))
  const reader = asRecord(
    first(source, ["reader"]) ?? first(nestedQuality, ["reader"]),
  )
  const readerMetrics = asRecord(first(reader, ["metrics"]))
  const overall = bounded(
    num(
      first(source, ["overall", "total", "score", "quality"]) ??
        first(nestedQuality, ["overall", "total", "score"]),
      0,
    ),
    0,
    100,
  )

  return {
    bookId: text(
      first(source, ["bookId", "book_id"]) ?? first(root, ["bookId", "book_id"]),
      bookId,
    ),
    chapterNum: num(
      first(source, ["chapterNum", "chapterNumber", "num"]) ??
        first(root, ["chapterNum", "chapterNumber", "num"]),
      chapterNum,
    ),
    overall,
    consistency: bounded(
      num(first(source, ["consistency"]) ?? first(metrics, ["continuity"]), overall),
      0,
      100,
    ),
    pacing: bounded(
      num(first(source, ["pacing", "rhythm"]) ?? first(metrics, ["rhythm"]), overall),
      0,
      100,
    ),
    emotion: bounded(
      num(
        first(source, ["emotion", "emotional"]) ??
          first(metrics, ["immersion", "reader"]) ??
          first(readerMetrics, ["immersion", "readOn"]),
        overall,
      ),
      0,
      100,
    ),
    diction: bounded(
      num(
        first(source, ["diction", "style"]) ??
          first(metrics, ["style", "readability"]),
        overall,
      ),
      0,
      100,
    ),
    // 人味指数(高=越像人写)。后端用 analyzeAITells 结构化检测 + aiMarkers 关键词补偿。
    // 缺字段时:回落到 style 分(去AI味子分)再回到 overall,保证 UI 永远有值显示。
    aiTone: bounded(
      num(
        first(source, ["aiTone"]) ??
          first(metrics, ["aiTone"]) ??
          first(source, ["diction", "style"]) ??
          first(metrics, ["style"]),
        overall,
      ),
      0,
      100,
    ),
    adopted: num(
      first(source, ["adopted", "adoptedWords"]) ??
        first(stats, ["chineseChars", "words"]),
      0,
    ),
    tokens: num(
      first(source, ["tokens", "tokenCount"]) ?? first(stats, ["tokens"]),
      0,
    ),
    speedWordsPerMinute: num(
      first(source, ["speedWordsPerMinute", "speed"]) ??
        first(stats, ["speedWordsPerMinute", "speed"]),
      0,
    ),
    // —— 富质量字段（handoff §17#3）：保留门禁/阻塞/主责，UI 才能显示"谁卡住、为什么" ——
    total: bounded(
      num(first(source, ["total", "overall", "score"]) ?? overall, overall),
      0,
      100,
    ),
    band:
      text(first(source, ["band"]) ?? first(nestedQuality, ["band"]), "") ||
      undefined,
    gate: ((): QualityMetrics["gate"] => {
      const g = asRecord(
        first(source, ["gate"]) ?? first(nestedQuality, ["gate"]),
      )
      if (!g || Object.keys(g).length === 0) return undefined
      const bl = first(g, ["blockers"])
      const pass = first(g, ["pass"])
      return {
        pass: typeof pass === "boolean" ? pass : undefined,
        target: num(first(g, ["target"]), 90),
        blockers: Array.isArray(bl) ? bl.map((x) => String(x)) : undefined,
        rule: text(first(g, ["rule"]), "") || undefined,
        ownerAgent: text(first(g, ["ownerAgent", "owner"]), "") || undefined,
        repairStrategy:
          text(first(g, ["repairStrategy", "strategy"]), "") || undefined,
      }
    })(),
    blockers: ((): string[] | undefined => {
      const g = asRecord(first(source, ["gate"]))
      const bl =
        first(source, ["blockers"]) ??
        (g ? first(g, ["blockers"]) : undefined)
      return Array.isArray(bl) ? bl.map((x) => String(x)) : undefined
    })(),
    criticals: num(
      first(stats, ["criticals"]) ?? first(source, ["criticals"]),
      0,
    ),
    warnings: num(
      first(stats, ["warnings"]) ?? first(source, ["warnings"]),
      0,
    ),
  }
}

export function normalizeReviewIssues(data: unknown): ReviewIssue[] {
  return records(data, ["issues", "reviewIssues", "items", "data"]).map(
    (issue, index) => ({
      id: text(first(issue, ["id", "issueId"]), `issue-${index + 1}`),
      severity: normalizeSeverity(first(issue, ["severity", "level"])),
      excerpt: bilingual(first(issue, ["excerpt", "quote", "text"])),
      note: bilingual(first(issue, ["note", "suggestion", "message", "reason"])),
      agent: bilingual(first(issue, ["agent", "agentId", "role"]), "Editor"),
    }),
  )
}

export function normalizeRewriteProposal(
  data: unknown,
  bookId: string,
  chapterNum: number,
  style: string,
): RewriteProposal {
  const source = asRecord(pickObject(data, ["proposal", "rewrite", "item"]))
  return {
    bookId: text(first(source, ["bookId", "book_id"]), bookId),
    chapterNum: num(first(source, ["chapterNum", "chapterNumber", "num"]), chapterNum),
    style: text(first(source, ["style", "mode"]), style),
    original: bilingual(first(source, ["original", "before", "source"])),
    revised: bilingual(first(source, ["revised", "after", "target", "content"])),
    matchScore: fraction(first(source, ["matchScore", "styleMatch", "score"]), 0),
    wordsDelta: num(first(source, ["wordsDelta", "delta"]), 0),
  }
}

export function normalizeDockMetrics(data: unknown): DockMetrics {
  const source = asRecord(pickObject(data, ["metrics", "quality", "item"]))
  const summary = asRecord(first(source, ["summary"]))
  const chapters = records(source, ["chapters"])
  const quality = bounded(
    num(first(source, ["quality", "overall", "score"]) ?? first(summary, ["average"]), 0),
    0,
    100,
  )
  const totalChapters = num(first(summary, ["total"]), chapters.length)
  const passedChapters = num(first(summary, ["passed90", "passed"]), undefined)
  const consistency = passedChapters === undefined || totalChapters <= 0
    ? bounded(num(first(source, ["consistency"]), quality), 0, 100)
    : bounded(Math.round((passedChapters / totalChapters) * 100), 0, 100)
  const adoptedWords = chapters.reduce((sum, chapter) => {
    const chapterQuality = asRecord(first(chapter, ["quality"]))
    const stats = asRecord(first(chapterQuality, ["stats"]))
    return sum + num(
      first(chapter, ["wordCount", "words"]) ??
        first(stats, ["chineseChars", "words"]),
      0,
    )
  }, 0)
  const targetWords = chapters.reduce((sum, chapter) => {
    const chapterQuality = asRecord(first(chapter, ["quality"]))
    const stats = asRecord(first(chapterQuality, ["stats"]))
    return sum + num(first(stats, ["targetWordCount", "targetWords"]), 0)
  }, 0)
  const remainingWords = Math.max(0, targetWords - adoptedWords)
  return {
    speedWordsPerMinute: num(first(source, ["speedWordsPerMinute", "speed"]), 0),
    speedTrend: text(first(source, ["speedTrend", "trend"]), "0%"),
    quality,
    consistency,
    adopted: num(first(source, ["adopted", "adoptedWords"]), adoptedWords),
    tokens: num(first(source, ["tokens", "tokenCount"]), 0),
    remaining: num(first(source, ["remaining", "remainingWords"]), remainingWords),
    remainingPct: percent(
      first(source, ["remainingPct"]),
      targetWords > 0 ? remainingWords / targetWords : 0,
    ),
    etaMinutes: num(first(source, ["etaMinutes", "eta"]), 0),
  }
}

export function normalizeSystemHealth(data: unknown): SystemHealth {
  const source = asRecord(pickObject(data, ["health", "doctor", "item"]))
  const doctorChecks = ["hardwriteJson", "projectEnv", "globalEnv", "booksDir", "llmConnected"]
    .filter((key) => typeof source[key] === "boolean")
  if (doctorChecks.length) {
    const passed = doctorChecks.filter((key) => source[key] === true).length
    const hasRuntimeBase = Boolean(source.hardwriteJson && source.projectEnv && source.booksDir)
    const hasLLM = Boolean(source.llmConnected)
    const status: SystemHealth["status"] = hasRuntimeBase && hasLLM
      ? "healthy"
      : hasRuntimeBase
        ? "degraded"
        : "down"

    return {
      status,
      onlineModels: passed,
      totalModels: doctorChecks.length,
      routeSuccessRate24h: doctorChecks.length ? passed / doctorChecks.length : 0,
      avgLatencySeconds: 0,
      load: status === "healthy" ? 0.18 : status === "degraded" ? 0.55 : 0,
      hardwriteJson: source.hardwriteJson === true,
      projectEnv: source.projectEnv === true,
      globalEnv: source.globalEnv === true,
      booksDir: source.booksDir === true,
      llmConnected: source.llmConnected === true,
      bookCount: num(first(source, ["bookCount", "books"]), 0),
      llmProbeCached: source.llmProbeCached === true,
      llmProbeStale: source.llmProbeStale === true,
      llmProbeAgeMs: num(first(source, ["llmProbeAgeMs", "llm_probe_age_ms"]), undefined),
      llmProbeStatus: normalizeLlmProbeStatus(
        first(source, ["llmProbeStatus", "llm_probe_status"]),
      ),
    }
  }

  const services = records(source, ["services", "checks"])
  const onlineModels = num(first(source, ["onlineModels", "online"]), services.length)
  const totalModels = num(first(source, ["totalModels", "total"]), services.length || onlineModels)
  const rawStatus = text(first(source, ["status"])).toLowerCase()
  const explicitlyHealthy =
    ["healthy", "ok"].includes(rawStatus) || Boolean(first(source, ["ok", "healthy"]))
  const hasModels = totalModels > 0 && onlineModels > 0
  const status: SystemHealth["status"] = explicitlyHealthy && hasModels
    ? "healthy"
    : hasModels
      ? "degraded"
      : "down"

  return {
    status,
    onlineModels,
    totalModels,
    routeSuccessRate24h: fraction(
      first(source, ["routeSuccessRate24h", "successRate"]),
      status === "healthy" ? 0.99 : status === "degraded" ? 0.5 : 0,
    ),
    avgLatencySeconds: num(first(source, ["avgLatencySeconds", "latencySeconds"]), 0),
    load: fraction(first(source, ["load"]), 0),
    bookCount: num(first(source, ["bookCount", "books"]), undefined),
    llmConnected: source.llmConnected === true ? true : undefined,
    llmProbeCached: source.llmProbeCached === true ? true : undefined,
    llmProbeStale: source.llmProbeStale === true ? true : undefined,
    llmProbeAgeMs: num(first(source, ["llmProbeAgeMs", "llm_probe_age_ms"]), undefined),
    llmProbeStatus: normalizeLlmProbeStatus(
      first(source, ["llmProbeStatus", "llm_probe_status"]),
    ),
  }
}

function normalizeLlmProbeStatus(value: unknown): SystemHealth["llmProbeStatus"] {
  const status = text(value).toLowerCase()
  return status === "fresh" ||
    status === "cached" ||
    status === "stale-timeout" ||
    status === "failed" ||
    status === "error"
    ? status
    : undefined
}

export function normalizeAutoRuns(data: unknown): AutoRun[] {
  return records(data, ["runs", "items", "data"]).map((run, index) =>
    normalizeAutoRun(run, index),
  )
}

export function normalizeAutoRun(data: unknown, index = 0): AutoRun {
  const source = asRecord(pickObject(data, ["run", "item"]))
  const bookId = text(first(source, ["bookId", "book_id"]), "book-instance-arrival")
  const errorText = optionalText(first(source, ["error", "message"]))
  const failureReason = optionalText(first(source, ["failureReason", "reason"]))
  const rawStatus = normalizeRunStatus(first(source, ["status", "state"]))
  const resultRecords = records(source, ["results"])
  const inferredCurrentChapter = inferRunChapterNumber(source, resultRecords)
  const currentIndex = positiveNum(first(source, ["currentIndex", "index"]))
  const totalChapters = positiveNum(first(source, ["total", "chapters"]))
  const explicitFromChapter = positiveNum(first(source, ["fromChapter", "from", "startChapter"]))
  const explicitToChapter = positiveNum(first(source, ["toChapter", "to", "endChapter"]))
  const inferredFromChapter =
    inferredCurrentChapter && currentIndex
      ? Math.max(1, inferredCurrentChapter - currentIndex + 1)
      : inferredCurrentChapter
  const explicitToFromTotal =
    explicitFromChapter && totalChapters
      ? explicitFromChapter + totalChapters - 1
      : undefined
  const explicitRangeContainsCurrent =
    !inferredCurrentChapter ||
    !explicitFromChapter ||
    (explicitFromChapter <= inferredCurrentChapter &&
      inferredCurrentChapter <=
        (explicitToChapter ?? explicitToFromTotal ?? explicitFromChapter))
  const fromChapter = explicitRangeContainsCurrent
    ? (explicitFromChapter ?? inferredFromChapter ?? 1)
    : (inferredFromChapter ?? inferredCurrentChapter ?? explicitFromChapter ?? 1)
  const rawToChapter =
    explicitRangeContainsCurrent && explicitToChapter
      ? explicitToChapter
      : totalChapters
        ? fromChapter + totalChapters - 1
        : (explicitToChapter ?? inferredCurrentChapter ?? fromChapter)
  const toChapter = Math.max(
    fromChapter,
    rawToChapter,
    inferredCurrentChapter ?? fromChapter,
  )
  const resultWords = resultRecords.reduce(
    (sum, result) =>
      sum +
      num(first(result, ["wordCount", "words", "chineseChars", "chars"]), 0),
    0,
  )
  const resultQualityValues = resultRecords
    .map((result) =>
      optionalNum(
        first(result, ["scoreAfter", "score", "quality", "total"]) ??
          first(asRecord(first(result, ["quality"])), ["total", "score"]),
      ),
    )
    .filter((value): value is number => value !== undefined)
  const explicitResultTargetScores = resultRecords
    .map((result) =>
      optionalNum(first(result, ["targetScore", "targetQuality"])),
    )
    .filter((value): value is number => value !== undefined)
  const resultGateTargets = resultRecords
    .map((result) =>
      optionalNum(first(asRecord(first(asRecord(first(result, ["quality"])), ["gate"])), ["target"])),
    )
    .filter((value): value is number => value !== undefined)
  const hasSuccessfulResult = resultRecords.some((result) => {
    const status = text(first(result, ["status", "state"])).toLowerCase()
    return Boolean(first(result, ["pass", "applied"])) ||
      ["done", "completed", "complete", "success", "ready-for-review"].includes(status)
  })
  const runEvents = normalizeRunEvents(first(source, ["recentEvents", "events"]))
  const currentStageSource = optionalText(first(source, ["currentStage", "stage"]))
  const currentAgentSource = optionalText(first(source, ["currentAgentId", "currentAgent", "agentId"]))
  const latestSpecificEvent = runEvents.find((event) => {
    const message = `${event.message.zh} ${event.message.en}`
    return (
      event.agentId &&
      !/heartbeat|心跳|批量写作工作流运行中/i.test(message)
    )
  })
  const hasGenericHeartbeatStage =
    !currentStageSource ||
    /heartbeat|心跳|批量写作工作流运行中/i.test(currentStageSource)
  const currentAgentRaw =
    hasGenericHeartbeatStage && latestSpecificEvent?.agentId
      ? latestSpecificEvent.agentId
      : currentAgentSource
  const currentAgentId = currentAgentRaw
    ? equivalentAgentId(currentAgentRaw)
    : undefined
  const currentStage =
    hasGenericHeartbeatStage && latestSpecificEvent
      ? latestSpecificEvent.message.zh
      : currentStageSource
  const runResults = normalizeAutoRunResults(resultRecords)
  const hasCompletionEvent = runEvents.some((event) =>
    ["chapter.complete", "rewrite.success"].includes(event.type),
  )
  const currentChapter = bounded(
    inferredCurrentChapter ?? fromChapter,
    fromChapter,
    toChapter,
  )
  const targetWordsPerChapter = num(first(source, ["targetWordsPerChapter", "targetWords", "wordCount"]), 5000)
  const currentWords = bounded(
    num(
      first(source, ["currentWords", "words"]) ??
        first(resultRecords.at(-1) ?? {}, ["wordCount", "words", "chineseChars", "chars"]),
      0,
    ),
    0,
    Math.max(targetWordsPerChapter, resultWords),
  )
  const targetQuality =
    optionalNum(first(source, ["targetQuality", "qualityTarget", "targetScore"])) ??
    explicitResultTargetScores.at(-1) ??
    targetScoreFromText(first(source, ["failureReason", "reason"])) ??
    targetScoreFromText(first(source, ["currentStage", "stage"])) ??
    resultGateTargets.at(-1) ??
    80
  const currentQuality = optionalNum(first(source, ["currentQuality", "quality"])) ??
    (resultQualityValues.length ? Math.max(...resultQualityValues) : undefined)
  const sourceAdoptedWords = num(
    first(source, ["totalAdoptedWords", "adoptedWords"]) ??
      first(source, ["totalChars", "chineseChars"]) ??
      resultWords,
    0,
  )
  const totalAdoptedWords = Math.max(sourceAdoptedWords, resultWords)
  const statusText = [
    optionalText(first(source, ["currentStage", "stage"])),
    errorText,
    failureReason,
    optionalText(first(source, ["suggestion", "hint"])),
  ]
    .filter(Boolean)
    .join(" ")
  const hasRecoverableInterruption = RECOVERABLE_RUN_TEXT_RE.test(statusText)
  const hasFailureSignal = Boolean(errorText || failureReason)
  const status =
    hasRecoverableInterruption && ["queued", "running", "rewriting"].includes(rawStatus)
      ? "paused"
    : rawStatus === "completed" &&
          hasFailureSignal
        ? "failed"
        : rawStatus === "completed" &&
            currentWords <= 0 &&
            totalAdoptedWords <= 0 &&
            (currentQuality === undefined || currentQuality <= 0) &&
            !hasSuccessfulResult &&
            !hasCompletionEvent
          ? "failed"
        : hasFailureSignal && ["queued", "running", "rewriting"].includes(rawStatus)
          ? "failed"
          : rawStatus

  return {
    id: text(first(source, ["id", "runId", "run_id"]), `run-${index + 1}`),
    bookId,
    type: optionalText(first(source, ["type", "runType", "kind"])),
    bookTitle: bilingual(first(source, ["bookTitle", "title"]), bookId),
    fromChapter,
    toChapter,
    targetWordsPerChapter,
    targetQuality,
    maxRewritesPerChapter: num(first(source, ["maxRewritesPerChapter", "maxRewrites", "maxAutoRounds"]), 2),
    status,
    currentChapter,
    currentRewrite: num(first(source, ["currentRewrite", "rewriteCount"]), 0),
    currentWords,
    currentAgentId,
    currentStage,
    error: errorText,
    failureReason,
    suggestion: optionalText(first(source, ["suggestion", "hint"])),
    currentQuality,
    startedAt: toEpoch(first(source, ["startedAt", "createdAt"]), Date.now()),
    eta: optionalEpoch(first(source, ["eta", "etaAt"])),
    totalAdoptedWords,
    totalTokens: num(first(source, ["totalTokens", "tokens"]), 0),
    totalRewrites: num(first(source, ["totalRewrites", "rewrites"]), 0),
    recentEvents: runEvents,
    results: runResults,
  }
}

export function normalizeWorkflowContract(data: unknown): WorkflowContract {
  const source = asRecord(pickObject(data, ["contract", "workflow", "item"]))
  const steps = records(source, ["steps", "items"])
  if (steps.length) return { steps: steps.map(normalizeWorkflowStep) }

  const taskFlowSteps = normalizeWorkflowStepsFromTaskFlows(source)
  if (taskFlowSteps.length) return { steps: taskFlowSteps }

  return { steps: normalizeWorkflowStepsFromStages(source) }
}

function normalizeWorkflowStep(step: JsonRecord, index: number) {
  const agentId = equivalentAgentId(text(first(step, ["agentId", "agent_id"]), "writer"))
  return {
    id: text(first(step, ["id", "stepId"]), `step-${index + 1}`),
    agentId,
    inputs: strings(first(step, ["inputs"])),
    outputs: strings(first(step, ["outputs"])),
    fallback: optionalText(first(step, ["fallback"])),
    optional: Boolean(first(step, ["optional"])),
  }
}

function normalizeWorkflowStepsFromTaskFlows(source: JsonRecord) {
  const taskFlows = asRecord(first(source, ["taskFlows", "flows"]))
  const preferredFlow = asRecord(first(taskFlows, ["continue-writing", "default", "main"]))
  const flow = Object.keys(preferredFlow).length
    ? preferredFlow
    : asRecord(Object.values(taskFlows).find(isRecord))
  const agents = strings(first(flow, ["agents", "agentIds"]))
  if (!agents.length) return []

  return agents.map((agent, index) => {
    const agentId = equivalentAgentId(agent)
    const previousAgent = index > 0 ? equivalentAgentId(agents[index - 1]) : undefined
    return {
      id: `continue-writing-${String(index + 1).padStart(2, "0")}-${agentId}`,
      agentId,
      inputs: index === 0
        ? ["book.foundation", "chapter.context"]
        : [`${previousAgent}.product`, "wiki.read"],
      outputs: [`${agentId}.product`],
      fallback: index > 0
        ? `continue-writing-${String(index).padStart(2, "0")}-${previousAgent}`
        : undefined,
      optional: ["chapter-analyst", "state-verifier", "prompt-steward"].includes(agentId),
    }
  })
}

function normalizeWorkflowStepsFromStages(source: JsonRecord) {
  const stages = records(source, ["stages", "phases"])
  return stages.flatMap((stage, stageIndex) => {
    const stageId = text(first(stage, ["id", "stageId"]), `stage-${stageIndex + 1}`)
    return records(stage, ["agents", "items"]).map((agent, agentIndex) => {
      const agentId = equivalentAgentId(text(first(agent, ["id", "agentId"]), "writer"))
      const stepIndex = `${String(stageIndex + 1).padStart(2, "0")}-${String(agentIndex + 1).padStart(2, "0")}`
      return {
        id: `${stageId}-${stepIndex}-${agentId}`,
        agentId,
        inputs: agentIndex === 0
          ? [`${stageId}.input`]
          : [`${stageId}.agent-${agentIndex}.product`],
        outputs: [`${stageId}.${agentId}.product`],
        fallback: agentIndex > 0
          ? `${stageId}-${String(stageIndex + 1).padStart(2, "0")}-${String(agentIndex).padStart(2, "0")}`
          : undefined,
        optional: Boolean(first(agent, ["optional"])),
      }
    })
  })
}

export function normalizeAgentProfiles(data: unknown): AgentProfile[] {
  const root = asRecord(data)
  const source = Array.isArray(root.agents)
    ? root
    : asRecord(pickObject(data, ["agentProfiles", "item"]))
  const agents = records(source, ["agents", "items", "data"])
  const profiles = asRecord(first(source, ["profiles", "overrides"]))
  const models = records(source, ["models"])

  if (!agents.length) {
    return AGENT_PROFILES_SEED.map((profile) => ({
      ...profile,
      model: DEFAULT_MODEL_HINT,
    }))
  }

  return agents.map((agent, index) => {
    const rawId = text(first(agent, ["id", "agentId"]), `agent-${index + 1}`)
    const id = equivalentAgentId(rawId)
    const backendId = toBackendAgentId(id)
    const override = {
      ...asRecord(profiles[id]),
      ...asRecord(profiles[backendId]),
      ...asRecord(profiles[rawId]),
    }
    const seed = AGENT_PROFILES_SEED.find((profile) =>
      sameAgentId(profile.id, id),
    )
    const model = text(
      first(override, ["model", "modelId"]) ??
        first(agent, ["model", "modelId"]) ??
        first(models[0] ?? {}, ["id", "model"]),
      DEFAULT_MODEL_HINT,
    )

    return {
      id,
      name: bilingual(first(agent, ["label", "name"]), seed?.name.zh ?? id),
      step: num(first(override, ["step"]), seed?.step ?? index + 1),
      systemPrompt: withSeedContract(
        text(
          first(override, ["systemPrompt", "prompt", "promptPatch"]) ??
            first(agent, ["defaultPromptPatch", "promptPatch", "mission"]) ??
            seed?.systemPrompt,
          "",
        ),
        seed?.systemPrompt,
      ),
      userTemplate: optionalText(first(override, ["userTemplate", "userPrompt"])),
      outputSchema: optionalText(
        first(override, ["outputSchema", "outputFormat"]) ??
          first(agent, ["defaultOutputFormat"]),
      ),
      tools: strings(first(override, ["tools"])).length
        ? strings(first(override, ["tools"]))
        : seed?.tools ?? [],
      model,
      temperature: num(
        first(override, ["temperature"]) ?? first(agent, ["defaultTemperature"]),
        seed?.temperature ?? 0.7,
      ),
      maxTokens: num(
        first(override, ["maxTokens", "maxOutputTokens"]),
        seed?.maxTokens ?? 4096,
      ),
      locked: Boolean(first(override, ["locked"])),
      deterministic: Boolean(first(agent, ["deterministic"])),
      versions: records(override, ["versions"]).map((version, versionIndex) => ({
        id: text(first(version, ["id"]), `v-${versionIndex + 1}`),
        ts: toEpoch(first(version, ["ts", "createdAt", "time"]), Date.now()),
        note: optionalText(first(version, ["note", "message"])),
        systemPrompt: text(first(version, ["systemPrompt", "prompt"]), ""),
        author: optionalText(first(version, ["author", "by"])),
      })),
    }
  }).sort((left, right) => left.step - right.step)
}

export function normalizeConnectivityResults(data: unknown): ConnectivityResult[] {
  return records(data, ["results", "items", "data"]).map((result, index) => ({
    agentId: equivalentAgentId(text(first(result, ["agentId", "agent", "id"]), `agent-${index + 1}`)),
    ok: Boolean(first(result, ["ok", "connected", "success"])),
    latencyMs: num(first(result, ["latencyMs", "durationMs", "elapsedMs"]), 0),
    model: text(first(result, ["model", "modelId"]), ""),
    testedAt: toEpoch(first(result, ["testedAt", "checkedAt", "time"]), Date.now()),
    error: optionalText(first(result, ["error", "message", "reason"])),
    sample: optionalText(first(result, ["sample", "output", "text"])),
  }))
}

export function normalizeConnectivityResult(
  data: unknown,
  agentId: string,
): ConnectivityResult {
  const result = normalizeConnectivityResults(data).find(
    (item) =>
      item.agentId === agentId ||
      equivalentAgentId(item.agentId) === equivalentAgentId(agentId),
  )
  return result ?? {
    agentId,
    ok: false,
    latencyMs: 0,
    model: "",
    testedAt: Date.now(),
    error: "agent connectivity result not returned by backend",
  }
}

export function normalizeLLMProviders(
  servicesData: unknown,
  configData: unknown,
  modelsData: unknown,
): LLMProvider[] {
  const services = records(servicesData, ["services", "items", "data"])
  const config = asRecord(pickObject(configData, ["config", "item"]))
  const configuredServices = records(config, ["services"])
  const modelGroups = records(modelsData, ["groups", "services", "items"])
  const activeService = text(first(config, ["service", "provider"]))
  const defaultModel = text(first(config, ["defaultModel", "model"]))

  if (!services.length) return LLM_PROVIDERS_SEED

  return services.map((service) => {
    const serviceId = text(first(service, ["service", "id"]), "")
    const configured = configuredServices.find(
      (item) => text(first(item, ["service"])) === serviceId,
    )
    const modelGroup = modelGroups.find(
      (group) => text(first(group, ["service", "id"])) === serviceId,
    )
    const models = records(modelGroup ?? {}, ["models"]).map((model) =>
      text(first(model, ["id", "name", "model"])),
    ).filter(Boolean)
    const baseUrl = text(
      first(service, ["baseUrl", "url"]) ?? first(configured ?? {}, ["baseUrl", "url"]),
    )
    const enabled =
      activeService === serviceId ||
      activeService.startsWith(`${serviceId}:`) ||
      Boolean(first(service, ["enabled"]))

    return {
      id: serviceId,
      name: text(first(service, ["label", "name"]), serviceId),
      kind: normalizeProviderKind(serviceId),
      baseUrl,
      hasKey: Boolean(first(service, ["connected", "hasKey"])),
      enabled,
      lastTestedAt: optionalEpoch(first(service, ["lastTestedAt", "testedAt"])),
      lastTestOk: first(service, ["lastTestOk"]) === undefined
        ? undefined
        : Boolean(first(service, ["lastTestOk"])),
      models: models.length
        ? models
        : enabled && defaultModel
          ? [defaultModel]
          : [],
    }
  })
}

export function normalizeProjectPrefs(data: unknown): ProjectPrefs {
  const source = asRecord(data)
  const project = asRecord(pickObject(source, ["project", "item"]))
  const defaultRun = asRecord(first(source, ["defaultRun", "default_run"]))
  const notify = asRecord(first(source, ["notify"]))
  const language = text(first(project, ["language", "locale"]), "zh")
  const notifyFlag = (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback
  return {
    ...PROJECT_PREFS_SEED,
    locale: language.toLowerCase().startsWith("en") ? "en" : "zh-CN",
    theme: text(first(source, ["theme"]), PROJECT_PREFS_SEED.theme) as ProjectPrefs["theme"],
    defaultRun: {
      targetWordsPerChapter: num(
        first(defaultRun, ["targetWordsPerChapter", "targetWords", "wordCount"]),
        PROJECT_PREFS_SEED.defaultRun.targetWordsPerChapter,
      ),
      targetQuality: num(
        first(defaultRun, ["targetQuality", "targetScore"]),
        PROJECT_PREFS_SEED.defaultRun.targetQuality,
      ),
      maxRewritesPerChapter: num(
        first(defaultRun, ["maxRewritesPerChapter", "maxRewrites"]),
        PROJECT_PREFS_SEED.defaultRun.maxRewritesPerChapter,
      ),
    },
    notify: {
      onChapterDone: notifyFlag(
        first(notify, ["onChapterDone", "chapterDone"]),
        PROJECT_PREFS_SEED.notify.onChapterDone,
      ),
      onRunFailed: notifyFlag(
        first(notify, ["onRunFailed", "runFailed"]),
        PROJECT_PREFS_SEED.notify.onRunFailed,
      ),
      onLowQuality: notifyFlag(
        first(notify, ["onLowQuality", "lowQuality"]),
        PROJECT_PREFS_SEED.notify.onLowQuality,
      ),
    },
  }
}

export function normalizeAgentsFromFlow(data: unknown) {
  const source = asRecord(pickObject(data, ["agentFlow", "flow", "item"]))
  const labels = asRecord(first(source, ["labels"]))
  const flow = records(source, ["flow", "agents", "items"])
  const tasksById = new Map<string, JsonRecord>()
  for (const item of flow) {
    const id = text(first(item, ["id", "agentId"]))
    if (id) tasksById.set(id, item)
  }

  return AGENTS.map((agent) => {
    const backendId = findBackendAgentId(agent.id, labels, tasksById)
    const backend = backendId ? tasksById.get(backendId) : undefined
    const label = backendId ? labels[backendId] : undefined
    const produces = strings(first(backend ?? {}, ["produces"]))
    const entersOn = strings(first(backend ?? {}, ["entersOn"]))
    return {
      ...agent,
      name: label ? bilingual(label, agent.name.zh) : agent.name,
      role: backend
        ? bilingual(first(backend, ["when", "handoffTo"]), agent.role.zh)
        : agent.role,
      desc: backend
        ? bilingual(first(backend, ["when", "ai"]), agent.desc.zh)
        : agent.desc,
      currentTask: backend && entersOn.length
        ? bilingual(entersOn[0], agent.currentTask?.zh ?? "")
        : null,
      modelHint: text(
        first(backend ?? {}, ["model", "modelHint"]),
        DEFAULT_MODEL_HINT,
      ),
      status: backend ? normalizeAgentStatus(first(backend, ["status", "state"])) : "idle",
      load: backend && produces.length ? 0.18 : 0,
    }
  })
}

function normalizeBookSummary(
  source: JsonRecord,
  index: number,
  fallbackId?: string,
): BookSummary {
  const id = text(
    first(source, ["id", "slug", "bookId", "book_id", "name"]),
    fallbackId ?? `book-${index + 1}`,
  )
  const plannedChapters = num(
    first(source, ["plannedChapters", "targetChapters", "chapterPlanCount"]),
    num(first(source, ["chapterCount", "chaptersWritten", "currentChapter"]), 1),
  )
  const currentChapter = num(
    first(source, ["currentChapter", "chaptersWritten", "latestChapter", "chapterCount"]),
    0,
  )
  const totalWords = num(
    first(source, ["totalWords", "wordCount", "words", "currentWords"]),
    0,
  )

  return {
    id,
    title: bilingual(first(source, ["title", "bookTitle", "name"]), id),
    kindLabel: bilingual(
      first(source, ["kindLabel", "genreLabel", "genre", "category", "type"]),
      "Long",
    ),
    type: normalizeBookType(first(source, ["type", "kind"])),
    cover: optionalText(first(source, ["cover", "coverUrl"])),
    totalWords,
    chapterCount: num(first(source, ["chapterCount", "chaptersCount"]), currentChapter),
    currentChapter,
    currentChapterPct: fraction(
      first(source, ["currentChapterPct", "progress", "overallProgress"]),
      plannedChapters > 0 ? currentChapter / plannedChapters : 0,
    ),
    plannedChapters,
    accent: text(first(source, ["accent", "color"]), ACCENTS[index % ACCENTS.length]),
    autoRunning: Boolean(first(source, ["autoRunning", "running", "activeRun"])),
    creationStatus: text(first(source, ["creationStatus", "status"]), ""),
    createdAt: dateString(first(source, ["createdAt", "created_at"])) ?? new Date().toISOString(),
    updatedAt: dateString(first(source, ["updatedAt", "updated_at"])) ?? new Date().toISOString(),
  }
}

function normalizeChapterRecord(
  source: JsonRecord,
  index: number,
  _bookId: string,
): Chapter {
  const chapterNum = num(
    first(source, ["num", "number", "chapterNum", "chapterNumber"]),
    index + 1,
  )
  const words = num(first(source, ["words", "wordCount", "currentWords"]), 0)
  const status = normalizeChapterStatus(first(source, ["status", "state"]), words)
  return {
    id: text(first(source, ["id"]), `c${chapterNum}`),
    num: chapterNum,
    title: bilingual(first(source, ["title", "name"]), `Chapter ${chapterNum}`),
    words,
    status,
    active: Boolean(first(source, ["active"])) || status === "writing",
  }
}

function normalizeStageProgress(
  value: unknown,
  currentStage: WorkflowStage,
): Record<WorkflowStage, number> {
  const source = isRecord(value) ? value : undefined
  if (!source && value != null) {
    const progress = fraction(value, 0)
    return STAGE_IDS.reduce(
      (acc, stage) => {
        acc[stage] = stage === currentStage ? progress : 0
        return acc
      },
      {} as Record<WorkflowStage, number>,
    )
  }
  return STAGE_IDS.reduce(
    (acc, stage) => {
      const raw = sourceStageValue(source, stage)
      acc[stage] = raw == null ? 0 : fraction(raw, 0)
      return acc
    },
    {} as Record<WorkflowStage, number>,
  )
}

function normalizeWorkflowStageProgress(
  source: JsonRecord,
  base: Record<WorkflowStage, number>,
  currentStage: WorkflowStage,
): Record<WorkflowStage, number> {
  const currentIndex = STAGE_IDS.indexOf(currentStage)
  const items = workflowAgentItems(source)
  const next = { ...base }

  for (const stage of STAGE_IDS) {
    const index = STAGE_IDS.indexOf(stage)
    if (index >= 0 && currentIndex >= 0 && index < currentIndex) {
      next[stage] = Math.max(next[stage], 1)
      continue
    }

    const stageItems = items.filter((item) => workflowItemStage(item) === stage)
    if (!stageItems.length) continue

    const doneCount = stageItems.filter(
      (item) => normalizeAgentStatus(first(item, ["status", "state"])) === "done",
    ).length
    const runningCount = stageItems.filter((item) =>
      ["running", "warning"].includes(
        normalizeAgentStatus(first(item, ["status", "state"])),
      ),
    ).length

    if (doneCount === stageItems.length) {
      next[stage] = Math.max(next[stage], 1)
    } else if (stage === currentStage && stageItems.length > 0) {
      const derived = (doneCount + (runningCount > 0 ? 0.5 : 0)) / stageItems.length
      next[stage] = Math.max(next[stage], bounded(derived, 0, 1))
    }
  }

  return next
}

function normalizeActiveAgents(value: unknown): Record<WorkflowStage, string[]> {
  const source = isRecord(value) ? value : undefined
  if (source && STAGE_IDS.some((stage) => Array.isArray(sourceStageValue(source, stage)))) {
    return STAGE_IDS.reduce(
      (acc, stage) => {
        acc[stage] = strings(sourceStageValue(source, stage)).map(equivalentAgentId)
        return acc
      },
      {} as Record<WorkflowStage, string[]>,
    )
  }

  const items = Array.isArray(value)
    ? value.filter(isRecord)
    : records(value, ["roleQueue", "agents", "items"])
  const grouped = STAGE_IDS.reduce(
    (acc, stage) => {
      acc[stage] = []
      return acc
    },
    {} as Record<WorkflowStage, string[]>,
  )

  for (const item of items) {
    const agentId = equivalentAgentId(text(first(item, ["agentId", "id", "role"]), ""))
    if (!agentId) continue
    const stage = workflowItemStage(item) ?? "prepare"
    const status = normalizeAgentStatus(first(item, ["status", "state"]))
    if (!["done", "idle"].includes(status) && !grouped[stage].includes(agentId)) {
      grouped[stage].push(agentId)
    }
  }

  return grouped
}

function sourceStageValue(source: JsonRecord | undefined, stage: WorkflowStage) {
  if (!source) return undefined
  return stage === "persist"
    ? source.persist ?? source.archive
    : source[stage]
}

function workflowAgentItems(source: JsonRecord): JsonRecord[] {
  return records(source, ["roleQueue", "agents", "items", "data"])
}

function workflowItemStage(item: JsonRecord): WorkflowStage | null {
  const agentId = equivalentAgentId(text(first(item, ["agentId", "id", "role"]), ""))
  const agent = AGENTS.find((candidate) => candidate.id === agentId)
  return normalizeWorkflowStageMaybe(first(item, ["stage", "stageId", "phase"])) ??
    agent?.stage ??
    null
}

function normalizeRunEvents(value: unknown): AutoRunEvent[] {
  return records(value, ["events", "items"])
    .map((event) => {
      const rawType = first(event, ["type", "event", "kind"])
      const message = first(event, ["message", "text", "summary", "content", "stage"])
      return {
        ts: toEpoch(first(event, ["ts", "createdAt", "time"]), Date.now()),
        type: normalizeRunEventType(rawType),
        agentId: optionalText(first(event, ["agentId", "agent_id", "agent", "roleId"]))
          ? equivalentAgentId(optionalText(first(event, ["agentId", "agent_id", "agent", "roleId"])) ?? "")
          : undefined,
        chapter: optionalNum(first(event, ["chapter", "chapterNum", "chapterNumber"])),
        message: bilingual(message),
      }
    })
    .filter((event) => event.message.zh.trim() || event.message.en.trim())
}

function normalizeAutoRunResults(
  resultRecords: JsonRecord[],
): AutoRun["results"] {
  return resultRecords.map((result, index) => {
    const changes = records(result, ["changes"]).map((change) => ({
      before: optionalText(first(change, ["before", "from", "problem"])),
      after: optionalText(first(change, ["after", "to", "fix"])),
      reason: optionalText(first(change, ["reason", "why"])),
    }))
    return {
      chapterNumber: num(
        first(result, ["chapterNumber", "chapterNum", "chapter", "num"]),
        index + 1,
      ),
      title: optionalText(first(result, ["title", "chapterTitle"])),
      status: optionalText(first(result, ["status", "state"])),
      generated: Boolean(first(result, ["generated"])),
      skipped: Boolean(first(result, ["skipped"])),
      applied: Boolean(first(result, ["applied"])),
      autoRepaired: Boolean(first(result, ["autoRepaired", "repaired"])),
      pass:
        first(result, ["pass"]) === undefined
          ? undefined
          : Boolean(first(result, ["pass"])),
      targetScore: optionalNum(first(result, ["targetScore", "targetQuality"])),
      scoreBefore: optionalNum(first(result, ["scoreBefore", "beforeScore"])),
      scoreAfter: optionalNum(
        first(result, ["scoreAfter", "score", "quality", "total"]) ??
          first(asRecord(first(result, ["quality"])), ["total", "score"]),
      ),
      wordCount: optionalNum(
        first(result, ["wordCount", "words", "chineseChars", "chars"]),
      ),
      repairRunId: optionalText(first(result, ["repairRunId", "repairId"])),
      autoRounds: optionalNum(first(result, ["autoRounds", "rounds"])),
      engine: optionalText(first(result, ["engine"])),
      error: optionalText(first(result, ["error"])),
      failureReason: optionalText(first(result, ["failureReason", "reason"])),
      suggestion: optionalText(first(result, ["suggestion", "hint"])),
      changes: changes.length ? changes : undefined,
      warnings: strings(first(result, ["warnings"])),
    }
  })
}

function toBook(summary: BookSummary): Book {
  return {
    id: summary.id,
    title: summary.title,
    type: summary.type,
    cover: summary.cover,
    totalWords: summary.totalWords,
    chapterCount: summary.chapterCount,
    currentChapter: summary.currentChapter,
    currentChapterPct: summary.currentChapterPct,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  }
}

function paragraph(value: unknown): Manuscript["paragraphs"][number] {
  if (!isRecord(value)) return bilingual(value)
  const textValue = first(value, ["text", "content", "body"])
  return {
    ...bilingual(textValue ?? value),
    quote: Boolean(value.quote),
  }
}

function normalizeWorkflowStageMaybe(value: unknown): WorkflowStage | null {
  const raw = text(value).toLowerCase()
  if (STAGE_IDS.includes(raw as WorkflowStage)) return raw as WorkflowStage
  if (raw.includes("审") || raw.includes("质检") || raw.includes("审核")) return "review"
  if (raw.includes("修") || raw.includes("改写") || raw.includes("润色")) return "revise"
  if (raw.includes("落库") || raw.includes("入库") || raw.includes("保存")) return "persist"
  if (raw.includes("发布") || raw.includes("导出")) return "publish"
  if (raw.includes("生成") || raw.includes("写作") || raw.includes("草稿")) return "generate"
  if (raw.includes("review") || raw.includes("audit") || raw.includes("qa")) return "review"
  if (raw.includes("revise") || raw.includes("rewrite") || raw.includes("repair")) return "revise"
  if (raw.includes("persist") || raw.includes("store") || raw.includes("save")) return "persist"
  if (raw.includes("archive")) return "persist"
  if (raw.includes("publish") || raw.includes("export")) return "publish"
  if (raw.includes("generate") || raw.includes("write") || raw.includes("draft")) return "generate"
  return null
}

function normalizeWorkflowStage(value: unknown): WorkflowStage {
  return normalizeWorkflowStageMaybe(value) ?? "prepare"
}

function normalizeAgentStatus(value: unknown): AgentStatus {
  const raw = text(value).toLowerCase()
  if (
    ["done", "completed", "complete", "success", "succeeded"].includes(raw) ||
    raw.includes("已完成") ||
    raw === "完成" ||
    raw.includes("成功")
  ) return "done"
  if (
    ["error", "failed", "failure"].includes(raw) ||
    raw.includes("错误") ||
    raw.includes("失败") ||
    raw.includes("异常")
  ) return "error"
  if (
    ["warning", "warn", "blocked"].includes(raw) ||
    raw.includes("告警") ||
    raw.includes("阻塞") ||
    raw.includes("需注意")
  ) return "warning"
  if (
    ["paused", "stopped", "cancelled", "canceled"].includes(raw) ||
    raw.includes("暂停") ||
    raw.includes("停止") ||
    raw.includes("取消")
  ) return "paused"
  if (
    ["queued", "pending", "waiting"].includes(raw) ||
    raw.includes("排队") ||
    raw.includes("待处理") ||
    raw === "等待"
  ) return "queued"
  if (
    ["running", "active", "working", "in_progress"].includes(raw) ||
    raw.includes("运行") ||
    raw.includes("生成") ||
    raw.includes("写作") ||
    raw.includes("进行中") ||
    raw.includes("处理中")
  ) return "running"
  return "idle"
}

function normalizeChapterStatus(
  value: unknown,
  words: number,
): Chapter["status"] {
  const raw = text(value).toLowerCase()
  if (["published", "released"].includes(raw)) return "published"
  // ready-for-review(后端待批准态)以前没被收进 review → 掉进下方 words>0 兜底被误标 "done",
  // 导致待审章在 UI 上显示成"完成"、还被计进 finished/已发布数。收齐变体,让"待审"真正区别于 done。
  if (["review", "reviewing", "qa", "ready-for-review", "ready_for_review", "ready", "needs-review", "pending-review", "awaiting-review"].includes(raw)) return "review"
  if (["running", "active", "writing", "in_progress"].includes(raw)) return "writing"
  if (["queued", "pending", "waiting"].includes(raw)) return "queued"
  if (["done", "complete", "completed", "approved", "finished"].includes(raw)) return "done"
  if (["draft", "planned", "todo"].includes(raw)) return "draft"
  return words > 0 ? "done" : "draft"
}

function normalizeBookType(value: unknown): Book["type"] {
  const raw = text(value).toLowerCase()
  if (BOOK_TYPES.includes(raw as Book["type"])) return raw as Book["type"]
  if (raw.includes("short")) return "novel-short"
  if (raw.includes("story") || raw.includes("mid")) return "story"
  return "novel-long"
}

function normalizeWikiNode(
  node: JsonRecord,
  incoming: JsonRecord[],
  outgoing: JsonRecord[],
  byId: Map<string, JsonRecord>,
): WikiNode {
  const id = text(first(node, ["id"]))
  const rawType = text(first(node, ["kind", "type"]), "note")
  const group = text(first(node, ["group"]))
  const path = text(first(node, ["path"]))
  const title = bilingual(first(node, ["title", "name"]), id)
  const subtitle = text(first(node, ["subtitle"]))
  // 文档型词条(伏笔池/世界观/卷纲等)真正的正文在 document.html(后端把 .md 渲染好的 HTML),
  // 而 body 往往只是占位标题 —— 之前只读 body 导致点进去全空。
  const documentObj = asRecord(first(node, ["document"]))
  const documentHtml = text(first(documentObj, ["html"]))
  const documentSummary = text(first(documentObj, ["summary"]))

  return {
    id,
    kind: normalizeWikiKind(rawType),
    title,
    body: optionalText(first(node, ["body", "summary", "content"]) ?? documentSummary),
    html: documentHtml || undefined,
    tags: [rawType, group, path]
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6),
    backlinks: linkedWikiNodes(incoming, byId, ["source", "from", "sourceId"]),
    links: linkedWikiNodes(outgoing, byId, ["target", "to", "targetId"]),
    agentProfileId: optionalText(first(node, ["agentProfileId", "agent_id"])),
    chapterNum: normalizeWikiChapterNum(id, rawType, subtitle),
  }
}

function linkedWikiNodes(
  edges: JsonRecord[],
  byId: Map<string, JsonRecord>,
  keys: string[],
): WikiNode["links"] {
  const seen = new Set<string>()
  return edges.flatMap((edge) => {
    const id = text(first(edge, keys))
    if (!id || seen.has(id)) return []
    seen.add(id)
    const node = byId.get(id)
    return [{ id, title: bilingual(node ? first(node, ["title", "name"]) : id, id) }]
  })
}

function normalizeWikiKind(value: unknown): WikiKind {
  const raw = text(value).toLowerCase()
  if (["chapter"].includes(raw)) return "chapter"
  if (["character", "characters", "role", "cast"].includes(raw)) return "character"
  if (["agent", "profile"].includes(raw)) return "agent"
  if (["constraint", "rules", "rule"].includes(raw)) return "constraint"
  // 设定 / 大纲 / 伏笔 / 剧情结构 全部归入醒目的 setpoint 类，
  // 不再掉进通用「笔记」——这是用户说"知识库没有设定大纲"的根因。
  if (
    [
      "setpoint", "plot", "subplot", "hooks", "hook", "focus", "relationship",
      "world", "volume", "bible", "story_frame", "volume_map", "description",
      "book", "canon", "emotions", "particles", "style",
    ].includes(raw)
  ) {
    return "setpoint"
  }
  return "note"
}

function normalizeWikiChapterNum(
  id: string,
  rawType: string,
  subtitle: string,
): number | undefined {
  if (normalizeWikiKind(rawType) !== "chapter") return undefined
  const value = id.match(/chapter:(\d+)/)?.[1] ?? subtitle.match(/第?(\d+)章/)?.[1]
  return value ? num(value, undefined) : undefined
}

function normalizeSeverity(value: unknown): ReviewIssue["severity"] {
  const raw = text(value).toLowerCase()
  if (raw.includes("high") || raw.includes("critical")) return "high"
  if (raw.includes("low") || raw.includes("minor")) return "low"
  return "med"
}

function normalizeRunStatus(value: unknown): AutoRun["status"] {
  const raw = text(value).toLowerCase()
  if (["completed", "complete", "done", "success"].includes(raw)) return "completed"
  if (["failed", "error", "failure"].includes(raw)) return "failed"
  if (["needs-repair", "needs_repair", "repair-needed"].includes(raw)) return "needs-repair"
  if (raw === "blocked") return "blocked"
  if (["stopped", "cancelled", "canceled"].includes(raw)) return "cancelled"
  if (raw === "paused") return "paused"
  if (["model_done", "model-done"].includes(raw)) return "model_done"
  if (["writing", "repairing", "accepted", "batch-writing", "quality-batch-repairing"].includes(raw)) return raw as AutoRun["status"]
  if (["rewriting", "rewrite", "revising"].includes(raw)) return "rewriting"
  if (["queued", "pending", "waiting"].includes(raw)) return "queued"
  if (["running", "streaming", "creating"].includes(raw)) return "running"
  return "unknown"
}

function normalizeRunEventType(value: unknown): AutoRunEvent["type"] {
  const raw = text(value).toLowerCase()
  if (raw.includes("write:complete") || raw.includes("chapter:complete")) return "chapter.complete"
  if (raw.includes("write:start") || raw.includes("chapter:start")) return "chapter.start"
  if (
    raw.includes("needs-repair") ||
    raw.includes("quality-gate") ||
    raw.includes("quality.gate") ||
    raw.includes("gate.fail")
  ) {
    return "quality.gate.fail"
  }
  if (raw.includes("auto-repair:start") || raw.includes("repair:start")) return "rewrite.trigger"
  if (raw.includes("quality-repair") || raw.includes("repair:complete")) return "rewrite.success"
  if (raw.includes("stale") || raw.includes("error") || raw.includes("fail")) return "run.error"
  if (raw.includes("pause")) return "run.pause"
  if (raw.includes("resume")) return "run.resume"
  const allowed: AutoRunEvent["type"][] = [
    "agent.start",
    "agent.end",
    "chapter.start",
    "chapter.complete",
    "quality.gate.fail",
    "rewrite.trigger",
    "rewrite.success",
    "run.pause",
    "run.resume",
    "run.error",
  ]
  return allowed.includes(raw as AutoRunEvent["type"])
    ? (raw as AutoRunEvent["type"])
    : "agent.start"
}

function inferRunChapterNumber(
  source: JsonRecord,
  resultRecords: JsonRecord[],
): number | undefined {
  return firstPositiveNum(
    first(source, ["currentChapter", "chapterNumber", "chapter"]),
    first(resultRecords.at(-1) ?? {}, ["chapterNumber", "currentChapter", "chapter"]),
    first(resultRecords[0] ?? {}, ["chapterNumber", "currentChapter", "chapter"]),
    chapterNumberFromText(first(source, ["currentStage", "stage"])),
    chapterNumberFromText(first(source, ["failureReason", "reason"])),
    chapterNumberFromText(first(source, ["error", "message"])),
    chapterNumberFromText(first(source, ["suggestion", "hint"])),
  )
}

function chapterNumberFromText(value: unknown): number | undefined {
  const match = text(value).match(/第\s*(\d+)\s*章/)
  return match ? positiveNum(match[1]) : undefined
}

function targetScoreFromText(value: unknown): number | undefined {
  const match = text(value).match(/目标\s*(\d{2,3})\+?/)
  return match ? positiveNum(match[1]) : undefined
}

function firstPositiveNum(...values: unknown[]): number | undefined {
  for (const value of values) {
    const next = positiveNum(value)
    if (next !== undefined) return next
  }
  return undefined
}

function positiveNum(value: unknown): number | undefined {
  const next = optionalNum(value)
  return next !== undefined && next > 0 ? next : undefined
}

function normalizeProviderKind(id: string): LLMProvider["kind"] {
  const raw = id.toLowerCase()
  if (raw.includes("anthropic") || raw.includes("claude")) return "anthropic"
  if (raw.includes("google") || raw.includes("gemini")) return "google"
  if (raw.includes("groq")) return "groq"
  if (raw.includes("xai") || raw.includes("grok")) return "xai"
  if (raw.includes("openrouter")) return "openrouter"
  if (raw.includes("openai") || raw.includes("newapi")) return "openai"
  return "custom"
}

function withSeedContract(prompt: string, seedPrompt?: string) {
  const contractStart = seedPrompt?.indexOf("【流水线契约】") ?? -1
  if (contractStart < 0 || prompt.includes("【流水线契约】")) return prompt
  const contract = seedPrompt?.slice(contractStart).trim()
  return contract ? `${prompt.trimEnd()}\n\n${contract}` : prompt
}

function equivalentAgentId(id: string) {
  return toFrontendAgentId(id)
}

function findBackendAgentId(
  frontendId: string,
  labels: JsonRecord,
  tasksById: Map<string, JsonRecord>,
) {
  if (tasksById.has(frontendId) || labels[frontendId]) return frontendId
  const normalized = equivalentAgentId(frontendId)
  for (const key of new Set([...Object.keys(labels), ...tasksById.keys()])) {
    if (equivalentAgentId(key) === normalized) return key
  }
  return undefined
}

function records(data: unknown, keys: string[]): JsonRecord[] {
  return pickArray(data, keys).filter(isRecord)
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function first(source: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => text(item)).filter(Boolean)
}

function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (isRecord(value)) {
    const title = first(value, ["zh", "en", "title", "name", "id"])
    if (title !== undefined) return text(title, fallback)
  }
  return fallback
}

function optionalText(value: unknown): string | undefined {
  const next = text(value)
  return next || undefined
}

function num(value: unknown, fallback: number): number
function num(value: unknown, fallback: undefined): number | undefined
function num(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""))
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function optionalNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function optionalEpoch(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  return toEpoch(value)
}

function dateString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  return new Date(toEpoch(value)).toISOString()
}

function fraction(value: unknown, fallback = 0): number {
  const next = num(value, fallback)
  return bounded(next > 1 ? next / 100 : next, 0, 1)
}

function percent(value: unknown, fallback = 0): number {
  const next = num(value, fallback)
  return bounded(next <= 1 ? next * 100 : next, 0, 100)
}

function bounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
