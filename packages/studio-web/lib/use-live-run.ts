"use client"

/**
 * 订阅当前作品的实时 agent 事件,累计「内容型 agent」(写手/修稿/润色/字数)
 * 正在生成章节的流式正文,供编辑器做「打字机」实时渲染并自动跟随到该章。
 * 复用 agent-event-stream 的共享 SSE(多处订阅只开一条连接)。
 */
import * as React from "react"
import { subscribeSharedAgentEvents } from "@/lib/agent-event-stream"
import type { AgentEvent } from "@/lib/api/client"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"
import { agentDisplayName, describeStage } from "@/lib/labels"

const CONTENT_AGENTS = new Set(["writer", "reviser", "polisher", "word-steward"])
// token 间偶有空档(切 agent / 模型思考),窗口给宽一点避免横幅闪烁。
const LIVE_WINDOW_MS = 12_000
// SSE 连接会回放最近事件;只认事件自身时间戳足够新的,避免历史/快照误点亮。
const FRESH_MS = 25_000

function freshTs(ts: string | undefined): number | null {
  const t = ts ? Date.parse(ts) : NaN
  const ms = Number.isFinite(t) ? t : Date.now()
  return Date.now() - ms > FRESH_MS ? null : ms
}

export type LiveRun = {
  /** 最近窗口内有内容型 token 在流 = 正在逐字生成 */
  active: boolean
  /** 正在生成的章节号(可能与当前查看章不同,编辑器据此自动跟随) */
  chapter?: number
  agentId?: string
  agentName?: string
  /** 最近阶段标签(规划/生成/审校…) */
  stageText?: string
  /** 当前内容型 agent 的累计正文(打字机内容) */
  text: string
  charCount: number
  /** active 由 true→false 的瞬间自增,调用方据此在收尾时刷新已保存正文 */
  completedTick: number
}

const EMPTY: LiveRun = { active: false, text: "", charCount: 0, completedTick: 0 }

// 写手原始流常带规划脚手架(=== PRE_WRITE_CHECK === 表格 + === CHAPTER_CONTENT === 标记)。
// 实时打字视图只显示正文,绝不把内部脚手架/原始标记露给用户。
function stripWriterScaffold(raw: string): string {
  if (!raw) return ""
  let body = raw
  if (raw.includes("CHAPTER_CONTENT") || raw.includes("PRE_WRITE_CHECK")) {
    const m = raw.indexOf("CHAPTER_CONTENT")
    if (m < 0) return "" // 还在产出脚手架,正文尚未开始
    body = raw.slice(m + "CHAPTER_CONTENT".length).replace(/^[=\s]*/, "")
  }
  // 剥离正文「之后」的内部状态块(=== UPDATED_STATE === / UPDATED_HOOKS 等),
  // 绝不把内部追踪原文露给用户(修:写作区出现 ===UPDATED_STATE===##角色名… 的泄漏)
  const cut = body.search(/=*\s*(UPDATED_STATE|UPDATED_HOOKS|UPDATED_TRACKING|STATE_DELTA)\b/)
  if (cut >= 0) body = body.slice(0, cut)
  return body.replace(/[=\s]+$/, "")
}

export function useLiveRun(bookId: string | undefined): LiveRun {
  const [snapshot, setSnapshot] = React.useState<LiveRun>(EMPTY)
  const ref = React.useRef({
    chapter: undefined as number | undefined,
    byAgent: new Map<string, string>(),
    lastContentAgent: undefined as string | undefined,
    lastTs: 0,
    stageText: undefined as string | undefined,
    completedTick: 0,
    wasActive: false,
  })

  const recompute = React.useCallback(() => {
    const st = ref.current
    const active = st.lastTs > 0 && Date.now() - st.lastTs < LIVE_WINDOW_MS
    if (st.wasActive && !active) st.completedTick += 1
    st.wasActive = active
    const raw = (st.lastContentAgent ? st.byAgent.get(st.lastContentAgent) : "") ?? ""
    const text = stripWriterScaffold(raw)
    setSnapshot({
      active,
      chapter: st.chapter,
      agentId: st.lastContentAgent,
      agentName: st.lastContentAgent ? agentDisplayName(st.lastContentAgent) : undefined,
      stageText: st.stageText,
      text,
      charCount: text.replace(/\s/g, "").length,
      completedTick: st.completedTick,
    })
  }, [])

  // 切作品:清空累计(保留 completedTick 让收尾刷新仍生效)
  React.useEffect(() => {
    const st = ref.current
    st.chapter = undefined
    st.byAgent = new Map()
    st.lastContentAgent = undefined
    st.lastTs = 0
    st.stageText = undefined
    st.wasActive = false
    setSnapshot((s) => ({ ...EMPTY, completedTick: s.completedTick }))
  }, [bookId])

  React.useEffect(() => {
    if (!bookId) return
    const unsub = subscribeSharedAgentEvents(bookId, (e: AgentEvent) => {
      const st = ref.current
      if (e.type === "token") {
        const ts = freshTs(e.ts)
        if (ts == null || !e.text) return
        const id = toFrontendAgentId(e.agentId)
        if (!CONTENT_AGENTS.has(id)) return
        const ch = typeof e.chapter === "number" && e.chapter > 0 ? e.chapter : st.chapter
        if (ch !== st.chapter) {
          // 换到新章节的流:重置累计
          st.chapter = ch
          st.byAgent = new Map()
          st.lastContentAgent = undefined
        }
        st.byAgent.set(id, (st.byAgent.get(id) ?? "") + e.text)
        st.lastContentAgent = id
        st.lastTs = ts
        recompute()
      } else if (e.type === "stage-update") {
        // 阶段事件只更新标签,不点亮 active(后端会在连接时回放当前阶段快照)
        const ts = freshTs(e.ts)
        if (ts == null) return
        // 翻成人话;未知/噪声(空文本)就保留上一个有意义的阶段标签,不被 write:start 这种键覆盖
        const d = describeStage(e.stage)
        if (d.text) st.stageText = d.text
        recompute()
      }
    })
    return unsub
  }, [bookId, recompute])

  // 定时回算,让 active 在窗口过期后自然熄灭
  React.useEffect(() => {
    const t = setInterval(recompute, 1500)
    return () => clearInterval(t)
  }, [recompute])

  return snapshot
}
