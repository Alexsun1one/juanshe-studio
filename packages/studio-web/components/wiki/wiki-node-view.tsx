"use client"

import * as React from "react"
import { mutate } from "swr"
import { Check, Edit3, FileText, Hash, X } from "lucide-react"

import { useWorkspace } from "@/lib/workspace-context"
import { updateWikiNode } from "@/lib/api/client"
import type { WikiNode } from "@/lib/api/types"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"

const FALLBACK_KIND_META = {
  icon: FileText,
  color: "var(--muted-foreground)",
  labelKey: "wiki.kinds.note",
}

type Props = {
  node: WikiNode
  lang: "zh" | "en"
  kindMeta?: {
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
    color: string
    labelKey: string
  }
}

/**
 * 中央节点详情视图：标题 + 类型徽章 + 正文（可编辑）。
 *
 * 编辑保存后由 swr 触发整个 wiki 重验，反向链接自动跟新。
 */
export function WikiNodeView({ node, lang, kindMeta }: Props) {
  const { bookId } = useWorkspace()
  const meta = kindMeta ?? FALLBACK_KIND_META
  const Icon = meta.icon

  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(node.body ?? "")
  const [saving, setSaving] = React.useState(false)

  // 切换节点时重置编辑态
  React.useEffect(() => {
    setEditing(false)
    setDraft(node.body ?? "")
  }, [node.id, node.body])

  async function handleSave() {
    setSaving(true)
    try {
      await updateWikiNode(bookId, node.id, { body: draft })
      await mutate(["wiki", bookId])
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* head */}
      <div className="border-border from-card/50 to-background flex items-start gap-3 border-b bg-gradient-to-b px-6 py-5 md:px-10">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-xl ring-1"
          style={{
            background: `color-mix(in oklab, ${meta.color} 14%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${meta.color} 30%, transparent)`,
          }}
        >
          <Icon className="size-4" strokeWidth={1.7} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 className="text-balance text-lg font-semibold tracking-tight">
            {node.title[lang]}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className="font-mono text-[10px] uppercase tracking-wider"
              style={{
                borderColor: `color-mix(in oklab, ${meta.color} 35%, transparent)`,
                color: meta.color,
              }}
            >
              {node.kind}
            </Badge>
            {node.chapterNum !== undefined && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                Ch.{node.chapterNum}
              </Badge>
            )}
            {node.tags.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="text-muted-foreground inline-flex items-center gap-0.5 font-mono text-[10px]"
              >
                <Hash className="size-2.5" />
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {!editing ? (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => setEditing(true)}
            >
              <Edit3 className="size-3" />
              {lang === "en" ? "Edit" : "编辑"}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={() => {
                  setDraft(node.body ?? "")
                  setEditing(false)
                }}
                disabled={saving}
              >
                <X className="size-3" />
                {lang === "en" ? "Cancel" : "取消"}
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={handleSave}
                disabled={saving}
              >
                <Check className="size-3" />
                {lang === "en" ? "Save" : "保存"}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* body */}
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-[68ch] px-6 py-6 md:px-10 md:py-8">
          {editing ? (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[280px] font-mono text-[12.5px] leading-relaxed"
              placeholder={
                lang === "en" ? "Write in markdown…" : "支持 Markdown 语法…"
              }
            />
          ) : (
            isHookLedger(node.body) ? (
              <HookLedger body={node.body ?? ""} />
            ) : (
            <article className="prose-sm max-w-none whitespace-pre-wrap font-serif text-[14.5px] leading-relaxed text-foreground/90">
              {node.body?.trim() ? (
                node.body
              ) : (
                <span className="text-muted-foreground italic">
                  {lang === "en"
                    ? "This node has no body yet — click Edit to start writing."
                    : "这个节点还没有正文 — 点击编辑开始书写"}
                </span>
              )}
            </article>
            )
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 伏笔账本：把 pending_hooks.md 的 markdown 表格拆成逐条可浏览的伏笔卡
// （用户原来只看到一坨表格；现在每条伏笔单独成卡，状态高亮）
// ---------------------------------------------------------------------------
function isHookLedger(body?: string): boolean {
  if (!body) return false
  return /\|\s*hook_id\s*\|/i.test(body)
}

const HOOK_STATUS_TONE: Record<string, string> = {
  open: "bg-secondary text-muted-foreground",
  pressured: "bg-status-warning/15 text-status-warning",
  pressing: "bg-status-warning/15 text-status-warning",
  near_payoff: "bg-primary/15 text-primary",
  "near-payoff": "bg-primary/15 text-primary",
  pledged: "bg-primary/15 text-primary",
  resolved: "bg-status-success/15 text-status-success",
  cleared: "bg-status-success/15 text-status-success",
}

function HookLedger({ body }: { body: string }) {
  const rows = React.useMemo(() => {
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean)
    const headerIdx = lines.findIndex((l) => /\|\s*hook_id\s*\|/i.test(l))
    if (headerIdx < 0) return []
    const header = lines[headerIdx]
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
    const out: Record<string, string>[] = []
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line.startsWith("|")) continue
      if (/^\|[\s|:-]+\|?$/.test(line)) continue // separator row
      const cells = line.split("|").map((c) => c.trim())
      // leading/trailing empty from | a | b |
      const vals = cells.slice(1, cells.length - 1)
      if (vals.length === 0) continue
      const rec: Record<string, string> = {}
      header.forEach((h, idx) => (rec[h] = vals[idx] ?? ""))
      if (rec["hook_id"]) out.push(rec)
    }
    return out
  }, [body])

  if (rows.length === 0) {
    return (
      <article className="prose-sm max-w-none whitespace-pre-wrap font-serif text-[14.5px] leading-relaxed text-foreground/90">
        {body}
      </article>
    )
  }

  return (
    <div className="space-y-2.5">
      <div className="text-muted-foreground text-xs">
        共 {rows.length} 条伏笔 · 按埋设/推进逐条
      </div>
      {rows.map((r) => {
        const id = (r["hook_id"] || "").replace(/^\[new\]\s*/, "")
        const isNew = /^\[new\]/.test(r["hook_id"] || "")
        const status = (r["状态"] || "").toLowerCase()
        const tone = HOOK_STATUS_TONE[status] ?? "bg-secondary text-muted-foreground"
        return (
          <div
            key={id}
            className="border-border bg-card rounded-lg border p-3 shadow-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground font-mono text-xs font-semibold">
                {id}
              </span>
              {isNew && (
                <span className="bg-primary/15 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">
                  新埋设
                </span>
              )}
              {r["状态"] && (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
                  {r["状态"]}
                </span>
              )}
              {r["类型"] && (
                <span className="text-muted-foreground text-[10px]">
                  {r["类型"]}
                </span>
              )}
              <span className="text-muted-foreground/70 ml-auto text-[10px]">
                起始 {r["起始章节"] || "—"} · 预期回收 {r["预期回收"] || "—"} · {r["回收节奏"] || ""}
              </span>
            </div>
            {r["最近推进"] && (
              <div className="text-foreground/85 mt-1.5 text-[12.5px] leading-relaxed">
                {r["最近推进"]}
              </div>
            )}
            {r["备注"] && (
              <div className="text-muted-foreground mt-1 text-[11.5px] leading-relaxed">
                {r["备注"]}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
