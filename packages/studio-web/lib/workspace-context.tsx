"use client"

import * as React from "react"
import { fetchBooks } from "@/lib/api/client"
import type { BookSummary } from "@/lib/api/types"
import { isBookWritable } from "@/lib/studio/book-readiness"

/**
 * 工作台跨页全局状态：
 *  - 当前激活书籍（多本切换）
 *  - 侧边导航是否折叠（Studio focus 模式时）
 * 由 RootLayout 注入；下游所有 page 共享。
 */

export type { BookSummary }

type Ctx = {
  bookId: string
  setBookId: (id: string) => void

  books: BookSummary[]
  /** true while the initial books fetch has not yet resolved */
  booksLoading: boolean
  refreshBooks: () => Promise<BookSummary[]>
  upsertBook: (book: BookSummary) => void

  /** 全屏沉浸模式（隐藏 SideNav + 顶栏右侧次要按钮） */
  chromeFocused: boolean
  setChromeFocused: (v: boolean) => void
}

const WorkspaceCtx = React.createContext<Ctx | null>(null)

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [bookId, setRawBookId] = React.useState<string>("")
  const [books, setBooks] = React.useState<BookSummary[]>([])
  const [booksLoading, setBooksLoading] = React.useState(true)
  const [chromeFocused, setChromeFocused] = React.useState(false)
  const booksRef = React.useRef<BookSummary[]>([])

  const applyBooks = React.useCallback((nextBooks: BookSummary[]) => {
    booksRef.current = nextBooks
    setBooks(nextBooks)
    setRawBookId((current) => {
      if (nextBooks.some((book) => book.id === current)) return current
      let stored = ""
      try { stored = localStorage.getItem("cj.bookId") || "" } catch { /* ignore */ }
      if (stored && nextBooks.some((book) => book.id === stored)) return stored
      return pickPreferredBook(nextBooks)?.id ?? ""
    })
  }, [])

  const refreshBooks = React.useCallback(async () => {
    const nextBooks = await fetchBooks()
    applyBooks(nextBooks)
    return nextBooks
  }, [applyBooks])

  const setBookId = React.useCallback((id: string) => {
    setRawBookId((current) => {
      const currentBooks = booksRef.current
      const nextExists = currentBooks.some((book) => book.id === id)
      if (nextExists) {
        try { localStorage.setItem("cj.bookId", id) } catch { /* ignore */ }
        return id
      }

      const currentExists = currentBooks.some((book) => book.id === current)
      if (currentExists) return current

      return pickPreferredBook(currentBooks)?.id ?? ""
    })
  }, [])

  const upsertBook = React.useCallback((book: BookSummary) => {
    setBooks((current) => {
      const nextBooks = [
        book,
        ...current.filter((item) => item.id !== book.id),
      ]
      booksRef.current = nextBooks
      return nextBooks
    })
  }, [])

  React.useEffect(() => {
    let cancelled = false

    // 后端在并发突发下偶发超时(502),单次失败不应永久清空工作区 → 重试几次再放弃。
    const load = async () => {
      for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
        try {
          const nextBooks = await fetchBooks()
          if (cancelled) return
          applyBooks(nextBooks)
          setBooksLoading(false)
          return
        } catch {
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
          }
        }
      }
      if (!cancelled) {
        applyBooks([])
        setBooksLoading(false)
      }
    }
    void load()

    return () => {
      cancelled = true
    }
  }, [applyBooks])

  const value = React.useMemo<Ctx>(
    () => ({
      bookId,
      setBookId,
      books,
      booksLoading,
      refreshBooks,
      upsertBook,
      chromeFocused,
      setChromeFocused,
    }),
    [bookId, books, booksLoading, chromeFocused, refreshBooks, upsertBook],
  )

  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>
}

export function pickPreferredBook(books: BookSummary[]) {
  return (
    bestBook(books.filter((book) => isBookWritable(book) && !isLikelyTestBook(book))) ??
    bestBook(books.filter((book) => isBookWritable(book))) ??
    bestBook(books.filter((book) => !isLikelyTestBook(book))) ??
    bestBook(books)
  )
}

function bestBook(books: BookSummary[]) {
  return books.reduce<BookSummary | undefined>((best, book) => {
    if (!best) return book
    return book.currentChapter > best.currentChapter ? book : best
  }, undefined)
}

export function isLikelyTestBook(book: BookSummary) {
  const label = [
    book.id,
    book.title.zh,
    book.title.en,
    book.kindLabel.zh,
    book.kindLabel.en,
    book.creationStatus,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  return TEST_BOOK_KEYWORDS.some((keyword) => label.includes(keyword))
}

const TEST_BOOK_KEYWORDS = [
  "qa",
  "test",
  "demo",
  "fixture",
  "sandbox",
  "测试",
  "验收",
  "上线流程",
  "全链路",
  "自动化",
]

export function useWorkspace() {
  const ctx = React.useContext(WorkspaceCtx)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}
