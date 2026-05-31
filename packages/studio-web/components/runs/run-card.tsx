"use client"

import * as React from "react"
import Link from "next/link"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Pause,
  Play,
  RefreshCw,
  XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useT, useLocale } from "@/lib/i18n"
import { useWorkspace } from "@/lib/workspace-context"
import {
  pauseAutoRun as stopAutoRun,
  resumeAutoRun,
  cancelAutoRun,
} from "@/lib/api/client"
import { mutate } from "swr"
import { cn } from "@/lib/utils"
import {
  autoRunStatusLabelKey,
  isLiveAutoRunStatus,
} from "@/lib/studio/run-status"
import type { AutoRun, AutoRunEvent, AutoRunStatus } from "@/lib/api/types"

const AGENT_CHAIN: { id: string; zh: string; en: string }[] = [
  { id: "market-radar", zh: "市场", en: "Market" },
  { id: "architect", zh: "架构", en: "Arch" },
  { id: "setup-auditor", zh: "复审", en: "Setup" },
  { id: "planner", zh: "规划", en: "Plan" },
  { id: "writer", zh: "写手", en: "Writer" },
  { id: "editor", zh: "审稿", en: "Edit" },
  { id: "reviser", zh: "修稿", en: "Revise" },
  { id: "word-steward", zh: "字数", en: "Words" },
  { id: "polisher", zh: "润色", en: "Polisher" },
  { id: "chapter-analyst", zh: "分析", en: "Analyze" },
  { id: "state-verifier", zh: "状态", en: "State" },
  { id: "style-fingerprint", zh: "文风", en: "Style" },
  { id: "reader-critic", zh: "读者", en: "Reader" },
  { id: "quality-report", zh: "质量", en: "Quality" },
  { id: "prompt-steward", zh: "治理", en: "Prompt" },
]

type RunActionKind = "stop" | "resume" | "cancel"

export function RunCard({ run, dim }: { run: AutoRun; dim?: boolean }) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { books, setBookId } = useWorkspace()
  const bookTitle = run.bookTitle[lang]
  const canOpenBook = books.some((book) => book.id === run.bookId)
  const [confirmAction, setConfirmAction] =
    React.useState<RunActionKind | null>(null)
  const [pendingAction, setPendingAction] =
    React.useState<RunActionKind | null>(null)

  const totalChapters = Math.max(1, run.toChapter - run.fromChapter + 1)
  const targetWordsPerChapter = Math.max(1, run.targetWordsPerChapter)
  const hasGeneratedOutput =
    run.currentWords > 0 ||
    run.totalAdoptedWords > 0 ||
    (run.currentQuality !== undefined && run.currentQuality > 0)
  const displayStatus: AutoRunStatus =
    run.status === "completed" && !hasGeneratedOutput ? "failed" : run.status
  const statusMessage =
    run.failureReason || run.error || run.currentStage || run.suggestion
  const completedChapters =
    displayStatus === "completed"
      ? totalChapters
      : Math.max(0, Math.min(totalChapters, run.currentChapter - run.fromChapter))
  const overallPct =
    Math.min(
      100,
      ((completedChapters + run.currentWords / targetWordsPerChapter) /
        totalChapters) *
        100,
    ) || 0
  const currentChapterPct = Math.min(
    100,
    (run.currentWords / targetWordsPerChapter) * 100,
  )

  const accent = statusAccent(displayStatus)
  const isActive = isLiveAutoRunStatus(displayStatus)
  const isRepairing =
    displayStatus === "rewriting" ||
    displayStatus === "repairing" ||
    displayStatus === "quality-batch-repairing" ||
    displayStatus === "needs-repair"
  const canStop = isLiveAutoRunStatus(run.status)
  const canResume = run.status === "paused" || run.status === "needs-repair"
  const canCancel = run.status === "paused" || run.status === "needs-repair"
  const actionInFlight = pendingAction !== null

  async function handleConfirmedRunAction() {
    if (!confirmAction || actionInFlight) return
    const action = confirmAction
    setPendingAction(action)
    try {
      if (action === "stop") {
        await stopAutoRun(run.id)
      } else if (action === "resume") {
        await resumeAutoRun(run.id)
      } else {
        await cancelAutoRun(run.id)
      }
      await mutate("auto-runs")
      setConfirmAction(null)
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <article
      className={cn(
        "border-border bg-card relative flex flex-col overflow-hidden rounded-xl border backdrop-blur-md transition-opacity",
        dim && "opacity-65",
      )}
    >
      {/* running 态保持可见，但不持续重绘，避免管理页叠加多个任务时掉帧。 */}
      {isActive && (
        <div
          className="from-primary via-accent to-primary absolute inset-x-0 top-0 h-px bg-gradient-to-r"
          aria-hidden
        />
      )}

      {/* Header */}
      <header className="border-border flex items-start gap-3 border-b p-4">
        <span
          className="mt-1 size-2 shrink-0 rounded-full"
          style={{
            backgroundColor: accent.dot,
            boxShadow: isActive ? `0 0 0 4px ${accent.halo}` : undefined,
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="text-foreground/90 truncate text-[14px] font-semibold tracking-tight">
              {bookTitle}
            </h2>
          </div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
            <span className="font-mono">
              {t("workspace.chapter")} {run.fromChapter}–{run.toChapter}
            </span>
            <span className="opacity-50">·</span>
            <span className="font-mono">
              {run.targetWordsPerChapter.toLocaleString()} {t("common.words")}/
              {t("common.chapter")}
            </span>
            <span className="opacity-50">·</span>
            <span className="font-mono">
              {t("runs.targetQuality")} ≥ {run.targetQuality}
            </span>
          </div>
        </div>
        <StatusPill status={displayStatus} />
      </header>

      {/* Overall progress + per-chapter */}
      <div className="px-4 pb-3 pt-4">
        <div className="text-muted-foreground mb-1.5 flex items-center justify-between text-[10px]">
          <span className="uppercase tracking-wider">
            {completedChapters} / {totalChapters} {t("common.chapter")}
          </span>
          <span className="font-mono">{overallPct.toFixed(1)}%</span>
        </div>
        <div className="bg-secondary relative h-2 overflow-hidden rounded-full">
          <div
            className="from-primary via-primary to-accent h-full rounded-full bg-gradient-to-r transition-all duration-700"
            style={{ width: `${overallPct}%` }}
          />
          {/* 章节刻度 */}
          {Array.from({ length: totalChapters - 1 }).map((_, i) => (
            <span
              key={i}
              className="bg-card absolute top-0 h-full w-px"
              style={{ left: `${((i + 1) / totalChapters) * 100}%` }}
            />
          ))}
        </div>

        {/* 当前章节的进度 */}
        <div className="mt-3 flex items-center justify-between text-[10px]">
          <span className="text-foreground/80 font-medium">
            {t("workspace.chapter")} {run.currentChapter}{" "}
            {run.currentRewrite > 0 && (
              <span className="text-status-warn ml-1">
                <RefreshCw className="mr-0.5 inline size-2.5" />
                {run.currentRewrite}/{run.maxRewritesPerChapter}
              </span>
            )}
          </span>
          <span className="text-muted-foreground font-mono">
            {run.currentWords.toLocaleString()} /{" "}
            {run.targetWordsPerChapter.toLocaleString()}
          </span>
        </div>
        <div className="bg-secondary relative mt-1 h-1 overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              isRepairing
                ? "bg-status-warn"
                : "bg-foreground/45",
            )}
            style={{ width: `${currentChapterPct}%` }}
          />
        </div>
      </div>

      {/* Agent chain */}
      <div className="px-4 pb-3">
        <div className="text-muted-foreground mb-1.5 text-[10px] uppercase tracking-wider">
          {t("runs.currentAgent")}
        </div>
        <AgentChain
          activeId={run.currentAgentId}
          rewriting={isRepairing}
          lang={lang}
        />
      </div>

      {statusMessage && (
        <div
          className={cn(
            "mx-4 mb-3 rounded-md border px-3 py-2 text-[11px] leading-relaxed",
            displayStatus === "failed"
              ? "border-status-error/30 bg-status-error/10 text-status-error"
              : displayStatus === "needs-repair" || displayStatus === "blocked"
              ? "border-status-warn/30 bg-status-warn/10 text-status-warn"
              : "border-border bg-secondary text-muted-foreground",
          )}
        >
          {statusMessage}
        </div>
      )}

      {/* Stats */}
      <div className="border-border bg-secondary grid grid-cols-4 gap-1 border-y px-4 py-2.5">
        <Stat label={t("runs.adopted")} value={formatThousand(run.totalAdoptedWords)} />
        <Stat label={t("runs.tokens")} value={formatThousand(run.totalTokens)} />
        <Stat label={t("runs.retries")} value={String(run.totalRewrites)} />
        <Stat
          label={t("workspace.quality")}
          value={
            run.currentQuality !== undefined
              ? Math.round(run.currentQuality).toString()
              : "—"
          }
          accent={
            run.currentQuality !== undefined && run.currentQuality < run.targetQuality
              ? "warn"
              : run.currentQuality !== undefined
              ? "success"
              : undefined
          }
        />
      </div>

      {/* Recent events */}
      <div className="min-h-[120px] flex-1 px-4 py-3">
        <div className="text-muted-foreground mb-1.5 text-[10px] uppercase tracking-wider">
          {t("runs.recentEvents")}
        </div>
        <ul className="flex flex-col gap-1">
          {run.recentEvents.slice(0, 4).map((e, i) => (
            <EventRow key={i} event={e} lang={lang} />
          ))}
          {run.recentEvents.length === 0 && (
            <li className="text-muted-foreground text-[11px] italic">—</li>
          )}
        </ul>
      </div>

      {/* Footer actions */}
      <footer className="border-border flex items-center gap-2 border-t bg-card px-4 py-2.5">
        <span className="text-muted-foreground flex-1 text-[10px]">
          {t("runs.elapsed")}{" "}
          <span className="text-foreground/80 font-mono">
            {formatDuration(Date.now() - run.startedAt)}
          </span>
          {run.eta &&
            displayStatus !== "completed" &&
            displayStatus !== "failed" &&
            displayStatus !== "cancelled" && (
            <>
              <span className="mx-1.5 opacity-50">·</span>
              {t("runs.eta")}{" "}
              <span className="text-foreground/80 font-mono">
                {formatDuration(Math.max(0, run.eta - Date.now()))}
              </span>
            </>
          )}
        </span>

        <TooltipProvider delayDuration={200}>
          {canStop ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`${t("runs.pause")} · ${bookTitle}`}
                  disabled={actionInFlight}
                  onClick={() => setConfirmAction("stop")}
                >
                  <XCircle className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("runs.pause")}</TooltipContent>
            </Tooltip>
          ) : canResume ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`${t("runs.resume")} · ${bookTitle}`}
                  disabled={actionInFlight}
                  onClick={() => setConfirmAction("resume")}
                >
                  <Play className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("runs.resume")}</TooltipContent>
            </Tooltip>
          ) : null}

          {canCancel && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`${t("runs.cancel")} · ${bookTitle}`}
                  disabled={actionInFlight}
                  onClick={() => setConfirmAction("cancel")}
                >
                  <XCircle className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("runs.cancel")}</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>

        {canOpenBook ? (
          <Button
            asChild
            variant="secondary"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => setBookId(run.bookId)}
          >
            <Link href="/">
              {t("runs.viewBook")}
              <ArrowRight className="size-3" />
            </Link>
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled
            title={
              lang === "zh"
                ? "这本书已不在工作区，已阻止切到失效状态"
                : "This book is no longer in the workspace, so the stale switch was blocked."
            }
          >
            {t("runs.viewBook")}
            <ArrowRight className="size-3" />
          </Button>
        )}
      </footer>

      <RunActionDialog
        action={confirmAction}
        bookTitle={bookTitle}
        lang={lang}
        open={confirmAction !== null}
        pending={actionInFlight}
        run={run}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !actionInFlight) setConfirmAction(null)
        }}
        onConfirm={handleConfirmedRunAction}
      />
    </article>
  )
}

function RunActionDialog({
  action,
  bookTitle,
  lang,
  open,
  pending,
  run,
  onOpenChange,
  onConfirm,
}: {
  action: RunActionKind | null
  bookTitle: string
  lang: "zh" | "en"
  open: boolean
  pending: boolean
  run: AutoRun
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}) {
  if (!action) return null
  const copy = runActionCopy(action, lang)
  const currentQuality =
    run.currentQuality !== undefined
      ? Math.round(run.currentQuality).toString()
      : lang === "en"
      ? "unknown"
      : "未知"
  const chapterScope =
    run.currentChapter > 0
      ? `${run.currentChapter}-${run.toChapter}`
      : `${run.fromChapter}-${run.toChapter}`

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base">
            {copy.icon}
            {copy.title}
          </AlertDialogTitle>
          <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
            <span>{copy.description}</span>
            <span className="border-border bg-secondary text-foreground/80 rounded-md border px-3 py-2 font-mono text-[11px] leading-relaxed">
              {lang === "en"
                ? `${bookTitle} · chapters ${chapterScope} · gate >= ${run.targetQuality} · current quality ${currentQuality}`
                : `《${bookTitle}》 · 第 ${chapterScope} 章 · 质量门槛 ≥ ${run.targetQuality} · 当前质量 ${currentQuality}`}
            </span>
            <span>{copy.guardrail}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            {lang === "en" ? "Keep current state" : "保持当前状态"}
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            disabled={pending}
            className={cn(
              action !== "resume" &&
                "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20",
            )}
            onClick={(event) => {
              event.preventDefault()
              void onConfirm()
            }}
          >
            {pending ? copy.pendingLabel : copy.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function runActionCopy(action: RunActionKind, lang: "zh" | "en") {
  if (action === "resume") {
    return {
      icon: <Play className="text-status-success size-4" />,
      title: lang === "en" ? "Resume real writing?" : "恢复真实写作？",
      description:
        lang === "en"
          ? "This will restart the batch writing workflow from the current run position. It may consume LLM tokens, run automatic repair, and update manuscript files."
          : "这会从当前运行断点重新启动批量写作工作流，可能消耗 LLM token、执行自动复修，并更新稿件文件。",
      guardrail:
        lang === "en"
          ? "Use this only when the selected book and chapter scope are intentional."
          : "只有确认当前作品与章节范围正确时才继续。",
      confirmLabel: lang === "en" ? "Resume writing" : "确认恢复写作",
      pendingLabel: lang === "en" ? "Resuming..." : "正在恢复...",
    }
  }

  if (action === "stop") {
    return {
      icon: <XCircle className="text-destructive size-4" />,
      title: lang === "en" ? "Stop this workflow?" : "停止此工作流？",
      description:
        lang === "en"
          ? "This is not a lightweight pause. Studio Web calls the backend stop workflow endpoint, cancels unfinished work, and releases active execution slots."
          : "这不是轻量暂停。Studio Web 会调用后端停止工作流端点，取消未完成任务并释放当前执行槽。",
      guardrail:
        lang === "en"
          ? "Already saved chapters and recovery drafts stay on disk; no new agent step should start after stopping."
          : "已落库章节和恢复草稿会留在本地；停止后不应再启动新的 agent 步骤。",
      confirmLabel: lang === "en" ? "Stop workflow" : "确认停止",
      pendingLabel: lang === "en" ? "Stopping..." : "正在停止...",
    }
  }

  return {
    icon: <AlertTriangle className="text-destructive size-4" />,
    title: lang === "en" ? "Cancel this repairable run?" : "终止这个可复修任务？",
    description:
      lang === "en"
        ? "This will mark the run as cancelled instead of repairing or resuming it. It does not improve the current chapter."
        : "这会把该运行标记为终止，而不是复修或恢复它；当前章节质量不会因此变好。",
    guardrail:
      lang === "en"
        ? "Keep the run if you still want to inspect the failure and resume repair."
        : "如果还要检查失败原因并继续复修，请保持当前状态。",
    confirmLabel: lang === "en" ? "Cancel run" : "确认终止",
    pendingLabel: lang === "en" ? "Cancelling..." : "正在终止...",
  }
}

function AgentChain({
  activeId,
  rewriting,
  lang,
}: {
  activeId?: string
  rewriting: boolean
  lang: "zh" | "en"
}) {
  const activeIdx = AGENT_CHAIN.findIndex((a) => a.id === activeId)
  const total = AGENT_CHAIN.length
  const current = activeIdx >= 0 ? AGENT_CHAIN[activeIdx] : undefined
  const done = activeIdx > 0 ? activeIdx : 0
  // 克制重做:15 个 agent 挤一行会把名字截没。改成「一排进度点(可 hover 看名) + 当前角色全名」,
  // 点紧凑、名可读,一眼看到进度 + 现在谁在接棒。
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {AGENT_CHAIN.map((a, i) => {
          const reached = activeIdx >= i
          const isActive = i === activeIdx
          return (
            <span
              key={a.id}
              title={a[lang]}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                isActive
                  ? rewriting ? "bg-status-warn" : "bg-primary"
                  : reached ? "bg-primary/40" : "bg-border",
              )}
            />
          )
        })}
      </div>
      <div className="flex items-center gap-2 text-[12px]">
        {current ? (
          <>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium",
                rewriting ? "bg-status-warn/12 text-status-warn" : "bg-primary/12 text-primary",
              )}
            >
              <span className={cn("size-1.5 rounded-full", rewriting ? "bg-status-warn" : "bg-primary")} />
              {current[lang]}
              {rewriting && (lang === "en" ? " · revising" : " · 修订中")}
            </span>
            <span className="text-muted-foreground text-[11px] tabular-nums">
              {activeIdx + 1}/{total}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground text-[11px]">
            {lang === "en" ? "Idle" : "待命中"}
          </span>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: "warn" | "success"
}) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground text-[9px] uppercase tracking-wider">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[13px] font-semibold tabular-nums leading-tight",
          accent === "warn" && "text-status-warn",
          accent === "success" && "text-status-success",
        )}
      >
        {value}
      </span>
    </div>
  )
}

function StatusPill({ status }: { status: AutoRunStatus }) {
  const t = useT()
  const map: Partial<Record<AutoRunStatus, { label: string; cls: string; icon: React.ReactNode }>> = {
    running: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-running/12 text-status-success",
      icon: <CircleDot className="size-3" />,
    },
    rewriting: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-warn/14 text-status-warn",
      icon: <RefreshCw className="size-3 animate-spin [animation-duration:3s]" />,
    },
    writing: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-running/12 text-status-success",
      icon: <CircleDot className="size-3" />,
    },
    repairing: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-warn/14 text-status-warn",
      icon: <RefreshCw className="size-3 animate-spin [animation-duration:3s]" />,
    },
    "batch-writing": {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-running/12 text-status-success",
      icon: <CircleDot className="size-3" />,
    },
    "quality-batch-repairing": {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-warn/14 text-status-warn",
      icon: <RefreshCw className="size-3 animate-spin [animation-duration:3s]" />,
    },
    model_done: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-primary/12 text-primary",
      icon: <CircleDot className="size-3" />,
    },
    accepted: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-success/14 text-status-success",
      icon: <CheckCircle2 className="size-3" />,
    },
    "needs-repair": {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-warn/14 text-status-warn",
      icon: <AlertTriangle className="size-3" />,
    },
    blocked: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-warn/14 text-status-warn",
      icon: <AlertTriangle className="size-3" />,
    },
    unknown: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-secondary text-muted-foreground",
      icon: <CircleDot className="size-3" />,
    },
    paused: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-secondary text-muted-foreground",
      icon: <Pause className="size-3" />,
    },
    cancelled: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-secondary text-muted-foreground",
      icon: <XCircle className="size-3" />,
    },
    completed: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-success/14 text-status-success",
      icon: <CheckCircle2 className="size-3" />,
    },
    failed: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-status-error/14 text-status-error",
      icon: <AlertTriangle className="size-3" />,
    },
    queued: {
      label: t(autoRunStatusLabelKey(status)),
      cls: "bg-secondary text-muted-foreground",
      icon: <CircleDot className="size-3" />,
    },
  }
  const m = map[status] ?? {
    label: status,
    cls: "bg-secondary text-muted-foreground",
    icon: <CircleDot className="size-3" />,
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
        m.cls,
      )}
    >
      {m.icon}
      {m.label}
    </span>
  )
}

function EventRow({ event, lang }: { event: AutoRunEvent; lang: "zh" | "en" }) {
  const ICONS: Record<AutoRunEvent["type"], React.ReactNode> = {
    "agent.start": <CircleDot className="size-2.5" />,
    "agent.end": <CheckCircle2 className="size-2.5" />,
    "chapter.start": <CircleDot className="size-2.5" />,
    "chapter.complete": <CheckCircle2 className="text-status-success size-2.5" />,
    "quality.gate.fail": <AlertTriangle className="text-status-warn size-2.5" />,
    "rewrite.trigger": <RefreshCw className="text-status-warn size-2.5" />,
    "rewrite.success": <CheckCircle2 className="text-status-success size-2.5" />,
    "run.pause": <Pause className="size-2.5" />,
    "run.resume": <Play className="size-2.5" />,
    "run.error": <XCircle className="text-status-error size-2.5" />,
  }
  const tone =
    event.type === "quality.gate.fail" || event.type === "run.error"
      ? "text-status-warn"
      : event.type === "chapter.complete" || event.type === "rewrite.success"
      ? "text-foreground/80"
      : "text-muted-foreground"

  return (
    <li className="flex items-start gap-2 text-[11px] leading-snug">
      <span className="mt-1 shrink-0">{ICONS[event.type]}</span>
      <span className={cn("min-w-0 flex-1 truncate", tone)}>
        {event.message[lang]}
      </span>
    </li>
  )
}

function statusAccent(s: AutoRunStatus) {
  if (s === "running" || s === "writing" || s === "batch-writing")
    return { dot: "var(--status-running)", halo: "color-mix(in oklab, var(--status-running) 25%, transparent)" }
  if (s === "rewriting" || s === "repairing" || s === "quality-batch-repairing" || s === "needs-repair")
    return { dot: "var(--status-warn)", halo: "color-mix(in oklab, var(--status-warn) 25%, transparent)" }
  if (s === "completed" || s === "accepted") return { dot: "var(--status-success)", halo: "transparent" }
  if (s === "failed" || s === "blocked") return { dot: "var(--status-error)", halo: "transparent" }
  if (s === "cancelled") return { dot: "var(--muted-foreground)", halo: "transparent" }
  return { dot: "var(--muted-foreground)", halo: "transparent" }
}

function formatThousand(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n.toString()
}

function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}
