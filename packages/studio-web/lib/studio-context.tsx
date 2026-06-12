"use client"

import * as React from "react"
import {
  ArrowRight,
  Compass,
  Flame,
  Heart,
  Loader2,
  Pencil,
  PenLine,
  ScanSearch,
  Sparkles,
  Theater,
  Wand2,
} from "lucide-react"
import { EDITORIAL_STAFF_COUNT } from "@/lib/agent-identity"
import { useWorkspace } from "@/lib/workspace-context"

const ONBOARDING_GENRES = [
  { id: "xianxia", icon: Compass, label: "玄幻修真" },
  { id: "scifi", icon: Sparkles, label: "科幻悬疑" },
  { id: "urban", icon: Theater, label: "都市言情" },
  { id: "history", icon: Pencil, label: "历史架空" },
  { id: "game", icon: Flame, label: "游戏竞技" },
  { id: "romance", icon: Heart, label: "情感治愈" },
] as const

const ONBOARDING_PILLARS = [
  { icon: PenLine, title: "写", desc: "多智能体自主成稿" },
  { icon: ScanSearch, title: "审", desc: "质量门控逐章把关" },
  { icon: Wand2, title: "改", desc: "按你的反馈精修" },
] as const

// ----------------------------------------------------------------------
// 全局工作台状态：模式 / 面板折叠 / 全屏 / AI 运行态
// ----------------------------------------------------------------------

export type StudioMode =
  | "new"
  | "outline"
  | "write"
  | "rewrite"
  | "review"
  | "publish"

export type AiState = "idle" | "running" | "paused"

type Ctx = {
  /** 当前在编辑的书 ID */
  bookId: string
  /** 当前激活章节号（write/review/rewrite 模式作用对象） */
  currentChapter: number
  /** 用户显式点选的章节；null 表示跟随当前书籍/运行态 */
  selectedChapter: number | null
  setCurrentChapter: (chapter: number) => void

  mode: StudioMode
  setMode: (m: StudioMode) => void

  leftCollapsed: boolean
  rightCollapsed: boolean
  dockExpanded: boolean
  focusMode: boolean

  /** 左/右栏当前像素宽度（拖拽可变，已持久化到 localStorage） */
  leftWidth: number
  rightWidth: number
  setLeftWidth: (v: number) => void
  setRightWidth: (v: number) => void

  toggleLeft: () => void
  toggleRight: () => void
  toggleDock: () => void
  toggleFocus: () => void
  setLeft: (v: boolean) => void
  setRight: (v: boolean) => void

  ai: AiState
  setAi: (s: AiState) => void

}

const StudioCtx = React.createContext<Ctx | null>(null)

/** 左右栏宽度边界 — desktop-style 可拖拽细栏 */
// 区域分布：参考设计工具中"中央"是绝对主角，两侧细。
// 收窄默认侧栏宽度，让写作画布更主导（仍可拖拽到 min/max）。
export const RAIL_BOUNDS = {
  left: { min: 200, max: 420, def: 232 },
  right: { min: 280, max: 560, def: 312 },
} as const

const clampRail = (v: number, side: "left" | "right") => {
  const b = RAIL_BOUNDS[side]
  if (!Number.isFinite(v)) return b.def
  return Math.min(b.max, Math.max(b.min, Math.round(v)))
}

function EmptyBookState() {
  const { refreshBooks, upsertBook } = useWorkspace()
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [genreId, setGenreId] = React.useState<string>("xianxia")

  const selectedGenre =
    ONBOARDING_GENRES.find((g) => g.id === genreId) ?? ONBOARDING_GENRES[0]

  async function handleCreate() {
    if (creating) return
    setCreating(true)
    setError("")
    try {
      const res = await fetch("/api/v1/books", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          title: title.trim() || "我的第一本书",
          genre: selectedGenre.label,
          language: "zh",
          targetWordsPerChapter: 3000,
          plannedChapters: 10,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        setError(text || `创建失败 (${res.status})`)
        return
      }
      const result = await res.json()
      if (result.bookId || result.id) {
        const books = await refreshBooks()
        const created = books.find((b) => b.id === (result.bookId || result.id))
        if (created) upsertBook(created)
      } else {
        await refreshBooks()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="bg-background text-foreground relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-12">
      {/* 环境光 — 极克制的氛围层 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(900px 460px at 50% -8%, color-mix(in oklab, var(--primary) 16%, transparent), transparent 70%), radial-gradient(700px 420px at 88% 108%, color-mix(in oklab, var(--purple) 13%, transparent), transparent 70%)",
        }}
      />

      <div className="animate-rise-in flex w-full max-w-[560px] flex-col items-center">
        {/* 品牌 */}
        <div className="ring-border bg-card flex size-14 items-center justify-center overflow-hidden rounded-2xl shadow-pop ring-1">
          <img
            src="/juanshe-logo.svg"
            alt=""
            className="size-full"
            draggable={false}
          />
        </div>
        <h1 className="text-foreground mt-5 text-center text-[28px] font-bold leading-tight tracking-tight">
          开启你的第一部长卷
        </h1>
        <p className="text-muted-foreground mt-2 max-w-[420px] text-center text-[14px] leading-relaxed">
          本地优先的 AI 协同长篇创作工作台 ——
          多智能体替你成稿、把关、精修，你始终掌控全局。
        </p>

        {/* 三柱价值 */}
        <div className="mt-7 grid w-full grid-cols-3 gap-2.5">
          {ONBOARDING_PILLARS.map((p) => (
            <div
              key={p.title}
              className="bg-card border-border flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3.5 text-center shadow-card"
            >
              <p.icon
                className="text-primary size-[18px]"
                strokeWidth={2}
                aria-hidden
              />
              <div className="text-foreground text-[15px] font-bold">
                {p.title}
              </div>
              <div className="text-muted-foreground text-[11px] leading-tight">
                {p.desc}
              </div>
            </div>
          ))}
        </div>

        {/* 快速建书卡 */}
        <div className="bg-card border-border mt-5 w-full rounded-2xl border p-5 shadow-pop">
          <label
            htmlFor="onboarding-title"
            className="text-foreground text-[13px] font-semibold"
          >
            作品名
          </label>
          <input
            id="onboarding-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate()
            }}
            placeholder="留空将以「我的第一本书」开始"
            autoComplete="off"
            className="border-input bg-background text-foreground placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-ring/40 mt-2 h-10 w-full rounded-lg border px-3 text-[14px] outline-none transition-shadow focus-visible:ring-[3px]"
          />

          <div className="text-foreground mt-4 mb-2 text-[13px] font-semibold">
            选择题材
          </div>
          <div
            role="radiogroup"
            aria-label="选择题材"
            className="grid grid-cols-3 gap-2"
          >
            {ONBOARDING_GENRES.map((g) => {
              const active = g.id === genreId
              return (
                <button
                  key={g.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setGenreId(g.id)}
                  className={
                    "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-[13px] font-medium transition-colors " +
                    (active
                      ? "border-primary bg-accent text-accent-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-input hover:text-foreground")
                  }
                >
                  <g.icon
                    className={active ? "text-primary size-4" : "size-4"}
                    strokeWidth={2}
                    aria-hidden
                  />
                  <span className="truncate">{g.label}</span>
                </button>
              )
            })}
          </div>

          <button
            onClick={handleCreate}
            disabled={creating}
            className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/50 mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[14px] font-semibold shadow-pop transition-colors outline-none focus-visible:ring-[3px] disabled:opacity-60"
          >
            {creating ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                正在创建工作区…
              </>
            ) : (
              <>
                创建并开始写作
                <ArrowRight className="size-4" aria-hidden />
              </>
            )}
          </button>

          {error && (
            <p
              role="alert"
              className="text-destructive mt-3 text-center text-[12px] leading-relaxed"
            >
              {error}
            </p>
          )}
        </div>

        <p className="text-muted-foreground/70 mt-5 text-center text-[12px]">
          所有数据保存在本地 · {EDITORIAL_STAFF_COUNT} 位编辑随时待命
        </p>
      </div>
    </div>
  )
}

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const { bookId, books, booksLoading, setChromeFocused } = useWorkspace()
  const currentBook = books.find((b) => b.id === bookId)
  const bookCurrentChapter = currentBook?.currentChapter ?? 0
  const [selectedChapter, setSelectedChapter] = React.useState<number | null>(null)
  const currentChapter = selectedChapter ?? bookCurrentChapter
  const [mode, setMode] = React.useState<StudioMode>("write")
  const [leftCollapsed, setLeftCollapsed] = React.useState(false)
  const [rightCollapsed, setRightCollapsed] = React.useState(false)
  const [dockExpanded, setDockExpanded] = React.useState(false)
  const [focusMode, setFocusMode] = React.useState(false)
  const [ai, setAi] = React.useState<AiState>("idle")
  const [leftWidth, setLeftWidthState] = React.useState<number>(
    RAIL_BOUNDS.left.def,
  )
  const [rightWidth, setRightWidthState] = React.useState<number>(
    RAIL_BOUNDS.right.def,
  )

  React.useEffect(() => {
    try {
      const l = Number(window.localStorage.getItem("studio:leftWidth:v2"))
      const r = Number(window.localStorage.getItem("studio:rightWidth:v2"))
      if (l) setLeftWidthState(clampRail(l, "left"))
      if (r) setRightWidthState(clampRail(r, "right"))
    } catch {
      /* localStorage 不可用时用默认值 */
    }
  }, [])

  const setLeftWidth = React.useCallback((v: number) => {
    const c = clampRail(v, "left")
    setLeftWidthState(c)
    try {
      window.localStorage.setItem("studio:leftWidth:v2", String(c))
    } catch {
      /* ignore */
    }
  }, [])

  const setRightWidth = React.useCallback((v: number) => {
    const c = clampRail(v, "right")
    setRightWidthState(c)
    try {
      window.localStorage.setItem("studio:rightWidth:v2", String(c))
    } catch {
      /* ignore */
    }
  }, [])

  React.useEffect(() => {
    setSelectedChapter(null)
    setAi("idle")
  }, [bookId])

  const setCurrentChapter = React.useCallback((chapter: number) => {
    setSelectedChapter(Math.max(0, chapter))
    setAi("idle")
  }, [])

  React.useEffect(() => {
    setChromeFocused(focusMode)
  }, [focusMode, setChromeFocused])

  const value = React.useMemo<Ctx>(
    () => ({
      bookId,
      currentChapter,
      selectedChapter,
      setCurrentChapter,
      mode,
      setMode,
      leftCollapsed,
      rightCollapsed,
      dockExpanded,
      focusMode,
      leftWidth,
      rightWidth,
      setLeftWidth,
      setRightWidth,
      toggleLeft: () => setLeftCollapsed((v) => !v),
      toggleRight: () => setRightCollapsed((v) => !v),
      toggleDock: () => setDockExpanded((v) => !v),
      toggleFocus: () => {
        setFocusMode((v) => {
          const next = !v
          if (next) {
            setLeftCollapsed(true)
            setRightCollapsed(true)
          } else {
            setLeftCollapsed(false)
            setRightCollapsed(false)
          }
          return next
        })
      },
      setLeft: setLeftCollapsed,
      setRight: setRightCollapsed,
      ai,
      setAi,
    }),
    [
      bookId,
      currentChapter,
      selectedChapter,
      setCurrentChapter,
      mode,
      leftCollapsed,
      rightCollapsed,
      dockExpanded,
      focusMode,
      leftWidth,
      rightWidth,
      setLeftWidth,
      setRightWidth,
      ai,
      setChromeFocused,
    ],
  )

  if (booksLoading) {
    return (
      <StudioCtx.Provider value={value}>
        <div className="bg-background text-foreground flex h-dvh flex-col items-center justify-center gap-3">
          <div className="ring-border bg-card flex size-12 items-center justify-center overflow-hidden rounded-2xl shadow-card ring-1">
            <img
              src="/juanshe-logo.svg"
              alt=""
              className="size-full opacity-90"
              draggable={false}
            />
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            正在载入工作区…
          </div>
        </div>
      </StudioCtx.Provider>
    )
  }

  if (books.length === 0 || !bookId || !currentBook) {
    return (
      <StudioCtx.Provider value={value}>
        <EmptyBookState />
      </StudioCtx.Provider>
    )
  }

  return <StudioCtx.Provider value={value}>{children}</StudioCtx.Provider>
}

export function useStudio() {
  const ctx = React.useContext(StudioCtx)
  if (!ctx) throw new Error("useStudio must be used within StudioProvider")
  return ctx
}
