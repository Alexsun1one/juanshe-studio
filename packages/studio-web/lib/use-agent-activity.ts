"use client"

/**
 * 订阅本作品的实时 agent 事件,汇成一条"编辑部流水线"活动流:
 * 当前哪个 agent 在做什么 + 最近若干步(规划/草稿/审校/裁决/字数治理…)。
 * 给编辑器的「实时流水线」面板用,让用户看到编辑部真的在动,而不是只显示"AI 写作中"。
 * 复用 agent-event-stream 的共享 SSE(与 useLiveRun / useRunState 共用一条连接)。
 */
import * as React from "react"
import { subscribeSharedAgentEvents } from "@/lib/agent-event-stream"
import type { AgentEvent } from "@/lib/api/client"
import { agentDisplayName, describeStage } from "@/lib/labels"

const LIVE_WINDOW_MS = 20_000
const FRESH_MS = 30_000
const MAX_EVENTS = 16

export type ActivityEvent = {
  id: string
  agentId: string
  agentName: string
  text: string
  kind: string
  ts: number
}

export type AgentStatus = "running" | "done" | "idle"

export type AgentActivity = {
  /** 最近窗口内有活动 = 流水线在跑 */
  live: boolean
  currentAgentId?: string
  currentText?: string
  events: ActivityEvent[]
  /** 本轮流水线每个 agent 的状态机:已出场且非当前=已完成,当前=运行中,没出场=待命 */
  statusByAgent: Record<string, AgentStatus>
  /** 本轮已出场 agent 的先后顺序(规划→写手→审稿→…) */
  seenOrder: string[]
}

function freshTs(ts: string | undefined): number | null {
  const t = ts ? Date.parse(ts) : NaN
  const ms = Number.isFinite(t) ? t : Date.now()
  return Date.now() - ms > FRESH_MS ? null : ms
}

export function useAgentActivity(bookId: string | undefined): AgentActivity {
  const [snap, setSnap] = React.useState<AgentActivity>({ live: false, events: [], statusByAgent: {}, seenOrder: [] })
  const ref = React.useRef({
    events: [] as ActivityEvent[],
    lastTs: 0,
    currentAgentId: undefined as string | undefined,
    currentText: undefined as string | undefined,
    seenOrder: [] as string[],
    seq: 0,
  })

  const recompute = React.useCallback(() => {
    const st = ref.current
    const live = st.lastTs > 0 && Date.now() - st.lastTs < LIVE_WINDOW_MS
    const statusByAgent: Record<string, AgentStatus> = {}
    for (const a of st.seenOrder) statusByAgent[a] = "done"
    if (st.currentAgentId) statusByAgent[st.currentAgentId] = "running"
    setSnap({
      live,
      currentAgentId: live ? st.currentAgentId : undefined,
      currentText: live ? st.currentText : undefined,
      events: st.events.slice(0, MAX_EVENTS),
      statusByAgent,
      seenOrder: [...st.seenOrder],
    })
  }, [])

  React.useEffect(() => {
    const st = ref.current
    st.events = []
    st.lastTs = 0
    st.currentAgentId = undefined
    st.currentText = undefined
    st.seenOrder = []
    setSnap({ live: false, events: [], statusByAgent: {}, seenOrder: [] })
  }, [bookId])

  React.useEffect(() => {
    if (!bookId) return
    const unsub = subscribeSharedAgentEvents(bookId, (e: AgentEvent) => {
      const ts = freshTs(e.ts)
      if (ts == null) return
      const st = ref.current
      const ev = e as Record<string, unknown>
      // 角色署名三层兜底:事件自带 agentId → 从事件语义推断(write→写手等)→ 沿用上一个,最后才 system。
      // 避免接力日志全是"智能体"看不出谁在干。
      const rawAgentId = typeof ev.agentId === "string" && ev.agentId ? ev.agentId : ""
      // 距上次活动超过窗口 = 新一轮流水线开始,重置进度(否则上一章的"已完成"会串到这一章)
      const gap = st.lastTs > 0 && Date.now() - st.lastTs > LIVE_WINDOW_MS
      let text = ""
      let inferredAgentId = ""
      let logIt = false
      let setsCurrent = false
      if (e.type === "token") {
        st.currentText = "正在逐字生成正文"
        inferredAgentId = "writer"
        setsCurrent = true
      } else if (e.type === "stage-update") {
        // 把 write:start / quality-batch:needs-repair 这类键翻成"谁在做什么";未知一律抑制,绝不泄漏 raw key
        const desc = describeStage(String(ev.stage ?? ""))
        text = desc.text
        inferredAgentId = desc.agentId ?? ""
        if (text) st.currentText = text
        setsCurrent = true
        logIt = Boolean(text)
      } else if (e.type === "audit") {
        text = ev.passed ? "连续性审校通过" : "连续性审校发现问题"
        inferredAgentId = "auditor"
        setsCurrent = true
        logIt = true
      } else if (e.type === "verdict") {
        const sc = typeof ev.score === "number" ? ` · ${ev.score} 分` : ""
        text = `总编${ev.verdict === "pass" ? "签发本章" : "判定返工"}${sc}`
        inferredAgentId = "editor-in-chief"
        setsCurrent = true
        logIt = true
      } else if (e.type === "log") {
        if (ev.level === "error" || ev.level === "warn") {
          text = String(ev.message ?? "")
          logIt = Boolean(text)
        }
      }
      const agentId = rawAgentId || inferredAgentId || st.currentAgentId || "system"
      // 推进状态机:出场即记入顺序,当前 agent 切换 → 上一个自动变"已完成"
      if (setsCurrent && agentId !== "system") {
        if (gap) st.seenOrder = []
        st.currentAgentId = agentId
        if (!st.seenOrder.includes(agentId)) st.seenOrder.push(agentId)
        st.lastTs = ts
      } else if (setsCurrent) {
        st.lastTs = ts
      }
      // 去重:与上一条同角色、同动作就不重复刷(后端常连发同一状态)
      const prev = st.events[0]
      const dupe = Boolean(prev && prev.agentId === agentId && prev.text === text)
      if (logIt && text && !dupe) {
        st.seq += 1
        st.events = [
          { id: `${ts}-${st.seq}`, agentId, agentName: agentDisplayName(agentId), text, kind: e.type, ts },
          ...st.events,
        ].slice(0, MAX_EVENTS)
      }
      recompute()
    })
    return unsub
  }, [bookId, recompute])

  React.useEffect(() => {
    const t = setInterval(recompute, 1500)
    return () => clearInterval(t)
  }, [recompute])

  return snap
}
