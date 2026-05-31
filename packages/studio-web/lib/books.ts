import type { Book, BookSummary } from "@/lib/api/types"

export const BOOK_SUMMARIES: BookSummary[] = [
  {
    id: "book-instance-arrival",
    title: { zh: "星尘邮局今晚开张", en: "After the Instance" },
    kindLabel: { zh: "长篇 · 玄幻", en: "Long · Fantasy" },
    type: "novel-long",
    currentChapter: 5,
    totalWords: 132847,
    chapterCount: 5,
    currentChapterPct: 0.43,
    plannedChapters: 120,
    accent: "var(--chart-1)",
    autoRunning: true,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
  },
  {
    id: "book-cyber-cultivation",
    title: { zh: "赛博修仙：代码入道", en: "Cyber Cultivation" },
    kindLabel: { zh: "长篇 · 科幻", en: "Long · Sci-Fi" },
    type: "novel-long",
    currentChapter: 18,
    totalWords: 58210,
    chapterCount: 18,
    currentChapterPct: 0.25,
    plannedChapters: 80,
    accent: "var(--chart-3)",
    autoRunning: true,
    createdAt: "2026-03-16T00:00:00Z",
    updatedAt: "2026-05-10T00:00:00Z",
  },
  {
    id: "book-postwar-restorer",
    title: { zh: "古籍修复师", en: "The Restorer" },
    kindLabel: { zh: "中篇 · 治愈", en: "Mid · Healing" },
    type: "story",
    currentChapter: 7,
    totalWords: 24180,
    chapterCount: 7,
    currentChapterPct: 0.38,
    plannedChapters: 40,
    accent: "var(--chart-2)",
    createdAt: "2026-02-20T00:00:00Z",
    updatedAt: "2026-05-08T00:00:00Z",
  },
]

export const DEFAULT_BOOK_ID = BOOK_SUMMARIES[0].id

export function findBookSummary(id: string): BookSummary | undefined {
  return BOOK_SUMMARIES.find((book) => book.id === id)
}

export function toBook(book: BookSummary): Book {
  return {
    id: book.id,
    title: book.title,
    type: book.type,
    cover: book.cover,
    totalWords: book.totalWords,
    chapterCount: book.chapterCount,
    currentChapter: book.currentChapter,
    currentChapterPct: book.currentChapterPct,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  }
}
