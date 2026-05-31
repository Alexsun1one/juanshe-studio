"use client"

import * as React from "react"
import {
  Activity,
  AlertCircle,
  BookMarked,
  ChevronRight,
  GitBranch,
  Maximize2,
  Network,
  RefreshCcw,
  Sparkles,
  TrendingUp,
  Users,
  Workflow,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AssistantConsole } from "@/components/assistant/assistant-console"
import { StudioDrawer } from "@/components/studio/studio-drawer"
import { ChapterQualityPanel } from "@/components/studio/chapter-quality-panel"
import { useT, useLocale } from "@/lib/i18n"
import { useStudio } from "@/lib/studio-context"
import { useWorkspace } from "@/lib/workspace-context"
import {
  useAgents,
  useAutoRuns,
  useChapters,
  useMemory,
  useOpportunities,
  usePlot,
  useRelationshipGraph,
  useStyleFingerprint,
  useWorkflow,
} from "@/hooks/use-studio"
import { Heartbeat, StatusDot } from "@/components/studio/status-dot"
import { WorkflowChain } from "@/components/studio/workflow-chain"
import { agentColor, agentSoftBg, agentBorder } from "@/lib/agent-identity"
import { RelationshipGraph } from "@/components/studio/relationship-graph"
import { getBookReadiness } from "@/lib/studio/book-readiness"
import {
  latestActiveBookRun,
  latestInterruptedBookRun,
  runMessage,
  workflowSnapshotFromRun,
} from "@/lib/studio/run-state"

const DEFAULT_RIGHT_RAIL_SECTIONS = ["workflow", "agents"] as const

type RailSection =
  | (typeof DEFAULT_RIGHT_RAIL_SECTIONS)[number]
  | "memory"
  | "relations"
  | "plot"
  | "insight"

type SectionProps = {
  enabled?: boolean
}

export function RightRail() {
  const { rightCollapsed, rightWidth, bookId } = useStudio()
  const readiness = useCurrentBookReadiness(bookId)
  const sideDataReady = useDeferredSideDataReady(bookId)
  // 默认全部抽屉收起 —— 层级清晰、降噪；用户按需展开（drawer 行为）
  const [openSections, setOpenSections] = React.useState<RailSection[]>([])
  const isOpen = React.useCallback(
    (section: RailSection) => openSections.includes(section),
    [openSections],
  )

  if (rightCollapsed) return <RightRailCollapsed />

  return (
    <aside
      style={{ width: rightWidth }}
      className="bg-sidebar border-border hidden h-full shrink-0 flex-col border-l md:flex"
    >
      {/* 参考设计工具：右栏「信息 | AI」双页签 —
          信息 = 工作流/Agent/记忆/图谱/剧情/洞察；AI = 可对话的写作助手 */}
      <Tabs defaultValue="info" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="bg-transparent h-9 w-full shrink-0 justify-start gap-1 rounded-none border-b border-border px-3 py-0">
          <TabsTrigger
            value="info"
            className="data-[state=active]:bg-secondary data-[state=active]:text-foreground text-muted-foreground h-7 gap-1.5 rounded-md px-2.5 text-xs font-normal data-[state=active]:shadow-none"
          >
            <Workflow className="size-3.5" />
            信息
          </TabsTrigger>
          <TabsTrigger
            value="ai"
            className="data-[state=active]:bg-secondary data-[state=active]:text-foreground text-muted-foreground h-7 gap-1.5 rounded-md px-2.5 text-xs font-normal data-[state=active]:shadow-none"
          >
            <Sparkles className="size-3.5" />
            AI 助手
          </TabsTrigger>
        </TabsList>

        <TabsContent value="info" className="m-0 min-h-0 flex-1">
          <ScrollArea data-testid="right-rail-scroll" className="h-full min-h-0">
            {/* 本章评分常驻可见：总分 + 9 维明细 + 可设达标分 */}
            {!readiness.resourcesBlocked && <ChapterQualityPanel />}
            {readiness.resourcesBlocked ? (
              <BlockedRightRail readiness={readiness} />
            ) : (
              <Accordion
                type="multiple"
                value={openSections}
                onValueChange={(value) => setOpenSections(value as RailSection[])}
                className="px-2 py-2"
              >
                <WorkflowSection enabled={isOpen("workflow")} />
                <AgentsSection enabled={isOpen("agents")} />
                <MemorySection enabled={sideDataReady && isOpen("memory")} />
                <RelationsSection enabled={sideDataReady && isOpen("relations")} />
                <PlotSection enabled={sideDataReady && isOpen("plot")} />
                <InsightSection enabled={sideDataReady && isOpen("insight")} />
              </Accordion>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent
          value="ai"
          className="m-0 min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          <AssistantLauncher />
        </TabsContent>
      </Tabs>
    </aside>
  )
}

/**
 * AI 助手启动卡 —— 右栏只放一个干净的入口卡片；
 * 真正的对话台（AssistantConsole 是整页宽布局）在宽抽屉里打开，
 * 不再硬塞进 ~300px 细栏导致单字竖排的排版崩坏。
 */
function AssistantLauncher() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="border-border bg-card flex flex-col gap-2 rounded-xl border p-3 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-lg">
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-foreground truncate text-sm font-semibold">
              AI 写作助手
            </div>
            <div className="text-muted-foreground truncate text-[11px]">
              自然语言指挥作品 / 章节 / 风格
            </div>
          </div>
        </div>
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          用大白话说你想怎么改，AI 会读完当前作品再动手，讨论只跟着这本书走。
        </p>
        <StudioDrawer
          size="lg"
          title="AI 写作助手"
          description="自然语言控制台 · 会话绑定当前作品"
          trigger={
            <Button size="sm" className="w-full gap-1.5">
              <Sparkles className="size-3.5" />
              打开 AI 助手
            </Button>
          }
        >
          <AssistantConsole />
        </StudioDrawer>
      </div>
    </div>
  )
}

function useDeferredSideDataReady(bookId: string) {
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    setReady(false)
    if (!bookId) return

    const timer = window.setTimeout(() => setReady(true), 350)
    return () => window.clearTimeout(timer)
  }, [bookId])

  return ready
}

function RightRailCollapsed() {
  const { setRight } = useStudio()
  return (
    <aside className="bg-sidebar border-border hidden h-full w-12 shrink-0 flex-col items-center gap-1 border-l py-3 md:flex">
      {[Workflow, Users, BookMarked, Network, GitBranch, TrendingUp].map(
        (Icon, i) => (
          <Button
            key={i}
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setRight(false)}
          >
            <Icon className="size-4" />
          </Button>
        ),
      )}
    </aside>
  )
}

type BookReadiness = ReturnType<typeof useCurrentBookReadiness>

function useCurrentBookReadiness(bookId: string) {
  const { books } = useWorkspace()
  const currentBook = books.find((book) => book.id === bookId)
  const currentChapter = currentBook?.currentChapter ?? 0
  const readiness = getBookReadiness(currentBook)

  return { currentBook, currentChapter, ...readiness }
}

function BlockedRightRail({ readiness }: { readiness: BookReadiness }) {
  const { setMode } = useStudio()
  return (
    <Accordion
      type="multiple"
      defaultValue={["book-state"]}
      className="px-2 py-2"
    >
      <AccordionItem
        value="book-state"
        className="border-border mb-1 border-b"
      >
        <SectionTrigger
          icon={AlertCircle}
          title="建书状态"
          meta={<span className="text-status-warning">{readiness.title}</span>}
        />
        <AccordionContent className="px-2 pb-3 pt-1">
          <div className="border-status-warning/30 bg-status-warning/10 text-muted-foreground rounded-md border px-3 py-3 text-[11px] leading-relaxed">
            {readiness.detail} 工作流、agent 阵列、记忆、图谱和剧情数据不会加载旧书兜底内容。
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-8 text-xs"
              onClick={() => setMode("new")}
            >
              回到建书
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 bg-transparent text-xs"
              onClick={() => setMode("outline")}
            >
              查看大纲
            </Button>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

function SectionTrigger({
  icon: Icon,
  title,
  meta,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  meta?: React.ReactNode
}) {
  return (
    <AccordionTrigger className="hover:bg-secondary/50 group rounded-md px-3 py-2.5 text-xs font-semibold hover:no-underline">
      <div className="flex flex-1 items-center gap-2">
        <Icon className="text-primary/70 size-3.5" />
        <span>{title}</span>
        {meta && (
          <span className="text-muted-foreground ml-auto mr-1 text-[10px] font-normal">
            {meta}
          </span>
        )}
      </div>
    </AccordionTrigger>
  )
}

// ---------------------------------------------------------------------
// Section: 工作流（动态调度链 — SWR 拉快照，SSE 推送时自动重拉）
// ---------------------------------------------------------------------
function WorkflowSection({ enabled = true }: SectionProps) {
  const t = useT()
  const { bookId, currentChapter } = useStudio()
  const { data: snap } = useWorkflow(bookId, { enabled })
  const { data: autoRuns } = useAutoRuns()
  const continuationChapter = currentChapter + 1
  const activeRun = latestActiveBookRun(autoRuns, bookId, continuationChapter)
  const interruptedRun = latestInterruptedBookRun(
    autoRuns,
    bookId,
    continuationChapter,
  )
  const runSnapshot = workflowSnapshotFromRun(activeRun)
  const displaySnap = runSnapshot ?? snap
  const runHint = activeRun ?? interruptedRun

  return (
    <AccordionItem value="workflow" className="border-border mb-1 border-b">
      <SectionTrigger
        icon={Workflow}
        title={t("right.tabs.workflow")}
        meta={
          displaySnap ? (
            <span className="font-mono">
              <span className="text-status-running font-medium">
                {Math.round(displaySnap.totalProgress * 100)}
              </span>
              <span className="text-muted-foreground/60">%</span>
            </span>
          ) : (
            <span className="text-muted-foreground/60">…</span>
          )
        }
      />
      <AccordionContent className="px-2 pb-3 pt-1">
        <div className="text-muted-foreground mb-2 px-1 text-[10px]">
          {t("workflow.subtitle")}
        </div>
        {runHint ? (
          <div
            className={cn(
              "mb-2 rounded-md border px-2.5 py-2 text-[10px] leading-relaxed",
              activeRun
                ? "border-status-running/30 bg-status-running/10 text-foreground/85"
                : "border-status-warning/30 bg-status-warning/10 text-muted-foreground",
            )}
          >
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <StatusDot
                status={activeRun ? "running" : "warning"}
                size="xs"
                pulse={Boolean(activeRun)}
              />
              <span>{activeRun ? "后台任务运行中" : "后台任务中断待续"}</span>
            </div>
            <p>{runMessage(runHint) || "等待下一次检查并继续。"}</p>
          </div>
        ) : null}
        {displaySnap ? (
          <WorkflowChain
            snapshot={displaySnap}
            transitionReason={runHint ? runMessage(runHint) : undefined}
          />
        ) : (
          <SectionLoading />
        )}
      </AccordionContent>
    </AccordionItem>
  )
}

// ---------------------------------------------------------------------
// Section: 15 位 agent 阵列（按调度链顺序）
// ---------------------------------------------------------------------
function AgentsSection({ enabled = true }: SectionProps) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId, currentChapter } = useStudio()
  const { data: agents } = useAgents({ enabled })
  const { data: workflow } = useWorkflow(bookId, { enabled })
  const { data: autoRuns } = useAutoRuns()
  const isLoading = agents === undefined
  const list = agents ?? []
  const continuationChapter = currentChapter + 1
  const activeRun = latestActiveBookRun(autoRuns, bookId, continuationChapter)
  const interruptedRun = latestInterruptedBookRun(
    autoRuns,
    bookId,
    continuationChapter,
  )
  const activeAgentIds = activeRun
    ? new Set(Object.values(workflow?.activeAgentsByStage ?? {}).flat())
    : new Set<string>()
  if (activeRun?.currentAgentId) activeAgentIds.add(activeRun.currentAgentId)
  const activeCount = activeAgentIds.size

  return (
    <AccordionItem value="agents" className="border-border mb-1 border-b">
      <SectionTrigger
        icon={Users}
        title={t("right.tabs.agents")}
        meta={
          isLoading ? (
            <span className="text-muted-foreground/60">…</span>
          ) : (
            <span className="font-mono">
              <span className="text-status-running font-medium">{list.length}</span>
              <span className="text-muted-foreground/60"> 配置</span>
            </span>
          )
        }
      />
      <AccordionContent className="px-2 pb-3 pt-1">
        {isLoading ? (
          <SectionLoading />
        ) : list.length === 0 ? (
          <SectionLoading
            variant="empty"
            message={lang === "zh" ? "未配置任何 agent" : "No agents yet"}
          />
        ) : (
          <div className="space-y-2">
            <div className="bg-secondary/40 text-muted-foreground flex items-center justify-between rounded-md px-2 py-1 text-[10px]">
              <span>{lang === "zh" ? "当前活跃" : "Active now"}</span>
              <span className="font-mono">
                <span
                  className={cn(
                    activeCount > 0 && "text-status-running font-medium",
                  )}
                >
                  {activeCount}
                </span>
                <span className="text-muted-foreground/60">/{list.length}</span>
              </span>
            </div>
            <ul className="space-y-1">
              {list.map((a) => {
                const active = activeAgentIds.has(a.id)
                const interrupted = interruptedRun?.currentAgentId === a.id
                const baseStatus = a.status === "running" ? "idle" : a.status
                const status = interrupted ? "warning" : active ? "running" : baseStatus
                // 每个 agent 一个专属色（与工作流连线 / 评审室 / 运行日志同源）：
                // 编号牌用其色身份着色，活跃时加深底色与描边。
                const color = agentColor(a.id)
                const lit = active && !interrupted

                return (
                  <li
                    key={a.id}
                    className={cn(
                      "group hover:bg-secondary/60 flex items-start gap-2 rounded-md border border-transparent p-1.5 transition-all",
                      status === "running" && "bg-status-running/[0.05]",
                      status === "warning" && "bg-status-warning/[0.05]",
                      status === "error" && "bg-status-error/[0.05]",
                    )}
                  >
                    <span
                      className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border font-mono text-[10px]"
                      style={{
                        color,
                        background: agentSoftBg(a.id, lit ? 20 : 12),
                        borderColor: lit ? agentBorder(a.id, 55) : "transparent",
                      }}
                    >
                      {a.num}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            lit && "motion-safe:animate-pulse",
                          )}
                          style={{ background: color }}
                          aria-hidden
                        />
                        <span className="truncate text-[11px] font-medium">
                          {a.name[lang]}
                        </span>
                        <StatusDot
                          status={status}
                          size="xs"
                          pulse={status === "running"}
                        />
                        <Heartbeat active={active && !interrupted} intensity={a.load} />
                      </div>
                      <div className="text-muted-foreground truncate text-[10px]">
                        {interrupted
                          ? runMessage(interruptedRun)
                          : a.currentTask
                            ? a.currentTask[lang]
                            : a.role[lang]}
                      </div>
                    </div>
                    <span className="text-muted-foreground/70 mt-0.5 hidden shrink-0 font-mono text-[9px] group-hover:inline">
                      {a.modelHint}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  )
}

// ---------------------------------------------------------------------
// Section: 记忆
// ---------------------------------------------------------------------
function MemorySection({ enabled = true }: SectionProps) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId } = useStudio()
  const [filter, setFilter] = React.useState<"long" | "current" | "world">(
    "long",
  )
  const { data: memories } = useMemory(bookId, filter, { enabled })
  const isLoading = memories === undefined
  const list = memories ?? []

  return (
    <AccordionItem value="memory" className="border-border mb-1 border-b">
      <SectionTrigger
        icon={BookMarked}
        title={t("right.tabs.memory")}
        meta={
          isLoading ? (
            <span className="text-muted-foreground/60">…</span>
          ) : (
            <span className="font-mono">{list.length}</span>
          )
        }
      />
      <AccordionContent className="px-2 pb-3 pt-1">
        <div className="bg-secondary/50 mb-2 inline-flex w-full gap-0.5 rounded-md p-0.5">
          {(["long", "current", "world"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cn(
                "flex-1 rounded px-2 py-1 text-[10px] font-medium transition-colors",
                filter === k
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`memory.${k}`)}
            </button>
          ))}
        </div>
        {isLoading ? (
          <SectionLoading />
        ) : list.length === 0 ? (
          <SectionLoading
            variant="empty"
            message={
              lang === "zh"
                ? `「${t(`memory.${filter}`)}」暂无条目`
                : `No ${filter} memory yet`
            }
          />
        ) : (
          <ul className="space-y-1">
            {list.map((m) => (
              <li
                key={m.id}
                className="group hover:bg-secondary/50 flex items-start gap-2 rounded-md border border-transparent p-2 text-[11px] transition-colors hover:border-border"
              >
                <span className="bg-primary/70 mt-1 size-1 shrink-0 rounded-full" />
                <span className="line-clamp-2 flex-1 leading-snug">
                  {m.text[lang]}
                </span>
                <Badge
                  variant="outline"
                  className="bg-secondary/40 shrink-0 px-1.5 py-0 font-mono text-[9px]"
                >
                  Ch.{m.chapter}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <ExpandSheet
          title={
            lang === "zh"
              ? `记忆长卷 · ${t(`memory.${filter}`)}`
              : `Memory · ${filter}`
          }
          description={
            lang === "zh"
              ? `共 ${list.length} 条。喂给 agent 时按 token 上限自动截取。`
              : `${list.length} items. Auto-truncated by agent token budget.`
          }
          trigger={
            <button className="text-primary/80 hover:text-primary mt-2 flex w-full items-center justify-center gap-1 text-[11px]">
              {t("memory.viewMore")}
              <ChevronRight className="size-3" />
            </button>
          }
        >
          {list.length === 0 ? (
            <SectionLoading variant="empty" message={lang === "zh" ? "暂无记忆条目" : "No memory items yet"} />
          ) : (
            <ul className="space-y-2">
              {list.map((m) => (
                <li
                  key={m.id}
                  className="border-border hover:bg-secondary/40 flex items-start gap-3 rounded-md border bg-card/40 p-3 text-sm"
                >
                  <span className="bg-primary/70 mt-1.5 size-1.5 shrink-0 rounded-full" />
                  <span className="flex-1 leading-relaxed">{m.text[lang]}</span>
                  <Badge
                    variant="outline"
                    className="bg-secondary/40 shrink-0 font-mono text-[10px]"
                  >
                    Ch.{m.chapter}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </ExpandSheet>
      </AccordionContent>
    </AccordionItem>
  )
}

// ---------------------------------------------------------------------
// Section: 关系图谱
// ---------------------------------------------------------------------
function RelationsSection({ enabled = true }: SectionProps) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId } = useStudio()
  const { data: graph, mutate } = useRelationshipGraph(bookId, undefined, {
    enabled,
  })

  return (
    <AccordionItem value="relations" className="border-border mb-1 border-b">
      <SectionTrigger
        icon={Network}
        title={t("right.tabs.relations")}
        meta={
          graph ? <span className="font-mono">v{graph.version}</span> : null
        }
      />
      <AccordionContent className="relative px-2 pb-3 pt-1">
        <div className="text-muted-foreground mb-2 px-1 text-[10px]">
          {t("relations.subtitle")}
        </div>

        {/* 右栏只是 teaser：legend 节点头像列表 + 计数；点击展开看完整图 */}
        {graph === undefined ? (
          <SectionLoading />
        ) : graph.nodes.length === 0 ? (
          <SectionLoading
            variant="empty"
            message={
              lang === "zh"
                ? "图谱为空。点击下方从正文提取角色关系。"
                : "Graph empty. Extract from manuscript below."
            }
          />
        ) : (
          <>
            {/* teaser：阵营色点 + 节点头像 */}
            <div className="flex flex-wrap gap-1 px-1">
              {graph.nodes.slice(0, 8).map((n) => {
                const fac = graph.factions?.find((f) => f.id === n.factionId)
                return (
                  <span
                    key={n.id}
                    className={cn(
                      "border-border inline-flex max-w-full items-center gap-1 rounded-full border bg-secondary/40 px-1.5 py-0.5 text-[10px]",
                      n.id === graph.focusId &&
                        "border-primary/50 bg-primary/10",
                    )}
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: fac?.color ?? "currentColor" }}
                    />
                    <span className="truncate">{n.name[lang]}</span>
                  </span>
                )
              })}
              {graph.nodes.length > 8 && (
                <span className="text-muted-foreground inline-flex items-center px-1.5 text-[10px]">
                  +{graph.nodes.length - 8}
                </span>
              )}
            </div>

            {/* 展开 Sheet 看完整 1000px 大图 */}
            <ExpandSheet
              title={
                lang === "zh"
                  ? "关系图谱 · 全量"
                  : "Relationship Graph · Full"
              }
              description={
                lang === "zh"
                  ? `共 ${graph.nodes.length} 个角色 · ${graph.edges.length} 条关系 · v${graph.version}`
                  : `${graph.nodes.length} characters · ${graph.edges.length} relations · v${graph.version}`
              }
              trigger={
                <button
                  type="button"
                  className="border-border text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-primary mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors"
                >
                  <Maximize2 className="size-3" />
                  {lang === "zh" ? "展开看完整图谱" : "Expand full graph"}
                </button>
              }
            >
              <div className="h-[70vh] w-full">
                <RelationshipGraph
                  nodes={graph.nodes}
                  edges={graph.edges}
                  focusId={graph.focusId}
                />
              </div>
              <div className="text-muted-foreground mt-3 flex items-center justify-between text-[11px]">
                <span>
                  {t("relations.focus")}:{" "}
                  <span className="text-foreground/80 font-medium">
                    {
                      graph.nodes.find((n) => n.id === graph.focusId)?.name[
                        lang
                      ]
                    }
                  </span>
                </span>
                <span className="font-mono">
                  {graph.nodes.length}n · {graph.edges.length}e
                </span>
              </div>
            </ExpandSheet>

            <div className="text-muted-foreground mt-2 flex items-center justify-between px-1 text-[9px]">
              <span>
                {t("relations.focus")}:{" "}
                <span className="text-foreground/80 font-medium">
                  {graph.nodes.find((n) => n.id === graph.focusId)?.name[lang]}
                </span>
              </span>
              <span className="font-mono">
                {graph.nodes.length}n · {graph.edges.length}e
              </span>
            </div>
          </>
        )}

        {/* 从正文提取关系图谱 — 调用后端 POST /relationship-graph/extract */}
        <ExtractGraphButton lang={lang} onDone={() => mutate()} />
      </AccordionContent>
    </AccordionItem>
  )
}

// ---------------------------------------------------------------------
// Section: 剧情推进
// ---------------------------------------------------------------------
function PlotSection({ enabled = true }: SectionProps) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId } = useStudio()
  const { data: plot } = usePlot(bookId, { enabled })
  const { data: chapters } = useChapters(bookId, { enabled })

  const milestones = plot?.milestones ?? []
  const currentIdx = plot
    ? milestones.findIndex((m) => m.id === plot.currentMilestoneId)
    : -1
  const tensionPoints =
    plot?.tensionCurve ??
    (chapters
      ? chapters.map((c, i) => ({
          chapter: c.num,
          tension: 0.3 + (i / chapters.length) * 0.3,
        }))
      : [])

  return (
    <AccordionItem value="plot" className="border-border mb-1 border-b">
      <SectionTrigger
        icon={GitBranch}
        title={t("right.tabs.plot")}
        meta={
          plot ? (
            <span className="font-mono">
              {currentIdx + 1}/{milestones.length}
            </span>
          ) : null
        }
      />
      <AccordionContent className="relative px-2 pb-3 pt-1">
        <div className="text-muted-foreground mb-2 px-1 text-[10px]">
          {t("plot.subtitle")}
        </div>

        {/* milestones */}
        {plot === undefined ? (
          <SectionLoading />
        ) : milestones.length === 0 ? (
          <SectionLoading
            variant="empty"
            message={
              lang === "zh"
                ? "尚未规划剧情节点。"
                : "No milestones planned yet."
            }
          />
        ) : (
          <ol className="mb-3 space-y-1">
            {milestones.map((m, i) => {
              const isCurrent = plot
                ? plot.currentMilestoneId === m.id
                : m.status === "current"
              return (
                <li
                  key={m.id}
                  className={cn(
                    "border-border flex items-center gap-2 rounded-md border bg-card/40 px-2 py-1.5 text-[11px]",
                    isCurrent && "border-primary/40 bg-primary/[0.04]",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full font-mono text-[9px]",
                      m.status === "done"
                        ? "bg-status-success text-primary-foreground"
                        : isCurrent
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-muted-foreground",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1 truncate font-medium">
                    {m.label[lang]}
                  </span>
                  <span className="text-muted-foreground font-mono text-[9px]">
                    {Math.round(m.progress * 100)}%
                  </span>
                </li>
              )
            })}
          </ol>
        )}

        {/* tension curve teaser */}
        <div className="text-muted-foreground mb-1 px-1 text-[10px] uppercase tracking-wider">
          {t("plot.tension")}
        </div>
        <TensionCurve points={tensionPoints} />

        {tensionPoints.length > 0 && (
          <ExpandSheet
            title={
              lang === "zh"
                ? "剧情节点 + 张力曲线 · 全量"
                : "Milestones & Tension · Full"
            }
            description={
              lang === "zh"
                ? `${milestones.length} 个节点 · ${tensionPoints.length} 章张力采样`
                : `${milestones.length} milestones · ${tensionPoints.length} chapters sampled`
            }
            trigger={
              <button
                type="button"
                className="border-border text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-primary mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] transition-colors"
              >
                <Maximize2 className="size-3" />
                {lang === "zh"
                  ? "展开看完整张力曲线"
                  : "Expand full curve"}
              </button>
            }
          >
            <div className="space-y-4">
              <ol className="space-y-1">
                {milestones.map((m, i) => {
                  const isCurrent = plot
                    ? plot.currentMilestoneId === m.id
                    : m.status === "current"
                  return (
                    <li
                      key={m.id}
                      className={cn(
                        "border-border flex items-center gap-3 rounded-md border bg-card/40 px-3 py-2 text-sm",
                        isCurrent && "border-primary/40 bg-primary/[0.04]",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px]",
                          m.status === "done"
                            ? "bg-status-success text-primary-foreground"
                            : isCurrent
                              ? "bg-primary text-primary-foreground"
                              : "bg-secondary text-muted-foreground",
                        )}
                      >
                        {i + 1}
                      </span>
                      <span className="flex-1 font-medium">
                        {m.label[lang]}
                      </span>
                      <span className="text-muted-foreground font-mono text-xs">
                        {Math.round(m.progress * 100)}%
                      </span>
                    </li>
                  )
                })}
              </ol>
              <div className="bg-card/40 border-border rounded-md border p-4">
                <TensionCurve points={tensionPoints} large />
              </div>
            </div>
          </ExpandSheet>
        )}
      </AccordionContent>
    </AccordionItem>
  )
}

function TensionCurve({
  points,
  large,
}: {
  points: { chapter: number; tension: number }[]
  large?: boolean
}) {
  const w = large ? 1000 : 300
  const h = large ? 280 : 60
  const padX = large ? 24 : 4
  const padY = large ? 24 : 6
  if (points.length === 0) return null
  const xs = points.map(
    (_, i) => padX + (i * (w - padX * 2)) / Math.max(1, points.length - 1),
  )
  const ys = points.map((p) => h - padY - p.tension * (h - padY * 2))
  const path = xs
    .map((x, i) => `${i === 0 ? "M" : "L"} ${x} ${ys[i]}`)
    .join(" ")
  const fillPath = `${path} L ${xs[xs.length - 1]} ${h} L ${xs[0]} ${h} Z`

  return (
    <div className="bg-card/60 border-border overflow-hidden rounded-md border">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className={cn("block w-full", large ? "h-72" : "h-12")}
      >
        <defs>
          <linearGradient id="tension-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {large &&
          [0, 0.25, 0.5, 0.75, 1].map((t) => (
            <line
              key={t}
              x1={padX}
              x2={w - padX}
              y1={h - padY - t * (h - padY * 2)}
              y2={h - padY - t * (h - padY * 2)}
              stroke="var(--border)"
              strokeWidth="0.5"
              strokeDasharray="2 4"
            />
          ))}
        <path d={fillPath} fill="url(#tension-fill)" />
        <path
          d={path}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={large ? 2 : 1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {xs.map((x, i) => (
          <g key={i}>
            <circle
              cx={x}
              cy={ys[i]}
              r={large ? 3 : 1.6}
              fill="var(--primary)"
            />
            {large && i % Math.max(1, Math.floor(points.length / 12)) === 0 && (
              <text
                x={x}
                y={h - 6}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ fontSize: 10 }}
              >
                Ch.{points[i].chapter}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------
// Section: 市场洞察 + 风��指纹
// ---------------------------------------------------------------------
function InsightSection({ enabled = true }: SectionProps) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { data: opps } = useOpportunities({ enabled })
  const list = opps ?? []

  return (
    <AccordionItem value="insight" className="mb-1">
      <SectionTrigger icon={TrendingUp} title={t("right.tabs.insight")} />
      <AccordionContent className="space-y-3 px-2 pb-3 pt-1">
        <div>
          <div className="text-muted-foreground mb-1.5 px-1 text-[10px] uppercase tracking-wider">
            {t("insight.hot")}
          </div>
          {list.length === 0 ? (
            <SectionLoading />
          ) : (
            <ul className="space-y-1">
              {list.map((o) => (
                <li
                  key={o.id}
                  className="hover:bg-secondary/60 flex items-center gap-2 rounded-md p-1.5 text-[11px] transition-colors"
                >
                  <span className="bg-secondary/80 text-muted-foreground flex h-5 w-7 shrink-0 items-center justify-center rounded font-mono text-[9px]">
                    {o.score}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {o.title[lang]}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[10px]",
                      o.trend === "up"
                        ? "text-status-success"
                        : "text-muted-foreground",
                    )}
                  >
                    {o.change}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="text-muted-foreground mb-1.5 px-1 text-[10px] uppercase tracking-wider">
            {t("insight.style")}
          </div>
          <div className="bg-card/60 border-border rounded-md border p-3">
            <StyleRadar enabled={enabled} />
          </div>
        </div>

        <ExpandSheet
          title={lang === "zh" ? "市场洞察与风格指纹" : "Market Insight & Style"}
          description={
            lang === "zh"
              ? `共 ${list.length} 条机会信号，风格雷达来自当前作品快照。`
              : `${list.length} opportunity signals. Style radar is from the current book snapshot.`
          }
          trigger={
            <Button
              variant="outline"
              size="sm"
              className="bg-transparent w-full text-xs"
            >
              <Activity className="size-3.5" />
              <span>{t("common.viewAll")}</span>
            </Button>
          }
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t("insight.hot")}</h3>
              {list.length === 0 ? (
                <SectionLoading
                  variant="empty"
                  message={lang === "zh" ? "暂无市场机会信号" : "No opportunity signals yet"}
                />
              ) : (
                <ul className="space-y-2">
                  {list.map((o) => (
                    <li
                      key={o.id}
                      className="border-border flex items-center gap-3 rounded-md border bg-card/40 px-3 py-2 text-sm"
                    >
                      <span className="bg-secondary/80 text-muted-foreground flex h-7 w-10 shrink-0 items-center justify-center rounded font-mono text-xs">
                        {o.score}
                      </span>
                      <span className="min-w-0 flex-1 font-medium">
                        {o.title[lang]}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-mono text-xs",
                          o.trend === "up"
                            ? "text-status-success"
                            : "text-muted-foreground",
                        )}
                      >
                        {o.change}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t("insight.style")}</h3>
              <div className="bg-card/60 border-border rounded-md border p-4">
                <StyleRadar enabled={enabled} />
              </div>
            </section>
          </div>
        </ExpandSheet>
      </AccordionContent>
    </AccordionItem>
  )
}

function StyleRadar({ enabled = true }: SectionProps) {
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { bookId } = useStudio()
  const { data: fingerprint } = useStyleFingerprint(bookId, { enabled })
  const axes = fingerprint?.axes ?? []
  const cx = 100
  const cy = 80
  const r = 55
  const n = axes.length
  if (n === 0) return <SectionLoading />

  const points = axes.map((d, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    return {
      x: cx + Math.cos(angle) * r * d.value,
      y: cy + Math.sin(angle) * r * d.value,
      lx: cx + Math.cos(angle) * (r + 18),
      ly: cy + Math.sin(angle) * (r + 18),
      label: d.axis[lang],
    }
  })
  const polygon = points.map((p) => `${p.x},${p.y}`).join(" ")

  return (
    <svg viewBox="0 0 200 160" className="h-32 w-full" aria-hidden>
      {[0.33, 0.66, 1].map((scale, i) => (
        <polygon
          key={i}
          points={Array.from({ length: n })
            .map((_, idx) => {
              const ang = (Math.PI * 2 * idx) / n - Math.PI / 2
              return `${cx + Math.cos(ang) * r * scale},${cy + Math.sin(ang) * r * scale}`
            })
            .join(" ")}
          fill="none"
          stroke="var(--border)"
          strokeWidth="0.5"
        />
      ))}
      {Array.from({ length: n }).map((_, i) => {
        const ang = (Math.PI * 2 * i) / n - Math.PI / 2
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={cx + Math.cos(ang) * r}
            y2={cy + Math.sin(ang) * r}
            stroke="var(--border)"
            strokeWidth="0.5"
          />
        )
      })}
      <polygon
        points={polygon}
        fill="var(--primary)"
        fillOpacity="0.18"
        stroke="var(--primary)"
        strokeWidth="1.2"
      />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="2" fill="var(--primary)" />
          <text
            x={p.lx}
            y={p.ly}
            fontSize="8"
            fill="currentColor"
            opacity="0.7"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  )
}

// ---------------------------------------------------------------------
// 通用：右栏 → 大图 Sheet
//   右栏只展示 teaser（300px 装不下完整图谱/曲线），点击右上角小按钮
//   会从右侧滑出 70vw 的 Sheet，里面渲染 children 的"完整版"。
// ---------------------------------------------------------------------
function ExpandSheet({
  title,
  description,
  trigger,
  children,
}: {
  title: string
  description?: string
  trigger?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        {trigger ?? (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground absolute right-2 top-2 size-6"
            aria-label={`展开 ${title}`}
          >
            <Maximize2 className="size-3" />
          </Button>
        )}
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-[min(72vw,1100px)] !max-w-[1100px] overflow-y-auto p-0 sm:w-[min(72vw,1100px)]"
      >
        <SheetHeader className="border-border sticky top-0 z-10 border-b bg-background/95 px-5 py-3 backdrop-blur">
          <SheetTitle className="text-base">{title}</SheetTitle>
          {description && (
            <SheetDescription className="text-xs">
              {description}
            </SheetDescription>
          )}
        </SheetHeader>
        <div className="px-5 py-4">{children}</div>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------
// 通用：section 加载/空态占位
//   variant="skeleton" — 数据未到（undefined），三条灰色脉冲条
//   variant="empty"    — 数据到了但为空（[]），自定义文案 + 可选 cta
// ---------------------------------------------------------------------
function SectionLoading({
  variant = "skeleton",
  message,
  cta,
}: {
  variant?: "skeleton" | "empty"
  message?: string
  cta?: React.ReactNode
}) {
  if (variant === "empty") {
    return (
      <div className="text-muted-foreground/80 border-border my-1 flex flex-col items-center gap-2 rounded-md border border-dashed bg-secondary/20 py-4 px-3 text-center text-[11px]">
        <Sparkles className="text-muted-foreground/60 size-3.5" />
        <span className="leading-snug">{message ?? "暂无数据"}</span>
        {cta}
      </div>
    )
  }
  return (
    <div className="space-y-1.5 px-1 py-1.5" aria-hidden="true">
      <div className="bg-muted/60 h-3 w-2/3 rounded" />
      <div className="bg-muted/40 h-3 w-full rounded" />
      <div className="bg-muted/40 h-3 w-3/4 rounded" />
    </div>
  )
}

// ---------------------------------------------------------------------
// 从正文提取关系图谱 — 触发后端异步任务
// POST /api/v1/books/:id/relationship-graph/extract
// ---------------------------------------------------------------------
function ExtractGraphButton({
  lang,
  onDone,
}: {
  lang: "zh" | "en"
  onDone?: () => void
}) {
  const { bookId } = useStudio()
  const [state, setState] = React.useState<"idle" | "running" | "done" | "error">("idle")

  async function handleExtract() {
    setState("running")
    try {
      const response = await fetch(
        `/api/v1/books/${encodeURIComponent(bookId)}/relationship-graph/extract`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "recent", merge: true }),
        },
      )
      if (!response.ok) throw new Error(await response.text())
      setState("done")
      onDone?.()
    } catch {
      setState("error")
    }
  }

  return (
    <button
      onClick={state === "running" ? undefined : handleExtract}
      disabled={state === "running"}
      className={cn(
        "mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-medium transition-all",
        state === "idle"
          ? "border-border text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5"
          : state === "running"
            ? "border-primary/30 bg-primary/5 text-primary cursor-wait"
            : state === "done"
              ? "border-status-success/30 bg-status-success/5 text-status-success"
              : "border-status-danger/30 bg-status-danger/5 text-status-danger hover:border-status-danger/50",
      )}
    >
      <RefreshCcw
        className={cn("size-3", state === "running" && "animate-spin")}
      />
      {state === "idle"
        ? lang === "zh"
          ? "从正文重新提取关系图谱"
          : "Re-extract graph from manuscript"
        : state === "running"
          ? lang === "zh"
            ? "提取中…"
            : "Extracting…"
          : state === "done"
            ? lang === "zh"
            ? "提取完成 · 图谱已更新"
            : "Extracted · graph updated"
            : lang === "zh"
              ? "提取失败 · 重试"
              : "Failed · retry"}
    </button>
  )
}
