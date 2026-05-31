"use client"

import * as React from "react"
import { useSWRConfig } from "swr"
import { useLocale } from "@/lib/i18n"
import { useWorkspace } from "@/lib/workspace-context"
import {
  fetchChapters,
  fetchChapterStats,
  fetchManuscript,
} from "@/lib/api/client"
import type { BookSummary } from "@/lib/api/types"

/**
 * 工作台书架 —— 替代 topbar 那个"下拉选书"(用户嫌 low)。
 * 所有书做成暖色像素书卡横排,点一下即切;书架头内联使用统计(几本 / 累计字数 / 已写章数 / 在写)。
 * 统计全部来自已加载的 books(零额外请求,真实数据,不编造)。
 * 切书逻辑与 BookSwitcher 对齐:setBookId + setMode("write") + 预取目标书数据。
 */
export function BookShelf({ onNewBook }: { onNewBook: () => void }) {
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { books, bookId, setBookId } = useWorkspace()
  const { mutate } = useSWRConfig()
  const prefetchedRef = React.useRef(new Map<string, number>())
  const activeRef = React.useRef<HTMLButtonElement>(null)

  // 当前书可能在书架右侧视野外 —— 自动把它滚进可视区,让"我在写哪本"一眼可见且高亮
  React.useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" })
  }, [bookId])

  // ── 使用统计:全部来自 books,真实、零额外请求 ──
  const count = books.length
  const totalWords = books.reduce((s, b) => s + (b.totalWords || 0), 0)
  const totalChapters = books.reduce((s, b) => s + (b.chapterCount || 0), 0)
  const runningCount = books.filter((b) => b.autoRunning).length

  function prefetchBook(book: BookSummary) {
    const chapter = Math.max(1, book.currentChapter || 1)
    const cacheKey = `${book.id}:${chapter}`
    const last = prefetchedRef.current.get(cacheKey) ?? 0
    if (Date.now() - last < 5_000) return
    prefetchedRef.current.set(cacheKey, Date.now())
    void mutate(["chapters", book.id], fetchChapters(book.id), { populateCache: true, revalidate: false }).catch(() => undefined)
    void mutate(["manuscript", book.id, chapter], fetchManuscript(book.id, chapter), { populateCache: true, revalidate: false }).catch(() => undefined)
    void mutate(["chapter-stats", book.id, chapter], fetchChapterStats(book.id, chapter), { populateCache: true, revalidate: false }).catch(() => undefined)
  }

  function switchToBook(book: BookSummary) {
    if (book.id === bookId) return
    prefetchBook(book)
    React.startTransition(() => {
      setBookId(book.id)
    })
  }

  if (count === 0) return null

  const wan = (totalWords / 10000).toFixed(totalWords >= 100000 ? 0 : 1)

  return (
    <div className="shelf">
      <div className="shelf-head">
        <span className="shelf-h-title">我的书架</span>
        <div className="shelf-stats" aria-label="写作统计">
          <span className="ss"><b>{count}</b> 本书</span>
          <span className="ss-dot" aria-hidden />
          <span className="ss">累计 <b>{wan}</b> 万字</span>
          <span className="ss-dot" aria-hidden />
          <span className="ss">已写 <b>{totalChapters.toLocaleString("en-US")}</b> 章</span>
          {runningCount > 0 && (
            <>
              <span className="ss-dot" aria-hidden />
              <span className="ss live"><i aria-hidden />在写 {runningCount}</span>
            </>
          )}
        </div>
      </div>

      <div className="shelf-rail" role="listbox" aria-label="选择作品">
        {books.map((b) => {
          const isActive = b.id === bookId
          const planned = b.plannedChapters || b.chapterCount || 0
          const pct = planned > 0 ? Math.min(100, Math.round((b.currentChapter / planned) * 100)) : 0
          const accent = b.accent || "#6E5BFA"
          const bWan = (b.totalWords / 10000).toFixed(1)
          return (
            <button
              type="button"
              key={b.id}
              ref={isActive ? activeRef : undefined}
              role="option"
              aria-selected={isActive}
              onPointerEnter={() => prefetchBook(b)}
              onFocus={() => prefetchBook(b)}
              onClick={() => switchToBook(b)}
              className={`shelf-book${isActive ? " is-active" : ""}`}
              style={{ ["--bk-accent" as string]: accent }}
              title={`${b.title[lang]} · 第 ${b.currentChapter}/${planned} 章`}
            >
              <span className="sb-cover" aria-hidden>
                <i className="sb-band" />
                <i className="sb-band" />
                <i className="sb-band" />
                {b.autoRunning && <span className="sb-live-dot" />}
              </span>
              <span className="sb-info">
                <span className="sb-title">{b.title[lang]}</span>
                <span className="sb-meta">
                  <b>{b.currentChapter}</b><span className="sb-of">/{planned}</span> 章
                  <span className="sb-mid">·</span>
                  <b>{bWan}</b><span className="sb-of">万</span>
                </span>
                <span className="sb-bar"><i style={{ width: `${pct}%` }} /></span>
              </span>
              {isActive && <span className="sb-check" aria-hidden>✓</span>}
            </button>
          )
        })}

        <button type="button" className="shelf-add" onClick={onNewBook} title="开建一部新书">
          <span className="sa-plus" aria-hidden>+</span>
          <span className="sa-text">新建一本</span>
        </button>
      </div>
    </div>
  )
}
