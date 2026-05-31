"use client"

import * as React from "react"
import { mutate } from "swr"
import { Loader2, ShieldAlert, Sparkles, Target, Zap } from "lucide-react"

import { useT, useLocale } from "@/lib/i18n"
import { pickPreferredBook, useWorkspace } from "@/lib/workspace-context"
import { useProjectPrefs } from "@/hooks/use-studio"
import { createAutoRun } from "@/lib/api/client"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type Props = {
  open: boolean
  onOpenChange: (v: boolean) => void
}

const QUICK_CHAPTER_COUNTS = [1, 3, 5, 10, 20] as const
const MIN_TARGET_WORDS = 800
const MAX_TARGET_WORDS = 12000
const MIN_TARGET_QUALITY = 50
const MAX_TARGET_QUALITY = 100
const MIN_MAX_REWRITES = 1
const MAX_MAX_REWRITES = 6
const MAX_RUN_CHAPTERS = 50
const MAX_CHAPTER_NUM = 9999

function clampInteger(
  value: number,
  min: number,
  max: number,
  fallback: number,
) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function nextChapterFor(book: { currentChapter: number } | null | undefined) {
  return (book?.currentChapter ?? 0) + 1
}

/**
 * 新建自动续写任务对话框。
 *
 * 关键参数：
 *  - 选哪本书
 *  - 写多少章（from → to）
 *  - 每章字数目标（达不到会触发改写）
 *  - 质量分阈值（< 阈值会触发改写）
 *  - 单章最大改写次数（超出则该章节标记 failed）
 */
export function NewRunDialog({ open, onOpenChange }: Props) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const acknowledgementId = React.useId()

  const { books, bookId: activeBookId, setBookId } = useWorkspace()
  const { data: prefs } = useProjectPrefs()

  const defaultBook =
    books.find((b) => b.id === activeBookId) ?? pickPreferredBook(books) ?? null
  const [bookId, setLocalBookId] = React.useState<string>(defaultBook?.id ?? "")
  const book = books.find((b) => b.id === bookId) ?? defaultBook
  const initialNextChapter = nextChapterFor(book)

  const [fromChapter, setFromChapter] =
    React.useState<number>(initialNextChapter)
  const [toChapter, setToChapter] = React.useState<number>(
    initialNextChapter + 4,
  )
  const [targetWords, setTargetWords] = React.useState<number>(
    prefs?.defaultRun.targetWordsPerChapter ?? 3500,
  )
  const [targetQuality, setTargetQuality] = React.useState<number>(
    prefs?.defaultRun.targetQuality ?? 88,
  )
  const [maxRewrites, setMaxRewrites] = React.useState<number>(
    prefs?.defaultRun.maxRewritesPerChapter ?? 3,
  )
  const [mutationAcknowledged, setMutationAcknowledged] =
    React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  // 切换书籍时，重置章节范围
  React.useEffect(() => {
    if (!defaultBook) {
      setLocalBookId("")
      return
    }
    setLocalBookId((current) =>
      books.some((candidate) => candidate.id === current)
        ? current
        : defaultBook.id,
    )
  }, [books, defaultBook])

  // 切换书籍时，重置章节范围
  React.useEffect(() => {
    if (!book) {
      setFromChapter(1)
      setToChapter(1)
      return
    }
    const nextChapter = nextChapterFor(book)
    setFromChapter(nextChapter)
    setToChapter(nextChapter + 4)
  }, [book])

  // 同步 prefs 默认值（仅在初次拉到时）
  React.useEffect(() => {
    if (prefs) {
      setTargetWords(prefs.defaultRun.targetWordsPerChapter)
      setTargetQuality(prefs.defaultRun.targetQuality)
      setMaxRewrites(prefs.defaultRun.maxRewritesPerChapter)
    }
  }, [prefs])

  React.useEffect(() => {
    if (!open) setMutationAcknowledged(false)
  }, [open])

  React.useEffect(() => {
    setMutationAcknowledged(false)
  }, [bookId, fromChapter, toChapter, targetWords, targetQuality, maxRewrites])

  const totalChapters = Math.max(0, toChapter - fromChapter + 1)
  const totalWordsEstimate = totalChapters * targetWords
  const bookTitle =
    book?.title[lang] ?? (lang === "en" ? "No book selected" : "未选择作品")
  const applyChapterCount = React.useCallback(
    (count: number) => {
      setToChapter(
        clampInteger(
          fromChapter + count - 1,
          fromChapter,
          Math.min(MAX_CHAPTER_NUM, fromChapter + MAX_RUN_CHAPTERS - 1),
          fromChapter,
        ),
      )
    },
    [fromChapter],
  )
  const canSubmit =
    totalChapters > 0 &&
    totalChapters <= MAX_RUN_CHAPTERS &&
    Boolean(book) &&
    Boolean(bookId) &&
    Number.isInteger(fromChapter) &&
    Number.isInteger(toChapter) &&
    targetWords >= MIN_TARGET_WORDS &&
    targetWords <= MAX_TARGET_WORDS &&
    targetQuality >= MIN_TARGET_QUALITY &&
    targetQuality <= MAX_TARGET_QUALITY &&
    maxRewrites >= MIN_MAX_REWRITES &&
    maxRewrites <= MAX_MAX_REWRITES &&
    mutationAcknowledged &&
    !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await createAutoRun({
        bookId,
        fromChapter,
        toChapter,
        targetWordsPerChapter: targetWords,
        targetQuality,
        maxRewritesPerChapter: maxRewrites,
      })
      // 把工作区焦点切到新启动的书
      setBookId(bookId)
      // 立即重验运行台
      await mutate("auto-runs")
      setMutationAcknowledged(false)
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="text-primary size-4" />
            {t("runs.newRun")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("runs.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-2">
          {/* Book selector */}
          <div className="grid gap-2">
            <Label className="text-xs">
              {lang === "en" ? "Book" : "作品"}
            </Label>
            <Select value={bookId} onValueChange={setLocalBookId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={lang === "en" ? "No books loaded" : "暂无可用作品"}
                />
              </SelectTrigger>
              <SelectContent>
                {books.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    <div className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: b.accent }}
                      />
                      <span className="font-medium">{b.title[lang]}</span>
                      <span className="text-muted-foreground ml-2 font-mono text-[10px]">
                        Ch.{b.currentChapter}/{b.plannedChapters}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Chapter range */}
          <div className="grid gap-2">
            <Label className="text-xs">{t("runs.fromTo")}</Label>
            <div className="flex items-center gap-3">
              <Input
                aria-label="起始章节"
                type="number"
                min={1}
                max={MAX_CHAPTER_NUM}
                value={fromChapter}
                onChange={(e) => {
                  const nextFrom = clampInteger(
                    Number(e.target.value),
                    1,
                    MAX_CHAPTER_NUM,
                    fromChapter,
                  )
                  setFromChapter(nextFrom)
                  setToChapter((current) =>
                    clampInteger(
                      Math.max(current, nextFrom),
                      nextFrom,
                      Math.min(MAX_CHAPTER_NUM, nextFrom + MAX_RUN_CHAPTERS - 1),
                      nextFrom,
                    ),
                  )
                }}
                className="font-mono"
                disabled={!book}
              />
              <span className="text-muted-foreground">→</span>
              <Input
                aria-label="结束章节"
                type="number"
                min={fromChapter}
                max={Math.min(MAX_CHAPTER_NUM, fromChapter + MAX_RUN_CHAPTERS - 1)}
                value={toChapter}
                onChange={(e) =>
                  setToChapter((current) =>
                    clampInteger(
                      Number(e.target.value),
                      fromChapter,
                      Math.min(MAX_CHAPTER_NUM, fromChapter + MAX_RUN_CHAPTERS - 1),
                      current,
                    ),
                  )
                }
                className="font-mono"
                disabled={!book}
              />
              <div className="text-muted-foreground shrink-0 text-[11px]">
                {totalChapters}{" "}
                {lang === "en" ? "chapters" : "章"}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground text-[10px]">
                {lang === "en" ? "One click" : "一键续写"}
              </span>
              {QUICK_CHAPTER_COUNTS.map((count) => (
                <button
                  key={count}
                  type="button"
                  disabled={!book || submitting}
                  onClick={() => applyChapterCount(count)}
                  className="border-border bg-secondary text-muted-foreground hover:bg-primary/10 hover:text-primary disabled:opacity-50 rounded-full border px-2 py-1 text-[10px] font-medium transition-colors"
                >
                  {count}
                  {lang === "en" ? " ch." : "章"}
                </button>
              ))}
              <span className="text-muted-foreground text-[10px]">
                {lang === "en"
                  ? `Up to ${MAX_RUN_CHAPTERS} chapters per run; can continue beyond the current plan.`
                  : `单次最多 ${MAX_RUN_CHAPTERS} 章，可越过当前计划继续。`}
              </span>
            </div>
          </div>

          {/* Target words per chapter */}
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5 text-xs">
                <Zap className="size-3" />
                {t("runs.targetWords")}
              </Label>
              <Input
                aria-label="自定义每章字数"
                type="number"
                min={MIN_TARGET_WORDS}
                max={MAX_TARGET_WORDS}
                step={100}
                value={targetWords}
                onChange={(event) =>
                  setTargetWords((current) =>
                    clampInteger(
                      Number(event.target.value),
                      MIN_TARGET_WORDS,
                      MAX_TARGET_WORDS,
                      current,
                    ),
                  )
                }
                className="h-7 w-28 font-mono text-xs"
              />
            </div>
            <Slider
              min={MIN_TARGET_WORDS}
              max={MAX_TARGET_WORDS}
              step={100}
              value={[targetWords]}
              onValueChange={([v]) =>
                setTargetWords(
                  clampInteger(
                    v,
                    MIN_TARGET_WORDS,
                    MAX_TARGET_WORDS,
                    targetWords,
                  ),
                )
              }
            />
            <div className="text-muted-foreground flex justify-between font-mono text-[10px]">
              <span>{MIN_TARGET_WORDS.toLocaleString()}</span>
              <span>{MAX_TARGET_WORDS.toLocaleString()}</span>
            </div>
          </div>

          {/* Quality threshold */}
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5 text-xs">
                <Target className="size-3" />
                {t("runs.targetQuality")}
              </Label>
              <Input
                aria-label="自定义质量分"
                type="number"
                min={MIN_TARGET_QUALITY}
                max={MAX_TARGET_QUALITY}
                value={targetQuality}
                onChange={(event) =>
                  setTargetQuality((current) =>
                    clampInteger(
                      Number(event.target.value),
                      MIN_TARGET_QUALITY,
                      MAX_TARGET_QUALITY,
                      current,
                    ),
                  )
                }
                className="h-7 w-20 font-mono text-xs"
              />
            </div>
            <Slider
              min={MIN_TARGET_QUALITY}
              max={MAX_TARGET_QUALITY}
              step={1}
              value={[targetQuality]}
              onValueChange={([v]) =>
                setTargetQuality(
                  clampInteger(
                    v,
                    MIN_TARGET_QUALITY,
                    MAX_TARGET_QUALITY,
                    targetQuality,
                  ),
                )
              }
            />
            <p className="text-muted-foreground text-[10px] leading-relaxed">
              {lang === "en"
                ? `If review score < ${targetQuality}, the chapter is rewritten until threshold is met or max rewrites is reached.`
                : `审稿评分若 < ${targetQuality}，会触发改写，直到达标或达到最大改写次数。`}
            </p>
          </div>

          {/* Max rewrites */}
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t("runs.maxRetries")}</Label>
              <span className="font-mono text-xs">{maxRewrites}</span>
            </div>
            <Slider
              min={MIN_MAX_REWRITES}
              max={MAX_MAX_REWRITES}
              step={1}
              value={[maxRewrites]}
              onValueChange={([v]) =>
                setMaxRewrites(
                  clampInteger(
                    v,
                    MIN_MAX_REWRITES,
                    MAX_MAX_REWRITES,
                    maxRewrites,
                  ),
                )
              }
            />
          </div>

          {/* Estimate */}
          <div className="bg-secondary border-border rounded-lg border px-3 py-2">
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider">
              {lang === "en" ? "Estimate" : "预估"}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-base font-semibold">
                {totalWordsEstimate.toLocaleString()}
              </span>
              <span className="text-muted-foreground text-[11px]">
                {lang === "en" ? "words across" : "总字数 ·"} {totalChapters}{" "}
                {lang === "en" ? "chapters" : "章"}
              </span>
            </div>
          </div>

          <div className="border-amber-500/35 bg-amber-500/10 grid gap-3 rounded-lg border px-3 py-3">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="min-w-0 space-y-1">
                <div className="text-xs font-semibold">
                  {lang === "en"
                    ? "This will write to the selected book"
                    : "这会写入所选作品"}
                </div>
                <p className="text-muted-foreground text-[11px] leading-relaxed">
                  {lang === "en"
                    ? `Run target: ${bookTitle}, chapters ${fromChapter}-${toChapter}, ${targetWords.toLocaleString()} words/chapter, quality >= ${targetQuality}, up to ${maxRewrites} rewrites/chapter. It may consume LLM tokens and update manuscript files.`
                    : `任务目标：《${bookTitle}》，第 ${fromChapter}-${toChapter} 章，每章约 ${targetWords.toLocaleString()} 字，质量 ≥ ${targetQuality}，每章最多改写 ${maxRewrites} 次。启动后可能消耗 LLM token，并更新稿件文件。`}
                </p>
              </div>
            </div>
            <Label
              htmlFor={acknowledgementId}
              className="flex items-start gap-2.5 rounded-md border border-amber-500/20 bg-background/70 p-2.5 text-[11px] font-normal leading-relaxed"
            >
              <Checkbox
                id={acknowledgementId}
                className="mt-0.5"
                checked={mutationAcknowledged}
                disabled={!book || submitting}
                onCheckedChange={(checked) =>
                  setMutationAcknowledged(checked === true)
                }
                aria-label={
                  lang === "en"
                    ? "Confirm this run will write to the selected book"
                    : "确认该任务会写入所选作品"
                }
              />
              <span>
                {lang === "en"
                  ? "I confirm this is a real writing run. For QA or browser smoke, use only a staging or disposable book."
                  : "我确认这是一次真实写作任务。若只是验收或浏览器 smoke，只应选择 staging/disposable 作品。"}
              </span>
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {lang === "en" ? "Cancel" : "取消"}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-2"
          >
            {submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                {lang === "en" ? "Starting…" : "启动中…"}
              </>
            ) : (
              <>
                <Sparkles className="size-3.5" />
                {t("runs.newRun")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
