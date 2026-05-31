"use client"

import * as React from "react"
import {
  ArrowRight,
  AlertCircle,
  BookPlus,
  Check,
  Compass,
  Flame,
  Heart,
  Lightbulb,
  Loader2,
  Pencil,
  RefreshCcw,
  Sparkles,
  Theater,
  Wand2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useT } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { useWorkspace } from "@/lib/workspace-context"
import { createBook, waitForBookCreateStatus } from "@/lib/api/client"
import type { BookCreateStatus } from "@/lib/api/types"
import { useToast } from "@/hooks/use-toast"

const GENRES = [
  { id: "xianxia", icon: Compass, zh: "玄幻修真", en: "Xianxia" },
  { id: "scifi", icon: Sparkles, zh: "科幻悬疑", en: "Sci-fi" },
  { id: "urban", icon: Theater, zh: "都市言情", en: "Urban" },
  { id: "history", icon: Pencil, zh: "历史架空", en: "History" },
  { id: "game", icon: Flame, zh: "游戏竞技", en: "Game" },
  { id: "romance", icon: Heart, zh: "情感治愈", en: "Romance" },
]

const TONES = [
  { id: "tense", zh: "紧凑悬疑", en: "Tense" },
  { id: "lyric", zh: "诗意抒情", en: "Lyrical" },
  { id: "dry", zh: "冷峻克制", en: "Dry" },
  { id: "warm", zh: "温润治愈", en: "Warm" },
  { id: "epic", zh: "史诗宏大", en: "Epic" },
]

const LENGTHS = [
  { id: "short", zh: "中短篇 · 10 万", en: "Short · 100k", chapters: 35 },
  { id: "long", zh: "长篇 · 50 万", en: "Long · 500k", chapters: 160 },
  { id: "saga", zh: "巨制 · 100 万 +", en: "Saga · 1M+", chapters: 320 },
]

const CREATION_STAGES = [
  {
    title: "地基档案",
    detail: "题材、主线、人物动机先落档，避免空壳开写。",
  },
  {
    title: "三幕大纲",
    detail: "先排主线推进与高潮位置，再切章节。",
  },
  {
    title: "伏笔账本",
    detail: "把能力、秘密、回收点写进可追踪账本。",
  },
  {
    title: "复审确认",
    detail: "不达标会停在大纲补地基，不直接硬写正文。",
  },
  {
    title: "进入写作台",
    detail: "通过后进入首屏流式工作台，继续质量门控。",
  },
]

export function NewBookMode() {
  const t = useT()
  const { setMode } = useStudio()
  const { setBookId, refreshBooks, upsertBook } = useWorkspace()
  const { toast } = useToast()
  const [genre, setGenre] = React.useState("xianxia")
  const [tone, setTone] = React.useState("tense")
  const [length, setLength] = React.useState("long")
  const [title, setTitle] = React.useState("星尘邮局今晚开张")
  const [synopsis, setSynopsis] = React.useState(
    "蓝星突然降临，蓝星出现大量异变区域。人类获得职业与能力，进入副本获取资源与力量。地图绘制能力是极为稀有的探索类能力，可将未知区域可视化。",
  )
  const [creating, setCreating] = React.useState(false)
  const [createStatus, setCreateStatus] = React.useState<BookCreateStatus | null>(
    null,
  )
  const [createError, setCreateError] = React.useState("")

  const selectedGenre = GENRES.find((item) => item.id === genre) ?? GENRES[0]
  const selectedTone = TONES.find((item) => item.id === tone) ?? TONES[0]
  const selectedLength = LENGTHS.find((item) => item.id === length) ?? LENGTHS[1]

  function clearSettledCreateState() {
    if (creating) return
    setCreateStatus(null)
    setCreateError("")
  }

  function handleTitleChange(value: string) {
    setTitle(value)
    clearSettledCreateState()
  }

  function handleSynopsisChange(value: string) {
    setSynopsis(value)
    clearSettledCreateState()
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (creating) return

    const nextTitle = title.trim()
    const nextSynopsis = synopsis.trim()
    if (!nextTitle || !nextSynopsis) {
      setCreateError("书名和简介都要填写，才能交给建书 agent。")
      return
    }

    setCreating(true)
    setCreateError("")
    setCreateStatus(null)
    try {
      const result = await createBook({
        title: nextTitle,
        genre: selectedGenre.zh,
        language: "zh",
        chapterWordCount: 3000,
        targetChapters: selectedLength.chapters,
        brief: `${nextSynopsis}\n\n风格基调：${selectedTone.zh}`,
      })
      const finalStatus = await waitForBookCreateStatus(result.bookId, {
        runId: result.runId,
        timeoutMs: 600_000,
        intervalMs: 2_000,
        onStatus: setCreateStatus,
      })

      if (finalStatus.status === "created") {
        const nextBooks = finalStatus.book ? [] : await refreshBooks()
        const createdBook =
          finalStatus.book ??
          nextBooks.find((book) => book.id === result.bookId)

        if (!createdBook) {
          setCreateError("建书已完成，但书籍文件还没有同步到列表；请稍后刷新。")
          return
        }

        upsertBook(createdBook)
        setBookId(createdBook.id)
        toast({
          title: `《${nextTitle}》已建好，已进入地基确认。`,
          description: "先检查大纲、伏笔和人物动机，确认后再启动 Goal 写作。",
        })
        setMode("outline")
        return
      }

      if (finalStatus.status === "needs-foundation") {
        if (finalStatus.book) {
          upsertBook(finalStatus.book)
          setBookId(finalStatus.book.id)
        } else {
          await refreshBooks()
          setBookId(result.bookId)
        }
        setCreateError(
          finalStatus.failureReason ||
            finalStatus.suggestion ||
            "建书复审没有通过，系统已保留草稿，但不会直接启动写章。",
        )
        toast({
          title: "建书需要补地基",
          description:
            finalStatus.suggestion || "请补足题材、主线、人物动机后再启动写作。",
          variant: "destructive",
        })
        setMode("outline")
        return
      }

      if (finalStatus.status === "creating") {
        await refreshBooks()
        setCreateError("建书仍在运行中，请稍后刷新状态；当前不会假装进入写作。")
        return
      }

      setCreateError(
        finalStatus.error ||
          finalStatus.failureReason ||
          `建书返回异常状态：${finalStatus.status}`,
      )
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl px-6 pb-28 pt-8 md:px-10 md:pb-32 md:pt-12">
          {/* Header */}
          <div className="mb-8 flex items-start gap-4">
            <div className="from-primary/20 to-accent/20 ring-primary/30 flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ring-1">
              <BookPlus className="text-primary size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-serif text-2xl font-semibold tracking-tight md:text-3xl">
                {t("new.title")}
              </h1>
              <p className="text-muted-foreground mt-1.5 text-sm">
                {t("new.subtitle")}
              </p>
            </div>
          </div>

          <CreationPipelinePanel creating={creating} status={createStatus} />

          {/* Form */}
          <form id="new-book-form" className="space-y-5" onSubmit={handleSubmit}>
            <Field
              label={t("new.bookTitle")}
              hint={
                <span className="text-muted-foreground">
                  <Lightbulb className="mr-1 inline size-3 text-accent" />
                  AI 建议：用主角动作 + 名词，节奏更带感
                </span>
              }
            >
              <Input
                placeholder={t("new.bookTitlePlaceholder")}
                value={title}
                onChange={(event) => handleTitleChange(event.target.value)}
                className="h-11 text-base"
              />
            </Field>

            <Field label={t("new.genre")}>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {GENRES.map((g) => {
                  const Icon = g.icon
                  const active = genre === g.id
                  return (
                    <button
                      type="button"
                      key={g.id}
                      onClick={() => setGenre(g.id)}
                      className={cn(
                        "border-border/60 hover:bg-secondary group flex flex-col items-center gap-1 rounded-lg border bg-card/40 p-3 text-xs transition-all",
                        active &&
                          "border-primary/50 bg-primary/10 ring-1 ring-primary/20",
                      )}
                    >
                      <Icon
                        className={cn(
                          "size-4 transition-colors",
                          active ? "text-primary" : "text-muted-foreground",
                        )}
                      />
                      <span className={cn(active && "text-primary font-medium")}>
                        {g.zh}
                      </span>
                    </button>
                  )
                })}
              </div>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={t("new.tone")}>
                <div className="flex flex-wrap gap-1.5">
                  {TONES.map((x) => (
                    <button
                      type="button"
                      key={x.id}
                      onClick={() => setTone(x.id)}
                      className={cn(
                        "border-border/60 rounded-full border bg-card/40 px-3 py-1.5 text-xs transition-all hover:bg-secondary",
                        tone === x.id &&
                          "border-primary/50 bg-primary/10 text-primary ring-1 ring-primary/20",
                      )}
                    >
                      {x.zh}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={t("new.length")}>
                <div className="flex flex-wrap gap-1.5">
                  {LENGTHS.map((x) => (
                    <button
                      type="button"
                      key={x.id}
                      onClick={() => setLength(x.id)}
                      className={cn(
                        "border-border/60 rounded-full border bg-card/40 px-3 py-1.5 text-xs transition-all hover:bg-secondary",
                        length === x.id &&
                          "border-primary/50 bg-primary/10 text-primary ring-1 ring-primary/20",
                      )}
                    >
                      {x.zh}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            <Field
              label={t("new.synopsis")}
              hint={
                <span className="text-muted-foreground inline-flex items-center gap-1">
                  <Wand2 className="size-3 text-accent" />
                  AI 已注入风格锚定 · 待你完成后启动建书复审
                </span>
              }
            >
              <Textarea
                placeholder={t("new.synopsisPlaceholder")}
                value={synopsis}
                onChange={(event) => handleSynopsisChange(event.target.value)}
                rows={3}
                className="resize-none"
              />
            </Field>

            {(createStatus || createError) && (
              <Alert
                data-testid="book-create-status"
                variant={createError ? "destructive" : "default"}
              >
                {creating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : createError ? (
                  <AlertCircle className="size-4" />
                ) : (
                  <RefreshCcw className="size-4" />
                )}
                <AlertTitle>
                  {createStatus?.status === "created"
                    ? "建书完成"
                    : createStatus?.status === "needs-foundation"
                      ? "建书需要补地基"
                      : createStatus?.status === "creating"
                        ? "建书 agent 运行中"
                        : createError
                          ? "建书未完成"
                          : "建书状态"}
                </AlertTitle>
                <AlertDescription className="space-y-1">
                  {createStatus?.stage && (
                    <p>
                      {createStatus.agentLabel || createStatus.agent || "建书 agent"} ·{" "}
                      {createStatus.stage}
                    </p>
                  )}
                  {createStatus?.preview && <p>{createStatus.preview}</p>}
                  {createError && <p>{createError}</p>}
                </AlertDescription>
              </Alert>
            )}

            {/* AI 生成预览 */}
            <div className="border-primary/20 from-primary/5 via-card to-accent/5 rounded-xl border bg-gradient-to-br p-5">
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="text-primary size-4" />
                <span className="text-sm font-medium">
                  建书复审官 · 实时建议
                </span>
                <Badge
                  variant="outline"
                  className="bg-status-success/10 text-status-success border-status-success/30 ml-auto gap-1 text-[10px]"
                >
                  <Check className="size-3" />
                  通过
                </Badge>
              </div>
              <ul className="space-y-2 text-xs">
                <SuggestionRow
                  ok
                  text="题材组合「玄幻 + 制图能力」拥挤度低，蓝海机会指数 78"
                />
                <SuggestionRow
                  ok
                  text="基调匹配读者偏好（紧凑悬疑 +35% 趋势）"
                />
                <SuggestionRow
                  warn
                  text="主角能力建议在第 1 章前 800 字内完整展示"
                />
              </ul>
            </div>
          </form>
        </div>
      </ScrollArea>

      {/* Sticky CTA */}
      <div className="border-border/40 bg-background/80 sticky bottom-0 shrink-0 border-t backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4 md:px-10">
          <span className="text-muted-foreground hidden text-xs sm:block">
            {t("new.aiHint")}
          </span>
          <Button
            size="lg"
            type="submit"
            form="new-book-form"
            disabled={creating || !title.trim() || !synopsis.trim()}
            className="from-primary to-primary/80 hover:from-primary/95 ml-auto bg-gradient-to-r shadow-lg shadow-primary/25"
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            <span>{creating ? "正在建书" : t("new.start")}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

function CreationPipelinePanel({
  creating,
  status,
}: {
  creating: boolean
  status: BookCreateStatus | null
}) {
  const state = status?.status ?? (creating ? "creating" : "")
  const activeIndex =
    state === "created"
      ? CREATION_STAGES.length - 1
      : state === "needs-foundation"
        ? 3
        : creating
          ? 0
          : -1

  return (
    <section
      data-testid="creation-pipeline"
      className="border-border/50 bg-card/45 mb-6 overflow-hidden rounded-2xl border"
    >
      <div className="border-border/40 flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-xl">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">流式建书流水线</h2>
          <p className="text-muted-foreground text-xs">
            新书会按地基、大纲、伏笔、复审推进；没过门槛就停下补，不会乱跳到正文。
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 text-[10px]",
            state === "created" &&
              "border-status-success/30 bg-status-success/10 text-status-success",
            state === "needs-foundation" &&
              "border-status-warning/30 bg-status-warning/10 text-status-warning",
            creating &&
              "border-status-running/30 bg-status-running/10 text-status-running",
          )}
        >
          {state === "created"
            ? "已通过"
            : state === "needs-foundation"
              ? "待补地基"
              : creating
                ? "运行中"
                : "待启动"}
        </Badge>
      </div>
      <ol className="grid gap-2 p-3 sm:grid-cols-5">
        {CREATION_STAGES.map((stage, index) => {
          const done = state === "created" || (state === "needs-foundation" && index < 3)
          const active = index === activeIndex && state !== "created"
          return (
            <li
              key={stage.title}
              className={cn(
                "border-border/40 bg-background/35 min-h-28 rounded-xl border p-3 transition-colors",
                done && "border-status-success/30 bg-status-success/5",
                active && "border-primary/40 bg-primary/5 ring-1 ring-primary/20",
              )}
            >
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold",
                    done
                      ? "border-status-success/30 bg-status-success/15 text-status-success"
                      : active
                        ? "border-primary/40 bg-primary/15 text-primary"
                        : "border-border text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3" /> : index + 1}
                </span>
                <span className="truncate text-xs font-medium">{stage.title}</span>
              </div>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {stage.detail}
              </p>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Label className="text-sm font-medium">{label}</Label>
        {hint && <div className="text-xs">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function SuggestionRow({
  ok,
  warn,
  text,
}: {
  ok?: boolean
  warn?: boolean
  text: string
}) {
  return (
    <li className="flex items-start gap-2">
      <span
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full",
          ok && "bg-status-success/15 text-status-success",
          warn && "bg-status-warning/15 text-status-warning",
        )}
      >
        {ok ? <Check className="size-2.5" /> : <span className="text-[8px]">!</span>}
      </span>
      <span className="leading-relaxed">{text}</span>
    </li>
  )
}
