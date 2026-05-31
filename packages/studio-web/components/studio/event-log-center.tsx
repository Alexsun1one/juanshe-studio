"use client"

// ============================================================================
// EventLogCenter — 全局「运行日志 / 错误中心」
// - 订阅当前书的 SSE 事件流(共享通道,不新开连接)
// - 任何 error 级事件(*:error / log level=error)→ 立刻弹 toast,用户一定看得到
// - 一个浮动按钮(带未读错误红点)→ 滑出抽屉,按级别列出所有日志/错误,可筛选/清空
// 设计目标:错误绝不再"静默吞进后台 stdout / run.error",而是浮到前台。
// ============================================================================

import * as React from "react"
import { toast } from "sonner"
import { useWorkspace } from "@/lib/workspace-context"
import { useAgentEvents } from "@/hooks/use-agent-events"
import type { AgentEvent } from "@/lib/api/client"
import { agentColor, isAgentId } from "@/lib/agent-identity"

type LogLevel = "info" | "warn" | "error"

interface LogRow {
  key: string
  level: LogLevel
  source: string
  /** 原始来源 id(用于上色:是规范 agent 就用其专属色,否则中性色) */
  sourceId: string
  message: string
  ts: number
}

// 日志来源 → 友好中文名(绝不把内部 id 直接丢给用户)。
const SOURCE_NAMES: Record<string, string> = {
  studio: "工作台",
  system: "系统",
  writer: "写手",
  editor: "审稿官",
  auditor: "审稿官",
  reviser: "修稿师",
  polisher: "润色师",
  "editor-in-chief": "总编",
  planner: "规划师",
  architect: "架构师",
  "chapter-analyst": "章节分析官",
  "chapter-analyzer": "章节分析官",
  "state-verifier": "状态校验员",
  "state-validator": "状态校验员",
  "word-steward": "字数治理官",
  "length-normalizer": "字数治理官",
  "reader-critic": "读者评审官",
  "quality-report": "质量报告官",
  "quality-reporter": "质量报告官",
  "market-radar": "市场雷达",
  radar: "市场雷达",
  model: "模型",
}

function sourceName(id: string | undefined): string {
  if (!id) return "系统"
  return SOURCE_NAMES[id] ?? id
}

const LEVEL_META: Record<LogLevel, { label: string; color: string; bg: string }> = {
  error: { label: "错误", color: "var(--destructive)", bg: "color-mix(in oklab, var(--destructive) 14%, transparent)" },
  warn: { label: "警告", color: "var(--chart-4)", bg: "color-mix(in oklab, var(--chart-4) 16%, transparent)" },
  info: { label: "信息", color: "var(--muted-foreground)", bg: "color-mix(in oklab, var(--muted-foreground) 12%, transparent)" },
}

const MAX_ROWS = 300

function toLogRow(event: Extract<AgentEvent, { type: "log" }>, index: number): LogRow {
  const tsNum = typeof event.ts === "string" ? Date.parse(event.ts) : Number(event.ts)
  return {
    key: `${event.ts ?? ""}-${index}-${event.message?.slice(0, 24) ?? ""}`,
    level: event.level,
    source: sourceName(event.agentId),
    sourceId: event.agentId ?? "",
    message: event.message || "(无内容)",
    ts: Number.isFinite(tsNum) ? tsNum : Date.now(),
  }
}

function formatClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false })
  } catch {
    return ""
  }
}

export function EventLogCenter() {
  const { bookId } = useWorkspace()
  const { events } = useAgentEvents(bookId, Boolean(bookId))

  const [open, setOpen] = React.useState(false)
  const [onlyErrors, setOnlyErrors] = React.useState(false)
  const [unreadErrors, setUnreadErrors] = React.useState(0)
  const [cleared, setCleared] = React.useState(0) // 清空时记一个游标,隐藏旧行但不动共享 events

  // 只对「挂载之后新到达」的事件弹 toast,避免历史错误一次性炸屏。
  const toastedRef = React.useRef<Set<string>>(new Set())
  const primedRef = React.useRef(false)

  const logRows = React.useMemo<LogRow[]>(() => {
    const rows: LogRow[] = []
    events.forEach((event, index) => {
      if (event.type !== "log") return
      rows.push(toLogRow(event, index))
    })
    return rows.slice(-MAX_ROWS)
  }, [events])

  // 新错误 → toast + 未读计数。首帧只做"预热"(记下已有的),不弹。
  React.useEffect(() => {
    if (!primedRef.current) {
      logRows.forEach((row) => toastedRef.current.add(row.key))
      primedRef.current = true
      return
    }
    let newErrors = 0
    for (const row of logRows) {
      if (toastedRef.current.has(row.key)) continue
      toastedRef.current.add(row.key)
      if (row.level === "error") {
        newErrors += 1
        toast.error(`${row.source}：${row.message.slice(0, 160)}`, {
          description: row.message.length > 160 ? row.message.slice(160, 400) : undefined,
          duration: 8000,
        })
      }
    }
    if (newErrors > 0 && !open) setUnreadErrors((n) => n + newErrors)
  }, [logRows, open])

  // 切书清空预热状态,避免把上一本书的日志当新错误弹。
  React.useEffect(() => {
    toastedRef.current = new Set()
    primedRef.current = false
    setUnreadErrors(0)
    setCleared(0)
  }, [bookId])

  const visibleRows = React.useMemo(() => {
    const base = logRows.slice(cleared)
    const filtered = onlyErrors ? base.filter((r) => r.level === "error") : base
    return filtered.slice().reverse() // 最新在上
  }, [logRows, onlyErrors, cleared])

  const errorCount = React.useMemo(() => logRows.slice(cleared).filter((r) => r.level === "error").length, [logRows, cleared])

  return (
    <>
      {/* 浮动入口:右下角,带未读错误红点 */}
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
          setUnreadErrors(0)
        }}
        aria-label="运行日志与错误"
        className="fixed bottom-4 right-4 z-40 flex h-10 items-center gap-2 rounded-full border px-3 text-xs shadow-lg backdrop-blur transition-colors motion-safe:transition-all hover:brightness-105"
        style={{
          background: "color-mix(in oklab, var(--card) 92%, transparent)",
          borderColor: unreadErrors > 0 ? "var(--destructive)" : "var(--border)",
          color: "var(--foreground)",
        }}
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: errorCount > 0 ? "var(--destructive)" : "var(--chart-2)" }}
        />
        运行日志
        {unreadErrors > 0 && (
          <span
            className="ml-0.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold"
            style={{ background: "var(--destructive)", color: "var(--destructive-foreground, #fff)" }}
          >
            {unreadErrors > 99 ? "99+" : unreadErrors}
          </span>
        )}
      </button>

      {/* 抽屉 */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 motion-safe:animate-in motion-safe:fade-in"
            style={{ background: "color-mix(in oklab, var(--background) 55%, transparent)" }}
            onClick={() => setOpen(false)}
          />
          <aside
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[26rem] flex-col border-l shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right"
            style={{ background: "var(--card)", borderColor: "var(--border)" }}
            aria-label="运行日志面板"
          >
            <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold" style={{ color: "var(--foreground)" }}>运行日志</span>
                {errorCount > 0 && (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: LEVEL_META.error.bg, color: LEVEL_META.error.color }}>
                    {errorCount} 个错误
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setOnlyErrors((v) => !v)}
                  className="rounded-md border px-2 py-1 text-[11px] transition-colors"
                  style={{
                    borderColor: onlyErrors ? "var(--destructive)" : "var(--border)",
                    color: onlyErrors ? "var(--destructive)" : "var(--muted-foreground)",
                    background: onlyErrors ? LEVEL_META.error.bg : "transparent",
                  }}
                >
                  仅错误
                </button>
                <button
                  type="button"
                  onClick={() => setCleared(logRows.length)}
                  className="rounded-md border px-2 py-1 text-[11px] transition-colors hover:brightness-105"
                  style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
                >
                  清空
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="关闭"
                  className="rounded-md px-2 py-1 text-[13px] transition-colors hover:brightness-110"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  ✕
                </button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {visibleRows.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <div className="text-2xl opacity-50">🪶</div>
                  <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                    {onlyErrors ? "暂无错误。写作/评审/修复出错时会实时出现在这里。" : "暂无日志。智能体运行时的每条状态与错误都会实时显示在这里。"}
                  </p>
                </div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {visibleRows.map((row) => {
                    const meta = LEVEL_META[row.level]
                    return (
                      <li
                        key={row.key}
                        className="rounded-lg border px-2.5 py-1.5"
                        style={{
                          borderColor: row.level === "error" ? "color-mix(in oklab, var(--destructive) 35%, var(--border))" : "var(--border)",
                          background: row.level === "error" ? meta.bg : "transparent",
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold leading-none" style={{ background: meta.bg, color: meta.color }}>
                            {meta.label}
                          </span>
                          {/* 来源色点:规范 agent 用其全站专属色(与评审室/工作流同色),非 agent 来源用中性色 */}
                          <span
                            className="inline-block size-1.5 shrink-0 rounded-full"
                            style={{ background: isAgentId(row.sourceId) ? agentColor(row.sourceId) : "var(--muted-foreground)" }}
                            aria-hidden
                          />
                          <span className="text-[11px] font-medium" style={{ color: "var(--foreground)" }}>{row.source}</span>
                          <span className="ml-auto text-[10px] tabular-nums" style={{ color: "var(--muted-foreground)" }}>{formatClock(row.ts)}</span>
                        </div>
                        <p
                          className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed"
                          style={{ color: row.level === "error" ? "var(--foreground)" : "var(--muted-foreground)" }}
                        >
                          {row.message}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <footer className="border-t px-4 py-2 text-[10px]" style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}>
              实时来自当前书的智能体事件流 · 错误会自动弹出提醒
            </footer>
          </aside>
        </>
      )}
    </>
  )
}
