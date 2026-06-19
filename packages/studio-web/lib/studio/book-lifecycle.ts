// 一本书的「生命周期状态机」—— 把持久状态(book.creationStatus)+ 实时建书态合一。
//
// 以前这套判定只活在 books/page.tsx 里;「需要处理」中枢页也要按同一口径判断哪本书卡住/失败/需补地基,
// 所以抽到共享层,books 页与中枢页共用,避免两处各判一套又漂移。

import type { BookSummary } from "@/lib/api/types"
import { getBookReadiness } from "@/lib/studio/book-readiness"

// 后端内存里的实时建书状态(server.ts: bookCreateStatus + isLiveBookCreateStatus)。
// 单条形状与 components/shell/build-status-indicator.tsx 对齐;共用同一个 SWR key "books-create-states"
// 从而共享一次轮询、一份缓存(不重复打后端)。
export type CreateState = {
  bookId: string
  status: string | null
  stage: string | null
  agent: string | null
  agentLabel: string | null
  startedAt: number | null
  lastEventAt: number | null
  live: boolean
}

export type Lifecycle =
  | "creating-live" // 建书中(架构师在跑)
  | "creating-stuck" // 建书卡住(creating 但已无心跳)
  | "failed" // 建书失败
  | "needs-foundation" // 需补地基
  | "writing" // 写作中
  | "ready" // 就绪

export type LifecycleMeta = {
  state: Lifecycle
  label: string
  /** 设计系统状态 pill 的 data-state(语义色只走状态) */
  tone: "running" | "warn" | "error" | "success"
  /** 该状态当前的责任角色像素 */
  agent: string
  /** 一行说明(克制,不做卡片) */
  hint: string
}

/** 这些状态是"需要用户处理"的卡点(中枢页据此聚合 TODO)。 */
export const BLOCKED_LIFECYCLE_STATES: ReadonlySet<Lifecycle> = new Set<Lifecycle>([
  "creating-stuck",
  "failed",
  "needs-foundation",
])

export function resolveLifecycle(book: BookSummary, create: CreateState | undefined): LifecycleMeta {
  const createStatus = String(create?.status ?? "").toLowerCase()
  const isCreatingRecord = createStatus === "creating"

  // 1) 实时建书态优先:还在 creating 记录里
  if (isCreatingRecord) {
    if (create?.live) {
      return {
        state: "creating-live",
        label: "建书中",
        tone: "running",
        agent: create?.agent || "architect",
        hint: create?.stage || "架构师正在搭建故事地基…",
      }
    }
    return {
      state: "creating-stuck",
      label: "建书卡住",
      tone: "warn",
      agent: create?.agent || "architect",
      hint: "建书任务已无心跳,可能中断了;取消后重试或删掉半成品。",
    }
  }

  // 2) 持久状态:用既有 readiness 判定(book.creationStatus → 标签/动作)
  const readiness = getBookReadiness(book)

  if (book.autoRunning && readiness.writable) {
    return {
      state: "writing",
      label: "写作中",
      tone: "running",
      agent: "writer",
      hint: "续写任务进行中,可进入观察或停止。",
    }
  }

  if (readiness.writable) {
    return {
      state: "ready",
      label: "就绪",
      tone: "success",
      agent: "editor-in-chief",
      hint: `${book.currentChapter}/${book.plannedChapters} 章 · 可进入继续创作。`,
    }
  }

  switch (readiness.status) {
    case "needs-foundation":
      return {
        state: "needs-foundation",
        label: "需补地基",
        tone: "warn",
        agent: "foundation-reviewer",
        hint: "建书地基未通过,先补地基再续写。",
      }
    case "stalled":
      return {
        state: "creating-stuck",
        label: "建书卡住",
        tone: "warn",
        agent: "architect",
        hint: "上次建书没有正常落地,取消后重试或删掉半成品。",
      }
    case "error":
    case "failed":
      return {
        state: "failed",
        label: "建书失败",
        tone: "error",
        agent: "state-verifier",
        hint: readiness.detail,
      }
    default:
      // outlining / draft / 仅有大纲未开写 等 → 当作需补地基处理(可补地基/重试)
      return {
        state: "needs-foundation",
        label: "需补地基",
        tone: "warn",
        agent: "foundation-reviewer",
        hint: readiness.detail,
      }
  }
}

/** 拉后端实时建书态(与 books 页、build-status-indicator 共用同一 SWR key "books-create-states")。 */
export async function fetchCreateStates(): Promise<CreateState[]> {
  const res = await fetch("/api/v1/books/create-states", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (!res.ok) return []
  const json = (await res.json().catch(() => null)) as { states?: CreateState[] } | null
  return Array.isArray(json?.states) ? json!.states : []
}
