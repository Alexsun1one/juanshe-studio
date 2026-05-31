"use client"

import * as React from "react"
import {
  BookOpenText,
  Cat,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Sparkles,
  Wand2,
} from "lucide-react"

import { fetchBooks } from "@/lib/api/client"
import { ENDPOINTS, type BookSummary } from "@/lib/api/types"
import { isLikelyTestBook, pickPreferredBook } from "@/lib/workspace-context"
import { Badge } from "@/components/ui/badge"
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
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { useAgentActivity } from "@/lib/use-agent-activity"
import { agentDisplayName } from "@/lib/labels"

type JsonRecord = Record<string, unknown>
type LoadState = "loading" | "ready" | "error"

type ChatMessage = {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt: string
}

type AssistantConfirmAction = {
  title: string
  description: string
  detail: string
  confirmLabel: string
  run: () => Promise<void>
}

export function AssistantConsole({
  seedInstruction = "",
  compact = false,
  hideHeader = false,
}: {
  /** 外部（如底部常驻对话栏）带入的初始指令文本 */
  seedInstruction?: string
  /** 紧凑模式：只留对话本体，隐藏工作对象/快照/会话列表/大标题等管理噪音 */
  compact?: boolean
  /** 隐藏对话台内部大标题（页面已有自己的标题时用，省垂直空间） */
  hideHeader?: boolean
} = {}) {
  const { toast } = useToast()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [books, setBooks] = React.useState<BookSummary[]>([])
  const [booksState, setBooksState] = React.useState<LoadState>("loading")
  const [selectedBookId, setSelectedBookId] = React.useState("")
  const [sessions, setSessions] = React.useState<unknown[]>([])
  const [sessionsState, setSessionsState] = React.useState<LoadState>("loading")
  const [sessionId, setSessionId] = React.useState("")
  const [instruction, setInstruction] = React.useState(seedInstruction)
  React.useEffect(() => {
    if (seedInstruction) setInstruction(seedInstruction)
  }, [seedInstruction])
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  // 真实进度:复用剧场那套事件流。猫委托子智能体(审稿官/写手…)时,这里反映它们的真实活动;
  // 加一个真实计时器,让等待期间界面是"动的、真的",而不是干瞪眼以为挂了。
  const activity = useAgentActivity(selectedBookId)
  const sending = busy === "agent:send"
  const [sendElapsed, setSendElapsed] = React.useState(0)
  React.useEffect(() => {
    if (!sending) { setSendElapsed(0); return }
    const startedAt = Date.now()
    const t = setInterval(() => setSendElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(t)
  }, [sending])
  const [context, setContext] = React.useState<unknown>(null)
  const [contextState, setContextState] = React.useState<LoadState>("loading")
  const [lastResult, setLastResult] = React.useState<unknown>(null)
  const [confirmAction, setConfirmAction] =
    React.useState<AssistantConfirmAction | null>(null)

  React.useEffect(() => {
    void loadBooks()
    void loadContext()
  }, [])

  React.useEffect(() => {
    if (selectedBookId) {
      void loadSessions(selectedBookId)
      return
    }
    if (booksState === "ready") {
      setSessions([])
      setSessionId("")
      setSessionsState("ready")
    }
  }, [booksState, selectedBookId])

  async function loadBooks() {
    setBooksState("loading")
    try {
      const rows = await fetchBooks()
      setBooks(rows)
      setBooksState("ready")
      setSelectedBookId((current) => {
        const currentBook = rows.find((book) => book.id === current)
        if (currentBook && !isLikelyTestBook(currentBook)) return currentBook.id
        return pickPreferredBook(rows)?.id ?? currentBook?.id ?? ""
      })
    } catch (error) {
      setBooksState("error")
      toast({
        title: "作品列表读取失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    }
  }

  async function loadContext() {
    setContextState("loading")
    try {
      const data = await requestJSON(ENDPOINTS.interactionSession())
      setContext(data)
      setContextState("ready")
      const record = toRecord(data)
      const activeBookId = stringField(record?.activeBookId)
      if (activeBookId) {
        setSelectedBookId((current) => current || activeBookId)
      }
      const session = toRecord(record?.session)
      const id = sessionIdFrom(session)
      if (id) setSessionId(id)
    } catch {
      setContext(null)
      setContextState("error")
    }
  }

  async function loadSessions(bookId = selectedBookId) {
    setSessionsState("loading")
    setBusy("sessions:load")
    try {
      const data = await requestJSON(ENDPOINTS.sessions(bookId || undefined))
      const rows = pickArray(data, ["sessions", "items"])
      setSessions(rows)
      setSessionsState("ready")
      setSessionId((current) => current || sessionIdFrom(rows[0]) || "")
    } catch (error) {
      setSessionsState("error")
      toast({
        title: "会话列表读取失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  function requestCreateSession() {
    if (!selectedBookId) {
      toast({
        title: "请先选择作品",
        description: "互动助手需要一个当前作品来建立上下文。",
        variant: "destructive",
      })
      return
    }
    const book = books.find((item) => item.id === selectedBookId)
    const targetBookId = selectedBookId
    setConfirmAction({
      title: "创建新的助手会话？",
      description:
        "这会向后端写入一个绑定当前作品的新互动会话，用于保存后续 Agent 对话上下文。",
      detail: book
        ? `目标作品：${bookTitle(book)}`
        : `目标作品 ID：${targetBookId}`,
      confirmLabel: "确认创建",
      run: () => executeCreateSession(targetBookId),
    })
  }

  async function executeCreateSession(bookId: string) {
    setBusy("sessions:create")
    try {
      const data = await requestJSON(ENDPOINTS.sessions(), {
        method: "POST",
        body: JSON.stringify({ bookId }),
      })
      setLastResult(data)
      const id = sessionIdFrom(toRecord(data)?.session) || sessionIdFrom(data)
      if (id) setSessionId(id)
      toast({ title: "新会话已创建" })
      await loadSessions(bookId)
    } catch (error) {
      toast({
        title: "创建会话失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  async function openSession(id: string) {
    if (!id) return
    setBusy(`sessions:${id}`)
    try {
      const data = await requestJSON(ENDPOINTS.session(id))
      setSessionId(id)
      setLastResult(data)
      const rows = pickArray(data, ["messages", "turns"])
      if (rows.length > 0) {
        setMessages(rows.map((row, index) => messageFromUnknown(row, index)))
      }
    } catch (error) {
      toast({
        title: "会话详情读取失败",
        description: errorMessage(error),
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  async function sendInstruction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = instruction.trim()
    if (!text) return
    if (!selectedBookId) {
      toast({
        title: "请先选择作品",
        description: "发送给助手前需要绑定当前作品，避免会话写到错误上下文。",
        variant: "destructive",
      })
      return
    }
    const book = books.find((item) => item.id === selectedBookId)
    const targetBookId = selectedBookId
    const targetSessionId = sessionId
    setConfirmAction({
      title: "发送给 AI 助手？",
      description:
        "这会调用后端 Agent 对话接口，可能读取作品上下文、消耗 LLM token，并把本轮对话写入会话。",
      detail: [
        book ? `作品：${bookTitle(book)}` : `作品 ID：${targetBookId}`,
        targetSessionId ? `会话：${targetSessionId}` : "会话：后端将自动创建或绑定",
        `指令：${text}`,
      ].join("\n"),
      confirmLabel: "确认发送",
      run: () => executeSendInstruction(text, targetBookId, targetSessionId),
    })
  }

  async function executeSendInstruction(
    text: string,
    bookId: string,
    activeSessionId: string,
  ) {
    const now = new Date().toISOString()
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: now,
    }
    setInstruction((current) => (current.trim() === text ? "" : current))
    setMessages((current) => [...current, userMessage])
    setBusy("agent:send")
    try {
      const data = await requestJSON(ENDPOINTS.agentChat(), {
        method: "POST",
        body: JSON.stringify({
          instruction: text,
          activeBookId: bookId || undefined,
          sessionId: activeSessionId || undefined,
        }),
      })
      setLastResult(data)
      const record = toRecord(data)
      const session = toRecord(record?.session)
      const nextSessionId = sessionIdFrom(session)
      if (nextSessionId) setSessionId(nextSessionId)
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: assistantText(data),
          createdAt: new Date().toISOString(),
        },
      ])
      await loadSessions(bookId)
    } catch (error) {
      const message = errorMessage(error)
      setMessages((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          role: "system",
          content: message,
          createdAt: new Date().toISOString(),
        },
      ])
      toast({
        title: "AI 助手请求失败",
        description: message,
        variant: "destructive",
      })
    } finally {
      setBusy(null)
    }
  }

  async function runConfirmedAction() {
    const action = confirmAction
    if (!action) return
    setConfirmAction(null)
    await action.run()
  }

  const selectedBook = books.find((book) => book.id === selectedBookId)
  const sendDisabled =
    busy === "agent:send" ||
    !instruction.trim() ||
    !selectedBookId ||
    booksState === "loading"

  return (
    <section
      className={
        compact
          ? "assistant-console-shell flex min-h-0 flex-1 flex-col"
          : "assistant-console-shell grid min-h-0 min-w-0 flex-1 gap-5 px-3 py-4 sm:px-6 sm:py-6 md:px-10 xl:grid-cols-[320px_minmax(0,1fr)]"
      }
    >
      {!compact && (
      <aside className="min-w-0 space-y-4">
        <div className="border-border/50 bg-card/35 min-w-0 rounded-lg border p-4">
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
            <Sparkles className="size-3.5" />
            工作对象
          </div>
          <h2 className="text-foreground mt-1 text-base font-semibold">
            正在改哪本书
          </h2>
          <div className="mt-4 grid min-w-0 gap-3">
            <label className="grid min-w-0 gap-1.5">
              <span className="text-muted-foreground text-xs">目标作品</span>
              <select
                value={selectedBookId}
                onChange={(event) => {
                  const id = event.target.value
                  setSelectedBookId(id)
                  void loadSessions(id)
                }}
                className="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full min-w-0 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                disabled={booksState === "loading" || books.length === 0}
              >
                {books.length === 0 ? (
                  <option value="">{bookSelectPlaceholder(booksState)}</option>
                ) : (
                  books.map((book) => (
                    <option key={book.id} value={book.id}>
                      {bookTitle(book)}
                    </option>
                  ))
                )}
              </select>
            </label>
            <div className="border-border/40 bg-background/70 min-w-0 rounded-lg border p-3">
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <BookOpenText className="size-3.5" />
                作品快照
              </div>
              <div className="text-foreground mt-2 text-sm font-medium">
                {selectedBook ? bookTitle(selectedBook) : "未选择作品"}
              </div>
              <div className="text-muted-foreground mt-1 text-xs">
                {selectedBook
                  ? `${selectedBook.chapterCount} 章 · ${selectedBook.totalWords.toLocaleString("zh-CN")} 字`
                  : "读取作品后会自动绑定上下文。"}
              </div>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void loadContext()}
              >
                <RefreshCw className="size-4" />
                刷新上下文
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={requestCreateSession}
                disabled={
                  busy === "sessions:create" ||
                  !selectedBookId ||
                  booksState === "loading"
                }
              >
                {busy === "sessions:create" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <MessageSquarePlus className="size-4" />
                )}
                新会话
              </Button>
            </div>
          </div>
        </div>

        <div className="border-border/50 bg-card/35 min-w-0 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-foreground text-sm font-semibold">会话</h2>
            <Badge variant="secondary">{sessions.length}</Badge>
          </div>
          <div className="mt-3 max-h-[420px] space-y-2 overflow-auto pr-1">
            {sessionsState === "loading" ? (
              <p className="text-muted-foreground text-xs">
                正在读取当前作品的会话...
              </p>
            ) : sessionsState === "error" ? (
              <p className="text-destructive text-xs">
                会话列表读取失败，请刷新或检查后端。
              </p>
            ) : sessions.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                暂无会话。创建会话后，助手会把讨论绑定到当前作品。
              </p>
            ) : (
              sessions.map((session, index) => {
                const id = sessionIdFrom(session)
                const active = id === sessionId
                return (
                  <button
                    key={id || index}
                    type="button"
                    className={[
                      "border-border/40 hover:bg-secondary/60 w-full rounded-lg border px-3 py-2 text-left transition-colors",
                      active ? "bg-secondary/70" : "bg-background/70",
                    ].join(" ")}
                    onClick={() => void openSession(id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground min-w-0 truncate text-sm font-medium">
                        {sessionTitle(session)}
                      </span>
                      {active && <Badge variant="secondary">当前</Badge>}
                    </div>
                    <div className="text-muted-foreground mt-1 truncate text-[11px]">
                      {sessionMeta(session)}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </aside>
      )}

      <div
        className={
          compact
            ? "flex min-h-0 flex-1 flex-col"
            : "assistant-chat-shell border-border/50 bg-card/35 flex min-h-[680px] min-w-0 flex-col rounded-lg border"
        }
      >
        {!compact && !hideHeader && (
        <header className="border-border/40 flex flex-wrap items-start justify-between gap-3 border-b p-5">
          <div>
            <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
              <Cat className="size-3.5" />
              编辑部的猫
            </div>
            <h2 className="text-foreground mt-1 text-lg font-semibold">
              和编辑部的猫说说
            </h2>
            <p className="text-muted-foreground mt-1 max-w-2xl text-xs leading-5">
              大白话说你想怎么改——这一章、整本书、大纲、文风都行。小事猫自己顺手办，要正经动笔的大事（写新章、整章重写、审稿），它去叫醒对应的编辑。
            </p>
          </div>
          <Badge variant={sessionId ? "secondary" : "outline"}>
            {sessionId ? "对话进行中" : "尚未开始对话"}
          </Badge>
        </header>
        )}

        <div className={compact ? "min-h-0 flex-1 overflow-auto p-3" : "min-h-0 flex-1 overflow-auto p-5"}>
          {messages.length === 0 ? (
            compact ? (
              <p className="text-muted-foreground px-1 py-2 text-xs leading-5">
                例如：“帮我检查第 25 章有没有 AI 痕迹风险，并给出可直接改写的三处建议。”
              </p>
            ) : (
              <div className="assistant-empty-card border-border/40 flex h-full min-h-[180px] flex-col items-center justify-center rounded-2xl border p-6 text-center">
                <img
                  className="assistant-empty-prop"
                  src="/brand/props/assistant-desk.webp"
                  alt=""
                  width={360}
                  height={283}
                  draggable={false}
                />
                <h3 className="text-foreground mt-4 text-base font-semibold">
                  跟猫说一句，它就开干
                </h3>
                <p className="text-muted-foreground mx-auto mt-2 max-w-xl text-sm leading-6">
                  例如：“帮我检查第 25 章有没有 AI 痕迹风险，并给出可直接改写的三处建议。”
                </p>
              </div>
            )
          ) : (
            <div className="space-y-3">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
              {sending && (
                <CatWorkingCard
                  elapsed={sendElapsed}
                  live={activity.live}
                  agentId={activity.currentAgentId}
                  text={activity.currentText}
                />
              )}
            </div>
          )}
        </div>

        <form
          onSubmit={sendInstruction}
          className={
            compact
              ? "border-border shrink-0 border-t p-3"
              : "border-border/40 border-t p-5"
          }
        >
          <Textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            className={
              compact
                ? "min-h-[44px] max-h-[120px] resize-none"
                : "min-h-[108px] resize-none"
            }
            placeholder="跟猫说一句你想怎么改，例如：总结当前作品风险、生成改写计划、检查某一章的文风一致性..."
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-muted-foreground text-xs">
              {contextStatusText(contextState, Boolean(context))}
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={sendDisabled}
            >
              {busy === "agent:send" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              发送
            </Button>
          </div>
        </form>

        {lastResult ? (
          <details className="border-border/40 border-t px-5 py-4">
            <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
              最近一次原始响应
            </summary>
            <pre className="text-muted-foreground mt-3 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.03] p-3 font-mono text-[11px] leading-5 dark:bg-white/[0.04]">
              {JSON.stringify(lastResult, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.title ?? "确认助手动作？"}
            </AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>{confirmAction?.description}</span>
              <span className="border-border/50 bg-secondary/45 whitespace-pre-wrap rounded-md border px-3 py-2 font-mono text-[11px] leading-5 text-foreground">
                {confirmAction?.detail}
              </span>
              <span>确认前不会创建会话、发送 Agent 请求或写入对话记录。</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={Boolean(busy)}>
              保持当前状态
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(busy)}
              onClick={(event) => {
                event.preventDefault()
                void runConfirmedAction()
              }}
            >
              {confirmAction?.confirmLabel ?? "确认执行"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** 猫干活时的真实进度卡:子智能体活动(审稿官/写手…)+ 真实计时器。绝不编假进度。 */
function CatWorkingCard({ elapsed, live, agentId, text }: { elapsed: number; live: boolean; agentId?: string; text?: string }) {
  const mm = Math.floor(elapsed / 60)
  const ss = String(elapsed % 60).padStart(2, "0")
  const status = live && agentId
    ? (text?.trim() ? `${agentDisplayName(agentId)}正在${text.trim()}` : `正在叫醒${agentDisplayName(agentId)}…`)
    : "正在读当前作品、琢磨怎么动手…"
  return (
    <article className="border-border/45 bg-background/70 rounded-lg border p-4">
      <div className="text-muted-foreground flex items-center gap-3 text-[11px]">
        <span className="flex items-center gap-1"><Cat className="size-3" /> 编辑部的猫</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-1.5 animate-pulse rounded-full" style={{ background: "var(--brand-500)" }} />
          忙活中
        </span>
        <span className="ml-auto tabular-nums">已等 {mm}:{ss}</span>
      </div>
      <div className="text-foreground mt-2 flex items-center gap-2 text-sm">
        <Loader2 className="size-4 shrink-0 animate-spin opacity-70" />
        <span className="truncate">{status}</span>
      </div>
    </article>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user"
  return (
    <article
      className={[
        "max-w-[860px] rounded-lg border p-4",
        isUser
          ? "border-primary/20 bg-primary/8 ml-auto"
          : message.role === "assistant"
            ? "border-border/45 bg-background/70"
            : "border-destructive/25 bg-destructive/8",
      ].join(" ")}
    >
      <div className="text-muted-foreground flex items-center justify-between gap-3 text-[11px]">
        <span className="flex items-center gap-1">
          {isUser ? "你" : message.role === "assistant" ? <><Cat className="size-3" /> 编辑部的猫</> : "系统"}
        </span>
        <time>{formatTime(message.createdAt)}</time>
      </div>
      <div className="text-foreground mt-2 whitespace-pre-wrap text-sm leading-6">
        {message.content}
      </div>
    </article>
  )
}

async function requestJSON<T = unknown>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has("accept")) headers.set("accept", "application/json")
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  const response = await fetch(url, {
    ...init,
    headers,
    cache: "no-store",
  })
  const text = await response.text()
  const data = text ? parseJSON(text) : {}
  if (!response.ok) {
    throw new Error(extractError(data) || `HTTP ${response.status}`)
  }
  return data as T
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

function pickArray(data: unknown, keys: string[]) {
  if (Array.isArray(data)) return data
  const record = toRecord(data)
  if (!record) return []
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  const session = toRecord(record.session)
  if (session) {
    for (const key of keys) {
      const value = session[key]
      if (Array.isArray(value)) return value
    }
  }
  return []
}

function messageFromUnknown(value: unknown, index: number): ChatMessage {
  const record = toRecord(value)
  const role = stringField(record?.role)
  return {
    id: stringField(record?.id) || `message-${index}`,
    role: role === "user" || role === "assistant" ? role : "system",
    content:
      stringField(record?.content) ||
      stringField(record?.text) ||
      stringField(record?.message) ||
      JSON.stringify(value, null, 2),
    createdAt: stringField(record?.createdAt) || stringField(record?.timestamp),
  }
}

function assistantText(data: unknown) {
  const record = toRecord(data)
  return (
    stringField(record?.response) ||
    stringField(record?.message) ||
    extractError(data) ||
    JSON.stringify(data, null, 2)
  )
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : ""
}

function sessionIdFrom(value: unknown) {
  const record = toRecord(value)
  return (
    stringField(record?.sessionId) ||
    stringField(record?.id) ||
    stringField(record?.uuid)
  )
}

function sessionTitle(value: unknown) {
  const record = toRecord(value)
  return (
    stringField(record?.title) ||
    stringField(record?.name) ||
    sessionIdFrom(value) ||
    "未命名会话"
  )
}

function sessionMeta(value: unknown) {
  const record = toRecord(value)
  const updated = stringField(record?.updatedAt) || stringField(record?.createdAt)
  const count = Number(record?.messageCount ?? record?.messagesCount ?? 0)
  return [updated ? formatTime(updated) : "", count ? `${count} 条消息` : ""]
    .filter(Boolean)
    .join(" · ")
}

function bookTitle(book: BookSummary) {
  return book.title.zh || book.title.en || book.id
}

function formatTime(value: string) {
  if (!value) return "刚刚"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function bookSelectPlaceholder(state: LoadState) {
  if (state === "loading") return "作品加载中..."
  if (state === "error") return "作品读取失败"
  return "暂无作品"
}

function contextStatusText(state: LoadState, hasContext: boolean) {
  if (state === "loading") return "正在读取互动上下文"
  if (hasContext) return "已读取互动上下文"
  if (state === "error") return "互动上下文暂不可用，发送时会显示后端错误"
  return "后端不可用时会在这里显示请求错误"
}

function extractError(data: unknown) {
  const record = toRecord(data)
  if (!record) return ""
  if (typeof record.error === "string") return record.error
  const nested = toRecord(record.error)
  if (typeof nested?.message === "string") return nested.message
  if (typeof record.message === "string") return record.message
  return ""
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
