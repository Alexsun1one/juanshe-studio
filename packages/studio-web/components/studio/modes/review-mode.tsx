"use client"

import * as React from "react"
import { AlertTriangle, CheckCircle2, Info, ScanSearch, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { useT, useLocale } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { useManuscript, useReviewIssues } from "@/hooks/use-studio"
import { type ReviewIssue } from "@/lib/studio-data"

export function ReviewMode() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId, currentChapter } = useStudio()
  const { data: manuscript } = useManuscript(bookId, currentChapter)
  const { data: issues } = useReviewIssues(bookId, currentChapter)
  const paragraphs = manuscript?.paragraphs ?? []
  const allIssues = issues ?? []
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set())
  const [fixed, setFixed] = React.useState<Set<string>>(new Set())

  const active = allIssues.filter((r) => !dismissed.has(r.id) && !fixed.has(r.id))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div className="border-border/40 bg-background/60 flex items-center gap-3 border-b px-6 py-3 backdrop-blur-sm md:px-10">
        <ScanSearch className="text-primary size-5" />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight md:text-lg">
            {t("review.title")}
          </h1>
          <p className="text-muted-foreground text-xs">{t("review.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <IssueSummary issues={allIssues} fixed={fixed} dismissed={dismissed} />
        </div>
      </div>

      {/* two-column layout: manuscript + issues panel */}
      <div className="flex min-h-0 flex-1 gap-0">
        {/* manuscript with inline annotations */}
        <ScrollArea className="min-h-0 flex-1">
          <article className="prose-manuscript mx-auto max-w-[64ch] px-6 py-10 md:px-10 md:py-14">
            {paragraphs.map((p, i) => {
              // find issues that match this paragraph by excerpt
              const paraIssues = allIssues.filter((r) => {
                const excerpt = r.excerpt[lang]
                return p[lang].includes(excerpt.slice(0, 8))
              })
              return (
                <div key={i} className="group relative">
                  <p
                    className={cn(
                      "animate-ink-in",
                      p.quote && "quote-line",
                      paraIssues.length > 0 &&
                        "rounded-sm bg-status-warning/8 ring-1 ring-status-warning/20",
                    )}
                    style={{ animationDelay: `${i * 20}ms` }}
                  >
                    {p[lang]}
                  </p>
                  {/* inline issue badges */}
                  {paraIssues.map((r) => {
                    if (dismissed.has(r.id) || fixed.has(r.id)) return null
                    return (
                      <InlineIssueBadge
                        key={r.id}
                        issue={r}
                        lang={lang}
                        onFix={() => setFixed((s) => new Set([...s, r.id]))}
                        onDismiss={() => setDismissed((s) => new Set([...s, r.id]))}
                      />
                    )
                  })}
                </div>
              )
            })}
            <div className="h-4" />
          </article>
        </ScrollArea>

        {/* issues sidebar */}
        <aside className="border-border/40 bg-sidebar/60 hidden w-72 shrink-0 flex-col border-l lg:flex">
          <div className="border-border/40 flex items-center justify-between border-b px-4 py-2.5">
            <span className="text-xs font-semibold">
              {active.length} {lang === "zh" ? "条待处理" : "pending"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() =>
                setFixed(
                  (current) =>
                    new Set([...current, ...active.map((issue) => issue.id)]),
                )
              }
              disabled={active.length === 0}
            >
              {lang === "zh" ? "本页全标记" : "Mark all"}
            </Button>
          </div>
          <p className="border-border/40 text-muted-foreground border-b px-4 py-2 text-[10px] leading-relaxed">
            {lang === "zh"
              ? "这里不会自动改正文，只记录本页处理状态。"
              : "This does not edit the manuscript; it only marks items in this view."}
          </p>
          <ScrollArea className="flex-1">
            <ul className="space-y-2 p-3">
              {allIssues.map((r) => (
                <IssueCard
                  key={r.id}
                  issue={r}
                  lang={lang}
                  isFixed={fixed.has(r.id)}
                  isDismissed={dismissed.has(r.id)}
                  onFix={() => setFixed((s) => new Set([...s, r.id]))}
                  onDismiss={() => setDismissed((s) => new Set([...s, r.id]))}
                />
              ))}
            </ul>
          </ScrollArea>

          {/* quality summary bar */}
          <QualitySummary lang={lang} fixedCount={fixed.size} total={allIssues.length} />
        </aside>
      </div>
    </div>
  )
}

function InlineIssueBadge({
  issue,
  lang,
  onFix,
  onDismiss,
}: {
  issue: ReviewIssue
  lang: "zh" | "en"
  onFix: () => void
  onDismiss: () => void
}) {
  const colors: Record<ReviewIssue["severity"], string> = {
    high: "bg-status-error/10 text-status-error border-status-error/30",
    med: "bg-status-warning/10 text-status-warning border-status-warning/30",
    low: "bg-secondary/60 text-muted-foreground border-border",
  }
  return (
    <div
      className={cn(
        "mt-1 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] transition-all animate-ink-in",
        colors[issue.severity],
      )}
    >
      <SeverityIcon severity={issue.severity} className="mt-0.5 size-3.5 shrink-0" />
      <span className="flex-1 leading-snug">{issue.note[lang]}</span>
      <span className="text-muted-foreground/70 shrink-0 text-[10px]">{issue.agent[lang]}</span>
      <button
        onClick={onFix}
        className="ml-1 shrink-0 rounded px-1 py-0.5 font-medium hover:bg-black/5 dark:hover:bg-white/10"
        title={lang === "zh" ? "标记已处理，不改正文" : "Mark handled; manuscript unchanged"}
      >
        <CheckCircle2 className="size-3" />
      </button>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
        title={lang === "zh" ? "忽略" : "Dismiss"}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function IssueCard({
  issue,
  lang,
  isFixed,
  isDismissed,
  onFix,
  onDismiss,
}: {
  issue: ReviewIssue
  lang: "zh" | "en"
  isFixed: boolean
  isDismissed: boolean
  onFix: () => void
  onDismiss: () => void
}) {
  const colors: Record<ReviewIssue["severity"], string> = {
    high: "border-status-error/30 bg-status-error/5",
    med: "border-status-warning/30 bg-status-warning/5",
    low: "border-border bg-card/40",
  }
  return (
    <li
      className={cn(
        "rounded-lg border p-3 text-[11px] transition-all",
        isFixed
          ? "border-status-success/30 bg-status-success/5 opacity-60"
          : isDismissed
            ? "opacity-30"
            : colors[issue.severity],
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <SeverityIcon severity={issue.severity} className="size-3" />
        <SeverityLabel severity={issue.severity} lang={lang} />
        <span className="text-muted-foreground ml-auto text-[10px]">{issue.agent[lang]}</span>
      </div>
      <blockquote className="text-foreground/60 border-border/60 mb-1.5 border-l-2 pl-2 font-serif italic leading-snug">
        {issue.excerpt[lang]}
      </blockquote>
      <p className="text-foreground/80 leading-snug">{issue.note[lang]}</p>
      {!isFixed && !isDismissed && (
        <div className="mt-2 flex gap-1.5">
          <Button size="sm" className="h-6 flex-1 text-[10px]" onClick={onFix}>
            <CheckCircle2 className="size-3" />
            {lang === "zh" ? "标记已处理" : "Mark handled"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={onDismiss}
          >
            {lang === "zh" ? "忽略" : "Skip"}
          </Button>
        </div>
      )}
      {isFixed && (
        <div className="text-status-success mt-1 flex items-center gap-1 text-[10px]">
          <CheckCircle2 className="size-3" />
          {lang === "zh" ? "本页已标记" : "Marked in this view"}
        </div>
      )}
    </li>
  )
}

function IssueSummary({
  issues,
  fixed,
  dismissed,
}: {
  issues: ReviewIssue[]
  fixed: Set<string>
  dismissed: Set<string>
}) {
  const high = issues.filter((r) => r.severity === "high" && !fixed.has(r.id) && !dismissed.has(r.id)).length
  const med = issues.filter((r) => r.severity === "med" && !fixed.has(r.id) && !dismissed.has(r.id)).length
  return (
    <div className="flex items-center gap-1.5">
      {high > 0 && (
        <Badge variant="outline" className="border-status-error/40 bg-status-error/10 text-status-error gap-1 text-[10px]">
          <AlertTriangle className="size-2.5" />
          {high}
        </Badge>
      )}
      {med > 0 && (
        <Badge variant="outline" className="border-status-warning/40 bg-status-warning/10 text-status-warning gap-1 text-[10px]">
          <Info className="size-2.5" />
          {med}
        </Badge>
      )}
    </div>
  )
}

function SeverityIcon({ severity, className }: { severity: ReviewIssue["severity"]; className?: string }) {
  if (severity === "high") return <AlertTriangle className={cn("text-status-error", className)} />
  if (severity === "med") return <Info className={cn("text-status-warning", className)} />
  return <Info className={cn("text-muted-foreground", className)} />
}

function SeverityLabel({ severity, lang }: { severity: ReviewIssue["severity"]; lang: "zh" | "en" }) {
  const labels: Record<ReviewIssue["severity"], Record<string, string>> = {
    high: { zh: "严重", en: "Critical" },
    med: { zh: "警告", en: "Warning" },
    low: { zh: "信息", en: "Info" },
  }
  const color =
    severity === "high"
      ? "text-status-error"
      : severity === "med"
        ? "text-status-warning"
        : "text-muted-foreground"
  return <span className={cn("font-semibold", color)}>{labels[severity][lang]}</span>
}

function QualitySummary({ lang, fixedCount, total }: { lang: "zh" | "en"; fixedCount: number; total: number }) {
  const pct = total === 0 ? 100 : Math.round((fixedCount / total) * 100)
  return (
    <div className="border-border/40 border-t px-4 py-3">
      <div className="mb-1 flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">{lang === "zh" ? "本页标记" : "Marked here"}</span>
        <span className="font-mono font-medium">{pct}%</span>
      </div>
      <div className="bg-secondary/60 h-1.5 overflow-hidden rounded-full">
        <div
          className="bg-status-success h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
