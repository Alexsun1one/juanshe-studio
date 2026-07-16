"use client"

import * as React from "react"
import {
  Activity,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Columns2,
  Columns3,
  Edit3,
  AlertCircle,
  CheckCircle2,
  FileText,
  GitCompare,
  Loader2,
  MessagesSquare,
  PanelTop,
  Pause,
  RotateCcw,
  Save,
  Sparkles,
  Target,
  Wrench,
  XCircle,
} from "lucide-react"
import { useSWRConfig } from "swr"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { StudioDrawer } from "@/components/studio/studio-drawer"
import { ReviewRoom } from "@/components/studio/review-room"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useT, useLocale } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { sanitizeAgentOutput } from "@/lib/sanitize-agent-output"
import { useWorkspace } from "@/lib/workspace-context"
import { RunStatePill, type RunState } from "@/components/studio/ds"
import {
  ApiClientError,
  type AgentEvent,
  pauseAutoRun,
  saveManuscript,
  startWriteNextChapter,
  startRepairQualityBatch,
  repairBookState,
  triggerPause,
  triggerRewrite,
} from "@/lib/api/client"
import type { AutoRun, AutoRunCreate } from "@/lib/api/types"
import {
  useChapterStats,
  useChapters,
  useAutoRuns,
  useManuscript,
  useProjectPrefs,
} from "@/hooks/use-studio"
import { useAgentEvents } from "@/hooks/use-agent-events"
import { useToast } from "@/hooks/use-toast"
import { getBookReadiness } from "@/lib/studio/book-readiness"
import {
  latestActiveBookRun,
  latestInterruptedBookRun,
  runProgress,
  runMessage,
} from "@/lib/studio/run-state"
import {
  isAcceptedRunningResult,
  isLiveAutoRunStatus,
} from "@/lib/studio/run-status"
import { AGENTS } from "@/lib/studio-data"
import { agentColor, agentSoftBg, agentBorder } from "@/lib/agent-identity"

type PageMode = 1 | 2 | 3

const SPREAD_GAP = 36
const ONE_COLUMN_WIDTH = "min(78cqw, 1280px)"
const MULTI_COLUMN_WIDTH = "min(88cqw, 1520px)"
const GOAL_CHAPTER_OPTIONS = [1, 3, 5, 10, 20] as const
const MIN_GOAL_CHAPTERS = 1
const MAX_GOAL_CHAPTERS = 50
const MIN_TARGET_QUALITY = 50
const MAX_TARGET_QUALITY = 100

function clampInteger(
  value: number,
  min: number,
  max: number,
  fallback: number,
) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

type ReaderBlock = {
  key: string
  text: string
  quote?: boolean
  muted?: boolean
  cursor?: boolean
  suffix?: string
}

type GoalRunSnapshot = {
  id?: string
  bookId: string
  fromChapter: number
  toChapter: number
  targetWordsPerChapter: number
  targetQuality: number
  maxRewritesPerChapter: number
  currentChapter: number
  currentWords: number
  currentQuality?: number
  currentStage?: string
  status?: string
}

export function WriteMode() {
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const {
    setMode,
    bookId,
    currentChapter,
    selectedChapter,
  } = useStudio()
  const { books } = useWorkspace()
  const currentBook = books.find((book) => book.id === bookId)
  const readiness = getBookReadiness(currentBook)
  const writingBlocked = readiness.resourcesBlocked
  const { data: autoRuns, mutate: refreshAutoRuns } = useAutoRuns()
  const continuationChapter = currentChapter + 1
  const activeRun = latestActiveBookRun(autoRuns, bookId, continuationChapter)
  const interruptedRun = latestInterruptedBookRun(autoRuns, bookId, continuationChapter)
  const shouldFollowActiveRun = selectedChapter === null
  const manuscriptChapter =
    shouldFollowActiveRun && activeRun?.currentChapter && activeRun.currentChapter > currentChapter
      ? activeRun.currentChapter
      : currentChapter
  const { data: manuscript } = useManuscript(bookId, manuscriptChapter, {
    live: Boolean(activeRun),
  })
  const paragraphs =
    manuscript?.chapterNum === manuscriptChapter ? manuscript.paragraphs : []
  const manuscriptPendingForActiveRun =
    Boolean(activeRun) && manuscriptChapter > currentChapter && paragraphs.length === 0
  const liveEvents = useAgentEvents(bookId, Boolean(bookId))
  const dashboardRun = React.useMemo(
    () => activeRun ?? interruptedRun ?? latestBookReportRun(autoRuns, bookId),
    [activeRun, autoRuns, bookId, interruptedRun],
  )
  const liveTokenFresh =
    typeof liveEvents.lastTokenAt === "number" &&
    Date.now() - liveEvents.lastTokenAt < 30_000
  const scopedLiveText = React.useMemo(
    () => buildScopedLiveText(liveEvents.events, {
      runId: activeRun?.id,
      chapter: manuscriptChapter,
    }),
    [activeRun?.id, liveEvents.events, manuscriptChapter],
  )
  const liveDraftText = React.useMemo(
    () =>
      activeRun || liveTokenFresh
        ? extractLiveChapterContent(scopedLiveText || liveEvents.liveText)
        : "",
    [activeRun, liveEvents.liveText, liveTokenFresh, scopedLiveText],
  )

  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const followingEdgeRef = React.useRef(true)
  const activeRunRef = React.useRef(false)
  const autoScrollRafRef = React.useRef<number | null>(null)
  const lastReaderInteractionRef = React.useRef(0)
  const [pageMode, setPageMode] = React.useState<PageMode>(1)
  const [manualMode, setManualMode] = React.useState(false)
  const [manualDraft, setManualDraft] = React.useState("")
  const [workbenchExpanded, setWorkbenchExpanded] = React.useState(false)
  // 默认折叠工作流/控制带 —— 让默认写作视图像参考图一样安静，
  // 只剩极简头 + 正文卡片；需要控制时再展开（渐进式披露，降噪）。
  const [controlsOpen, setControlsOpen] = React.useState(false)
  // 评审室（群聊评审）右栏开关：默认关，活跃运行时自动滑出；用户可手动收起并被记住。
  const [reviewRoomOpen, setReviewRoomOpen] = React.useState(false)
  const reviewRoomUserClosedRef = React.useRef(false)

  React.useEffect(() => {
    activeRunRef.current = Boolean(activeRun)
  }, [activeRun])

  // 读取持久化的评审室开关偏好（每本书各记一份）。
  React.useEffect(() => {
    if (typeof window === "undefined" || !bookId) return
    const saved = window.localStorage.getItem(`studio:review-room:${bookId}`)
    if (saved === "open") {
      setReviewRoomOpen(true)
      reviewRoomUserClosedRef.current = false
    } else if (saved === "closed") {
      setReviewRoomOpen(false)
      reviewRoomUserClosedRef.current = true
    } else {
      reviewRoomUserClosedRef.current = false
    }
  }, [bookId])

  // 运行激活时自动滑出评审室（除非用户在本次显式收起过）。
  React.useEffect(() => {
    if (activeRun && !reviewRoomUserClosedRef.current) {
      setReviewRoomOpen(true)
    }
  }, [activeRun])

  const toggleReviewRoom = React.useCallback(
    (open: boolean) => {
      setReviewRoomOpen(open)
      reviewRoomUserClosedRef.current = !open
      if (typeof window !== "undefined" && bookId) {
        window.localStorage.setItem(
          `studio:review-room:${bookId}`,
          open ? "open" : "closed",
        )
      }
    },
    [bookId],
  )

  React.useEffect(() => {
    followingEdgeRef.current = true
    const el = scrollRef.current
    if (!el) return
    if (activeRunRef.current) return
    el.scrollTo({ left: 0, top: 0, behavior: "auto" })
  }, [bookId, manuscriptChapter])

  const paginated = !manualMode && pageMode !== 1

  const markReaderInteraction = React.useCallback(() => {
    lastReaderInteractionRef.current = performance.now()
  }, [])

  const updateFollowState = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceToEdge = el.scrollHeight - el.clientHeight - el.scrollTop

    // Hysteresis keeps tiny content-height changes from flipping auto-follow on/off.
    if (distanceToEdge < 96) {
      followingEdgeRef.current = true
      return
    }
    if (distanceToEdge > 260) {
      followingEdgeRef.current = false
    }
  }, [])

  const handleReaderWheel = React.useCallback(
    (_event: React.WheelEvent<HTMLDivElement>) => {
      markReaderInteraction()
      updateFollowState()
    },
    [markReaderInteraction, updateFollowState],
  )

  const isReaderLive = Boolean(liveDraftText.trim())
  const shouldAutoWide = Boolean(bookId) || Boolean(activeRun) || isReaderLive

  // 传统三栏布局：左右细栏常驻可见、宽度可拖拽，由用户/折叠按钮控制，
  // 不再因为打开书籍就把两侧整栏自动隐藏（那样用户永远看不到三栏）。
  // 进入写作时只收起画布内的工作台仪表盘，让中间正文区更完整。
  React.useEffect(() => {
    if (shouldAutoWide) {
      setWorkbenchExpanded(false)
    }
  }, [shouldAutoWide])

  React.useEffect(() => {
    if (!isReaderLive || !scrollRef.current) return
    if (!followingEdgeRef.current) return
    if (performance.now() - lastReaderInteractionRef.current < 1200) return

    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current)
    }
    autoScrollRafRef.current = requestAnimationFrame(() => {
      autoScrollRafRef.current = null
      const el = scrollRef.current
      if (!el || !followingEdgeRef.current) return
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    })

    return () => {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current)
        autoScrollRafRef.current = null
      }
    }
  }, [isReaderLive, liveDraftText.length])

  const manuscriptBlocks = React.useMemo<ReaderBlock[]>(() => {
    return paragraphs.map((p, i) => ({
      key: `p-${i}`,
      text: p[lang],
      quote: p.quote,
    }))
  }, [lang, paragraphs])
  const liveReaderBlocks = React.useMemo<ReaderBlock[]>(() => {
    if (!liveDraftText) return []
    const blocks = liveDraftText
      .split(/\n{2,}/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text, index, items) => ({
        key: `live-${index}`,
        text,
        cursor: index === items.length - 1,
      }))
    return [
      {
        key: "live-status",
        text: `第 ${manuscriptChapter} 章实时流式预览，正式快照落库后会自动替换。`,
        muted: true,
      },
      ...blocks,
    ]
  }, [liveDraftText, manuscriptChapter])
  const readerBlocks = liveReaderBlocks.length > 0 ? liveReaderBlocks : manuscriptBlocks
  const paginatedSpreads = React.useMemo(
    () => buildManuscriptSpreads(readerBlocks, pageMode),
    [pageMode, readerBlocks],
  )
  const hasManuscript = readerBlocks.length > 0
  const animateReaderTail = isReaderLive && !manualMode && !paginated
  const generatedText = React.useMemo(() => {
    return paragraphs.map((p) => p[lang]).join("\n\n")
  }, [lang, paragraphs])
  const manualDraftKey = `studio:manual-draft:v2:${bookId}:${manuscriptChapter}:${lang}`

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const saved = window.localStorage.getItem(manualDraftKey)
    setManualDraft(saved && saved.trim() ? saved : generatedText)
  }, [generatedText, manualDraftKey])

  const handleManualDraftChange = React.useCallback(
    (text: string) => {
      setManualDraft(text)
      if (typeof window !== "undefined") {
        window.localStorage.setItem(manualDraftKey, text)
      }
    },
    [manualDraftKey],
  )
  if (writingBlocked) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-border bg-background/60 border-b px-6 py-3 backdrop-blur-sm md:px-10">
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className="border-status-warning/40 bg-status-warning/10 text-status-warning gap-1.5 rounded-full px-2 py-0.5"
            >
              <AlertCircle className="size-3" />
              <span className="text-[10px] font-medium">{readiness.label}</span>
            </Badge>
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight md:text-lg">
              《{currentBook?.title[lang] ?? bookId}》
            </h1>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
          <Alert className="max-w-xl border-status-warning/35 bg-status-warning/10">
            <AlertCircle className="size-4 text-status-warning" />
            <AlertTitle>{readiness.title}</AlertTitle>
            <AlertDescription className="space-y-4">
              <p>{readiness.detail} 为避免误写旧书内容，写作区不会加载兜底稿，也不会启动章节续写。</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setMode("new")}>
                  {readiness.action === "repair" ? "重试建书" : "回到建书"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="bg-transparent"
                  onClick={() => setMode("outline")}
                >
                  查看大纲状态
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ChapterHeader autoRuns={autoRuns} />

      {/* 极简切换条：工作流/仪表盘/控制栏统一收进右侧抽屉，
          写作卡片永远保持安静（全局抽屉模式） */}
      <div
        data-testid="write-workbench"
        className="border-border flex shrink-0 items-center justify-between border-b px-4 py-1.5"
      >
        <StudioDrawer
          size="lg"
          title="工作流与控制"
          description="实时运行 · 流程仪表盘 · 续写/复修/手写控制"
          open={controlsOpen}
          onOpenChange={setControlsOpen}
          trigger={
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors"
            >
              <Wrench className="size-3.5" />
              <span>工作流与控制</span>
              <ChevronDown className="size-3.5" />
            </button>
          }
        >
          {/* 抽屉里只放静态「流程仪表盘」诊断；实时瀑布已移回常驻可见 */}
          <div className="flex flex-col gap-3">
            <WorkflowDashboard
              run={dashboardRun}
              events={liveEvents.events}
              livePreview={liveDraftText}
              nextChapter={continuationChapter}
              expanded={workbenchExpanded}
              onExpandedChange={setWorkbenchExpanded}
            />
          </div>
        </StudioDrawer>
        <div className="ml-auto flex items-center gap-2">
          {(activeRun || interruptedRun) && (
            <span className="text-muted-foreground/70 truncate text-[11px]">
              {activeRun ? "后台任务运行中" : "后台任务中断待续"}
            </span>
          )}
          <button
            type="button"
            onClick={() => toggleReviewRoom(!reviewRoomOpen)}
            aria-pressed={reviewRoomOpen}
            title={reviewRoomOpen ? "收起评审室" : "打开评审室（群聊评审）"}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
              reviewRoomOpen
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <MessagesSquare className="size-3.5" />
            <span className="hidden sm:inline">评审室</span>
            {activeRun && !reviewRoomOpen ? (
              <span className="bg-status-running size-1.5 rounded-full" aria-hidden />
            ) : null}
          </button>
        </div>
      </div>

      {/* 实时工作流瀑布：有任务时常驻可见——每步推进 + 各 agent 产出
          （写作/审稿意见等）像瀑布滚动；内部滚动，不挤走正文 */}
      {(activeRun || interruptedRun) && (
        <div className="border-border max-h-[42vh] shrink-0 overflow-y-auto border-b">
          <LiveRunPanel
            activeRun={activeRun}
            interruptedRun={interruptedRun}
            connected={liveEvents.connected}
          />
        </div>
      )}

      {/* 主操作栏常驻可见：一键续写 / 自动修复 / 我来写 等不再藏进抽屉 */}
      <div className="border-border shrink-0 border-b">
        <ControlBar
          autoRuns={autoRuns}
          pageMode={pageMode}
          manualMode={manualMode}
          manualDraft={manualDraft}
          onAutoRunsRefresh={() => {
            void refreshAutoRuns()
          }}
          onManualModeChange={setManualMode}
          onPageModeChange={setPageMode}
        />
      </div>

      {/* 正文区 + 评审室右栏并排 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* 正文区 */}
      <div className="relative min-h-0 flex-1">
        {/* 顶部渐隐遮罩 */}
        <div className="from-background/95 pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b to-transparent" />
        <div className="from-background/95 pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-gradient-to-t to-transparent" />

        <div
          ref={scrollRef}
          data-testid="manuscript-scroll"
          onScroll={updateFollowState}
          onWheel={handleReaderWheel}
          onPointerDown={markReaderInteraction}
          onTouchStart={markReaderInteraction}
          className={cn(
            "scroll-thin h-full",
            "overflow-x-hidden overflow-y-auto [container-type:inline-size]",
          )}
        >
          <article
            data-testid="manuscript-pages"
            data-page-mode={pageMode}
            className={cn(
              "prose-manuscript min-h-full max-w-none",
              !paginated
                ? "mx-auto px-5 py-10 text-[1.38rem] leading-[2.05] md:px-8 md:py-14"
                : "mx-auto px-4 py-8 md:px-8 md:py-10",
              manualMode && "flex flex-col",
            )}
            style={{
              width: paginated ? MULTI_COLUMN_WIDTH : ONE_COLUMN_WIDTH,
            }}
            aria-label="正文阅读区"
          >
            {manualMode ? (
              <textarea
                data-testid="manual-manuscript-editor"
                aria-label="手写正文编辑器"
                value={manualDraft}
                onChange={(event) => handleManualDraftChange(event.target.value)}
                placeholder="开始写这一章..."
                className="selection:bg-primary/25 min-h-[60vh] flex-1 resize-none bg-transparent font-serif text-[18px] leading-[2] text-foreground outline-none placeholder:text-muted-foreground/45 md:text-[19px]"
              />
            ) : !hasManuscript ? (
              <EmptyManuscriptState
                chapter={manuscriptChapter}
                isGenerating={manuscriptPendingForActiveRun}
                onManualWrite={() => onManualModeChangeFromEmpty(setManualMode)}
              />
            ) : paginated ? (
              <SpreadReader
                spreads={paginatedSpreads}
                pageMode={pageMode}
              />
            ) : (
              <ReaderBlocks
                blocks={readerBlocks}
                animateTail={animateReaderTail}
              />
            )}
            <div className="h-4" />
          </article>
        </div>

      </div>

        {/* 评审室右栏 —— 固定/最大宽度，窄屏可收起；不破坏正文阅读体验 */}
        {reviewRoomOpen ? (
          <div className="hidden w-[min(24rem,40vw)] shrink-0 md:flex lg:w-[min(26rem,32vw)]">
            <ReviewRoom
              bookId={bookId}
              chapterNumber={manuscriptChapter}
              activeRun={Boolean(activeRun)}
              events={liveEvents.events}
              manuscript={liveDraftText}
              onClose={() => toggleReviewRoom(false)}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function onManualModeChangeFromEmpty(setManualMode: (manual: boolean) => void) {
  setManualMode(true)
}

/**
 * 实时尾块 —— 让"按大块到达的 token"读起来像逐字流式：
 * 稳定前缀不重绘（不闪），仅新增片段包进重挂载的淡入 span。
 */
function StreamingTail({ text }: { text: string }) {
  const prevRef = React.useRef("")
  const prev = prevRef.current
  let stable = text
  let fresh = ""
  if (text.length > prev.length && text.startsWith(prev)) {
    stable = prev
    fresh = text.slice(prev.length)
  }
  React.useEffect(() => {
    prevRef.current = text
  }, [text])
  return (
    <>
      {stable}
      {fresh ? (
        <span key={text.length} className="stream-token">
          {fresh}
        </span>
      ) : null}
    </>
  )
}

function ReaderBlocks({
  blocks,
  animateTail = false,
}: {
  blocks: ReaderBlock[]
  animateTail?: boolean
}) {
  const animatedStart = Math.max(0, blocks.length - 3)

  return (
    <>
      {blocks.map((block, index) => (
        <p
          key={block.key}
          className={cn(
            animateTail &&
              index >= animatedStart &&
              !block.cursor &&
              "motion-safe:animate-ink-in",
            block.quote && "quote-line",
            block.muted && "text-muted-foreground/70 italic",
          )}
        >
          {block.cursor ? <StreamingTail text={block.text} /> : block.text}
          {block.cursor && (
            <span
              className="bg-primary ml-0.5 inline-block h-[1.1em] w-[2px] -translate-y-[1px] align-middle animate-typing-cursor"
              aria-hidden
            />
          )}
          {block.suffix && (
            <span className="ml-1 text-[10px] not-italic">{block.suffix}</span>
          )}
        </p>
      ))}
    </>
  )
}

function SpreadReader({
  spreads,
  pageMode,
}: {
  spreads: ReaderBlock[][][]
  pageMode: PageMode
}) {
  const columnGap = pageMode === 3 ? SPREAD_GAP : SPREAD_GAP + 16
  const minSpreadHeight = pageMode === 3 ? "min(62vh, 44rem)" : "min(66vh, 48rem)"
  const columnTextClass =
    pageMode === 3
      ? "text-[1.08rem] leading-[1.92]"
      : "text-[1.18rem] leading-[2]"

  return (
    <div className="space-y-10">
      {spreads.map((spread, spreadIndex) => (
        <section
          key={spreadIndex}
          aria-label={`正文第 ${spreadIndex + 1} 屏`}
          className={cn(
            "grid border-b border-border pb-10 last:border-b-0",
            pageMode === 2 ? "grid-cols-2" : "grid-cols-3",
          )}
          style={{
            columnGap,
            minHeight: minSpreadHeight,
          }}
        >
          {Array.from({ length: pageMode }).map((_, columnIndex) => (
            <div
              key={columnIndex}
              className={cn(
                "min-w-0 border-border pr-6",
                columnIndex < pageMode - 1 && "border-r",
                columnIndex > 0 && "pl-1",
                columnTextClass,
              )}
            >
              <ReaderBlocks blocks={spread[columnIndex] ?? []} />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

function buildManuscriptSpreads(blocks: ReaderBlock[], pageMode: PageMode) {
  const charsPerLine = pageMode === 3 ? 21 : pageMode === 2 ? 29 : 44
  const lineBudget = pageMode === 3 ? 18 : 20
  const columns: ReaderBlock[][] = []
  let currentColumn: ReaderBlock[] = []
  let usedLines = 0

  for (const block of blocks) {
    const lineCount =
      Math.ceil(Math.max(block.text.length, 1) / charsPerLine) +
      (block.quote ? 2 : 1)
    if (
      currentColumn.length > 0 &&
      usedLines + lineCount > lineBudget
    ) {
      columns.push(currentColumn)
      currentColumn = []
      usedLines = 0
    }
    currentColumn.push(block)
    usedLines += lineCount
  }

  if (currentColumn.length > 0) {
    columns.push(currentColumn)
  }

  const spreads: ReaderBlock[][][] = []
  const sourceColumns = columns.length ? columns : [[]]
  for (let index = 0; index < sourceColumns.length; index += pageMode) {
    spreads.push(sourceColumns.slice(index, index + pageMode))
  }
  return spreads.length ? spreads : [[[]]]
}

function EmptyManuscriptState({
  chapter,
  isGenerating,
  onManualWrite,
}: {
  chapter: number
  isGenerating: boolean
  onManualWrite: () => void
}) {
  if (isGenerating) {
    // 生成中 —— 体现状态机的"实时流式待命"面板，
    // 类手稿骨架行优雅填充空白并预示正文将在此处浮现。
    return (
      <div className="animate-rise-in mx-auto flex min-h-[55vh] w-full max-w-2xl flex-col px-2 py-10 md:py-14">
        <div className="flex items-center gap-2.5">
          <span className="state-dot" data-state="streaming" aria-hidden />
          <span className="text-foreground text-ui font-semibold tracking-tight">
            第 {chapter} 章 · 正在生成
          </span>
          <span className="pill ml-auto" data-tone="brand">
            <span className="state-dot" data-state="streaming" aria-hidden />
            实时流式
          </span>
        </div>
        <p className="text-muted-foreground mt-2 text-body leading-relaxed">
          后台已进入本章，多智能体正在成稿。正文落库前不再显示上一章旧稿；
          实时片段会在此自动浮现，无需等待。
        </p>

        {/* 类手稿骨架 —— 把空白变成有呼吸的"正文加载"占位 */}
        <div
          className="mt-8 space-y-3.5"
          aria-hidden
        >
          {[
            "92%", "100%", "84%", "97%", "70%",
            "100%", "88%", "95%", "61%",
          ].map((w, i) => (
            <div
              key={i}
              className="skeleton h-3.5"
              style={{ width: w, animationDelay: `${i * 90}ms` }}
            />
          ))}
        </div>

        <div className="text-muted-foreground/70 mt-8 flex items-center gap-2 text-micro">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          章节快照写入后将自动替换为正式正文
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[55vh] items-center justify-center px-6 py-12 text-center">
      <div className="max-w-md">
        <div className="text-muted-foreground border-border bg-secondary/40 mx-auto mb-3 flex size-11 items-center justify-center rounded-full border">
          <AlertCircle className="size-5" />
        </div>
        <h2 className="text-foreground text-ui font-semibold">
          当前章节还没有正文快照
        </h2>
        <p className="text-muted-foreground mt-2 text-body leading-relaxed">
          前端不会再填入样例稿。点击底部继续生成让后端写入，或进入手写模式先保存一版正文。
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-4 bg-transparent"
          onClick={onManualWrite}
        >
          <Edit3 className="size-3.5" />
          进入手写
        </Button>
      </div>
    </div>
  )
}

// 写手在同一条流式响应里,把正文(CHAPTER_CONTENT)之后紧跟 POST_SETTLEMENT / UPDATED_* 等
// 机器自检账本一起吐出;结算自检子阶段(settler/observer)又走同一个 onTextDelta 通道。这些
// 机器块含 === 分隔符、实体id(environment-1987)、钩子id(0317-7)、反引号 token,是引擎内部
// 噪音,绝不该进"实时生成"正文直播流。在第一个机器尾界标记处截断,从源头堵住泄漏。
const LIVE_TAIL_MARKER_RE =
  /={3,}\s*(?:POST_SETTLEMENT|UPDATED_STATE|UPDATED_LEDGER|UPDATED_HOOKS|RUNTIME_[A-Z0-9_]+)\s*={3,}/i

function extractLiveChapterContent(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return ""

  let content: string
  const contentMarker = trimmed.match(/===\s*CHAPTER_CONTENT\s*===/i)
  if (contentMarker?.index !== undefined) {
    content = trimmed.slice(contentMarker.index + contentMarker[0].length).trim()
  } else {
    const titleMarker = trimmed.match(/(?:^|\n)#\s*第\s*\d+\s*章[^\n]*/m)
    if (titleMarker?.index !== undefined) {
      content = trimmed.slice(titleMarker.index).trim()
    } else if (/===\s*PRE_WRITE_CHECK\s*===|===\s*CHAPTER_TITLE\s*===/.test(trimmed)) {
      return ""
    } else {
      content = trimmed
    }
  }

  // 切尾:POST_SETTLEMENT/UPDATED_* 及其后整段机器账本砍掉,只留正文。
  const tail = content.match(LIVE_TAIL_MARKER_RE)
  if (tail?.index !== undefined) {
    content = content.slice(0, tail.index).trim()
  }
  // 清洗残留机器标记(RUNTIME 块、内部 hook marker),与审稿面板复用同一套。
  return sanitizeAgentOutput(content)
}

function buildScopedLiveText(
  events: AgentEvent[],
  scope: { runId?: string; chapter: number },
) {
  const tokens = events.filter((event): event is Extract<AgentEvent, { type: "token" }> => {
    if (event.type !== "token") return false
    if (scope.runId && event.runId && event.runId !== scope.runId) return false
    const eventChapter = event.chapterNumber ?? event.chapter
    if (eventChapter > 0 && eventChapter !== scope.chapter) return false
    return true
  })
  // 预解析时间戳再排:比较器里 Date.parse 会把 O(e) 次解析放大成 O(e·log e) 次
  const timed = tokens.map((event) => ({ event, at: Date.parse(event.ts) }))
  timed.sort((left, right) => left.at - right.at)

  return timed.map((x) => x.event.text).join("")
}

function emptyChapterStats(bookId: string, currentChapter: number) {
  return {
    bookId,
    chapterNum: currentChapter,
    currentWords: 0,
    todayMinutes: 0,
    todaySeconds: 0,
    chapterTarget: 0,
    thisRunWords: 0,
    chapterPct: 0,
  }
}

function ChapterHeader({ autoRuns }: { autoRuns?: AutoRun[] }) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { ai, bookId, currentChapter, selectedChapter } = useStudio()
  const { books } = useWorkspace()
  const { data: chapters } = useChapters(bookId)
  const currentBook = books.find((book) => book.id === bookId)
  const continuationChapter = currentChapter + 1
  const activeRun = latestActiveBookRun(autoRuns, bookId, continuationChapter)
  const interruptedRun = latestInterruptedBookRun(autoRuns, bookId, continuationChapter)
  const shouldFollowActiveRun = selectedChapter === null
  const displayChapter =
    shouldFollowActiveRun && activeRun?.currentChapter && activeRun.currentChapter > currentChapter
      ? activeRun.currentChapter
      : currentChapter
  const { data: stats } = useChapterStats(bookId, displayChapter)
  const chapter = chapters?.find((item) => item.num === displayChapter)
  const stableStats = stats ?? emptyChapterStats(bookId, displayChapter)

  const title =
    chapter?.title[lang] ??
    (lang === "en" ? `Chapter ${displayChapter}` : `第 ${displayChapter} 章`)
  const bookTitle = currentBook?.title[lang]
  const elapsed = `${stableStats.todayMinutes} ${t("common.minute")} ${stableStats.todaySeconds} ${t("common.seconds")}`
  const thisRunWords = activeRun?.currentWords ?? stableStats.thisRunWords
  const isRunning = Boolean(activeRun)
  const statusLabel = activeRun
    ? t("canvas.aiWriting")
    : interruptedRun
      ? "中断待续"
      : ai === "paused"
        ? t("canvas.aiPaused")
        : t("canvas.aiIdle")
  const statusMessage = activeRun
    ? runMessage(activeRun)
    : interruptedRun
      ? runMessage(interruptedRun)
      : ""

  return (
    <div className="border-border bg-background/60 border-b px-6 py-2 backdrop-blur-sm md:px-10">
      <div className="flex items-center gap-3">
        <RunStatePill
          state={
            (isRunning
              ? "streaming"
              : interruptedRun
                ? "paused"
                : ai === "paused"
                  ? "paused"
                  : "idle") as RunState
          }
          label={statusLabel}
          lang={lang}
          title={statusMessage || undefined}
        />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight md:text-lg">
          {bookTitle ? `《${bookTitle}》 · ${title}` : `《${title}》`}
        </h1>
        <div className="text-muted-foreground hidden items-center gap-3 text-micro md:flex">
          {isRunning ? (
            <>
              <span>
                {t("canvas.elapsed")}{" "}
                <span className="text-foreground font-mono">{elapsed}</span>
              </span>
              <span className="opacity-40">·</span>
            </>
          ) : null}
          <span>
            {isRunning
              ? t("canvas.wordsThisRun")
              : t("canvas.currentChapterWords")}{" "}
            <span className="text-foreground font-mono">
              {isRunning ? "+" : ""}
              {thisRunWords.toLocaleString()}
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}

function ControlBar({
  autoRuns,
  pageMode,
  manualMode,
  manualDraft,
  onAutoRunsRefresh,
  onManualModeChange,
  onPageModeChange,
}: {
  autoRuns?: AutoRun[]
  pageMode: PageMode
  manualMode: boolean
  manualDraft: string
  onAutoRunsRefresh: () => void
  onManualModeChange: (manual: boolean) => void
  onPageModeChange: (mode: PageMode) => void
}) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { ai, setAi, setMode, bookId, currentChapter } = useStudio()
  const { data: stats } = useChapterStats(bookId, currentChapter)
  const { data: prefs } = useProjectPrefs()
  const { toast } = useToast()
  const { mutate } = useSWRConfig()
  const [goalChapters, setGoalChapters] = React.useState(3)
  const [customTargetQuality, setCustomTargetQuality] = React.useState<
    number | null
  >(null)
  const [busy, setBusy] = React.useState<
    "write" | "quality-repair" | "repair" | "pause" | "revise" | "save" | null
  >(null)
  const [goalRunSnapshot, setGoalRunSnapshot] =
    React.useState<GoalRunSnapshot | null>(null)
  const stableStats = stats ?? emptyChapterStats(bookId, currentChapter)
  const thisRunWords = stableStats.thisRunWords
  const chapterTarget = stableStats.chapterTarget
  const chapterPct = stableStats.chapterPct
  const nextChapter = currentChapter + 1
  const activeRun = latestActiveBookRun(autoRuns, bookId, nextChapter)
  const interruptedRun = latestInterruptedBookRun(autoRuns, bookId, nextChapter)
  const hasRunSnapshot = Array.isArray(autoRuns)
  const localPendingRun = ai === "running" && !hasRunSnapshot
  const isRunning =
    Boolean(activeRun) ||
    localPendingRun ||
    Boolean(goalRunSnapshot && ai === "running")
  const targetWords =
    prefs?.defaultRun.targetWordsPerChapter || chapterTarget || 3000
  const defaultTargetQuality = prefs?.defaultRun.targetQuality ?? 90
  const targetQuality = customTargetQuality ?? defaultTargetQuality
  const maxRewrites = prefs?.defaultRun.maxRewritesPerChapter ?? 2
  const plannedGoalToChapter = Math.max(nextChapter, nextChapter + goalChapters - 1)
  const setClampedGoalChapters = React.useCallback((value: number) => {
    setGoalChapters((previous) =>
      clampInteger(value, MIN_GOAL_CHAPTERS, MAX_GOAL_CHAPTERS, previous),
    )
  }, [])
  const setClampedTargetQuality = React.useCallback(
    (value: number) => {
      setCustomTargetQuality((previous) =>
        clampInteger(
          value,
          MIN_TARGET_QUALITY,
          MAX_TARGET_QUALITY,
          previous ?? defaultTargetQuality,
        ),
      )
    },
    [defaultTargetQuality],
  )
  const writePayload = React.useMemo(
    () => ({
      wordCount: targetWords,
      targetScore: targetQuality,
      targetQuality,
      maxRewrites,
      maxRewritesPerChapter: maxRewrites,
      autoRepair: true,
      forceTakeover: true,
    }),
    [maxRewrites, targetQuality, targetWords],
  )
  const goalRunPayload = React.useMemo(
    () => ({
      bookId,
      fromChapter: nextChapter,
      toChapter: plannedGoalToChapter,
      targetWordsPerChapter: targetWords,
      targetQuality,
      maxRewritesPerChapter: maxRewrites,
    }),
    [
      bookId,
      maxRewrites,
      nextChapter,
      plannedGoalToChapter,
      targetQuality,
      targetWords,
    ],
  )
  const plannedGoalSnapshot = React.useMemo(
    () => goalSnapshotFromPayload(goalRunPayload, nextChapter),
    [goalRunPayload, nextChapter],
  )
  const backendRun = activeRun ?? interruptedRun
  const displayGoalSnapshot =
    goalSnapshotFromRun(backendRun) ?? goalRunSnapshot ?? plannedGoalSnapshot
  const goalFromChapter = displayGoalSnapshot.fromChapter
  const goalToChapter = displayGoalSnapshot.toChapter
  const actualGoalChapters = Math.max(1, goalToChapter - goalFromChapter + 1)

  React.useEffect(() => {
    setGoalRunSnapshot(null)
    setCustomTargetQuality(null)
  }, [bookId])

  React.useEffect(() => {
    const snapshot = goalSnapshotFromRun(backendRun)
    if (snapshot) {
      setGoalRunSnapshot(snapshot)
      return
    }
    if (!busy && ai !== "running") {
      setGoalRunSnapshot(null)
    }
  }, [ai, backendRun, busy])

  React.useEffect(() => {
    if (ai !== "running" || !hasRunSnapshot) return
    if (activeRun || interruptedRun || busy === "write" || busy === "quality-repair") {
      return
    }
    const timer = window.setTimeout(() => setAi("idle"), 900)
    return () => window.clearTimeout(timer)
  }, [activeRun, ai, busy, hasRunSnapshot, interruptedRun, setAi])

  async function handleWrite() {
    if (busy) return
    setBusy("write")
    try {
      if (actualGoalChapters > 1) {
        const pendingSnapshot = {
          ...goalSnapshotFromPayload(goalRunPayload, nextChapter),
          status: "queued",
        }
        setGoalRunSnapshot(pendingSnapshot)
        const result = await startRepairQualityBatch(bookId, {
          fromChapter: 1,
          toChapter: currentChapter,
          continueChapters: actualGoalChapters,
          wordCount: targetWords,
          targetScore: targetQuality,
          forceTakeover: true,
        })
        const accepted = isAcceptedRunningResult(result.status)
        setGoalRunSnapshot({
          ...pendingSnapshot,
          id: result.runId,
          status: accepted ? "running" : pendingSnapshot.status,
        })
        setAi(accepted ? "running" : "idle")
        onManualModeChange(false)
        if (accepted) onAutoRunsRefresh()
        toast({
          title: accepted
            ? `已启动连续续写 + 全书质检`
            : "质量流水线未进入运行",
          description: describeBackendAction(
            result,
            `先复核第 1–${currentChapter} 章，低分章自动复修；通过后连续写第 ${nextChapter}–${plannedGoalToChapter} 章，每章质量≥${targetQuality}。`,
          ),
        })
        return
      }

      const result = await startWriteNextChapter(bookId, writePayload)
      const blocked = qualityGatePayload(result)
      if (blocked) {
        await startQualityRepairAfterGate(blocked)
        return
      }

      const accepted = isAcceptedRunningResult(result.status)
      setAi(accepted ? "running" : "idle")
      onManualModeChange(false)
      if (accepted) onAutoRunsRefresh()
      toast({
        title: accepted ? "已启动向下写" : "后端未进入续写",
        description: describeBackendAction(
          result,
          `目标质量≥${targetQuality}，未达标自动复修。`,
        ),
      })
    } catch (error) {
      const blocked = qualityGatePayload(
        error instanceof ApiClientError ? error.payload : null,
      )
      if (blocked) {
        try {
          await startQualityRepairAfterGate(blocked)
          return
        } catch (repairError) {
          setAi("idle")
          toast({
            title: "质量流水线启动失败",
            description:
              repairError instanceof Error
                ? repairError.message
                : String(repairError),
            variant: "destructive",
          })
          return
        }
      }

      setAi("idle")
      setGoalRunSnapshot(null)
      toast({
        title: "续写启动失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  async function startQualityRepairAfterGate(blocked: QualityGateBlockedPayload) {
    const blockedChapter = blocked.chapterNumber ?? currentChapter
    const targetScore =
      blocked.targetScore ??
      writePayload.targetScore ??
      writePayload.targetQuality ??
      90
    setBusy("quality-repair")
    const result = await startRepairQualityBatch(bookId, {
      fromChapter: blockedChapter,
      continueChapters: 1,
      wordCount: writePayload.wordCount,
      targetScore,
      forceTakeover: true,
    })
    const accepted = isAcceptedRunningResult(result.status)
    setAi(accepted ? "running" : "idle")
    onManualModeChange(false)
    if (accepted) onAutoRunsRefresh()
    toast({
      title: accepted ? "已转入连续复修" : "质量流水线未进入运行",
      description: describeBackendAction(
        result,
        `第 ${blockedChapter} 章未达 ${targetScore}+，已先复修，达标后自动写下一章。`,
      ),
    })
  }

  async function handleRepair() {
    if (busy) return
    setBusy("repair")
    try {
      const result = await repairBookState(bookId, { forceTakeover: true })
      const running = isAcceptedRunningResult(result.status)
      setAi(running ? "running" : "idle")
      onManualModeChange(false)
      if (running) onAutoRunsRefresh()
      toast({
        title: result.status === "clean" ? "状态正常，无需修复" : "已启动自动修复",
        description: describeBackendAction(result, "后端会先修复状态链，再允许继续写。"),
      })
    } catch (error) {
      setAi("idle")
      toast({
        title: "自动修复失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  async function handleManualWrite() {
    if (busy) return
    setAi("idle")
    onManualModeChange(true)
    toast({
      title: "已进入手写模式",
      description: "正文可直接编辑，草稿已保存在本机浏览器。",
    })

    if (ai === "running") {
      void triggerPause(bookId, currentChapter).catch(() => {
        // 手写接管不依赖后端停止成功，后端错误会在 AI 续写时继续暴露。
      })
    }
  }

  async function handleSaveManual() {
    if (busy) return
    if (!manualDraft.trim()) {
      toast({
        title: "保存失败",
        description: "正文为空，不能保存当前章节。",
        variant: "destructive",
      })
      return
    }

    setBusy("save")
    try {
      const saved = await saveManuscript(bookId, currentChapter, {
        content: manualDraft,
        locale: lang,
      })
      await mutate(["manuscript", bookId, currentChapter], saved, {
        revalidate: false,
      })
      toast({
        title: "已保存当前章节",
        description: `手写稿已写入章节快照，约 ${countManuscriptWords(manualDraft).toLocaleString()} 字。`,
      })
    } catch (error) {
      toast({
        title: "保存失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  async function handlePause() {
    if (busy) return
    setBusy("pause")
    try {
      if (activeRun) {
        await pauseAutoRun(activeRun.id)
        await mutate(
          "auto-runs",
          (current?: AutoRun[]) =>
            current?.map((run) =>
              run.id === activeRun.id ? { ...run, status: "cancelled" as const } : run,
            ),
          { revalidate: false },
        )
      } else {
        await triggerPause(bookId, currentChapter)
      }
      setAi("idle")
      onAutoRunsRefresh()
      toast({ title: "已停止后台写作" })
    } catch (error) {
      toast({
        title: "停止失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  async function handleRevise() {
    if (busy) return
    setBusy("revise")
    try {
      await triggerRewrite(bookId, currentChapter, { style: "tighten" })
      setAi("running")
      setMode("rewrite")
      onAutoRunsRefresh()
      toast({ title: "已启动后端复修" })
    } catch (error) {
      setAi("idle")
      toast({
        title: "复修启动失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      data-testid="control-bar"
      className="border-border bg-background/70 border-t backdrop-blur-sm"
    >
      <div className="mx-auto grid w-full max-w-[92rem] items-center gap-x-4 gap-y-1 px-5 py-1 md:px-8 xl:grid-cols-[minmax(18rem,1fr)_minmax(0,auto)]">
        {/* progress */}
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground mb-1 flex items-center justify-between text-[10px]">
            <span>{t("canvas.progress")}</span>
            <span className="font-mono">
              {thisRunWords.toLocaleString()} /{" "}
              {chapterTarget.toLocaleString()} {t("common.words")} ·{" "}
              {chapterPct}%
            </span>
          </div>
          <div className="bg-secondary/60 relative h-1.5 overflow-hidden rounded-full">
            <div
              className="from-primary via-primary to-accent h-full rounded-full bg-gradient-to-r transition-all duration-500"
              style={{ width: `${Math.min(100, Math.max(0, chapterPct))}%` }}
            />
          </div>
          <GoalStatusStrip
            activeRun={activeRun}
            interruptedRun={interruptedRun}
            nextChapter={nextChapter}
            snapshot={displayGoalSnapshot}
            goalFromChapter={goalFromChapter}
            goalToChapter={goalToChapter}
            actualGoalChapters={actualGoalChapters}
            targetWords={targetWords}
            targetQuality={targetQuality}
            maxRewrites={maxRewrites}
          />
        </div>

        {/* actions */}
        <div className="scroll-thin flex min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5 xl:shrink-0">
          <PageModeButton
            active={pageMode === 1}
            icon={<PanelTop className="size-3.5" />}
            label="单页纵向滚动"
            onClick={() => onPageModeChange(1)}
          />
          <PageModeButton
            active={pageMode === 2}
            icon={<Columns2 className="size-3.5" />}
            label="双页并排滚动"
            onClick={() => onPageModeChange(2)}
          />
          <PageModeButton
            active={pageMode === 3}
            icon={<Columns3 className="size-3.5" />}
            label="三页并排滚动"
            onClick={() => onPageModeChange(3)}
          />
          <div className="bg-border/60 mx-1 h-5 w-px" />
          <div
            className="border-border bg-secondary/30 flex shrink-0 items-center gap-1 rounded-full border px-2 py-1"
            aria-label="Goal 连写参数"
          >
            <Target className="text-primary size-3.5" />
            <span className="text-muted-foreground text-[10px] font-medium">
              Goal
            </span>
            <div className="hidden items-center gap-0.5 sm:flex">
              {GOAL_CHAPTER_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] transition-colors",
                    goalChapters === option
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                  aria-pressed={goalChapters === option}
                  disabled={busy !== null}
                  onClick={() => setClampedGoalChapters(option)}
                >
                  {option}章
                </button>
              ))}
            </div>
            <label className="text-muted-foreground flex items-center gap-1 text-[10px]">
              <input
                aria-label="Goal 自定义章节数"
                type="number"
                min={MIN_GOAL_CHAPTERS}
                max={MAX_GOAL_CHAPTERS}
                value={goalChapters}
                disabled={busy !== null}
                onChange={(event) =>
                  setClampedGoalChapters(Number(event.target.value))
                }
                className="border-border bg-background text-foreground h-6 w-11 rounded-full border px-2 text-center font-mono text-[11px] outline-none"
              />
              <span>章</span>
            </label>
            <span className="text-muted-foreground/50 text-[10px]">/</span>
            <label className="text-muted-foreground flex items-center gap-1 text-[10px]">
              <span>≥</span>
              <input
                aria-label="Goal 自定义质量分"
                type="number"
                min={MIN_TARGET_QUALITY}
                max={MAX_TARGET_QUALITY}
                value={targetQuality}
                disabled={busy !== null}
                onChange={(event) =>
                  setClampedTargetQuality(Number(event.target.value))
                }
                className="border-border bg-background text-foreground h-6 w-12 rounded-full border px-2 text-center font-mono text-[11px] outline-none"
              />
              <span>分</span>
            </label>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            disabled={busy !== null}
            onClick={handleRepair}
            title="修复章节状态链；低分质量复修会由“向下写 + 自动复修”自动接管。"
          >
            {busy === "repair" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Wrench className="size-3.5" />
            )}
            <span className="hidden sm:inline">自动修复</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            disabled={busy !== null}
            onClick={handleRevise}
          >
            {busy === "revise" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            <span className="hidden sm:inline">{t("canvas.revise")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            disabled={busy !== null}
            onClick={handleManualWrite}
          >
            {busy === "pause" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Edit3 className="size-3.5" />
            )}
            <span className="hidden sm:inline">
              {manualMode ? "手写中" : t("canvas.write")}
            </span>
          </Button>
          {manualMode && (
            <Button
              variant="outline"
              size="sm"
              className="bg-transparent gap-1.5 text-xs"
              disabled={busy !== null}
              onClick={handleSaveManual}
            >
              {busy === "save" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              <span className="hidden sm:inline">保存</span>
            </Button>
          )}
          {isRunning ? (
            <Button
              size="sm"
              variant="outline"
              onClick={handlePause}
              disabled={busy !== null}
              className="order-first shrink-0 bg-transparent gap-1.5"
            >
              {busy === "pause" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Pause className="size-3.5" />
              )}
              <span className="text-xs">{t("canvas.pause")}</span>
            </Button>
          ) : (
            <Button
              data-testid="goal-write-button"
              size="sm"
              onClick={handleWrite}
              disabled={busy !== null}
              className="from-primary to-primary/80 hover:from-primary/95 hover:to-primary/75 order-first shrink-0 bg-gradient-to-r gap-1.5 shadow-md shadow-primary/20"
              title={`连续续写 ${actualGoalChapters} 章；先复核现有章节，低分自动修复，通过后再写新章。质量目标≥${targetQuality}，最大复修 ${maxRewrites} 次。`}
            >
              {busy === "write" || busy === "quality-repair" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              <span className="text-xs">
                {busy === "quality-repair"
                  ? "复修接管中"
                  : interruptedRun
                    ? `连续修复并续写 · ${actualGoalChapters}章`
                    : actualGoalChapters > 1
                      ? `连续续写+修复 ${actualGoalChapters}章`
                      : "向下写 + 自动复修"}
              </span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function goalSnapshotFromRun(run: AutoRun | undefined): GoalRunSnapshot | null {
  if (!run) return null
  return {
    id: run.id,
    bookId: run.bookId,
    fromChapter: run.fromChapter,
    toChapter: run.toChapter,
    targetWordsPerChapter: run.targetWordsPerChapter,
    targetQuality: run.targetQuality,
    maxRewritesPerChapter: run.maxRewritesPerChapter,
    currentChapter: run.currentChapter,
    currentWords: run.currentWords,
    currentQuality: run.currentQuality,
    currentStage: run.currentStage,
    status: run.status,
  }
}

function goalSnapshotFromPayload(
  payload: AutoRunCreate,
  currentChapter: number,
): GoalRunSnapshot {
  return {
    ...payload,
    currentChapter: Math.min(
      payload.toChapter,
      Math.max(payload.fromChapter, currentChapter),
    ),
    currentWords: 0,
    status: "planned",
  }
}

function goalSnapshotProgress(snapshot: GoalRunSnapshot | null | undefined) {
  if (!snapshot) return 0
  const chapterCount = Math.max(1, snapshot.toChapter - snapshot.fromChapter + 1)
  const chapterOffset = Math.min(
    chapterCount,
    Math.max(0, snapshot.currentChapter - snapshot.fromChapter),
  )
  const wordProgress = Math.min(
    0.95,
    Math.max(
      0,
      snapshot.currentWords / Math.max(1, snapshot.targetWordsPerChapter),
    ),
  )
  return Math.min(1, Math.max(0, (chapterOffset + wordProgress) / chapterCount))
}

function latestBookReportRun(autoRuns: AutoRun[] | undefined, bookId: string) {
  return autoRuns
    ?.filter((run) => run.bookId === bookId)
    .filter((run) => run.results.length > 0 || run.recentEvents.length > 0)
    .sort((left, right) => right.startedAt - left.startedAt)[0]
}

function WorkflowDashboard({
  run,
  events,
  livePreview,
  nextChapter,
  expanded,
  onExpandedChange,
}: {
  run?: AutoRun
  events: AgentEvent[]
  livePreview: string
  nextChapter: number
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  const agentCards = React.useMemo(
    () => latestAgentOutputCards(run, events).slice(0, 4),
    [events, run],
  )
  const results = run?.results ?? []
  const report = summarizeRunResults(results)
  const latestResult = [...results]
    .reverse()
    .find((item) => item.scoreAfter !== undefined || item.changes?.length || item.error)
  const latestChange = latestResult?.changes?.[0]
  const preview = livePreview.trim()
    ? livePreview.trim().slice(-180)
    : run?.currentStage ?? `待启动第 ${nextChapter} 章`
  const latestCard = agentCards[0]
  const reportText = report.total
    ? `${report.pass}/${report.total} 达标`
    : typeof run?.currentQuality === "number"
      ? `${Math.round(run.currentQuality)}/100`
      : "等待结果"
  const statusText = run
    ? isLiveAutoRunStatus(run.status)
      ? "运行中"
      : run.status === "completed"
        ? "已完成"
        : run.status === "failed"
          ? "需处理"
          : run.status === "paused"
            ? "已暂停"
            : run.status
    : "待命"
  const compactDetail = latestCard
    ? `${latestCard.agent} · ${latestCard.detail}`
    : preview

  if (!expanded) {
    return (
      <section
        data-testid="workflow-dashboard"
        className="border-border border-t px-4 py-1 md:px-6"
      >
        <div className="mx-auto flex min-h-8 w-full max-w-[92rem] items-center gap-3 overflow-hidden">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Activity className="text-primary size-3.5 shrink-0" />
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                isLiveAutoRunStatus(run?.status)
                  ? "bg-status-running"
                  : "bg-muted-foreground/45",
              )}
            />
            <span className="shrink-0 text-xs font-semibold">工作流</span>
            <span className="text-muted-foreground shrink-0 text-[11px]">
              {statusText}
            </span>
            <span className="text-muted-foreground min-w-0 truncate text-[11px]">
              {compactDetail}
            </span>
          </div>
          <div className="hidden shrink-0 items-center gap-2 text-[10px] md:flex">
            <span className="text-muted-foreground">{reportText}</span>
            {run?.id ? (
              <span className="text-muted-foreground/70 font-mono">
                {run.id.slice(0, 16)}
              </span>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            title="展开工作流详情"
            aria-label="展开工作流详情"
            onClick={() => onExpandedChange(true)}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section
      data-testid="workflow-dashboard"
      className="border-border border-t px-4 py-2 md:px-6"
    >
      <div className="mx-auto mb-2 flex w-full max-w-[92rem] items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="text-primary size-3.5 shrink-0" />
          <span className="text-xs font-semibold">工作流详情</span>
          <span className="text-muted-foreground min-w-0 truncate text-[11px]">
            {compactDetail}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          title="收起工作流详情"
          aria-label="收起工作流详情"
          onClick={() => onExpandedChange(false)}
        >
          <ChevronUp className="size-3.5" />
        </Button>
      </div>
      <div className="mx-auto grid w-full max-w-[92rem] gap-2 lg:grid-cols-[1.05fr_1fr_1.05fr]">
        <div className="border-border bg-secondary/20 min-w-0 rounded-md border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Activity className="text-primary size-3.5" />
              Agent 动作
            </div>
            <span className="text-muted-foreground truncate font-mono text-[9px]">
              {run?.id ? run.id.slice(0, 16) : "waiting"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {agentCards.length ? (
              agentCards.map((card) => (
                <div
                  key={card.key}
                  className="border-border bg-background/45 min-w-0 rounded-md border px-2 py-1.5"
                >
                  <div className="flex items-center gap-1.5 text-[10px] font-medium">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        card.tone === "error"
                          ? "bg-status-danger"
                          : card.tone === "warn"
                            ? "bg-status-warning"
                            : "bg-status-running",
                      )}
                    />
                    <span className="truncate">{card.agent}</span>
                  </div>
                  <div className="text-muted-foreground mt-1 line-clamp-2 text-[10px] leading-4">
                    {card.detail}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-muted-foreground col-span-2 py-3 text-[11px]">
                启动后会按规划、写手、审稿、修稿、质量报告的顺序显示每个 agent 的当前输出。
              </div>
            )}
          </div>
        </div>

        <div className="border-border bg-secondary/20 min-w-0 rounded-md border p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
            <FileText className="text-primary size-3.5" />
            输出内容
          </div>
          <div className="text-muted-foreground line-clamp-5 min-h-[5rem] text-[11px] leading-5">
            {preview}
          </div>
        </div>

        <div className="border-border bg-secondary/20 min-w-0 rounded-md border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <GitCompare className="text-primary size-3.5" />
              修复报告
            </div>
            <span className="text-muted-foreground text-[10px]">
              {reportText}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <ReportMetric label="前" value={formatScore(report.avgBefore)} />
            <ReportMetric label="后" value={formatScore(report.avgAfter)} />
            <ReportMetric
              label="提升"
              value={report.avgGain === undefined ? "--" : `+${report.avgGain}`}
              positive={Boolean(report.avgGain && report.avgGain > 0)}
            />
          </div>
          <div className="mt-2 space-y-1">
            {results.slice(-3).map((item) => (
              <div
                key={`${item.chapterNumber}:${item.scoreBefore}:${item.scoreAfter}:${item.status ?? ""}`}
                className="grid grid-cols-[3.5rem_minmax(0,1fr)_2.4rem] items-center gap-2 text-[10px]"
              >
                <span className="text-muted-foreground">Ch.{item.chapterNumber}</span>
                <span className="truncate">
                  {formatScore(item.scoreBefore)} -&gt; {formatScore(item.scoreAfter)}
                  {item.skipped ? " · 已达标跳过" : item.generated ? " · 新写入" : " · 已复修"}
                </span>
                <span
                  className={cn(
                    "flex items-center justify-end",
                    item.pass ? "text-status-success" : "text-status-warning",
                  )}
                  title={item.pass ? "达标" : item.error || item.failureReason || "待复修"}
                >
                  {item.pass ? (
                    <CheckCircle2 className="size-3.5" />
                  ) : (
                    <XCircle className="size-3.5" />
                  )}
                </span>
              </div>
            ))}
            {latestChange ? (
              <div className="border-border mt-1 rounded-md border px-2 py-1 text-[10px] leading-4">
                <span className="text-muted-foreground">对比：</span>
                <span>{latestChange.before || "原问题"}</span>
                <span className="text-muted-foreground"> -&gt; </span>
                <span>{latestChange.after || latestChange.reason || "已修复"}</span>
              </div>
            ) : !results.length ? (
              <div className="text-muted-foreground py-1 text-[10px]">
                每章完成后会显示修改前后分数、是否自动复修、改动摘要和失败原因。
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}

function ReportMetric({
  label,
  value,
  positive = false,
}: {
  label: string
  value: string
  positive?: boolean
}) {
  return (
    <div className="border-border bg-background/40 rounded-md border px-2 py-1">
      <div className="text-muted-foreground text-[9px]">{label}</div>
      <div
        className={cn(
          "font-mono text-[12px] font-semibold",
          positive && "text-status-success",
        )}
      >
        {value}
      </div>
    </div>
  )
}

function latestAgentOutputCards(run: AutoRun | undefined, events: AgentEvent[]) {
  const cards = new Map<
    string,
    { key: string; agent: string; detail: string; ts: number; tone: LiveRunRow["tone"] }
  >()
  const setCard = (
    agent: string | undefined,
    detail: string | undefined,
    ts: number,
    tone: LiveRunRow["tone"] = "info",
  ) => {
    const agentName = agent || "system"
    const text = detail?.trim()
    if (!text) return
    const current = cards.get(agentName)
    if (current && current.ts > ts) return
    cards.set(agentName, {
      key: `${agentName}:${ts}`,
      agent: agentName,
      detail: text,
      ts,
      tone,
    })
  }

  run?.recentEvents.forEach((event) => {
    setCard(
      event.agentId,
      event.message.zh || event.message.en,
      event.ts,
      event.type === "run.error" ? "error" : "info",
    )
  })
  events.forEach((event) => {
    const ts = Date.parse(event.ts) || Date.now()
    if (event.type === "stage-update") {
      const [agent, ...rest] = event.stage.split(" · ")
      setCard(
        rest.length ? agent : "system",
        rest.length ? rest.join(" · ") : event.stage,
        ts,
      )
    }
    if (event.type === "log") {
      setCard(
        event.agentId,
        event.message,
        ts,
        event.level === "error" ? "error" : event.level === "warn" ? "warn" : "info",
      )
    }
    if (event.type === "metric") {
      setCard("metric", `${event.key}: ${event.value}`, ts)
    }
  })

  return [...cards.values()].sort((left, right) => right.ts - left.ts)
}

function summarizeRunResults(results: AutoRun["results"]) {
  const scored = results.filter(
    (item) => item.scoreBefore !== undefined || item.scoreAfter !== undefined,
  )
  const beforeValues = scored
    .map((item) => item.scoreBefore)
    .filter((value): value is number => typeof value === "number")
  const afterValues = scored
    .map((item) => item.scoreAfter)
    .filter((value): value is number => typeof value === "number")
  const avgBefore = average(beforeValues)
  const avgAfter = average(afterValues)
  return {
    total: results.length,
    pass: results.filter((item) => item.pass).length,
    avgBefore,
    avgAfter,
    avgGain:
      avgBefore === undefined || avgAfter === undefined
        ? undefined
        : Math.round(avgAfter - avgBefore),
  }
}

function average(values: number[]) {
  if (!values.length) return undefined
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function formatScore(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Math.round(value))
    : "--"
}

function GoalStatusStrip({
  activeRun,
  interruptedRun,
  nextChapter,
  snapshot,
  goalFromChapter,
  goalToChapter,
  actualGoalChapters,
  targetWords,
  targetQuality,
  maxRewrites,
}: {
  activeRun?: AutoRun
  interruptedRun?: AutoRun
  nextChapter: number
  snapshot: GoalRunSnapshot
  goalFromChapter: number
  goalToChapter: number
  actualGoalChapters: number
  targetWords: number
  targetQuality: number
  maxRewrites: number
}) {
  const run = activeRun ?? interruptedRun
  const progress = Math.round(
    (run ? runProgress(run) : goalSnapshotProgress(snapshot)) * 100,
  )
  const currentChapter = run?.currentChapter ?? snapshot.currentChapter ?? nextChapter
  const displayTargetWords = snapshot.targetWordsPerChapter || targetWords
  const displayTargetQuality = snapshot.targetQuality || targetQuality
  const displayMaxRewrites = snapshot.maxRewritesPerChapter ?? maxRewrites
  const snapshotLive = isLiveAutoRunStatus(snapshot.status)
  const statusText = activeRun
    ? "执行中"
    : interruptedRun
      ? "中断待续"
      : snapshotLive
        ? "执行中"
        : `${actualGoalChapters} 章待命`
  const stage =
    interruptedRun && run
      ? runMessage(run)
      : run?.currentStage || snapshot.currentStage || (run ? runMessage(run) : "")
  const qualityText =
    typeof (run?.currentQuality ?? snapshot.currentQuality) === "number"
      ? `当前质量 ${run?.currentQuality ?? snapshot.currentQuality}/100`
      : `质量>=${displayTargetQuality}`

  return (
    <div
      data-testid="goal-status-strip"
      className="text-muted-foreground mt-1 flex max-h-9 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 overflow-hidden text-[10px]"
    >
      <span className="text-foreground font-medium">
        目标：第 {goalFromChapter}-{goalToChapter} 章
      </span>
      <span>当前 {currentChapter}/{goalToChapter}</span>
      <span>{displayTargetWords.toLocaleString()} 字/章</span>
      <span>{qualityText}</span>
      <span>{`最多返修 ${displayMaxRewrites} 次`}</span>
      <span className="text-status-success">没达标先修</span>
      <span className="text-muted-foreground/80">{statusText}</span>
      {run || progress > 0 ? (
        <span className="flex min-w-[6rem] items-center gap-1.5">
          <span className="bg-secondary/70 h-1 w-16 overflow-hidden rounded-full">
            <span
              className="bg-primary block h-full rounded-full transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
          </span>
          <span className="font-mono">{progress}%</span>
        </span>
      ) : null}
      {stage ? (
        <span className="min-w-0 max-w-[18rem] truncate" title={stage}>
          {stage}
        </span>
      ) : null}
    </div>
  )
}

function countManuscriptWords(text: string) {
  const latinWords = text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0
  const cjkChars = text.match(/[\u3400-\u9fff]/g)?.length ?? 0
  return latinWords + cjkChars
}

type LiveRunRow = {
  key: string
  ts: number
  tone: "info" | "warn" | "error"
  label: string
  detail: string
}

function LiveRunPanel({
  activeRun,
  interruptedRun,
  connected,
}: {
  activeRun?: AutoRun
  interruptedRun?: AutoRun
  connected: boolean
}) {
  const run = activeRun ?? interruptedRun
  const { locale } = useLocale()
  const agentLang = locale === "en" ? "en" : "zh"
  const currentAgent = run?.currentAgentId
    ? AGENTS.find((a) => a.id === run.currentAgentId)
    : undefined

  const liveState: RunState = activeRun
    ? "streaming"
    : interruptedRun
      ? "paused"
      : "idle"
  const liveLabel = activeRun
    ? "实时流转中"
    : interruptedRun
      ? "中断待续"
      : connected
        ? "待命工作台"
        : "事件流重连中"
  const stageText =
    (interruptedRun ? runMessage(interruptedRun) : run?.currentStage) ||
    (connected ? "事件流已连接，等待启动 Goal" : "事件流重连中")
  const nextAgent = currentAgent ? nextAgentAfter(currentAgent.id) : undefined
  const handoffReason =
    (run ? runMessage(run) : "") ||
    (currentAgent && nextAgent
      ? agentLang === "en"
        ? `After ${currentAgent.role.en}, hand off to ${nextAgent.role.en}`
        : `${currentAgent.role.zh}完成后交给${nextAgent.role.zh}`
      : "")

  // 单行紧凑态 —— 把原 84px 多行面板压成一条，把纵向空间还给正文区。
  // 完整事件流 / 15 智能体推进顺序在「工作流」展开态中查看。
  return (
    <section data-testid="live-run-panel" className="px-4 md:px-6">
      <div className="mx-auto flex h-9 w-full max-w-[92rem] items-center gap-2.5 overflow-hidden">
        <RunStatePill state={liveState} label={liveLabel} lang={agentLang} />

        {currentAgent ? (
          <span
            className="pill shrink-0"
            data-tone="brand"
            title={`${currentAgent.num}. ${currentAgent.name[agentLang]} · ${currentAgent.role[agentLang]}`}
          >
            {/* 该 agent 的专属色点（全站统一身份）—— 扫一眼知道是谁在动 */}
            <span
              className="size-1.5 shrink-0 rounded-full motion-safe:animate-pulse"
              style={{ background: agentColor(currentAgent.id) }}
              aria-hidden
            />
            <span className="font-mono opacity-70">
              {String(currentAgent.num).padStart(2, "0")}
            </span>
            {currentAgent.name[agentLang]}
          </span>
        ) : null}

        {currentAgent ? (
          <span
            data-testid="agent-handoff-strip"
            className="border-border bg-secondary/25 text-muted-foreground hidden min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-micro lg:inline-flex"
            title={[
              `${currentAgent.num}. ${currentAgent.name[agentLang]} · ${currentAgent.role[agentLang]}`,
              nextAgent
                ? `${nextAgent.num}. ${nextAgent.name[agentLang]} · ${nextAgent.role[agentLang]}`
                : "",
              handoffReason,
            ]
              .filter(Boolean)
              .join(" / ")}
          >
            <GitCompare className="text-primary size-3 shrink-0" />
            <span className="text-foreground max-w-[7rem] truncate">
              {currentAgent.name[agentLang]}
            </span>
            <ArrowRight className="size-3 shrink-0 opacity-60" />
            <span className="max-w-[7rem] truncate">
              {nextAgent
                ? nextAgent.name[agentLang]
                : agentLang === "en"
                  ? "Closeout"
                  : "收口"}
            </span>
          </span>
        ) : null}

        <AgentOrderStrip
          currentAgentId={run?.currentAgentId}
          nextAgentId={nextAgent?.id}
        />

        <span className="text-muted-foreground min-w-0 flex-1 truncate text-cap">
          {stageText}
        </span>

        {run?.id ? (
          <span className="text-muted-foreground/60 hidden shrink-0 font-mono text-micro sm:inline">
            {run.id.slice(0, 18)}
          </span>
        ) : null}
      </div>
    </section>
  )
}

function AgentOrderStrip({
  currentAgentId,
  nextAgentId,
}: {
  currentAgentId?: string
  nextAgentId?: string
}) {
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const orderedAgents = React.useMemo(
    () => [...AGENTS].sort((a, b) => a.num - b.num),
    [],
  )

  return (
    <div
      data-testid="agent-order-strip"
      className="scroll-thin hidden h-6 gap-1.5 overflow-x-auto pb-0.5 lg:flex"
      aria-label="Agent 推进顺序"
    >
      {orderedAgents.map((agent) => {
        const isCurrent = agent.id === currentAgentId
        const isNext = agent.id === nextAgentId && !isCurrent
        // 每个 agent 的专属色身份（与右栏阵列 / 工作流连线 / 评审室同源）。
        const color = agentColor(agent.id)
        const emphasized = isCurrent || isNext
        return (
          <div
            key={agent.id}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors",
              isCurrent
                ? "text-foreground font-medium"
                : isNext
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
            style={{
              borderColor: emphasized ? agentBorder(agent.id, 60) : "var(--border)",
              background: emphasized
                ? agentSoftBg(agent.id, isCurrent ? 18 : 12)
                : "color-mix(in oklab, var(--secondary) 25%, transparent)",
            }}
            title={`${agent.num}. ${agent.name[lang]} · ${agent.role[lang]}`}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                isCurrent && "motion-safe:animate-pulse",
              )}
              style={{ background: color, opacity: emphasized ? 1 : 0.7 }}
              aria-hidden
            />
            <span className="font-mono text-[9px] opacity-70">
              {String(agent.num).padStart(2, "0")}
            </span>
            <span className="whitespace-nowrap">{agent.name[lang]}</span>
            {isNext ? (
              <ArrowRight className="size-3" style={{ color }} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function nextAgentAfter(agentId: string) {
  const orderedAgents = [...AGENTS].sort((a, b) => a.num - b.num)
  const index = orderedAgents.findIndex((agent) => agent.id === agentId)
  return index >= 0 ? orderedAgents[index + 1] : undefined
}

type QualityGateBlockedPayload = {
  status?: string
  chapterNumber?: number
  targetScore?: number
  failureReason?: string
  suggestion?: string
}

function qualityGatePayload(value: unknown): QualityGateBlockedPayload | null {
  if (!isRecord(value)) return null
  if (value.status !== "quality-gate-blocked") return null
  return {
    status: typeof value.status === "string" ? value.status : undefined,
    chapterNumber:
      typeof value.chapterNumber === "number" ? value.chapterNumber : undefined,
    targetScore:
      typeof value.targetScore === "number" ? value.targetScore : undefined,
    failureReason:
      typeof value.failureReason === "string" ? value.failureReason : undefined,
    suggestion:
      typeof value.suggestion === "string" ? value.suggestion : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeBackendAction(
  result: {
    status?: string
    runId?: string
    message?: string
    failureReason?: string
    suggestion?: string
  },
  fallback: string,
) {
  return (
    result.message ||
    [result.failureReason, result.suggestion].filter(Boolean).join(" ") ||
    (result.runId ? `${fallback} run_id: ${result.runId.slice(0, 14)}` : fallback)
  )
}

function PageModeButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="icon"
      className="size-8"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {icon}
    </Button>
  )
}
