"use client"

import * as React from "react"
import { ArrowLeftRight, Check, Loader2, Sparkles, X } from "lucide-react"
import { mutate } from "swr"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useT, useLocale } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { saveManuscript } from "@/lib/api/client"
import { useRewriteProposal } from "@/hooks/use-studio"
import { useToast } from "@/hooks/use-toast"

const STYLES = [
  { id: "tighten", key: "rewrite.styles.tighten" },
  { id: "lyric", key: "rewrite.styles.lyric" },
  { id: "dialog", key: "rewrite.styles.dialog" },
  { id: "sensory", key: "rewrite.styles.sensory" },
] as const

type LocalizedText = string | { zh?: string; en?: string } | null | undefined

function pickLocalizedText(value: LocalizedText, lang: "zh" | "en") {
  if (typeof value === "string") return value
  return value?.[lang] ?? value?.zh ?? value?.en ?? ""
}

export function RewriteMode() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId, currentChapter, setMode } = useStudio()
  const { toast } = useToast()
  const [active, setActive] = React.useState<string>("tighten")
  const [busy, setBusy] = React.useState(false)
  const {
    data: proposal,
    error: proposalError,
    isLoading: proposalLoading,
  } = useRewriteProposal(bookId, currentChapter, active)

  const originalText = pickLocalizedText(proposal?.original, lang)
  const revisedText = pickLocalizedText(proposal?.revised, lang)
  const hasProposalText =
    originalText.trim().length > 0 || revisedText.trim().length > 0

  async function handleAccept() {
    if (busy || !revisedText.trim()) return
    setBusy(true)
    try {
      const saved = await saveManuscript(bookId, currentChapter, {
        content: revisedText,
        locale: lang,
      })
      await mutate(["manuscript", bookId, currentChapter], saved, {
        revalidate: false,
      })
      await mutate(["rewrite-proposal", bookId, currentChapter, active])
      setMode("write")
      toast({
        title: lang === "en" ? "Rewrite accepted" : "已采纳改写",
        description:
          lang === "en"
            ? "The revised chapter was saved to the manuscript."
            : "改写稿已写回当前章节正文。",
      })
    } catch (error) {
      toast({
        title: lang === "en" ? "Rewrite failed" : "复修失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  function renderPane(text: string, tone: "original" | "revised") {
    if (proposalLoading) {
      return (
        <div className="text-muted-foreground flex min-h-[220px] items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {lang === "en" ? "Loading rewrite proposal..." : "正在读取改写提案..."}
        </div>
      )
    }

    if (proposalError || !hasProposalText) {
      return (
        <div className="border-border/70 bg-muted/20 text-muted-foreground flex min-h-[220px] flex-col justify-center rounded-md border px-5 py-4 text-sm leading-7">
          <p className="text-foreground font-medium">
            {lang === "en"
              ? "No rewrite proposal available"
              : "当前章节没有可用改写稿"}
          </p>
          <p className="mt-2">
            {lang === "en"
              ? `Chapter ${currentChapter} was not found in the manuscript store, or the backend failed to return a proposal.`
              : `第 ${currentChapter} 章没有在正文库中找到，或后端没有返回改写提案。`}
          </p>
        </div>
      )
    }

    return (
      <div
        className={cn(
          "prose-manuscript",
          tone === "revised" && "animate-ink-in",
        )}
      >
        <p>{text}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* style selector */}
      <div className="border-border/50 bg-card/30 flex flex-wrap items-center gap-2 border-b px-5 py-3">
        <ArrowLeftRight className="text-primary size-4" />
        <span className="text-xs font-semibold">{t("rewrite.style")}</span>
        <div className="bg-secondary/60 ml-2 inline-flex gap-0.5 rounded-md p-0.5">
          {STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                active === s.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(s.key)}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground ml-auto inline-flex items-center gap-1 text-[11px]">
          <Sparkles className="size-3" />
          润色师 + 风格指纹官 协同
        </span>
      </div>

      {/* diff view — two columns, scroll independent */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <ScrollArea className="border-border/50 lg:border-r">
          <div className="px-6 py-6">
            <div className="text-muted-foreground mb-3 flex items-center gap-2 text-xs uppercase tracking-wider">
              <span className="bg-muted-foreground/40 size-1 rounded-full" />
              {t("rewrite.original")}
            </div>
            {renderPane(originalText, "original")}
          </div>
        </ScrollArea>

        <ScrollArea>
          <div className="px-6 py-6">
            <div className="text-primary mb-3 flex items-center gap-2 text-xs uppercase tracking-wider">
              <span className="bg-primary size-1 rounded-full" />
              {t("rewrite.revised")}
              <Badge
                variant="outline"
                className="border-primary/40 text-primary bg-primary/5 ml-1 px-1.5 py-0 text-[9px]"
              >
                {t(STYLES.find((s) => s.id === active)!.key)}
              </Badge>
            </div>
            {renderPane(revisedText, "revised")}
          </div>
        </ScrollArea>
      </div>

      {/* footer actions */}
      <div className="border-border/50 bg-card/30 flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
        <div className="text-muted-foreground text-[11px]">
          风格指纹匹配{" "}
          <span className="text-foreground font-mono font-medium">
            {proposal ? `${(proposal.matchScore * 100).toFixed(1)}%` : "—"}
          </span>
          <span className="mx-2">·</span>
          字数变化{" "}
          <span className="text-foreground font-mono font-medium">
            {proposal
              ? `${proposal.wordsDelta >= 0 ? "+" : ""}${proposal.wordsDelta}`
              : "—"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="bg-transparent"
            disabled={busy}
            onClick={() => setMode("write")}
          >
            <X className="size-3.5" />
            {t("rewrite.reject")}
          </Button>
          <Button
            size="sm"
            disabled={busy || !revisedText.trim()}
            onClick={handleAccept}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {t("rewrite.accept")}
          </Button>
        </div>
      </div>
    </div>
  )
}
