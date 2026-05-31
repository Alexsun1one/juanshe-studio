"use client"

import * as React from "react"
import { BookOpen, Check, ChevronDown, Plus, Sparkles } from "lucide-react"
import { useSWRConfig } from "swr"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useT, useLocale } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { useWorkspace } from "@/lib/workspace-context"
import {
  fetchChapters,
  fetchChapterStats,
  fetchManuscript,
} from "@/lib/api/client"
import type { BookSummary } from "@/lib/api/types"

export function BookSwitcher() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { books, bookId, setBookId } = useWorkspace()
  const { setMode } = useStudio()
  const { mutate } = useSWRConfig()
  const prefetchCacheRef = React.useRef(new Map<string, number>())

  const current = books.find((b) => b.id === bookId) ?? null
  const runningCount = books.filter((b) => b.autoRunning).length

  function prefetchBook(book: BookSummary) {
    const chapter = Math.max(1, book.currentChapter || 1)
    const cacheKey = `${book.id}:${chapter}`
    const lastPrefetchedAt = prefetchCacheRef.current.get(cacheKey) ?? 0

    if (Date.now() - lastPrefetchedAt < 5_000) return
    prefetchCacheRef.current.set(cacheKey, Date.now())

    void mutate(["chapters", book.id], fetchChapters(book.id), {
      populateCache: true,
      revalidate: false,
    }).catch(() => undefined)
    void mutate(["manuscript", book.id, chapter], fetchManuscript(book.id, chapter), {
      populateCache: true,
      revalidate: false,
    }).catch(() => undefined)
    void mutate(
      ["chapter-stats", book.id, chapter],
      fetchChapterStats(book.id, chapter),
      {
        populateCache: true,
        revalidate: false,
      },
    ).catch(() => undefined)
  }

  function switchToBook(book: BookSummary) {
    prefetchBook(book)
    React.startTransition(() => {
      setBookId(book.id)
      setMode("write")
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="hover:bg-secondary/70 h-9 w-full max-w-[220px] shrink min-w-0 gap-2 px-2.5"
          aria-label={t("workspace.switchBook")}
        >
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-border/40"
            style={{
              backgroundColor: current
                ? `color-mix(in oklab, ${current.accent} 18%, transparent)`
                : undefined,
            }}
          >
            <BookOpen
              className="size-3.5"
              style={{ color: current?.accent }}
            />
          </span>
          <div className="flex min-w-0 flex-col items-start leading-tight">
            <span className="text-foreground/90 truncate text-[13px] font-medium">
              {current ? current.title[lang] : "正在载入作品"}
            </span>
            <span className="text-muted-foreground truncate text-[10px]">
              {current
                ? `${current.kindLabel[lang]} · ${t("workspace.chapter")} ${current.currentChapter} / ${current.plannedChapters}`
                : "等待后端真实数据"}
            </span>
          </div>
          {runningCount > 0 && (
            <span className="bg-status-running/15 text-status-success ml-1 hidden items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium md:inline-flex">
              <Sparkles className="size-2.5" />
              {runningCount}
            </span>
          )}
          <ChevronDown className="text-muted-foreground size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="bs-menu w-[360px] p-2 bg-card border-border">
        <div className="bs-menu-head">
          <span>{t("workspace.myBooks")}</span>
          <span className="bs-menu-count">{books.length}</span>
        </div>
        <div className="bs-menu-list">
          {books.map((b) => {
            const isActive = b.id === bookId
            const pct = b.plannedChapters > 0
              ? Math.round((b.currentChapter / b.plannedChapters) * 100)
              : 0
            const accent = b.accent || "#6E5BFA"
            return (
              <button
                type="button"
                key={b.id}
                onPointerEnter={() => prefetchBook(b)}
                onFocus={() => prefetchBook(b)}
                onClick={() => switchToBook(b)}
                className={`bs-card${isActive ? " bs-card-active" : ""}`}
                style={{ ["--bs-accent" as string]: accent }}
              >
                {/* 像素书脊封面 — 用 faction 色 + 书架风格 */}
                <span className="bs-spine" aria-hidden>
                  <span className="bs-spine-band" />
                  <span className="bs-spine-band" />
                  <span className="bs-spine-band" />
                </span>
                <span className="bs-body">
                  <span className="bs-title-row">
                    <span className="bs-title">{b.title[lang]}</span>
                    {b.autoRunning && (
                      <span className="bs-running" title="正在写作中">
                        <span className="bs-running-dot" />
                        写
                      </span>
                    )}
                  </span>
                  <span className="bs-meta">
                    <span className="bs-kind">{b.kindLabel[lang]}</span>
                    <span className="bs-sep">·</span>
                    <span className="bs-num">
                      <b>{b.currentChapter}</b><span className="bs-of">/{b.plannedChapters}</span> 章
                    </span>
                    <span className="bs-sep">·</span>
                    <span className="bs-num">
                      <b>{(b.totalWords / 10000).toFixed(1)}</b><span className="bs-of">万</span>
                    </span>
                  </span>
                  <span className="bs-progress">
                    <span className="bs-progress-fill" style={{ width: `${pct}%` }} />
                  </span>
                </span>
                {isActive && (
                  <Check className="bs-check" />
                )}
              </button>
            )
          })}
        </div>
        <div className="bs-divider" />
        <button
          type="button"
          className="bs-new"
          onClick={() => setMode("new")}
        >
          <Plus className="size-4" />
          <span>{t("workspace.newBook")}</span>
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
