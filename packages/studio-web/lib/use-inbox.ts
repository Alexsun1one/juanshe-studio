"use client"

// 「需要处理」的唯一数据源。
//
// 用户痛点:撞墙时没有任何一处聚合"我现在卡在哪、该点什么"。这个 hook 把全站阻碍态收成一个 TODO 列表,
// 中枢页(/inbox)渲染完整列表 + 直达恢复动作,侧边栏只取 count 显示小红点 —— 同一份判断,不再各页各算。

import useSWR from "swr"
import { useWorkspace } from "@/lib/workspace-context"
import { fetchLLMProviders } from "@/lib/api/client"
import type { BookSummary } from "@/lib/api/types"
import {
  fetchCreateStates,
  resolveLifecycle,
  BLOCKED_LIFECYCLE_STATES,
} from "@/lib/studio/book-lifecycle"
import { RECOVERY_DEST } from "@/lib/recovery"

export type InboxTodo = {
  id: string
  kind: "model" | "book"
  severity: "high" | "warn"
  /** 责任角色像素 id;model 类无像素(用图标) */
  agent?: string
  title: string
  hint: string
  actionLabel: string
  /** 点了去哪 */
  href: string
  /** 若设置,跳转前先把它设为当前作品 */
  bookId?: string
}

function titleOf(book: BookSummary): string {
  const t = book.title as unknown
  if (typeof t === "string") return t || book.id
  if (t && typeof t === "object" && "zh" in t) {
    return (t as { zh?: string }).zh || book.id
  }
  return book.id
}

const SEVERITY_RANK: Record<string, number> = { high: 0, warn: 1 }

export function useInbox(): { todos: InboxTodo[]; count: number; loading: boolean } {
  const { books } = useWorkspace()
  // 与 page.tsx / books 页 / build-status-indicator 共用同一 SWR key,共享缓存、不重复打后端。
  const { data: providers } = useSWR("llm-providers", fetchLLMProviders, { shouldRetryOnError: false })
  const { data: createStates } = useSWR("books-create-states", fetchCreateStates, { refreshInterval: 8000 })

  const todos: InboxTodo[] = []

  // ① 没配写作模型 —— 最高优先,阻断一切(没 Key 连建书都不行)
  if (providers && !providers.some((p) => p.hasKey && p.enabled)) {
    todos.push({
      id: "model",
      kind: "model",
      severity: "high",
      title: "还没配置写作模型",
      hint: "粘贴你的大模型 API Key 并启用服务,编辑部才能开始写。这是所有功能的前置。",
      actionLabel: RECOVERY_DEST.model.label,
      href: RECOVERY_DEST.model.href,
    })
  }

  // ② 每本卡住 / 失败 / 需补地基的书
  const createByBook = new Map((createStates ?? []).map((s) => [s.bookId, s]))
  for (const book of books) {
    const meta = resolveLifecycle(book, createByBook.get(book.id))
    if (!BLOCKED_LIFECYCLE_STATES.has(meta.state)) continue
    todos.push({
      id: `book:${book.id}`,
      kind: "book",
      severity: meta.state === "failed" ? "high" : "warn",
      agent: meta.agent,
      title: `《${titleOf(book)}》· ${meta.label}`,
      hint: meta.hint,
      actionLabel: "去处理",
      href: RECOVERY_DEST.foundation.href, // 作品管理:那里有补地基 / 重试建书 / 删除
      bookId: book.id,
    })
  }

  todos.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))

  return { todos, count: todos.length, loading: !providers || !createStates }
}
