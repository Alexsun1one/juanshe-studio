"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR, { mutate } from "swr"
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
  approveChapter,
  repairLowScore,
} from "@/lib/api/client"
import { useWorkspace } from "@/lib/workspace-context"
import { NewBookDialog } from "@/components/workbench/new-book-dialog"
import { WarmWhisper } from "@/components/workbench/warm-whisper"
import { CelebrationBurst } from "@/components/workbench/celebration-burst"
import { EditorialOfficeHero } from "@/components/workbench/editorial-office-hero"
import { FirstRunHero } from "@/components/workbench/first-run-hero"
import { FeedStrip } from "@/components/workbench/feed-strip"
import { StreakCard } from "@/components/workbench/streak-card"
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
import { useAutoRuns } from "@/hooks/use-studio"
import { useEasedNumber } from "@/hooks/use-eased-number"
import { isLiveAutoRunStatus } from "@/lib/studio/run-status"
import { BatchProgress } from "@/components/workbench/batch-progress"
import { useAgentActivity } from "@/lib/use-agent-activity"
import { useTypewriter } from "@/lib/use-typewriter"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"
import { showWriteBlockToast } from "@/lib/write-block-toast"
import { blockerLabels } from "@/lib/blocker-labels"
import { Meter } from "@/components/design/kit"
import { AgentPixel } from "@/components/design/agent-pixel"
import { PlatformHint } from "@/components/design/platform-hint"
import { CjTour } from "@/components/shell/cj-tour"
import { PixelCat } from "@/components/design/pixel-cat"
import { renderProse, useEntityDict } from "@/lib/prose-highlight"
import { StreamingProse } from "@/components/workbench/streaming-prose"
import { StreamFollowChip } from "@/components/workbench/stream-follow-chip"
import { useStickToBottom } from "@/hooks/use-stick-to-bottom"
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

// 工作台正文是预览位(全文在编辑器/沉浸页),只显示开头几段 —— 但截断必须明示,不能让长章被"读短"
const PREVIEW_PARAGRAPHS = 9

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
  unattended?: boolean
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
        title: input.unattended ? `无人值守连写 ${input.batchN} 章？` : `启动连续写 ${input.batchN} 章？`,
        description: `这会逐章调用真实写作流水线，单章目标 ${input.targetWords.toLocaleString("en-US")} 字，质量门槛 ${input.targetQuality} 分；每章都可能消耗 LLM token 并写入稿件。`,
        guardrail: input.unattended
          ? "无人值守:每章修不到门槛也先接受、继续往下写(标记待重修),全程不停。适合挂机,事后再批量重修。"
          : "达不到质量门槛会先自动复修，修不到就停在那一章，不会硬往下写。",
        confirmLabel: input.unattended ? `确认无人值守连写 ${input.batchN} 章` : `确认连续写 ${input.batchN} 章`,
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
  const { books, bookId, booksLoading, refreshBooks } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const key = (name: string) => (bookId ? [name, bookId] : null)

  // 首页写作器接入实时流式:正在写就把写手逐字正文打出来,而不是停在已保存的上一章。
  const live = useLiveRun(bookId)
  const proseDict = useEntityDict(bookId) // 人物/地点字典(story-graph),供正文语义分色
  // 读到的人物/地点就地一点直达实体页 —— 减少"想查谁就得离开当前页去翻"的上下文切换负担
  const goEntity = React.useCallback(
    (name: string) => router.push(`/characters/${encodeURIComponent(name)}`),
    [router],
  )
  // 优雅逐字:无论上游一次推多少,前端都一个字一个字吐出来
  const typed = useTypewriter(live.text, live.active)
  // 实时流水线状态机:哪个 agent 已完成 / 正在跑 / 待命
  const activity = useAgentActivity(bookId)
  const streamRef = React.useRef<HTMLDivElement>(null)
  // 贴底才跟随:用户上翻回读即解除自动滚底,浮出「回到最新」;贴回底部恢复跟随
  const stick = useStickToBottom(streamRef, typed, live.active)

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
  // 连续写批次进度(auto-runs):与 /runs 共享 SWR key,不新增轮询通道。
  // 「第几章/还剩几章/重写几轮/ETA」这些挂机最核心的安心感信息,就地摆在写作器头部,不必跑去运行台。
  const { data: autoRuns } = useAutoRuns()
  const batchRun = React.useMemo(
    () => (autoRuns ?? []).find((r) => r.bookId === bookId && isLiveAutoRunStatus(r.status)),
    [autoRuns, bookId],
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
  // 无人值守续写:低分先接受、不停下、事后批量重修(走 write-batch livestream)。适合挂机连写几十章。
  const [unattended, setUnattended] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<DashboardWorkflowAction | null>(null)
  // 新建书向导:工作台直接打开,不再跳 /books
  const [newBookOpen, setNewBookOpen] = React.useState(false)
  // 深链 /?new=1:从任意页(⌘K「新建一本书」/ 书架「新建一本」)一键直达并自动开建书弹窗,
  // 省掉"跳到工作台后还得再找一次新建一本"的第二下点击。开后清掉 query,避免刷新/返回重复弹。
  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (new URLSearchParams(window.location.search).get("new") === "1") {
      setNewBookOpen(true)
      window.history.replaceState(null, "", window.location.pathname)
    }
  }, [])

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
  // 失败/中断横幅的本地 dismiss:按错误文本记到 sessionStorage,同一条错误不再纠缠(新错误会再次浮现)
  const [dismissedError, setDismissedError] = React.useState<string | null>(null)
  React.useEffect(() => {
    try { setDismissedError(sessionStorage.getItem("cj.dismissedRunError")) } catch { /* ignore */ }
  }, [])
  const dismissLastError = React.useCallback(() => {
    const text = run.lastError ?? ""
    try { sessionStorage.setItem("cj.dismissedRunError", text) } catch { /* ignore */ }
    setDismissedError(text)
  }, [run.lastError])
  const showFailBanner = !isRunning && !!run.lastError && run.lastError !== dismissedError
  // 「续写一开,创作流程自动进入剧场态」:刚从待命切到运行 → 把右栏滚进可视区
  React.useEffect(() => {
    const sig = isRunning ? (liveAgentId || "running") : "idle"
    if (sig !== "idle" && lastRunSig.current === "idle") {
      agentsFlowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    }
    lastRunSig.current = sig
  }, [isRunning, liveAgentId])

  // 进展庆祝:写作从"运行"回到"待命"(一章/一轮刚写完)→ 触发一次温暖的像素庆祝。
  // tone 区分场景:write=写完一章 / approve=批准达标 / finish=全书完本,文案池各自独立。
  const [celebrate, setCelebrate] = React.useState<{
    sig: number
    tone: "write" | "approve" | "finish"
    note?: string
  }>({ sig: 0, tone: "write" })
  const prevRunning = React.useRef(false)
  React.useEffect(() => {
    if (prevRunning.current && !isRunning) {
      setCelebrate((c) => ({ sig: c.sig + 1, tone: "write" }))
      // 完稿事件 → 解冻工作台数字:books(章号/累计字数/进度)、本章质量分、情节里程碑。
      // 不刷的话庆祝动画放完页面数字纹丝不动,奖励感落空;chapters/ms 已有 6s 轮询,这里不重复。
      void refreshBooks()
      if (bookId) {
        if (curChapter) void mutate(["quality", bookId, curChapter])
        void mutate(["plot", bookId])
      }
    }
    prevRunning.current = isRunning
  }, [isRunning, bookId, curChapter, refreshBooks])

  const handoffCurrentId = isRunning ? (liveAgentId || "planner") : "planner"
  const handoffCurrentIndex = agentList.findIndex((a) => toFrontendAgentId(a.id) === handoffCurrentId)
  const handoffCurrentAgent = handoffCurrentIndex >= 0 ? agentList[handoffCurrentIndex] : undefined
  const handoffNextAgent = handoffCurrentIndex >= 0 ? agentList[handoffCurrentIndex + 1] : agentList.find((a) => toFrontendAgentId(a.id) === "writer")
  const handoffStage = liveStage || activeRun?.currentStage || (isRunning ? "任务运行中" : "等待续写指令")
  const handoffReason = isRunning
    ? describeHandoffReason(handoffStage, handoffCurrentId)
    : "点击继续创作后，规划师先读取设定、记忆和章节索引，再把章节意图交给写手。"

  // "模型准备中"态:run 真跑起来(isRunning)即解除;30s 兜底防卡死。期间写作按钮显示"模型准备中…"
  // 兜底超时不再静默复位按钮 —— 说清"可能哪儿出了问题 + 去哪查",否则用户只觉得"点了没反应"。
  React.useEffect(() => {
    if (!preparing) return
    if (isRunning) { setPreparing(false); return }
    const t = window.setTimeout(() => {
      setPreparing(false)
      toast.warning("模型迟迟没动静", {
        description: "可能是 LLM 配置或后端没响应 —— 去检查模型配置,或到「系统」看运行日志。",
        action: { label: "去配模型", onClick: () => router.push("/llm") },
      })
    }, 30000)
    return () => window.clearTimeout(t)
  }, [preparing, isRunning, router])

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
        onSignOffChapter: bookId ? async (n: number) => { await approveChapter(bookId, n) } : undefined,
        bookId: bookId ?? undefined,
      })) toast.error(`触发失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  // 低分章一键复修:把"分数没到 → 我该怎么办"从"自己去翻流程"降成"就地点一下"。
  // 会触发真实写作流水线(消耗 token),所以仅在未达标时暴露、需用户显式点击;后端自带防重复 + 熔断。
  const onRepair = async () => {
    if (!bookId) return
    if (isRunning) {
      toast.info("正在写作中", { description: "等当前章节写完,或先停止工作流,再复修本章。" })
      return
    }
    setBusy(true)
    try {
      await repairLowScore(bookId, curChapter, { targetScore: targetQuality })
      setPreparing(true)
      toast.success(`已派修稿师复修第 ${curChapter} 章…`, {
        description: `按 ${targetQuality} 分门槛复修,改完自动复验;修不到门槛不会硬放行。`,
      })
      run.refresh()
    } catch (e) {
      if (!showWriteBlockToast(e, {
        onConfigureLlm: () => router.push("/llm"),
        onSignOffChapter: bookId ? async (n: number) => { await approveChapter(bookId, n) } : undefined,
        bookId: bookId ?? undefined,
      })) toast.error(`复修触发失败:${e instanceof Error ? e.message : String(e)}`)
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
  // 批准达标章:把原先只藏在"写作受阻 toast"里的批准动作摆成台面按钮。只批准达标的(未达门槛的会提示复修)。
  // 纯状态变更不消耗 token,但仍改书稿状态,故由用户显式点击。
  const onApprove = async () => {
    if (!bookId) return
    setBusy(true)
    try {
      const res = await approveQualifyingChapters(bookId, { targetScore: targetQuality })
      const n = res.approved?.length ?? 0
      if (n > 0) {
        const rest = reviewCount - n
        // 过审是收获感最强的动作 —— 庆祝交给 CelebrationBurst(approve 档);
        // toast 只在还有未达标章时补一句"接下来怎么办",避免与庆祝卡信息重复。
        setCelebrate((c) => ({ sig: c.sig + 1, tone: "approve", note: `${n} 章正式定稿` }))
        if (rest > 0) {
          toast.info(`还有 ${rest} 章没到 ${targetQuality} 分门槛`, { description: "复修达标后再来批准。" })
        }
      } else {
        toast.info("暂无达标章可批准", { description: `待审章都还没到 ${targetQuality} 分门槛,先点「修复本章」复修再批准。` })
      }
      mutate(["chapters", bookId])
      run.refresh()
    } catch (e) {
      toast.error(`批准失败:${e instanceof Error ? e.message : String(e)}`)
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
      await startWriteBatch(bookId, { chapters: batchN, targetScore: targetQuality, wordCount: targetWords, livestream: unattended })
      setPreparing(true)
      toast.success(unattended ? `已开始无人值守连写 ${batchN} 章` : `已开始连续写 ${batchN} 章`, {
        description: unattended
          ? `无人值守:每章先自动复修,修不到 ${targetQuality} 分也先接受、继续往下写(标记为待重修),全程不停。挂机即可,写完到「一致性扫描」一键批量重修。`
          : `每章按 ${targetQuality} 分把关:达不到先自动复修,修不到就停在那一章,绝不硬往下写。`,
      })
      run.refresh()
    } catch (e) {
      if (!showWriteBlockToast(e, {
        onConfigureLlm: () => router.push("/llm"),
        onApproveQualifying: bookId ? async () => { await approveQualifyingChapters(bookId, { targetScore: targetQuality }) } : undefined,
        onSignOffChapter: bookId ? async (n: number) => { await approveChapter(bookId, n) } : undefined,
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
  // 写完待批准的章数(status="review")——驱动「批准达标章」CTA,把原先只藏在写作受阻 toast 里的批准动作摆到台面
  const reviewCount = chapters?.filter((c) => c.status === "review").length ?? 0
  const targetWords = prefs?.defaultRun.targetWordsPerChapter ?? 5000
  // 有效门槛:用户在写作器里改了就用 batchScore,否则跟着项目默认走
  const prefDefaultQuality = prefs?.defaultRun.targetQuality ?? 90
  const targetQuality = batchScore ?? prefDefaultQuality
  // 低分诊断:从最弱维度 + 具体门禁阻塞推导"为什么没到门槛",摆到分数旁,省去跳 /consistency 翻原因。
  // 排除冗余的 quality-below-target(它只是"没达标",与诊断标题循环),只留具体阻塞(critical/状态链等)。
  const weakDims = [...dims].filter((d) => d.v < 82).sort((a, b) => a.v - b.v).slice(0, 3)
  const realBlockers = blockerLabels(
    (quality?.gate?.blockers ?? []).filter((c) => c !== "quality-below-target"),
  ).slice(0, 2)
  const chapterWords = curChapterRow?.words ?? 0
  const chapterPct = targetWords ? Math.min(100, Math.round((chapterWords / targetWords) * 100)) : 0
  const planned = active?.plannedChapters || active?.chapterCount || 0
  const bookPct = planned ? Math.round((curChapter / planned) * 100) : (active?.currentChapterPct ?? 0)
  // 实时数字滚动:字数/进度这些核心数字从旧值缓动到新值,流式期间不再生硬瞬移(reduced-motion 直接跳)
  const totalWordsEased = useEasedNumber(typeof active?.totalWords === "number" ? active.totalWords : 0)
  const chapterWordsEased = useEasedNumber(chapterWords)
  const liveWordsEased = useEasedNumber(live.active ? live.charCount : chapterWords)
  const chapterPctEased = useEasedNumber(chapterPct)
  // 完本时刻:同一本书的进度首次跨过 100% → finish 档庆祝。
  // 只在 prev>0 且 <100 时触发一次(容忍轮询抖动);切书时重置,不把"切到一本已完本的书"误判成完本。
  const prevBookPct = React.useRef<{ book: string | null; pct: number }>({ book: bookId ?? null, pct: bookPct })
  React.useEffect(() => {
    const prev = prevBookPct.current
    if (prev.book === (bookId ?? null) && prev.pct > 0 && prev.pct < 100 && bookPct >= 100) {
      setCelebrate((c) => ({
        sig: c.sig + 1,
        tone: "finish",
        note: `全书 ${planned || curChapter} 章 · ${fmt(active?.totalWords)} 字`,
      }))
    }
    prevBookPct.current = { book: bookId ?? null, pct: bookPct }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookPct, bookId])
  const confirmCopy = confirmAction
    ? dashboardWorkflowActionCopy({
        action: confirmAction,
        title: active?.title.zh ?? "—",
        curChapter,
        batchN,
        targetQuality,
        targetWords,
        unattended,
        stage: activeRun?.currentStage || liveStage,
      })
    : null

  // 长短期记忆卡已下沉到 /memory 专页;首页不再重复展示统计 + 片段。
  const milestones = plot?.milestones ?? []

  if (!booksLoading && !active) {
    return (
      <div className="page cj-dashboard">
        <FeedStrip />
        <FirstRunHero onCreate={() => setNewBookOpen(true)} />
        <NewBookDialog open={newBookOpen} onOpenChange={setNewBookOpen} />
      </div>
    )
  }

  return (
    <div className="cj-screen cj-workbench cj-dashboard">
      {/* 站长广播动态条:最新 pinned/未读一条,可关可展开;无动态/桌面单机不渲染 */}
      <FeedStrip />
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
          {/* 低分章就地修复:分数没达标时,"修复"按钮直接长在分数旁,不必去翻一致性扫描/连续写流程 */}
          {overall > 0 && overall < targetQuality && !isRunning && (
            <button
              type="button"
              className="ds-repair"
              onClick={onRepair}
              disabled={busy}
              title={`第 ${curChapter} 章 ${overall} 分未达 ${targetQuality} 分门槛 —— 派修稿师复修(会调用写作流水线、消耗 token)`}
            >
              {busy ? "复修中…" : "修复本章"}
            </button>
          )}
        </div>
        <div className="dash-meta">
          <span className="meta-cell">
            写到 <strong className="mv-ch">第 {curChapter} 章</strong>
            {curChapterRow?.title.zh ? ` · ${curChapterRow.title.zh}` : ""}
          </span>
          <span className="meta-cell">
            累计 <strong className="num mv-words">{typeof active?.totalWords === "number" ? fmt(totalWordsEased) : "—"}</strong> 字
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
              {/* 本章字数走缓动滚数;Token/速度/采纳这类小值用 num-tick(key 重挂):变化瞬间闪一下品牌紫再退回墨色 */}
              <span className="dq-m">本章 <b className="num mm-brand">{fmt(chapterWordsEased)}</b><span className="u">/ {fmt(targetWords)} 字</span></span>
              <span className="dq-m">Token <b key={`tk-${quality?.tokens ?? "—"}`} className="num num-tick">{fmt(quality?.tokens)}</b></span>
              <span className="dq-m">速度 <b key={`sp-${quality?.speedWordsPerMinute ?? "—"}`} className="num num-tick">{quality?.speedWordsPerMinute ? Math.round(quality.speedWordsPerMinute) : "—"}</b><span className="u">字/分</span></span>
              <span className="dq-m">采纳 <b key={`ad-${quality?.adopted ?? "—"}`} className="num ok num-tick">{quality?.adopted ? fmt(Math.round(quality.adopted)) : "—"}</b><span className="u">字</span></span>
            </div>
          </div>
        )}
        {overall > 0 && overall < targetQuality && (
          <div className="dq-why" title="未达门槛的具体原因 —— 不用跳一致性扫描就地看清">
            <span className="dq-why-lead">没到 {targetQuality} 是因为</span>
            {weakDims.map((d) => (
              <span className="dq-why-chip dim" key={d.label}>{d.label} <b>{d.v}</b></span>
            ))}
            {realBlockers.map((b, i) => (
              <span className="dq-why-chip blk" key={`b${i}`}>{b}</span>
            ))}
            {weakDims.length === 0 && realBlockers.length === 0 && (
              <span className="dq-why-chip">整体略低于门槛,复修一轮即可</span>
            )}
          </div>
        )}
      </div>

        {/* 写作打卡:顶部工作条右侧一细条(紧凑模式),与黄色信息条同高,不占中央创作区。 */}
        <div className="wb-head-streak">
          <StreakCard compact bookTitle={active?.title.zh ?? "我的作品"} totalWords={active?.totalWords} />
        </div>
      </header>

      {/* 上次写作失败/中断:说清原因 + 给恢复入口(重试/去运行台),不再只留两个字「已清理」 */}
      {showFailBanner && (
        <div className="run-fail-banner" role="status">
          <span className="rfb-ic" aria-hidden>!</span>
          <span className="rfb-text">
            <b>上次写作中断</b>
            <span className="rfb-reason" title={run.lastError}>{(run.lastError ?? "").slice(0, 80)}</span>
          </span>
          <span className="rfb-actions">
            <button
              type="button"
              className="rfb-btn primary"
              onClick={() => { dismissLastError(); openWorkflowConfirm("continue") }}
            >
              重试续写
            </button>
            <Link href="/runs" className="rfb-btn">去运行台 →</Link>
            <button type="button" className="rfb-btn ghost" onClick={dismissLastError}>知道了</button>
          </span>
        </div>
      )}

      <WarmWhisper writing={isRunning} />
      <CelebrationBurst signal={celebrate.sig} tone={celebrate.tone} note={celebrate.note} />

      {/* ── 主体:中央写作工作区 + 右侧 Inspector(滚动只在各自 pane 内)── */}
      <div className="cj-screen-body wb-body">
        <div className="cj-mainpane">
          {/* 沉浸写作器 */}
          <section className="writer">
            <div className="writer-head">
              <span className={`writer-status${isRunning ? "" : " idle"}`}>
                <span className="pulse" />
                {live.reconnecting ? "连接中断 · 重连中…" : isRunning ? "AI 写作中" : "等候继续"}
              </span>
              <span className="writer-elapsed">
                {isRunning && liveStage ? `阶段 · ${liveStage}` : `第 ${curChapter} 章 · ${curChapterRow?.title.zh ?? "未命名"}`}
              </span>
              {/* 连续写批次进度:第几章/还剩几章/重写几轮/ETA + 按章刻度细进度条(数据与运行台同源) */}
              {batchRun && <BatchProgress run={batchRun} />}
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
                {reviewCount > 0 && !isRunning && (
                  <button
                    type="button"
                    className="ctrl approve"
                    onClick={onApprove}
                    disabled={busy}
                    title={`${reviewCount} 章写完待批准 —— 批准达标的(未达门槛会提示复修);纯状态变更,不耗 token`}
                  >
                    批准达标 <span className="ctrl-badge">{reviewCount}</span>
                  </button>
                )}
                <Link href={immersiveHref} className="ctrl">全屏沉浸</Link>
                <Link href="/editor" className="ctrl">展开编辑器</Link>
              </div>
            </div>

            <div className="writer-body cj-pane-scroll" ref={streamRef}>
              {live.active && live.text ? (
                <>
                  {/* 流式按空行分段渲染(与定稿同构),已完成段 memo 冻结,每 tick 只重分词尾段 */}
                  <StreamingProse text={typed} dict={proseDict} caret={<span className="dash-caret" aria-hidden />} />
                  <StreamFollowChip show={!stick.following} onJump={stick.jumpToBottom} />
                </>
              ) : manuscript?.paragraphs?.length ? (
                <>
                  {manuscript.paragraphs.slice(0, PREVIEW_PARAGRAPHS).map((p, i) =>
                    p.quote ? (
                      <p key={i}><span className="accent">{renderProse(p.zh, proseDict, `q${i}-`, goEntity)}</span></p>
                    ) : (
                      <p key={i}>{renderProse(p.zh, proseDict, `p${i}-`, goEntity)}</p>
                    ),
                  )}
                  {/* 截断必须明示:眼睛读到这里时就地给出口,不让"100% 进度 + 戛然而止的正文"互相打架 */}
                  {manuscript.paragraphs.length > PREVIEW_PARAGRAPHS && (
                    <div className="writer-more">
                      <span className="wm-text">
                        …后面还有 {manuscript.paragraphs.length - PREVIEW_PARAGRAPHS} 段(全章 {fmt(chapterWords)} 字)
                      </span>
                      <Link href={`/editor?chapter=${curChapter}`} className="wm-link">展开编辑器读全文</Link>
                      <Link href={immersiveHref} className="wm-link">全屏沉浸</Link>
                    </div>
                  )}
                </>
              ) : (
                <p className="writer-empty">本章还是一张白纸。点「继续创作」就让写手接着上一章往下写。</p>
              )}
            </div>

            <div className="writer-foot">
              {/* 第 1 行:本章进度 + 字数 — 单纯信息展示,不抢焦 */}
              <div className="writer-foot-row writer-foot-progress">
                <span className="writer-foot-label">本章</span>
                <div className="pbar"><i style={{ width: `${chapterPct}%` }} /></div>
                <span className="num">{chapterPctEased}%</span>
                <span className="writer-foot-words">
                  <span className="delta">{fmt(liveWordsEased)}</span>
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
                <label className="writer-batch-field writer-unattended-field" title="无人值守:每章修不到门槛也先接受、继续往下写(标记待重修),全程不停。适合挂机连写几十章,配合连续性约束减少漂移。">
                  <input
                    type="checkbox"
                    className="wf-unattended-check"
                    checked={unattended}
                    onChange={(e) => setUnattended(e.target.checked)}
                    disabled={busy || isRunning}
                    aria-label="无人值守续写(接受低分、不停)"
                  />
                  <span className="writer-batch-label">🤖 无人值守</span>
                </label>
                <span className={`writer-batch-state${isRunning ? " is-running" : run.lastError ? " is-error" : " is-idle"}`}>
                  <span className="dot" aria-hidden />
                  {isRunning ? "运行中" : run.lastError ? "上次中断" : "待命"}
                </span>
                <button
                  type="button"
                  className={`ctrl batch${busy || preparing ? " is-loading" : ""}`}
                  onClick={() => openWorkflowConfirm("batch")}
                  disabled={busy || preparing || !bookId || isRunning}
                  title={unattended ? "无人值守连写 N 章:低分也不停、事后批量重修  (⌘/Ctrl + Shift + Enter)" : "连续写 N 章,达不到质量门槛即停  (⌘/Ctrl + Shift + Enter)"}
                >
                  {preparing ? "模型准备中…" : unattended ? "无人值守连写" : "开始连续写"}
                  {!preparing && <kbd className="kbd">⌘⇧↵</kbd>}
                </button>
              </div>
              <PlatformHint type="batch-limits" variant="quiet" />
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
