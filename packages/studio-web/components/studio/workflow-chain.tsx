"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { useLocale, useT } from "@/lib/i18n"
import {
  AGENTS,
  WORKFLOW_STAGES,
  type Agent,
  type Stage,
  type WorkflowStage,
} from "@/lib/studio-data"
import type { WorkflowSnapshot } from "@/lib/api/types"
import { agentColor, agentSoftBg } from "@/lib/agent-identity"

/**
 * 工作流调度链 — 6 阶段竖向 swimlane
 * 每行：阶段名 + 进度条 + 当前激活的 agents 头像组
 */
export function WorkflowChain({
  snapshot,
  stages = WORKFLOW_STAGES,
  transitionReason,
}: {
  snapshot: WorkflowSnapshot
  stages?: Stage[]
  /** 显式 agent→agent 转移原因（取自当前 run 的最新 stage 文本）—— §17 #1 */
  transitionReason?: string
}) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"

  const agentsById = React.useMemo(
    () => new Map(AGENTS.map((a) => [a.id, a])),
    [],
  )

  return (
    <div className="space-y-1.5">
      {/* total progress */}
      <div className="bg-secondary/40 mb-2 flex items-center justify-between rounded-md px-2.5 py-1.5">
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
          {t("workflow.totalProgress")}
        </span>
        <span className="font-mono text-[11px] font-medium">
          {Math.round(snapshot.totalProgress * 100)}%
        </span>
      </div>

      {/* 竖向连线工作流:阶段沿一条主轴串联,走过的段亮起,一眼看出流到哪、谁在动 */}
      <ol className="relative">
        {stages.map((stage, idx) => {
          const isCurrent = stage.id === snapshot.currentStage
          const progress = snapshot.stageProgress[stage.id] ?? 0
          const activeIds = snapshot.activeAgentsByStage[stage.id] ?? []
          const activeAgents = activeIds
            .map((id) => agentsById.get(id))
            .filter((a): a is Agent => Boolean(a))
          const agentsInStage = stage.agentIds
            .map((id) => agentsById.get(id))
            .filter((a): a is Agent => Boolean(a))
          const isDone = progress >= 1
          const isActivelyRunning = isCurrent && !isDone
          const isLast = idx === stages.length - 1
          // 连线段:本阶段→下一阶段。已完成=绿(流已通过),进行中=主色,未到=淡。
          const connectorClass = isDone
            ? "bg-status-success/70"
            : isActivelyRunning
              ? "bg-primary/60"
              : "bg-border"

          // 下一阶段 + 其首位 agent —— 用于连线上的「谁→谁」交接标注。
          const nextStage = isLast ? undefined : stages[idx + 1]
          const nextLeadAgent = nextStage
            ? nextStage.agentIds
                .map((id) => agentsById.get(id))
                .find((a): a is Agent => Boolean(a))
            : undefined

          return (
            <li key={stage.id} className="relative flex gap-2.5 pb-1.5 last:pb-0">
              {/* 主轴:阶段徽标 + 向下连线 */}
              <div className="relative flex w-4 shrink-0 flex-col items-center">
                <StageBadge stage={stage.id} isCurrent={isActivelyRunning} isDone={isDone} />
                {!isLast && (
                  <div className="relative mt-1 w-px flex-1" style={{ minHeight: "0.9rem" }}>
                    <div className={cn("absolute inset-0 w-px rounded-full transition-colors duration-500", connectorClass)} />
                    {/* 流向箭头:进行中阶段下方做一个轻微下淌动画,强调"正流向下一步" */}
                    {isActivelyRunning && (
                      <span className="bg-primary motion-safe:animate-pulse absolute -bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full" />
                    )}
                  </div>
                )}
              </div>

              {/* 阶段卡片 */}
              <div
                className={cn(
                  "border-border/30 group bg-card/40 relative min-w-0 flex-1 rounded-md border p-2 transition-colors",
                  isActivelyRunning && "border-primary/40 bg-primary/[0.04]",
                  isCurrent && isDone && "border-status-success/40 bg-status-success/[0.04]",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{stage.name[lang]}</span>
                  <span className="text-muted-foreground font-mono text-[9px]">{Math.round(progress * 100)}%</span>
                </div>

                {/* §17 #1：当前阶段下显式 agent→agent 转移原因 */}
                {isActivelyRunning && transitionReason && (
                  <div className="text-muted-foreground mt-1 line-clamp-2 text-[10px] italic leading-snug">
                    → 为什么走到这一步：{transitionReason}
                  </div>
                )}

                {/* progress bar */}
                <div className="bg-secondary/60 mt-1.5 h-[3px] w-full overflow-hidden rounded-full">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-700",
                      isActivelyRunning ? "bg-primary" : isDone ? "bg-status-success" : "bg-muted-foreground/40",
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }}
                  />
                </div>

                {/* 本阶段 agents —— 每个一个专属颜色,色点 + 描边,扫一眼知道谁在动 */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {agentsInStage.map((a) => {
                    const isActive = activeAgents.includes(a)
                    const color = agentColor(a.id)
                    return (
                      <span
                        key={a.id}
                        title={`${a.num}. ${a.name[lang]} — ${a.role[lang]}`}
                        className={cn(
                          "group/agent flex h-5 min-w-0 cursor-default items-center gap-1 rounded-full border px-1.5 text-[9px] transition-all",
                          isActive ? "font-medium" : "opacity-55",
                        )}
                        style={{
                          borderColor: isActive ? color : "var(--border)",
                          background: isActive ? agentSoftBg(a.id, 14) : "color-mix(in oklab, var(--card) 60%, transparent)",
                        }}
                      >
                        <span
                          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", isActive && "motion-safe:animate-pulse")}
                          style={{ background: color }}
                        />
                        <span className="text-foreground/90 max-w-[64px] truncate">{a.name[lang]}</span>
                        <span className="text-muted-foreground/70 font-mono text-[8px]">{a.num}</span>
                      </span>
                    )
                  })}
                </div>

                {/* 连线交接标注:谁→谁、下一步流向哪 —— 安静的小字,贴着向下连线 */}
                {nextStage && (
                  <div className="text-muted-foreground/70 mt-1.5 flex items-center gap-1 text-[9px] leading-none">
                    <span className="opacity-70">
                      {lang === "en" ? "Next" : "下一步"}
                    </span>
                    <span aria-hidden className={cn(isActivelyRunning && "text-primary")}>→</span>
                    <span className="text-foreground/70 truncate font-medium">{nextStage.name[lang]}</span>
                    {nextLeadAgent && (
                      <span className="text-muted-foreground/60 inline-flex min-w-0 items-center gap-1">
                        <span aria-hidden className="opacity-50">·</span>
                        <span
                          className="size-1 shrink-0 rounded-full"
                          style={{ background: agentColor(nextLeadAgent.id) }}
                          aria-hidden
                        />
                        <span className="max-w-[72px] truncate">{nextLeadAgent.name[lang]}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function StageBadge({
  stage,
  isCurrent,
  isDone,
}: {
  stage: WorkflowStage
  isCurrent: boolean
  isDone: boolean
}) {
  const STAGE_NUM: Record<WorkflowStage, number> = {
    prepare: 1,
    generate: 2,
    review: 3,
    revise: 4,
    persist: 5,
    publish: 6,
  }
  return (
    <span
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[9px] font-semibold transition-all",
        isCurrent
          ? "bg-primary text-primary-foreground"
          : isDone
            ? "bg-status-success text-primary-foreground"
            : "bg-secondary text-muted-foreground",
      )}
    >
      {STAGE_NUM[stage]}
    </span>
  )
}
