import type { Manuscript } from "@/lib/api/types"

type ManualStore = Map<string, Manuscript>

const globalManualStore = globalThis as typeof globalThis & {
  __hardwriteStudioManualManuscripts?: ManualStore
}

function store() {
  globalManualStore.__hardwriteStudioManualManuscripts ??= new Map()
  return globalManualStore.__hardwriteStudioManualManuscripts
}

function key(bookId: string, chapterNum: number) {
  return `${bookId}:${chapterNum}`
}

export function getManualManuscript(bookId: string, chapterNum: number) {
  return store().get(key(bookId, chapterNum))
}

export function saveManualManuscript({
  bookId,
  chapterNum,
  content,
}: {
  bookId: string
  chapterNum: number
  content: string
  locale?: "zh" | "en"
}): Manuscript {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      zh: line,
      en: line,
      quote: /^[「『“"]/.test(line),
    }))

  const payload: Manuscript = {
    bookId,
    chapterNum,
    paragraphs,
    cursorParagraph: paragraphs.length,
  }
  store().set(key(bookId, chapterNum), payload)
  return payload
}
