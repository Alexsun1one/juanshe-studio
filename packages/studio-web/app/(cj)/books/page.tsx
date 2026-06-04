"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import {
  ArrowRight,
  Ban,
  Download,
  Hammer,
  Loader2,
  Pencil,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react"
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
  bookExportUrl,
  createBook,
  stopBookWorkflow,
  updateBook,
  validateBookFoundation,
  waitForBookCreateStatus,
} from "@/lib/api/client"
import type { BookSummary } from "@/lib/api/types"
import { ENDPOINTS } from "@/lib/api/types"
import { blockerLabels } from "@/lib/blocker-labels"
import { useWorkspace } from "@/lib/workspace-context"
import { getBookReadiness } from "@/lib/studio/book-readiness"
import { AgentPixel } from "@/components/design/agent-pixel"
import { EmptyArt } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import "./books.css"

// ── 经 BFF 调后端(沿用 client.ts「全部走 Next route handler」约定) ──────────
// create-states / create-cancel / DELETE books/:id 都已有 BFF route(app/api/v1/books/**),
// 这里直接打同源相对路径;其余写操作(建书/补地基/停止/改名/导出)走 lib/api/client。
async function bffFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  })
  const text = await res.text().catch(() => "")
  const payload = text ? safeJSON(text) : null
  if (!res.ok) {
    const message =
      (payload && typeof payload === "object"
        ? extractError(payload as Record<string, unknown>)
        : "") || `请求失败 (${res.status})`
    throw new Error(message)
  }
  return (payload ?? {}) as T
}

function extractError(payload: Record<string, unknown>): string {
  const err = payload.error
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message ?? "")
  }
  return ""
}

function safeJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ── 后端内存里的实时建书状态(server.ts: bookCreateStatus + isLiveBookCreateStatus) ──
// 单条形状与 components/shell/build-status-indicator.tsx 对齐;两处共用同一个 SWR key
// "books-create-states",从而共享一次轮询、一份缓存(不重复打后端)。
type CreateState = {
  bookId: string
  status: string | null
  stage: string | null
  agent: string | null
  agentLabel: string | null
  startedAt: number | null
  lastEventAt: number | null
  live: boolean
}

const fetchCreateStates = async (): Promise<CreateState[]> => {
  const json = await bffFetch<{ states?: CreateState[] }>(
    "/api/v1/books/create-states",
  )
  return Array.isArray(json.states) ? json.states : []
}

// ── 生命周期状态机:把"持久状态(book.creationStatus)+ 实时建书态"合一 ──────
type Lifecycle =
  | "creating-live" // 建书中(架构师在跑)
  | "creating-stuck" // 建书卡住(creating 但已无心跳)
  | "failed" // 建书失败
  | "needs-foundation" // 需补地基
  | "writing" // 写作中
  | "ready" // 就绪

type LifecycleMeta = {
  state: Lifecycle
  label: string
  /** 设计系统状态 pill 的 data-state(语义色只走状态) */
  tone: "running" | "warn" | "error" | "success"
  /** 该状态当前的责任角色像素 */
  agent: string
  /** 一行说明(克制,不做卡片) */
  hint: string
}

function resolveLifecycle(
  book: BookSummary,
  create: CreateState | undefined,
): LifecycleMeta {
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

function bookTitle(book: BookSummary): string {
  const t = book.title as unknown
  if (typeof t === "string") return t || book.id
  if (t && typeof t === "object" && "zh" in t) {
    const obj = t as { zh?: string; en?: string }
    return obj.zh || obj.en || book.id
  }
  return book.id
}

const fmtInt = (n: number | undefined | null) =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "0"

// 把每本书的真实规模(类目/章节/计划/字数/更新时间)整理成「一眼看清」的内联数据,
// 只用 BookSummary 已有字段,不编任何数字。章节用「已写/计划」如实呈现,不强算误导性百分比。
function bookScale(book: BookSummary) {
  const written = Math.max(
    Number.isFinite(book.currentChapter) ? book.currentChapter : 0,
    Number.isFinite(book.chapterCount) ? book.chapterCount : 0,
  )
  const planned = Number.isFinite(book.plannedChapters) ? book.plannedChapters : 0
  const kind =
    (book.kindLabel && (book.kindLabel.zh || book.kindLabel.en)) || ""
  return {
    kind,
    written,
    planned,
    words: Number.isFinite(book.totalWords) ? book.totalWords : 0,
    updatedAt: book.updatedAt,
  }
}

// 相对时间(克制):刚刚 / N 分钟 / N 小时 / N 天前,更久回落到日期。不编数据,纯展示。
function relTime(iso: string | undefined): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const diff = Date.now() - t
  if (diff < 0) return ""
  const min = Math.floor(diff / 60000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
}

type Busy = { id: string; kind: string } | null
type Confirm = {
  book: BookSummary
  kind: "cancel" | "delete-partial" | "delete"
} | null

export default function BooksPage() {
  const { books, bookId, setBookId, refreshBooks, upsertBook, booksLoading } =
    useWorkspace()
  const router = useRouter()

  // 实时建书态:与侧栏 BuildStatusIndicator 共用 key "books-create-states",
  // 共享一次轮询 / 一份缓存(避免两处各打一遍后端)。节奏沿用 3.5s。
  const { data: createStatesRaw } = useSWR<CreateState[]>(
    "books-create-states",
    fetchCreateStates,
    {
      refreshInterval: 3500,
      revalidateOnFocus: true,
      dedupingInterval: 1500,
      shouldRetryOnError: false,
      keepPreviousData: true,
    },
  )
  const createStates = React.useMemo(() => {
    const map = new Map<string, CreateState>()
    for (const s of createStatesRaw ?? []) {
      if (s && typeof s.bookId === "string") map.set(s.bookId, s)
    }
    return map
  }, [createStatesRaw])

  const [busy, setBusy] = React.useState<Busy>(null)
  const [confirm, setConfirm] = React.useState<Confirm>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [titleDraft, setTitleDraft] = React.useState("")

  const isBusy = (id: string, kind?: string) =>
    busy?.id === id && (kind ? busy.kind === kind : true)

  // ── 恢复操作 ──────────────────────────────────────────────────────────
  async function run(
    id: string,
    kind: string,
    fn: () => Promise<void>,
  ) {
    if (busy) return
    setBusy({ id, kind })
    try {
      await fn()
    } catch (e) {
      toast.error(`操作失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  // 取消在建:既有 create-cancel(经 BFF)
  async function cancelCreate(book: BookSummary) {
    await run(book.id, "cancel", async () => {
      await bffFetch(ENDPOINTS.bookCreateCancel(book.id), { method: "POST" })
      await refreshBooks()
      toast.success(`已取消《${bookTitle(book)}》的在建任务`)
    })
  }

  // 重试建书:复用既有建书入口(resumeExisting 让后端在半成品上原地续建)
  async function retryCreate(book: BookSummary) {
    await run(book.id, "retry", async () => {
      const title = bookTitle(book)
      const result = await createBook({ title, resumeExisting: true })
      toast.message(`正在重试建书《${title}》…`, {
        description: "架构师重新搭建地基,完成后会自动刷新。",
      })
      const final = await waitForBookCreateStatus(result.bookId, {
        runId: result.runId,
        timeoutMs: 120_000,
      })
      if (final.book) upsertBook(final.book)
      else await refreshBooks()
      if (final.status === "created") {
        setBookId(result.bookId)
        toast.success(`已重建《${title}》`)
      } else {
        throw new Error(
          final.failureReason || final.suggestion || final.error || `建书返回 ${final.status}`,
        )
      }
    })
  }

  // 补地基:走既有 foundation/validate 入口(会尝试自动修复地基)
  async function repairFoundation(book: BookSummary) {
    await run(book.id, "foundation", async () => {
      const res = await validateBookFoundation(book.id)
      await refreshBooks()
      if (res.ready) {
        toast.success(`《${bookTitle(book)}》地基已就绪`)
      } else {
        toast.message("地基仍有缺口", {
          description:
            blockerLabels(res.blockers).slice(0, 2).join(" · ") ||
            "请到大纲页补齐设定后再续写。",
        })
      }
    })
  }

  // 停止写作:既有 workflow/stop
  async function stopWriting(book: BookSummary) {
    await run(book.id, "stop", async () => {
      await stopBookWorkflow(book.id, "用户在作品列表停止")
      await refreshBooks()
      toast.success(`已停止《${bookTitle(book)}》的写作`)
    })
  }

  // 删除:既有 DELETE /books/:id(经 BFF)
  async function deleteBook(book: BookSummary) {
    await run(book.id, "delete", async () => {
      await bffFetch(ENDPOINTS.bookDetail(book.id), { method: "DELETE" })
      await refreshBooks()
      toast.success(`已删除《${bookTitle(book)}》`)
    })
  }

  function enter(book: BookSummary) {
    setBookId(book.id)
    router.push("/")
  }

  // 改名:既有 PATCH
  function startRename(book: BookSummary) {
    setEditingId(book.id)
    setTitleDraft(bookTitle(book))
  }
  async function saveRename(book: BookSummary) {
    const next = titleDraft.trim()
    if (!next) return
    await run(book.id, "rename", async () => {
      await updateBook(book.id, { title: next })
      await refreshBooks()
      setEditingId(null)
      toast.success(`已改名为《${next}》`)
    })
  }

  function onConfirm() {
    const c = confirm
    if (!c) return
    setConfirm(null)
    if (c.kind === "cancel") void cancelCreate(c.book)
    else void deleteBook(c.book)
  }

  // ── 概览计数(给焦点带内联数据条) ──────────────────────────────────────
  const rows = React.useMemo(
    () =>
      books.map((book) => ({
        book,
        meta: resolveLifecycle(book, createStates.get(book.id)),
      })),
    [books, createStates],
  )
  const counts = React.useMemo(() => {
    let needsAttention = 0
    let writing = 0
    let ready = 0
    let totalWords = 0
    let totalWritten = 0
    let totalPlanned = 0
    for (const { book, meta } of rows) {
      if (meta.state === "writing") writing += 1
      else if (meta.state === "ready") ready += 1
      else needsAttention += 1
      const s = bookScale(book)
      totalWords += s.words
      totalWritten += s.written
      totalPlanned += s.planned
    }
    return { needsAttention, writing, ready, totalWords, totalWritten, totalPlanned }
  }, [rows])

  // 需要你处理 / 最近更新:纯从已取数据派生(不新增请求),给 Inspector 折叠卡用。
  const attentionRows = React.useMemo(
    () => rows.filter(({ meta }) => meta.state !== "ready" && meta.state !== "writing"),
    [rows],
  )
  const recentRows = React.useMemo(() => {
    const ts = (iso: string | undefined) => {
      const t = iso ? new Date(iso).getTime() : NaN
      return Number.isFinite(t) ? t : 0
    }
    return [...rows].sort((a, b) => ts(b.book.updatedAt) - ts(a.book.updatedAt)).slice(0, 6)
  }, [rows])

  const libraryPct = counts.totalPlanned > 0
    ? Math.min(100, Math.round((counts.totalWritten / counts.totalPlanned) * 100))
    : 0
  const healthPct = books.length > 0
    ? Math.round(((counts.writing + counts.ready) / books.length) * 100)
    : 0

  return (
    <div className="cj-screen cj-books">
      {/* ── 顶部工作条:像素 + 标题 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead bk-head">
        <div className="bk-headline">
          <PixelBadge
            kind="library"
            size={44}
            className="bk-hero-pixel"
            ariaLabel="作品管理"
          />
          <div className="bk-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">作品管理</h1>
            </div>
            <div className="page-sub">
              每本作品的生命周期一目了然——建书中、卡住、失败、需补地基都能就地补救,无需进编辑器排查。
            </div>
          </div>
          <Link href="/" className="btn primary bk-head-cta">
            <span aria-hidden>+</span> 新建一本
          </Link>
        </div>
        <div className="bk-kpis" role="group" aria-label="作品概览">
          <KpiChip label="全部作品" value={books.length} unit="本" tone="brand" />
          <KpiChip
            label="待处理"
            value={counts.needsAttention}
            unit="本"
            tone={counts.needsAttention > 0 ? "warn" : "neutral"}
            hint="建书中断 / 卡住 / 失败 / 需补地基"
          />
          <KpiChip label="写作中" value={counts.writing} unit="本" tone="info" />
          <KpiChip
            label="就绪"
            value={counts.ready}
            unit="本"
            tone={counts.ready > 0 ? "ok" : "neutral"}
          />
          <KpiChip
            label="累计字数"
            value={fmtInt(counts.totalWords)}
            unit="字"
            tone="neutral"
            sub={<StatLine items={[{ n: fmtInt(counts.totalWritten), label: "章已写", tone: "brand" }]} />}
          />
        </div>
      </header>

      {/* ── 主体:作品列表(主区,pane 内滚) + 编辑部概览(Inspector)── */}
      <div className="cj-screen-body bk-body">
        <div className="cj-mainpane bk-mainpane">
          <div className="bk-mainpane-head">
            <span className="bk-mainpane-title">全部作品</span>
            {!booksLoading && books.length > 0 && (
              <StatLine
                className="bk-mainpane-stat"
                items={[
                  { n: books.length, label: "本" },
                  { n: fmtInt(counts.totalWritten), label: "章" },
                  { n: fmtInt(counts.totalWords), label: "字" },
                ]}
              />
            )}
          </div>
          <div className="cj-pane-scroll bk-pane-scroll">
            {booksLoading ? (
              <>
                <div className="bk-loading-stage">
                  <div className="bk-loading-art" aria-hidden>
                    <EmptyArt variant="books" />
                  </div>
                  <div>
                    <strong>正在清点作品书架</strong>
                    <span>本地书库读取中,先把登记台、台灯和稿纸铺好。</span>
                  </div>
                </div>
                <div className="bk-list bk-list-loading">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="skel" style={{ height: 54, borderRadius: "var(--r-lg)" }} />
                  ))}
                </div>
              </>
            ) : books.length === 0 ? (
              <div className="empty empty-lg editorial-empty bk-empty" data-empty-variant="books">
                <div className="empty-art">
                  <EmptyArt variant="books" />
                </div>
                <div className="empty-title">书架还在等第一本长卷</div>
                <div className="empty-desc">在工作台用「新建书」向导创建第一部作品,这里会汇总每本书的状态。</div>
                <div className="empty-actions">
                  <Link href="/" className="btn primary">
                    去工作台新建
                  </Link>
                </div>
              </div>
            ) : (
              <div className="bk-list">
                {rows.map(({ book, meta }) => {
                  const isActive = book.id === bookId
                  const rowBusy = isBusy(book.id)
                  const editing = editingId === book.id
                  const scale = bookScale(book)
                  return (
                    <div
                      key={book.id}
                      className={`bk-row${isActive ? " active" : ""}`}
                      data-state={meta.state}
                    >
                      <span className="bk-rail" style={{ background: book.accent }} aria-hidden />
                      <AgentPixel
                        id={meta.agent}
                        size={34}
                        className="bk-pixel"
                        ariaLabel={meta.label}
                      />

                      <div className="bk-main">
                        <div className="bk-titleline">
                          {editing ? (
                            <form
                              className="bk-rename"
                              onSubmit={(e) => {
                                e.preventDefault()
                                void saveRename(book)
                              }}
                            >
                              <input
                                autoFocus
                                value={titleDraft}
                                onChange={(e) => setTitleDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") setEditingId(null)
                                }}
                                aria-label="书名"
                              />
                              <button
                                type="submit"
                                className="bk-mini primary"
                                disabled={!titleDraft.trim() || isBusy(book.id, "rename")}
                              >
                                {isBusy(book.id, "rename") ? (
                                  <Loader2 size={13} className="spin" />
                                ) : (
                                  "保存"
                                )}
                              </button>
                              <button
                                type="button"
                                className="bk-mini"
                                onClick={() => setEditingId(null)}
                              >
                                取消
                              </button>
                            </form>
                          ) : (
                            <>
                              <span className="bk-title" title={bookTitle(book)}>
                                {bookTitle(book)}
                              </span>
                              <span className="pill" data-state={meta.tone}>
                                <span className="dot" />
                                {meta.label}
                              </span>
                              {isActive && <span className="bk-current">当前</span>}
                            </>
                          )}
                        </div>
                        {!editing && (
                          <div className="bk-sub">
                            <div className="bk-scale" aria-label="作品规模">
                              {scale.kind ? (
                                <span className="bk-kind">{scale.kind}</span>
                              ) : null}
                              <span
                                className="bk-chip"
                                title={
                                  scale.planned > 0
                                    ? `已写 ${scale.written} / 计划 ${scale.planned} 章`
                                    : `已写 ${scale.written} 章`
                                }
                              >
                                <b>{scale.written}</b>
                                {scale.planned > 0 ? <i>/ {scale.planned}</i> : null}
                                <em>章</em>
                              </span>
                              <span className="bk-dot" aria-hidden />
                              <span className="bk-chip">
                                <b>{fmtInt(scale.words)}</b>
                                <em>字</em>
                              </span>
                              {relTime(scale.updatedAt) ? (
                                <>
                                  <span className="bk-dot" aria-hidden />
                                  <span className="bk-upd">{relTime(scale.updatedAt)}</span>
                                </>
                              ) : null}
                            </div>
                            {meta.state !== "ready" && meta.state !== "writing" ? (
                              <div className="bk-hint" data-tone={meta.tone}>
                                {meta.hint}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>

                      {!editing && (
                        <div className="bk-acts">
                          {rowBusy && (
                            <Loader2 size={15} className="spin bk-busy" aria-label="处理中" />
                          )}
                          <RowActions
                            meta={meta}
                            busy={rowBusy}
                            onEnter={() => enter(book)}
                            onProgress={() => enter(book)}
                            onCancel={() => setConfirm({ book, kind: "cancel" })}
                            onRetry={() => void retryCreate(book)}
                            onFoundation={() => void repairFoundation(book)}
                            onStop={() => void stopWriting(book)}
                            onRename={() => startRename(book)}
                            onExport={() =>
                              window.open(
                                bookExportUrl(book.id, "txt"),
                                "_blank",
                                "noopener,noreferrer",
                              )
                            }
                            onDelete={() =>
                              setConfirm({
                                book,
                                kind:
                                  meta.state === "creating-stuck"
                                    ? "delete-partial"
                                    : "delete",
                              })
                            }
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Inspector:编辑部概览(状态构成 + 进度 + 需要你处理 + 最近更新)── */}
        <aside className="cj-inspector bk-inspector">
          <div className="cj-pane-scroll bk-insp-scroll">
            <section className="card bk-overview">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-title">编辑部概览</div>
                <Link href="/" className="card-action">去工作台 →</Link>
              </div>
              {books.length > 0 ? (
                <>
                  <div className="bk-meters">
                    <Meter
                      label="作品库进度"
                      value={counts.totalWritten}
                      max={Math.max(counts.totalPlanned, counts.totalWritten, 1)}
                      tone="brand"
                      showValue={false}
                    />
                    <div className="bk-meter-cap">
                      <span className="num">{fmtInt(counts.totalWritten)}</span>
                      <span className="bk-meter-of">
                        /{counts.totalPlanned > 0 ? fmtInt(counts.totalPlanned) : "—"} 章
                      </span>
                      <span className="bk-meter-pct">{libraryPct}%</span>
                    </div>
                    <Meter
                      label="活跃占比"
                      value={counts.writing + counts.ready}
                      max={Math.max(books.length, 1)}
                      tone="ok"
                      showValue={false}
                    />
                    <div className="bk-meter-cap">
                      <span className="num">{counts.writing + counts.ready}</span>
                      <span className="bk-meter-of">/{books.length} 本写作中/就绪</span>
                      <span className="bk-meter-pct">{healthPct}%</span>
                    </div>
                  </div>
                  <div className="bk-statgrid">
                    <span className="bk-stat" data-tone="warn">
                      <b className="num">{counts.needsAttention}</b>
                      <i>待处理</i>
                    </span>
                    <span className="bk-stat" data-tone="info">
                      <b className="num">{counts.writing}</b>
                      <i>写作中</i>
                    </span>
                    <span className="bk-stat" data-tone="ok">
                      <b className="num">{counts.ready}</b>
                      <i>就绪</i>
                    </span>
                  </div>
                </>
              ) : (
                <div className="bk-overview-empty">还没有作品,新建后这里会汇总整库状态。</div>
              )}
            </section>

            {attentionRows.length > 0 && (
              <FoldCard
                title="需要你处理"
                count={attentionRows.length}
                defaultOpen
                scrollable={attentionRows.length > 4}
                maxHeight={208}
              >
                <div className="bk-mini-list">
                  {attentionRows.map(({ book, meta }) => (
                    <button
                      key={book.id}
                      type="button"
                      className="bk-mini-row"
                      data-tone={meta.tone}
                      onClick={() => enter(book)}
                      title={meta.hint}
                    >
                      <AgentPixel id={meta.agent} size={24} ariaLabel={meta.label} className="bk-mini-pixel" />
                      <span className="bk-mini-body">
                        <span className="bk-mini-title">{bookTitle(book)}</span>
                        <span className="bk-mini-hint">{meta.hint}</span>
                      </span>
                      <span className="pill" data-state={meta.tone}>
                        <span className="dot" />
                        {meta.label}
                      </span>
                    </button>
                  ))}
                </div>
              </FoldCard>
            )}

            {recentRows.length > 0 && (
              <FoldCard
                title="最近更新"
                count={recentRows.length}
                defaultOpen={attentionRows.length === 0}
                scrollable={recentRows.length > 4}
                maxHeight={208}
              >
                <div className="bk-mini-list">
                  {recentRows.map(({ book, meta }) => {
                    const s = bookScale(book)
                    return (
                      <button
                        key={book.id}
                        type="button"
                        className="bk-mini-row"
                        onClick={() => enter(book)}
                        title={`进入《${bookTitle(book)}》`}
                      >
                        <span className="bk-mini-rail" style={{ background: book.accent }} aria-hidden />
                        <span className="bk-mini-body">
                          <span className="bk-mini-title">{bookTitle(book)}</span>
                          <span className="bk-mini-meta">
                            <span className="num">{s.written}</span>
                            <em>章</em>
                            <span className="bk-dot" aria-hidden />
                            <span className="num">{fmtInt(s.words)}</span>
                            <em>字</em>
                            {relTime(s.updatedAt) ? (
                              <>
                                <span className="bk-dot" aria-hidden />
                                <span className="bk-mini-upd">{relTime(s.updatedAt)}</span>
                              </>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </FoldCard>
            )}
          </div>
        </aside>
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "cancel"
                ? "取消正在进行的建书?"
                : confirm?.kind === "delete-partial"
                  ? "删除这本半成品?"
                  : "删除这本作品?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>
                {confirm?.kind === "cancel"
                  ? "会中止架构师的建书任务并释放写锁,已生成的半成品会保留,可稍后重试或删除。"
                  : "会删除该作品目录下的全部章节、设定与历史记录,删除后不可撤销。确认前不会发起请求。"}
              </span>
              {confirm && (
                <span className="rounded-md border bg-muted/50 px-3 py-2 text-foreground">
                  {bookTitle(confirm.book)}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={busy !== null}>
              {confirm?.kind === "cancel" ? "继续建书" : "保留作品"}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={busy !== null}
              onClick={(e) => {
                e.preventDefault()
                onConfirm()
              }}
            >
              {confirm?.kind === "cancel" ? "确认取消" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── 每个状态对应的内联恢复动作(紧凑文字按钮,非大按钮堆) ──────────────────
function RowActions({
  meta,
  busy,
  onEnter,
  onProgress,
  onCancel,
  onRetry,
  onFoundation,
  onStop,
  onRename,
  onExport,
  onDelete,
}: {
  meta: LifecycleMeta
  busy: boolean
  onEnter: () => void
  onProgress: () => void
  onCancel: () => void
  onRetry: () => void
  onFoundation: () => void
  onStop: () => void
  onRename: () => void
  onExport: () => void
  onDelete: () => void
}) {
  switch (meta.state) {
    case "creating-live":
      return (
        <>
          <Act icon={<ArrowRight size={13} />} onClick={onProgress} disabled={busy}>
            看进度
          </Act>
          <Act icon={<Ban size={13} />} tone="warn" onClick={onCancel} disabled={busy}>
            取消在建
          </Act>
        </>
      )
    case "creating-stuck":
      return (
        <>
          <Act icon={<Ban size={13} />} onClick={onCancel} disabled={busy}>
            取消在建
          </Act>
          <Act icon={<RotateCcw size={13} />} onClick={onRetry} disabled={busy}>
            重试
          </Act>
          <Act icon={<Trash2 size={13} />} tone="danger" onClick={onDelete} disabled={busy}>
            删半成品
          </Act>
        </>
      )
    case "failed":
      return (
        <>
          <Act icon={<RotateCcw size={13} />} onClick={onRetry} disabled={busy}>
            重试
          </Act>
          <Act icon={<Hammer size={13} />} onClick={onFoundation} disabled={busy}>
            补地基
          </Act>
          <Act icon={<Trash2 size={13} />} tone="danger" onClick={onDelete} disabled={busy}>
            删除
          </Act>
        </>
      )
    case "needs-foundation":
      return (
        <>
          <Act icon={<Hammer size={13} />} onClick={onFoundation} disabled={busy}>
            补地基
          </Act>
          <Act icon={<RotateCcw size={13} />} onClick={onRetry} disabled={busy}>
            重试
          </Act>
          <Act icon={<Trash2 size={13} />} tone="danger" onClick={onDelete} disabled={busy}>
            删除
          </Act>
        </>
      )
    case "writing":
      return (
        <>
          <Act icon={<ArrowRight size={13} />} onClick={onEnter} disabled={busy}>
            进入
          </Act>
          <Act icon={<Square size={13} />} tone="warn" onClick={onStop} disabled={busy}>
            停止
          </Act>
        </>
      )
    default: // ready
      return (
        <>
          <Act icon={<ArrowRight size={13} />} primary onClick={onEnter} disabled={busy}>
            进入
          </Act>
          <IconAct title="改名" onClick={onRename} disabled={busy}>
            <Pencil size={14} />
          </IconAct>
          <IconAct title="导出 TXT" onClick={onExport} disabled={busy}>
            <Download size={14} />
          </IconAct>
          <IconAct title="删除" tone="danger" onClick={onDelete} disabled={busy}>
            <Trash2 size={14} />
          </IconAct>
        </>
      )
  }
}

function Act({
  children,
  icon,
  onClick,
  disabled,
  tone,
  primary,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: "warn" | "danger"
  primary?: boolean
}) {
  return (
    <button
      type="button"
      className={`bk-act${primary ? " primary" : ""}${tone ? ` ${tone}` : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      {children}
    </button>
  )
}

function IconAct({
  children,
  title,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
  disabled?: boolean
  tone?: "danger"
}) {
  return (
    <button
      type="button"
      className={`bk-ic${tone ? ` ${tone}` : ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}
