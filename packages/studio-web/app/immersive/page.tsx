"use client"

import * as React from "react"
import useSWR from "swr"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  BookOpen,
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

export default function ImmersivePage() {
  const router = useRouter()
  const { books, bookId } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const [locationReady, setLocationReady] = React.useState(false)
  const [requestedChapter, setRequestedChapter] = React.useState<number | null>(null)
  const { data: chapters } = useSWR(bookId ? ["chapters", bookId] : null, () => fetchChapters(bookId), soft)
  const requestedExists =
    locationReady && requestedChapter != null && (!chapters || chapters.some((chapter) => chapter.num === requestedChapter))
  const fallbackChapter = active?.currentChapter ?? chapters?.[0]?.num ?? 0
  const cur = locationReady ? (requestedExists ? requestedChapter : fallbackChapter) : 0
  const { data: ms, isLoading: msLoading } = useSWR(bookId && cur ? ["ms", bookId, cur] : null, () => fetchManuscript(bookId, cur), soft)
  const running = Boolean(active?.autoRunning)
  const chapterTitle = chapters?.find((chapter) => chapter.num === cur)?.title.zh
  const editorHref = cur ? `/editor?chapter=${cur}` : "/editor"

  React.useEffect(() => {
    setRequestedChapter(chapterFromLocation())
    setLocationReady(true)
  }, [])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") router.push(editorHref) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [editorHref, router])

  const paras = ms?.paragraphs ?? []
  const words = paras.reduce((s, p) => s + (p.zh?.replace(/\s/g, "").length ?? 0), 0)
  // 正文取数中(章节已定、尚未拿到段落且无缓存)→ 显示骨架,避免把「加载中」误显成「暂无正文」空态
  const bodyLoading = Boolean(bookId && cur) && msLoading && paras.length === 0

  // ── 展示派生(只用现有字段,不编造数据)──────────────────────────────────
  const chapterPct = Math.min(100, active?.currentChapterPct ? Math.round(active.currentChapterPct * 100) : 0)
  const plannedChapters = active?.plannedChapters || active?.chapterCount || 0
  const totalWords = active?.totalWords
  const bookTitle = active?.title.zh ?? "—"

  return (
    <div className="cj-immersive">
        {/* ── 顶部工作条:像素书签 + 书名/章节 + 状态 chip + 退出 ── */}
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
            {running ? "AI 写作中" : "沉浸阅读"}
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
          <button type="button" className="im-exit" onClick={() => router.push(editorHref)}>
            <X size={14} /> 退出 <span className="kbd">Esc</span>
          </button>
        </header>

        <div className="im-stage scroll-thin">
          <div className="im-paper">
            {paras.length ? (
              <>
                <div className="im-title">
                  <span className="im-title-kicker">
                    <Hash size={11} aria-hidden /> 第 {cur} 章
                  </span>
                  {chapterTitle ? <span className="im-title-name">{chapterTitle}</span> : null}
                </div>
                <div className="im-body">
                  {paras.map((p, i) => p.quote ? <p key={i}><span className="accent">{p.zh}</span></p> : <p key={i}>{p.zh}</p>)}
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

        {/* ── 底部状态条:本章进度 + 密集统计(字数/章节/全书进度)── */}
        <footer className="im-foot">
          <span className="im-foot-mode">
            <ScrollText size={13} aria-hidden /> 沉浸写作 · 宋体大字号
          </span>
          <div className="im-foot-progress">
            <span className="im-foot-label">本章</span>
            <div className="pbar"><i style={{ width: `${chapterPct}%` }} /></div>
            <span className="im-foot-pct tabular">{chapterPct}%</span>
          </div>
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
