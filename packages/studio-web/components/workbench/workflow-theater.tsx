"use client"

import * as React from "react"
import { X, Maximize2, Minimize2, Square } from "lucide-react"
import { toast } from "sonner"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"
import { stopBookWorkflow, fetchAutoRuns } from "@/lib/api/client"
import { useAgentActivity } from "@/lib/use-agent-activity"
import { useLiveRun } from "@/lib/use-live-run"
import { useRunState } from "@/lib/use-run-state"
import { useTypewriter } from "@/lib/use-typewriter"
import { useAutoRuns } from "@/hooks/use-studio"
import { isLiveAutoRunStatus } from "@/lib/studio/run-status"
import { formatEta } from "./batch-progress"
import { useEntityDict } from "@/lib/prose-highlight"
import { agentColor } from "@/lib/agent-identity"
import { AgentPixel } from "@/components/design/agent-pixel"
import { PixelCat } from "@/components/design/pixel-cat"
import { CelebrationBurst } from "./celebration-burst"
import { StreamingProse, createIncrementalSplitState, splitStreamParagraphsIncremental, type IncrementalSplitState } from "./streaming-prose"
import { StreamFollowChip } from "./stream-follow-chip"
import { useStickToBottom } from "@/hooks/use-stick-to-bottom"
import { renderAgentOutputInline, sanitizeAgentOutput } from "@/lib/sanitize-agent-output"
import "./workflow-theater.css"

/**
 * WorkflowTheater — 续写时的全屏剧场态。
 *
 * 三栏布局:
 *   左 = 17 角色 swim lane(按部门),实时点亮谁在干
 *   中 = 写手当前章节正文,大字号 typewriter + 闪烁光标
 *   右 = 最近事件流(每个 agent 上一句话做了什么)
 *
 * 进入条件:isRunning(run.isRunning || live.active)
 * 用户可以折叠成右下角的迷你脉冲 pip,继续看自己的工作台;再点恢复全屏
 */

const AGENT_DEPTS: ReadonlyArray<{ id: string; label: string; agents: ReadonlyArray<string> }> = [
  { id: "strategy", label: "战略选题", agents: ["market-radar", "architect", "setup-auditor"] },
  { id: "writing",  label: "写作",     agents: ["planner", "writer", "chapter-analyst"] },
  { id: "review",   label: "评审",     agents: ["editor", "reader-critic", "quality-report"] },
  { id: "revision", label: "修改打磨", agents: ["reviser", "word-steward", "polisher"] },
  { id: "ops",      label: "运营质保", agents: ["state-verifier", "style-fingerprint", "prompt-steward"] },
  { id: "eic",      label: "总编室",   agents: ["managing-editor", "editor-in-chief"] },
]

const AGENT_NAMES: Record<string, string> = {
  "market-radar": "市场雷达", "architect": "架构师", "setup-auditor": "建书复审官",
  "planner": "规划师", "writer": "写手", "chapter-analyst": "章节分析官",
  "editor": "审稿官", "reader-critic": "读者评审官", "quality-report": "质量报告官",
  "reviser": "修稿师", "word-steward": "字数治理官", "polisher": "润色师",
  "state-verifier": "状态校验员", "style-fingerprint": "风格指纹官", "prompt-steward": "提示词治理官",
  "managing-editor": "执行主编", "editor-in-chief": "总编",
}
const nameOf = (fid: string) => AGENT_NAMES[fid] ?? fid

/**
 * 标准撰写管线 — 7 个有顺序的阶段。每阶段由 N 个 agent 组成,
 * 这一阶段的状态 = 内含任一 agent 的 running 优先,否则 done > idle。
 * 顺序对应 docs/HARDWRITE_PRODUCT_CURRENT_STATE.md 的运行时流水线。
 */
const PIPELINE_STEPS: ReadonlyArray<{
  id: string
  label: string
  hint: string
  agents: ReadonlyArray<string>
}> = [
  { id: "plan",     label: "规划",  hint: "读设定 / 记忆 → 章节意图 + 上下文包",        agents: ["planner"] },
  { id: "write",    label: "撰写",  hint: "写手按意图逐字生成草稿",                       agents: ["writer"] },
  { id: "audit",    label: "审稿",  hint: "审稿官 + 读者评审官检查逻辑 / 连续性 / 张力",  agents: ["editor", "reader-critic"] },
  { id: "revise",   label: "修订",  hint: "修稿师按审计 issue 改稿 + 字数治理调长度",     agents: ["reviser", "word-steward"] },
  { id: "polish",   label: "润色",  hint: "润色师做文字层精修",                            agents: ["polisher"] },
  { id: "verify",   label: "复核",  hint: "状态校验 + 风格指纹 + 综合评分",               agents: ["chapter-analyst", "state-verifier", "style-fingerprint", "quality-report"] },
  { id: "release",  label: "签发",  hint: "执行主编 → 总编最终裁决",                       agents: ["managing-editor", "editor-in-chief"] },
]

// 接力顺序:把 7 步里的 agent 按管线先后摊平去重 → 一条有序的"交棒名单"(规划师→写手→审稿官→…→总编)。
// 右栏接力链就按这个顺序竖向铺开,棒子(当前)从上往下走。
const RELAY_ORDER: string[] = (() => {
  const seen = new Set<string>()
  const order: string[] = []
  for (const s of PIPELINE_STEPS) for (const a of s.agents) if (!seen.has(a)) { seen.add(a); order.push(a) }
  return order
})()

type StepStatus = "done" | "running" | "pending"

function computeStepStatus(
  step: typeof PIPELINE_STEPS[number],
  statusByAgent: Record<string, "running" | "done" | "idle">,
  seenOrder: string[],
): StepStatus {
  // running 优先
  if (step.agents.some((a) => statusByAgent[a] === "running")) return "running"
  // 任一已 done(出现过)→ 这一步已完成
  if (step.agents.some((a) => statusByAgent[a] === "done" || seenOrder.includes(a))) return "done"
  return "pending"
}

/* 自动分段(splitStreamParagraphs)与流式渲染(StreamingProse)已抽到 ./streaming-prose,
   工作台 / 编辑器 / 剧场三处流式画布共用一套;
   正文「语义分色」分词器在 lib/prose-highlight(人物/地点字典 + 时间)。 */

type Mode = "full" | "mini" | "closed"

export function WorkflowTheater({ bookId, bookTitle }: { bookId: string | undefined; bookTitle: string }) {
  const run = useRunState(bookId)
  const live = useLiveRun(bookId)
  const activity = useAgentActivity(bookId)
  const proseDict = useEntityDict(bookId) // 人物/地点字典(story-graph),供正文语义分色
  // 连续写批次(auto-runs,与 /runs 共享 SWR key):剧场头部给「本批第几章/共几章 + 预计剩余」,
  // 挂机长任务不必离开剧场就知道还剩多少、卡没卡;单章续写查不到活跃批次时不渲染,零噪音。
  const { data: autoRuns } = useAutoRuns()
  const batchRun = React.useMemo(
    () => (autoRuns ?? []).find((r) => r.bookId === bookId && isLiveAutoRunStatus(r.status)),
    [autoRuns, bookId],
  )

  // 写手 done 后,后续 agent(章节分析官/审稿等)不发 token,live.text 会清空 →
  // 用户最小化再展开后看到空白页。这里缓存"本轮见过的最长文本",作为后备显示。
  // 切书 / mode 关闭 / 重新启动新一轮(seenOrder 重置)时清掉。
  const cachedTextRef = React.useRef<string>("")
  const cachedRunSigRef = React.useRef<string>("")
  React.useEffect(() => {
    // 切书或 closed → 清缓存
    cachedTextRef.current = ""
    cachedRunSigRef.current = ""
  }, [bookId])
  React.useEffect(() => {
    if (live.text && live.text.length > cachedTextRef.current.length) {
      cachedTextRef.current = live.text
      cachedRunSigRef.current = String(live.chapter ?? "")
    }
    // 章节切换 → 重置缓存(新章节自己的文本)
    if (live.chapter !== undefined && String(live.chapter) !== cachedRunSigRef.current && live.text) {
      cachedTextRef.current = live.text
      cachedRunSigRef.current = String(live.chapter)
    }
  }, [live.text, live.chapter])
  const effectiveText = live.text || cachedTextRef.current
  const typed = useTypewriter(effectiveText, live.active)
  const isRunning = run.isRunning || live.active

  const [mode, setMode] = React.useState<Mode>("closed")

  // 停止写作 —— 剧场里就能停,不用先关剧场再去工作台找按钮。
  // 二段确认(首点变"确认停止?",3s 内再点才真停),避免误触中断长任务;已落库章节后端会保留。
  const [stopConfirm, setStopConfirm] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  const stopConfirmTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => { if (stopConfirmTimer.current) clearTimeout(stopConfirmTimer.current) }, [])
  const handleStop = React.useCallback(async () => {
    if (!bookId) return
    if (!stopConfirm) {
      setStopConfirm(true)
      toast.info("再点一次「确认停止」", { description: "防误触:3 秒内再点一下,才会真正停止本轮写作。" })
      if (stopConfirmTimer.current) clearTimeout(stopConfirmTimer.current)
      stopConfirmTimer.current = setTimeout(() => setStopConfirm(false), 3000)
      return
    }
    if (stopConfirmTimer.current) clearTimeout(stopConfirmTimer.current)
    setStopConfirm(false)
    setStopping(true)
    try {
      await stopBookWorkflow(bookId, "用户在剧场停止写作")
      // 关键:停止后立即刷新运行态,别让剧场停了还显示"写作中"(用户以为没停)。
      run.refresh()
      // 兜底校验:并发场景下 workspace 选中的 book 可能与真正在跑的 run 不是同一本,
      // 查一遍 auto-runs,对任何仍在跑、但 book 不同的 run 再停一次,确保真停到后端。
      try {
        const runs = await fetchAutoRuns()
        const stillActive = (runs || []).filter((r) => /running|streaming|batch|queued/i.test(String(r.status)))
        for (const r of stillActive) {
          if (r.bookId && r.bookId !== bookId) {
            await stopBookWorkflow(r.bookId, "兜底停止:剧场停止时仍有其它在跑任务")
          }
        }
      } catch {
        /* 兜底校验失败不影响主流程 */
      }
      run.refresh()
      toast.success("已停止写作", { description: "已落库的章节都保留在本地。" })
    } catch (e) {
      toast.error(`停止失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setStopping(false)
    }
  }, [bookId, stopConfirm, run])

  // 自动开/收逻辑 — 修了两个 bug:
  //   旧版 bug A:user 按 X → mode=closed,但 isRunning 还 true,effect 又把它拉回 full。死循环。
  //   旧版 bug B:阶段切换时 live.active 假性掉,run.isRunning 没补上 → 剧场闪退。
  //
  //   新版规则:
  //     - 只在 isRunning 上升沿(false → true)做 setMode("full") — 跑了一轮新的就展开
  //     - user 手动 X / 最小化期间,prevRunningRef 仍标记为 true,所以效果不会自动拉回
  //     - isRunning 持续 ≥ 10 秒为 false 才降级到 mini(忍受 stage 切换的瞬时 false)
  //     - 降到 mini 后不再自动 closed — 用户手动 X 才彻底关
  //     - 下一次 isRunning 重新从 false 升到 true,才再次自动展开(用户期望:新的一章再弹)
  const idleSinceRef = React.useRef<number | null>(null)
  const prevRunningRef = React.useRef(false)
  React.useEffect(() => {
    if (isRunning) {
      idleSinceRef.current = null
      // 关键:只在"上一次是 false → 这次是 true"的瞬间自动展开
      // 这样 user 按 X 后 isRunning 仍 true,prevRunning 也是 true → 不会被 effect 拉回
      if (!prevRunningRef.current) {
        setMode("full")
      }
      prevRunningRef.current = true
      return
    }
    prevRunningRef.current = false
    // 进入 idle 稳定窗口 — 10s 后还 idle 才降级
    if (idleSinceRef.current === null) idleSinceRef.current = Date.now()
    const startedAt = idleSinceRef.current
    const t = setTimeout(() => {
      if (idleSinceRef.current === startedAt && mode === "full") setMode("mini")
    }, 10_000)
    return () => clearTimeout(t)
  }, [isRunning, mode])

  // 进展庆祝:本轮写作刚跑完(isRunning 真→假)→ 剧场内也来一记温暖的像素庆祝
  const [celebrateSig, setCelebrateSig] = React.useState(0)
  const prevRunCelebrate = React.useRef(false)
  React.useEffect(() => {
    if (prevRunCelebrate.current && !isRunning) setCelebrateSig((s) => s + 1)
    prevRunCelebrate.current = isRunning
  }, [isRunning])

  // ESC 收成 mini
  React.useEffect(() => {
    if (mode !== "full") return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMode("mini") }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [mode])

  // 计时:第一次 isRunning=true 开始计时;只在 mode 变 closed 时重置,
  // 不再因为 isRunning 短暂掉 false 就清零(那会让计时器在阶段切换间频繁归零)
  const startedAt = React.useRef<number | null>(null)
  // 记住"当前在第几步 + 何时切到这步",用于在焦点条显示"本阶段已用时 Ns"(会跳的数字 = 最强的"没卡住"信号)。
  const stageTrackRef = React.useRef<{ idx: number; at: number }>({ idx: -1, at: 0 })
  const [elapsed, setElapsed] = React.useState<string>("00:00")
  React.useEffect(() => {
    if (isRunning && startedAt.current === null) startedAt.current = Date.now()
  }, [isRunning])
  React.useEffect(() => {
    if (mode === "closed") {
      startedAt.current = null
      cachedTextRef.current = ""
      cachedRunSigRef.current = ""
    }
  }, [mode])
  React.useEffect(() => {
    if (!isRunning) return
    const tick = () => {
      const s = startedAt.current ? Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)) : 0
      const m = Math.floor(s / 60), r = s % 60
      setElapsed(`${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [isRunning])

  // 贴底才跟随 typewriter:用户上翻回读即解除自动滚底,浮出「回到最新」;贴回底部恢复
  const paperRef = React.useRef<HTMLDivElement>(null)
  const stick = useStickToBottom(paperRef, typed, live.active)

  // 滚动事件流到顶(最新在上)
  const feedRef = React.useRef<HTMLDivElement>(null)
  // 接力链:棒子(当前角色)一换,自动把当前节点滚进视区 —— "刷刷刷往下走"的体感
  const activeNodeRef = React.useRef<HTMLLIElement>(null)
  React.useEffect(() => {
    activeNodeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [activity.currentAgentId])

  if (mode === "closed") return null

  if (mode === "mini") {
    return (
      <button
        type="button"
        className={`theater-mini${isRunning ? " running" : " done"}`}
        onClick={() => setMode("full")}
        title="展开 AI 写作剧场"
      >
        <span className="theater-mini-dot" />
        <span className="theater-mini-text">
          {isRunning
            ? `${activity.currentAgentId ? nameOf(toFrontendAgentId(activity.currentAgentId)) : "AI"} · ${live.charCount.toLocaleString()} 字`
            : "刚跑完 · 点开看复盘"}
        </span>
        <Maximize2 size={13} />
      </button>
    )
  }

  // full mode
  const currentFid = activity.currentAgentId ? toFrontendAgentId(activity.currentAgentId) : (live.active ? "writer" : undefined)
  const wordsPerMin = startedAt.current ? Math.round((live.charCount * 60) / Math.max(1, (Date.now() - startedAt.current) / 1000)) : 0

  // 按管线顺序算每一步状态 + 找到"当前步"与"下一步"
  const stepStatuses = PIPELINE_STEPS.map((s) => ({
    step: s,
    status: computeStepStatus(s, activity.statusByAgent, activity.seenOrder),
  }))
  const currentStepIdx = stepStatuses.findIndex((s) => s.status === "running")
  const nextStepIdx = currentStepIdx >= 0
    ? stepStatuses.findIndex((s, i) => i > currentStepIdx && s.status === "pending")
    : stepStatuses.findIndex((s) => s.status === "pending")
  const currentStep = currentStepIdx >= 0 ? stepStatuses[currentStepIdx] : undefined
  const nextStep = nextStepIdx >= 0 ? stepStatuses[nextStepIdx] : undefined
  const doneCount = stepStatuses.filter((s) => s.status === "done").length
  // 本阶段已用时(秒):阶段一变就把"起算时刻"重置。组件每秒重渲(elapsed tick)→ 这个数字会持续跳动,
  // 让审稿/复核这种"无正文流"的阶段也明确"在动",而不是被误判成卡死。
  if (currentStepIdx !== stageTrackRef.current.idx) {
    stageTrackRef.current = { idx: currentStepIdx, at: Date.now() }
  }
  const stageSeconds = currentStepIdx >= 0
    ? Math.max(0, Math.floor((Date.now() - stageTrackRef.current.at) / 1000))
    : 0

  // 拆段;只把"已稳定"的段交给 typewriter 不太现实(typewriter 拿到的是累计 full text)
  // 直接用累计 text 拆 → 渲染多个 <p>。最后一段会有 caret。
  // 增量分段:剧场每秒计时重渲 + 每 token 重渲,全量分段在长文本下掉帧;增量版每渲 O(增量)。
  const splitRef = React.useRef<IncrementalSplitState | null>(null)
  if (!splitRef.current) splitRef.current = createIncrementalSplitState()
  const paragraphs = splitStreamParagraphsIncremental(typed, splitRef.current)

  // 接力链:每个角色取它最近一条事件文案,挂到对应节点上(让真实事件流在结构化接力里就地呈现)
  const lastTextByFid: Record<string, string> = {}
  for (const ev of activity.events) lastTextByFid[toFrontendAgentId(ev.agentId)] = sanitizeAgentOutput(ev.text)
  const currentAgentText = sanitizeAgentOutput(activity.currentText)

  // "在跑但没可见输出"期:剧场在跑,但还没有正文逐字流出 —— 可能是模型冷启动(还没人出场),
  // 也可能是某个角色(如写手)在闷头调模型生成(字数还是 0)。这两种页面都"看着像冻住",
  // 都换成带真实计时器 + 脉冲动画的动态块,并尽量说清"谁正在干什么"。
  const noVisibleOutput = isRunning && paragraphs.length === 0 && !live.active
  const workTitle = currentFid ? `${nameOf(currentFid)}正在${currentStep?.step.label ?? "工作"}…` : "正在唤醒编辑部…"
  const workSub = currentFid
    ? (currentAgentText || "正在调用模型逐字生成,第一段马上冒出来。别关,它在干活。")
    : "后台正在启动 —— 模型冷启动可能要几十秒,规划师马上接第一棒。"

  return (
    <div className="theater-backdrop" role="dialog" aria-modal="true" aria-label="AI 写作剧场">
      <CelebrationBurst signal={celebrateSig} />
      <div className="theater-shell">
        {/* ─── 顶部条:书名 / 状态 / 计时 / 折叠/关闭 ──────────── */}
        <header className="theater-head">
          <div className="theater-head-left">
            <span className="theater-live-dot" aria-hidden />
            <span className="theater-status">
              {live.reconnecting ? "连接中断 · 重连中…" : isRunning ? "正在写作中" : "刚跑完"}
            </span>
            <span className="theater-sep">·</span>
            <span className="theater-book">《{bookTitle}》</span>
            {currentFid && (
              <>
                <span className="theater-sep">·</span>
                <span className="theater-agent" style={{ ["--c" as string]: agentColor(currentFid) }}>
                  <span className="theater-agent-dot" />
                  {nameOf(currentFid)}
                </span>
              </>
            )}
            {run.currentStage && (
              <>
                <span className="theater-sep">·</span>
                <span className="theater-stage">{run.currentStage}</span>
              </>
            )}
          </div>
          <div className="theater-head-right">
            {/* 批次进度:本批 X/N 章 + 预计剩余(数据与运行台 RunCard 同源,每秒重渲让 ETA 活着) */}
            {batchRun && (
              <div
                className="theater-stat theater-stat-batch"
                title={`本批连写 第 ${batchRun.fromChapter}–${batchRun.toChapter} 章 · 还剩 ${Math.max(0, batchRun.toChapter - batchRun.currentChapter)} 章${batchRun.currentRewrite > 0 ? ` · 重写 ${batchRun.currentRewrite}/${batchRun.maxRewritesPerChapter}` : ""}`}
              >
                <span className="theater-stat-k">本批</span>
                <span className="theater-stat-v">{batchRun.currentChapter}/{batchRun.toChapter}<small>章</small></span>
              </div>
            )}
            {batchRun?.eta && isRunning ? (
              <div className="theater-stat">
                <span className="theater-stat-k">预计剩余</span>
                <span className="theater-stat-v">{formatEta(Math.max(0, batchRun.eta - Date.now()))}</span>
              </div>
            ) : null}
            <div className="theater-stat">
              <span className="theater-stat-k">耗时</span>
              <span className="theater-stat-v">{elapsed}</span>
            </div>
            <div className="theater-stat">
              <span className="theater-stat-k">字数</span>
              <span className="theater-stat-v">{live.charCount.toLocaleString()}</span>
            </div>
            <div className="theater-stat">
              <span className="theater-stat-k">速度</span>
              <span className="theater-stat-v">{wordsPerMin}<small>字/分</small></span>
            </div>
            {isRunning && (
              <button
                type="button"
                className={`theater-stop-btn${stopConfirm ? " confirm" : ""}`}
                onClick={handleStop}
                disabled={stopping}
                title="停止本轮写作(已写章节会保留)"
              >
                <Square size={12} fill="currentColor" />
                {stopping ? "停止中…" : stopConfirm ? "确认停止?" : "停止写作"}
              </button>
            )}
            <button type="button" className="theater-icon-btn" onClick={() => setMode("mini")} title="收成 pip (Esc)">
              <Minimize2 size={15} />
            </button>
            <button type="button" className="theater-icon-btn" onClick={() => setMode("closed")} title="关闭剧场(写作继续在后台)">
              <X size={15} />
            </button>
          </div>
        </header>

        {/* ─── 流程步骤条:7 步标准管线,带序号 + 状态 + 当前进度 ──── */}
        <div className="theater-pipeline" role="progressbar" aria-valuemin={0} aria-valuemax={PIPELINE_STEPS.length} aria-valuenow={doneCount}>
          {stepStatuses.map(({ step, status }, i) => {
            const isCurrent = status === "running"
            const isDone = status === "done"
            return (
              <React.Fragment key={step.id}>
                <div
                  className={`pl-step pl-${status}${isCurrent ? " pl-current" : ""}`}
                  title={`${i + 1}. ${step.label} · ${status === "done" ? "已完成" : status === "running" ? "进行中" : "等候"} — ${step.hint}`}
                >
                  <span className="pl-num">{isDone ? "✓" : i + 1}</span>
                  <span className="pl-info">
                    <b>{step.label}</b>
                    {/* 仅 running / done / 下一步 显示状态字 —— 5 个"等候"反复刷屏是噪声 */}
                    {isCurrent && <em>进行中</em>}
                    {isDone && <em>已完成</em>}
                    {!isCurrent && !isDone && i === stepStatuses.findIndex((s) => s.status === "pending") && <em>下一步</em>}
                  </span>
                </div>
                {i < PIPELINE_STEPS.length - 1 && (
                  <span className={`pl-arrow${stepStatuses[i].status === "done" ? " pl-arrow-done" : ""}`} aria-hidden>→</span>
                )}
              </React.Fragment>
            )
          })}
        </div>

        {/* ─── 当前角色聚焦条 — 压成一行,挪到 pipeline 下面紧贴 ───── */}
        <div className="theater-focus">
          {currentStep ? (
            // key 跟随当前步:阶段一变就重挂载 → 触发一次 enter 动画(整条闪一下),让"切到下一步"被眼睛抓住。
            <div key={currentStepIdx} className="tf-strip" style={{ ["--c" as string]: currentFid ? agentColor(currentFid) : "var(--brand-500)" }}>
              {currentFid && <span className="tf-strip-avatar"><AgentPixel id={currentFid} size={28} ariaLabel={nameOf(currentFid)} /></span>}
              <span className="tf-strip-step">第 {currentStepIdx + 1}/{PIPELINE_STEPS.length} 步</span>
              <span className="tf-strip-name">{currentFid ? nameOf(currentFid) : currentStep.step.label}</span>
              <span className="tf-strip-doing">正在 <b>{currentStep.step.label}</b><span className="tf-dots" aria-hidden><i /><i /><i /></span></span>
              <span className="tf-strip-secs" title="本阶段已用时 · 数字在跳=正在运行,没有卡住">{stageSeconds}s</span>
              <span className="tf-strip-hint">{renderAgentOutputInline(currentAgentText || currentStep.step.hint, "theater-current-hint")}</span>
              {nextStep && (
                <span className="tf-strip-next">
                  <span aria-hidden>↪</span>下一步 <b>{nextStep.step.label}</b>
                </span>
              )}
            </div>
          ) : (
            <div className="tf-idle">
              {isRunning
                ? "正在准备启动,流水线即将进入第 1 步「规划」…"
                : doneCount === PIPELINE_STEPS.length
                  ? `🎉 全部 ${PIPELINE_STEPS.length} 步已跑完,本章签发就绪`
                  : "本轮写作已结束。可以看右侧事件复盘,或关闭剧场回工作台。"
              }
            </div>
          )}
        </div>

        {/* ─── 主体 3 栏 ───────────────────────────────────── */}
        <div className="theater-body">
          {/* 左:17 角色 swim lane */}
          <aside className="theater-lanes scroll-thin">
            <div className="theater-lanes-head">
              <span>编辑部 17 角色</span>
              <span className="muted">{activity.seenOrder.length} 已出场</span>
            </div>
            {AGENT_DEPTS.map((dept) => {
              const runningDept = dept.agents.some((fid) => activity.statusByAgent[fid] === "running")
              return (
                <div key={dept.id} className={`theater-dept${runningDept ? " has-running" : ""}`}>
                  <div className="theater-dept-label">{dept.label}</div>
                  {dept.agents.map((fid) => {
                    const status = activity.statusByAgent[fid] ?? "idle"
                    const isCurrent = currentFid === fid
                    return (
                      <div key={fid} className={`theater-lane ${status}${isCurrent ? " current" : ""}`}>
                        <AgentPixel id={fid} size={22} ariaLabel={nameOf(fid)} />
                        <span className="theater-lane-name">{nameOf(fid)}</span>
                        <span className={`theater-lane-state ${status}`}>
                          {status === "running" ? "在跑" : status === "done" ? "✓" : "—"}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </aside>

          {/* 中:写手的正文流 — 自动分段 + 首行缩进 2em(中文长篇排版) */}
          <main className="theater-paper-wrap">
            <div className="theater-paper-head">
              <span className="theater-paper-label">本章正文 · 实时生成</span>
              <span className="theater-paper-stage">
                {live.stageText
                  || (currentStep && live.active ? `写手 · ${live.charCount.toLocaleString()} 字` : "")
                  || (paragraphs.length ? `${paragraphs.length} 段 · ${live.charCount.toLocaleString()} 字` : "等待写手开口")}
              </span>
            </div>
            <div className="theater-paper scroll-thin" ref={paperRef}>
              {paragraphs.length > 0 ? (
                <>
                  {/* 已完成段 memo 冻结,每 tick 只重分词正在生长的尾段(长章不掉帧) */}
                  <StreamingProse
                    text={typed}
                    dict={proseDict}
                    paragraphClassName="theater-paragraph"
                    caret={live.active ? <span className="theater-caret" aria-hidden /> : null}
                  />
                  <StreamFollowChip show={live.active && !stick.following} onJump={stick.jumpToBottom} />
                </>
              ) : noVisibleOutput ? (
                <div className="theater-warmup">
                  <span className="theater-warmup-dots" aria-hidden><i /><i /><i /></span>
                  <p className="theater-warmup-title">{workTitle}</p>
                  <p className="theater-warmup-sub">{workSub}</p>
                  <p className="theater-warmup-time">已跑 <b className="theater-warmup-clock">{elapsed}</b></p>
                  <span className="theater-warmup-bar" aria-hidden />
                </div>
              ) : (
                <p className="theater-paper-empty">
                  {isRunning ? "马上就好…" : "本轮写作已结束。可以看右侧事件复盘,或关闭剧场回工作台。"}
                </p>
              )}
            </div>
          </main>

          {/* 右:接力链 — 整条交棒名单竖向铺开,棒子从上往下走(交棒✓ → 当前(跳动) → 待接棒) */}
          <aside className="theater-feed theater-relay scroll-thin" ref={feedRef}>
            <div className="theater-feed-head">
              <span>接力链</span>
              <span className="muted">{doneCount}/{PIPELINE_STEPS.length} 棒</span>
            </div>
            <ol className="relay-chain">
              {RELAY_ORDER.map((fid, i) => {
                const status = activity.statusByAgent[fid] ?? "idle"
                const isCurrent = currentFid === fid
                const seen = status === "done" || status === "running" || activity.seenOrder.includes(fid)
                const text = isCurrent
                  ? (currentAgentText || lastTextByFid[fid] || "正在接棒,马上开干…")
                  : (lastTextByFid[fid] || (seen ? "已交棒" : "等待接棒"))
                return (
                  <li
                    key={fid}
                    ref={isCurrent ? activeNodeRef : null}
                    className={`relay-node relay-${status}${isCurrent ? " current" : ""}`}
                    style={{ ["--c" as string]: agentColor(fid) }}
                  >
                    <span className="relay-rail" aria-hidden />
                    <span className="relay-dot" aria-hidden>{status === "done" ? "✓" : isCurrent ? "▶" : i + 1}</span>
                    <span className="relay-card">
                      <span className="relay-card-head">
                        <AgentPixel id={fid} size={20} ariaLabel={nameOf(fid)} />
                        <b className="relay-name">{nameOf(fid)}</b>
                        <span className="relay-state">{status === "running" ? "在跑" : status === "done" ? "交棒✓" : "待接"}</span>
                      </span>
                      <span className="relay-text">{renderAgentOutputInline(text, `relay-${fid}`)}</span>
                    </span>
                  </li>
                )
              })}
            </ol>
          </aside>
        </div>
        {/* 编辑部的猫 🐱 — 蜷在剧场左下角打盹,偶尔起来踱两步,陪着这场接力 */}
        <PixelCat className="theater-cat" />
      </div>
    </div>
  )
}
