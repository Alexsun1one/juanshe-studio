// ============================================================================
// 数据 hooks — 全部走 SWR + lib/api/client.ts
// 组件不直接 fetch，统一走这里。可以在这里加全局缓存、polling、SSE 合流策略
// ============================================================================

"use client"

import useSWR from "swr"
import {
  fetchAgentProfiles,
  fetchAgents,
  fetchAssets,
  fetchAutoRun,
  fetchAutoRuns,
  fetchBook,
  fetchCast,
  fetchChapters,
  fetchChapterStats,
  fetchDockMetrics,
  fetchLLMProviders,
  fetchManuscript,
  fetchMemory,
  fetchOpportunities,
  fetchOutline,
  fetchPlotProgress,
  fetchProjectPrefs,
  fetchPublishChannels,
  fetchQuality,
  fetchChapterQualityRaw,
  fetchRelationshipGraph,
  fetchReviewIssues,
  fetchRewriteProposal,
  fetchRoleQueue,
  fetchStyleFingerprint,
  fetchSystemHealth,
  fetchWiki,
  fetchWorkflow,
  fetchWorkflowContract,
  fetchWorld,
} from "@/lib/api/client"
import type { AutoRun } from "@/lib/api/types"
import { type MemoryItem } from "@/lib/studio-data"
import { isLiveAutoRunStatus } from "@/lib/studio/run-status"

// SSE/EventBridge drives live changes; SWR polling is only a safety net so it
// must stay quiet while the streaming writing surface is active.
const REFRESH_FAST = 6_000
const REFRESH_NORMAL = 45_000
const REFRESH_SLOW = 120_000
const PREFETCHED_CONTENT_OPTIONS = {
  dedupingInterval: 6_000,
  revalidateIfStale: false,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

type HookOptions = {
  enabled?: boolean
}

function isHookEnabled(options?: HookOptions) {
  return options?.enabled !== false
}

function hasLiveAutoRun(runs?: AutoRun[]) {
  return Boolean(runs?.some((run) => isLiveAutoRunStatus(run.status)))
}

export function useAgents(options?: HookOptions) {
  return useSWR(isHookEnabled(options) ? "agents" : null, fetchAgents, {
    refreshInterval: REFRESH_NORMAL,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useWorkflow(bookId: string, options?: HookOptions) {
  const enabled = Boolean(bookId) && isHookEnabled(options)
  return useSWR(enabled ? ["workflow", bookId] : null, () => fetchWorkflow(bookId), {
    refreshInterval: REFRESH_NORMAL,
    dedupingInterval: 4_000,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useBook(bookId: string) {
  return useSWR(bookId ? ["book", bookId] : null, () => fetchBook(bookId), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useChapters(bookId: string, options?: HookOptions) {
  const enabled = Boolean(bookId) && isHookEnabled(options)
  return useSWR(enabled ? ["chapters", bookId] : null, () => fetchChapters(bookId), {
    ...PREFETCHED_CONTENT_OPTIONS,
    refreshInterval: REFRESH_FAST,
    revalidateIfStale: true,
    revalidateOnFocus: true,
  })
}

export function useRoleQueue(bookId: string, chapter: number) {
  const enabled = Boolean(bookId) && chapter > 0
  return useSWR(
    enabled ? ["role-queue", bookId, chapter] : null,
    () => fetchRoleQueue(bookId, chapter),
    {
      refreshInterval: REFRESH_NORMAL,
      dedupingInterval: 4_000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}

export function useRelationshipGraph(
  bookId: string,
  focusId?: string,
  options?: HookOptions,
) {
  const enabled = Boolean(bookId) && isHookEnabled(options)
  return useSWR(
    enabled ? ["graph", bookId, focusId] : null,
    () => fetchRelationshipGraph(bookId, focusId),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}

export function usePlot(bookId: string, options?: HookOptions) {
  const enabled = Boolean(bookId) && isHookEnabled(options)
  return useSWR(enabled ? ["plot", bookId] : null, () => fetchPlotProgress(bookId), {
    refreshInterval: REFRESH_NORMAL,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useMemory(
  bookId: string,
  kind?: MemoryItem["kind"],
  options?: HookOptions,
) {
  const enabled = Boolean(bookId) && isHookEnabled(options)
  return useSWR(enabled ? ["memory", bookId, kind] : null, () => fetchMemory(bookId, kind), {
    refreshInterval: REFRESH_SLOW,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useStyleFingerprint(bookId: string, options?: HookOptions) {
  const enabled = Boolean(bookId) && isHookEnabled(options)
  return useSWR(enabled ? ["style", bookId] : null, () => fetchStyleFingerprint(bookId), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useQuality(bookId: string, chapter: number) {
  const enabled = Boolean(bookId) && chapter > 0
  return useSWR(
    enabled ? ["quality", bookId, chapter] : null,
    () => fetchQuality(bookId, chapter),
    {
      refreshInterval: REFRESH_NORMAL,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}

/** 每章质量原始 payload（9 维 + gate + reasons），带用户设定达标分 */
export function useChapterQualityRaw(
  bookId: string,
  chapter: number,
  targetScore: number,
) {
  const enabled = Boolean(bookId) && chapter > 0
  return useSWR(
    enabled ? ["chapter-quality-raw", bookId, chapter, targetScore] : null,
    () => fetchChapterQualityRaw(bookId, chapter, targetScore),
    {
      refreshInterval: REFRESH_NORMAL,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}

export function useOpportunities(options?: HookOptions) {
  return useSWR(isHookEnabled(options) ? "opps" : null, fetchOpportunities, {
    refreshInterval: REFRESH_SLOW,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useDockMetrics(bookId: string) {
  return useSWR(bookId ? ["dock", bookId] : null, () => fetchDockMetrics(bookId), {
    refreshInterval: REFRESH_NORMAL,
    dedupingInterval: 4_000,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useSystemHealth() {
  return useSWR("health", fetchSystemHealth, {
    refreshInterval: REFRESH_NORMAL,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useCast(bookId: string) {
  return useSWR(bookId ? ["cast", bookId] : null, () => fetchCast(bookId), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useWorld(bookId: string) {
  return useSWR(bookId ? ["world", bookId] : null, () => fetchWorld(bookId), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useAssets(bookId: string) {
  return useSWR(bookId ? ["assets", bookId] : null, () => fetchAssets(bookId), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function useOutline(bookId: string) {
  return useSWR(bookId ? ["outline", bookId] : null, () => fetchOutline(bookId), {
    refreshInterval: REFRESH_NORMAL,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

export function usePublishChannels(bookId: string) {
  return useSWR(
    bookId ? ["publish-channels", bookId] : null,
    () => fetchPublishChannels(bookId),
    {
      refreshInterval: REFRESH_NORMAL,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}

export function useManuscript(
  bookId: string,
  chapter: number,
  options?: HookOptions & { live?: boolean },
) {
  const enabled = Boolean(bookId) && chapter > 0
  return useSWR(
    enabled && isHookEnabled(options) ? ["manuscript", bookId, chapter] : null,
    () => fetchManuscript(bookId, chapter),
    {
      ...PREFETCHED_CONTENT_OPTIONS,
      keepPreviousData: true,
      refreshInterval: options?.live ? REFRESH_FAST : REFRESH_NORMAL,
      revalidateIfStale: true,
      revalidateOnFocus: true,
      shouldRetryOnError: Boolean(options?.live),
      errorRetryInterval: REFRESH_FAST,
    },
  )
}

export function useChapterStats(bookId: string, chapter: number) {
  const enabled = Boolean(bookId) && chapter > 0
  return useSWR(
    enabled ? ["chapter-stats", bookId, chapter] : null,
    () => fetchChapterStats(bookId, chapter),
    {
      ...PREFETCHED_CONTENT_OPTIONS,
      keepPreviousData: true,
      refreshInterval: REFRESH_NORMAL,
    },
  )
}

export function useReviewIssues(bookId: string, chapter: number) {
  const enabled = Boolean(bookId) && chapter > 0
  return useSWR(
    enabled ? ["review-issues", bookId, chapter] : null,
    () => fetchReviewIssues(bookId, chapter),
    {
      refreshInterval: REFRESH_NORMAL,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}

export function useRewriteProposal(
  bookId: string,
  chapter: number,
  style?: string,
) {
  const enabled = Boolean(bookId) && chapter > 0
  return useSWR(
    enabled ? ["rewrite-proposal", bookId, chapter, style] : null,
    () => fetchRewriteProposal(bookId, chapter, style),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}

// 自动续写引擎：活动任务主要由 SSE 推动；轮询只做慢速兜底，避免运行态刷卡。
export function useAutoRuns() {
  return useSWR("auto-runs", fetchAutoRuns, {
    keepPreviousData: true,
    refreshInterval: (runs?: AutoRun[]) =>
      runs === undefined || hasLiveAutoRun(runs) ? REFRESH_FAST : REFRESH_NORMAL,
    dedupingInterval: 2500,
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  })
}

export function useAutoRun(id: string | null) {
  return useSWR(
    id ? ["auto-run", id] : null,
    () => fetchAutoRun(id as string),
    {
      keepPreviousData: true,
      refreshInterval: (run?: AutoRun) =>
        run && isLiveAutoRunStatus(run.status)
          ? REFRESH_FAST
          : REFRESH_NORMAL,
      dedupingInterval: 2500,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}

// Agent Lab
export function useAgentProfiles() {
  return useSWR("agent-profiles", fetchAgentProfiles, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}
export function useWorkflowContract() {
  return useSWR("workflow-contract", fetchWorkflowContract, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

// Settings
export function useLLMProviders() {
  return useSWR("llm-providers", fetchLLMProviders, {
    refreshInterval: REFRESH_NORMAL,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}
export function useProjectPrefs() {
  return useSWR("project-prefs", fetchProjectPrefs, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}

// Wiki
export function useWiki(bookId: string) {
  return useSWR(bookId ? ["wiki", bookId] : null, () => fetchWiki(bookId), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
}
