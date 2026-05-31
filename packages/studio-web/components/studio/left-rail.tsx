"use client"

import * as React from "react"
import {
  AlertCircle,
  BookOpen,
  FileText,
  Globe,
  Library,
  Plus,
  Sparkles,
  Users,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { useT, useLocale } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { useWorkspace } from "@/lib/workspace-context"
import { BookSwitcher } from "@/components/shell/book-switcher"
import {
  useAssets,
  useAutoRuns,
  useCast,
  useChapters,
  useWorld,
} from "@/hooks/use-studio"
import { type Chapter } from "@/lib/studio-data"
import { getBookReadiness } from "@/lib/studio/book-readiness"
import { latestActiveBookRun } from "@/lib/studio/run-state"

export function LeftRail() {
  const { leftCollapsed, leftWidth } = useStudio()

  if (leftCollapsed) return <LeftRailCollapsed />

  return (
    <aside
      style={{ width: leftWidth }}
      className={cn(
        "bg-sidebar border-border hidden h-full shrink-0 flex-col border-r md:flex",
      )}
    >
      <BookHeader />
      <Tabs defaultValue="chapters" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="bg-transparent h-9 w-full justify-start gap-1 rounded-none border-b border-border px-3 py-0">
          <TabRail value="chapters" icon={BookOpen} labelKey="left.tabs.chapters" />
          <TabRail value="cast" icon={Users} labelKey="left.tabs.cast" />
          <TabRail value="world" icon={Globe} labelKey="left.tabs.world" />
          <TabRail value="assets" icon={Library} labelKey="left.tabs.assets" />
        </TabsList>
        <TabsContent value="chapters" className="m-0 min-h-0 flex-1">
          <ChaptersTab />
        </TabsContent>
        <TabsContent value="cast" className="m-0 min-h-0 flex-1">
          <CastTab />
        </TabsContent>
        <TabsContent value="world" className="m-0 min-h-0 flex-1">
          <WorldTab />
        </TabsContent>
        <TabsContent value="assets" className="m-0 min-h-0 flex-1">
          <AssetsTab />
        </TabsContent>
      </Tabs>
    </aside>
  )
}

function LeftRailCollapsed() {
  const { setLeft } = useStudio()
  return (
    <aside className="bg-sidebar border-border hidden h-full w-12 shrink-0 flex-col items-center gap-1 border-r py-3 md:flex">
      {[
        { icon: BookOpen, key: "left.tabs.chapters" },
        { icon: Users, key: "left.tabs.cast" },
        { icon: Globe, key: "left.tabs.world" },
        { icon: Library, key: "left.tabs.assets" },
      ].map((it, i) => {
        const Icon = it.icon
        return (
          <Button
            key={i}
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setLeft(false)}
          >
            <Icon className="size-4" />
          </Button>
        )
      })}
    </aside>
  )
}

function BookHeader() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { currentBook, resourcesBlocked, title, detail } = useCurrentBookReadiness()
  const { bookId, currentChapter, selectedChapter } = useStudio()
  const { data: autoRuns } = useAutoRuns()
  const activeRun = latestActiveBookRun(autoRuns, bookId, currentChapter + 1)
  const shouldFollowActiveRun = selectedChapter === null
  const displayChapter =
    shouldFollowActiveRun && activeRun?.currentChapter && activeRun.currentChapter > currentChapter
      ? activeRun.currentChapter
      : currentChapter
  const bookKind = currentBook?.kindLabel?.[lang] ?? "长篇小说"
  const plannedChapters = currentBook?.plannedChapters ?? currentBook?.chapterCount ?? 0
  const currentProgress =
    plannedChapters > 0
      ? `${bookKind} · 第 ${displayChapter} / ${plannedChapters}`
      : `${bookKind} · 第 ${displayChapter} 章`
  return (
    <div className="border-border flex flex-col gap-1.5 border-b px-2.5 py-2.5">
      {/* 项目/作品切换器（仿参考图左栏顶部的项目下拉） */}
      <BookSwitcher />
      <p className="text-muted-foreground truncate px-1 text-[11px]">
        {resourcesBlocked ? detail : currentProgress}
      </p>
    </div>
  )
}

function useCurrentBookReadiness() {
  const { bookId } = useStudio()
  const { books } = useWorkspace()
  const currentBook = books.find((book) => book.id === bookId)
  const readiness = getBookReadiness(currentBook)

  return { currentBook, ...readiness }
}

function ResourceBlocked({
  title,
  description,
}: {
  title: string
  description: string
}) {
  const { setMode } = useStudio()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
        <div className="border-status-warning/30 bg-status-warning/10 flex size-10 items-center justify-center rounded-full border">
          <AlertCircle className="size-5 text-status-warning" />
        </div>
        <div>
          <div className="text-sm font-medium">{title}</div>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            {description}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setMode("new")}>
          回到建书
        </Button>
      </div>
    </div>
  )
}

function TabRail({
  value,
  icon: Icon,
  labelKey,
}: {
  value: string
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
}) {
  const t = useT()
  return (
    <TabsTrigger
      value={value}
      className="data-[state=active]:bg-secondary data-[state=active]:text-foreground text-muted-foreground h-7 gap-1 rounded-md px-2 text-xs font-normal data-[state=active]:shadow-none"
    >
      <Icon className="size-3.5" />
      <span className="hidden sm:inline">{t(labelKey)}</span>
    </TabsTrigger>
  )
}

function ChaptersTab() {
  const t = useT()
  const { locale } = useLocale()
  const {
    bookId,
    currentChapter,
    selectedChapter,
    setCurrentChapter,
    setMode,
  } = useStudio()
  const { resourcesBlocked } = useCurrentBookReadiness()
  const { data: chapters } = useChapters(bookId)
  const { data: autoRuns } = useAutoRuns()
  const activeRun = latestActiveBookRun(autoRuns, bookId, currentChapter + 1)
  const runningChapter =
    activeRun?.currentChapter && activeRun.currentChapter > currentChapter
      ? activeRun.currentChapter
      : undefined
  const selectedDisplayChapter =
    selectedChapter === null ? (runningChapter ?? currentChapter) : currentChapter
  const visibleChapters = React.useMemo(() => {
    const list = chapters ?? []
    if (!runningChapter || list.some((chapter) => chapter.num === runningChapter)) {
      return list
    }
    return [
      ...list,
      {
        id: `${bookId}:running:${runningChapter}`,
        num: runningChapter,
        title: {
          zh: `第 ${runningChapter} 章生成中`,
          en: `Chapter ${runningChapter} generating`,
        },
        words: activeRun?.currentWords ?? 0,
        status: "writing" as const,
        active: true,
      },
    ].sort((a, b) => a.num - b.num)
  }, [activeRun?.currentWords, bookId, chapters, runningChapter])

  if (resourcesBlocked) {
    return (
      <ResourceBlocked
        title="还没有可写章节"
        description="当前书籍未通过建书地基，章节列表暂停显示，避免混入旧书章节。"
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="flex-1">
        <ol className="space-y-0.5 p-2">
          {visibleChapters.map((c) => (
            <ChapterRow
              key={c.id}
              chapter={c}
              locale={locale}
              selected={c.num === selectedDisplayChapter}
              running={c.num === runningChapter}
              onSelect={() => {
                setCurrentChapter(c.num)
                setMode("write")
              }}
            />
          ))}
        </ol>
      </ScrollArea>
      <div className="border-border border-t p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-1.5 bg-transparent text-xs"
          disabled
          title="当前后端没有单独创建空章节接口；请用底部“向下写 + 自动复修”生成下一章。"
        >
          <Plus className="size-3.5" />
          {t("left.chapters.new")}（用向下写生成）
        </Button>
      </div>
    </div>
  )
}

function ChapterRow({
  chapter,
  locale,
  selected,
  running = false,
  onSelect,
}: {
  chapter: Chapter
  locale: "zh-CN" | "en"
  selected: boolean
  running?: boolean
  onSelect: () => void
}) {
  const status = chapter.status
  const lang = locale === "en" ? "en" : "zh"
  return (
    <li>
      <button
        type="button"
        className={cn(
          "group hover:bg-secondary/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
          selected && "bg-primary/10 ring-1 ring-primary/20",
          running && "bg-status-running/10 ring-1 ring-status-running/30",
        )}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
      >
        <span
          className={cn(
            "text-muted-foreground/80 w-7 shrink-0 font-mono text-[10px]",
            selected && "text-primary",
          )}
        >
          Ch.{String(chapter.num).padStart(2, "0")}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {chapter.title[lang]}
        </span>
        {/* 降噪：参考图的树没有任何状态点；这里只在"写作中"留一个跳动小点 */}
        {running && (
          <span className="bg-status-running size-1.5 shrink-0 animate-pulse rounded-full" />
        )}
      </button>
    </li>
  )
}

function DisabledCreateButton({ label }: { label: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full justify-start gap-1.5 bg-transparent text-xs"
      disabled
      title="当前后端暂未提供创建接口"
    >
      <Plus className="size-3.5" />
      {label}
    </Button>
  )
}

function ChapterStatus({ status }: { status: Chapter["status"] }) {
  const map: Record<Chapter["status"], { color: string; pulse?: boolean }> = {
    draft: { color: "bg-muted-foreground/40" },
    writing: { color: "bg-status-running", pulse: true },
    done: { color: "bg-status-success" },
    queued: { color: "bg-status-paused" },
    review: { color: "bg-status-warning" },
    published: { color: "bg-primary" },
  }
  const s = map[status]
  return (
    <span className="relative inline-flex shrink-0">
      <span className={cn("h-1.5 w-1.5 rounded-full", s.color)} />
      {s.pulse && (
        <span
          className={cn(
            "absolute inset-0 inline-flex rounded-full opacity-30 ring-2 ring-status-running/40",
            s.color,
          )}
        />
      )}
    </span>
  )
}

function CastTab() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId } = useStudio()
  const { resourcesBlocked } = useCurrentBookReadiness()
  const { data: cast } = useCast(bookId)

  if (resourcesBlocked) {
    return (
      <ResourceBlocked
        title="角色表待生成"
        description="建书完成后会读取这本书自己的角色表。"
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="flex-1">
        <ul className="space-y-1 p-2">
          {(cast ?? []).map((c) => (
            <li
              key={c.id}
              className="hover:bg-secondary/60 flex items-center gap-2.5 rounded-md p-2 transition-colors"
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-primary-foreground"
                style={{ background: c.color as string }}
              >
                {c.name.zh.slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{c.name[lang]}</div>
                <div className="text-muted-foreground truncate text-[10px]">
                  {c.role[lang]}
                </div>
              </div>
              <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                {Math.round(c.arc * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div className="border-border border-t p-2">
        <DisabledCreateButton label={t("left.cast.new")} />
      </div>
    </div>
  )
}

function WorldTab() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId } = useStudio()
  const { resourcesBlocked } = useCurrentBookReadiness()
  const { data: world } = useWorld(bookId)

  if (resourcesBlocked) {
    return (
      <ResourceBlocked
        title="世界观待生成"
        description="建书地基通过前不会展示其它作品的设定。"
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="flex-1">
        <ul className="space-y-1 p-2">
          {(world ?? []).map((w) => (
            <li
              key={w.id}
              className="hover:bg-secondary/60 flex items-center justify-between gap-2 rounded-md p-2.5 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Globe className="text-primary/70 size-3.5 shrink-0" />
                <span className="truncate text-xs">{w.title[lang]}</span>
              </div>
              <Badge
                variant="secondary"
                className="bg-secondary/60 shrink-0 font-mono text-[10px]"
              >
                {w.count}
              </Badge>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div className="border-border border-t p-2">
        <DisabledCreateButton label={t("left.world.new")} />
      </div>
    </div>
  )
}

function AssetsTab() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId } = useStudio()
  const { resourcesBlocked } = useCurrentBookReadiness()
  const { data: assets } = useAssets(bookId)

  if (resourcesBlocked) {
    return (
      <ResourceBlocked
        title="素材库待生成"
        description="新书创建完成后才会加载它自己的素材。"
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="flex-1">
        <ul className="space-y-0.5 p-2">
          {(assets ?? []).map((a) => (
            <li
              key={a.id}
              className="hover:bg-secondary/60 flex items-center gap-2 rounded-md p-2 text-xs transition-colors"
            >
              <FileText className="text-muted-foreground size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{a.name[lang]}</span>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div className="border-border border-t p-2">
        <DisabledCreateButton label={t("left.assets.new")} />
      </div>
    </div>
  )
}
