"use client"

import * as React from "react"
import useSWR, { useSWRConfig } from "swr"
import { toast } from "sonner"
import {
  ArrowDownWideNarrow,
  BadgeCheck,
  BookOpenText,
  Check,
  CircleDashed,
  ClipboardCheck,
  Copy,
  FileCheck2,
  FilePen,
  FileText,
  Gauge,
  Gavel,
  GitCompareArrows,
  Lightbulb,
  ListTree,
  Loader2,
  Maximize2,
  PanelRight,
  PenLine,
  Radio,
  Scissors,
  Send,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Stars,
  TriangleAlert,
  Wand2,
  Workflow,
  X,
} from "lucide-react"
import Link from "next/link"
import {
  approveChapter,
  applyChapterSuggestion,
  fetchChapters,
  fetchManuscript,
  fetchQuality,
  fetchEditorialReview,
  fetchChapterHandoff,
  fetchChapterRevisions,
  generateEditorialReview,
  saveManuscript,
  startRepairQualityBatch,
  triggerContinue,
  triggerReview,
  triggerRewrite,
  type EditorialReview,
  type ChapterHandoff,
} from "@/lib/api/client"
import type { ChapterRevisionsResult } from "@/lib/api/types"
import { diffLines, diffStats } from "@/lib/simple-diff"
import { useWorkspace } from "@/lib/workspace-context"
import { EmptyArt } from "@/components/design/cj-placeholder"
import { AgentPixel } from "@/components/design/agent-pixel"
import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import { agentDisplayName, severityLabel, verdictLabel } from "@/lib/labels"
import { agentColor } from "@/lib/agent-identity"
import { useLiveRun } from "@/lib/use-live-run"
import { useRunState } from "@/lib/use-run-state"
import { useAgentActivity } from "@/lib/use-agent-activity"
import { useTypewriter } from "@/lib/use-typewriter"
import { useEntityDict } from "@/lib/prose-highlight"
import { StreamingProse } from "@/components/workbench/streaming-prose"
import { StreamFollowChip } from "@/components/workbench/stream-follow-chip"
import { useStickToBottom } from "@/hooks/use-stick-to-bottom"
import { showWriteBlockToast } from "@/lib/write-block-toast"
import { useRecoveryActions } from "@/lib/use-recovery-actions"
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
import "./editor.css"

const soft = { shouldRetryOnError: false }
const CH_STATE: Record<string, string> = { published: "已发布", done: "完成", review: "审校", writing: "写作中", queued: "排队", draft: "草稿", "audit-failed": "待修硬伤" }
// approve 不是 AI 动作(纯状态变更、不耗 token),但低分强制签发要借同一个确认弹窗把语义说清
type EditorAiAction = "continue" | "repair" | "polish" | "expand" | "review" | "eic-review" | "approve" | "suggestion"

// 章节状态 → 设计系统状态 pill 的 data-state(语义色只走状态)+ 一个贴切的 lucide 图标。
// 不新增配色:直接复用 .pill[data-state] 的 10 态;图标只为「一眼可辨」。
const CH_META: Record<string, { state: string; Icon: typeof FileText }> = {
  published: { state: "published", Icon: BadgeCheck },
  done: { state: "success", Icon: FileCheck2 },
  review: { state: "warn", Icon: ClipboardCheck },
  writing: { state: "running", Icon: PenLine },
  queued: { state: "queued", Icon: CircleDashed },
  draft: { state: "draft", Icon: FilePen },
  // 待修硬伤(audit-failed):复修预算耗尽仍带硬违规落盘 —— warn 暖橙,不做红色警报
  "audit-failed": { state: "warn", Icon: TriangleAlert },
}
function chapterMeta(status: string) {
  return CH_META[status] ?? { state: "draft", Icon: FileText }
}

function initialChapterFromLocation() {
  if (typeof window === "undefined") return null
  const n = Number(new URLSearchParams(window.location.search).get("chapter"))
  return Number.isInteger(n) && n > 0 ? n : null
}

export default function EditorPage() {
  const { books, bookId, booksLoading } = useWorkspace()
  // 统一恢复动作:撞墙时(没配模型/地基没过/分数卡门)给同一套按钮+落点,补上编辑器历史漏接的「一键放行」。
  const recovery = useRecoveryActions(bookId)
  const active = books.find((b) => b.id === bookId)
  const activeTitle = typeof active?.title === "string" ? active.title : active?.title?.zh
  // 章节列表会随后端改写/回滚变化:定时+聚焦自动重拉,避免显示已被删除的"幽灵章"
  const { data: chapters } = useSWR(bookId ? ["chapters", bookId] : null, () => fetchChapters(bookId), { ...soft, refreshInterval: 6000 })

  const [selNum, setSelNum] = React.useState<number | null>(() => initialChapterFromLocation())
  // 把选中章夹取到真实存在的章节:选过的章被回滚删掉后,不再拿它去取(否则会显示错章正文)
  const selValid = selNum != null && (chapters ?? []).some((c) => c.num === selNum) ? selNum : null
  const cur = selValid ?? active?.currentChapter ?? (chapters?.[0]?.num ?? null)
  const immersiveHref = cur ? `/immersive?chapter=${cur}` : "/immersive"

  const { data: manuscript } = useSWR(bookId && cur ? ["ms", bookId, cur] : null, () => fetchManuscript(bookId, cur as number), soft)
  const { data: quality } = useSWR(bookId && cur ? ["quality", bookId, cur] : null, () => fetchQuality(bookId, cur as number), soft)
  const { data: handoff } = useSWR<ChapterHandoff>(bookId && cur ? ["handoff", bookId, cur] : null, () => fetchChapterHandoff(bookId, cur as number), soft)

  const [text, setText] = React.useState("")
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [review, setReview] = React.useState<EditorialReview | null>(null)
  const [reviewBusy, setReviewBusy] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<EditorAiAction | null>(null)
  const [suggestionInstruction, setSuggestionInstruction] = React.useState("")
  // 画布视图:正文 ⇄ 编辑部评审(每个 agent 的意见/建议 + 修改 diff)
  const [view, setView] = React.useState<"text" | "review">("text")
  // 评审视图才拉修订快照(写手原稿→定稿 + 每轮修复 before/after)
  const { data: revisions } = useSWR<ChapterRevisionsResult>(
    view === "review" && bookId && cur ? ["revisions", bookId, cur] : null,
    () => fetchChapterRevisions(bookId, cur as number),
    soft,
  )
  const loadedKey = React.useRef<string>("")
  const bodyRef = React.useRef<HTMLDivElement>(null)

  // 实时流式:订阅本作品 agent 事件,把写手/改写的正文实时打字出来
  const { mutate } = useSWRConfig()
  const live = useLiveRun(bookId)
  // 优雅逐字:无论上游块大块小,前端都一个字一个字吐
  const typed = useTypewriter(live.text, live.active)
  // 人物/地点字典(story-graph),流式正文语义分色 —— 与工作台/剧场同一套
  const proseDict = useEntityDict(bookId)
  // 真实写作状态:正在跑时禁用 AI 操作,避免并发触发 → 后端 409 报错
  const run = useRunState(bookId)
  // 实时编辑部流水线:当前 agent + 最近步骤(规划/草稿/审校/裁决…)
  const activity = useAgentActivity(bookId)
  const aiBusy = busy || run.isRunning || live.active
  const streamRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const n = initialChapterFromLocation()
    if (n) setSelNum(n)
  }, [])

  // 用户手动点过章节就接管 — 自动跟随就此停手
  const userPickedRef = React.useRef(false)
  const pickChapter = (n: number) => {
    if (n === cur) return
    if (dirty && typeof window !== "undefined" && !window.confirm("当前章有未保存的修改,切换章节会丢弃。确定切换?")) return
    userPickedRef.current = true
    setSelNum(n)
  }

  // 用户已发布勾(localStorage 持久化,与后端 status 解耦,纯个人发布追踪)
  const PUBLISHED_KEY = bookId ? `ed-published:${bookId}` : null
  const [published, setPublished] = React.useState<Set<number>>(new Set())
  React.useEffect(() => {
    if (!PUBLISHED_KEY) return
    try {
      const raw = localStorage.getItem(PUBLISHED_KEY)
      if (raw) setPublished(new Set(JSON.parse(raw) as number[]))
      else setPublished(new Set())
    } catch { /* ignore */ }
  }, [PUBLISHED_KEY])
  const togglePublished = (n: number) => {
    setPublished((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      if (PUBLISHED_KEY) {
        try { localStorage.setItem(PUBLISHED_KEY, JSON.stringify([...next])) } catch { /* ignore */ }
      }
      return next
    })
  }

  // 自动跟随:正在生成的章节(如续写会写下一章)若不是当前章,自动切过去看它打字
  // 但用户手动选了别的章就尊重用户(不再跳回正在写的章)
  React.useEffect(() => {
    if (userPickedRef.current) return
    if (live.active && live.chapter && live.chapter !== cur) setSelNum(live.chapter)
  }, [live.active, live.chapter, cur])

  // 流式文本增长时贴底跟随:用户上翻回读即解除,浮出「回到最新」;贴回底部恢复。
  // 只在「正文流式分支真的渲染着」时生效 —— 评审视图复用同一个 .paper 容器,不能被钉底劫持。
  const streamPinActive = live.active && view !== "review"
  const stick = useStickToBottom(streamRef, typed, streamPinActive)

  // 一轮生成结束(active true→false):拉回已保存的正文与质量/工作流
  React.useEffect(() => {
    if (live.completedTick === 0 || !bookId || !cur) return
    // 只在"刚完成的就是当前章、且无未保存改动"时才允许覆盖编辑框;否则保留草稿(防后台 run 冲掉正在改的稿)
    if (live.chapter === cur && !dirty) loadedKey.current = ""
    mutate(["ms", bookId, cur])
    mutate(["chapters", bookId])
    mutate(["quality", bookId, cur])
    mutate(["handoff", bookId, cur])
    fetchEditorialReview(bookId, cur).then((d) => setReview(d.review)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.completedTick])

  // 切章时拉总编裁决缓存(GET 不触发 LLM)
  React.useEffect(() => {
    setReview(null)
    if (!bookId || !cur) return
    let alive = true
    fetchEditorialReview(bookId, cur).then((d) => { if (alive) setReview(d.review) }).catch(() => {})
    return () => { alive = false }
  }, [bookId, cur])

  const runEditorialReview = async () => {
    if (!bookId || !cur) return
    setReviewBusy(true)
    try {
      const d = await generateEditorialReview(bookId, cur)
      setReview(d.review)
      toast.success(`总编已${d.review.verdict === "pass" ? "签发本章" : "判定返工"}`)
    } catch (e) {
      toast.error(`总编复审失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReviewBusy(false)
    }
  }

  React.useEffect(() => {
    const key = `${bookId}#${cur}`
    if (manuscript && loadedKey.current !== key) {
      setText((manuscript.paragraphs ?? []).map((p) => p.zh).join("\n\n"))
      setDirty(false)
      loadedKey.current = key
    }
  }, [manuscript, bookId, cur])

  // 未保存改动:关窗/刷新前拦一道(写作类客户端必须的防丢失)
  React.useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = "" }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [dirty])

  const selChapter = chapters?.find((c) => c.num === cur)
  const wordCount = text.replace(/\s/g, "").length
  const lastChapterNum = chapters && chapters.length ? Math.max(...chapters.map((c) => c.num)) : (cur ?? 0)

  // 左栏目录密度:已写章 / 已发布 / 累计字数,从已取数据派生(不新增请求,不编数字)
  const chapterStats = React.useMemo(() => {
    const list = chapters ?? []
    let written = 0
    let words = 0
    for (const c of list) {
      if (c.words && c.words > 0) written += 1
      words += c.words ?? 0
    }
    return { total: list.length, written, words, pub: published.size }
  }, [chapters, published])

  // 右侧三 tab:工作(AI 动作 + 本章信息) / 质量(分数 + handoff)/ 审议(总编)
  type RightTab = "work" | "quality" | "review"
  const [rightTab, setRightTab] = React.useState<RightTab>("work")

  // 窄屏(<1080px)退路:三栏挤不下时,把左侧章节目录 / 右侧 AI 面板收进可开合抽屉,
  // 否则它们整块 display:none 就丢了核心功能。宽屏永不触发(抽屉态被 CSS 忽略)。
  const [drawer, setDrawer] = React.useState<"chapters" | "panel" | null>(null)
  // 切走章节 / 按 Esc 自动收起抽屉,避免选完章还挡着正文
  React.useEffect(() => { setDrawer(null) }, [cur])
  React.useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(null) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [drawer])

  const onSave = async () => {
    if (!bookId || !cur) return
    setSaving(true)
    try {
      await saveManuscript(bookId, cur, { content: text, locale: "zh" })
      setDirty(false)
      loadedKey.current = `${bookId}#${cur}` // 标记已加载,防 SWR 刷新把刚存的正文又覆盖回去
      toast.success(`第 ${cur} 章已保存`)
    } catch (e) {
      toast.error(`保存失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const onCopy = async () => {
    const body = (text || "").trim()
    if (!body) { toast.info("本章暂无正文可复制"); return }
    const heading = selChapter?.title.zh ? `第 ${cur} 章 ${selChapter.title.zh}\n\n` : ""
    try {
      await navigator.clipboard.writeText(heading + body)
      toast.success(`已复制第 ${cur} 章 · ${wordCount.toLocaleString()} 字`)
    } catch {
      toast.error("复制失败,请手动选择正文复制")
    }
  }

  const openAiConfirm = (kind: EditorAiAction) => {
    if (!bookId || !cur) return
    if (run.isRunning || live.active) {
      toast.info("正在写作中", {
        description: `${run.currentStage || (live.active ? "正文流式生成中" : "当前章节生成中")} —— 等它写完,或在工作台停止后再操作。`,
      })
      return
    }
    if ((kind === "eic-review" && reviewBusy) || (kind !== "eic-review" && busy)) return
    setConfirmAction(kind)
  }

  const confirmAiAction = async () => {
    const action = confirmAction
    if (!action) return
    setConfirmAction(null)
    if (action === "repair") {
      await repairChapter()
    } else if (action === "eic-review") {
      await runEditorialReview()
    } else if (action === "approve") {
      await doApprove()
    } else if (action === "suggestion") {
      await applySuggestionToChapter()
    } else {
      await aiAction(action)
    }
  }

  const openSuggestionConfirm = (instruction: string) => {
    if (!bookId || !cur) return
    if (!instruction.trim()) return
    if (run.isRunning || live.active) {
      toast.info("正在写作中", { description: "等当前生成结束,或在工作台停止后再按建议修复。" })
      return
    }
    setSuggestionInstruction(instruction.trim())
    setConfirmAction("suggestion")
  }

  const applySuggestionToChapter = async () => {
    if (!bookId || !cur || !suggestionInstruction.trim()) return
    setBusy(true)
    toast.info("正在按建议修复本章…")
    try {
      await applyChapterSuggestion(bookId, cur, suggestionInstruction)
      loadedKey.current = ""
      setDirty(false)
      await Promise.all([
        mutate(["ms", bookId, cur]),
        mutate(["manuscript", bookId, cur]),
        mutate(["quality", bookId, cur]),
        mutate(["handoff", bookId, cur]),
        mutate(["revisions", bookId, cur]),
        mutate(["chapters", bookId]),
      ])
      fetchEditorialReview(bookId, cur).then((d) => setReview(d.review)).catch(() => {})
      toast.success("已按建议修复本章", { description: "正文、质量和审议信息已重新刷新。" })
    } catch (e) {
      toast.error(`按建议修复失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      setSuggestionInstruction("")
    }
  }

  // 批准本章 = 强制签发(无视分数的纯状态变更,不耗 token):读完觉得行,就地放行,不必绕回工作台。
  // 达标章(≥85)直接签;低分章先弹确认 —— 强制签发会稀释质量门禁,语义必须说清再放行。
  const [approving, setApproving] = React.useState(false)
  const doApprove = async () => {
    if (!bookId || !cur) return
    setApproving(true)
    try {
      await approveChapter(bookId, cur)
      mutate(["chapters", bookId])
      toast.success(`第 ${cur} 章已签发`, { description: "已标记为通过 —— 续写会把它当定稿继续往下写。" })
    } catch (e) {
      toast.error(`签发失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApproving(false)
    }
  }
  const onApproveClick = () => {
    if (!bookId || !cur || approving) return
    // 没有质量报告 = 分数未知,与低分同样要先确认,不能静默强签
    if (!quality || Math.round(quality.overall) < 85) setConfirmAction("approve")
    else void doApprove()
  }

  const aiAction = async (kind: "continue" | "review" | "polish" | "expand") => {
    if (!bookId || !cur) return
    if (run.isRunning || live.active) {
      toast.info("正在写作中", {
        description: `${run.currentStage || (live.active ? "正文流式生成中" : "当前章节生成中")} —— 等它写完,或在工作台停止后再操作。`,
      })
      return
    }
    setBusy(true)
    try {
      if (kind === "continue") { await triggerContinue(bookId, cur); toast.success("已触发续写,生成中…") }
      else if (kind === "review") { await triggerReview(bookId, cur); toast.success("已触发审稿") }
      else { await triggerRewrite(bookId, cur, { style: kind === "polish" ? "润色" : "扩写" }); toast.success(kind === "polish" ? "已触发润色" : "已触发扩写") }
      run.refresh()
    } catch (e) {
      if (!showWriteBlockToast(e, recovery)) toast.error(`操作失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // 原地修复本章到达标:只动这一章,不回滚后续章节(解决"早章没达标→改写又毁掉后面"的死结)
  const repairChapter = async () => {
    if (!bookId || !cur) return
    if (run.isRunning || live.active) {
      toast.info("正在写作中", { description: "等当前生成结束,或在工作台停止后再修复。" })
      return
    }
    setBusy(true)
    try {
      await startRepairQualityBatch(bookId, { fromChapter: cur, toChapter: cur, targetScore: 90 })
      toast.success(`已开始原地修复第 ${cur} 章到 90 分`, { description: "只修这一章,不影响后面的章节。修完会自动刷新。" })
      run.refresh()
    } catch (e) {
      if (!showWriteBlockToast(e, recovery)) toast.error(`修复失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const startDrag = (side: "l" | "r") => (e: React.PointerEvent) => {
    e.preventDefault()
    const body = bodyRef.current
    if (!body) return
    const startX = e.clientX
    const prop = side === "l" ? "--el" : "--er"
    const base = parseInt(getComputedStyle(body).getPropertyValue(prop)) || (side === "l" ? 256 : 320)
    ;(e.currentTarget as HTMLElement).classList.add("dragging")
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      let v = side === "l" ? base + dx : base - dx
      v = Math.max(200, Math.min(460, v))
      body.style.setProperty(prop, `${v}px`)
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp)
      document.body.style.cursor = ""
      document.querySelectorAll(".cj-editor .ed-resizer.dragging").forEach((el) => el.classList.remove("dragging"))
    }
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp)
    document.body.style.cursor = "col-resize"
  }

  // 整页空态(未选书):页头工作条与 books/runs 同构(像素徽章 + 标题 + 副标题 + KPI + 动作区),
  // 主体沿用整页像素剧场,但撑满可用宽高 —— 不再是「一行小字 + 漂在死白里的空态卡」。
  if (!booksLoading && !bookId) {
    return (
      <div className="cj-screen cj-editor">
        <header className="cj-workhead ed-head">
          <div className="ed-headline">
            <PixelBadge kind="editor" size={44} className="ed-hero-pixel" ariaLabel="章节编辑" />
            <div className="ed-headline-text">
              <div className="page-title-row">
                <h1 className="page-title">章节编辑</h1>
              </div>
              <div className="page-sub">
                本地工作区还没有作品 —— 创建后,左手章节目录、中间写作画布、右手 AI 编辑部,在这里一章一章往前写。
              </div>
            </div>
            <Link href="/books" className="btn primary ed-head-cta">
              <span aria-hidden>+</span> 去创建第一部作品
            </Link>
          </div>
          <div className="ed-kpis" role="group" aria-label="写作概览">
            <KpiChip label="章节总数" value={0} unit="章" tone="neutral" hint="创建作品后从第一章开写" />
            <KpiChip label="已写章节" value={0} unit="章" tone="neutral" />
            <KpiChip label="已发布" value={0} unit="章" tone="neutral" />
            <KpiChip label="累计成稿" value={0} unit="字" tone="neutral" />
            <KpiChip label="质量评分" value="—" tone="neutral" hint="开笔后编辑部会给每章打分" />
          </div>
        </header>
        <div className="cj-screen-body solo ed-vacant-body">
          <div className="empty empty-lg editorial-empty ed-vacant-stage" data-empty-variant="editor">
            <div className="empty-art">
              <EmptyArt variant="editor" />
            </div>
            <div className="empty-title">稿纸已经铺好</div>
            <div className="empty-desc">本地工作区还没有作品 —— 创建后挑一章落笔,或让编辑部起个头;不急,一句一句来。</div>
            <div className="empty-actions">
              <Link href="/books" className="btn primary">去创建第一部作品</Link>
              <Link href="/" className="btn">返回工作台</Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const dims = quality ? [
    { l: "一致性", v: Math.round(quality.consistency) },
    { l: "节奏感", v: Math.round(quality.pacing) },
    { l: "情感", v: Math.round(quality.emotion) },
    { l: "文笔", v: Math.round(quality.diction) },
  ] : []
  const confirmCopy = confirmAction ? editorActionCopy(confirmAction, cur ?? 0, lastChapterNum, quality ? Math.round(quality.overall) : null) : null

  // 剧场态:写作流水线在跑时,正文区放大字号,左右栏淡化半透明,焦点回到字上
  const writingTheater = run.isRunning || live.active

  // —— 「愉悦」支柱:用真实状态轻轻庆祝进展,绝不打扰写作、绝不编数字 ——
  // 正文区加载态:切到一个真实章节、正文还没回来时给衬线骨架,代替闪烁/串章
  const paperLoading = !!cur && !manuscript && !live.active && view === "text"
  // 这一章是否「写过」:有正文 manuscript(空章给温柔的起笔邀请,而非空白)
  const chapterHasBody = (manuscript?.paragraphs?.length ?? 0) > 0 || text.trim().length > 0
  // 真实达标:本章质量分≥85(与右侧/评审同一门槛),不是凭空夸
  const chapterPassed = !!quality && quality.overall >= 85
  // 真实签发:总编裁决 pass
  const eicSigned = review?.verdict === "pass"
  // 一句真诚、克制的庆祝(只在确有进展时出现一次性短句,不刷屏)
  const cheer = !cur || live.active
    ? null
    : eicSigned
      ? { tone: "signed" as const, text: `总编已签发第 ${cur} 章 — 这一章站住了，去写下一章吧。` }
      : chapterPassed
        ? { tone: "passed" as const, text: `第 ${cur} 章质量已达标 · ${Math.round(quality!.overall)} 分，稳稳的。` }
        : null

  return (
    <div className={`page cj-editor${writingTheater ? " writing-theater" : ""}`}>
      <div className={`ed-body${drawer ? ` drawer-open drawer-${drawer}` : ""}`} ref={bodyRef}>
        {/* 窄屏抽屉的遮罩,点击空白处收起(宽屏由 CSS 隐藏) */}
        {drawer && <div className="ed-scrim" onClick={() => setDrawer(null)} aria-hidden />}
        {/* 左:章节目录 */}
        <div className="ed-left scroll-thin">
          <div className="lh">
            <ListTree size={14} className="lh-ico" aria-hidden />
            <span className="lh-t">章节目录</span>
            <span className="c">{chapters?.length ?? 0}</span>
            <button type="button" className="ed-drawer-close" onClick={() => setDrawer(null)} aria-label="收起章节目录"><X size={15} /></button>
          </div>
          {chapters && chapters.length > 0 && (
            <div className="ed-left-stat">
              <StatLine items={[
                { n: chapterStats.written, label: "已写", tone: "brand" },
                { n: chapterStats.pub, label: "已发布", tone: "ok" },
                { n: chapterStats.words.toLocaleString(), label: "字" },
              ]} />
            </div>
          )}
          {(chapters ?? []).map((c) => {
            const isPub = published.has(c.num)
            const m = chapterMeta(c.status)
            const ChIcon = m.Icon
            return (
              <div key={c.id} className={`ch-item-wrap${c.num === cur ? " sel-wrap" : ""}`}>
                <button type="button" className={`ch-item${c.num === cur ? " sel" : ""}${isPub ? " pub" : ""}`} onClick={() => pickChapter(c.num)}>
                  <span className="ct">
                    <span className="ch-ico" data-state={m.state}><ChIcon size={13} /></span>
                    <span className="num">{String(c.num).padStart(2, "0")}</span>
                    <span className="ti">{c.title.zh}</span>
                  </span>
                  <span className="meta">
                    <span className="ch-words">{c.words ? `${c.words.toLocaleString()} 字` : "未写"}</span>
                    <span className={`pill ch-pill${c.status === "audit-failed" ? " audit" : ""}`} data-state={m.state}><span className="dot" />{CH_STATE[c.status] ?? c.status}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={`ch-pub-toggle${isPub ? " on" : ""}`}
                  onClick={(e) => { e.stopPropagation(); togglePublished(c.num) }}
                  title={isPub ? "已发布 · 点击撤销" : "标记为已发布"}
                  aria-label={isPub ? "已发布 · 点击撤销" : "标记为已发布"}
                >
                  {isPub ? <Check size={13} aria-hidden /> : null}
                </button>
              </div>
            )
          })}
          {!chapters && <div className="skel" style={{ height: 200, margin: 12 }} />}
        </div>

        <div className="ed-resizer" onPointerDown={startDrag("l")} onDoubleClick={() => bodyRef.current?.style.setProperty("--el", "256px")} />

        {/* 中:写作画布 */}
        <div className="ed-canvas">
          <div className="canvas-head">
            {/* 窄屏:打开章节目录抽屉(宽屏由 CSS 隐藏) */}
            <button type="button" className="ed-drawer-btn" onClick={() => setDrawer("chapters")} title="章节目录" aria-label="章节目录"><ListTree size={16} /></button>
            <PixelBadge kind="editor" size={28} className="page-title-pixel" ariaLabel="章节编辑" />
            <span className="tt">{selChapter ? `第 ${cur} 章 · ${selChapter.title.zh}` : cur ? `第 ${cur} 章` : "选择章节"}</span>
            {live.reconnecting ? (
              <span className="ed-live" style={{ ["--live-color" as string]: "var(--warn-500, #D97706)" }}>
                <span className="ed-live-dot" />
                连接中断 · 重连中…
              </span>
            ) : live.active ? (
              <span className="ed-live" style={{ ["--live-color" as string]: agentColor(live.agentId ?? "writer") }}>
                <span className="ed-live-dot" />
                {live.agentName ?? "智能体"}正在{live.stageText || "生成"}
                {live.charCount > 0 ? ` · ${live.charCount.toLocaleString()} 字` : "…"}
              </span>
            ) : (
              <span className="st"><PenLine size={12} aria-hidden /> {wordCount.toLocaleString()} 字</span>
            )}
            <div className="canvas-view-toggle" role="tablist">
              <button type="button" className={view === "text" ? "on" : ""} onClick={() => setView("text")}><BookOpenText size={13} /> 正文</button>
              <button type="button" className={view === "review" ? "on" : ""} onClick={() => setView("review")}><Gavel size={13} /> 评审</button>
            </div>
            {/* 窄屏:打开 AI 协作 / 质量 / 审议面板抽屉(宽屏由 CSS 隐藏) */}
            <button type="button" className="ed-drawer-btn" onClick={() => setDrawer("panel")} title="AI 协作面板" aria-label="AI 协作面板"><PanelRight size={16} /></button>
            <Link href={immersiveHref} className="btn ghost sm" title="全屏沉浸"><Maximize2 size={13} /></Link>
          </div>
          {/* 待修硬伤提示条:audit-failed 章带未修复硬违规落盘,读者侧必须看得见;就地给「修复本章」出口 */}
          {selChapter?.status === "audit-failed" && !live.active && (
            <div className="ed-audit-bar" role="alert">
              <TriangleAlert size={13} aria-hidden />
              <span className="ed-audit-t">本章带未修复的硬性问题(复修预算已用尽)— 修到过门禁会自动解锁。</span>
              <button type="button" className="btn sm ed-audit-fix" onClick={() => openAiConfirm("repair")} disabled={aiBusy || !cur} title="原地把本章修到达标,不回滚后面的章">
                <ShieldCheck size={12} /> 修复本章
              </button>
            </div>
          )}
          <div className="paper scroll-thin" ref={streamRef}>
            {!cur ? (
              <div className="ed-welcome">
                <img
                  className="ed-welcome-prop"
                  src="/brand/props/editor-desk.webp"
                  alt=""
                  width={360}
                  height={251}
                  draggable={false}
                />
                <p className="ed-welcome-t">挑一个章节，开始今天的写作</p>
                <p className="ed-welcome-s">左侧目录里选一章，正文会在这里铺开;不急,一句一句来。</p>
              </div>
            ) : paperLoading ? (
              <div className="ed-paper-skel" aria-hidden>
                {[92, 100, 86, 97, 70, 100, 90, 64].map((w, i) => (
                  <span key={i} className="skel ed-skel-line" style={{ width: `${w}%` }} />
                ))}
              </div>
            ) : view === "review" ? (
              <div className="ed-review">
                <div className="erv-head">
                  <h3>第 {cur} 章 · 编辑部评审</h3>
                  {quality && (
                    <span className="erv-score" data-ok={quality.overall >= 85}>{Math.round(quality.overall)}<i>/100</i></span>
                  )}
                </div>

                <div className="erv-sec">
                  <div className="erv-lab"><Workflow size={13} aria-hidden /> 编辑部流水线 · 谁做了什么</div>
                  {handoff && handoff.agents.length > 0 ? handoff.agents.map((a) => (
                    <div className="erv-agent" key={a.id} style={{ ["--c" as string]: agentColor(a.id) }}>
                      <span className="erv-avatar"><AgentPixel id={a.id} size={32} ariaLabel={a.role} /></span>
                      <div className="erv-abody">
                        <div className="erv-arow"><b>{a.role}</b><span className={`erv-sig ${a.tone}`}>{a.signal}</span></div>
                        <p className="erv-did">{a.did}</p>
                      </div>
                    </div>
                  )) : <div className="muted" style={{ fontSize: 13 }}>本章暂无流水线追踪(写作 / 续写后,这里会出现每个 agent 做了什么)。</div>}
                </div>

                {handoff && (handoff.opinions.audit.length > 0 || handoff.opinions.reader) && (
                  <div className="erv-sec">
                    <div className="erv-lab"><ClipboardCheck size={13} aria-hidden /> 审校意见与建议</div>
                    {handoff.opinions.audit.map((i, idx) => (
                      <div className={`erv-issue ${String(i.severity).toLowerCase()}`} key={idx}>
                        <span className="erv-sev">{severityLabel(i.severity)}</span>
                        <span className="erv-msg">{i.message}</span>
                        <button
                          type="button"
                          className="btn ghost sm erv-fix"
                          onClick={() => openSuggestionConfirm(`按这条审校意见修复本章：${i.message}`)}
                          disabled={aiBusy || !cur}
                        >
                          <Wand2 size={12} /> 按此修复
                        </button>
                      </div>
                    ))}
                    {handoff.opinions.reader && (
                      <div className="erv-reader">读者评审 · {verdictLabel(handoff.opinions.reader.verdict) || "—"}{handoff.opinions.reader.total != null ? ` · ${handoff.opinions.reader.total} 分` : ""}</div>
                    )}
                  </div>
                )}

                {review ? (
                  <div className="erv-sec">
                    <div className="erv-lab"><Gavel size={13} aria-hidden /> 总编批语 <span className={`erv-verdict ${review.verdict}`}>{review.verdict === "pass" ? "已签发" : "判返工"}</span>{review.editorialScore != null && <span className="erv-escore">编辑分 {review.editorialScore}</span>}</div>
                    <p className="erv-note">{review.rationale}</p>
                    {review.strengths.length > 0 && <div className="erv-list ok"><span className="l">亮点</span><ul>{review.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
                    {review.risks.length > 0 && <div className="erv-list risk"><span className="l">风险</span><ul>{review.risks.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
                    {review.reworkTargets.length > 0 && <div className="erv-rework"><span className="l">返工派工</span>{review.reworkTargets.map((t, i) => (
                      <div className="erv-rt" key={i}>
                        <span><b>{t.agent}</b> {t.what}</span>
                        <button
                          type="button"
                          className="btn ghost sm erv-fix"
                          onClick={() => openSuggestionConfirm(`按总编返工建议修复本章：${t.agent}：${t.what}`)}
                          disabled={aiBusy || !cur}
                        >
                          <Wand2 size={12} /> 按此修复
                        </button>
                      </div>
                    ))}</div>}
                    {review.nextDirection && <div className="erv-dir"><span className="l">下一程方向</span>{review.nextDirection}</div>}
                  </div>
                ) : (
                  <div className="erv-sec">
                    <div className="erv-lab"><Gavel size={13} aria-hidden /> 总编批语</div>
                    <div className="erv-empty">
                      <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>总编尚未签批本章。它会读全部专家信号做整体裁决。</p>
                      <button type="button" className={`btn primary sm${reviewBusy ? " is-loading" : ""}`} onClick={() => openAiConfirm("eic-review")} disabled={reviewBusy || aiBusy || !cur}><Gavel size={13} /> 请总编复审</button>
                    </div>
                  </div>
                )}

                <div className="erv-sec">
                  <div className="erv-lab"><GitCompareArrows size={13} aria-hidden /> 修改对比 · diff</div>
                  {revisions && revisions.passes.length > 0 ? revisions.passes.map((pass, idx) => {
                    const segs = diffLines(pass.before, pass.after)
                    const stats = diffStats(segs)
                    return (
                      <details className="erv-diff-pass" key={pass.filename} open={idx === 0}>
                        <summary>
                          <span className="erv-diff-kind">{pass.kindLabel}</span>
                          <span className="erv-diff-stat"><b className="add">+{stats.added}</b> <b className="del">−{stats.removed}</b> 段</span>
                        </summary>
                        {pass.notes && <p className="erv-diff-notes">{pass.notes}</p>}
                        <div className="erv-diff-body">
                          {segs.filter((s) => s.text.trim()).map((s, i) => (
                            <div className={`dl ${s.type}`} key={i}>{s.text}</div>
                          ))}
                        </div>
                      </details>
                    )
                  }) : <p className="muted" style={{ fontSize: 13 }}>本章还没有修订记录(没被改写/修复过,或刚写完)。一旦写手原稿被修改,这里就会出现逐处「红删 / 绿增」对比。</p>}
                </div>
              </div>
            ) : live.active && live.text ? (
              <div className="paper-stream prose-serif">
                {/* 流式分段渲染 + 语义分色(editor 在 .app 内,.tk-* 直接生效),与另两处画布同构 */}
                <StreamingProse text={typed} dict={proseDict} caret={<span className="type-caret" aria-hidden />} />
                <StreamFollowChip show={!stick.following} onJump={stick.jumpToBottom} />
              </div>
            ) : (
              <div className="ed-write-wrap">
                {!chapterHasBody && (
                  <div className="ed-blank-hint" aria-hidden>
                    <img
                      className="ed-blank-prop"
                      src="/brand/props/editor-desk.webp"
                      alt=""
                      width={180}
                      height={126}
                      draggable={false}
                    />
                    <p className="ed-blank-t">这一章还是空白页 — 落下第一句,或让右侧 AI 起个头。</p>
                  </div>
                )}
                <textarea
                  value={text}
                  onChange={(e) => { setText(e.target.value); setDirty(true) }}
                  placeholder="在此撰写本章正文,或用右侧 AI 协作生成…"
                  spellCheck={false}
                />
              </div>
            )}
          </div>
          {/* 进展庆祝条:仅在确有真实进展时出现(达标 / 总编签发),一行像素温度,不弹窗不打扰 */}
          {cheer && view === "text" && !dirty && (
            <div className={`ed-cheer ${cheer.tone}`} role="status">
              <AgentPixel id={cheer.tone === "signed" ? "editor-in-chief" : "quality-report"} size={24} className="ed-cheer-pix" ariaLabel={cheer.tone === "signed" ? "总编" : "质量报告官"} />
              <span className="ed-cheer-t">{cheer.text}</span>
            </div>
          )}
          <div className="canvas-foot">
            {dirty
              ? <span className="ed-foot-state dirty"><span className="dirty-dot" />还没保存 · 写得正顺就继续</span>
              : <span className="ed-foot-state ok"><Check size={12} /> 已同步</span>}
            <span className="ed-foot-dim">· 第 {cur ?? "—"} 章 · {wordCount.toLocaleString()} 字</span>
            <span className="sp" />
            <button type="button" className="btn ghost sm" onClick={onCopy} disabled={!cur}><Copy size={12} /> 复制本章</button>
            {/* 读完即批:status=review 且无未保存改动时,把批准动作放到读完的终点(达标直签,低分先确认) */}
            {selChapter?.status === "review" && !dirty && (
              <button
                type="button"
                className={`btn primary sm${approving ? " is-loading" : ""}`}
                onClick={onApproveClick}
                disabled={approving || !cur}
                title={quality && Math.round(quality.overall) < 85
                  ? `本章 ${Math.round(quality.overall)} 分未达 85 门禁 —— 点击会先确认再强制签发`
                  : "批准本章:标记为通过,纯状态变更,不耗 token"}
              >
                <BadgeCheck size={12} /> {quality && Math.round(quality.overall) < 85 ? `批准本章 · ${Math.round(quality.overall)} 分` : "批准本章"}
              </button>
            )}
            <button type="button" className={`btn primary sm${saving ? " is-loading" : ""}`} onClick={onSave} disabled={saving || !dirty}><Check size={12} /> 保存</button>
          </div>
        </div>

        <div className="ed-resizer" onPointerDown={startDrag("r")} onDoubleClick={() => bodyRef.current?.style.setProperty("--er", "320px")} />

        {/* 右:AI 协作(实时流水线 sticky 顶部 + 三 tab 分流) */}
        <div className="ed-right scroll-thin">
          {(run.isRunning || activity.live) && (
            <div className="rs ed-live-panel">
              <h5><Radio size={13} aria-hidden /> 实时流水线 <span className="wf-sub">{run.currentStage || activity.currentText || "运行中"}</span></h5>
              {activity.currentAgentId && (
                <div className="elp-current" style={{ ["--c" as string]: agentColor(activity.currentAgentId) }}>
                  <span className="elp-dot" />
                  <b>{agentDisplayName(activity.currentAgentId)}</b>
                  <span className="elp-cur-text">{activity.currentText || "处理中…"}</span>
                </div>
              )}
              <div className="elp-log">
                {activity.events.length ? activity.events.map((ev) => (
                  <div className="elp-row" key={ev.id} style={{ ["--c" as string]: agentColor(ev.agentId) }}>
                    <span className="elp-rdot" />
                    <span className="elp-agent">{ev.agentName}</span>
                    <span className="elp-text">{ev.text}</span>
                  </div>
                )) : <div className="muted" style={{ fontSize: 12 }}>正在启动流水线…</div>}
              </div>
            </div>
          )}

          {/* 三 tab 切片 — 一次只看一个,降低视觉噪音 */}
          <div className="ed-tabs" role="tablist" aria-label="右侧面板视图">
            <button type="button" role="tab" aria-selected={rightTab === "work"}    className={rightTab === "work"    ? "on" : ""} onClick={() => setRightTab("work")}><SquarePen size={13} /> 工作</button>
            <button type="button" role="tab" aria-selected={rightTab === "quality"} className={rightTab === "quality" ? "on" : ""} onClick={() => setRightTab("quality")}>
              <Gauge size={13} /> 质量{quality ? <span className="ed-tab-badge" data-ok={quality.overall >= 85}>{Math.round(quality.overall)}</span> : null}
            </button>
            <button type="button" role="tab" aria-selected={rightTab === "review"}  className={rightTab === "review"  ? "on" : ""} onClick={() => setRightTab("review")}>
              <Gavel size={13} /> 审议{review ? <span className={`ed-tab-badge ${review.verdict === "pass" ? "ok" : "warn"}`}>{review.verdict === "pass" ? "签" : "返"}</span> : null}
            </button>
            <button type="button" className="ed-drawer-close in-tabs" onClick={() => setDrawer(null)} aria-label="收起面板"><X size={15} /></button>
          </div>

          {rightTab === "work" && <>
          <div className="rs">
            <h5><Sparkles size={13} aria-hidden /> AI 协作</h5>
            <div className="ai-acts">
              <button type="button" className={`ai-act${aiBusy ? " is-disabled" : ""}`} onClick={() => openAiConfirm("continue")} disabled={aiBusy || !cur}><span className="i"><Sparkles size={14} /></span>续写</button>
              <button type="button" className={`ai-act fix${aiBusy ? " is-disabled" : ""}`} onClick={() => openAiConfirm("repair")} disabled={aiBusy || !cur} title="原地把本章修到达标,不回滚后面的章"><span className="i"><ShieldCheck size={14} /></span>修复本章</button>
              <button type="button" className={`ai-act${aiBusy ? " is-disabled" : ""}`} onClick={() => openAiConfirm("polish")} disabled={aiBusy || !cur} title="改写式:会回滚重写本章之后的所有章"><span className="i"><Wand2 size={14} /></span>润色</button>
              <button type="button" className={`ai-act${aiBusy ? " is-disabled" : ""}`} onClick={() => openAiConfirm("expand")} disabled={aiBusy || !cur} title="改写式:会回滚重写本章之后的所有章"><span className="i"><Stars size={14} /></span>扩写</button>
              <button type="button" className={`ai-act${aiBusy ? " is-disabled" : ""}`} onClick={() => openAiConfirm("review")} disabled={aiBusy || !cur}><span className="i"><Scissors size={14} /></span>审稿</button>
            </div>
          </div>
          <div className="rs">
            <h5><FileText size={13} aria-hidden /> 本章信息</h5>
            <div className="ed-info">
              <span className="ed-info-item">
                <PenLine size={13} className="ed-info-ico" aria-hidden />
                <span className="ed-info-l">状态</span>
                {selChapter
                  ? <span className="pill" data-state={chapterMeta(selChapter.status).state}><span className="dot" />{CH_STATE[selChapter.status] ?? selChapter.status}</span>
                  : <span className="ed-info-v">—</span>}
              </span>
              <span className="ed-info-item">
                <FileText size={13} className="ed-info-ico" aria-hidden />
                <span className="ed-info-l">字数</span>
                <span className="ed-info-v num">{wordCount.toLocaleString()}</span>
              </span>
              <span className="ed-info-item">
                <BadgeCheck size={13} className="ed-info-ico" aria-hidden />
                <span className="ed-info-l">已采纳字数</span>
                <span className="ed-info-v num">{quality?.adopted ? `${Math.round(quality.adopted).toLocaleString()} 字` : "—"}</span>
              </span>
            </div>
          </div>
          </>}

          {rightTab === "quality" && <>
          <div className="rs">
            <h5><Gauge size={13} aria-hidden /> 本章质量</h5>
            {quality ? (
              <>
                <div className="ed-q-hero">
                  <span className="ed-q-num num">{Math.round(quality.overall)}</span>
                  <span className="ed-q-of">/ 100</span>
                  <span className="pill" data-state={quality.overall >= 85 ? "success" : quality.overall >= 70 ? "warn" : "error"} style={{ marginLeft: "auto" }}><span className="dot" />{quality.overall >= 85 ? "达标" : "待提升"}</span>
                </div>
                <Meter value={Math.round(quality.overall)} max={100} threshold={85} tone="brand" showValue={false} />
                <div className="ed-q-dims">
                  {dims.map((d) => (
                    <Meter key={d.l} label={d.l} value={d.v} max={100} tone="brand" />
                  ))}
                </div>
              </>
            ) : <div className="muted" style={{ fontSize: 12 }}>本章暂无质量评分</div>}
          </div>
          <div className="rs">
            <h5><Workflow size={13} aria-hidden /> 本章工作流 <span className="wf-sub">{handoff ? `${handoff.agents.length} 关 · 谁做了什么` : "流水线全貌"}</span></h5>
            {handoff ? (
              <div className="wf">
                <FoldCard
                  title="流水线交棒"
                  icon={<Workflow size={14} />}
                  count={handoff.agents.length}
                  defaultOpen
                  scrollable={handoff.agents.length > 6}
                  maxHeight={220}
                >
                  <div className="wf-ledger">
                    {handoff.agents.map((a) => (
                      <div className="wf-row" key={a.id} title={a.did} style={{ ["--c" as string]: agentColor(a.id) }}>
                        <AgentPixel id={a.id} size={18} ariaLabel={a.role} className="wf-pix" />
                        <span className="wf-role">{a.role}</span>
                        <span className="wf-sig" title={a.signal}>{a.signal}</span>
                        <span className={`wf-dot ${a.tone}`} />
                      </div>
                    ))}
                  </div>
                </FoldCard>

                {(handoff.opinions.audit.length > 0 || handoff.opinions.reader) && (
                  <div className="wf-block">
                    <div className="wf-lab"><Lightbulb size={12} aria-hidden /> 意见与建议</div>
                    {handoff.opinions.reader && (
                      <div className="wf-reader">读者评审 · {verdictLabel(handoff.opinions.reader.verdict) || "—"}{handoff.opinions.reader.total != null ? ` · ${handoff.opinions.reader.total} 分` : ""}</div>
                    )}
                    {handoff.opinions.audit.slice(0, 5).map((i, idx) => (
                      <div className={`wf-issue ${String(i.severity).toLowerCase()}`} key={idx}>
                        <span className="wf-sev">{severityLabel(i.severity)}</span>
                        <span className="wf-msg">{i.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="wf-block">
                  <div className="wf-lab"><BookOpenText size={12} aria-hidden /> 读取 · 每个 agent 读什么(有界注入)</div>
                  {handoff.reads.stale && <div className="wf-warn"><TriangleAlert size={12} aria-hidden /> 追踪早于当前正文,下方为上次管线生成时的注入</div>}
                  {handoff.reads.captured && handoff.reads.truthSources.length > 0 && (
                    <div className="wf-chips">
                      {handoff.reads.truthSources.slice(0, 10).map((s) => <span className="wf-chip" key={s}>{s}</span>)}
                    </div>
                  )}
                  <p className="wf-note">{handoff.reads.boundedNote}</p>
                </div>

                <div className="wf-block">
                  <div className="wf-lab"><Send size={12} aria-hidden /> 写回 · 是否传给下一章</div>
                  <div className="wf-wb"><span className={`wf-pill ${handoff.writeback.summaryWritten ? "ok" : "warn"}`}>{handoff.writeback.summaryWritten ? "已回写摘要+状态 → 下一章可读" : "尚未回写(刚写完/重置后属正常)"}</span></div>
                  <p className="wf-note">{handoff.writeback.note}</p>
                </div>
              </div>
            ) : <div className="muted" style={{ fontSize: 12 }}>本章暂无工作流追踪(写作/续写后,这里会出现每个 agent 的动作、意见、读取与回写)。</div>}
          </div>
          </>}

          {rightTab === "review" && <>
          <div className="rs">
            <h5><Gavel size={13} aria-hidden /> 总编批语 <span className="eic-role">Editor-in-Chief</span></h5>
            {review ? (
              <div className="eic">
                <div className="eic-head">
                  <span className={`eic-verdict ${review.verdict}`}>{review.verdict === "pass" ? "已签发" : "判返工"}</span>
                  {review.editorialScore != null && <span className="eic-score">编辑分 {review.editorialScore}</span>}
                  <button type="button" className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => openAiConfirm("eic-review")} disabled={reviewBusy || aiBusy}>{reviewBusy ? <Loader2 size={12} className="spin" /> : <Gavel size={12} />} 复审</button>
                  {/* 总编已 pass 而章仍待批:把「裁决通过」自然接到「正式批准」,不必绕回工作台 */}
                  {review.verdict === "pass" && selChapter?.status === "review" && (
                    <button type="button" className={`btn primary sm${approving ? " is-loading" : ""}`} onClick={onApproveClick} disabled={approving || !cur}>
                      <BadgeCheck size={12} /> 签发本章
                    </button>
                  )}
                </div>
                <p className="eic-note">{review.rationale}</p>
                {review.strengths.length > 0 && <div className="eic-list ok"><span className="lab"><Lightbulb size={11} aria-hidden /> 亮点</span><ul>{review.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
                {review.risks.length > 0 && <div className="eic-list risk"><span className="lab"><TriangleAlert size={11} aria-hidden /> 风险</span><ul>{review.risks.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
                {review.reworkTargets.length > 0 && <div className="eic-rework"><span className="lab">返工派工</span>{review.reworkTargets.map((t, i) => (
                  <div className="eic-rt" key={i}>
                    <span><b>{t.agent}</b> {t.what}</span>
                    <button
                      type="button"
                      className="btn ghost sm eic-fix"
                      onClick={() => openSuggestionConfirm(`按总编返工建议修复本章：${t.agent}：${t.what}`)}
                      disabled={aiBusy || !cur}
                    >
                      <Wand2 size={12} /> 按此修复
                    </button>
                  </div>
                ))}</div>}
                {review.nextDirection && <div className="eic-dir"><span className="lab"><ArrowDownWideNarrow size={11} aria-hidden /> 下一程方向</span>{review.nextDirection}</div>}
                {(review.model || review.skill) && <div className="eic-by">{review.model}{review.skill ? ` · 挂载技能 ${review.skill}` : ""}</div>}
              </div>
            ) : (
              <div className="eic-empty">
                <p className="muted" style={{ fontSize: 12, margin: "0 0 8px", lineHeight: 1.6 }}>总编尚未签批本章。它会读全部专家信号(质量分/连续性/读者/风格/字数/审稿)做整体裁决。</p>
                <button type="button" className={`btn primary sm${reviewBusy ? " is-loading" : ""}`} onClick={() => openAiConfirm("eic-review")} disabled={reviewBusy || aiBusy || !cur}>{reviewBusy ? <Loader2 size={13} /> : <Gavel size={13} />} 请总编复审</button>
              </div>
            )}
          </div>
          </>}
        </div>
      </div>
      {confirmCopy && (
        <AlertDialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmCopy.title}</AlertDialogTitle>
              <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
                <span>{confirmCopy.description}</span>
                <span className="border-border bg-secondary text-foreground/80 rounded-md border px-3 py-2 font-mono text-[11px] leading-relaxed">
                  《{activeTitle ?? "—"}》 · 第 {cur ?? "—"} 章 · 当前字数 {wordCount.toLocaleString()} · 当前质量 {quality ? Math.round(quality.overall) : "—"}
                </span>
                {confirmAction === "suggestion" && suggestionInstruction && (
                  <span className="border-border bg-secondary text-foreground/80 rounded-md border px-3 py-2 text-[11px] leading-relaxed">
                    {suggestionInstruction}
                  </span>
                )}
                <span>{confirmCopy.guardrail}</span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={busy || reviewBusy || approving}>保持当前状态</AlertDialogCancel>
              <AlertDialogAction
                type="button"
                disabled={busy || reviewBusy || approving}
                className={confirmCopy.destructive ? "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20" : undefined}
                onClick={(event) => {
                  event.preventDefault()
                  void confirmAiAction()
                }}
              >
                {confirmCopy.confirmLabel}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}

function editorActionCopy(action: EditorAiAction, cur: number, lastChapterNum: number, qualityOverall: number | null) {
  const rewritesTail = cur > 0 && lastChapterNum > cur
  const tailScope = rewritesTail ? `会回滚并重写第 ${cur + 1}–${lastChapterNum} 章(后端会自动备份)。` : "当前已是最后一章,主要更新本章改写结果。"

  switch (action) {
    case "continue":
      return {
        title: "启动真实续写？",
        description: "这会调用后端写作流水线,可能消耗 LLM token,并新增或更新后续章节正文。",
        guardrail: "只做界面检查时请保持当前状态;需要真实写作时再确认。",
        confirmLabel: "确认续写",
        destructive: false,
      }
    case "repair":
      return {
        title: "启动本章原地复修？",
        description: `这会启动质量复修流水线,只修第 ${cur || "—"} 章,目标质量 90 分,可能消耗 LLM token 并更新稿件文件。`,
        guardrail: "它不会回滚后续章节;如果想大幅改写本章及后文,再使用润色或扩写。",
        confirmLabel: "确认修复本章",
        destructive: false,
      }
    case "polish":
      return {
        title: "启动真实润色？",
        description: `润色是改写式操作,可能消耗 LLM token 并更新稿件。${tailScope}`,
        guardrail: "只想修好当前章且不动后文,请保持当前状态并改用“修复本章”。",
        confirmLabel: "确认润色",
        destructive: rewritesTail,
      }
    case "expand":
      return {
        title: "启动真实扩写？",
        description: `扩写是改写式操作,可能消耗 LLM token 并更新稿件。${tailScope}`,
        guardrail: "只想修好当前章且不动后文,请保持当前状态并改用“修复本章”。",
        confirmLabel: "确认扩写",
        destructive: rewritesTail,
      }
    case "review":
      return {
        title: "启动真实审稿？",
        description: "这会调用审稿流水线读取本章,可能消耗 LLM token,并写回审稿意见/工作流追踪。",
        guardrail: "不会直接改写正文,但会更新本章审稿与流水线证据。",
        confirmLabel: "确认审稿",
        destructive: false,
      }
    case "eic-review":
      return {
        title: "请总编真实复审？",
        description: "总编会读取质量分、连续性、读者评审、风格和审稿信号做整体裁决,可能消耗 LLM token。",
        guardrail: "不会直接改写正文,但会更新总编批语/签发或返工裁决。",
        confirmLabel: "确认复审",
        destructive: false,
      }
    case "approve":
      return {
        title: "强制签发本章？",
        description: `第 ${cur || "—"} 章${qualityOverall != null ? `当前质量 ${qualityOverall} 分,未达 85 分门禁` : "还没有质量评分"}。批准是无视分数的强制签发 —— 签发后它会被当作定稿,续写不再回头修它。`,
        guardrail: "纯状态变更,不耗 token;想先把分拉上去再签,请保持当前状态并改用“修复本章”。",
        confirmLabel: "确认强制签发",
        destructive: false,
      }
    case "suggestion":
      return {
        title: "按这条建议改写本章？",
        description: "这会让编辑部按该建议改写本章,调用整章 enhance,触发 LLM 并消耗额度。",
        guardrail: "这是直接落地改稿,会更新本章正文并刷新质量/审议信息;只想本地记账请保持当前状态。",
        confirmLabel: "确认按建议修复",
        destructive: false,
      }
  }
}
