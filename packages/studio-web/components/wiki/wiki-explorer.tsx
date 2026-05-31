"use client"

import * as React from "react"
import { mutate } from "swr"
import {
  BookText,
  ChevronRight,
  Compass,
  FileText,
  Lock,
  Search,
  ShieldAlert,
  Sparkles,
  User,
} from "lucide-react"

import { useT, useLocale } from "@/lib/i18n"
import { useWorkspace } from "@/lib/workspace-context"
import { useWiki } from "@/hooks/use-studio"
import { feedWikiNodeToAgent } from "@/lib/api/client"
import { cn } from "@/lib/utils"
import type { WikiKind, WikiNode } from "@/lib/api/types"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { WikiMiniGraph } from "@/components/wiki/wiki-mini-graph"
import { WikiNodeView } from "@/components/wiki/wiki-node-view"

type WikiKindMeta = {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  color: string
  labelKey: `wiki.kinds.${WikiKind}`
}

const KIND_META: Record<WikiKind, WikiKindMeta> = {
  chapter: { icon: BookText, color: "var(--chart-1)", labelKey: "wiki.kinds.chapter" },
  character: { icon: User, color: "var(--chart-3)", labelKey: "wiki.kinds.character" },
  setpoint: { icon: Compass, color: "var(--chart-4)", labelKey: "wiki.kinds.setpoint" },
  constraint: { icon: ShieldAlert, color: "var(--chart-5)", labelKey: "wiki.kinds.constraint" },
  agent: { icon: Sparkles, color: "var(--primary)", labelKey: "wiki.kinds.agent" },
  note: { icon: FileText, color: "var(--muted-foreground)", labelKey: "wiki.kinds.note" },
}

const KIND_ORDER: WikiKind[] = [
  "setpoint", // 设定·大纲·伏笔 —— 置顶最醒目
  "character",
  "chapter",
  "constraint",
  "agent",
  "note",
]

function toKnownKind(kind: string): WikiKind {
  return Object.prototype.hasOwnProperty.call(KIND_META, kind)
    ? (kind as WikiKind)
    : "note"
}

function getKindMeta(kind: string): WikiKindMeta {
  return KIND_META[toKnownKind(kind)]
}

const AGENT_FEED_TARGETS = [
  { id: "writer", zh: "正文写手", en: "Writer" },
  { id: "planner", zh: "规划师", en: "Planner" },
  { id: "editor", zh: "审稿官", en: "Editor" },
  { id: "state-verifier", zh: "状态核校", en: "State check" },
] as const

export function WikiExplorer() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId } = useWorkspace()
  const { data, isLoading } = useWiki(bookId)

  const nodes = React.useMemo(() => data?.nodes ?? [], [data])

  const [activeKinds, setActiveKinds] = React.useState<Set<WikiKind>>(
    new Set(KIND_ORDER),
  )
  const [query, setQuery] = React.useState("")
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  // 默认选第一条；后端真实数据替换 demo 种子时，也要修正失效选中项。
  React.useEffect(() => {
    if (nodes.length > 0 && !nodes.some((node) => node.id === selectedId)) {
      setSelectedId(nodes[0].id)
    }
  }, [nodes, selectedId])

  // 按类型分组 + 搜索过滤
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return nodes.filter((n) => {
      if (!activeKinds.has(toKnownKind(n.kind))) return false
      if (!q) return true
      const hay = [
        n.title.zh,
        n.title.en,
        ...(n.tags ?? []),
        n.body ?? "",
      ]
        .join(" ")
        .toLowerCase()
      return hay.includes(q)
    })
  }, [nodes, activeKinds, query])

  const grouped = React.useMemo(() => {
    const acc: Record<WikiKind, WikiNode[]> = {
      chapter: [],
      character: [],
      setpoint: [],
      constraint: [],
      agent: [],
      note: [],
    }
    for (const n of filtered) acc[toKnownKind(n.kind)].push(n)
    return acc
  }, [filtered])

  const counts = React.useMemo(() => {
    const acc: Record<WikiKind, number> = {
      chapter: 0,
      character: 0,
      setpoint: 0,
      constraint: 0,
      agent: 0,
      note: 0,
    }
    for (const n of nodes) acc[toKnownKind(n.kind)]++
    return acc
  }, [nodes])

  const selected = filtered.find((n) => n.id === selectedId) ?? nodes.find((n) => n.id === selectedId) ?? null

  function toggleKind(k: WikiKind) {
    setActiveKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      // 至少保留一个
      if (next.size === 0) return new Set(KIND_ORDER)
      return next
    })
  }

  return (
    <div className="grid flex-1 grid-cols-[320px_minmax(0,1fr)_360px] gap-0 overflow-hidden">
      {/* 左：检索 + 节点列表 */}
      <aside className="border-border bg-card flex min-h-0 flex-col border-r">
        <div className="border-border flex flex-col gap-3 border-b px-3 py-3">
          <div className="relative">
            <Search className="text-muted-foreground absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("wiki.search")}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {KIND_ORDER.map((k) => {
              const meta = KIND_META[k]
              const active = activeKinds.has(k)
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggleKind(k)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors",
                    active
                      ? "border-border bg-secondary text-foreground"
                      : "border-border text-muted-foreground hover:bg-secondary",
                  )}
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ background: meta.color }}
                  />
                  {t(meta.labelKey)}
                  <span className="text-muted-foreground/60 ml-0.5 font-mono">
                    {counts[k]}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-3 px-2 py-2">
            {isLoading && (
              <div className="text-muted-foreground py-12 text-center text-xs">
                {lang === "en" ? "Loading…" : "加载中…"}
              </div>
            )}
            {!isLoading && filtered.length === 0 && (
              <div className="text-muted-foreground py-12 text-center text-xs">
                {lang === "en" ? "No matches." : "没有匹配的节点"}
              </div>
            )}
            {KIND_ORDER.filter((k) => grouped[k].length > 0).map((k) => {
              const meta = KIND_META[k]
              const Icon = meta.icon
              return (
                <section key={k} className="flex flex-col gap-1">
                  <div className="text-muted-foreground flex items-center gap-1.5 px-2 pt-1 text-[10px] uppercase tracking-widest">
                    <Icon className="size-3" strokeWidth={1.7} />
                    {t(meta.labelKey)}
                    <span className="font-mono opacity-60">
                      {grouped[k].length}
                    </span>
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {grouped[k].map((n) => (
                      <NodeRow
                        key={n.id}
                        node={n}
                        lang={lang}
                        active={n.id === selectedId}
                        accent={getKindMeta(n.kind).color}
                        onSelect={() => setSelectedId(n.id)}
                      />
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        </ScrollArea>
      </aside>

      {/* 中：节点详情 */}
      <section className="flex min-h-0 flex-col">
        {selected ? (
          <WikiNodeView
            node={selected}
            lang={lang}
            kindMeta={getKindMeta(selected.kind)}
          />
        ) : (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
            {lang === "en" ? "Pick a node from the left." : "请从左侧选择一个节点"}
          </div>
        )}
      </section>

      {/* 右：迷你图 + 反向链接 */}
      <aside className="border-border bg-card flex min-h-0 flex-col border-l">
        {selected ? (
          <BacklinksPanel
            node={selected}
            allNodes={nodes}
            lang={lang}
            onSelect={setSelectedId}
          />
        ) : (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
            —
          </div>
        )}
      </aside>
    </div>
  )
}

function NodeRow({
  node,
  lang,
  active,
  accent,
  onSelect,
}: {
  node: WikiNode
  lang: "zh" | "en"
  active: boolean
  accent: string
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
          active
            ? "bg-primary/10 text-foreground"
            : "text-foreground/80 hover:bg-secondary",
        )}
      >
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: accent }}
        />
        <span className="min-w-0 flex-1 truncate">{node.title[lang]}</span>
        {node.backlinks.length > 0 && (
          <span className="text-muted-foreground/70 font-mono text-[10px]">
            {node.backlinks.length}
          </span>
        )}
      </button>
    </li>
  )
}

function BacklinksPanel({
  node,
  allNodes,
  lang,
  onSelect,
}: {
  node: WikiNode
  allNodes: WikiNode[]
  lang: "zh" | "en"
  onSelect: (id: string) => void
}) {
  const t = useT()
  const { bookId } = useWorkspace()
  const [feedingAgent, setFeedingAgent] = React.useState<string | null>(null)
  const [feedState, setFeedState] = React.useState<{
    kind: "ok" | "error"
    text: string
  } | null>(null)

  async function feedAgent(agentId: string) {
    if (!bookId || feedingAgent) return
    setFeedingAgent(agentId)
    setFeedState(null)
    try {
      await feedWikiNodeToAgent(agentId, {
        bookId,
        node,
        reason: `Wiki node ${node.id} fed from Studio Web`,
        expiresInMinutes: 240,
      })
      setFeedState({
        kind: "ok",
        text: lang === "en" ? "Injected into the next run." : "已注入下一次执行。",
      })
      await Promise.all([
        mutate(["wiki", bookId]),
        mutate(["workflow", bookId]),
      ])
    } catch (error) {
      setFeedState({
        kind: "error",
        text: error instanceof Error
          ? error.message
          : lang === "en"
            ? "Feed failed."
            : "注入失败。",
      })
    } finally {
      setFeedingAgent(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* mini graph */}
      <div className="border-border flex h-[260px] shrink-0 flex-col gap-2 border-b px-3 py-3">
        <div className="text-muted-foreground flex items-center gap-1.5 text-[10px] uppercase tracking-widest">
          <Compass className="size-3" />
          {lang === "en" ? "Local graph" : "局部图"}
        </div>
        <div className="flex-1">
          <WikiMiniGraph
            focus={node}
            allNodes={allNodes}
            lang={lang}
            onSelect={onSelect}
          />
        </div>
      </div>

      {/* backlinks */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-3 px-3 py-3">
          <Section
            title={t("wiki.backlinks")}
            count={node.backlinks.length}
            empty={lang === "en" ? "No backlinks yet." : "暂无反向链接"}
          >
            {node.backlinks.map((b) => (
              <LinkRow
                key={b.id}
                title={b.title[lang]}
                onClick={() => onSelect(b.id)}
              />
            ))}
          </Section>

          <Section
            title={lang === "en" ? "Outgoing links" : "正向引用"}
            count={node.links.length}
            empty={lang === "en" ? "—" : "—"}
          >
            {node.links.map((l) => (
              <LinkRow
                key={l.id}
                title={l.title[lang]}
                onClick={() => onSelect(l.id)}
              />
            ))}
          </Section>

          {node.tags.length > 0 && (
            <Section title={lang === "en" ? "Tags" : "标签"}>
              <div className="flex flex-wrap gap-1.5">
                {node.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="font-mono text-[10px]">
                    #{tag}
                  </Badge>
                ))}
              </div>
            </Section>
          )}

          {/* feed-into-agent */}
          <Section title={t("wiki.feed")}>
            <div className="grid grid-cols-2 gap-1.5">
              {AGENT_FEED_TARGETS.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => feedAgent(a.id)}
                  disabled={!bookId || feedingAgent !== null}
                  className="h-7 justify-start gap-1 text-[10px]"
                >
                  <Sparkles className="size-3" />
                  <span className="truncate">
                    {feedingAgent === a.id
                      ? lang === "en" ? "Injecting" : "注入中"
                      : lang === "en" ? a.en : a.zh}
                  </span>
                </Button>
              ))}
            </div>
            {feedState && (
              <div
                className={cn(
                  "mt-1 text-[10px]",
                  feedState.kind === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-destructive",
                )}
              >
                {feedState.text}
              </div>
            )}
          </Section>

          {/* governance hint for locked agent profiles */}
          {node.kind === "agent" && (
            <div className="border-border bg-secondary flex items-start gap-2 rounded-md border px-2.5 py-2 text-[10px] leading-relaxed">
              <Lock className="text-muted-foreground mt-0.5 size-3 shrink-0" />
              <span className="text-muted-foreground">
                {lang === "en"
                  ? "Edit prompts in System & Agents or Agent Lab. Changes here don’t affect runtime."
                  : "请到「系统与智能体」或「Agent 实验室」修改提示词。这里的内容只是档案视图，不影响执行。"}
              </span>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string
  count?: number
  empty?: string
  children: React.ReactNode
}) {
  const isEmptyChildren = React.Children.count(children) === 0
  return (
    <section className="flex flex-col gap-1.5">
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10px] uppercase tracking-widest">
        {title}
        {count !== undefined && (
          <span className="font-mono opacity-70">{count}</span>
        )}
      </div>
      {isEmptyChildren && empty ? (
        <div className="text-muted-foreground/70 text-[11px]">{empty}</div>
      ) : (
        <div className="flex flex-col gap-1">{children}</div>
      )}
    </section>
  )
}

function LinkRow({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-secondary group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
    >
      <ChevronRight className="text-muted-foreground/60 group-hover:text-foreground size-3 transition-colors" />
      <span className="flex-1 truncate">{title}</span>
    </button>
  )
}
