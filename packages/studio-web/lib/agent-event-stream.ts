"use client"

import {
  fetchAgentEvents,
  subscribeAgentEvents,
  type AgentEvent,
} from "@/lib/api/client"

type EventListener = (event: AgentEvent) => void
type ErrorListener = (error: Event) => void

type StreamEntry = {
  listeners: Set<EventListener>
  errorListeners: Set<ErrorListener>
  refCount: number
  unsubscribe?: () => void
  closeTimer?: ReturnType<typeof setTimeout>
  history?: AgentEvent[]
  historyFetchedAt?: number
  historyPromise?: Promise<AgentEvent[]>
}

const HISTORY_TTL_MS = 15_000
const STRICT_MODE_CLOSE_GRACE_MS = 1_000
const streams = new Map<string, StreamEntry>()

export function getAgentEventHistory(bookId: string) {
  const entry = getStreamEntry(bookId)
  const now = Date.now()

  if (
    entry.history &&
    entry.historyFetchedAt &&
    now - entry.historyFetchedAt < HISTORY_TTL_MS
  ) {
    return Promise.resolve(entry.history)
  }

  if (entry.historyPromise) return entry.historyPromise

  entry.historyPromise = fetchAgentEvents(bookId)
    .then((events) => {
      entry.history = events
      entry.historyFetchedAt = Date.now()
      return events
    })
    .finally(() => {
      entry.historyPromise = undefined
    })

  return entry.historyPromise
}

export function subscribeSharedAgentEvents(
  bookId: string,
  onEvent: EventListener,
  onError?: ErrorListener,
) {
  const entry = getStreamEntry(bookId)

  entry.refCount += 1
  entry.listeners.add(onEvent)
  if (onError) entry.errorListeners.add(onError)

  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer)
    entry.closeTimer = undefined
  }

  if (!entry.unsubscribe) {
    entry.unsubscribe = subscribeAgentEvents(
      bookId,
      (event) => {
        const current = streams.get(bookId)
        if (!current) return

        current.history = mergeEventIntoHistory(current.history, event)
        current.historyFetchedAt = Date.now()
        current.listeners.forEach((listener) => listener(event))
      },
      (error) => {
        const current = streams.get(bookId)
        if (!current) return

        current.errorListeners.forEach((listener) => listener(error))
      },
    )
  }

  return () => {
    const current = streams.get(bookId)
    if (!current) return

    current.listeners.delete(onEvent)
    if (onError) current.errorListeners.delete(onError)
    current.refCount = Math.max(0, current.refCount - 1)

    if (current.refCount > 0 || current.closeTimer) return

    current.closeTimer = setTimeout(() => {
      const latest = streams.get(bookId)
      if (!latest || latest.refCount > 0) return

      latest.unsubscribe?.()
      latest.unsubscribe = undefined
      latest.closeTimer = undefined

      if (latest.listeners.size === 0 && latest.errorListeners.size === 0) {
        streams.delete(bookId)
      }
    }, STRICT_MODE_CLOSE_GRACE_MS)
  }
}

function getStreamEntry(bookId: string) {
  let entry = streams.get(bookId)
  if (!entry) {
    entry = {
      listeners: new Set(),
      errorListeners: new Set(),
      refCount: 0,
    }
    streams.set(bookId, entry)
  }
  return entry
}

function mergeEventIntoHistory(history: AgentEvent[] | undefined, event: AgentEvent) {
  if (!history) return [event]

  const key = eventKey(event)
  if (history.some((item) => eventKey(item) === key)) return history

  return [event, ...history].slice(0, 200)
}

function eventKey(event: AgentEvent) {
  const detail =
    event.type === "stage-update"
      ? event.stage
      : event.type === "log"
        ? event.message
        : event.type === "token"
          ? event.text
          : event.type === "metric"
            ? `${event.key}:${event.value}`
            : JSON.stringify(event)
  return `${event.type}:${event.ts}:${detail}`
}
