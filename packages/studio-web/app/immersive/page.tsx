"use client"

import * as React from "react"
import useSWR, { useSWRConfig } from "swr"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ALargeSmall,
  ArrowDown,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Hash,
  Layers,
  Network,
  PenLine,
  ScrollText,
  Sparkles,
  Type,
  X,
} from "lucide-react"
import { fetchChapters, fetchManuscript } from "@/lib/api/client"
import {
  classifyParagraph,
  renderProse,
  useEntityDict,
  type EntityClick,
  type EntityDict,
} from "@/lib/prose-highlight"
import { useLiveRun } from "@/lib/use-live-run"
import { useTypewriter } from "@/lib/use-typewriter"
import { useWorkspace } from "@/lib/workspace-context"
import { PixelBadge } from "@/components/design/pixel-badge"
import "./immersive.css"

const soft = { shouldRetryOnError: false }

function chapterFromLocation() {
  const n = Number(new URLSearchParams(window.location.search).get("chapter"))
  return Number.isInteger(n) && n > 0 ? n : null
}

const fmtInt = (n: number | undefined | null) =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "0"

// ── 阅读偏好:字号/行宽/行高三档,localStorage 持久(全局偏好,不分书)────────
//    选择写入 .cj-immersive 的 --im-fs/--im-w/--im-lh,正文只动宋体尺寸,控件本身走 UI 字体
const PREFS_KEY = "im-read-prefs"
const FS_OPTS = [18, 20, 22] as const
const W_OPTS = [680, 760, 840] as const
const LH_OPTS = [1.9, 2.05, 2.2] as const
type ReadPrefs = { fs: number; w: number; lh: number }
const DEFAULT_PREFS: ReadPrefs = { fs: 20, w: 760, lh: 2.05 }

function loadPrefs(): ReadPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "") as Partial<ReadPrefs>
    return {
      fs: FS_OPTS.includes(p?.fs as (typeof FS_OPTS)[number]) ? (p.fs as number) : DEFAULT_PREFS.fs,
      w: W_OPTS.includes(p?.w as (typeof W_OPTS)[number]) ? (p.w as number) : DEFAULT_PREFS.w,
      lh: LH_OPTS.includes(p?.lh as (typeof LH_OPTS)[number]) ? (p.lh as number) : DEFAULT_PREFS.lh,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

/** 流式段落 —— React.memo:流式只在尾段追加,前面段 props 不变即整段跳过重分词与 span 重建,
 *  每 tick 成本从 O(全文) 降到 O(尾段);markdown 残留与定稿走同一套 classifyParagraph,绝不裸渲染。 */
const StreamPara = React.memo(function StreamPara({
  text,
  dict,
  prefix,
  onEntity,
  tail,
}: {
  text: string
  dict: EntityDict
  prefix: string
  onEntity: EntityClick
  tail: boolean
}) {
  const caret = tail ? <span className="type-caret" aria-hidden /> : null
  const para = classifyParagraph(text)
  if (para.type === "scene-break") return <div className="scene-break" aria-hidden>✦</div>
  if (para.type === "heading") return caret
  return (
    <p>
      {renderProse(para.text, dict, prefix, onEntity)}
      {caret}
    </p>
  )
})

export default function ImmersivePage() {
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const { books, bookId } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const [locationReady, setLocationReady] = React.useState(false)
  const [requestedChapter, setRequestedChapter] = React.useState<number | null>(null)
  const { data: chapters } = useSWR(bookId ? ["chapters", bookId] : null, () => fetchChapters(bookId), soft)

  // 实时流式:订阅本作品 agent 事件(共享 SSE),AI 写本书时正文活起来,与编辑器同一套已验证模式
  const live = useLiveRun(bookId)
  const typed = useTypewriter(live.text, live.active)
  // 未通过 ?chapter= 显式指定章时,自动跟随正在写的章(沉浸页没有「正在编辑」冲突,可放心跟);
  // 跟随值在收尾后保留,避免 active 熄灭瞬间跳回旧章。显式指定 URL 章节则始终尊重用户。
  const [followChapter, setFollowChapter] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (live.active && live.chapter) setFollowChapter(live.chapter)
  }, [live.active, live.chapter])

  const requestedExists =
    locationReady && requestedChapter != null && (!chapters || chapters.some((chapter) => chapter.num === requestedChapter))
  const fallbackChapter = followChapter ?? active?.currentChapter ?? chapters?.[0]?.num ?? 0
  const cur = locationReady ? (requestedExists ? requestedChapter : fallbackChapter) : 0
  const { data: ms, isLoading: msLoading } = useSWR(bookId && cur ? ["ms", bookId, cur] : null, () => fetchManuscript(bookId, cur), soft)
  const paras = ms?.paragraphs ?? []
  const hasBody = paras.length > 0
  // 流式渲染只在「正在写的就是当前章」时接管正文;刚收尾、定稿还没拉回来(全新章节缓存为空)
  // 时也先留住流式全文,避免闪一下「暂无正文」空态再跳成定稿
  const streaming = live.chapter === cur && live.text.length > 0 && (live.active || !hasBody)
  const running = Boolean(active?.autoRunning) || live.active
  const chapterTitle = chapters?.find((chapter) => chapter.num === cur)?.title.zh
  const editorHref = cur ? `/editor?chapter=${cur}` : "/editor"
  // 语义分色字典(story-graph 实体)+ 就地跳转:读到谁点谁,人物直达人物页、地点落知识图谱
  const dict = useEntityDict(bookId)
  const goEntity = React.useCallback(
    (name: string, kind: "person" | "place") =>
      router.push(kind === "person" ? `/characters/${encodeURIComponent(name)}` : "/graph"),
    [router],
  )

  React.useEffect(() => {
    setRequestedChapter(chapterFromLocation())
    setLocationReady(true)
  }, [])

  // ── 上一章/下一章:按 num 排序取前后项,←/→ 键同逻辑 ──────────────────────
  const sortedNums = React.useMemo(() => (chapters ?? []).map((c) => c.num).sort((a, b) => a - b), [chapters])
  const prevNum = React.useMemo(() => {
    const lower = sortedNums.filter((n) => n < cur)
    return lower.length ? lower[lower.length - 1] : null
  }, [sortedNums, cur])
  const nextNum = React.useMemo(() => sortedNums.find((n) => n > cur) ?? null, [sortedNums, cur])
  const nextTitle = nextNum != null ? chapters?.find((c) => c.num === nextNum)?.title.zh : undefined
  const goChapter = React.useCallback(
    (n: number) => {
      // replace 不污染历史栈,Esc 回编辑器的行为不变
      router.replace(`/immersive?chapter=${n}`)
      setRequestedChapter(n)
    },
    [router],
  )

  // ── 阅读偏好 ──────────────────────────────────────────────────────────────
  const [prefs, setPrefs] = React.useState<ReadPrefs>(DEFAULT_PREFS)
  React.useEffect(() => { setPrefs(loadPrefs()) }, [])
  const patchPrefs = (patch: Partial<ReadPrefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  const [prefsOpen, setPrefsOpen] = React.useState(false)
  const prefsRef = React.useRef<HTMLSpanElement>(null)
  React.useEffect(() => {
    if (!prefsOpen) return
    const onDown = (e: PointerEvent) => {
      if (prefsRef.current && !prefsRef.current.contains(e.target as Node)) setPrefsOpen(false)
    }
    window.addEventListener("pointerdown", onDown)
    return () => window.removeEventListener("pointerdown", onDown)
  }, [prefsOpen])

  // 键盘:Esc 先关偏好弹层再退出;←/→ 翻章(弹层打开时不抢)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (prefsOpen) setPrefsOpen(false)
        else router.push(editorHref)
        return
      }
      if (prefsOpen) return
      if (e.key === "ArrowLeft" && prevNum != null) goChapter(prevNum)
      else if (e.key === "ArrowRight" && nextNum != null) goChapter(nextNum)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [editorHref, router, prefsOpen, prevNum, nextNum, goChapter])

  const parasWords = paras.reduce((s, p) => s + (p.zh?.replace(/\s/g, "").length ?? 0), 0)
  // 流式中字数计实时累计(live.charCount 已剥脚手架),收尾后回到定稿统计
  const words = streaming ? live.charCount : parasWords
  // 正文取数中(章节已定、尚未拿到段落且无缓存)→ 显示骨架,避免把「加载中」误显成「暂无正文」空态
  const bodyLoading = Boolean(bookId && cur) && msLoading && !hasBody && !streaming
  const streamParas = React.useMemo(() => (streaming ? typed.split(/\n{2,}/) : []), [streaming, typed])

  // ── 滚动:礼貌钉底(贴底才跟随,上滚回读即解除)+ 阅读位置记忆 ─────────────
  const stageRef = React.useRef<HTMLDivElement>(null)
  const atBottomRef = React.useRef(true) // 距底 < 80px 视为贴底;在内容写入前采样,钉底只在贴底时执行
  const [following, setFollowing] = React.useState(true)
  const [readPct, setReadPct] = React.useState(0)
  const lastPosWrite = React.useRef(0)
  const posKey = bookId && cur ? `im-pos:${bookId}:${cur}` : null
  const restoredKey = React.useRef("")

  const onStageScroll = () => {
    const el = stageRef.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    const atBottom = max - el.scrollTop < 80
    atBottomRef.current = atBottom
    if (streaming) {
      // 流式中只维护跟随态,不记阅读位置(跟随模式优先)
      setFollowing(atBottom)
      return
    }
    const now = Date.now()
    if (now - lastPosWrite.current < 200) return // 节流 200ms
    lastPosWrite.current = now
    const pct = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 1
    setReadPct(pct)
    if (posKey) {
      try { sessionStorage.setItem(posKey, String(pct)) } catch { /* ignore */ }
    }
  }

  // 流式开启:默认进入跟随(专门进来看 AI 写)
  React.useEffect(() => {
    if (!streaming) return
    atBottomRef.current = true
    setFollowing(true)
    const el = stageRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [streaming])

  // 流式钉底:typed 每 ~24ms 增长,仅在用户仍贴底时跟到底,绝不打断回读
  React.useEffect(() => {
    if (!streaming) return
    const el = stageRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [typed, streaming])

  const jumpToBottom = () => {
    atBottomRef.current = true
    setFollowing(true)
    const el = stageRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // 一轮生成结束(active true→false):拉回定稿与章节列表;刚看完写完的章留在原地,不做位置恢复
  // (本 effect 必须声明在「位置恢复」之前:同一次提交里先标记 restoredKey,恢复才不会把人拽走)
  React.useEffect(() => {
    if (live.completedTick === 0 || !bookId || !cur) return
    if (live.chapter === cur && posKey) restoredKey.current = posKey
    mutate(["ms", bookId, cur])
    mutate(["chapters", bookId])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.completedTick])

  // 阅读位置恢复:进章时回到上次读到的位置(sessionStorage;流式中不恢复,跟随优先)
  React.useEffect(() => {
    if (!posKey || streaming || !hasBody) return
    if (restoredKey.current === posKey) {
      // 本章已恢复过 / 流式收尾原地接定稿:不动滚动,只把「读至」对齐到当前实际位置并落存
      requestAnimationFrame(() => {
        const el = stageRef.current
        if (!el) return
        const max = el.scrollHeight - el.clientHeight
        const pct = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 1
        setReadPct(pct)
        try { sessionStorage.setItem(posKey, String(pct)) } catch { /* ignore */ }
      })
      return
    }
    restoredKey.current = posKey
    let saved = NaN
    try { saved = Number(sessionStorage.getItem(posKey)) } catch { /* ignore */ }
    requestAnimationFrame(() => {
      const el = stageRef.current
      if (!el) return
      const max = el.scrollHeight - el.clientHeight
      const pct = Number.isFinite(saved) && saved > 0 ? Math.min(1, saved) : 0
      el.scrollTop = pct * Math.max(0, max)
      setReadPct(max > 0 ? pct : 1)
    })
  }, [posKey, streaming, hasBody])

  // ── 展示派生(只用现有字段,不编造数据)──────────────────────────────────
  const chapterPct = Math.min(100, active?.currentChapterPct ? Math.round(active.currentChapterPct * 100) : 0)
  const plannedChapters = active?.plannedChapters || active?.chapterCount || 0
  const totalWords = active?.totalWords
  const bookTitle = active?.title.zh ?? "—"

  const titleBlock = (
    <div className="im-title">
      <span className="im-title-kicker">
        <Hash size={11} aria-hidden /> 第 {cur} 章
      </span>
      {chapterTitle ? <span className="im-title-name">{chapterTitle}</span> : null}
    </div>
  )

  return (
    <div
      className="cj-immersive"
      style={{
        ["--im-fs" as string]: `${prefs.fs}px`,
        ["--im-w" as string]: `${prefs.w}px`,
        ["--im-lh" as string]: String(prefs.lh),
      }}
    >
        {/* ── 顶部工作条:像素书签 + 书名/章节 + 状态 chip + 阅读偏好 + 退出 ── */}
        <header className="im-top">
          <span className="im-mark" aria-hidden>
            <PixelBadge kind={running ? "workbench" : "editor"} size={30} />
          </span>
          <div className="im-headline">
            <span className="im-book">《{bookTitle}》</span>
            <span className="im-ch-line">
              <Hash size={12} className="im-ch-ico" aria-hidden />
              <strong className="im-ch-num">第 {cur || "—"} 章</strong>
              {chapterTitle ? <span className="im-ch-title">{chapterTitle}</span> : null}
            </span>
          </div>
          <span className={`im-status${running ? " is-running" : " is-idle"}`} role="status">
            <span className="im-pulse" aria-hidden />
            {streaming && live.agentName ? `${live.agentName}执笔中` : running ? "AI 写作中" : "沉浸阅读"}
          </span>
          {/* 本章实时指标(密集 token,克制不抢焦)*/}
          <div className="im-metrics" role="group" aria-label="本章指标">
            <span className="im-metric" title="本章字数">
              <Type size={12} className="im-metric-ico" aria-hidden />
              <b className="tabular">{fmtInt(words)}</b>
              <i>字</i>
            </span>
            {chapterPct > 0 ? (
              <span className="im-metric" title="本章进度">
                <PenLine size={12} className="im-metric-ico" aria-hidden />
                <b className="tabular">{chapterPct}</b>
                <i>%</i>
              </span>
            ) : null}
          </div>
          {/* 阅读偏好:字号/行宽/行高三档,持久到 localStorage */}
          <span className="im-prefs" ref={prefsRef}>
            <button
              type="button"
              className="im-pref-btn"
              aria-haspopup="dialog"
              aria-expanded={prefsOpen}
              title="阅读偏好(字号 / 行宽 / 行高)"
              onClick={() => setPrefsOpen((v) => !v)}
            >
              <ALargeSmall size={16} />
            </button>
            {prefsOpen ? (
              <div className="im-prefs-pop" role="dialog" aria-label="阅读偏好">
                <div className="im-pref-row">
                  <span className="im-pref-label">字号</span>
                  <div className="im-pref-seg" role="group" aria-label="字号">
                    {FS_OPTS.map((v) => (
                      <button key={v} type="button" className={v === prefs.fs ? "on" : ""} onClick={() => patchPrefs({ fs: v })}>
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="im-pref-row">
                  <span className="im-pref-label">行宽</span>
                  <div className="im-pref-seg" role="group" aria-label="行宽">
                    {W_OPTS.map((v, i) => (
                      <button key={v} type="button" className={v === prefs.w ? "on" : ""} onClick={() => patchPrefs({ w: v })}>
                        {["窄", "适中", "宽"][i]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="im-pref-row">
                  <span className="im-pref-label">行高</span>
                  <div className="im-pref-seg" role="group" aria-label="行高">
                    {LH_OPTS.map((v, i) => (
                      <button key={v} type="button" className={v === prefs.lh ? "on" : ""} onClick={() => patchPrefs({ lh: v })}>
                        {["紧凑", "适中", "宽松"][i]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </span>
          <button type="button" className="im-exit" onClick={() => router.push(editorHref)}>
            <X size={14} /> 退出 <span className="kbd">Esc</span>
          </button>
        </header>

        <div className="im-stage scroll-thin" ref={stageRef} onScroll={onStageScroll}>
          <div className="im-paper">
            {streaming ? (
              <>
                {titleBlock}
                {/* 流式正文:逐字追加 + 尾段光标(只在真正打字时闪),沿用剧场/编辑器的流式视觉语言 */}
                <div className="im-body im-body-live">
                  {streamParas.map((t, i) => (
                    <StreamPara
                      key={i}
                      text={t}
                      dict={dict}
                      prefix={`s${i}-`}
                      onEntity={goEntity}
                      tail={live.active && i === streamParas.length - 1}
                    />
                  ))}
                </div>
              </>
            ) : paras.length ? (
              <>
                {titleBlock}
                <div className="im-body">
                  {paras.map((p, i) => {
                    // markdown 残留清洗:`---` → 居中「✦」场景分隔符;重复章题行跳过(im-title 已显示)
                    const para = classifyParagraph(p.zh)
                    if (para.type === "scene-break") return <div key={i} className="scene-break" aria-hidden>✦</div>
                    if (para.type === "heading") return null
                    const body = renderProse(para.text, dict, `p${i}-`, goEntity)
                    return p.quote ? <p key={i}><span className="accent">{body}</span></p> : <p key={i}>{body}</p>
                  })}
                </div>
                {/* 读完顺势翻页:大号下一章 CTA;已是最新章则收一个安静的完结标 */}
                <div className="im-next">
                  {nextNum != null ? (
                    <button type="button" className="im-empty-cta im-next-cta" onClick={() => goChapter(nextNum)}>
                      下一章 · 第 {nextNum} 章{nextTitle ? `「${nextTitle}」` : ""} <ChevronRight size={15} />
                    </button>
                  ) : (
                    <span className="im-end-mark">已读到最新一章</span>
                  )}
                </div>
              </>
            ) : bodyLoading ? (
              <div className="im-loading" aria-busy aria-label="正文加载中">
                <div className="im-loading-title">
                  <span className="skel im-skel-kicker" />
                  <span className="skel im-skel-name" />
                </div>
                <div className="im-loading-body">
                  {[92, 100, 100, 78, 100, 96, 100, 64].map((w, i) => (
                    <span key={i} className="skel im-skel-line" style={{ width: `${w}%` }} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="im-empty">
                <span className="im-empty-mark" aria-hidden>
                  <PixelBadge kind="editor" size={48} />
                </span>
                <div className="im-empty-title">本章暂无正文</div>
                <div className="im-empty-desc">回到编辑器,让写手接着上一章往下写。</div>
                <Link href={editorHref} className="im-empty-cta">
                  <BookOpen size={14} /> 去编辑器创作
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* 流式中上滚回读会解除钉底;这颗 chip 一键回到追更位 */}
        {live.active && streaming && !following ? (
          <button type="button" className="im-follow" onClick={jumpToBottom}>
            <ArrowDown size={13} /> 跟随最新
          </button>
        ) : null}

        {/* ── 底部状态条:本章进度 + 阅读位置 + 密集统计 + 章节切换 ── */}
        <footer className="im-foot">
          <span className="im-foot-mode">
            <ScrollText size={13} aria-hidden /> 沉浸阅读 · 宋体 {prefs.fs}px
          </span>
          <div className="im-foot-progress">
            <span className="im-foot-label">本章</span>
            <div className="pbar"><i style={{ width: `${chapterPct}%` }} /></div>
            <span className="im-foot-pct tabular">{chapterPct}%</span>
          </div>
          {/* 阅读位置(滚动百分比,墨灰与 brand 色生成进度区分);流式跟随中不显示 */}
          {!streaming && hasBody ? (
            <div className="im-foot-progress im-foot-read" title="本章阅读位置">
              <span className="im-foot-label">读至</span>
              <div className="pbar"><i style={{ width: `${Math.round(readPct * 100)}%` }} /></div>
              <span className="im-foot-pct tabular">{Math.round(readPct * 100)}%</span>
            </div>
          ) : null}
          <div className="im-foot-stats" role="group" aria-label="作品统计">
            <span className="im-stat">
              <b className="tabular">{fmtInt(words)}</b><i>本章字</i>
            </span>
            {plannedChapters > 0 ? (
              <>
                <span className="im-stat-sep" aria-hidden />
                <span className="im-stat" title="已写 / 计划章节">
                  <b className="tabular">{cur || 0}</b>
                  <span className="im-stat-of">/ {plannedChapters}</span>
                  <i>章</i>
                </span>
              </>
            ) : null}
            {typeof totalWords === "number" && totalWords > 0 ? (
              <>
                <span className="im-stat-sep" aria-hidden />
                <span className="im-stat" title="全书累计字数">
                  <Layers size={11} className="im-stat-ico" aria-hidden />
                  <b className="tabular">{fmtInt(totalWords)}</b><i>全书字</i>
                </span>
              </>
            ) : null}
          </div>
          <div className="im-foot-nav" role="group" aria-label="章节切换">
            <button
              type="button"
              className="im-nav-btn"
              disabled={prevNum == null}
              onClick={() => prevNum != null && goChapter(prevNum)}
              title="上一章(←)"
            >
              <ChevronLeft size={13} /> 上一章
            </button>
            <button
              type="button"
              className="im-nav-btn"
              disabled={nextNum == null}
              onClick={() => nextNum != null && goChapter(nextNum)}
              title="下一章(→)"
            >
              下一章 <ChevronRight size={13} />
            </button>
          </div>
        </footer>

        <nav className="im-dock" aria-label="快速跳转">
          <Link href={editorHref} className="im-dock-link" title="编辑器" aria-label="返回章节编辑器"><BookOpen size={17} /></Link>
          <Link href="/outline" className="im-dock-link" title="大纲" aria-label="打开大纲与规划"><ScrollText size={17} /></Link>
          <Link href="/knowledge" className="im-dock-link" title="知识图谱" aria-label="打开知识与资产"><Network size={17} /></Link>
          <Link href="/compose" className="im-dock-link" title="AI 创作" aria-label="打开多平台创作"><Sparkles size={17} /></Link>
        </nav>
      </div>
  )
}
