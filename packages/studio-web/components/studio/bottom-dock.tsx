"use client"

import * as React from "react"
import {
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Coins,
  Gauge,
  Sparkles,
  Target,
  Zap,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { useWorkspace } from "@/lib/workspace-context"
import { Heartbeat } from "@/components/studio/status-dot"
import {
  useAgents,
  useAutoRuns,
  useDockMetrics,
  useWorkflow,
} from "@/hooks/use-studio"
import { getBookReadiness } from "@/lib/studio/book-readiness"
import {
  latestActiveBookRun,
  latestInterruptedBookRun,
} from "@/lib/studio/run-state"

type Metric = {
  id: string
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  value: string
  unit?: string
  trend?: string
  trendUp?: boolean
  accent?: "primary" | "accent" | "success"
  progress?: number
}

export function BottomDock() {
  const t = useT()
  const { dockExpanded, toggleDock, bookId, currentChapter } = useStudio()
  const { books } = useWorkspace()
  const { data: dock } = useDockMetrics(bookId)
  const { data: agents } = useAgents()
  const { data: workflow } = useWorkflow(bookId)
  const { data: autoRuns } = useAutoRuns()
  const allAgents = agents ?? []
  const [autoExpand, setAutoExpand] = React.useState(false)
  const currentBook = books.find((book) => book.id === bookId)
  const readiness = getBookReadiness(currentBook)
  const resourcesBlocked = readiness.resourcesBlocked
  const continuationChapter = currentChapter + 1
  const activeRun = latestActiveBookRun(autoRuns, bookId, continuationChapter)
  const interruptedRun = latestInterruptedBookRun(
    autoRuns,
    bookId,
    continuationChapter,
  )

  const metrics: Metric[] = resourcesBlocked
    ? [
        {
          id: "blocked",
          icon: AlertCircle,
          labelKey: "common.status",
          value: readiness.label,
          accent: "accent",
        },
        {
          id: "chapter",
          icon: Target,
          labelKey: "common.chapter",
          value: String(currentBook?.currentChapter ?? 0),
          unit: `/${currentBook?.plannedChapters ?? 0}`,
        },
      ]
    : dock
      ? [
          {
            id: "speed",
            icon: Zap,
            labelKey: "dock.speed",
            value: dock.speedWordsPerMinute.toLocaleString(),
            unit: t("dock.speed.unit"),
            trend: dock.speedTrend,
            trendUp: true,
            accent: "primary",
          },
          {
            id: "quality",
            icon: Sparkles,
            labelKey: "dock.quality",
            value: String(dock.quality),
            unit: "/100",
            accent: "accent",
            progress: dock.quality,
          },
          {
            id: "consistency",
            icon: Activity,
            labelKey: "dock.consistency",
            value: `${dock.consistency}%`,
            accent: "success",
            progress: dock.consistency,
          },
          {
            id: "adopted",
            icon: Gauge,
            labelKey: "dock.adopted",
            value: dock.adopted.toLocaleString(),
            unit: t("common.words"),
          },
          {
            id: "tokens",
            icon: Coins,
            labelKey: "dock.token",
            value: dock.tokens.toLocaleString(),
          },
          {
            id: "remaining",
            icon: Target,
            labelKey: "dock.remaining",
            value: dock.remaining.toLocaleString(),
            unit: `${dock.remainingPct}%`,
            progress: dock.remainingPct,
          },
          {
            id: "eta",
            icon: Clock,
            labelKey: "dock.eta",
            value: String(dock.etaMinutes),
            unit: t("common.minutes"),
          },
        ]
      : []

  const expanded = dockExpanded || autoExpand
  // 默认极简：只在展开(hover/手动)或有后台任务时才铺满 7 个指标，
  // 否则只留一条很细的状态条，让默认视图安静（贴参考图）。
  // 仅"正在运行"或展开时铺满指标；中断待续是休眠态(状态条已说明)，
  // 不该一直把噪音钉在底部 —— 默认保持安静。
  const showMetrics = expanded || Boolean(activeRun) || resourcesBlocked
  const activeAgentIds = activeRun
    ? new Set(Object.values(workflow?.activeAgentsByStage ?? {}).flat())
    : new Set<string>()
  if (activeRun?.currentAgentId) activeAgentIds.add(activeRun.currentAgentId)
  const runningAgents = resourcesBlocked
    ? 0
    : activeAgentIds.size

  return (
    <div
      data-testid="bottom-dock"
      className="border-border bg-sidebar fixed inset-x-0 bottom-0 z-40 border-t"
      onMouseEnter={() => setAutoExpand(true)}
      onMouseLeave={() => setAutoExpand(false)}
    >
      <div
        className={cn(
          "flex items-stretch gap-1 overflow-hidden px-3 transition-all duration-300",
          expanded ? "py-3" : showMetrics ? "py-2" : "py-1",
        )}
      >
        {/* Heartbeat strip */}
        <div className="hidden shrink-0 items-center gap-2 pr-3 lg:flex">
          <div className="bg-secondary/60 flex h-9 items-center gap-2 rounded-full px-3">
            <span
              className={cn(
                "size-1.5 rounded-full",
                resourcesBlocked
                  ? "bg-status-warning"
                  : interruptedRun
                    ? "bg-status-warning"
                    : "bg-status-running",
              )}
            />
            <span className="text-[11px] font-medium">
              {resourcesBlocked
                ? readiness.label
                : activeRun
                  ? `${runningAgents} active / ${allAgents.length}`
                  : interruptedRun
                    ? "任务中断待续"
                    : `${runningAgents} active / ${allAgents.length}`}
            </span>
            {resourcesBlocked ? (
              <AlertCircle className="text-status-warning size-3" />
            ) : interruptedRun && !activeRun ? (
              <AlertCircle className="text-status-warning size-3" />
            ) : (
              <Heartbeat active intensity={0.8} />
            )}
          </div>
        </div>

        {/* Scrollable metric strip — 默认隐藏，仅展开/运行时显示 */}
        {showMetrics ? (
          <div className="scroll-thin flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
            {metrics.map((m) => (
              <MetricCard key={m.id} m={m} expanded={expanded} />
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground/50 flex min-w-0 flex-1 items-center pl-1 text-[11px]">
            指标已收起 · 悬停展开
          </div>
        )}

        {/* Toggle */}
        <button
          onClick={toggleDock}
          className="hover:bg-secondary text-muted-foreground hover:text-foreground ml-1 flex shrink-0 items-center gap-1 rounded-md px-2 text-[11px] transition-colors"
          aria-label={dockExpanded ? t("dock.collapse") : t("dock.expand")}
        >
          {dockExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronUp className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  )
}

function MetricCard({ m, expanded }: { m: Metric; expanded: boolean }) {
  const t = useT()
  const Icon = m.icon
  const accentClass =
    m.accent === "primary"
      ? "text-primary"
      : m.accent === "accent"
        ? "text-accent"
        : m.accent === "success"
          ? "text-status-success"
          : "text-muted-foreground"

  return (
    <div
      className={cn(
        "border-border bg-card/40 hover:bg-card flex shrink-0 flex-col justify-center rounded-lg border px-3 transition-all",
        expanded ? "min-w-[140px] py-1" : "min-w-[120px] py-0.5",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3.5", accentClass)} />
        <span className="text-muted-foreground truncate text-[10px]">
          {t(m.labelKey)}
        </span>
        {m.trend && (
          <span
            className={cn(
              "ml-auto font-mono text-[9px]",
              m.trendUp ? "text-status-success" : "text-muted-foreground",
            )}
          >
            {m.trend}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="font-mono text-sm font-semibold tabular-nums">
          {m.value}
        </span>
        {m.unit && (
          <span className="text-muted-foreground/80 text-[10px]">
            {m.unit}
          </span>
        )}
      </div>
      {expanded && typeof m.progress === "number" && (
        <div className="bg-secondary/40 mt-1 h-0.5 overflow-hidden rounded-full">
          <div
            className="bg-primary/60 h-full rounded-full"
            style={{
              width: `${Math.min(100, Math.max(0, m.progress))}%`,
            }}
          />
        </div>
      )}
    </div>
  )
}
