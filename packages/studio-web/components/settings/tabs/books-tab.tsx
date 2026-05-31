"use client"

import * as React from "react"
import Link from "next/link"
import {
  BookOpen,
  Check,
  ChevronRight,
  Download,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  X,
} from "lucide-react"

import { useT, useLocale } from "@/lib/i18n"
import { useWorkspace } from "@/lib/workspace-context"
import {
  bookExportUrl,
  createBook,
  updateBook,
  waitForBookCreateStatus,
} from "@/lib/api/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"

export function BooksTab() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { books, bookId, setBookId, refreshBooks, upsertBook } = useWorkspace()
  const { toast } = useToast()
  const [creatingOpen, setCreatingOpen] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [editingBookId, setEditingBookId] = React.useState<string | null>(null)
  const [savingBookId, setSavingBookId] = React.useState<string | null>(null)
  const [titleDraft, setTitleDraft] = React.useState("")
  const [draft, setDraft] = React.useState({
    title: "",
    genre: "长篇小说",
    platform: "fanqie",
    chapterWordCount: "3000",
    targetChapters: "120",
    brief: "",
  })
  const runningCount = books.filter((b) => b.autoRunning).length

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const title = draft.title.trim()
    if (!title || creating) return

    setCreating(true)
    try {
      const result = await createBook({
        title,
        genre: draft.genre.trim() || undefined,
        platform: draft.platform.trim() || undefined,
        language: "zh",
        chapterWordCount: Number(draft.chapterWordCount) || undefined,
        targetChapters: Number(draft.targetChapters) || undefined,
        brief: draft.brief.trim() || undefined,
      })
      const finalStatus = await waitForBookCreateStatus(result.bookId, {
        runId: result.runId,
        timeoutMs: 120_000,
      })
      if (finalStatus.book) {
        upsertBook(finalStatus.book)
        setBookId(finalStatus.book.id)
      } else {
        await refreshBooks()
        setBookId(result.bookId)
      }
      if (finalStatus.status !== "created") {
        throw new Error(
          finalStatus.failureReason ||
            finalStatus.suggestion ||
            finalStatus.error ||
            `Create returned ${finalStatus.status}`,
        )
      }
      setCreatingOpen(false)
      setDraft((current) => ({ ...current, title: "", brief: "" }))
      toast({ title: lang === "en" ? `Created ${title}` : `已创建《${title}》` })
    } catch (error) {
      toast({
        title: lang === "en" ? "Create failed" : "创建失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setCreating(false)
    }
  }

  function startRename(book: (typeof books)[number]) {
    setEditingBookId(book.id)
    setTitleDraft(book.title[lang] || book.id)
  }

  function cancelRename() {
    setEditingBookId(null)
    setTitleDraft("")
  }

  async function handleRename(book: (typeof books)[number]) {
    const title = titleDraft.trim()
    if (!title || savingBookId) return

    setSavingBookId(book.id)
    try {
      await updateBook(book.id, { title })
      await refreshBooks()
      cancelRename()
      toast({
        title:
          lang === "en"
            ? `Renamed to ${title}`
            : `已改名为《${title}》`,
      })
    } catch (error) {
      toast({
        title: lang === "en" ? "Rename failed" : "改名失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setSavingBookId(null)
    }
  }

  function handleExport(book: (typeof books)[number]) {
    window.open(bookExportUrl(book.id, "txt"), "_blank", "noopener,noreferrer")
  }

  return (
    <div className="min-w-0 space-y-6">
      <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-foreground text-base font-semibold">
            {t("workspace.myBooks")}{" "}
            <span className="text-muted-foreground font-mono text-sm">
              · {books.length}
            </span>
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {lang === "en"
              ? `All books in your local workspace · ${runningCount} auto-writing`
              : `本地工作区中的所有作品 · ${runningCount} 本自动续写中`}
          </p>
        </div>
        <Button size="sm" onClick={() => setCreatingOpen((value) => !value)}>
          <Plus className="mr-1.5 size-3.5" strokeWidth={1.8} />
          {t("settings.books.create")}
        </Button>
      </header>

      {creatingOpen && (
        <form
          className="border-border bg-card grid gap-3 rounded-2xl border p-5 md:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr_0.8fr_0.8fr_auto]"
          onSubmit={handleCreate}
        >
          <div className="space-y-1.5">
            <Label className="text-xs">{lang === "en" ? "Title" : "书名"}</Label>
            <Input
              required
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => ({ ...current, title: event.target.value }))
              }
              placeholder={lang === "en" ? "New book title" : "例如：雾港第七盏灯"}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{lang === "en" ? "Genre" : "题材"}</Label>
            <Input
              value={draft.genre}
              onChange={(event) =>
                setDraft((current) => ({ ...current, genre: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{lang === "en" ? "Platform" : "平台"}</Label>
            <Input
              value={draft.platform}
              onChange={(event) =>
                setDraft((current) => ({ ...current, platform: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{lang === "en" ? "Words/ch." : "每章字数"}</Label>
            <Input
              type="number"
              min={500}
              step={100}
              value={draft.chapterWordCount}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  chapterWordCount: event.target.value,
                }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{lang === "en" ? "Chapters" : "目标章节"}</Label>
            <Input
              type="number"
              min={1}
              value={draft.targetChapters}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  targetChapters: event.target.value,
                }))
              }
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" size="sm" disabled={creating || !draft.title.trim()}>
              {creating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              {lang === "en" ? "Create" : "创建"}
            </Button>
          </div>
          <div className="space-y-1.5 md:col-span-2 xl:col-span-6">
            <Label className="text-xs">{lang === "en" ? "Brief" : "一句话方向"}</Label>
            <Input
              value={draft.brief}
              onChange={(event) =>
                setDraft((current) => ({ ...current, brief: event.target.value }))
              }
              placeholder={
                lang === "en"
                  ? "Optional premise, conflict, platform direction"
                  : "可选：主角、欲望、第一冲突、平台方向"
              }
            />
          </div>
        </form>
      )}

      <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {books.map((b) => {
          const isActive = b.id === bookId
          const progress = (b.currentChapter / b.plannedChapters) * 100
          return (
            <article
              key={b.id}
              className="border-border bg-card group relative flex flex-col gap-3 overflow-hidden rounded-2xl border p-4 transition-colors hover:bg-card"
            >
              {isActive && (
                <span className="bg-primary absolute inset-y-0 left-0 w-[3px]" />
              )}

              <header className="flex min-w-0 items-start gap-3">
                <span
                  className="ring-border/40 flex size-10 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${b.accent} 18%, transparent)`,
                  }}
                >
                  <BookOpen
                    className="size-4"
                    strokeWidth={1.7}
                    style={{ color: b.accent }}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  {editingBookId === b.id ? (
                    <form
                      className="flex min-w-0 items-center gap-1.5"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void handleRename(b)
                      }}
                    >
                      <Input
                        value={titleDraft}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        className="h-7 min-w-0 text-sm font-semibold"
                        autoFocus
                      />
                      <Button
                        type="submit"
                        size="icon"
                        variant="ghost"
                        className="size-7 shrink-0"
                        disabled={!titleDraft.trim() || savingBookId === b.id}
                        title={lang === "en" ? "Save name" : "保存书名"}
                        aria-label={lang === "en" ? "Save name" : "保存书名"}
                      >
                        {savingBookId === b.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Check className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-7 shrink-0"
                        onClick={cancelRename}
                        title={lang === "en" ? "Cancel" : "取消"}
                        aria-label={lang === "en" ? "Cancel" : "取消"}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </form>
                  ) : (
                    <div className="flex min-w-0 items-center gap-1.5">
                      <h3 className="text-foreground truncate text-sm font-semibold">
                        {b.title[lang]}
                      </h3>
                      {b.autoRunning && (
                        <span className="bg-status-running/15 text-status-success flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium">
                          <Sparkles className="size-2.5" />
                          {lang === "en" ? "running" : "续写中"}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[10.5px]">
                    <span className="truncate">{b.kindLabel[lang]}</span>
                    {editingBookId !== b.id && (
                      <button
                        type="button"
                        className="hover:text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-md"
                        onClick={() => startRename(b)}
                        title={lang === "en" ? "Rename book" : "改名"}
                        aria-label={lang === "en" ? "Rename book" : "改名"}
                      >
                        <Pencil className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
              </header>

              <dl className="grid grid-cols-3 gap-2 text-[10.5px]">
                <Stat
                  label={t("workspace.chapter")}
                  value={`${b.currentChapter}/${b.plannedChapters}`}
                />
                <Stat
                  label={t("workspace.totalWords")}
                  value={`${(b.totalWords / 10000).toFixed(1)}w`}
                />
                <Stat
                  label={lang === "en" ? "Progress" : "进度"}
                  value={`${progress.toFixed(0)}%`}
                />
              </dl>

              {/* progress bar */}
              <div className="bg-secondary h-1 overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${progress}%`,
                    background: b.accent,
                  }}
                />
              </div>

              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                <Badge
                  variant={isActive ? "default" : "outline"}
                  className="max-w-full truncate text-[10px] sm:max-w-[10rem]"
                >
                  {isActive
                    ? lang === "en"
                      ? "Active"
                      : "当前"
                    : b.id}
                </Badge>
                <div className="flex-1" />
                {!isActive && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setBookId(b.id)}
                    className="h-7 px-2 text-[11px]"
                  >
                    {lang === "en" ? "Activate" : "切换为当前"}
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => handleExport(b)}
                  className="size-7"
                  title={lang === "en" ? "Export TXT" : "导出 TXT"}
                  aria-label={lang === "en" ? "Export TXT" : "导出 TXT"}
                >
                  <Download className="size-3.5" />
                </Button>
                <Link
                  href="/"
                  className="text-muted-foreground hover:text-foreground inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px]"
                  onClick={() => setBookId(b.id)}
                >
                  {lang === "en" ? "Open" : "打开"}
                  <ChevronRight className="size-3" />
                </Link>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card rounded-md px-2 py-1.5">
      <div className="text-muted-foreground/70 truncate text-[9px] uppercase tracking-wider">
        {label}
      </div>
      <div className="text-foreground mt-0.5 truncate font-mono text-[12px]">
        {value}
      </div>
    </div>
  )
}
