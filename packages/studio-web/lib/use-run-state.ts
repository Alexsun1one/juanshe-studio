"use client"

/**
 * 订阅本作品的「真实写作状态」—— 轮询后端 task_runs(/api/v1/books/:id/runs)。
 * 这是"是否正在写作 / 当前哪个 agent / 当前阶段"的唯一真相来源,
 * 取代前端虚构、后端 404 的 auto-runs 引擎(它从来没接上真后端,导致横幅永远"待命"、
 * 续写键永远以为没在跑 → 点了就 409 报错)。
 *
 * 该端点每次调用都会自愈残留 stale run,所以轮询本身也顺带把僵尸任务标 error。
 */
import * as React from "react"
import useSWR from "swr"
import { fetchBookRuns } from "@/lib/api/client"
import type { BookRun } from "@/lib/api/types"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"

const ACTIVE_STATUSES = new Set(["running", "queued", "pending", "active", "streaming"])

export type RunState = {
  /** 是否有进行中的写作/改写/修复任务 */
  isRunning: boolean
  /** 进行中的那个 run(没有则 undefined) */
  activeRun?: BookRun
  /** 当前激活 agent 的前端 id(如 writer / planner) */
  currentAgentId?: string
  /** 当前阶段文案,如「第 4 章重写中」 */
  currentStage?: string
  /** 运行类型:write-next / rewrite / ... */
  runType?: string
  /** 最近一条失败 run 的错误(用于前台兜底提示) */
  lastError?: string
  /** 立即重新拉取(触发写作后调用,让状态秒级反映) */
  refresh: () => void
}

export function useRunState(bookId: string | undefined): RunState {
  const { data, mutate } = useSWR(
    bookId ? ["book-runs", bookId] : null,
    () => fetchBookRuns(bookId as string),
    { refreshInterval: 3500, shouldRetryOnError: false, dedupingInterval: 1500 },
  )

  const refresh = React.useCallback(() => {
    void mutate()
  }, [mutate])

  const runs = data ?? []
  const activeRun = runs.find((r) => ACTIVE_STATUSES.has(String(r.status)))
  const lastError = runs.find(
    (r) => String(r.status) === "error" && (r.error || r.failureReason),
  )

  return {
    isRunning: Boolean(activeRun),
    activeRun,
    currentAgentId: activeRun?.currentAgent
      ? toFrontendAgentId(activeRun.currentAgent)
      : undefined,
    currentStage: activeRun?.currentStage,
    runType: activeRun?.type,
    lastError: lastError?.error || lastError?.failureReason,
    refresh,
  }
}
