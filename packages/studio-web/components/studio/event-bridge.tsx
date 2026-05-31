"use client"

/**
 * SSE → SWR 自动失效桥接器
 *
 * 单实例挂在 page 根节点。订阅 /api/v1/books/:id/events 单一 SSE 通道，
 * 按事件 type 分发到对应 SWR 缓存键，触发 useSWR 的乐观重新拉取。
 *
 * 这层让"后端推一个事件 → 前端 UI 自动更新"成为零认知成本：
 * 组件只用 useXxx 拿数据，不需要监听任何事件。
 */

import * as React from "react"
import { unstable_serialize, useSWRConfig, type Key } from "swr"
import { useStudio } from "@/lib/studio-context"
import { subscribeSharedAgentEvents } from "@/lib/agent-event-stream"

const EVENT_BRIDGE_BATCH_MS = 350
const TOKEN_REVALIDATE_MS = 1_200
const RUN_REVALIDATE_MS = 700
const RUN_EVENT_RE =
  /^(write|batch|quality-batch|chapter:quality-repair|state-repair|workflow|watchdog|agent:stage|prompt-governance|llm):/

export function EventBridge() {
  const { bookId, currentChapter } = useStudio()
  const { mutate } = useSWRConfig()
  const pendingKeysRef = React.useRef(new Map<string, Key>())
  const flushTimerRef = React.useRef<number | null>(null)
  const lastQueuedAtRef = React.useRef(new Map<string, number>())

  const queueMutate = React.useCallback(
    (key: Key, throttleMs = EVENT_BRIDGE_BATCH_MS) => {
      const id = unstable_serialize(key)
      if (!id) return

      const now = Date.now()
      const lastQueuedAt = lastQueuedAtRef.current.get(id) ?? 0
      if (now - lastQueuedAt < throttleMs) return

      lastQueuedAtRef.current.set(id, now)
      pendingKeysRef.current.set(id, key)

      if (flushTimerRef.current !== null) return
      flushTimerRef.current = window.setTimeout(() => {
        const keys = Array.from(pendingKeysRef.current.values())
        pendingKeysRef.current.clear()
        flushTimerRef.current = null
        keys.forEach((item) => {
          void mutate(item)
        })
      }, EVENT_BRIDGE_BATCH_MS)
    },
    [mutate],
  )

  React.useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
      }
    }
  }, [])

  React.useEffect(() => {
    if (!bookId) return
    const unsubscribe = subscribeSharedAgentEvents(bookId, (e) => {
      const rawEvent = e.rawEvent ?? ""
      const chapter = e.chapterNumber ?? (e.type === "token" ? e.chapter : 0)

      if (RUN_EVENT_RE.test(rawEvent)) {
        queueMutate("auto-runs", RUN_REVALIDATE_MS)
        if (e.runId) {
          queueMutate(["auto-run", e.runId], RUN_REVALIDATE_MS)
        }
        queueMutate(["workflow", bookId], RUN_REVALIDATE_MS)
      }

      switch (e.type) {
        case "agent-status":
          // agent 状态变化 → 失效 agent 列表与 workflow 快照
          queueMutate("agents")
          queueMutate(["workflow", bookId])
          break

        case "stage-update":
          // 工作流阶段推进 → 失效 workflow + plot
          queueMutate(["workflow", bookId])
          queueMutate(["plot", bookId])
          if (chapter > 0) {
            queueMutate(["chapter-stats", bookId, chapter], RUN_REVALIDATE_MS)
            queueMutate(["quality", bookId, chapter], RUN_REVALIDATE_MS)
          }
          break

        case "metric":
          // 指标变化 → 失效 dock + 章节 stats + 质量
          queueMutate(["dock", bookId])
          queueMutate(["chapter-stats", bookId, chapter || currentChapter])
          queueMutate(["quality", bookId, chapter || currentChapter])
          break

        case "token":
          // token 高频到达时只做节流刷新，避免每个 chunk 都触发正文回流。
          if (chapter > 0) {
            queueMutate(["manuscript", bookId, chapter], TOKEN_REVALIDATE_MS)
            queueMutate(
              ["chapter-stats", bookId, chapter],
              TOKEN_REVALIDATE_MS,
            )
          }
          break

        case "memory-add":
          // 新记忆条目 → 失效全部 memory 缓存（不区分 kind）
          mutate(
            (key) =>
              Array.isArray(key) && key[0] === "memory" && key[1] === bookId,
            undefined,
            { revalidate: true },
          )
          break

        case "graph-update":
          // 关系图谱重算完成 → 失效全部 graph 缓存
          mutate(
            (key) =>
              Array.isArray(key) && key[0] === "graph" && key[1] === bookId,
            undefined,
            { revalidate: true },
          )
          break

        case "log":
          // 日志事件本身不改 SWR 缓存；如需要，组件可单独订阅
          break
      }
    })
    return unsubscribe
  }, [bookId, currentChapter, mutate, queueMutate])

  return null
}
