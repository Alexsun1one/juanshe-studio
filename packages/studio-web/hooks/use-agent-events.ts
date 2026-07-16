// ============================================================================
// useAgentEvents — 订阅 SSE 实时事件流
// - 一个 bookId 一条 EventSource（StrictMode 下 cleanup 会重连一次，正常）
// - 暴露最近事件、log 流、token 流、metric 流；带按 type 过滤
// ============================================================================

"use client"

import { useEffect, useRef, useState } from "react"
import type { AgentEvent } from "@/lib/api/client"
import {
  getAgentEventHistory,
  subscribeSharedAgentEvents,
} from "@/lib/agent-event-stream"

type State = {
  connected: boolean
  events: AgentEvent[]
  /** 正文类 token 拼接（写作、改写、复修的最新增量） */
  liveText: string
  /** 最近一次正文类 token 的服务端时间戳 */
  lastTokenAt?: number
  /** 最近一次 stage 进度 */
  stageProgress?: { stage: string; progress: number }
  /** 最近一次 metric */
  lastMetrics: Record<string, number | string>
}

const MAX_EVENTS = 200
const MAX_LIVE_TEXT = 24_000
const LIVE_EVENT_BATCH_MS = 120

export function useAgentEvents(bookId: string, enabled = true) {
  const [state, setState] = useState<State>({
    connected: false,
    events: [],
    liveText: "",
    lastTokenAt: undefined,
    stageProgress: undefined,
    lastMetrics: {},
  })
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    if (!enabled || !bookId) return
    let alive = true
    let pendingEvents: AgentEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flushPendingEvents = () => {
      flushTimer = null
      if (!alive || pendingEvents.length === 0) return

      const batch = pendingEvents
      pendingEvents = []
      setState((prev) => applyEvents({ ...prev, connected: true }, batch))
    }

    const queueLiveEvent = (event: AgentEvent) => {
      pendingEvents.push(event)
      if (flushTimer) return
      flushTimer = setTimeout(flushPendingEvents, LIVE_EVENT_BATCH_MS)
    }

    setState({
      connected: false,
      events: [],
      liveText: "",
      lastTokenAt: undefined,
      stageProgress: undefined,
      lastMetrics: {},
    })

    void getAgentEventHistory(bookId)
      .then((events) => {
        if (!alive) return
        setState((prev) => applyEvents(prev, events))
      })
      .catch(() => {
        // SSE 会继续尝试连接；历史快照失败不打断实时订阅。
      })

    const unsub = subscribeSharedAgentEvents(
      bookId,
      (e) => {
        if (!alive) return
        queueLiveEvent(e)
      },
      () => {
        if (!alive) return
        setState((prev) => ({ ...prev, connected: false }))
      },
    )
    setState((prev) => ({ ...prev, connected: true }))
    return () => {
      alive = false
      if (flushTimer) clearTimeout(flushTimer)
      unsub()
    }
  }, [bookId, enabled])

  return state
}

function applyEvents(prev: State, incoming: AgentEvent[]): State {
  if (incoming.length === 0) return prev

  const seen = new Set(prev.events.map(eventKey))
  const merged = [...prev.events]
  let liveText = prev.liveText
  let lastTokenAt = prev.lastTokenAt
  let stageProgress = prev.stageProgress
  let lastMetrics = prev.lastMetrics

  incoming.forEach((event) => {
    const key = eventKey(event)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(event)
    }

    if (event.type === "token" && isManuscriptToken(event)) {
      liveText = (liveText + event.text).slice(-MAX_LIVE_TEXT)
      const tokenAt = Date.parse(event.ts)
      lastTokenAt = Number.isFinite(tokenAt)
        ? Math.max(lastTokenAt ?? 0, tokenAt)
        : Date.now()
    }
    if (event.type === "stage-update") {
      stageProgress = { stage: event.stage, progress: event.progress }
    }
    if (event.type === "metric") {
      lastMetrics = { ...lastMetrics, [event.key]: event.value }
    }
  })

  // 预解析时间戳再排(降序):比较器里 Date.parse 会把 O(e) 次解析放大成 O(e·log e) 次
  const timed = merged.map((event) => ({ event, at: Date.parse(event.ts) }))
  timed.sort((a, b) => b.at - a.at)
  return {
    ...prev,
    events: timed.slice(0, MAX_EVENTS).map((x) => x.event),
    liveText,
    lastTokenAt,
    stageProgress,
    lastMetrics,
  }
}

function isManuscriptToken(event: Extract<AgentEvent, { type: "token" }>) {
  if (!event.text) return false
  const agent = event.agentId.toLowerCase()
  const stage = event.stage ?? ""

  if (
    [
      "writer",
      "reviser",
      "editor",
      "polisher",
      "word-steward",
      "length-normalizer",
    ].includes(agent)
  ) {
    return true
  }

  return /撰写章节草稿|创作正文|正文|重写|改写|复修|修稿|润色|扩写|llm:delta|draft|rewrite|repair|revise|polish/i.test(stage)
}

function eventKey(event: AgentEvent) {
  const detail =
    event.type === "stage-update"
      ? event.stage
      : event.type === "log"
        ? event.message
        : event.type === "token"
          ? event.text
          : event.type === "metric"
            ? `${event.key}:${event.value}`
            : JSON.stringify(event)
  return `${event.type}:${event.ts}:${detail}`
}
