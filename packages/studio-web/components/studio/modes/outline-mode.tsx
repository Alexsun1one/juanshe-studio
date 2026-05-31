"use client"

import * as React from "react"
import {
  ChevronRight,
  CheckCircle2,
  GripVertical,
  ListTree,
  Loader2,
  Plus,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { useT, useLocale } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { createAutoRun, validateBookFoundation } from "@/lib/api/client"
import type { BookFoundationValidateResult } from "@/lib/api/types"
import { useOutline, useProjectPrefs } from "@/hooks/use-studio"
import { useToast } from "@/hooks/use-toast"

const FOUNDATION_GOAL_CHAPTERS = 3

export function OutlineMode() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { setMode, setAi, bookId, currentChapter } = useStudio()
  const { data: outline } = useOutline(bookId)
  const { data: prefs } = useProjectPrefs()
  const { toast } = useToast()
  const [creating, setCreating] = React.useState(false)
  const [foundationGate, setFoundationGate] =
    React.useState<BookFoundationValidateResult | null>(null)
  const acts = outline ?? []

  async function handleNewChapter() {
    if (creating) return
    setCreating(true)
    setFoundationGate(null)
    try {
      const nextChapter = currentChapter + 1
      const outlineMaxChapter = acts.reduce(
        (max, act) =>
          Math.max(max, ...act.chapters.map((chapter) => chapter.num)),
        nextChapter,
      )
      const toChapter = Math.max(
        nextChapter,
        Math.min(outlineMaxChapter, nextChapter + FOUNDATION_GOAL_CHAPTERS - 1),
      )
      const goalChapters = Math.max(1, toChapter - nextChapter + 1)
      setAi("running")
      const gate = await validateBookFoundation(bookId)
      setFoundationGate(gate)
      if (gate.ok === false || !gate.ready) {
        setAi("idle")
        const blockers = foundationBlockers(gate)
        toast({
          title:
            lang === "en"
              ? "Foundation blocked. Writing stopped"
              : "地基未达标，已停止连写",
          description:
            lang === "en"
              ? `Score ${gate.score ?? "—"}. ${blockers || gate.failureReason || gate.suggestion || "Please repair the foundation first."}`
              : `验收分 ${gate.score ?? "—"}。${blockers || gate.failureReason || gate.suggestion || "请先补齐地基后再开写。"}`,
          variant: "destructive",
        })
        return
      }
      const run = await createAutoRun({
        bookId,
        fromChapter: nextChapter,
        toChapter,
        targetWordsPerChapter:
          prefs?.defaultRun.targetWordsPerChapter ?? 3000,
        targetQuality: prefs?.defaultRun.targetQuality ?? 90,
        maxRewritesPerChapter:
          prefs?.defaultRun.maxRewritesPerChapter ?? 2,
      })
      setMode("write")
      toast({
        title:
          lang === "en"
            ? `Foundation passed. Goal ${goalChapters} chapters started`
            : `地基验收通过，Goal 连写 ${goalChapters} 章已启动`,
        description:
          lang === "en"
            ? `Score ${gate.score ?? "—"}. Chapter ${nextChapter}-${toChapter}. Quality gate and auto-rewrite are enabled.${gate.repaired.length ? ` Repaired ${gate.repaired.length}.` : ""}${run.id ? ` run_id: ${run.id.slice(0, 14)}` : ""}`
            : `验收分 ${gate.score ?? "—"}。第 ${nextChapter}-${toChapter} 章 · 目标分与自动复修已启用。${gate.repaired.length ? `已自动修复 ${gate.repaired.length} 项。` : ""}${run.id ? ` run_id: ${run.id.slice(0, 14)}` : ""}`,
      })
    } catch (error) {
      setAi("idle")
      toast({
        title: lang === "en" ? "Start failed" : "启动失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/40 bg-background/60 flex items-center gap-3 border-b px-6 py-3 backdrop-blur-sm md:px-10">
        <ListTree className="text-primary size-5" />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight md:text-lg">
            {t("outline.title")}
          </h1>
          <p className="text-muted-foreground text-xs">
            {t("outline.subtitle")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="bg-transparent gap-1.5"
          disabled={creating}
          onClick={handleNewChapter}
        >
          {creating ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          <span className="hidden sm:inline text-xs">
            {t("outline.newChapter")}
          </span>
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-4xl space-y-8 px-6 py-8 md:px-10">
          <FoundationGatePanel
            creating={creating}
            targetQuality={prefs?.defaultRun.targetQuality}
            targetWords={prefs?.defaultRun.targetWordsPerChapter}
            maxRewrites={prefs?.defaultRun.maxRewritesPerChapter}
            goalChapters={FOUNDATION_GOAL_CHAPTERS}
            gate={foundationGate}
            onStart={handleNewChapter}
          />

          {acts.map((act, ai) => (
            <section key={act.actId}>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-primary font-mono text-xs">
                  {String(ai + 1).padStart(2, "0")}
                </span>
                <h2 className="font-serif text-xl font-semibold tracking-tight">
                  {act.actTitle[lang]}
                </h2>
                <span className="bg-border/60 ml-2 h-px flex-1" />
                <Badge variant="outline" className="bg-secondary/40 text-[10px]">
                  {act.chapters.length} {t("common.chapter")}
                </Badge>
              </div>

              <ul className="grid gap-2 sm:grid-cols-2">
                {act.chapters.map((c) => (
                  <li
                    key={c.id}
                    className={cn(
                      "group border-border/60 hover:border-primary/40 hover:bg-card relative flex flex-col gap-2 rounded-xl border bg-card/40 p-4 transition-all",
                      c.status === "writing" &&
                        "border-status-running/40 bg-status-running/5 ring-1 ring-status-running/20",
                    )}
                  >
                    <button
                      className="text-muted-foreground/40 hover:text-muted-foreground absolute left-1 top-3 hidden cursor-grab sm:block"
                      aria-label="拖动排序"
                    >
                      <GripVertical className="size-3.5" />
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground/80 font-mono text-[11px]">
                        Ch.{String(c.num).padStart(2, "0")}
                      </span>
                      <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
                        {c.title[lang]}
                      </h3>
                      <ChapterStatusBadge status={c.status} />
                    </div>
                    <div className="text-muted-foreground flex items-center justify-between text-[11px]">
                      <span>
                        {t("outline.beats")}{" "}
                        <span className="text-foreground font-mono">
                          {c.beats}
                        </span>
                      </span>
                      <span>
                        {t("outline.estWords")}{" "}
                        <span className="text-foreground font-mono">
                          {c.words > 0
                            ? `${c.words.toLocaleString()}`
                            : "—"}
                        </span>
                      </span>
                    </div>
                    {/* beats mini bars */}
                    <div className="flex h-1 gap-0.5">
                      {Array.from({ length: c.beats }).map((_, bi) => (
                        <span
                          key={bi}
                          className={cn(
                            "flex-1 rounded-full",
                            c.status === "done"
                              ? "bg-status-success/70"
                              : c.status === "writing" && bi < 2
                                ? "bg-status-running"
                                : "bg-border/60",
                          )}
                        />
                      ))}
                    </div>
                    {c.status === "writing" && (
                      <button
                        onClick={() => setMode("write")}
                        className="text-primary mt-1 inline-flex items-center gap-1 text-[11px] font-medium hover:underline"
                      >
                        <Sparkles className="size-3" />
                        进入写作
                        <ChevronRight className="size-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function FoundationGatePanel({
  creating,
  targetQuality = 85,
  targetWords = 3000,
  maxRewrites = 3,
  goalChapters,
  gate,
  onStart,
}: {
  creating: boolean
  targetQuality?: number
  targetWords?: number
  maxRewrites?: number
  goalChapters: number
  gate: BookFoundationValidateResult | null
  onStart: () => void
}) {
  const checkpoints = [
    "世界观和主线冲突已落档",
    "角色动机与关系链可追踪",
    "伏笔账本已进入后续回收",
    `单章约 ${targetWords.toLocaleString()} 字`,
    `质量低于 ${targetQuality} 会先复修`,
  ]

  return (
    <section
      data-testid="foundation-gate"
      className="border-primary/25 from-primary/8 via-card to-accent/8 overflow-hidden rounded-2xl border bg-gradient-to-br"
    >
      <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
        <div className="bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-2xl">
          <ShieldCheck className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">
              地基确认后再开写
            </h2>
            <Badge
              variant="outline"
              className="border-status-success/30 bg-status-success/10 text-status-success text-[10px]"
            >
              自动复修开启
            </Badge>
            {gate && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  gate.ready
                    ? "border-status-success/30 bg-status-success/10 text-status-success"
                    : "border-status-error/30 bg-status-error/10 text-status-error",
                )}
              >
                验收 {gate.score ?? "—"} 分
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            这里是旧流式工作台的确认闸门：确认大纲、伏笔和人物动机后才进正文；不达标先修，不会一口气往下灌。
          </p>
          {gate && (
            <p className="mt-2 text-xs leading-relaxed">
              {gate.ready ? (
                <span className="text-status-success">
                  已通过地基验收
                  {gate.repaired.length > 0
                    ? `，并自动修复 ${gate.repaired.length} 项`
                    : "，可以进入写作"}
                </span>
              ) : (
                <span className="text-status-error">
                  已拦截：{foundationBlockers(gate) || "地基信息不足，请先补齐后再启动。"}
                </span>
              )}
            </p>
          )}
        </div>
        <Button
          onClick={onStart}
          disabled={creating}
          className="from-primary to-primary/80 shrink-0 gap-1.5 bg-gradient-to-r shadow-md shadow-primary/20"
          title={`质量目标≥${targetQuality}，最多复修 ${maxRewrites} 次；未达标会先修。`}
        >
          {creating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          确认并 Goal 连写 {goalChapters} 章
        </Button>
      </div>
      <div className="border-border/40 grid gap-2 border-t p-3 sm:grid-cols-5">
        {checkpoints.map((item, index) => (
          <div
            key={item}
            className="border-border/40 bg-background/40 flex min-h-20 flex-col gap-2 rounded-xl border p-3"
          >
            <div className="flex items-center gap-2">
              {index === checkpoints.length - 1 ? (
                <Target className="text-primary size-3.5" />
              ) : (
                <CheckCircle2 className="text-status-success size-3.5" />
              )}
              <span className="font-mono text-[10px] text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
            </div>
            <p className="text-[11px] leading-relaxed">{item}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function foundationBlockers(gate: BookFoundationValidateResult) {
  const blockers = gate.blockers.length
    ? gate.blockers
    : gate.assessment?.blockers ?? []
  return blockers.slice(0, 3).join("；")
}

function ChapterStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    done: {
      label: "已完成",
      className: "bg-status-success/10 text-status-success border-status-success/30",
    },
    writing: {
      label: "运行中",
      className: "bg-status-running/10 text-status-running border-status-running/30",
    },
    draft: {
      label: "草稿",
      className: "bg-secondary/60 text-muted-foreground border-border",
    },
  }
  const s = map[status] ?? map.draft
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 px-1.5 py-0 text-[9px]", s.className)}
    >
      {s.label}
    </Badge>
  )
}
