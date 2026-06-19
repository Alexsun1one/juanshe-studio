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
// live-draft 种子的可信窗口:超过这个时长没新 token 的快照视为死流,不种入
// (防"上一轮悄悄挂掉的旧草稿"垫在新一轮 token 前面,拼出错文)。
const SEED_MAX_AGE_MS = 10 * 60 * 1000

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
  /** SSE 连接已断、浏览器在自动重连 —— 状态 chip 据此显示「重连中」,别让用户以为写丢了 */
  reconnecting: boolean
  /** 用户点了停止:立刻把 active 压成 false,别等 12s 流式窗口自然过期(否则"停止"了 UI 还转十几秒) */
  forceIdle: () => void
}

// 内部累计快照不带 forceIdle(那是 hook 出口才合成的方法),其余字段同 LiveRun。
type LiveRunSnapshot = Omit<LiveRun, "forceIdle">
const EMPTY: LiveRunSnapshot = { active: false, text: "", charCount: 0, completedTick: 0, reconnecting: false }

/** 后端 GET /books/:id/live-draft 的快照(当前在写章节的已累计正文) */
type LiveDraftSeed = {
  chapter?: number | null
  agentId?: string | null
  text?: string
  updatedAt?: string | null
  completed?: boolean
}

// 同一本书的种子请求在多个画布(工作台/编辑器/剧场)间共享,避免一次挂载打三发
const seedInflight = new Map<string, Promise<LiveDraftSeed | null>>()
function fetchLiveDraftSeed(bookId: string): Promise<LiveDraftSeed | null> {
  const pending = seedInflight.get(bookId)
  if (pending) return pending
  const p = fetch(`/api/v1/books/${encodeURIComponent(bookId)}/live-draft`, { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<LiveDraftSeed>) : null))
    .catch(() => null)
    .finally(() => { seedInflight.delete(bookId) })
  seedInflight.set(bookId, p)
  return p
}

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
  const [snapshot, setSnapshot] = React.useState<LiveRunSnapshot>(EMPTY)
  const ref = React.useRef({
    chapter: undefined as number | undefined,
    byAgent: new Map<string, string>(),
    lastContentAgent: undefined as string | undefined,
    lastTs: 0,
    stageText: undefined as string | undefined,
    completedTick: 0,
    wasActive: false,
    reconnecting: false,
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
      reconnecting: st.reconnecting,
    })
  }, [])

  // 把后端 live-draft 快照种进累计:订阅建立时(刷新后半章不再"消失")与重连恢复时
  // (补上断线期间漏掉的 token)各拉一次。种子与其后到达的 token 用结尾重叠去重拼接。
  const applySeed = React.useCallback(async (alive: () => boolean) => {
    if (!bookId) return
    // 先记下请求发起时各 agent 已累计的长度 —— 请求往返期间新到的 token 是"种子之外的尾巴"
    const marks = new Map(ref.current.byAgent)
    const seed = await fetchLiveDraftSeed(bookId)
    if (!alive() || !seed || !seed.text || seed.completed) return
    const fid = toFrontendAgentId(String(seed.agentId ?? ""))
    if (!CONTENT_AGENTS.has(fid)) return
    const ts = seed.updatedAt ? Date.parse(seed.updatedAt) : NaN
    if (!Number.isFinite(ts) || Date.now() - ts > SEED_MAX_AGE_MS) return
    const st = ref.current
    const ch = typeof seed.chapter === "number" && seed.chapter > 0 ? seed.chapter : st.chapter
    const current = st.byAgent.get(fid) ?? ""
    const base = marks.get(fid) ?? ""
    // 请求期间新到的 token(它们可能已含在种子末尾,也可能比种子新)
    const tail = current.startsWith(base) ? current.slice(base.length) : ""
    let merged = seed.text
    let overlap = Math.min(tail.length, merged.length)
    while (overlap > 0 && !merged.endsWith(tail.slice(0, overlap))) overlap--
    merged += tail.slice(overlap)
    if (merged.length <= current.length) return // 本地已累计得更全,种子不回退现状
    if (ch !== st.chapter) {
      st.chapter = ch
      st.byAgent = new Map()
    }
    st.byAgent.set(fid, merged)
    st.lastContentAgent = fid
    st.lastTs = Math.max(st.lastTs, ts)
    recompute()
  }, [bookId, recompute])

  // 切作品:清空累计(保留 completedTick 让收尾刷新仍生效)
  React.useEffect(() => {
    const st = ref.current
    st.chapter = undefined
    st.byAgent = new Map()
    st.lastContentAgent = undefined
    st.lastTs = 0
    st.stageText = undefined
    st.wasActive = false
    st.reconnecting = false
    setSnapshot((s) => ({ ...EMPTY, completedTick: s.completedTick }))
  }, [bookId])

  React.useEffect(() => {
    if (!bookId) return
    let alive = true
    const isAlive = () => alive
    const unsub = subscribeSharedAgentEvents(
      bookId,
      (e: AgentEvent) => {
        const st = ref.current
        if (st.reconnecting) {
          // 任何事件(含 ping)到达 = 连接已恢复;补拉一次快照,接上断线期间漏掉的正文
          st.reconnecting = false
          void applySeed(isAlive)
          recompute()
        }
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
      },
      () => {
        // EventSource 断开(浏览器会自动重连):亮出「重连中」,别让用户以为写丢了
        const st = ref.current
        if (!st.reconnecting) {
          st.reconnecting = true
          recompute()
        }
      },
    )
    // 订阅建立后种入已累计正文:刷新页面回来,打字机立即是完整半章而不是句中尾巴
    void applySeed(isAlive)
    return () => {
      alive = false
      unsub()
    }
  }, [bookId, recompute, applySeed])

  // 定时回算,让 active 在窗口过期后自然熄灭
  React.useEffect(() => {
    const t = setInterval(recompute, 1500)
    return () => clearInterval(t)
  }, [recompute])

  // 用户点停止后立刻熄灭 active:清掉 lastTs(不等 12s 流式窗口自然过期),避免"已停止"了 UI 还转十几秒。
  const forceIdle = React.useCallback(() => {
    const st = ref.current
    st.lastTs = 0
    st.wasActive = false
    recompute()
  }, [recompute])

  return React.useMemo(() => ({ ...snapshot, forceIdle }), [snapshot, forceIdle])
}
