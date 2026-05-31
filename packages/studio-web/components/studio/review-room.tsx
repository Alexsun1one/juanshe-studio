"use client"

// ============================================================================
// ReviewRoom — 群聊评审室
// 写手成稿后，其余编辑部 agent（审稿官/修稿师/润色师/总编/读者评审官/质量报告官/
// 状态校验员/字数治理官…）对刚写完的章节做评审，渲染成「实时群聊」：
//   · 顶部：群聊流（按 agent 聚合 token，逐字流式 + 打字态）
//   · 底部：总编裁决卡（通过 / 返工 + 批语 + 评分）
//   · 侧栏/折叠：改写 diff（写手初稿 → 最新改写稿的行级对比）
// 纯实时（订阅既有 SSE 事件流，不调后端、不回放历史、不做重审）。
// 数据来自 write-mode 已有的 useAgentEvents 实例（events 作为 prop 传入，避免重复订阅）。
// ============================================================================

import * as React from "react"
import {
  GitCompare,
  MessagesSquare,
  PanelRightClose,
  ScrollText,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { AgentEvent } from "@/lib/api/client"
import { AGENTS } from "@/lib/studio-data"
import { agentColor, agentSoftBg, agentBorder } from "@/lib/agent-identity"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card"

// ---------------------------------------------------------------------------
// agent 展示元数据 —— 友好中文名 + 单色字号头像，绝不外泄 agentId/原始 JSON。
// ---------------------------------------------------------------------------
type AgentMeta = {
  name: string
  /** 头像取名首字 */
  monogram: string
  /** 头像主题色（设计系统 chart token，不写死 hex） */
  tint: string
}

const AGENT_NAME_BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent.name.zh]))
// 完整 agent 资料(角色 / 职责),供头像 hover 卡展示;按规范 id 归一查找。
const AGENT_DATA_BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]))

// 颜色统一走全站唯一的 agent 色身份(lib/agent-identity),评审室/工作流连线/运行日志同色。
function metaFor(agentId: string): AgentMeta {
  const name = AGENT_NAME_BY_ID.get(agentId) ?? friendlyFallbackName(agentId)
  return {
    name,
    monogram: name.slice(0, 1) || "审",
    tint: agentColor(agentId),
  }
}

// 兜底：未登记的 agentId 也给一个可读中文名，绝不把 id 直接显示给用户。
function friendlyFallbackName(agentId: string): string {
  const dict: Record<string, string> = {
    system: "编辑部",
    "managing-editor": "执行主编",
    auditor: "审稿官",
    reviewer: "审稿官",
    "quality-reporter": "质量报告官",
    "state-validator": "状态校验员",
    "length-normalizer": "字数治理官",
  }
  return dict[agentId] ?? "评审员"
}

// 写手单独高亮：群聊里 ta 是「被评审对象」的作者。
const WRITER_ID = "writer"
// 产出正文（可能改写章节）的 agent —— 用于抓 diff 快照。
const CONTENT_AGENT_IDS = new Set(["writer", "reviser", "polisher", "word-steward"])

// ---------------------------------------------------------------------------
// 群聊消息模型
// ---------------------------------------------------------------------------
type ChatMessage =
  | {
      kind: "agent"
      id: string
      agentId: string
      text: string
      ts: number
      /** 是否仍在流式输出（最后一条且该 agent 还在产出） */
      streaming: boolean
    }
  | {
      kind: "system"
      id: string
      ts: number
      text: string
      tone: "neutral" | "audit" | "stage"
    }

type DerivedRoom = {
  messages: ChatMessage[]
  verdict?: Extract<AgentEvent, { type: "verdict" }>
  /** 是否有任何评审活动（决定空态 vs 进行态） */
  hasActivity: boolean
  /** 写手初稿与最新改写稿（用于 diff） */
  firstDraft?: string
  latestContent?: string
}

const STREAM_IDLE_MS = 2_600

// ---------------------------------------------------------------------------
// 从事件流派生群聊 + 裁决 + diff 快照
// ---------------------------------------------------------------------------
function deriveRoom(
  events: AgentEvent[],
  chapter: number | undefined,
  manuscript: string | undefined,
  now: number,
): DerivedRoom {
  // 评审室关注「写手之后」的环节，但写手的草稿要作为群聊起点 + diff 基线。
  const inChapter = (eventChapter: number | undefined) =>
    !chapter || !eventChapter || eventChapter <= 0 || eventChapter === chapter

  // 1. 时间升序，稳定可读。
  const sorted = [...events]
    .filter((event) => {
      const eventChapter =
        "chapter" in event ? event.chapter : event.chapterNumber
      return inChapter(eventChapter ?? event.chapterNumber)
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))

  const messages: ChatMessage[] = []
  let verdict: Extract<AgentEvent, { type: "verdict" }> | undefined
  let firstDraft: string | undefined
  let latestContent: string | undefined

  // 把连续同 agent 的 token 聚合进一个不断增长的气泡。
  let activeBubble: Extract<ChatMessage, { kind: "agent" }> | null = null
  // 各 agent 累计的正文（用于 diff 快照）。
  const contentByAgent = new Map<string, { text: string; lastTs: number }>()
  let lastTokenTs = 0
  let lastTokenAgent: string | undefined

  const stageSeen = new Set<string>()

  for (const event of sorted) {
    const ts = Date.parse(event.ts) || now

    if (event.type === "token") {
      if (!event.text) continue
      const agentId = event.agentId
      // 续上同 agent 的气泡，否则新开一条。
      if (activeBubble && activeBubble.agentId === agentId) {
        activeBubble.text += event.text
        activeBubble.ts = ts
      } else {
        activeBubble = {
          kind: "agent",
          id: `bubble-${agentId}-${ts}-${messages.length}`,
          agentId,
          text: event.text,
          ts,
          streaming: false,
        }
        messages.push(activeBubble)
      }
      lastTokenTs = ts
      lastTokenAgent = agentId

      if (CONTENT_AGENT_IDS.has(agentId)) {
        const prev = contentByAgent.get(agentId)
        contentByAgent.set(agentId, {
          text: (prev?.text ?? "") + event.text,
          lastTs: ts,
        })
      }
      continue
    }

    // 非 token 事件会打断聚合气泡。
    activeBubble = null

    if (event.type === "verdict") {
      verdict = event
      continue
    }

    if (event.type === "audit") {
      messages.push({
        kind: "system",
        id: `audit-${ts}`,
        ts,
        tone: "audit",
        text: event.passed
          ? `审稿官 · 连续性审稿通过${
              typeof event.score === "number" ? `（${Math.round(event.score)} 分）` : ""
            }`
          : `审稿官 · 发现需返工问题${
              event.issues ? `（${event.issues} 处）` : ""
            }`,
      })
      continue
    }

    if (event.type === "stage-update") {
      const label = humanizeStage(event.stage)
      if (!label) continue
      const dedupeKey = `${label}`
      if (stageSeen.has(dedupeKey)) continue
      stageSeen.add(dedupeKey)
      messages.push({
        kind: "system",
        id: `stage-${ts}-${messages.length}`,
        ts,
        tone: "stage",
        text: label,
      })
      continue
    }
  }

  // 标记最后一条 agent 气泡的流式态（仍在产出 + 距上次 token 很近）。
  if (lastTokenAgent && now - lastTokenTs < STREAM_IDLE_MS) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (msg.kind === "agent") {
        if (msg.agentId === lastTokenAgent) msg.streaming = true
        break
      }
    }
  }

  // diff 快照：写手初稿为基线；最新「内容型 agent」产出为对照。
  const writerContent = contentByAgent.get(WRITER_ID)?.text?.trim()
  if (writerContent) firstDraft = writerContent

  let latestTs = -1
  for (const [agentId, snap] of contentByAgent) {
    if (agentId === WRITER_ID) continue
    if (snap.lastTs > latestTs && snap.text.trim()) {
      latestTs = snap.lastTs
      latestContent = snap.text.trim()
    }
  }
  // 若没有改写型 agent 的快照，退而用 manuscript（live 正文）作对照。
  if (!latestContent && manuscript && manuscript.trim()) {
    latestContent = manuscript.trim()
  }
  // 若仍缺初稿，用 manuscript 兜底当基线（这样至少能显示「暂无改写」）。
  if (!firstDraft && manuscript && manuscript.trim()) {
    firstDraft = manuscript.trim()
  }

  const hasActivity = messages.length > 0 || Boolean(verdict)

  return { messages, verdict, hasActivity, firstDraft, latestContent }
}

// 把内部 stage 字符串翻译成群聊系统行；过滤纯写手撰写阶段（那是被评审对象本身）。
function humanizeStage(stage: string): string | null {
  const cleaned = stage.replace(/llm:delta|token/gi, "").trim()
  if (!cleaned) return null
  // 这些是写作阶段本身，不当作「评审」系统行。
  if (/撰写章节草稿|创作正文|draft/i.test(cleaned) && !/审|复修|润色|裁决/.test(cleaned)) {
    return null
  }
  // 形如 "editor · 审计草稿 · ..." → 取友好名 + 动作。
  const parts = cleaned.split(" · ").map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const maybeAgentName = AGENT_NAME_BY_ID.get(parts[0]) ?? friendlyMaybe(parts[0])
  if (maybeAgentName && parts.length > 1) {
    return `${maybeAgentName} · ${parts.slice(1).join(" · ")}`
  }
  return cleaned
}

function friendlyMaybe(token: string): string | null {
  // 仅当 token 看起来像 agentId（全小写连字符）才映射，避免误伤中文短语。
  if (!/^[a-z][a-z-]*$/.test(token)) return null
  return friendlyFallbackName(token)
}

// ---------------------------------------------------------------------------
// 行级 LCS diff（无依赖）—— 返回 added / removed / context 行。
// ---------------------------------------------------------------------------
type DiffLine = { type: "add" | "del" | "ctx"; text: string }

function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  const n = a.length
  const m = b.length

  // LCS 长度表。对超长正文做规模保护，避免 O(n*m) 卡顿。
  if (n * m > 600_000) {
    // 退化为「整体替换」展示，保证不卡。
    return [
      ...a.map<DiffLine>((text) => ({ type: "del", text })),
      ...b.map<DiffLine>((text) => ({ type: "add", text })),
    ]
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  )
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] })
      i += 1
    } else {
      out.push({ type: "add", text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] })
    i += 1
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] })
    j += 1
  }
  return out
}

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

// ===========================================================================
// 组件
// ===========================================================================
export function ReviewRoom({
  bookId: _bookId,
  chapterNumber,
  activeRun,
  events,
  manuscript,
  onClose,
}: {
  bookId: string
  chapterNumber?: number
  activeRun?: boolean
  events: AgentEvent[]
  manuscript?: string
  /** 可选：点击折叠回去 */
  onClose?: () => void
}) {
  const [tab, setTab] = React.useState<"chat" | "diff">("chat")
  // 用「秒级心跳」驱动流式态判定（token 停下 ~2.6s 后收起打字指示），不引发高频重渲。
  const [nowTick, setNowTick] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!activeRun) return
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [activeRun])

  const room = React.useMemo(
    () => deriveRoom(events, chapterNumber, manuscript, nowTick),
    [events, chapterNumber, manuscript, nowTick],
  )

  // 始终对比「写手初稿」↔「终稿」：
  //  · 有独立改写稿（修稿/润色/字数治理）→ 终稿 = 最新改写稿；否则 终稿 = manuscript（live 正文）。
  //  · 初稿与终稿一致 → 显示「未改写」静态态，而非隐藏整个区块。
  //  · 只抓到一份快照（无独立初稿，仅 manuscript）→ 原样展示终稿 + 「未改写」说明，绝不编造 diff。
  const firstDraft = room.firstDraft
  const finalDraft = room.latestContent ?? room.firstDraft
  const diff = React.useMemo(() => {
    if (!firstDraft || !finalDraft) return null
    if (firstDraft === finalDraft) return null
    return lineDiff(firstDraft, finalDraft)
  }, [firstDraft, finalDraft])

  const hasDiff = Boolean(diff && diff.some((line) => line.type !== "ctx"))
  // 是否真正捕获到「独立的写手初稿」(区别于仅有 manuscript 单一快照)。
  const hasDistinctDraft = Boolean(room.firstDraft && room.latestContent)

  return (
    <aside
      data-testid="review-room"
      aria-label="群聊评审室"
      className={cn(
        "bg-sidebar border-border flex h-full min-h-0 w-full flex-col border-l",
        "motion-safe:animate-rise-in",
      )}
    >
      {/* 头部 */}
      <header className="border-border flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
        <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-lg">
          <MessagesSquare className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-foreground flex items-center gap-1.5 text-sm font-semibold">
            评审室
            <span
              className="state-dot"
              data-state={activeRun ? "streaming" : "idle"}
              aria-hidden
            />
          </div>
          <div className="text-muted-foreground truncate text-[11px]">
            {chapterNumber
              ? `第 ${chapterNumber} 章 · 编辑部群聊评审`
              : "编辑部群聊评审"}
          </div>
        </div>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="收起评审室"
            title="收起评审室"
            onClick={onClose}
          >
            <PanelRightClose className="size-4" />
          </Button>
        ) : null}
      </header>

      {/* 段控：群聊 / Diff */}
      <div className="border-border flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
        <TabButton
          active={tab === "chat"}
          icon={<MessagesSquare className="size-3.5" />}
          label="群聊"
          onClick={() => setTab("chat")}
        />
        <TabButton
          active={tab === "diff"}
          icon={<GitCompare className="size-3.5" />}
          label="改了什么"
          badge={hasDiff ? "•" : undefined}
          onClick={() => setTab("diff")}
        />
      </div>

      {/* 主体 */}
      {tab === "chat" ? (
        <ChatStream room={room} activeRun={Boolean(activeRun)} />
      ) : (
        <DiffView
          diff={diff}
          hasDiff={hasDiff}
          finalDraft={finalDraft}
          hasDistinctDraft={hasDistinctDraft}
          activeRun={Boolean(activeRun)}
        />
      )}

      {/* 裁决卡常驻底部 */}
      <VerdictCard
        verdict={room.verdict}
        activeRun={Boolean(activeRun)}
        hasActivity={room.hasActivity}
      />
    </aside>
  )
}

// ---------------------------------------------------------------------------
// 群聊流
// ---------------------------------------------------------------------------
function ChatStream({
  room,
  activeRun,
}: {
  room: DerivedRoom
  activeRun: boolean
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const followingEdgeRef = React.useRef(true)
  const lastInteractionRef = React.useRef(0)
  const rafRef = React.useRef<number | null>(null)

  const messages = room.messages
  // 用最后一条消息内容长度驱动自动滚动（流式增长时跟随）。
  const tailSignature =
    messages.length > 0
      ? `${messages.length}:${
          messages[messages.length - 1].kind === "agent"
            ? (messages[messages.length - 1] as Extract<ChatMessage, { kind: "agent" }>).text.length
            : 0
        }`
      : "0"

  const updateFollowState = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceToEdge = el.scrollHeight - el.clientHeight - el.scrollTop
    // 与 write-mode 一致的迟滞，避免内容微抖动反复切换自动跟随。
    if (distanceToEdge < 80) {
      followingEdgeRef.current = true
      return
    }
    if (distanceToEdge > 220) {
      followingEdgeRef.current = false
    }
  }, [])

  const markInteraction = React.useCallback(() => {
    lastInteractionRef.current =
      typeof performance !== "undefined" ? performance.now() : Date.now()
  }, [])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el || !followingEdgeRef.current) return
    const nowMs =
      typeof performance !== "undefined" ? performance.now() : Date.now()
    if (nowMs - lastInteractionRef.current < 1_000) return
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const node = scrollRef.current
      if (!node || !followingEdgeRef.current) return
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" })
    })
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [tailSignature])

  if (messages.length === 0) {
    return <EmptyRoom activeRun={activeRun} />
  }

  return (
    <div
      ref={scrollRef}
      data-testid="review-room-chat"
      onScroll={updateFollowState}
      onWheel={() => {
        markInteraction()
        updateFollowState()
      }}
      onPointerDown={markInteraction}
      onTouchStart={markInteraction}
      className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {messages.map((message) =>
        message.kind === "system" ? (
          <SystemLine key={message.id} message={message} />
        ) : (
          <AgentBubble key={message.id} message={message} />
        ),
      )}
    </div>
  )
}

function AgentBubble({
  message,
}: {
  message: Extract<ChatMessage, { kind: "agent" }>
}) {
  const meta = metaFor(message.agentId)
  const isWriter = message.agentId === WRITER_ID
  const agentData = AGENT_DATA_BY_ID.get(toFrontendAgentId(message.agentId))

  return (
    <div className="motion-safe:animate-rise-in flex items-start gap-2.5">
      <HoverCard openDelay={140} closeDelay={90}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-label={`${meta.name} 详情`}
            className="mt-0.5 shrink-0 cursor-help rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-offset-1"
          >
            <span
              className="flex size-7 items-center justify-center rounded-full text-[11px] font-semibold"
              style={{ backgroundColor: agentSoftBg(message.agentId, 18), color: meta.tint }}
              aria-hidden
            >
              {meta.monogram}
            </span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent side="left" align="start" className="w-64 p-3" style={{ borderColor: agentBorder(message.agentId) }}>
          <div className="flex items-center gap-2">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
              style={{ backgroundColor: agentSoftBg(message.agentId, 20), color: meta.tint }}
              aria-hidden
            >
              {meta.monogram}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold leading-tight" style={{ color: meta.tint }}>{meta.name}</div>
              {agentData ? <div className="text-muted-foreground truncate text-[11px]">{agentData.role.zh}</div> : null}
            </div>
          </div>
          {agentData?.desc ? (
            <p className="text-foreground/80 mt-2 text-[11px] leading-relaxed">{agentData.desc.zh}</p>
          ) : null}
          <div className="mt-2 flex items-center gap-1.5 text-[10px]">
            <span className={cn("inline-block size-1.5 rounded-full", message.streaming && "motion-safe:animate-pulse")} style={{ background: meta.tint }} />
            <span className="text-muted-foreground">{message.streaming ? "正在输出本章评审…" : "已发言"}</span>
          </div>
        </HoverCardContent>
      </HoverCard>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-foreground text-[12px] font-semibold">
            {meta.name}
          </span>
          {isWriter ? (
            <span className="pill" data-tone="muted">
              <ScrollText className="size-3" />
              被评审
            </span>
          ) : null}
          {message.streaming ? (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[10px]">
              <TypingDots />
              输出中
            </span>
          ) : null}
        </div>
        <div
          className={cn(
            "border-border text-foreground/90 rounded-2xl rounded-tl-sm border px-3 py-2 text-[13px] leading-relaxed",
            isWriter ? "bg-secondary/30" : "bg-card",
          )}
        >
          <span className="whitespace-pre-wrap break-words">{message.text}</span>
          {message.streaming ? <span className="stream-caret" aria-hidden /> : null}
        </div>
      </div>
    </div>
  )
}

function SystemLine({
  message,
}: {
  message: Extract<ChatMessage, { kind: "system" }>
}) {
  return (
    <div className="motion-safe:animate-rise-in flex items-center gap-2 px-1 py-0.5">
      <span
        className={cn(
          "h-px flex-1",
          message.tone === "audit" ? "bg-status-warning/30" : "bg-border",
        )}
        aria-hidden
      />
      <span
        className={cn(
          "inline-flex items-center gap-1 text-[10px] font-medium",
          message.tone === "audit"
            ? "text-status-warning"
            : "text-muted-foreground",
        )}
      >
        {message.tone === "audit" ? (
          <ShieldCheck className="size-3" />
        ) : (
          <Sparkles className="size-3" />
        )}
        {message.text}
      </span>
      <span
        className={cn(
          "h-px flex-1",
          message.tone === "audit" ? "bg-status-warning/30" : "bg-border",
        )}
        aria-hidden
      />
    </div>
  )
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="bg-current size-1 rounded-full motion-safe:animate-bounce"
          style={{ animationDelay: `${i * 140}ms`, animationDuration: "1s" }}
        />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 裁决卡
// ---------------------------------------------------------------------------
function VerdictCard({
  verdict,
  activeRun,
  hasActivity,
}: {
  verdict?: Extract<AgentEvent, { type: "verdict" }>
  activeRun: boolean
  hasActivity: boolean
}) {
  if (!verdict) {
    return (
      <div className="border-border bg-card/40 shrink-0 border-t px-3 py-3">
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <span
            className="state-dot"
            data-state={activeRun || hasActivity ? "streaming" : "idle"}
            aria-hidden
          />
          {activeRun || hasActivity ? "评审进行中 · 等待总编裁决…" : "本章尚未进入评审"}
        </div>
      </div>
    )
  }

  const passed = isPassVerdict(verdict.verdict)

  return (
    <div
      className={cn(
        "shrink-0 border-t px-3 py-3 motion-safe:animate-rise-in",
        passed
          ? "border-status-success/30 bg-status-success/[0.06]"
          : "border-status-warning/30 bg-status-warning/[0.06]",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="pill"
          data-tone={passed ? "success" : "warning"}
          data-dot
        >
          {passed ? "通过" : "返工"}
        </span>
        <span className="text-foreground text-[12px] font-semibold">
          总编裁决
        </span>
        {typeof verdict.score === "number" ? (
          <span
            className={cn(
              "ml-auto font-mono text-[13px] font-semibold tabular-nums",
              passed ? "text-status-success" : "text-status-warning",
            )}
          >
            {Math.round(verdict.score)}
            <span className="text-muted-foreground/60 text-[10px]">/100</span>
          </span>
        ) : null}
      </div>
      {verdict.rationale ? (
        <p className="text-muted-foreground mt-2 max-h-32 overflow-y-auto scroll-thin text-[12px] leading-relaxed">
          {verdict.rationale}
        </p>
      ) : null}
    </div>
  )
}

function isPassVerdict(verdict: string): boolean {
  const v = (verdict || "").toLowerCase()
  return /pass|approve|accept|通过|签发|采纳/.test(v) && !/返工|rework|reject|不通过|fail/.test(v)
}

// ---------------------------------------------------------------------------
// Diff 视图
// ---------------------------------------------------------------------------
function DiffView({
  diff,
  hasDiff,
  finalDraft,
  hasDistinctDraft,
  activeRun,
}: {
  diff: DiffLine[] | null
  hasDiff: boolean
  /** 终稿正文（无独立改写稿时即 live 正文 / manuscript） */
  finalDraft?: string
  /** 是否真正捕获到独立的写手初稿（区别于仅有单一 manuscript 快照） */
  hasDistinctDraft: boolean
  activeRun: boolean
}) {
  const labelRow = (
    <div className="text-muted-foreground mb-2 flex items-center gap-1.5 px-1 text-[10px]">
      <span className="text-foreground/80 font-medium">写手初稿</span>
      <span aria-hidden>→</span>
      <span className="text-foreground/80 font-medium">终稿</span>
    </div>
  )

  // 真有改写 —— 渲染逐行 LCS diff（保留原渲染器），两侧标注清晰。
  if (diff && hasDiff) {
    const added = diff.filter((line) => line.type === "add").length
    const removed = diff.filter((line) => line.type === "del").length
    return (
      <div
        data-testid="review-room-diff"
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        <div className="text-muted-foreground mb-2 flex items-center gap-3 px-1 text-[10px]">
          <span className="text-foreground/80 font-medium">写手初稿</span>
          <span aria-hidden>→</span>
          <span className="text-foreground/80 font-medium">终稿</span>
          <span className="text-status-success ml-auto">+{added} 行</span>
          <span className="text-status-danger">-{removed} 行</span>
        </div>
        <div className="border-border overflow-hidden rounded-lg border font-mono text-[11px] leading-relaxed">
          {diff.map((line, index) => (
            <div
              key={index}
              className={cn(
                "flex gap-2 px-2.5 py-1",
                line.type === "add" && "bg-status-success/[0.08] text-status-success",
                line.type === "del" && "bg-status-danger/[0.08] text-status-danger",
                line.type === "ctx" && "text-muted-foreground/70",
              )}
            >
              <span className="select-none opacity-50">
                {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
              </span>
              <span className="whitespace-pre-wrap break-words">{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // 还没有任何正文 —— 区分「运行中等待」与「尚未开始」。
  if (!finalDraft || !finalDraft.trim()) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <div className="text-muted-foreground/80 border-border mx-auto flex max-w-xs flex-col items-center gap-2 rounded-lg border border-dashed bg-secondary/20 px-4 py-6 text-center text-[12px]">
          <GitCompare className="text-muted-foreground/60 size-5" />
          <span className="leading-relaxed">
            {activeRun
              ? "写手正在产出本章初稿，成稿后这里会对比初稿与终稿。"
              : "尚无终稿可对比。写手成稿后这里会显示初稿与终稿的逐行对比。"}
          </span>
        </div>
      </div>
    )
  }

  // 有终稿但与初稿一致（或只抓到单一快照）—— 平静地展示「未改写」+ 终稿原文，绝不编造 diff。
  const note = hasDistinctDraft
    ? "本章未经改写（与初稿一致）"
    : "本章未经改写 · 暂未捕获到独立的改写稿，下方为当前终稿"
  return (
    <div
      data-testid="review-room-diff"
      className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3"
    >
      {labelRow}
      <div className="border-status-success/25 bg-status-success/[0.05] text-muted-foreground mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed">
        <ShieldCheck className="text-status-success/70 size-3.5 shrink-0" />
        <span>{note}</span>
      </div>
      <div className="border-border bg-card/40 overflow-hidden rounded-lg border px-3 py-2 text-[12px] leading-relaxed">
        <span className="whitespace-pre-wrap break-words text-foreground/85">
          {finalDraft}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 空态
// ---------------------------------------------------------------------------
function EmptyRoom({ activeRun }: { activeRun: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      <span className="bg-primary/10 text-primary mb-3 flex size-12 items-center justify-center rounded-full">
        <MessagesSquare className="size-6" />
      </span>
      <h3 className="text-foreground text-sm font-semibold">编辑部群聊评审室</h3>
      <p className="text-muted-foreground mt-2 max-w-xs text-[12px] leading-relaxed">
        每写完一章，审稿官、修稿师、润色师、读者评审官与总编会在这里实时过稿，
        逐条给出意见，最后由总编裁决通过或返工。
      </p>
      <div className="text-muted-foreground/70 mt-4 flex items-center gap-1.5 text-[11px]">
        <span className="state-dot" data-state={activeRun ? "streaming" : "idle"} aria-hidden />
        {activeRun ? "本章评审即将开始…" : "等待下一章写作完成"}
      </div>
    </div>
  )
}

function TabButton({
  active,
  icon,
  label,
  badge,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
      {badge ? <span className="text-primary text-[14px] leading-none">{badge}</span> : null}
    </button>
  )
}
