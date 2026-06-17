"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Loader2, Sparkles, FileText, Upload, X, Trash2, ListChecks, Layers, AlertTriangle, ArrowRight, Lightbulb, ChevronDown, Check } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  createBook,
  waitForBookCreateStatus,
  cancelBookCreate,
  deleteBook,
} from "@/lib/api/client"
import type { BookCreateStatus } from "@/lib/api/types"
import { useWorkspace } from "@/lib/workspace-context"
import "./new-book-dialog.css"

// 题材下拉建议:常见网文题材,点选即填;输入框仍可自由改/自定义(题材是开放集)。
const GENRE_OPTIONS = [
  "都市现实", "都市异能", "玄幻修真", "仙侠武侠",
  "科幻悬疑", "历史架空", "悬疑推理", "游戏竞技",
  "奇幻冒险", "言情古言", "青春校园", "末世星际",
  "灵异恐怖", "职场商战", "种田经营", "同人二创",
]

// 建书阶段:对应后端 BookCreateStatus.stage / pipeline
const SETUP_STEPS: { id: string; label: string; hint: string }[] = [
  { id: "init",       label: "落盘工作区",   hint: "创建本地目录、初始化配置文件" },
  { id: "architect",  label: "架构师起稿",   hint: "生成故事框架 / 卷地图 / 角色矩阵" },
  { id: "foundation", label: "建书复审官",   hint: "复审框架的逻辑、设定与商业潜力" },
  { id: "settle",     label: "落地章节计划", hint: "把卷地图拆成章节,准备开写" },
]

// running = 轮询中;done = 建好;needs-foundation / stalled / error 各有专属补救面板。
type Step = "form" | "running" | "done" | "needs-foundation" | "stalled" | "error"

export function NewBookDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const { setBookId, refreshBooks, upsertBook } = useWorkspace()
  const [step, setStep] = React.useState<Step>("form")
  const [draft, setDraft] = React.useState({
    title: "",
    genre: "都市现实",
    platform: "fanqie",
    chapterWordCount: 3000,
    targetChapters: 120,
    brief: "",
  })
  const [statusSnap, setStatusSnap] = React.useState<BookCreateStatus | null>(null)
  const [activeStepIdx, setActiveStepIdx] = React.useState<number>(-1)
  const [errMsg, setErrMsg] = React.useState<string>("")
  // 题材下拉:点 chevron 弹常见题材建议,点击外面收起;输入框始终可自由输入。
  const [genreOpen, setGenreOpen] = React.useState(false)
  const genreRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!genreOpen) return
    const onDoc = (e: MouseEvent) => { if (genreRef.current && !genreRef.current.contains(e.target as Node)) setGenreOpen(false) }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [genreOpen])
  // stalled 面板复用给两种情形:轮询超时(timeout) 与 用户主动取消(cancelled),标题/副标各自措辞。
  const [stalledKind, setStalledKind] = React.useState<"timeout" | "cancelled">("timeout")
  // 后端已经落盘的半成品书 id —— 取消建书 / 删除半成品 / 去补地基 都靠它。
  // 即使建书崩了,只要 createBook 返回过 bookId,这本残稿就在磁盘上,必须能被收拾。
  const [createdBookId, setCreatedBookId] = React.useState<string>("")
  const [cancelling, setCancelling] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  // 用户点了「取消建书」后,仍在跑的 waitForBookCreateStatus 会看到 run=cancelled 并想切到 error
  // 面板 —— 那会把用户主动取消错误地渲染成红色「建书没成」。用 ref 标记,让 handleCreate 在取消后
  // 不再抢占面板,取消的善后 UI 由 handleCancelCreate 独占。
  const cancelRequestedRef = React.useRef(false)
  // 删除是破坏性操作 —— 先点一次变「确认删除」,二次点击才真删。避免误删半成品。
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  // ─ 上传文件 ────────────────────────────────────────────────────
  // 支持把别的 LLM/手写的 md / txt 文件喂给建书 — 多个文件 → 拼到 brief
  // 每个文件内容前加 "## 文件名" 让 architect 能区分来源
  type UploadedFile = { name: string; size: number; content: string }
  const [uploads, setUploads] = React.useState<UploadedFile[]>([])
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const MAX_TOTAL_CHARS = 200_000  // ~200KB 文本上限,防止 LLM context 爆

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    const accepted: UploadedFile[] = []
    let totalSoFar = uploads.reduce((s, u) => s + u.content.length, 0)
    for (const f of files) {
      // 后缀白名单(允许 .md / .markdown / .txt / .text)
      if (!/\.(md|markdown|txt|text)$/i.test(f.name)) {
        toast.warning(`跳过 ${f.name}`, { description: "只支持 .md / .markdown / .txt" })
        continue
      }
      try {
        const text = await f.text()
        if (totalSoFar + text.length > MAX_TOTAL_CHARS) {
          toast.warning(`${f.name} 太大,跳过`, { description: `单次上传总量超过 ${MAX_TOTAL_CHARS / 1000}k 字符` })
          continue
        }
        totalSoFar += text.length
        accepted.push({ name: f.name, size: f.size, content: text })
      } catch (err) {
        toast.error(`读 ${f.name} 失败`, { description: err instanceof Error ? err.message : String(err) })
      }
    }
    if (accepted.length > 0) {
      setUploads((prev) => [...prev, ...accepted])
      toast.success(`已加 ${accepted.length} 个文件`, { description: "提交时会跟你写的设定一起发给 Architect。" })
    }
    // 清空 input value 让同一文件可再次被选(用户撤销后重传)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function removeUpload(idx: number) {
    setUploads((prev) => prev.filter((_, i) => i !== idx))
  }

  // 关闭时重置
  React.useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setStep("form")
        setStatusSnap(null)
        setActiveStepIdx(-1)
        setErrMsg("")
        setCreatedBookId("")
        setCancelling(false)
        setDeleting(false)
        setConfirmDelete(false)
        cancelRequestedRef.current = false
        setUploads([])  // 清掉上传
      }, 250)  // 等关闭动画结束
      return () => clearTimeout(t)
    }
  }, [open])

  // 根据后端的 stage / agent 推算当前在哪一步
  const inferStepIdx = (snap: BookCreateStatus): number => {
    const haystack = `${snap.stage ?? ""} ${snap.agent ?? ""} ${snap.agentLabel ?? ""}`.toLowerCase()
    if (/(foundation|复审|review)/.test(haystack)) return 2
    if (/(architect|框架|story_frame|character_matrix)/.test(haystack)) return 1
    if (/(plan|settle|章节|chapter|finalize|publish)/.test(haystack)) return 3
    if (/(init|mkdir|workspace|config)/.test(haystack)) return 0
    return Math.max(0, activeStepIdx)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const title = draft.title.trim()
    if (!title) {
      toast.error("书名不能为空")
      return
    }
    setStep("running")
    setActiveStepIdx(0)
    setErrMsg("")
    setConfirmDelete(false)
    setStalledKind("timeout")
    cancelRequestedRef.current = false
    try {
      const result = await createBook({
        title,
        genre: draft.genre.trim() || undefined,
        platform: draft.platform.trim() || undefined,
        language: "zh",
        chapterWordCount: Number(draft.chapterWordCount) || undefined,
        targetChapters: Number(draft.targetChapters) || undefined,
        // 用户一段话设定:小而精,直接给架构师。
        brief: draft.brief.trim() || undefined,
        // 上传文件【单独传】,不再拼进 brief。后端会按体量决定:小则内联,大则先摘要再喂架构师,
        // 避免把几十万字原文整段塞进 LLM 上下文导致溢出/超时(建书崩溃的根因)。
        referenceFiles:
          uploads.length > 0
            ? uploads.map((u) => ({ name: u.name, content: u.content }))
            : undefined,
      })
      // 拿到 bookId 立刻记下来 —— 后续无论成功/崩溃,取消/删除/补地基都要它。
      setCreatedBookId(result.bookId)
      const finalStatus = await waitForBookCreateStatus(result.bookId, {
        runId: result.runId,
        timeoutMs: 180_000,
        onStatus: (snap) => {
          setStatusSnap(snap)
          setActiveStepIdx(inferStepIdx(snap))
        },
      })
      // 用户中途取消了:善后面板已由 handleCancelCreate 接管,这里一律不再抢占。
      if (cancelRequestedRef.current) return
      if (finalStatus.status === "created") {
        // 真正建好才切到新书
        if (finalStatus.book) {
          upsertBook(finalStatus.book)
          setBookId(finalStatus.book.id)
        } else {
          await refreshBooks()
          setBookId(result.bookId)
        }
        setActiveStepIdx(SETUP_STEPS.length)  // 全亮
        setStep("done")
        toast.success(`《${title}》已建立`, { description: "可以开始写作了。" })
      } else {
        // 建书没跑完(崩溃 / 超时 / 地基待验收):刷新列表让半成品书可见,
        // 但【不把当前作品切到这本残缺的新书】——这是之前"建书崩了还把我扔到破书上"的根因。
        await refreshBooks()
        const msg =
          finalStatus.failureReason ||
          finalStatus.suggestion ||
          finalStatus.error ||
          finalStatus.warning ||
          (finalStatus.status === "needs-foundation"
            ? "故事地基还没通过复审,建书停在了大纲阶段 —— 没有直接硬写正文。"
            : finalStatus.status === "stalled"
              ? "前端等了 3 分钟还没等到结果,后台可能仍在跑。"
              : `建书没跑完(状态:${finalStatus.status})。`)
        setErrMsg(msg)
        if (finalStatus.status === "stalled") setStalledKind("timeout")
        setStep(
          finalStatus.status === "needs-foundation"
            ? "needs-foundation"
            : finalStatus.status === "stalled"
              ? "stalled"
              : "error",
        )
        toast.error("建书未完成", { description: msg })
      }
    } catch (err) {
      // 取消引发的中断不算失败,别覆盖取消的善后面板。
      if (cancelRequestedRef.current) return
      const msg = err instanceof Error ? err.message : String(err)
      setErrMsg(msg)
      // 异常时如果列表里能看到半成品,也刷新一下(createBook 可能已落盘才抛错)。
      await refreshBooks().catch(() => {})
      setStep("error")
      toast.error("建书失败", { description: msg })
    }
  }

  const close = () => onOpenChange(false)

  // 取消建书:走后端 create-cancel(标记 run 为 cancelled、释放写锁、abort job)。
  // 取消后保留半成品落到 stalled 面板,用户可再决定删除还是去补地基。
  async function handleCancelCreate() {
    if (!createdBookId || cancelling) return
    // 先举旗:在等后端返回的这段时间里,仍在跑的轮询不许再切面板。
    cancelRequestedRef.current = true
    setCancelling(true)
    setStalledKind("cancelled")
    try {
      await cancelBookCreate(createdBookId)
      await refreshBooks().catch(() => {})
      setErrMsg("已停下建书:架构师收手,写锁已释放。半成品草稿还在,可以删掉重来,或去补地基接着补。")
      setStep("stalled")
      toast.success("已取消建书")
    } catch (err) {
      // 409 = 后端说"没有进行中的建书任务"(可能刚好跑完/已停),当成已停处理,不卡用户。
      const msg = err instanceof Error ? err.message : String(err)
      await refreshBooks().catch(() => {})
      setErrMsg(`取消请求返回:${msg}。建书大概率已经停了,去作品列表确认一下;要么删掉半成品重来。`)
      setStep("stalled")
      toast.message("取消请求已发出", { description: "建书可能已停,去作品列表看看状态。" })
    } finally {
      setCancelling(false)
    }
  }

  // 删除半成品:DELETE /books/:id —— 取消未完成工作流 + 删本地目录。二次确认后执行。
  async function handleDeleteDraft() {
    if (!createdBookId || deleting) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setDeleting(true)
    try {
      await deleteBook(createdBookId)
      await refreshBooks().catch(() => {})
      toast.success("已删除半成品", { description: "本地草稿和未完成的工作流都清掉了。" })
      close()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error("删除失败", { description: msg })
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  // 去作品列表 / 运行台:都先关窗再跳,避免弹窗压在新页面上。
  function goTo(path: string) {
    close()
    router.push(path)
  }

  // 去补地基:把这本残稿设为当前作品,再进路线图(大纲/地基确认)。
  // 跟 new-book-mode 的 needs-foundation 处理一致 —— 不硬写正文,先补大纲/伏笔/人物动机。
  function goFixFoundation() {
    if (createdBookId) setBookId(createdBookId)
    close()
    router.push("/outline")
  }

  function foundationGuidance(raw: string): string {
    const msg = raw.trim()
    if (!msg) return "复审官没否定这本书,只是觉得地基还差一口气。先补清主角想要什么、第一卷冲突是什么、前三章怎么转折,再让编辑部开写。"
    if (/json|parse|schema|validator|required|missing|invalid|字段|格式/i.test(msg)) {
      return "复审官没拿到足够清楚的故事施工图。先补三样:主角想要什么、第一卷核心冲突是什么、每三章靠什么转折。"
    }
    if (/timeout|timed out|econn|network|fetch|abort|超时|网络|连接/i.test(msg)) {
      return "复审官还没等到完整地基结果。可以先去作品列表看进度;如果确实停住,再进路线图补大纲或重试。"
    }
    return `复审官的意见是:${msg}。先补清主角动机、核心冲突和第一卷转折,补够了再开写正文。`
  }

  // stalled / needs-foundation / error 三态共用的补救按钮组(文案/主按钮各态微调)。
  // 用自绘 div 而非 DialogFooter:DialogFooter 自带 sm:justify-end,会跟两端对齐布局打架。
  const remediationActions = (variant: "stalled" | "needs-foundation" | "error") => (
    <div className="nb-actions">
      <div className="nb-actions-secondary">
        <button
          type="button"
          className="nb-btn ghost"
          onClick={() => goTo("/books")}
        >
          <ListChecks size={14} /> 去作品列表看进度
        </button>
        {createdBookId && (
          <button
            type="button"
            className={`nb-btn ghost ${confirmDelete ? "danger" : "danger-quiet"}`}
            onClick={handleDeleteDraft}
            disabled={deleting}
          >
            {deleting ? <Loader2 size={14} className="nb-spin" /> : <Trash2 size={14} />}
            {confirmDelete ? "确认删除半成品" : "删除半成品"}
          </button>
        )}
      </div>
      <div className="nb-actions-primary">
        <button type="button" className="nb-btn ghost" onClick={() => setStep("form")}>
          返回修改
        </button>
        {variant === "needs-foundation" ? (
          createdBookId && (
            <button type="button" className="nb-btn primary" onClick={goFixFoundation}>
              <Layers size={14} /> 去补地基
            </button>
          )
        ) : (
          <button
            type="button"
            className="nb-btn primary"
            onClick={() => handleCreate(new Event("submit") as unknown as React.FormEvent)}
          >
            重试
          </button>
        )}
      </div>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="nb-dialog">
        <DialogHeader>
          <DialogTitle>新建一部作品</DialogTitle>
          <DialogDescription>
            填一段你想写的样子,编辑部会自动搭好故事框架、角色矩阵、章节地图,几十秒后你就能开写。
          </DialogDescription>
        </DialogHeader>

        {step === "form" && (
          <form onSubmit={handleCreate} className="nb-form">
            <div className="nb-row">
              <label className="nb-field nb-field-wide">
                <span className="nb-lab">书名 <em className="nb-req">*</em></span>
                <input
                  autoFocus
                  className="nb-input"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="给你的作品起个名字…"
                  maxLength={64}
                />
              </label>
              <div className="nb-field">
                <span className="nb-lab">题材</span>
                <div className="nb-combo" ref={genreRef}>
                  <input
                    className="nb-input"
                    value={draft.genre}
                    onChange={(e) => setDraft({ ...draft, genre: e.target.value })}
                    onFocus={() => setGenreOpen(true)}
                    placeholder="都市 / 科幻 / 仙侠 …"
                  />
                  <button
                    type="button"
                    className={`nb-combo-toggle${genreOpen ? " open" : ""}`}
                    aria-label="选择题材"
                    aria-expanded={genreOpen}
                    onClick={() => setGenreOpen((o) => !o)}
                  >
                    <ChevronDown size={14} />
                  </button>
                  {genreOpen && (
                    <div className="nb-combo-menu" role="listbox">
                      {GENRE_OPTIONS.map((g) => (
                        <button
                          type="button"
                          key={g}
                          role="option"
                          aria-selected={draft.genre === g}
                          className={`nb-combo-opt${draft.genre === g ? " sel" : ""}`}
                          onClick={() => { setDraft({ ...draft, genre: g }); setGenreOpen(false) }}
                        >
                          <span>{g}</span>
                          {draft.genre === g && <Check size={13} aria-hidden />}
                        </button>
                      ))}
                      <div className="nb-combo-tip">没有合适的?直接在上面输入框里自己写。</div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <label className="nb-field">
              <span className="nb-lab">想写的样子 / 一段话设定</span>
              <textarea
                className="nb-input nb-textarea"
                rows={5}
                value={draft.brief}
                onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
                placeholder="例:近未来的海滨城市,女主角是能「听见」老建筑记忆的修复师,接下一桩旧剧院翻新案,逐渐卷入二十年前的失踪旧案。基调温暖带悬疑,节奏每章一个小发现、三章一个转折。"
              />
              <span className="nb-hint">一句话灵感要写出具体的人、正在发生的事、能感到的基调;别只写主题词。</span>
            </label>

            {/* 一句话灵感提示卡 — 一句钩子 + 超短好/坏对比 + 链到完整指南。最小侵入,不动提交逻辑。 */}
            <aside className="nb-guidetip" aria-label="一句话灵感写法提示">
              <div className="nb-guidetip-head">
                <Lightbulb size={13} className="nb-guidetip-ico" />
                <span className="nb-guidetip-hook">一句话决定整本书 —— 这样写,编辑部更懂你</span>
              </div>
              <ul className="nb-guidetip-rows">
                <li className="nb-guidetip-row">
                  <span className="nb-guidetip-bad">关于成长与救赎的史诗</span>
                  <ArrowRight size={11} className="nb-guidetip-arrow" />
                  <span className="nb-guidetip-good">能「听见」老建筑记忆的修复师,接下一桩旧剧院翻新案</span>
                </li>
                <li className="nb-guidetip-row">
                  <span className="nb-guidetip-bad">都市爽文,爽就完了</span>
                  <ArrowRight size={11} className="nb-guidetip-arrow" />
                  <span className="nb-guidetip-good">破产的游戏制作人靠预判算法翻身,每场发布会实时打脸</span>
                </li>
                <li className="nb-guidetip-row">
                  <span className="nb-guidetip-bad">要好看,要有深度</span>
                  <ArrowRight size={11} className="nb-guidetip-arrow" />
                  <span className="nb-guidetip-good">克制内伤式的悲;每卷一个身份揭穿;不要圣母</span>
                </li>
              </ul>
              <Link
                href="/guide"
                className="nb-guidetip-link"
                onClick={() => onOpenChange(false)}
              >
                查看完整创作指南
                <ArrowRight size={12} />
              </Link>
            </aside>

            {/* 上传文件 — 别的模型/手写的设定 .md / .txt 多文件,内容拼到 brief */}
            <div className="nb-field">
              <span className="nb-lab">
                <FileText size={12} style={{ display: "inline", marginRight: 4, verticalAlign: "-2px" }} />
                参考文件(可选,可多选)
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt,.text,text/markdown,text/plain"
                multiple
                onChange={handleFilePick}
                style={{ display: "none" }}
              />
              <div className="nb-upload-row">
                <button
                  type="button"
                  className="nb-btn ghost nb-upload-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={13} /> 选择文件
                </button>
                <span className="nb-upload-hint">
                  支持 .md / .markdown / .txt;别的模型先写的大纲/世界观/章节直接拖进来,跟设定一起喂给 Architect
                </span>
              </div>
              {uploads.length > 0 && (
                <ul className="nb-upload-list">
                  {uploads.map((u, i) => (
                    <li key={`${u.name}-${i}`} className="nb-upload-chip">
                      <FileText size={11} className="nb-upload-icon" />
                      <span className="nb-upload-name" title={u.name}>{u.name}</span>
                      <span className="nb-upload-size">
                        {u.content.length >= 1000
                          ? `${(u.content.length / 1000).toFixed(1)}k 字`
                          : `${u.content.length} 字`}
                      </span>
                      <button
                        type="button"
                        className="nb-upload-rm"
                        onClick={() => removeUpload(i)}
                        title="移除"
                        aria-label={`移除 ${u.name}`}
                      >
                        <X size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="nb-row">
              <label className="nb-field">
                <span className="nb-lab">单章字数</span>
                <input
                  type="number" min={500} max={20000} step={100}
                  className="nb-input nb-num"
                  value={draft.chapterWordCount}
                  onChange={(e) => setDraft({ ...draft, chapterWordCount: Number(e.target.value) || 3000 })}
                />
              </label>
              <label className="nb-field">
                <span className="nb-lab">计划章数</span>
                <input
                  type="number" min={1} max={2000} step={1}
                  className="nb-input nb-num"
                  value={draft.targetChapters}
                  onChange={(e) => setDraft({ ...draft, targetChapters: Number(e.target.value) || 120 })}
                />
              </label>
              <label className="nb-field">
                <span className="nb-lab">首发平台</span>
                <select
                  className="nb-input"
                  value={draft.platform}
                  onChange={(e) => setDraft({ ...draft, platform: e.target.value })}
                >
                  <option value="fanqie">番茄</option>
                  <option value="qidian">起点</option>
                  <option value="zongheng">纵横</option>
                  <option value="changjuan">长卷自留</option>
                </select>
              </label>
            </div>

            <DialogFooter>
              <button type="button" className="nb-btn ghost" onClick={close}>取消</button>
              <button type="submit" className="nb-btn primary">
                <Sparkles size={14} /> 开建并自动起稿
              </button>
            </DialogFooter>
          </form>
        )}

        {step === "running" && (
          <div className="nb-progress">
            <div className="nb-title-row">
              <Loader2 className="nb-spin" size={16} />
              <span><b>正在为《{draft.title}》搭骨架</b> · {statusSnap?.stage || "等待后端响应"}</span>
            </div>
            <ol className="nb-steps">
              {SETUP_STEPS.map((s, i) => {
                const cls = i < activeStepIdx ? "done" : i === activeStepIdx ? "active" : "pending"
                return (
                  <li key={s.id} className={`nb-step ${cls}`}>
                    <span className="nb-step-dot" aria-hidden />
                    <span className="nb-step-body">
                      <b>{s.label}</b>
                      <span className="nb-step-hint">{s.hint}</span>
                    </span>
                    <span className="nb-step-state">
                      {i < activeStepIdx ? "已完成" : i === activeStepIdx ? "进行中" : "等候"}
                    </span>
                  </li>
                )
              })}
            </ol>
            {(statusSnap?.agentLabel || statusSnap?.agent) && (
              <div className="nb-active">
                <span className="nb-active-dot" aria-hidden />
                <span>
                  <b>{statusSnap.agentLabel || statusSnap.agent}</b>
                  {" 正在 · "}
                  {statusSnap.preview || statusSnap.stage || "处理中"}
                </span>
              </div>
            )}
            {/* 关掉不丢 —— 明确告诉用户后台会继续,去哪看进度。 */}
            <p className="nb-foot-note">
              建书一般 30–90 秒。<b>可以直接关掉本窗</b> —— 建书会在后台继续,进度能在<b>作品列表</b>和左侧边栏看到,建好会在右下角提示。
            </p>
            <div className="nb-running-actions">
              <button type="button" className="nb-btn ghost" onClick={() => goTo("/books")}>
                <ListChecks size={14} /> 去作品列表看进度
              </button>
              <button
                type="button"
                className="nb-btn ghost danger-quiet"
                onClick={handleCancelCreate}
                disabled={!createdBookId || cancelling}
                title={createdBookId ? "停下建书,释放写锁" : "等后端返回作品后才能取消"}
              >
                {cancelling ? <Loader2 size={14} className="nb-spin" /> : <X size={14} />}
                取消建书
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="nb-done">
            <div className="nb-done-mark">✓</div>
            <h3>建好了</h3>
            <p>《{draft.title}》已经落库,故事框架 / 角色矩阵 / 章节地图都到位。点下方按钮去工作台开写。</p>
            <DialogFooter>
              <button type="button" className="nb-btn primary" onClick={close}>
                去工作台 →
              </button>
            </DialogFooter>
          </div>
        )}

        {/* 地基没过 —— 不是失败,是停在大纲等你补。主按钮给"去补地基"。 */}
        {step === "needs-foundation" && (
          <div className="nb-outcome">
            <div className="nb-outcome-head">
              <div className="nb-outcome-mark warn"><Layers size={20} /></div>
              <div className="nb-outcome-title">
                <h3>建书停在了补地基</h3>
                <p className="nb-outcome-sub">框架已起好,但复审官没让它直接开写正文。</p>
              </div>
            </div>
            <p className="nb-outcome-body">{foundationGuidance(errMsg)}</p>
            <p className="nb-outcome-note">
              草稿已保存在<b>作品列表</b>里(没切成当前作品)。去补地基会把它设为当前作品,带你进路线图补大纲、伏笔和人物动机,补够了再开写。
            </p>
            {remediationActions("needs-foundation")}
          </div>
        )}

        {/* 轮询超时 / 已取消 —— 都不是「失败」,用平静的 info 色,给清楚的下一步。 */}
        {step === "stalled" && (
          <div className="nb-outcome">
            <div className="nb-outcome-head">
              <div className={`nb-outcome-mark info${stalledKind === "cancelled" ? " stopped" : ""}`}>
                {stalledKind === "cancelled" ? <X size={20} /> : <Loader2 size={20} />}
              </div>
              <div className="nb-outcome-title">
                <h3>{stalledKind === "cancelled" ? "已取消建书" : "还没等到结果"}</h3>
                <p className="nb-outcome-sub">
                  {stalledKind === "cancelled"
                    ? "建书已停下,半成品草稿保留在作品列表里。"
                    : "前端停止等待,但后台不一定停了。"}
                </p>
              </div>
            </div>
            <p className="nb-outcome-body">{errMsg || "建书已停下。"}</p>
            <p className="nb-outcome-note">
              {stalledKind === "cancelled" ? (
                <>不想留草稿就<b>删除半成品</b>;想接着弄,可以<b>去补地基</b>补大纲,或直接<b>重试</b>重新起稿。</>
              ) : (
                <>建议先<b>去作品列表看进度</b> —— 如果还在跑,过会儿就好了。确实卡住了,可以删掉半成品重来,或去补地基继续。</>
              )}
            </p>
            {remediationActions("stalled")}
          </div>
        )}

        {/* 真失败(异常 / 后端报错)。 */}
        {step === "error" && (
          <div className="nb-outcome">
            <div className="nb-outcome-head">
              <div className="nb-outcome-mark err"><AlertTriangle size={20} /></div>
              <div className="nb-outcome-title">
                <h3>建书没成</h3>
                <p className="nb-outcome-sub">下面是后端给的原因,改完可以直接重试。</p>
              </div>
            </div>
            <pre className="nb-err-msg">{errMsg || "未知错误"}</pre>
            {createdBookId && (
              <p className="nb-outcome-note">
                后端已经落了一本半成品在<b>作品列表</b>。重试会再建一本新的,所以如果不想留残稿,记得先删掉它。
              </p>
            )}
            {remediationActions("error")}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
