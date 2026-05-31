"use client"

import * as React from "react"
import {
  Check,
  CheckCircle2,
  Clipboard,
  Clock,
  ExternalLink,
  FileText,
  RefreshCcw,
  Send,
  Sparkles,
  Tags,
  TrendingUp,
  XCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { useT, useLocale } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import {
  fetchBookDescription,
  generateBookDescription,
  triggerPublish,
} from "@/lib/api/client"
import { ENDPOINTS, type BookDescriptionPayload } from "@/lib/api/types"
import { useChapters, usePublishChannels } from "@/hooks/use-studio"
import { useToast } from "@/hooks/use-toast"

export function PublishMode() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId } = useStudio()
  const { toast } = useToast()
  const { data: chapters } = useChapters(bookId)
  const { data: channels } = usePublishChannels(bookId)
  const allChapters = chapters ?? []
  const allChannels = channels ?? []

  // chapters available to publish = done status
  const readyChapters = allChapters.filter((c) => c.status === "done")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  // 当 chapters 拉到后，将"全部已完成章节"作为默认勾选集
  React.useEffect(() => {
    if (readyChapters.length > 0 && selected.size === 0) {
      setSelected(new Set(readyChapters.map((c) => c.id)))
    }
  }, [allChapters.length]) // readyChapters/selected intentionally excluded
  const [publishing, setPublishing] = React.useState(false)
  const [submitted, setSubmitted] = React.useState(false)
  const [description, setDescription] = React.useState<BookDescriptionPayload | null>(null)
  const [descriptionLoading, setDescriptionLoading] = React.useState(false)
  const [descriptionError, setDescriptionError] = React.useState("")

  function toggleChapter(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  async function handlePublish() {
    const selectedChapters = readyChapters.filter((chapter) =>
      selected.has(chapter.id),
    )
    if (selectedChapters.length === 0) return
    setPublishing(true)
    try {
      await Promise.all(
        selectedChapters.map((chapter) => triggerPublish(bookId, chapter.num)),
      )
      setSubmitted(true)
      toast({
        title:
          lang === "en"
            ? `Approved ${selectedChapters.length} chapters`
            : `已标记 ${selectedChapters.length} 章为审核通过`,
      })
    } catch (error) {
      toast({
        title: lang === "en" ? "Approval failed" : "审核通过失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setPublishing(false)
    }
  }

  const totalWords = allChapters.reduce((sum, chapter) => sum + (chapter.words || 0), 0)
  const publishDescription = description
  const stats = [
    {
      label: lang === "zh" ? "总字数" : "Total words",
      value: totalWords.toLocaleString(),
    },
    {
      label: lang === "zh" ? "渠道配置" : "Channel configs",
      value: allChannels.length.toString(),
    },
    {
      label: lang === "zh" ? "可审核章节" : "Ready to approve",
      value: readyChapters.length.toString(),
    },
  ]

  const loadBookDescription = React.useCallback(
    async (generate = false) => {
      setDescriptionLoading(true)
      setDescriptionError("")
      try {
        const result = generate
          ? await generateBookDescription(bookId)
          : await fetchBookDescription(bookId)
        setDescription(result.description)
        if (generate) {
          toast({
            title: lang === "zh" ? "已生成网站简介" : "Description generated",
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setDescriptionError(message)
      } finally {
        setDescriptionLoading(false)
      }
    },
    [bookId, lang, toast],
  )

  React.useEffect(() => {
    setDescription(null)
    setDescriptionError("")
    void loadBookDescription(false)
  }, [bookId, loadBookDescription])

  async function copyPublishText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text.trim())
      toast({
        title: lang === "zh" ? `已复制${label}` : `${label} copied`,
      })
    } catch (error) {
      toast({
        title: lang === "zh" ? "复制失败" : "Copy failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div className="border-border/40 bg-background/60 flex items-center gap-3 border-b px-6 py-3 backdrop-blur-sm md:px-10">
        <Send className="text-primary size-5" />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight md:text-lg">
            {t("publish.title")}
          </h1>
          <p className="text-muted-foreground text-xs">{t("publish.subtitle")}</p>
        </div>
        {!submitted ? (
          <Button
            onClick={handlePublish}
            disabled={selected.size === 0 || publishing}
            className="from-primary to-primary/80 gap-1.5 bg-gradient-to-r shadow-md shadow-primary/20"
            size="sm"
          >
            {publishing ? (
              <RefreshCcw className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            <span className="text-xs">
              {publishing
                ? lang === "zh"
                  ? "审核通过中…"
                  : "Approving…"
                : lang === "zh"
                  ? `审核通过 ${selected.size} 章`
                  : `Approve ${selected.size} ch.`}
            </span>
          </Button>
        ) : (
          <Badge className="bg-status-success/10 text-status-success border-status-success/30 gap-1 border">
            <CheckCircle2 className="size-3" />
            {lang === "zh" ? "已审核通过" : "Approved"}
          </Badge>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="mx-auto grid max-w-5xl gap-6 px-6 py-8 md:grid-cols-2 md:px-10">
          {/* Chapter checklist */}
          <section>
            <h2 className="text-muted-foreground mb-3 text-xs font-semibold uppercase tracking-wider">
              {lang === "zh" ? "选择章节" : "Select chapters"}
            </h2>
            <ul className="space-y-1.5">
              {allChapters.map((c) => {
                const ready = c.status === "done"
                const checked = selected.has(c.id)
                return (
                  <li
                    key={c.id}
                    className={cn(
                      "border-border/40 bg-card/40 flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-all",
                      ready
                        ? checked
                          ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                          : "hover:bg-card"
                        : "opacity-40 cursor-not-allowed",
                    )}
                    onClick={() => ready && toggleChapter(c.id)}
                    role="checkbox"
                    aria-checked={checked}
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-transparent",
                      )}
                    >
                      {checked && <Check className="size-2.5" />}
                    </span>
                    <span className="text-muted-foreground/70 font-mono text-[11px]">
                      Ch.{String(c.num).padStart(2, "0")}
                    </span>
                    <span className="flex-1 truncate text-[12px] font-medium">
                      {c.title[lang]}
                    </span>
                    <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                      {c.words > 0 ? `${c.words.toLocaleString()}${lang === "zh" ? "字" : "w"}` : "—"}
                    </span>
                    <ChapterStatusPip status={c.status} />
                  </li>
                )
              })}
            </ul>
          </section>

          {/* Channels */}
          <section>
            <PublishCopyKit
              description={publishDescription}
              error={descriptionError}
              lang={lang}
              loading={descriptionLoading}
              onCopy={copyPublishText}
              onGenerate={() => void loadBookDescription(true)}
              onRefresh={() => void loadBookDescription(false)}
            />

            <h2 className="text-muted-foreground mb-3 text-xs font-semibold uppercase tracking-wider">
              {lang === "zh" ? "发布渠道" : "Channels"}
            </h2>
            <ul className="space-y-2">
              {allChannels.map((ch) => (
                <li
                  key={ch.id}
                  className="border-border/40 bg-card/40 flex items-center gap-3 rounded-lg border px-3 py-3"
                >
                  <ChannelIcon name={ch.name.zh} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium">{ch.name[lang]}</div>
                    <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
                      <Clock className="size-2.5" />
                      {lang === "zh" ? "同步至" : "synced to"} {ch.chapter}
                      <span className="opacity-50">·</span>
                      {ch.lastSync}
                    </div>
                  </div>
                  <ChannelStatusBadge status={ch.status} lang={lang} />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    aria-label={
                      lang === "zh" ? "导出发布稿" : "Export publish draft"
                    }
                    onClick={() =>
                      window.open(
                        ENDPOINTS.bookExport(bookId, "txt"),
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    <ExternalLink className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>

            {/* stats row */}
            <div className="mt-4 grid grid-cols-3 gap-2">
              {stats.map((s) => (
                <div
                  key={s.label}
                  className="border-border/40 bg-card/40 flex flex-col gap-0.5 rounded-lg border px-3 py-2.5"
                >
                  <span className="font-mono text-sm font-semibold tabular-nums">
                    {s.value}
                  </span>
                  <span className="text-muted-foreground text-[10px]">{s.label}</span>
                </div>
              ))}
            </div>

            {/* market feedback status */}
            <div className="border-border/40 bg-secondary/30 mt-4 flex items-start gap-2.5 rounded-lg border px-3 py-3">
              <TrendingUp className="text-primary mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0 text-[11px] leading-snug">
                <span className="text-foreground/80 font-medium">
                  {lang === "zh" ? "市场雷达未接入：" : "Market Radar not connected: "}
                </span>
                <span className="text-muted-foreground">
                  {lang === "zh"
                    ? "这里不展示热度百分比或趋势判断，接入真实数据源后再给出建议。"
                    : "No heat score or trend advice is shown until a real data source is connected."}
                </span>
              </div>
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

function PublishCopyKit({
  description,
  error,
  lang,
  loading,
  onCopy,
  onGenerate,
  onRefresh,
}: {
  description: BookDescriptionPayload | null
  error: string
  lang: string
  loading: boolean
  onCopy: (label: string, text: string) => void
  onGenerate: () => void
  onRefresh: () => void
}) {
  const markdown = description
    ? description.markdown?.trim()
      ? description.markdown.trim()
      : formatPublishDescriptionMarkdown(description)
    : ""
  const sourceLabel = description
    ? lang === "zh"
      ? "已读取作品资料"
      : "Loaded from book assets"
    : loading
      ? lang === "zh"
        ? "读取真实资料中"
        : "Loading real assets"
      : lang === "zh"
        ? "等待真实资料"
        : "Waiting for real assets"

  return (
    <section
      data-testid="publish-copy-kit"
      className="border-primary/20 from-primary/10 via-card/80 to-background/80 mb-6 overflow-hidden rounded-2xl border bg-gradient-to-br shadow-lg shadow-primary/5"
    >
      <div className="border-border/40 flex items-start gap-3 border-b px-4 py-3">
        <span className="bg-primary/15 text-primary flex size-9 shrink-0 items-center justify-center rounded-xl">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">
              {lang === "zh" ? "站点资料复制台" : "Site copy kit"}
            </h2>
            <Badge variant="outline" className="text-[10px]">
              {sourceLabel}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
            {lang === "zh"
              ? "这里只展示后端读取或生成的站点资料；接口不可用时不会拼本地假文案。"
              : "Only backend-loaded or backend-generated site copy is shown here; no local fake copy is fabricated."}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 gap-1.5 px-2 text-[11px]"
          onClick={onGenerate}
          disabled={loading}
        >
          {loading ? (
            <RefreshCcw className="size-3 animate-spin" />
          ) : (
            <Sparkles className="size-3" />
          )}
          {lang === "zh" ? "生成简介" : "Generate"}
        </Button>
      </div>

      <div className="space-y-3 px-4 py-4">
        {description ? (
          <>
            <CopyBlock
              icon={<Sparkles className="size-3.5" />}
              label={lang === "zh" ? "一句话卖点" : "One-line hook"}
              text={description.oneLine}
              onCopy={() =>
                onCopy(lang === "zh" ? "一句话卖点" : "one-line hook", description.oneLine)
              }
            />
            <CopyBlock
              icon={<FileText className="size-3.5" />}
              label={lang === "zh" ? "短简介" : "Short intro"}
              text={description.shortIntro}
              onCopy={() =>
                onCopy(lang === "zh" ? "短简介" : "short intro", description.shortIntro)
              }
            />
            <CopyBlock
              icon={<Tags className="size-3.5" />}
              label={lang === "zh" ? "标签" : "Tags"}
              text={description.tags.join(" / ")}
              onCopy={() => onCopy(lang === "zh" ? "标签" : "tags", description.tags.join(" / "))}
            />

            <div className="border-border/40 bg-background/45 rounded-xl border p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[11px] font-medium">
                  {lang === "zh" ? "完整简介" : "Full intro"}
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    onClick={onRefresh}
                    disabled={loading}
                  >
                    <RefreshCcw className={cn("size-3", loading && "animate-spin")} />
                    {lang === "zh" ? "读取" : "Load"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    onClick={() => onCopy(lang === "zh" ? "完整简介" : "full intro", description.fullIntro)}
                  >
                    <Clipboard className="size-3" />
                    {lang === "zh" ? "复制" : "Copy"}
                  </Button>
                </div>
              </div>
              <p className="text-muted-foreground line-clamp-5 text-[12px] leading-relaxed">
                {description.fullIntro}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-[11px]"
                onClick={() => onCopy(lang === "zh" ? "整套站点资料" : "site kit", markdown)}
              >
                <Clipboard className="size-3" />
                {lang === "zh" ? "复制整套资料" : "Copy full kit"}
              </Button>
              {description.sellingPoints.map((point) => (
                <Badge
                  key={point}
                  variant="outline"
                  className="border-primary/20 bg-primary/5 text-[10px]"
                >
                  {point}
                </Badge>
              ))}
            </div>
          </>
        ) : (
          <div className="border-border/40 bg-background/45 rounded-xl border p-4">
            <div className="mb-3 flex items-start gap-3">
              <FileText className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <div className="text-[12px] font-medium">
                  {lang === "zh" ? "暂无真实站点资料" : "No real site copy yet"}
                </div>
                <p className="text-muted-foreground mt-1 text-[11px] leading-snug">
                  {lang === "zh"
                    ? "请读取后端保存的简介，或触发后端生成；这里不会用书名和字数临时拼一份假简介。"
                    : "Load saved backend copy or generate it through the backend; this view will not fabricate copy from title and word count."}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 px-2 text-[11px]"
                onClick={onRefresh}
                disabled={loading}
              >
                <RefreshCcw className={cn("size-3", loading && "animate-spin")} />
                {lang === "zh" ? "读取真实资料" : "Load real copy"}
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5 px-2 text-[11px]"
                onClick={onGenerate}
                disabled={loading}
              >
                <Sparkles className="size-3" />
                {lang === "zh" ? "后端生成" : "Generate via backend"}
              </Button>
            </div>
          </div>
        )}

        {error ? (
          <div className="border-status-error/30 bg-status-error/10 text-status-error rounded-lg border px-3 py-2 text-[11px]">
            {lang === "zh"
              ? "简介接口暂时不可用；没有使用本地假文案。"
              : "Description API unavailable; no local fake copy was used."}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function CopyBlock({
  icon,
  label,
  onCopy,
  text,
}: {
  icon: React.ReactNode
  label: string
  onCopy: () => void
  text: string
}) {
  return (
    <div className="border-border/40 bg-background/45 flex items-start gap-3 rounded-xl border p-3">
      <span className="text-primary mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-[11px] font-medium">{label}</div>
        <p className="text-muted-foreground line-clamp-2 text-[12px] leading-snug">
          {text}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
        onClick={onCopy}
      >
        <Clipboard className="size-3" />
        复制
      </Button>
    </div>
  )
}

function formatPublishDescriptionMarkdown(description: BookDescriptionPayload) {
  return [
    "# 一句话卖点",
    description.oneLine,
    "",
    "# 短简介",
    description.shortIntro,
    "",
    "# 完整简介",
    description.fullIntro,
    "",
    "# 卖点",
    ...description.sellingPoints.map((point) => `- ${point}`),
    "",
    "# 标签",
    description.tags.join(" / "),
    "",
    "# 平台备注",
    description.platformNotes,
  ].join("\n")
}

function ChapterStatusPip({ status }: { status: string }) {
  if (status === "done") return <CheckCircle2 className="text-status-success size-3.5 shrink-0" />
  if (status === "published") return <CheckCircle2 className="text-primary size-3.5 shrink-0" />
  return <XCircle className="text-muted-foreground/40 size-3.5 shrink-0" />
}

function ChannelIcon({ name }: { name: string }) {
  const initials = name.slice(0, 2)
  return (
    <span className="bg-secondary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-mono text-[11px] font-semibold">
      {initials}
    </span>
  )
}

function ChannelStatusBadge({ status, lang }: { status: string; lang: string }) {
  const map: Record<string, { label: { zh: string; en: string }; cls: string }> = {
    published: { label: { zh: "已发布", en: "Published" }, cls: "border-status-success/30 bg-status-success/10 text-status-success" },
    released: { label: { zh: "已发布", en: "Released" }, cls: "border-status-success/30 bg-status-success/10 text-status-success" },
    queue: { label: { zh: "待发布", en: "Queued" }, cls: "border-status-queued/30 bg-status-queued/10 text-status-queued" },
    draft: { label: { zh: "草稿", en: "Draft" }, cls: "border-border bg-secondary/40 text-muted-foreground" },
  }
  const s = map[status] ?? map.draft
  return (
    <Badge variant="outline" className={cn("shrink-0 text-[9px]", s.cls)}>
      {s.label[lang as "zh" | "en"]}
    </Badge>
  )
}
