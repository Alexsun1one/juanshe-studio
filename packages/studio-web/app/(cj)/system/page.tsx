"use client"

import * as React from "react"
import Link from "next/link"
import useSWR from "swr"
import {
  Activity,
  ArrowRight,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Cpu,
  FileCheck2,
  FolderCheck,
  Gauge,
  Heart,
  Library,
  Radio,
  ScrollText,
  Sparkles,
  Stethoscope,
  X,
} from "lucide-react"
import { fetchAgents, fetchAgentEvents, fetchSystemHealth } from "@/lib/api/client"
import type { AgentEvent } from "@/lib/api/client"
import { useWorkspace } from "@/lib/workspace-context"
import { useAgentActivity } from "@/lib/use-agent-activity"
import { agentColor, isAgentId } from "@/lib/agent-identity"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"
import { stageLabel, describeStage } from "@/lib/labels"
import { AgentPixel } from "@/components/design/agent-pixel"
import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import "./system.css"

// 与 dashboard 共用:按编辑部部门重新分组 17 位智能体
const AGENT_DEPTS: ReadonlyArray<{ id: string; label: string; hint: string; agents: ReadonlyArray<string> }> = [
  { id: "strategy", label: "战略选题", hint: "趋势 / 框架 / 立基复审",      agents: ["market-radar", "architect", "setup-auditor"] },
  { id: "writing",  label: "写作",     hint: "规划 → 写手 → 章节分析",     agents: ["planner", "writer", "chapter-analyst"] },
  { id: "review",   label: "评审",     hint: "审稿 + 读者视角 + 总分报告", agents: ["editor", "reader-critic", "quality-report"] },
  { id: "revision", label: "修改打磨", hint: "修稿 / 字数治理 / 润色",     agents: ["reviser", "word-steward", "polisher"] },
  { id: "ops",      label: "运营质保", hint: "真相校验 / 风格 / 提示词治理", agents: ["state-verifier", "style-fingerprint", "prompt-steward"] },
  { id: "eic",      label: "总编室",   hint: "签发与方向把控",              agents: ["managing-editor", "editor-in-chief"] },
]

const SOURCE_NAMES: Record<string, string> = {
  studio: "工作台", system: "系统", model: "模型",
  radar: "市场雷达", "market-radar": "市场雷达",
  architect: "架构师",
  "foundation-reviewer": "建书复审官", "setup-auditor": "建书复审官",
  planner: "规划师", writer: "写手",
  auditor: "审稿官", editor: "审稿官",
  reviser: "修稿师", polisher: "润色师",
  "length-normalizer": "字数治理官", "word-steward": "字数治理官",
  "chapter-analyzer": "章节分析官", "chapter-analyst": "章节分析官",
  "state-validator": "状态校验员", "state-verifier": "状态校验员",
  "style-governor": "风格指纹官", "style-fingerprint": "风格指纹官",
  "reader-critic": "读者评审官",
  "quality-reporter": "质量报告官", "quality-report": "质量报告官",
  "prompt-governor": "提示词治理官", "prompt-steward": "提示词治理官",
  "managing-editor": "执行主编", "editor-in-chief": "总编",
}
const sourceName = (id?: string) => (id ? (SOURCE_NAMES[id] ?? SOURCE_NAMES[toFrontendAgentId(id)] ?? id) : "系统")

// 时间窗:最近 30 分钟,用于横向 swim lane
const TIMELINE_WINDOW_MS = 30 * 60 * 1000

// 17 位 lane 智能体的 fid 集合(用于判断某事件是否落到某条泳道)
const LANE_FIDS = new Set<string>(AGENT_DEPTS.flatMap((d) => d.agents))

/**
 * 关键修复:后端大量工作流事件(write:start / batch:chapter:start / editor-in-chief:verdict /
 * chapter:quality-repair / quality-gate:* …)没带 roleId/agentId,normalizeAgentEvent 把它们
 * 归到 "system",于是接力时间线几乎全空。这里按事件名把"交接里程碑"归到对应智能体,
 * 让泳道真正显示谁在什么时候接的棒。llm:progress 是进度噪声(非交接),返回 null 跳过。
 */
function inferFidFromRawEvent(rawEvent?: string): string | null {
  if (!rawEvent) return null
  const n = rawEvent.toLowerCase()
  if (n === "llm:progress" || n === "llm:delta" || n === "ping") return null // 进度/心跳噪声,非交接
  if (n.startsWith("editor-in-chief") || n.includes("verdict")) return "editor-in-chief"
  if (n.startsWith("managing")) return "managing-editor"
  if (n.startsWith("audit") || n.includes("continuity")) return "editor"
  if (n.includes("quality-repair") || n.startsWith("revis")) return "reviser"
  if (n.includes("quality-gate") || n.includes("quality-report") || n.includes("quality")) return "quality-report"
  if (n.includes("reader")) return "reader-critic"
  if (n.includes("polish")) return "polisher"
  if (n.includes("length") || n.includes("word")) return "word-steward"
  if (n.includes("style")) return "style-fingerprint"
  if (n.includes("state") || n.includes("validat")) return "state-verifier"
  if (n.includes("prompt")) return "prompt-steward"
  if (n.includes("chapter-analy") || n.includes("analyz")) return "chapter-analyst"
  if (n.startsWith("batch:start") || n.startsWith("plan")) return "planner"
  if (n.startsWith("write") || n.startsWith("batch:chapter") || n.startsWith("batch")) return "writer"
  if (n.includes("radar") || n.includes("market")) return "market-radar"
  if (n.includes("foundation") || n.includes("architect")) return "architect"
  if (n.includes("setup")) return "setup-auditor"
  return null // workflow:* / watchdog:* 等系统级事件不落泳道
}

/** 解析事件归属的泳道 fid:优先显式 agentId,否则按事件名推断里程碑归属。 */
function laneAgentForEvent(e: AgentEvent): string | null {
  const explicit = "agentId" in e && typeof e.agentId === "string" ? toFrontendAgentId(e.agentId) : null
  if (explicit && LANE_FIDS.has(explicit)) return explicit
  const inferred = inferFidFromRawEvent(e.rawEvent)
  return inferred && LANE_FIDS.has(inferred) ? inferred : null
}

function eventColor(e: AgentEvent): string {
  if (e.type === "log" && e.level === "error") return "var(--err-500)"
  if (e.type === "log" && e.level === "warn") return "var(--warn-500)"
  if (e.type === "verdict") return "var(--ok-500)"
  if (e.type === "token") return "var(--brand-500)"
  if (e.type === "agent-status") return "var(--brand-400)"
  return "var(--ink-400)"
}

function eventLine(e: AgentEvent): string {
  if (e.type === "log") return `${sourceName(e.agentId)}:${e.message}`
  if (e.type === "stage-update") return `阶段切换 → ${describeStage(e.stage).text || "进行中"} ${Math.round(e.progress * 100)}%`
  if (e.type === "token") return `${sourceName(e.agentId)} 正在写第 ${e.chapter} 章`
  if (e.type === "agent-status") return `${sourceName(e.agentId)} → ${e.status}`
  if (e.type === "metric") return `${e.key}: ${e.value}`
  if (e.type === "verdict") return `${sourceName(e.agentId)} 签发第 ${e.chapter} 章`
  return e.type
}

function logTone(e: AgentEvent): "info" | "ok" | "warn" | "err" {
  if (e.type === "log") return e.level === "error" ? "err" : e.level === "warn" ? "warn" : "info"
  if (e.type === "verdict") return "ok"
  if (e.type === "metric") return "ok"
  return "info"
}

function probeLabel(status?: string, connected?: boolean) {
  if (status === "fresh") return "实时成功"
  if (status === "cached") return "缓存可信"
  if (status === "stale-timeout") return "超时沿用"
  if (status === "failed") return "探针失败"
  if (status === "error") return "探针异常"
  if (connected === true) return "连通"
  if (connected === false) return "未连通"
  return "待检测"
}
function probeTone(status?: string, connected?: boolean): "ok" | "warn" | "err" {
  if (status === "fresh" || status === "cached") return "ok"
  if (status === "stale-timeout") return "warn"
  if (status === "failed" || status === "error" || connected === false) return "err"
  return "warn"
}
function formatAge(ms?: number) {
  if (!ms || ms <= 0) return ""
  if (ms < 1000) return `${Math.round(ms)}ms 前`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s 前`
  return `${Math.round(s / 60)}min 前`
}
function checkText(value?: boolean, ok = "存在", no = "缺失") {
  if (value === undefined) return "未知"
  return value ? ok : no
}

// 证据行的状态 → 设计系统 pill 的 data-state(语义色只走状态,不裸文字)
function evidenceState(ok: boolean | undefined, tone?: "ok" | "warn" | "err"): string {
  if (tone === "ok") return "success"
  if (tone === "warn") return "warn"
  if (tone === "err") return "error"
  if (ok === undefined) return "pending"
  return ok ? "success" : "error"
}

export default function SystemPage() {
  const { bookId } = useWorkspace()
  const { data: agents } = useSWR("agents", fetchAgents, { refreshInterval: 8000 })
  const { data: health } = useSWR("sys-health", fetchSystemHealth, { refreshInterval: 8000 })
  const { data: events } = useSWR(
    bookId ? ["agent-events", bookId] : null,
    () => fetchAgentEvents(bookId),
    { refreshInterval: 5000 },
  )
  const activity = useAgentActivity(bookId)
  const [selFid, setSelFid] = React.useState<string | null>(null)

  // 17 agents 按部门归并
  const list = agents ?? []
  // 首帧 roster 还没回来:部门卡走骨架,而不是闪一片空白(微状态三件套之"加载")
  const agentsLoading = agents === undefined
  const byFid = React.useMemo(() => {
    const m = new Map<string, typeof list[number]>()
    for (const a of list) m.set(toFrontendAgentId(a.id), a)
    return m
  }, [list])
  const sel = selFid ? byFid.get(selFid) : undefined

  const running = list.filter((a) => a.status === "running").length

  // swim lane:按 fid 收 events,只保留窗口内 + 限制每个 lane 最多 60 个 tick
  const now = Date.now()
  // 最新"交接里程碑"时间:写作停了之后把窗口锚定到"最后一轮接力"而非 wall-clock now,
  // 否则空闲时窗口滑过历史事件 → 时间线一直空白(用户看到的就是这个)。
  // 注意:必须用"能落到泳道的事件"(里程碑)算锚点,不能用任何事件——否则最近的 llm:progress
  // 噪声会把窗口钉在 now,反而把更早的真实里程碑甩出窗外。
  const newestTs = React.useMemo(() => {
    let mx = 0
    for (const e of events ?? []) {
      if (!laneAgentForEvent(e)) continue
      const t = Date.parse(e.ts)
      if (Number.isFinite(t) && t > mx) mx = t
    }
    return mx
  }, [events])
  const isLiveWindow = !newestTs || now - newestTs <= TIMELINE_WINDOW_MS
  const windowEnd = isLiveWindow ? now : newestTs
  const windowStart = windowEnd - TIMELINE_WINDOW_MS
  type LaneEvent = { ts: number; left: number; ev: AgentEvent }
  const laneByFid = React.useMemo(() => {
    const m = new Map<string, LaneEvent[]>()
    for (const e of events ?? []) {
      // 归属泳道:显式 agentId,或按事件名推断"交接里程碑"归属(见 laneAgentForEvent)。
      // 这样 write/verdict/audit/repair/quality 等没带 roleId 的工作流事件也能落到正确角色。
      const fid = laneAgentForEvent(e)
      if (!fid) continue
      const t = Date.parse(e.ts)
      if (!Number.isFinite(t) || t < windowStart) continue
      const left = ((t - windowStart) / TIMELINE_WINDOW_MS) * 100
      const arr = m.get(fid) ?? []
      arr.push({ ts: t, left, ev: e })
      m.set(fid, arr)
    }
    for (const [k, arr] of m) {
      arr.sort((a, b) => a.ts - b.ts)
      if (arr.length > 60) m.set(k, arr.slice(-60))
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, windowStart])

  const totalEventsInWindow = Array.from(laneByFid.values()).reduce((s, a) => s + a.length, 0)

  // 健康
  const healthTone: "ok" | "warn" | "err" = health?.status === "healthy" ? "ok" : health?.status === "down" ? "err" : "warn"
  const healthLabel = health?.status === "healthy" ? "健康" : health?.status === "down" ? "宕机" : "降级"
  const healthState = healthTone === "ok" ? "success" : healthTone === "err" ? "error" : "warn"
  const llmTone = probeTone(health?.llmProbeStatus, health?.llmConnected)
  const llmText = probeLabel(health?.llmProbeStatus, health?.llmConnected)
  const llmAge = formatAge(health?.llmProbeAgeMs)
  const checkRate = health?.routeSuccessRate24h ?? 0
  const checkTone: "ok" | "warn" | "err" = checkRate >= 0.8 ? "ok" : checkRate >= 0.5 ? "warn" : "err"
  const checkPct = Math.round(checkRate * 100)
  // 平均延迟/集群负载:SystemHealth 已有字段,工作台标杆密度——内联呈现,不编造
  const avgLatency = health?.avgLatencySeconds
  const clusterLoad = typeof health?.load === "number" ? Math.round(health.load * 100) : null

  // 日志栏:最近 40
  const recent = [...(events ?? [])].slice(-40).reverse()

  // 选中角色在泳道中的最近一次活动时间(用于详情条,不编造)
  const selLastTs = selFid ? (laneByFid.get(selFid)?.at(-1)?.ts ?? null) : null

  return (
    <div className="cj-screen cj-system">
      {/* ── 顶部工作条:像素 +「系统·编辑部」+ 一行密集 KPI + 集群状态 pill ── */}
      <header className="cj-workhead sys-head">
        <div className="sys-headline">
          <PixelBadge kind="system" size={44} className="sys-hero-pixel" ariaLabel="系统 · 编辑部" />
          <div className="sys-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">系统 · 编辑部</h1>
              <span className="pill" data-state={running > 0 ? "running" : "pending"}>
                <span className="dot" />
                {running > 0 ? "正在生产" : "空闲待命"}
              </span>
            </div>
            <div className="page-sub">
              17 位 AI 角色按编辑部接力生产 —— 集群健康、模型探针、Doctor 通过率与实时交棒一屏可见。
            </div>
          </div>
          <span className={`pill sys-health-pill ${healthTone}`} data-state={healthState}>
            <Heart size={13} aria-hidden />
            集群 {healthLabel}
          </span>
        </div>
        <div className="sys-kpis" role="group" aria-label="集群指标">
          <KpiChip
            label="运行槽"
            value={running}
            unit={`/ ${list.length}`}
            tone="brand"
            hint="正在执行任务的智能体 / 编制总数"
          />
          <KpiChip
            label="模型在线"
            value={health?.onlineModels ?? 0}
            unit={`/ ${health?.totalModels ?? 0}`}
            tone={(health?.onlineModels ?? 0) > 0 ? "ok" : "neutral"}
            hint="可调度的模型实例 / 已配置总数"
          />
          <KpiChip
            label="Doctor 通过率"
            value={checkPct}
            unit="% · 24h"
            tone={checkTone}
            hint="近 24 小时路由健康检查通过率"
          />
          <KpiChip
            label="作品库"
            value={health?.bookCount ?? 0}
            unit="本"
            tone="brand"
            hint="本地工作区作品总数"
          />
          <KpiChip
            label="平均延迟"
            value={typeof avgLatency === "number" && Number.isFinite(avgLatency) ? avgLatency.toFixed(1) : "—"}
            unit="s"
            tone="neutral"
            hint="近期 LLM 调用平均响应时间"
          />
        </div>
      </header>

      {/* ── 主体:编辑部 + 接力时间线(主区,pane 内滚) | 证据 + 事件流(Inspector)── */}
      <div className="cj-screen-body sys-body">
        <div className="cj-mainpane sys-mainpane">
          <div className="cj-pane-scroll sys-pane-scroll">
            {/* 编辑部 · 按部门:像素角色卡(AgentCard 同款)分组,接力依据可点 */}
            <section className="sys-section">
              <h3 className="sys-sh">
                <Sparkles size={14} aria-hidden className="sys-sh-ic" />
                编辑部 · 按部门视图
                <span className="sys-sh-c">{list.length || 17} 位</span>
                <Link href="/agents" className="sys-sh-act">
                  原始 roster <ChevronRight size={13} aria-hidden />
                </Link>
              </h3>
              <div className="sys-depts">
                {agentsLoading && AGENT_DEPTS.map((dept) => (
                  <div key={`sk-${dept.id}`} className="sys-dept">
                    <div className="sys-dept-head">
                      <span className="sys-dept-label">{dept.label}</span>
                      <span className="sys-dept-count">{dept.agents.length}</span>
                    </div>
                    <div className="sys-dept-row">
                      {dept.agents.map((fid) => (
                        <div key={fid} className="skel sys-agent-skel" />
                      ))}
                    </div>
                  </div>
                ))}
                {!agentsLoading && AGENT_DEPTS.map((dept) => {
                  const members = dept.agents
                    .map((fid) => ({ fid, agent: byFid.get(fid) }))
                    .filter((m): m is { fid: string; agent: NonNullable<typeof m.agent> } => Boolean(m.agent))
                  if (!members.length) return null
                  const runningCount = members.filter((m) => activity.statusByAgent[m.fid] === "running").length
                  return (
                    <div key={dept.id} className={`sys-dept${runningCount ? " has-running" : ""}`}>
                      <div className="sys-dept-head">
                        {runningCount > 0 && <Activity size={12} aria-hidden className="sys-dept-live" />}
                        <span className="sys-dept-label">{dept.label}</span>
                        <span className="sys-dept-count">{members.length}</span>
                        <span className="sys-dept-hint">{dept.hint}</span>
                      </div>
                      <div className="sys-dept-row">
                        {members.map(({ fid, agent: a }) => {
                          const liveStatus = activity.statusByAgent[fid]
                          // 联合类型联起来类型推断会窄到 only "running" | "done" | "idle",
                          // 但 a.status 还可能是 "error"。手动 cast 成 string 再分支,避免 TS 误报。
                          const status: string = liveStatus ?? a.status
                          const stateForPill =
                            status === "running" ? "running"
                              : status === "done" ? "success"
                              : status === "error" ? "error" : "pending"
                          const isSel = selFid === fid
                          return (
                            <button
                              key={a.id}
                              type="button"
                              className={`sys-agent-card${isSel ? " sel" : ""}${status === "running" ? " running" : ""}`}
                              onClick={() => setSelFid(isSel ? null : fid)}
                              title={`${a.name.zh} · ${a.role.zh} · 点击查看活动`}
                            >
                              <AgentPixel id={a.id} size={34} ariaLabel={a.name.zh} className="sys-agent-pixel" />
                              <span className="sys-agent-body">
                                <span className="sys-agent-name">{a.name.zh}</span>
                                <span className="sys-agent-role">{a.role.zh}</span>
                              </span>
                              <span className="pill sys-agent-state" data-state={stateForPill}>
                                <span className="dot" />
                                {status === "running" ? "运行" : status === "done" ? "完成" : status === "error" ? "异常" : "待命"}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            {/* 接力时间线 — 横向 swim lane */}
            <section className="sys-section">
              <h3 className="sys-sh">
                <Radio size={14} aria-hidden className="sys-sh-ic" />
                接力时间线
                <span className="sys-sh-c">
                  {isLiveWindow ? "最近 30 分钟" : "最近一轮"} · {totalEventsInWindow} 个事件
                  {!isLiveWindow && newestTs ? ` · 截至 ${new Date(newestTs).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}` : ""}
                </span>
                {selFid && (
                  <button type="button" className="sys-sh-act" onClick={() => setSelFid(null)}>
                    <X size={12} aria-hidden />
                    清除筛选({sourceName(selFid)})
                  </button>
                )}
              </h3>
              <div className="swim">
                <div className="swim-axis">
                  <span>30 min 前</span><span>20</span><span>10</span><span>{isLiveWindow ? "现在" : "本轮末"}</span>
                </div>
                {agentsLoading && Array.from({ length: 6 }).map((_, i) => (
                  <div key={`swk-${i}`} className="swim-lane swim-lane-skel">
                    <div className="lane-label">
                      <span className="skel lane-skel-pixel" />
                      <span className="skel lane-skel-name" />
                    </div>
                    <div className="skel lane-skel-track" />
                  </div>
                ))}
                {!agentsLoading && AGENT_DEPTS.flatMap((dept) =>
                  dept.agents.map((fid) => {
                    const a = byFid.get(fid)
                    if (!a) return null
                    const events = laneByFid.get(fid) ?? []
                    const isSel = selFid === fid
                    const isFaded = selFid !== null && !isSel
                    const liveStatus = activity.statusByAgent[fid]
                    return (
                      <div
                        key={fid}
                        className={`swim-lane${isSel ? " sel" : ""}${isFaded ? " faded" : ""}${liveStatus === "running" ? " running" : ""}`}
                        onClick={() => setSelFid(isSel ? null : fid)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter") setSelFid(isSel ? null : fid) }}
                      >
                        <div className="lane-label">
                          <AgentPixel id={a.id} size={20} ariaLabel={a.name.zh} />
                          <span className="lane-name">{a.name.zh}</span>
                        </div>
                        <div className="lane-track">
                          <div className="lane-track-grid" aria-hidden />
                          {events.length === 0 ? (
                            <span className="lane-empty">尚无事件</span>
                          ) : (
                            events.map((le, i) => (
                              <span
                                key={i}
                                className={`lane-tick t-${le.ev.type}`}
                                style={{ left: `${le.left}%`, background: eventColor(le.ev) }}
                                title={`${new Date(le.ts).toLocaleTimeString("zh-CN", { hour12: false })} · ${eventLine(le.ev)}`}
                              />
                            ))
                          )}
                        </div>
                      </div>
                    )
                  }),
                )}
              </div>
            </section>

            {/* 选中角色:浮层式详情(非弹窗,贴在时间线下方) */}
            {sel && (
              <section className="agent-inline">
                <AgentPixel id={sel.id} size={40} ariaLabel={sel.name.zh} className="ai-pixel" />
                <div className="ai-text">
                  <div className="ai-name">
                    {sel.name.zh}
                    <span className="muted">· {sel.role.zh}</span>
                    <span className="pill" data-state={sel.status === "running" ? "running" : sel.status === "done" ? "success" : sel.status === "error" ? "error" : "pending"}>
                      <span className="dot" />
                      {sel.status === "running" ? "运行中" : sel.status === "done" ? "完成" : sel.status === "error" ? "异常" : "待命"}
                    </span>
                  </div>
                  <div className="ai-desc">{sel.desc?.zh ?? "暂无描述"}</div>
                </div>
                <div className="ai-meta">
                  <span><b>阶段</b>{stageLabel(sel.stage)}</span>
                  <span><b>负载</b>{Math.round((sel.load ?? 0) * 100)}%</span>
                  <span><b>模型</b><code>{sel.modelHint}</code></span>
                  {selLastTs != null && (
                    <span><b>最近活动</b>{new Date(selLastTs).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}</span>
                  )}
                </div>
                <Link href={`/agent/${encodeURIComponent(sel.id)}`} className="ai-cta">
                  完整档案 <ArrowRight size={14} aria-hidden />
                </Link>
                <button type="button" className="ai-close" onClick={() => setSelFid(null)} aria-label="关闭">
                  <X size={15} aria-hidden />
                </button>
              </section>
            )}
          </div>
        </div>

        {/* ── Inspector:系统证据 + Doctor 计量 + 实时事件流(只在 pane 内滚)── */}
        <aside className="cj-inspector sys-inspector">
          <div className="cj-pane-scroll sys-insp-scroll">
            {/* 系统证据:体检面板 —— 每项一个 lucide 图标 + 状态 pill,不裸文字 */}
            <section className="card sys-evid-card">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-title">
                  <Stethoscope size={15} aria-hidden className="sys-card-ic" />
                  系统证据
                </div>
                <span className={`pill ${healthTone}`} data-state={healthState}>
                  <span className="dot" />
                  {healthLabel}
                </span>
              </div>
              <div className="sys-doctor">
                <Meter label="Doctor 通过率 · 24h" value={checkPct} threshold={50} tone="ok" />
                <StatLine
                  className="sys-doctor-stat"
                  items={[
                    { n: health?.onlineModels ?? 0, label: "模型在线", tone: "ok" },
                    { n: `${running}/${list.length || 17}`, label: "运行槽", tone: "brand" },
                    { n: clusterLoad != null ? `${clusterLoad}%` : "—", label: "集群负载", tone: "neutral" },
                  ]}
                />
              </div>
              <div className="sys-evid">
                <EvidRow icon={<FileCheck2 size={14} aria-hidden />} label="项目配置" state={evidenceState(health?.projectEnv)} text={checkText(health?.projectEnv)} />
                <EvidRow icon={<FolderCheck size={14} aria-hidden />} label="作品目录" state={evidenceState(health?.booksDir)} text={checkText(health?.booksDir)} />
                <EvidRow icon={<Cpu size={14} aria-hidden />} label="LLM 连通" state={evidenceState(health?.llmConnected)} text={checkText(health?.llmConnected, "可用", "不可用")} />
                <EvidRow icon={<Radio size={14} aria-hidden />} label="LLM 探针" state={evidenceState(undefined, llmTone)} text={llmText} sub={llmAge || undefined} />
                <EvidRow icon={<FileCheck2 size={14} aria-hidden />} label="全局配置" state={evidenceState(health?.globalEnv ?? true)} text={checkText(health?.globalEnv, "存在", "未配置")} />
                <EvidRow icon={<Gauge size={14} aria-hidden />} label="Doctor 通过率" state={evidenceState(checkRate >= 0.5, checkTone)} text={`${checkPct}%`} />
                <EvidRow icon={<Heart size={14} aria-hidden />} label="集群状态" state={healthState} text={healthLabel} />
              </div>
            </section>

            {/* 实时事件流:折叠卡 + 卡内滚,信息多不撑破一屏 */}
            <FoldCard
              title="实时事件流"
              icon={<ScrollText size={15} aria-hidden />}
              count={recent.length}
              defaultOpen
              scrollable
              maxHeight={320}
            >
              <div className="sys-log">
                {recent.length ? recent.map((e, i) => {
                  const tone = logTone(e)
                  const t = (() => { try { return new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false }) } catch { return "--:--:--" } })()
                  const aid = "agentId" in e ? e.agentId : undefined
                  const fid = aid ? toFrontendAgentId(aid) : ""
                  return (
                    <div className="ln" key={i}>
                      <span className="t">{t}</span>
                      <span className={`lv ${tone}`}>{tone.toUpperCase()}</span>
                      {isAgentId(fid) && <span className="dot" aria-hidden style={{ background: agentColor(fid) }} />}
                      <span className="msg">{eventLine(e)}</span>
                    </div>
                  )
                }) : (
                  <div className="sys-empty">
                    {bookId ? (
                      <>
                        <CircleSlash size={18} aria-hidden />
                        <span>暂无事件 · 开始写作就会实时刷新</span>
                      </>
                    ) : (
                      <>
                        <Library size={18} aria-hidden />
                        <span>选择作品后显示事件流</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </FoldCard>
          </div>
        </aside>
      </div>
    </div>
  )
}

// ── 证据行:图标 + 标签 + 状态 pill(语义色只走状态) ──────────────────────────
function EvidRow({
  icon,
  label,
  state,
  text,
  sub,
}: {
  icon: React.ReactNode
  label: string
  state: string
  text: string
  sub?: string
}) {
  return (
    <div className="sys-ev-row" data-state={state}>
      <span className="sys-ev-ic">{icon}</span>
      <span className="sys-ev-label">{label}</span>
      {sub && <span className="sys-ev-sub">{sub}</span>}
      <span className="pill" data-state={state}>
        {state === "success" ? <CircleCheck size={11} aria-hidden /> : <span className="dot" />}
        {text}
      </span>
    </div>
  )
}
