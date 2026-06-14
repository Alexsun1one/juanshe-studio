// ============================================================================
// 长卷写作台 — API 契约（前端定义，后端实现）
// 所有接口形状以本文件为准；后端实现需保证 TypeScript 类型一致。
// 详见 docs/API.md（人类可读版）。
// ============================================================================

import type {
  Agent,
  AgentLog,
  AgentStatus,
  Cast,
  Chapter,
  Faction,
  FactionId,
  MemoryItem,
  PlotMilestone,
  Relation,
  RelationKind,
  ReviewIssue,
  Stage,
  WorkflowStage,
} from "@/lib/studio-data"

// ---------- 通用 ----------
export type Locale = "zh" | "en"

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

export type Paginated<T> = {
  items: T[]
  total: number
  cursor?: string
}

// ---------- Agent / 工作流 ----------
export type { Agent, AgentStatus, AgentLog, Stage, WorkflowStage }

/** 当前书籍的工作流快照 */
export type WorkflowSnapshot = {
  bookId: string
  /** 当前激活的阶段 */
  currentStage: WorkflowStage
  /** 各阶段的完成度 0..1 */
  stageProgress: Record<WorkflowStage, number>
  /** 各阶段被实际激活的 agent ids（动态，非全部参与） */
  activeAgentsByStage: Record<WorkflowStage, string[]>
  /** 全局总进度 0..1 */
  totalProgress: number
  /** 启动时间戳（ISO） */
  startedAt: string
  /** 预计完成（ISO，可空） */
  etaAt?: string
}

/** 章节执行队列（一行一个 agent 的任务记录） */
export type RoleQueueItem = {
  bookId: string
  chapterNum: number
  agentId: string
  task: { zh: string; en: string }
  status: AgentStatus
  startTime?: string
  endTime?: string
  /** 本任务输出条目数（用于进度感知） */
  outputCount?: number
}

// ---------- 书 / 章节 ----------
export type Book = {
  id: string
  title: { zh: string; en: string }
  type: "novel-long" | "novel-short" | "story"
  cover?: string
  totalWords: number
  chapterCount: number
  currentChapter: number
  currentChapterPct: number
  createdAt: string
  updatedAt: string
}

export type BookSummary = Book & {
  /** 短型类标签（"长篇" / "短篇" / "番外"） */
  kindLabel: { zh: string; en: string }
  /** 章节计划数 */
  plannedChapters: number
  /** 颜色（书脊色 / 节点色），design tokens 引用名 */
  accent: string
  /** 自动续写运行中（是否在 RunsConsole 出现） */
  autoRunning?: boolean
  /** 建书终态：created / needs-foundation / creating 等 */
  creationStatus?: string
}

export type { Chapter }

export type BookCreateInput = {
  title: string
  genre?: string
  platform?: string
  language?: "zh" | "en" | string
  chapterWordCount?: number
  targetChapters?: number
  brief?: string
  description?: string
  resumeExisting?: boolean
  /** 上传的参考文件(大纲/世界观/设定等)。后端按体量决定内联或先 LLM 摘要再喂架构师。 */
  referenceFiles?: { name: string; content: string }[]
}

export type BookCreateResult = {
  status: string
  bookId: string
  runId?: string
  run?: unknown
}

export type BookUpdateInput = {
  title?: string
  genre?: string
  platform?: string
  brief?: string
  description?: string
  status?: string
  language?: string
  chapterWordCount?: number
  targetChapters?: number
}

/** 全本导出格式(与后端 GET /export 白名单子集对齐):txt=纯文本 / md=带章题 / epub=电子书(二进制) */
export type BookExportFormat = "txt" | "md" | "epub"

export type BookCreateStatus = {
  status: "creating" | "created" | "needs-foundation" | "error" | "stalled" | string
  bookId: string
  runId?: string
  title?: string
  stage?: string
  agent?: string
  agentLabel?: string
  preview?: string
  error?: string
  failureReason?: string
  suggestion?: string
  warning?: string
  book?: BookSummary
  progress?: Record<string, unknown>
  [key: string]: unknown
}

export type BookDescriptionPayload = {
  oneLine: string
  shortIntro: string
  fullIntro: string
  sellingPoints: string[]
  tags: string[]
  platformNotes: string
  markdown?: string
}

export type BookDescriptionResult = {
  ok?: true
  bookId: string
  engine?: string
  description: BookDescriptionPayload
}

export type WriteNextChapterInput = {
  wordCount?: number
  targetScore?: number
  targetQuality?: number
  maxRewrites?: number
  maxRewritesPerChapter?: number
  autoRepair?: boolean
  forceTakeover?: boolean
  instruction?: string
  /** 写作强度档位:light(轻·省 token)/ standard(中)/ max(重·最高质量)。后端按激活等级限档。 */
  mode?: "light" | "standard" | "max"
}

export type WriteNextChapterResult = {
  status?: string
  ok?: true
  bookId?: string
  runId?: string
  run?: unknown
  chapterNumber?: number
  error?: unknown
  failureReason?: string
  suggestion?: string
  message?: string
}

export type BookRepairStateResult = {
  status?: string
  ok?: true
  bookId?: string
  runId?: string
  run?: unknown
  chapterNumber?: number
  error?: unknown
  failureReason?: string
  suggestion?: string
  message?: string
}

export type BookRepairQualityBatchInput = {
  targetScore?: number
  fromChapter?: number
  toChapter?: number
  continueChapters?: number
  wordCount?: number
  forceTakeover?: boolean
  ignoreFoundationGate?: boolean
  ignoreRepairCircuitBreaker?: boolean
  ignoreExistingQualityGate?: boolean
}

export type BookRepairQualityBatchResult = {
  status?: string
  ok?: true
  bookId?: string
  runId?: string
  run?: unknown
  total?: number
  repairTotal?: number
  continueChapters?: number
  targetScore?: number
  chapterNumber?: number
  error?: unknown
  failureReason?: string
  suggestion?: string
  message?: string
}

export type FoundationModuleAssessment = {
  id?: string
  label?: string
  ready?: boolean
  score?: number
  blockers?: string[]
  repaired?: string[]
  [key: string]: unknown
}

export type FoundationAssessment = {
  ready?: boolean
  score?: number
  blockers?: string[]
  modules?: FoundationModuleAssessment[]
  [key: string]: unknown
}

export type BookFoundationValidateResult = {
  ok?: boolean
  bookId: string
  ready: boolean
  score?: number
  repaired: string[]
  blockers: string[]
  assessment?: FoundationAssessment
  error?: string
  failureReason?: string
  suggestion?: string
  [key: string]: unknown
}

/** 章节详情（含正文） */
export type ChapterDetail = Chapter & {
  bookId: string
  /** 段落数组（流式拼接前的快照） */
  paragraphs: { zh: string; en?: string; quote?: boolean }[]
  /** 字数目标 */
  wordsTarget: number
  /** 已采纳段落数 */
  acceptedParagraphs: number
}

// ---------- 流式生成（Writer） ----------
export type StreamEvent =
  | { type: "start"; chapterNum: number }
  | { type: "token"; agentId: string; text: string }
  | { type: "paragraph-done"; index: number }
  | { type: "agent-status"; agentId: string; status: AgentStatus; load: number }
  | { type: "metric"; key: string; value: number | string }
  | { type: "done"; reason: "complete" | "paused" | "error" }

// ---------- 关系图谱 ----------
export type { Cast, Relation, RelationKind, Faction, FactionId }

export type RelationshipGraph = {
  bookId: string
  /** 焦点角色（中央节点） */
  focusId: string
  /** 派系（节点会按 factionId 归组上色） */
  factions: Faction[]
  /** 节点 */
  nodes: Cast[]
  /** 边 */
  edges: Relation[]
  /** 提取版本号（每次重算后端递增，前端可缓存） */
  version: number
  /** 上次更新（ISO） */
  updatedAt: string
  /** 提取该图谱时所到达的章节，便于「按章节回放」 */
  uptoChapter?: number
}

// ---------- 剧情推进 ----------
export type { PlotMilestone }

export type PlotProgress = {
  bookId: string
  milestones: PlotMilestone[]
  /** 当前章节命中的 milestone id */
  currentMilestoneId: string
  /** 节奏分布（每章节的张力 0..1，按章节序） */
  tensionCurve: { chapter: number; tension: number }[]
}

// ---------- 记忆 ----------
export type { MemoryItem }

export type MemoryQuery = {
  bookId: string
  kind?: MemoryItem["kind"]
  chapter?: number
  cursor?: string
  limit?: number
}

// ---------- 知识与资产 ----------
export type KnowledgeNode = {
  id: string
  title: { zh: string; en: string }
  count: number
  category?: string
}

export type Asset = {
  id: string
  name: { zh: string; en: string }
  type: "doc" | "image" | "audio" | "video"
  size?: number
  updatedAt?: string
}

// ---------- 质量与审稿 ----------
export type { ReviewIssue }

export type QualityMetrics = {
  bookId: string
  chapterNum: number
  /** 0..100 */
  overall: number
  consistency: number
  pacing: number
  emotion: number
  diction: number
  /** 0..100,高=越像人写,低=AI 痕迹重(段长方差/套话/转折公式/列表式结构/陈词意象等结构化检测) */
  aiTone: number
  adopted: number
  tokens: number
  speedWordsPerMinute: number
  /** 富质量字段（handoff §17#3：UI 需展示主责/阻塞/门禁，不再被 transform 丢弃） */
  total?: number
  band?: string
  gate?: {
    pass?: boolean
    target?: number
    blockers?: string[]
    rule?: string
    ownerAgent?: string
    repairStrategy?: string
  }
  blockers?: string[]
  criticals?: number
  warnings?: number
}

// ---------- 风格指纹 ----------
export type StyleFingerprint = {
  bookId: string
  axes: { axis: { zh: string; en: string }; value: number }[]
  /** 与作者历史样本的匹配度 0..1 */
  matchScore: number
}

// ---------- 市场洞察 ----------
export type MarketOpportunity = {
  id: string
  title: { zh: string; en: string }
  score: number
  trend: "up" | "flat" | "down"
  change: string
}

// ---------- 全局 dock 指标 ----------
export type DockMetrics = {
  speedWordsPerMinute: number
  speedTrend: string
  quality: number
  consistency: number
  adopted: number
  tokens: number
  remaining: number
  remainingPct: number
  etaMinutes: number
}

// ---------- 关系图谱提取（从正文自动识别角色与关系） ----------
/**
 * 后端接受此请求，读取指定章节范围的正文，
 * 通过 NLP/LLM 提取角色实体与关系边，合并入全书图谱。
 *
 * POST /api/v1/books/:id/relationship-graph/extract
 */
export type RelationshipGraphExtractRequest = {
  bookId: string
  /** 提取范围：指定章节或全书 */
  scope: "full" | "recent" | { chapterNums: number[] }
  /** 使用的模型 hint（留空走全局路由策略） */
  modelHint?: string
  /** 是否与现有图谱合并（false = 重建） */
  merge?: boolean
}

/**
 * 提取任务的异步状态回调
 * GET /api/v1/books/:id/relationship-graph/extract/:taskId
 */
export type RelationshipGraphExtractStatus = {
  taskId: string
  status: "pending" | "running" | "done" | "error"
  progress: number          // 0..1，已处理章节比例
  nodesFound: number
  edgesFound: number
  error?: string
}

// ---------- Agent Lab（提示词 / 工作流 / 连通性） ----------
/** 单个 agent 的完整 profile（提示词、模型、参数、版本历史） */
export type AgentProfile = {
  id: string
  name: { zh: string; en: string }
  /** 工作流位置 1..15 */
  step: number
  /** 系统提示词（markdown） */
  systemPrompt: string
  /** 用户消息模板（含 {{vars}}） */
  userTemplate?: string
  /** 输出 schema 描述（自由文本，用于约束输出） */
  outputSchema?: string
  /** 工具/MCP 名 */
  tools: string[]
  /** 模型 id（与 services/models 对齐） */
  model: string
  temperature: number
  maxTokens: number
  /** 是否被锁定（治理） */
  locked?: boolean
  /** 确定性编排器(如执行主编 pipeline runner):非 LLM、无可配置提示词,详情应只读 */
  deterministic?: boolean
  /** 版本历史（用于 restore） */
  versions: {
    id: string
    ts: number
    note?: string
    systemPrompt: string
    /** 触发改动的人/事件 */
    author?: string
  }[]
}

/** 工作流契约：哪些 agent 按什么顺序、handoff 什么数据 */
export type WorkflowContract = {
  steps: {
    id: string
    agentId: string
    /** 上一步产物名 */
    inputs: string[]
    /** 本步产物名 */
    outputs: string[]
    /** 失败时回滚到哪一步 */
    fallback?: string
    /** 是否允许跳过 */
    optional?: boolean
  }[]
}

/** 单 agent 连通性测试结果 */
export type ConnectivityResult = {
  agentId: string
  ok: boolean
  latencyMs: number
  model: string
  testedAt: number
  /** 失败原因 */
  error?: string
  /** 一段示例输出，证明真的通了 */
  sample?: string
}

// ---------- Settings（LLM / 项目 / 偏好） ----------
/** 单个 LLM 提供商配置（OpenAI / Anthropic / 自建 endpoint 等） */
export type LLMProvider = {
  id: string
  name: string
  kind: string
  baseUrl: string
  /** API key 是否已配置（不返回明文） */
  hasKey: boolean
  /** 是否启用 */
  enabled: boolean
  /** 当前选中的默认模型 */
  selectedModel?: string
  /** 上次连通时间 */
  lastTestedAt?: number
  lastTestOk?: boolean
  /** 这个 provider 上可用的模型列表 */
  models: string[]
}

export type LLMProviderPatch = Partial<LLMProvider> & {
  apiKey?: string
  model?: string
}

export type LLMProviderCreateInput = {
  name: string
  baseUrl: string
  model?: string
  apiKey?: string
  enabled?: boolean
  apiFormat?: "chat" | "responses"
  stream?: boolean
}

/** 全局模型路由：哪个 agent 走哪个模型 */
export type ModelRouting = {
  /** key 是 agentId */
  routes: Record<string, string>
  /** 默认模型（兜底） */
  default: string
}

/** 项目级偏好 */
export type ProjectPrefs = {
  locale: "zh-CN" | "en"
  theme: "light" | "dark" | "system"
  /** 自动续写默认参数 */
  defaultRun: {
    targetWordsPerChapter: number
    targetQuality: number
    maxRewritesPerChapter: number
  }
  /** 通知开关 */
  notify: {
    onChapterDone: boolean
    onRunFailed: boolean
    onLowQuality: boolean
  }
}

// ---------- LLM Wiki（Obsidian 风格知识图谱） ----------
export type WikiKind =
  | "chapter"
  | "character"
  | "setpoint"
  | "constraint"
  | "agent"
  | "note"

export type WikiNode = {
  id: string
  kind: WikiKind
  title: { zh: string; en: string }
  /** markdown 主体（懒加载，列表接口可不返回） */
  body?: string
  /** 文档型词条（伏笔池/世界观/卷纲等)的渲染后 HTML 正文（来自后端 document.html） */
  html?: string
  tags: string[]
  /** 反向链接：哪些节点引用了我 */
  backlinks: { id: string; title: { zh: string; en: string } }[]
  /** 正向链接：我引用了谁 */
  links: { id: string; title: { zh: string; en: string } }[]
  /** 仅 agent 类型：与 atelier/agent-profiles 关联 */
  agentProfileId?: string
  /** 仅 chapter：章节号 */
  chapterNum?: number
}

export type WikiResponse = {
  nodes: WikiNode[]
  /** 节点 id → 二维坐标（可选；前端有 fallback 自动布局） */
  layout?: Record<string, { x: number; y: number }>
}

// ---------- 自动续写引擎 ----------
/** 自动续写任务状态 */
export type AutoRunStatus =
  | "queued"
  | "running"
  | "rewriting"
  | "model_done"
  | "writing"
  | "repairing"
  | "accepted"
  | "batch-writing"
  | "quality-batch-repairing"
  | "needs-repair"
  | "blocked"
  | "unknown"
  | "paused"
  | "cancelled"
  | "completed"
  | "failed"

/** 单条事件流（来自 SSE 或轮询） */
export type AutoRunEvent = {
  ts: number
  type:
    | "agent.start"
    | "agent.end"
    | "chapter.start"
    | "chapter.complete"
    | "quality.gate.fail"
    | "rewrite.trigger"
    | "rewrite.success"
    | "run.pause"
    | "run.resume"
    | "run.error"
  agentId?: string
  chapter?: number
  message: { zh: string; en: string }
}

export type AutoRunResult = {
  chapterNumber: number
  title?: string
  status?: string
  generated?: boolean
  skipped?: boolean
  applied?: boolean
  autoRepaired?: boolean
  pass?: boolean
  targetScore?: number
  scoreBefore?: number
  scoreAfter?: number
  wordCount?: number
  repairRunId?: string
  autoRounds?: number
  engine?: string
  error?: string
  failureReason?: string
  suggestion?: string
  changes?: { before?: string; after?: string; reason?: string }[]
  warnings?: string[]
}

/** 自动续写运行任务（持久化形态） */
export type AutoRun = {
  id: string
  bookId: string
  type?: string
  bookTitle: { zh: string; en: string }
  /** 起始章节（包含） */
  fromChapter: number
  /** 终止章节（包含） */
  toChapter: number
  /** 每章目标字数（达不到将触发改写或中止） */
  targetWordsPerChapter: number
  /** 质量阈值 0..100，每章过审分 < 阈值即触发改写 */
  targetQuality: number
  /** 单章允许的最大改写次数；超出则该章节标记为 failed */
  maxRewritesPerChapter: number

  status: AutoRunStatus
  /** 当前正在写的章节 */
  currentChapter: number
  /** 当前章节已经改写次数（含本次） */
  currentRewrite: number
  /** 当前章节内已写出的字数（流式累计） */
  currentWords: number
  /** 当前激活的智能体 id */
  currentAgentId?: string
  /** 后端当前阶段文案 */
  currentStage?: string
  error?: string
  failureReason?: string
  suggestion?: string
  /** 当前章节实时质量分（0..100，每改写一次重算） */
  currentQuality?: number

  /** 启动时间（ms epoch） */
  startedAt: number
  /** 预计完成时间（ms epoch） */
  eta?: number

  /** 累计统计 */
  totalAdoptedWords: number
  totalTokens: number
  totalRewrites: number

  /** 最近 12 条事件（更老的不返） */
  recentEvents: AutoRunEvent[]
  /** 批量续写 / 批量复修的章节结果，用于前端报告 */
  results: AutoRunResult[]
}

/**
 * 真实任务运行的精简视图,来自 `/api/v1/books/:id/runs`。
 * 与前端虚构的 AutoRun 引擎(/auto-runs，后端 404)不同,这是后端 task_runs 的真相,
 * 用来驱动"是否正在写作 / 当前哪个 agent / 当前阶段"等实时状态。
 */
export type BookRun = {
  id: string
  bookId: string
  type?: string
  status: string
  /** 当前激活的 agent(后端 id，如 writer / planner / reviser) */
  currentAgent?: string
  /** 当前阶段文案,如「第 4 章重写中」 */
  currentStage?: string
  chapter?: number | null
  error?: string
  failureReason?: string
  updatedAt?: string
  startedAt?: string | number | null
  events?: {
    kind?: string
    stage?: string
    agent?: string
    time?: string
    failureReason?: string
  }[]
}

/** 本章一轮修订的 before/after(写手原稿→定稿,或每轮质量修复/改写/润色) */
export type ChapterRevisionPass = {
  kind: string
  kindLabel: string
  timestamp: string
  before: string
  after: string
  notes: string
  filename: string
}
export type ChapterRevisionsResult = {
  bookId: string
  chapterNumber: number
  passes: ChapterRevisionPass[]
}

/** 创建任务的入参 */
export type AutoRunCreate = {
  bookId: string
  fromChapter: number
  toChapter: number
  targetWordsPerChapter: number
  targetQuality: number
  maxRewritesPerChapter: number
}

// ---------- 章节正文 ----------
/** 流式手稿（章节正文段落数组） */
export type Manuscript = {
  bookId: string
  chapterNum: number
  paragraphs: { zh: string; en: string; quote?: boolean }[]
  /** 字数已生成的段落数（写手当前推进游标） */
  cursorParagraph: number
}

/** 章节实时统计（写作模式头部 + 控制栏使用） */
export type ChapterStats = {
  bookId: string
  chapterNum: number
  /** 当前书籍累计字数 */
  currentWords: number
  /** 本次会话耗时（分） */
  todayMinutes: number
  /** 本次会话耗时（秒，0..59） */
  todaySeconds: number
  /** 本章字数目标 */
  chapterTarget: number
  /** 本次 run 已写出 */
  thisRunWords: number
  /** 本章完成百分比 0..100 */
  chapterPct: number
}

// ---------- 大纲 ----------
export type OutlineChapter = {
  id: string
  num: number
  title: { zh: string; en: string }
  beats: number
  words: number
  status: string
}

export type OutlineAct = {
  actId: string
  actTitle: { zh: string; en: string }
  chapters: OutlineChapter[]
}

// ---------- 改写建议 ----------
export type RewriteProposal = {
  bookId: string
  chapterNum: number
  /** 改写风格 id（tighten / lyric / dialog / sensory / ...） */
  style: string
  original: { zh: string; en: string }
  revised: { zh: string; en: string }
  /** 与作者风格指纹的匹配度 0..1 */
  matchScore: number
  /** 字数差 (revised - original) */
  wordsDelta: number
}

// ---------- 发布渠道 ----------
export type PublishChannel = {
  id: string
  name: { zh: string; en: string }
  status: "published" | "released" | "queue" | "draft"
  /** 已同步到的章节标签，如 "Ch.4" */
  chapter: string
  /** 上次同步时间（人类可读字符串） */
  lastSync: string
}

// ---------- 世界观节点 ----------
export type WorldNode = {
  id: string
  title: { zh: string; en: string }
  count: number
}

// ---------- 系统健康 ----------
export type SystemHealth = {
  status: "healthy" | "degraded" | "down"
  onlineModels: number
  totalModels: number
  routeSuccessRate24h: number
  avgLatencySeconds: number
  load: number
  hardwriteJson?: boolean
  projectEnv?: boolean
  globalEnv?: boolean
  booksDir?: boolean
  llmConnected?: boolean
  bookCount?: number
  llmProbeCached?: boolean
  llmProbeStale?: boolean
  llmProbeAgeMs?: number
  llmProbeStatus?: "fresh" | "cached" | "stale-timeout" | "failed" | "error"
}

// ============================================================================
// 写作打卡热力图 + 连更里程碑（GitHub 贡献图风格）
//   桌面与 SaaS 登录用户都能用：读当前工作区 state 章节聚合。
//   桌面 saas:false 不送 credits；SaaS 命中里程碑且未领过 → 后端发软配额，
//   newlyRewarded 供前端 CelebrationBurst 庆祝。门禁/发放/幂等全在后端。
// ============================================================================
export interface StreakDay {
  date: string // 本地 YYYY-MM-DD
  words: number
  chapters: number
}
export interface StreakMilestone {
  days: number
  credits: number
}
export interface StreakReward {
  days: number
  credits: number
}
export interface Streak {
  saas: boolean
  calendar: StreakDay[] // 近 53 周升序密集日历（无写作的日子补 0）
  currentStreak: number
  longestStreak: number
  todayWords: number
  activeDays: number
  totalWords: number
  /** 仅 SaaS 返回里程碑配置；桌面 undefined */
  milestones?: StreakMilestone[]
  /** 已领过的里程碑天数集合（幂等去重）；桌面为空数组 */
  rewardedMilestones: number[]
  /** 本次请求新发放的里程碑（供庆祝）；桌面为空数组 */
  newlyRewarded: StreakReward[]
  /** SaaS 当前软配额余额；桌面为 null */
  credits: number | null
}

// ============================================================================
// 接口路径常量（前端只通过 ENDPOINTS 访问 URL，便于后端调整）
// ============================================================================
export const ENDPOINTS = {
  streak: () => `/api/v1/streak`,
  /** 导出全部书稿(整本目录打包 zip · 数据可携带,免费不扣 credits) */
  allBooksExport: () => `/api/v1/export/books`,
  agentList: () => `/api/v1/agents`,
  agentDetail: (id: string) => `/api/v1/agents/${id}`,
  agentLogs: (bookId: string, chapter: number, agentId?: string) =>
    `/api/v1/books/${bookId}/chapters/${chapter}/logs${agentId ? `?role=${agentId}` : ""}`,

  bookDetail: (id: string) => `/api/v1/books/${id}`,
  bookList: () => `/api/v1/books`,
  bookCreate: () => `/api/v1/books`,
  bookCreateStatus: (id: string) => `/api/v1/books/${id}/create-status`,
  bookCreateCancel: (id: string) => `/api/v1/books/${id}/create-cancel`,
  bookWriteNext: (id: string) => `/api/v1/books/${id}/write-next`,
  /** 连续写 N 章(每章按质量门槛把关,不达标即停) */
  bookWriteBatch: (id: string) => `/api/v1/books/${id}/write-batch`,
  bookRepairState: (id: string) => `/api/v1/books/${id}/repair-state`,
  bookRepairQualityBatch: (id: string) =>
    `/api/v1/books/${id}/repair-quality-batch`,
  bookFoundationValidate: (id: string) =>
    `/api/v1/books/${id}/foundation/validate`,
  bookAgentEvents: (id: string, limit = 80) =>
    `/api/v1/books/${id}/agent-events?limit=${encodeURIComponent(String(limit))}`,
  bookExport: (id: string, format: BookExportFormat = "txt") =>
    `/api/v1/books/${id}/export?format=${encodeURIComponent(format)}`,
  bookDescription: (id: string) => `/api/v1/books/${id}/description`,
  bookDetectChapter: (id: string, chapter: number) =>
    `/api/v1/books/${id}/detect/${chapter}`,
  bookDetectAll: (id: string) => `/api/v1/books/${id}/detect-all`,
  bookDetectStats: (id: string) => `/api/v1/books/${id}/detect/stats`,
  bookStyleImport: (id: string) => `/api/v1/books/${id}/style/import`,
  workflow: (id: string) => `/api/v1/books/${id}/workflow`,
  /** 真实任务运行列表(write-next / rewrite / 修复 等),用于判断"是否正在写作" */
  bookRuns: (id: string, limit = 8) =>
    `/api/v1/books/${id}/runs?limit=${encodeURIComponent(String(limit))}`,
  /** 停止本书全部进行中的工作流(真实端点,非 auto-run 引擎) */
  bookWorkflowStop: (id: string) => `/api/v1/books/${id}/workflow/stop`,
  chapters: (id: string) => `/api/v1/books/${id}/chapters`,
  chapter: (id: string, num: number) => `/api/v1/books/${id}/chapters/${num}`,
  roleQueue: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/role-queue`,
  chapterStream: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/stream`,
  chapterContinue: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/continue`,
  chapterPause: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/pause`,
  chapterRewrite: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/rewrite`,
  chapterRepairLowScore: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/repair-low-score`,
  chapterReview: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/review`,
  /** 本章修订快照(写手原稿→定稿 + 每轮修复的 before/after),供评审视图做 diff */
  chapterRevisions: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/revisions`,
  chapterPublish: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/publish`,

  relationshipGraph: (id: string) => `/api/v1/books/${id}/relationship-graph`,
  /** 触发从正文提取关系图谱（POST） */
  relationshipGraphExtract: (id: string) =>
    `/api/v1/books/${id}/relationship-graph/extract`,
  /** 查询提取任务状态（GET） */
  relationshipGraphExtractStatus: (id: string, taskId: string) =>
    `/api/v1/books/${id}/relationship-graph/extract/${taskId}`,
  plotProgress: (id: string) => `/api/v1/books/${id}/plot-progress`,
  memory: (id: string) => `/api/v1/books/${id}/memory`,
  styleFingerprint: (id: string) => `/api/v1/books/${id}/style-fingerprint`,
  quality: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/quality`,
  knowledge: (id: string) => `/api/v1/books/${id}/knowledge`,
  assets: (id: string) => `/api/v1/books/${id}/assets`,
  cast: (id: string) => `/api/v1/books/${id}/cast`,
  world: (id: string) => `/api/v1/books/${id}/world`,
  outline: (id: string) => `/api/v1/books/${id}/outline`,
  publishChannels: (id: string) => `/api/v1/books/${id}/publish-channels`,
  reviewIssues: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/review-issues`,
  manuscript: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/manuscript`,
  chapterStats: (id: string, num: number) =>
    `/api/v1/books/${id}/chapters/${num}/stats`,
  rewriteProposal: (id: string, num: number, style?: string) =>
    `/api/v1/books/${id}/chapters/${num}/rewrite-proposal${style ? `?style=${encodeURIComponent(style)}` : ""}`,

  marketOpportunities: () => `/api/v1/insight/opportunities`,
  systemHealth: () => `/api/v1/system/health`,
  doctor: () => `/api/v1/doctor`,
  daemon: () => `/api/v1/daemon`,
  daemonStart: () => `/api/v1/daemon/start`,
  daemonStop: () => `/api/v1/daemon/stop`,
  radarLatest: () => `/api/v1/radar/latest`,
  radarScan: () => `/api/v1/radar/scan`,
  styleAnalyses: () => `/api/v1/style/analyses`,
  styleAnalyze: () => `/api/v1/style/analyze`,
  genres: () => `/api/v1/genres`,
  genre: (id: string) => `/api/v1/genres/${id}`,
  genreCopy: (id: string) => `/api/v1/genres/${id}/copy`,
  vault: () => `/api/v1/vault`,
  vaultDocument: (path: string) =>
    `/api/v1/vault/document?path=${encodeURIComponent(path)}`,
  vaultFile: (path: string) =>
    `/api/v1/vault/file?path=${encodeURIComponent(path)}`,
  vaultAsset: (path: string) =>
    `/api/v1/vault/asset?path=${encodeURIComponent(path)}`,
  vaultInit: () => `/api/v1/vault/init`,
  vaultImportText: () => `/api/v1/vault/import-text`,
  vaultImportUrl: () => `/api/v1/vault/import-url`,
  vaultSyncBooks: () => `/api/v1/vault/sync-books`,
  interactionSession: () => `/api/v1/interaction/session`,
  sessions: (bookId?: string | null) =>
    `/api/v1/sessions${
      bookId === undefined
        ? ""
        : `?bookId=${bookId === null ? "null" : encodeURIComponent(bookId)}`
    }`,
  session: (id: string) => `/api/v1/sessions/${id}`,
  agentChat: () => `/api/v1/agent`,
  dockMetrics: (id: string) => `/api/v1/books/${id}/metrics`,

  // Agent Lab
  agentProfiles: () => `/api/v1/agent-profiles`,
  agentProfile: (id: string) => `/api/v1/agent-profiles/${id}`,
  agentProfileFeed: (id: string) => `/api/v1/agent-profiles/${id}/feed`,
  agentConnectivity: () => `/api/v1/agent-profiles/connectivity`,
  agentConnectivityOne: (id: string) => `/api/v1/agent-profiles/${id}/test`,
  workflowContract: () => `/api/v1/workflow-contract`,

  // Settings
  llmProviders: () => `/api/v1/llm-providers`,
  llmProvider: (id: string) => `/api/v1/llm-providers/${id}`,
  llmProviderTest: (id: string) => `/api/v1/llm-providers/${id}/test`,
  modelRouting: () => `/api/v1/project/model-routing`,
  projectPrefs: () => `/api/v1/project/prefs`,

  // Wiki
  wiki: (id: string) => `/api/v1/books/${id}/wiki`,
  wikiNode: (id: string, nodeId: string) =>
    `/api/v1/books/${id}/wiki/nodes/${nodeId}`,
  promptInjections: (id: string) => `/api/v1/books/${id}/prompt-injections`,
  effectivePromptInjections: (id: string, agent?: string, chapterNumber?: number) => {
    const query = [
      agent ? `agent=${encodeURIComponent(agent)}` : "",
      chapterNumber ? `chapterNumber=${encodeURIComponent(String(chapterNumber))}` : "",
    ].filter(Boolean).join("&")
    return `/api/v1/books/${id}/prompt-injections/effective${query ? `?${query}` : ""}`
  },

  // 自动续写引擎（多本书并行）
  autoRuns: () => `/api/v1/auto-runs`,
  autoRun: (id: string) => `/api/v1/auto-runs/${id}`,
  autoRunPause: (id: string) => `/api/v1/auto-runs/${id}/pause`,
  autoRunResume: (id: string) => `/api/v1/auto-runs/${id}/resume`,
  autoRunCancel: (id: string) => `/api/v1/auto-runs/${id}/cancel`,
} as const
