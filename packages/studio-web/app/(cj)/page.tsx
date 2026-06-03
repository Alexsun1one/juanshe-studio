"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import {
  fetchAgents,
  fetchChapters,
  fetchManuscript,
  fetchPlotProgress,
  fetchProjectPrefs,
  fetchQuality,
  startWriteBatch,
  startWriteNextChapter,
  stopBookWorkflow,
  approveQualifyingChapters,
} from "@/lib/api/client"
import { useWorkspace } from "@/lib/workspace-context"
import { NewBookDialog } from "@/components/workbench/new-book-dialog"
import { WarmWhisper } from "@/components/workbench/warm-whisper"
import { CelebrationBurst } from "@/components/workbench/celebration-burst"
import { EditorialOfficeHero } from "@/components/workbench/editorial-office-hero"
import { FirstRunHero } from "@/components/workbench/first-run-hero"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useLiveRun } from "@/lib/use-live-run"
import { useRunState } from "@/lib/use-run-state"
import { useAgentActivity } from "@/lib/use-agent-activity"
import { useTypewriter } from "@/lib/use-typewriter"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"
import { showWriteBlockToast } from "@/lib/write-block-toast"
import { Meter } from "@/components/design/kit"
import { AgentPixel } from "@/components/design/agent-pixel"
import { CjTour } from "@/components/shell/cj-tour"
import { PixelCat } from "@/components/design/pixel-cat"
import { renderProse, useEntityDict } from "@/lib/prose-highlight"
import { VipUpgradeDialog } from "@/components/cj/vip-upgrade-dialog"
import "./dashboard.css"

const AGENT_STATE_LABEL: Record<string, string> = {
  running: "运行中",
  streaming: "运行中",
  done: "✓",
  idle: "待命",
  queued: "排队",
  paused: "暂停",
  error: "失败",
  warning: "警告",
}

// 按编辑部部门重新分组智能体,避免大网格平铺。
// 顺序对应实际流水线节奏:战略 → 写作 → 评审 → 修改 → 运营 → 总编。
// agents 用的是 FRONTEND_AGENT_IDS 里的规范 id(见 lib/api/agent-aliases),不是后端原始 id。
const AGENT_DEPTS: ReadonlyArray<{
  id: string
  label: string
  hint: string
  agents: ReadonlyArray<string>
}> = [
  { id: "strategy", label: "战略选题", hint: "趋势 / 故事框架 / 立基",      agents: ["market-radar", "architect", "setup-auditor"] },
  { id: "writing",  label: "写作",     hint: "规划意图 → 写手 → 分析",     agents: ["planner", "writer", "chapter-analyst"] },
  { id: "review",   label: "评审",     hint: "审稿 + 读者视角 + 总分报告", agents: ["editor", "reader-critic", "quality-report"] },
  { id: "revision", label: "修改打磨", hint: "修稿 → 字数治理 → 润色",     agents: ["reviser", "word-steward", "polisher"] },
  { id: "ops",      label: "运营质保", hint: "真相校验 / 风格 / 提示词治理", agents: ["state-verifier", "style-fingerprint", "prompt-steward"] },
  { id: "eic",      label: "总编室",   hint: "签发与方向把控",              agents: ["managing-editor", "editor-in-chief"] },
]


type DashboardWorkflowAction = "continue" | "stop" | "batch"

function gradeOf(score: number): string {
  if (score >= 90) return "A"
  if (score >= 85) return "A-"
  if (score >= 80) return "B+"
  if (score >= 70) return "B"
  if (score >= 60) return "C"
  return "D"
}
function judgeOf(score: number): { label: string; cls: string } {
  if (score >= 85) return { label: "优秀", cls: "ok" }
  if (score >= 75) return { label: "良好", cls: "good" }
  if (score >= 60) return { label: "及格", cls: "warn" }
  return { label: "待改", cls: "warn" }
}
// 维度分按档位上不同暖色(高=冷静正向,低=暖色提醒),让数值有层次而非一片深色
function dimTier(v: number): string {
  if (v >= 95) return "t-excellent"
  if (v >= 88) return "t-strong"
  if (v >= 80) return "t-good"
  if (v >= 70) return "t-ok"
  return "t-weak"
}
const fmt = (n: number | undefined | null) =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "—"

function describeHandoffReason(stage: string | undefined, currentAgentId: string | undefined) {
  const text = `${stage ?? ""} ${currentAgentId ?? ""}`
  if (/规划|意图|上下文|planner/i.test(text)) return "规划师完成章节意图、规则栈和上下文包后交给写手落正文。"
  if (/撰写|草稿|正文|token|writer/i.test(text)) return "写手产出草稿后交给审稿官检查逻辑、连续性和伏笔兑现。"
  if (/审计|审稿|audit|editor/i.test(text)) return "审稿官根据质量门槛决定放行、返给修稿师，或进入润色。"
  if (/修复|修稿|重写|reviser|word-steward/i.test(text)) return "修稿结果会回到审稿/质量链路复验，未达标不会继续硬写。"
  if (/润色|polisher/i.test(text)) return "润色师完成文字层修整后交给质量报告官汇总评分。"
  if (/质量|Gate|报告|quality/i.test(text)) return "质量报告官给出签发、复修或暂停的明确结论。"
  return "每个智能体只在上一步产物可用后接棒，交棒记录会写入运行日志。"
}

function dashboardWorkflowActionCopy(input: {
  action: DashboardWorkflowAction
  title: string
  curChapter: number
  batchN: number
  targetQuality: number
  targetWords: number
  stage?: string
}) {
  switch (input.action) {
    case "continue":
      return {
        title: "启动真实续写？",
        description: `这会调用后端写作流水线，为《${input.title}》从第 ${input.curChapter || "—"} 章之后继续生成，可能消耗 LLM token 并写入稿件文件。`,
        guardrail: "只做界面检查或浏览器 smoke 时请保持当前状态；需要真实写作时再确认。",
        confirmLabel: "确认续写",
        destructive: false,
      }
    case "batch":
      return {
        title: `启动连续写 ${input.batchN} 章？`,
        description: `这会逐章调用真实写作流水线，单章目标 ${input.targetWords.toLocaleString("en-US")} 字，质量门槛 ${input.targetQuality} 分；每章都可能消耗 LLM token 并写入稿件。`,
        guardrail: "达不到质量门槛会先自动复修，修不到就停在那一章，不会硬往下写。",
        confirmLabel: `确认连续写 ${input.batchN} 章`,
        destructive: false,
      }
    case "stop":
      return {
        title: "停止当前工作流？",
        description: `这会调用后端停止工作流端点，取消未完成任务并释放执行槽。当前阶段：${input.stage || "运行中"}。`,
        guardrail: "已经落库的章节和恢复草稿会保留在本地；停止后不会再启动新的 Agent 步骤。",
        confirmLabel: "确认停止",
        destructive: true,
      }
  }
}

export default function CjDashboard() {
  const router = useRouter()
  const { books, bookId, booksLoading } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const key = (name: string) => (bookId ? [name, bookId] : null)

  // 首页写作器接入实时流式:正在写就把写手逐字正文打出来,而不是停在已保存的上一章。
  const live = useLiveRun(bookId)
  const proseDict = useEntityDict(bookId) // 人物/地点字典(story-graph),供正文语义分色
  // 优雅逐字:无论上游一次推多少,前端都一个字一个字吐出来
  const typed = useTypewriter(live.text, live.active)
  // 实时流水线状态机:哪个 agent 已完成 / 正在跑 / 待命
  const activity = useAgentActivity(bookId)
  const streamRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = streamRef.current
    if (el && live.active) el.scrollTop = el.scrollHeight
  }, [typed, live.active])

  // 按书域数据可能对某些书缺失,容错:错误不重试,缺失则走兜底
  const soft = { shouldRetryOnError: false }
  // 章节/正文会随后端改写回滚变化:定时重拉,避免显示已删除的旧章节/旧正文
  const fresh = { ...soft, refreshInterval: 6000 }
  const { data: chapters } = useSWR(key("chapters"), () => fetchChapters(bookId), fresh)
  const { data: plot } = useSWR(key("plot"), () => fetchPlotProgress(bookId), soft)
  const { data: agents } = useSWR("agents", fetchAgents, { refreshInterval: 8000 })
  const { data: prefs } = useSWR("prefs", fetchProjectPrefs, soft)
  const curChapter = active?.currentChapter ?? 0
  const immersiveHref = curChapter ? `/immersive?chapter=${curChapter}` : "/immersive"
  const { data: quality } = useSWR(
    bookId && curChapter ? ["quality", bookId, curChapter] : null,
    () => fetchQuality(bookId, curChapter),
    soft,
  )
  const { data: manuscript } = useSWR(
    bookId && curChapter ? ["ms", bookId, curChapter] : null,
    () => fetchManuscript(bookId, curChapter),
    fresh,
  )

  const [busy, setBusy] = React.useState(false)
  // 续写/连写点击后 → run 真跑起来之间的"模型准备中"态,避免用户以为没反应而狂点
  const [preparing, setPreparing] = React.useState(false)
  // 写作强度档位(轻中重):默认 = 当前激活等级允许的最高档(normal→轻 / pro→中 / ultra→重);可往下选省 token
  const [tier, setTier] = React.useState<"normal" | "pro" | "ultra">("normal")
  React.useEffect(() => { try { const t = localStorage.getItem("cj.tier"); if (t === "pro" || t === "ultra") setTier(t) } catch { /* ignore */ } }, [])
  const maxMode: "light" | "standard" | "max" = tier === "ultra" ? "max" : tier === "pro" ? "standard" : "light"
  const [writeMode, setWriteMode] = React.useState<"light" | "standard" | "max">("light")
  React.useEffect(() => { setWriteMode(maxMode) }, [maxMode])
  // 成为 VIP / 升级弹窗:点锁住的「中/重」档即弹出
  const [vipOpen, setVipOpen] = React.useState(false)
  const [batchN, setBatchN] = React.useState(10)
  // 本批次的过线分数:从 prefs 默认带出,允许用户在写作器里临时改(不写回 prefs)
  const [batchScore, setBatchScore] = React.useState<number | null>(null)
  const [confirmAction, setConfirmAction] = React.useState<DashboardWorkflowAction | null>(null)
  // 新建书向导:工作台直接打开,不再跳 /books
  const [newBookOpen, setNewBookOpen] = React.useState(false)

  // 「续写一开,创作流程自动进入剧场态」的 ref(effect 在 isRunning 派生之后再注册,避免 TDZ)
  const agentsFlowRef = React.useRef<HTMLDivElement | null>(null)
  const lastRunSig = React.useRef<string>("")

  // 真实写作状态(后端 task_runs)+ 实时流式(SSE token)双信号:
  // 轮询给出权威的"是否在跑 / 当前 agent / 阶段",SSE 的逐字流让横幅秒级点亮。
  const run = useRunState(bookId)
  const isRunning = run.isRunning || live.active
  const activeRun = run.activeRun
  const liveStage = activity.currentText || run.currentStage || (live.active ? live.stageText : undefined)
  const liveAgentId = activity.currentAgentId || run.currentAgentId || (live.active ? live.agentId : undefined)
  const agentList = agents ?? []
  // 「续写一开,创作流程自动进入剧场态」:刚从待命切到运行 → 把右栏滚进可视区
  React.useEffect(() => {
    const sig = isRunning ? (liveAgentId || "running") : "idle"
    if (sig !== "idle" && lastRunSig.current === "idle") {
      agentsFlowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    }
    lastRunSig.current = sig
  }, [isRunning, liveAgentId])

  // 进展庆祝:写作从"运行"回到"待命"(一章/一轮刚写完)→ 触发一次温暖的像素庆祝
  const [celebrateSig, setCelebrateSig] = React.useState(0)
  const prevRunning = React.useRef(false)
  React.useEffect(() => {
    if (prevRunning.current && !isRunning) setCelebrateSig((s) => s + 1)
    prevRunning.current = isRunning
  }, [isRunning])

  const handoffCurrentId = isRunning ? (liveAgentId || "planner") : "planner"
  const handoffCurrentIndex = agentList.findIndex((a) => toFrontendAgentId(a.id) === handoffCurrentId)
  const handoffCurrentAgent = handoffCurrentIndex >= 0 ? agentList[handoffCurrentIndex] : undefined
  const handoffNextAgent = handoffCurrentIndex >= 0 ? agentList[handoffCurrentIndex + 1] : agentList.find((a) => toFrontendAgentId(a.id) === "writer")
  const handoffStage = liveStage || activeRun?.currentStage || (isRunning ? "任务运行中" : "等待续写指令")
  const handoffReason = isRunning
    ? describeHandoffReason(handoffStage, handoffCurrentId)
    : "点击继续创作后，规划师先读取设定、记忆和章节索引，再把章节意图交给写手。"

  // "模型准备中"态:run 真跑起来(isRunning)即解除;30s 兜底防卡死。期间写作按钮显示"模型准备中…"
  React.useEffect(() => {
    if (!preparing) return
    if (isRunning) { setPreparing(false); return }
    const t = window.setTimeout(() => setPreparing(false), 30000)
    return () => window.clearTimeout(t)
  }, [preparing, isRunning])

  const onContinue = async () => {
    if (!bookId) return
    if (isRunning) {
      toast.info("正在写作中", {
        description: `${activeRun?.currentStage || "当前章节生成中"} —— 等它写完,或先点「停止工作流」再续。`,
      })
      return
    }
    setBusy(true)
    try {
      // 关键修复:手动续写必须带上用户配置的过线分(targetQuality),否则后端默认 90、
      // 比你设的门槛(如 85)更严 —— 这会把本来达标(≥85)的旧章误判为未过线而挡住续写。
      // 连续写一直是按 targetQuality 把关的,这里对齐,保证"哪种写法都用同一条过线"。
      await startWriteNextChapter(bookId, { targetScore: targetQuality, mode: writeMode })
      setPreparing(true)
      toast.success("已唤醒编辑部,模型准备中…", { description: "规划师正在读取设定与记忆,马上开写。" })
      run.refresh()
    } catch (e) {
      if (!showWriteBlockToast(e, {
        onConfigureLlm: () => router.push("/llm"),
        onApproveQualifying: bookId ? async () => { await approveQualifyingChapters(bookId, { targetScore: targetQuality }) } : undefined,
        bookId: bookId ?? undefined,
      })) toast.error(`触发失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const onStop = async () => {
    if (!isRunning) {
      toast.info("当前没有运行中的工作流")
      return
    }
    setBusy(true)
    try {
      await stopBookWorkflow(bookId as string, "用户在工作台停止写作")
      toast.success("已停止工作流")
      run.refresh()
    } catch (e) {
      toast.error(`停止失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  // 连续写 N 章:每章按质量门槛把关,不达标即停(不会硬往下写,避免"写到100章才发现第10章没过")
  const onBatch = async () => {
    if (!bookId) return
    if (isRunning) {
      toast.info("正在写作中", { description: "等当前任务结束,或先停止再开始连续写。" })
      return
    }
    setBusy(true)
    try {
      await startWriteBatch(bookId, { chapters: batchN, targetScore: targetQuality, wordCount: targetWords })
      setPreparing(true)
      toast.success(`已开始连续写 ${batchN} 章`, {
        description: `每章按 ${targetQuality} 分把关:达不到先自动复修,修不到就停在那一章,绝不硬往下写。`,
      })
      run.refresh()
    } catch (e) {
      if (!showWriteBlockToast(e, {
        onConfigureLlm: () => router.push("/llm"),
        onApproveQualifying: bookId ? async () => { await approveQualifyingChapters(bookId, { targetScore: targetQuality }) } : undefined,
        bookId: bookId ?? undefined,
      })) toast.error(`触发失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const openWorkflowConfirm = (action: DashboardWorkflowAction) => {
    if ((action === "continue" || action === "batch") && !bookId) return
    if ((action === "continue" || action === "batch") && isRunning) {
      toast.info("正在写作中", { description: "等当前任务结束,或先停止再开始新的写作任务。" })
      return
    }
    if (action === "stop" && !isRunning) {
      toast.info("当前没有运行中的工作流")
      return
    }
    setConfirmAction(action)
  }

  const confirmWorkflowAction = async () => {
    const action = confirmAction
    if (!action) return
    setConfirmAction(null)
    if (action === "continue") {
      await onContinue()
      return
    }
    if (action === "batch") {
      await onBatch()
      return
    }
    await onStop()
  }

  // 键盘:⌘/Ctrl + Enter = 继续创作;⌘/Ctrl + Shift + Enter = 连续写 N 章。
  // 输入框聚焦时不拦截,避免 spinbutton 内回车被误吞。
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key !== "Enter") return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return
      e.preventDefault()
      if (e.shiftKey) openWorkflowConfirm("batch")
      else openWorkflowConfirm("continue")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, isRunning, busy, batchN])

  // ── derived ──
  const overall = Math.round(quality?.overall ?? 0)
  const dims = quality
    ? [
        { label: "一致性", v: Math.round(quality.consistency) },
        { label: "节奏感", v: Math.round(quality.pacing) },
        { label: "情感张力", v: Math.round(quality.emotion) },
        { label: "文笔质量", v: Math.round(quality.diction) },
        // 去 AI 味(高=人味重,低=AI 痕迹重;后端 analyzeAITells 结构化检测:段长方差/套话/转折公式/列表式/陈词意象等)
        // 与其它维度同向(都是越高越好),避免行内混合 high=good / high=bad 两种语义。
        { label: "去AI味", v: Math.round(quality.aiTone) },
      ]
    : []
  const dialFill = ((overall / 100) * 264).toFixed(0)

  const curChapterRow = chapters?.find((c) => c.num === curChapter)
  const targetWords = prefs?.defaultRun.targetWordsPerChapter ?? 5000
  // 有效门槛:用户在写作器里改了就用 batchScore,否则跟着项目默认走
  const prefDefaultQuality = prefs?.defaultRun.targetQuality ?? 90
  const targetQuality = batchScore ?? prefDefaultQuality
  const chapterWords = curChapterRow?.words ?? 0
  const chapterPct = targetWords ? Math.min(100, Math.round((chapterWords / targetWords) * 100)) : 0
  const planned = active?.plannedChapters || active?.chapterCount || 0
  const bookPct = planned ? Math.round((curChapter / planned) * 100) : (active?.currentChapterPct ?? 0)
  const confirmCopy = confirmAction
    ? dashboardWorkflowActionCopy({
        action: confirmAction,
        title: active?.title.zh ?? "—",
        curChapter,
        batchN,
        targetQuality,
        targetWords,
        stage: activeRun?.currentStage || liveStage,
      })
    : null

  // 长短期记忆卡已下沉到 /memory 专页;首页不再重复展示统计 + 片段。
  const milestones = plot?.milestones ?? []

  if (!booksLoading && !active) {
    return (
      <div className="page cj-dashboard">
        <FirstRunHero onCreate={() => setNewBookOpen(true)} />
        <NewBookDialog open={newBookOpen} onOpenChange={setNewBookOpen} />
      </div>
    )
  }

  return (
    <div className="cj-screen cj-workbench cj-dashboard">
      {/* ── 顶部工作条:书架(重复实体卡)+ 标题 + 一行小型 KPI token ── */}
      <header className="cj-workhead">
      {/* 书架已移除:顶栏作品切换器已能切书,首页不再用一排书卡占一屏高度 —— 工作头聚焦当前作品。
          (反馈 2026-05-30:学 GPT 首页去书架,腾出写作区) */}

      {/* 标题块 — 评分 / 五维 / 运行指标内联为小型 status token,不做大卡 */}
      <div className="dash-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span className="tag brand">
            <span className="dot" style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", display: "inline-block" }} />
            {isRunning ? "AI 正在写" : "等候指令"}
          </span>
        </div>
        <div className="dash-title-row">
          <h1 className="page-title">《{active?.title.zh ?? "—"}》</h1>
          <span className="tag">{active?.kindLabel.zh ?? "作品"}</span>
          <button
            type="button"
            className="title-newbook"
            onClick={() => setNewBookOpen(true)}
            title="开建一部新书 — 编辑部会自动起稿故事框架 / 角色矩阵 / 章节地图"
          >
            <span aria-hidden>+</span> 新建一本
          </button>
          <div className="dash-score" data-judge={overall ? judgeOf(overall).cls : undefined} title={`本章质量评分 · 第 ${curChapter} 章`}>
            <span className="ds-label">本章评分</span>
            <span className="ds-num">{overall || "—"}</span>
            {(quality?.band || (overall && gradeOf(overall))) ? (
              <span className="ds-grade">{quality?.band ?? gradeOf(overall)}</span>
            ) : null}
          </div>
        </div>
        <div className="dash-meta">
          <span className="meta-cell">
            写到 <strong className="mv-ch">第 {curChapter} 章</strong>
            {curChapterRow?.title.zh ? ` · ${curChapterRow.title.zh}` : ""}
          </span>
          <span className="meta-cell">
            累计 <strong className="num mv-words">{fmt(active?.totalWords)}</strong> 字
          </span>
          <span className="meta-cell">
            进度 <strong className="num mv-prog">{bookPct}%</strong>
            <span className="bar"><i style={{ width: `${bookPct}%` }} /></span>
          </span>
          <span className="meta-cell muted-cell">
            单章 <strong className="num mv-cfg">{fmt(targetWords)}</strong> 字 · 过线 <strong className="num mv-cfg">{targetQuality}</strong> 分 · 至多改 <strong className="num mv-cfg">{prefs?.defaultRun.maxRewritesPerChapter ?? 2}</strong> 轮
            <Link href="/preferences" className="meta-link" title="调整目标/门槛/改写轮次">调</Link>
          </span>
        </div>
        {dims.length > 0 && (
          <div className="dash-quality">
            <div className="dq-dims">
              {dims.map((d) => {
                const j = judgeOf(d.v)
                return (
                  <span className={`dq-dim ${dimTier(d.v)}`} key={d.label} title={`${d.label} ${d.v} · ${j.label}`}>
                    <span className="k">{d.label}</span>
                    <span className="v">{d.v}</span>
                  </span>
                )
              })}
            </div>
            <span className="dq-sep" aria-hidden />
            <div className="dq-metrics">
              <span className="dq-m">本章 <b className="num mm-brand">{fmt(chapterWords)}</b><span className="u">/ {fmt(targetWords)} 字</span></span>
              <span className="dq-m">Token <b className="num">{fmt(quality?.tokens)}</b></span>
              <span className="dq-m">速度 <b className="num">{quality?.speedWordsPerMinute ? Math.round(quality.speedWordsPerMinute) : "—"}</b><span className="u">字/分</span></span>
              <span className="dq-m">采纳 <b className="num ok">{quality?.adopted ? fmt(Math.round(quality.adopted)) : "—"}</b><span className="u">字</span></span>
            </div>
          </div>
        )}
      </div>

      </header>

      <WarmWhisper writing={isRunning} />
      <CelebrationBurst signal={celebrateSig} />

      {/* ── 主体:中央写作工作区 + 右侧 Inspector(滚动只在各自 pane 内)── */}
      <div className="cj-screen-body wb-body">
        <div className="cj-mainpane">
          {/* 沉浸写作器 */}
          <section className="writer">
            <div className="writer-head">
              <span className={`writer-status${isRunning ? "" : " idle"}`}>
                <span className="pulse" />
                {isRunning ? "AI 写作中" : "等候继续"}
              </span>
              <span className="writer-elapsed">
                {isRunning && liveStage ? `阶段 · ${liveStage}` : `第 ${curChapter} 章 · ${curChapterRow?.title.zh ?? "未命名"}`}
              </span>
              <div className="writer-actions">
                <div className="write-mode-seg" role="group" aria-label="写作强度档位">
                  {(([["light", "轻"], ["standard", "中"], ["max", "重"]] as const)).map(([m, label]) => {
                    const locked = (m === "standard" && tier === "normal") || (m === "max" && tier !== "ultra")
                    return (
                      <button
                        key={m}
                        type="button"
                        className={`wm-opt${writeMode === m ? " on" : ""}${locked ? " locked" : ""}`}
                        onClick={() => { if (locked) setVipOpen(true); else setWriteMode(m) }}
                        disabled={isRunning || preparing}
                        title={locked
                          ? (m === "max" ? "「重·Ultra」需 Ultra 会员 · 点击查看如何升级" : "「中·Pro」需 Pro 会员 · 点击查看如何升级")
                          : (m === "light" ? "轻量 · 最省 token(规划→写手→审稿,跳润色/额外评审)" : m === "standard" ? "均衡 · 加一轮复修 + 润色" : "最高质量 · 全流程复修+去AI味+读者/风格评审")}
                      >
                        {label}{locked && <span className="wm-lock">🔒</span>}
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  className={`ctrl primary${busy || preparing ? " is-loading" : ""}`}
                  onClick={() => openWorkflowConfirm("continue")}
                  disabled={busy || preparing || !bookId || isRunning}
                  title="继续创作  (⌘/Ctrl + Enter)"
                >
                  {isRunning ? "写作中" : preparing ? "模型准备中…" : "继续创作"}
                  {!isRunning && !preparing && <kbd className="kbd">⌘↵</kbd>}
                </button>
                {isRunning && (
                  <button
                    type="button"
                    className="ctrl danger"
                    onClick={() => openWorkflowConfirm("stop")}
                    disabled={busy}
                  >
                    停止
                  </button>
                )}
                <Link href={immersiveHref} className="ctrl">全屏沉浸</Link>
                <Link href="/editor" className="ctrl">展开编辑器</Link>
              </div>
            </div>

            <div className="writer-body cj-pane-scroll" ref={streamRef}>
              {live.active && live.text ? (
                <p className="live-stream">{renderProse(typed, proseDict)}<span className="dash-caret" aria-hidden /></p>
              ) : manuscript?.paragraphs?.length ? (
                manuscript.paragraphs.slice(0, 9).map((p, i) =>
                  p.quote ? (
                    <p key={i}><span className="accent">{renderProse(p.zh, proseDict, `q${i}-`)}</span></p>
                  ) : (
                    <p key={i}>{renderProse(p.zh, proseDict, `p${i}-`)}</p>
                  ),
                )
              ) : (
                <p className="writer-empty">本章还是一张白纸。点「继续创作」就让写手接着上一章往下写。</p>
              )}
            </div>

            <div className="writer-foot">
              {/* 第 1 行:本章进度 + 字数 — 单纯信息展示,不抢焦 */}
              <div className="writer-foot-row writer-foot-progress">
                <span className="writer-foot-label">本章</span>
                <div className="pbar"><i style={{ width: `${chapterPct}%` }} /></div>
                <span className="num">{chapterPct}%</span>
                <span className="writer-foot-words">
                  <span className="delta">{fmt(live.active ? live.charCount : chapterWords)}</span>
                  <span className="muted-slash">/</span>
                  {fmt(targetWords)}
                  <span className="muted-slash">字</span>
                </span>
              </div>
              {/* 第 2 行:连续写参数(章数 + 门槛分数,均可改)+ 状态 + 启动按钮 */}
              <div className="writer-foot-row writer-batch-row">
                <label className="writer-batch-field">
                  <span className="writer-batch-label">连续写</span>
                  <input
                    type="number"
                    className="wf-batch-num"
                    min={1}
                    max={500}
                    step={1}
                    value={batchN}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n) && n > 0) setBatchN(Math.min(500, Math.max(1, Math.round(n))))
                    }}
                    disabled={busy || isRunning}
                    aria-label="连续写章数"
                  />
                  <span className="muted-slash">章</span>
                </label>
                <label className="writer-batch-field writer-batch-gate-field">
                  <span className="writer-batch-label">过线</span>
                  <input
                    type="number"
                    className="wf-batch-num wf-gate-num"
                    min={60}
                    max={100}
                    step={1}
                    value={targetQuality}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n) && n > 0) setBatchScore(Math.min(100, Math.max(60, Math.round(n))))
                    }}
                    disabled={busy || isRunning}
                    aria-label="质量门槛分数"
                  />
                  <span className="muted-slash">分</span>
                  {batchScore !== null && batchScore !== prefDefaultQuality && (
                    <button
                      type="button"
                      className="writer-batch-reset"
                      onClick={() => setBatchScore(null)}
                      title={`复位回项目默认 ${prefDefaultQuality} 分`}
                    >
                      复位
                    </button>
                  )}
                </label>
                <span className={`writer-batch-state${isRunning ? " is-running" : run.lastError ? " is-error" : " is-idle"}`}>
                  <span className="dot" aria-hidden />
                  {isRunning ? "运行中" : run.lastError ? "已清理" : "待命"}
                </span>
                <button
                  type="button"
                  className={`ctrl batch${busy || preparing ? " is-loading" : ""}`}
                  onClick={() => openWorkflowConfirm("batch")}
                  disabled={busy || preparing || !bookId || isRunning}
                  title="连续写 N 章,达不到质量门槛即停  (⌘/Ctrl + Shift + Enter)"
                >
                  {preparing ? "模型准备中…" : "开始连续写"}
                  {!preparing && <kbd className="kbd">⌘⇧↵</kbd>}
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* ── 右侧 Inspector:接棒 / 质量门槛 / 风险(只在 pane 内滚)── */}
        <aside className="cj-inspector wb-inspector" ref={agentsFlowRef}>
          <div className="cj-pane-scroll wb-insp-scroll">
          {/* 交棒条(当前 → 下一棒 + 依据)*/}
          <section className={`card flow-handoff${isRunning ? " flow-live" : ""}`}>
            <div className="card-head" style={{ marginBottom: 8 }}>
              <div className="card-title">本轮接棒</div>
              <Link href="/system" className="card-action">运行日志 →</Link>
            </div>
            <div className={`handoff-strip${isRunning ? " live" : ""}`}>
              <Link
                href={`/system?agent=${encodeURIComponent(handoffCurrentAgent ? toFrontendAgentId(handoffCurrentAgent.id) : "planner")}`}
                className="handoff-node current"
                title="点击查看当前角色"
              >
                <span className="k">当前</span>
                <strong>{handoffCurrentAgent?.name.zh ?? "规划师"}</strong>
                <span>{handoffCurrentAgent?.currentTask?.zh ?? handoffStage}</span>
              </Link>
              <div className="handoff-arrow" aria-hidden>→</div>
              <Link
                href={`/system?agent=${encodeURIComponent(handoffNextAgent ? toFrontendAgentId(handoffNextAgent.id) : "writer")}`}
                className="handoff-node next"
                title="点击查看下一棒角色"
              >
                <span className="k">下一棒</span>
                <strong>{handoffNextAgent?.name.zh ?? "下一智能体"}</strong>
                <span>{handoffNextAgent?.currentTask?.zh ?? "等待上一步产物"}</span>
              </Link>
              <div className="handoff-reason">
                <span>交棒依据</span>
                <strong>{handoffReason}</strong>
              </div>
            </div>
          </section>

          {/* 质量门槛 — 常驻 Inspector 的小卡(次要信息折叠,不再大卡平铺)*/}
          <section className="card wb-gatecard">
            <div className="card-head" style={{ marginBottom: 8 }}>
              <div className="card-title">质量门槛</div>
              <Link href="/preferences" className="card-action">调整 →</Link>
            </div>
            {overall > 0 && (
              <div className="wb-gate-meter">
                <Meter label="本章达标" value={overall} threshold={targetQuality} tone="ok" />
              </div>
            )}
            <div className="wb-gaterow">
              <span className="wb-gate"><i>字数</i><b className="num">≥ {fmt(targetWords)}</b></span>
              <span className="wb-gate"><i>过线</i><b className="num">≥ {targetQuality} 分</b></span>
              <span className="wb-gate"><i>至多改</i><b className="num">{prefs?.defaultRun.maxRewritesPerChapter ?? 2} 轮</b></span>
            </div>
          </section>

          {/* 陪伴 agent — 当前工作流是哪个 agent,就让 ta 坐在这儿"写字";切换时丝滑过渡(key 触发淡入)。
              呼应"和一群 agent 一起创作"的陪伴感(反馈 2026-05-30:放质量门槛下面)。 */}
          <section className="card wb-companion" aria-live="polite">
            <div className="wb-companion-stage" data-running={isRunning ? "1" : undefined}>
              <AgentPixel
                key={handoffCurrentId}
                id={handoffCurrentId}
                size={92}
                ariaLabel={handoffCurrentAgent?.name.zh ?? "规划师"}
                className="wb-companion-pixel"
              />
              <span className="wb-companion-desk" aria-hidden />
            </div>
            <div className="wb-companion-meta">
              <span className="wb-companion-name">{handoffCurrentAgent?.name.zh ?? "规划师"}</span>
              <span className="wb-companion-task">
                {isRunning ? (handoffStage || "正在为你写作…") : "在编辑部待命 · 随时接棒"}
              </span>
            </div>
          </section>

          </div>
        </aside>
      </div>


      {/* 里程碑已下沉到 /outline(路线图);工作台保持一屏一意图,不再在底部堆条带 */}
      {confirmCopy && (
        <AlertDialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmCopy.title}</AlertDialogTitle>
              <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
                <span>{confirmCopy.description}</span>
                <span className="border-border bg-secondary text-foreground/80 rounded-md border px-3 py-2 font-mono text-[11px] leading-relaxed">
                  《{active?.title.zh ?? "—"}》 · 当前第 {curChapter || "—"} 章 · 单章目标 {targetWords.toLocaleString("en-US")} 字 · 质量门槛 {targetQuality} 分
                </span>
                <span>{confirmCopy.guardrail}</span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={busy}>保持当前状态</AlertDialogCancel>
              <AlertDialogAction
                type="button"
                disabled={busy}
                className={confirmCopy.destructive ? "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20" : undefined}
                onClick={(event) => {
                  event.preventDefault()
                  void confirmWorkflowAction()
                }}
              >
                {confirmCopy.confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      <NewBookDialog open={newBookOpen} onOpenChange={setNewBookOpen} />
      <VipUpgradeDialog open={vipOpen} onOpenChange={setVipOpen} tier={tier} />
      <CjTour />
      <PixelCat />
      {/* AI 写作剧场已上移到全站 CjShell(任意页运行都自动弹),此处不再重复挂载 */}
    </div>
  )
}
