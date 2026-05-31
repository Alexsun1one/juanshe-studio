"use client"

import * as React from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  ArrowUpRight,
  AtSign,
  BookText,
  Copy,
  FileText,
  Gauge,
  Hash,
  Layers,
  Loader2,
  Mail,
  Maximize2,
  MessageCircle,
  Newspaper,
  NotebookPen,
  Search,
  Send,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  fetchChapters,
  fetchContentDrafts,
  deleteContentDraft,
  type ContentDraft,
} from "@/lib/api/client"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import { EarnPath } from "@/components/workbench/earn-path"
import { stripMarkdown } from "@/lib/utils"
import "./library.css"

type Chapter = Awaited<ReturnType<typeof fetchChapters>>[number]

// 发布门槛:成品分≥此值视为「可直接发布」(与洞察/质量门槛口径一致),作为可变现就绪信号
const READY_SCORE = 85
const PLATFORMS = [
  { id: "all", label: "全部" },
  { id: "wechat_article", label: "公众号" },
  { id: "xiaohongshu_note", label: "小红书" },
  { id: "zhihu_answer", label: "知乎" },
  { id: "x_thread", label: "X / Twitter" },
  { id: "newsletter", label: "Newsletter" },
] as const
const CH_STATE: Record<string, string> = { published: "已发布", done: "完成", review: "审校", writing: "写作中", queued: "排队", draft: "草稿" }
// 章节状态 → 设计系统 pill 的 data-state(语义色只走状态,避免裸文字/杂色);未知回落到草稿档
const CH_PILL: Record<string, string> = { published: "published", done: "done", review: "running", writing: "running", queued: "queued", draft: "draft" }

// 每个目标平台一个语义化 lucide 图标,让列表/分布一眼可辨(无对应时回落到通用图标)
function platIcon(id: string): React.ReactNode {
  switch (id) {
    case "wechat_article": return <MessageCircle size={13} />
    case "xiaohongshu_note": return <NotebookPen size={13} />
    case "zhihu_answer": return <Hash size={13} />
    case "x_thread": return <AtSign size={13} />
    case "newsletter": return <Mail size={13} />
    default: return <Newspaper size={13} />
  }
}

export default function LibraryPage() {
  const { bookId, books, booksLoading } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const activeTitle = typeof active?.title === "string" ? active.title : active?.title?.zh

  const [tab, setTab] = React.useState<"drafts" | "chapters">("drafts")
  const [drafts, setDrafts] = React.useState<ContentDraft[]>([])
  const [draftsLoading, setDraftsLoading] = React.useState(true)
  const [plat, setPlat] = React.useState("all")
  const [q, setQ] = React.useState("")
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [fullView, setFullView] = React.useState<ContentDraft | null>(null)
  const [deleting, setDeleting] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<ContentDraft | null>(null)

  const [chapters, setChapters] = React.useState<Chapter[]>([])
  const [chaptersLoading, setChaptersLoading] = React.useState(false)

  const loadDrafts = React.useCallback(async () => {
    setDraftsLoading(true)
    try {
      const d = await fetchContentDrafts()
      setDrafts(Array.isArray(d.drafts) ? d.drafts : [])
    } catch {
      setDrafts([])
    } finally {
      setDraftsLoading(false)
    }
  }, [])

  React.useEffect(() => { void loadDrafts() }, [loadDrafts])
  React.useEffect(() => {
    if (!bookId) { setChapters([]); setChaptersLoading(false); return }
    let alive = true
    setChaptersLoading(true)
    fetchChapters(bookId)
      .then((c) => { if (alive) setChapters(Array.isArray(c) ? c : []) })
      .catch(() => { if (alive) setChapters([]) })
      .finally(() => { if (alive) setChaptersLoading(false) })
    return () => { alive = false }
  }, [bookId])

  const filtered = React.useMemo(() => {
    const kw = q.trim().toLowerCase()
    return drafts.filter((d) => (plat === "all" || d.contentType === plat) && (!kw || (d.title + d.brief + d.excerpt).toLowerCase().includes(kw)))
  }, [drafts, plat, q])

  const platformFilters = React.useMemo(() => {
    const known = new Set<string>(PLATFORMS.map((p) => p.id))
    const extras = drafts
      .filter((d) => d.contentType && !known.has(d.contentType))
      .reduce<Array<{ id: string; label: string }>>((acc, d) => {
        if (!acc.some((p) => p.id === d.contentType)) {
          acc.push({ id: d.contentType, label: d.platformLabel || d.contentType })
        }
        return acc
      }, [])
    return [...PLATFORMS, ...extras]
  }, [drafts])

  const platCount = (id: string) => id === "all" ? drafts.length : drafts.filter((d) => d.contentType === id).length
  const isFiltered = plat !== "all" || q.trim() !== ""
  const resetFilters = () => { setPlat("all"); setQ("") }

  const draftStats = React.useMemo(() => {
    const scored = drafts.map((d) => d.finalScore).filter((s): s is number => typeof s === "number")
    const platforms = new Set(drafts.map((d) => d.contentType).filter(Boolean))
    const totalChars = drafts.reduce((sum, d) => sum + (d.chars ?? 0), 0)
    const ready = drafts.filter((d) => typeof d.finalScore === "number" && d.finalScore >= READY_SCORE).length
    return {
      total: drafts.length,
      platforms: platforms.size,
      avg: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
      best: scored.length ? Math.max(...scored) : null,
      chars: totalChars,
      ready,
    }
  }, [drafts])

  const chapterStats = React.useMemo(() => {
    const words = chapters.reduce((sum, c) => sum + (c.words ?? 0), 0)
    const finished = chapters.filter((c) => c.status === "published" || c.status === "done").length
    return { total: chapters.length, finished, words }
  }, [chapters])

  // 平台分布(可变现视角):每个目标平台有几篇成品、是否已覆盖。已覆盖=可直接铺;未覆盖=待开拓的渠道
  const platformCoverage = React.useMemo(() => {
    return PLATFORMS.filter((p) => p.id !== "all").map((p) => ({ ...p, count: platCount(p.id) }))
  }, [drafts]) // eslint-disable-line react-hooks/exhaustive-deps

  // 待打磨成品(分数已出但未达发布标准):从已取数据派生,给 Inspector 折叠卡用,不新增请求/不造数据
  const toPolish = React.useMemo(
    () => drafts
      .filter((d) => typeof d.finalScore === "number" && d.finalScore < READY_SCORE)
      .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0)),
    [drafts],
  )

  const fmtChars = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}w` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

  const onCopy = async (d: ContentDraft) => {
    try {
      await navigator.clipboard.writeText(d.markdown || "")
      toast.success("已复制 Markdown", { description: "可直接粘贴到平台后台发布。" })
    } catch {
      toast.error("复制失败,请手动选择内容复制")
    }
  }
  const confirmDelete = async () => {
    const d = deleteTarget
    if (!d) return
    setDeleting(d.id)
    try {
      await deleteContentDraft(d.id)
      setDrafts((prev) => prev.filter((x) => x.id !== d.id))
      if (openId === d.id) setOpenId(null)
      setDeleteTarget(null)
      toast.success("已删除")
    } catch (e) {
      toast.error(`删除失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeleting(null)
    }
  }

  if (!booksLoading && !bookId && !draftsLoading && drafts.length === 0) {
    return <CjPlaceholder title="内容库" sub="还没有任何产出。去「多平台创作」生成成品,或在「章节编辑」写小说,这里会统一汇总成可发布的资产。" />
  }

  const readyShare = draftStats.total ? Math.round((draftStats.ready / draftStats.total) * 100) : 0
  const chapterPct = chapterStats.total ? Math.round((chapterStats.finished / chapterStats.total) * 100) : 0

  return (
    <div className="cj-screen cj-library">
      {/* ── 顶部工作条:像素 + 标题 + 变现路径 + 可变现下一步;下挂一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead lib-head">
        <div className="lib-headline">
          <PixelBadge kind="library" size={44} className="lib-hero-pixel" ariaLabel="内容库 · 成品资产中心" />
          <div className="lib-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">内容库</h1>
              <span className="lib-hero-tag">成品资产中心</span>
            </div>
            <div className="lib-headline-sub">
              <EarnPath current="asset" />
            </div>
          </div>
          <div className="lib-head-act" role="group" aria-label="可变现下一步">
            {tab === "drafts" ? (
              <>
                <Link href="/platform-export" className="lib-cta primary"><Send size={13} /> 去排版导出</Link>
                <Link href="/compose" className="lib-cta"><Wand2 size={13} /> 多平台创作</Link>
              </>
            ) : (
              <>
                <Link href="/publish" className="lib-cta primary"><Send size={13} /> 去发布</Link>
                <Link href="/editor" className="lib-cta"><FileText size={13} /> 章节编辑</Link>
              </>
            )}
          </div>
        </div>

        {tab === "drafts" ? (
          <div className="lib-kpis" role="group" aria-label="成品概览">
            <KpiChip label="多平台成品" value={draftStats.total} unit="篇" tone="brand" />
            <KpiChip label="覆盖平台" value={draftStats.platforms} unit="个" tone="info" hint="已铺过成品的目标平台数" />
            <KpiChip
              label="已达发布标准"
              value={draftStats.ready}
              unit="篇"
              tone={draftStats.ready > 0 ? "ok" : "neutral"}
              hint={`成品分 ≥ ${READY_SCORE} 即可直接发布`}
              sub={<StatLine items={[{ n: `${readyShare}%`, label: "占比", tone: draftStats.ready > 0 ? "ok" : "neutral" }]} />}
            />
            <KpiChip label="最高分" value={draftStats.best ?? "—"} unit={draftStats.best != null ? "分" : undefined} tone="amber" hint="所有成品里的最高成品分" />
            <KpiChip label="累计字数" value={fmtChars(draftStats.chars)} unit="字" tone="neutral" />
          </div>
        ) : (
          <div className="lib-kpis" role="group" aria-label="章节概览">
            <KpiChip label="当前作品" value={active ? (activeTitle ?? "—") : "未选择"} tone="brand" hint={active ? "顶栏可切换作品" : "在顶栏切换作品后查看其章节资产"} />
            <KpiChip label="章节总数" value={chapterStats.total} unit="章" tone="info" />
            <KpiChip
              label="已完成"
              value={chapterStats.finished}
              unit="章"
              tone={chapterStats.finished > 0 ? "ok" : "neutral"}
              sub={<StatLine items={[{ n: `${chapterPct}%`, label: "占比", tone: chapterStats.finished > 0 ? "ok" : "neutral" }]} />}
            />
            <KpiChip label="累计成稿" value={fmtChars(chapterStats.words)} unit="字" tone="amber" />
          </div>
        )}

        <div className="lib-tabs">
          <button type="button" className={`lib-tab${tab === "drafts" ? " on" : ""}`} onClick={() => setTab("drafts")}><Newspaper size={14} /> 多平台成品 <span className="c">{drafts.length}</span></button>
          <button type="button" className={`lib-tab${tab === "chapters" ? " on" : ""}`} onClick={() => setTab("chapters")}><FileText size={14} /> 小说章节 <span className="c">{chapters.length}</span></button>
        </div>
      </header>

      {/* ── 主体:成品/章节列表(主区,pane 内滚) + 资产概览(Inspector)── */}
      <div className="cj-screen-body lib-body">
        <div className="cj-mainpane lib-mainpane">
          {tab === "drafts" ? (
            <>
              <div className="lib-mainpane-head">
                <span className="lib-mainpane-title"><Layers size={14} /> 多平台成品</span>
                <div className="lib-count">
                  {!draftsLoading && drafts.length > 0 && (
                    <>
                      {isFiltered ? <><b>{filtered.length}</b> / 共 {drafts.length} 篇</> : <>共 <b>{drafts.length}</b> 篇成品</>}
                      {isFiltered && <button type="button" className="lib-count-reset" onClick={resetFilters}>重置筛选</button>}
                    </>
                  )}
                </div>
                <div className="lib-search">
                  <Search size={14} />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题 / 选题…" />
                  {q && (
                    <button type="button" className="lib-search-clear" title="清除搜索" aria-label="清除搜索" onClick={() => setQ("")}><X size={13} /></button>
                  )}
                </div>
              </div>

              {/* 平台分布(可变现地图)+ 筛选合一:每平台一根小竖量条,空缺=待开拓渠道。点选即按平台筛选。 */}
              {!draftsLoading && drafts.length > 0 && (
                <div className="lib-cover" role="group" aria-label="平台分布与筛选">
                  <button type="button" className={`lib-cover-all${plat === "all" ? " on" : ""}`} onClick={() => setPlat("all")} aria-pressed={plat === "all"}>
                    <Layers size={13} /> 全部 <span className="n">{drafts.length}</span>
                  </button>
                  <div className="lib-cover-track">
                    {platformCoverage.map((p) => {
                      const has = p.count > 0
                      const w = draftStats.total ? Math.max(has ? 8 : 0, Math.round((p.count / draftStats.total) * 100)) : 0
                      return (
                        <button
                          type="button"
                          key={p.id}
                          className={`lib-cover-item${plat === p.id ? " on" : ""}${has ? "" : " empty"}`}
                          onClick={() => setPlat(p.id)}
                          aria-pressed={plat === p.id}
                          title={has ? `${p.label} · ${p.count} 篇` : `${p.label} · 暂无成品,去创作可开拓此渠道`}
                        >
                          <span className="lib-cover-top">
                            <span className="lbl"><span className="lib-cover-ic">{platIcon(p.id)}</span>{p.label}</span>
                            <span className="n">{has ? p.count : "—"}</span>
                          </span>
                          <span className="lib-cover-bar"><span className="fill" style={{ width: `${w}%` }} /></span>
                        </button>
                      )
                    })}
                    {platformFilters.filter((p) => !PLATFORMS.some((k) => k.id === p.id)).map((p) => (
                      <button type="button" key={p.id} className={`lib-cover-item${plat === p.id ? " on" : ""}`} onClick={() => setPlat(p.id)} aria-pressed={plat === p.id} title={`${p.label} · ${platCount(p.id)} 篇`}>
                        <span className="lib-cover-top">
                          <span className="lbl"><span className="lib-cover-ic">{platIcon(p.id)}</span>{p.label}</span>
                          <span className="n">{platCount(p.id)}</span>
                        </span>
                        <span className="lib-cover-bar"><span className="fill" style={{ width: `${draftStats.total ? Math.max(8, Math.round((platCount(p.id) / draftStats.total) * 100)) : 0}%` }} /></span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="cj-pane-scroll lib-pane-scroll">
                {draftsLoading ? (
                  <div className="lib-list">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="skel" style={{ height: 56, borderRadius: "var(--r-md)" }} />
                    ))}
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="lib-empty">
                    {drafts.length === 0 ? (
                      <>
                        <Sparkles size={16} />
                        <span>还没有多平台成品。去「多平台创作」把一个选题一次产出成多平台成品资产。</span>
                        <Link href="/compose" className="lib-empty-cta"><Wand2 size={13} /> 去创作</Link>
                      </>
                    ) : (
                      <>
                        <span>没有匹配的成品。</span>
                        {isFiltered && <button type="button" className="lib-empty-reset" onClick={resetFilters}>重置筛选</button>}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="lib-list">
                    {filtered.map((d) => {
                      const ready = typeof d.finalScore === "number" && d.finalScore >= READY_SCORE
                      return (
                        <div className={`lib-row${openId === d.id ? " open" : ""}`} key={d.id}>
                          <div className="lib-row-line">
                            <button type="button" className="lib-row-main" onClick={() => setOpenId(openId === d.id ? null : d.id)} aria-expanded={openId === d.id}>
                              <span className="lib-plat"><span className="lib-plat-ic">{platIcon(d.contentType)}</span>{d.platformLabel}</span>
                              <span className="lib-title">{d.title || "(无标题)"}</span>
                              {d.revised && <span className="lib-flag" title="已经过改稿打磨"><Sparkles size={10} /> 已精修</span>}
                              <span className="lib-meta">{d.chars ?? 0} 字{d.createdAt ? ` · ${new Date(d.createdAt).toLocaleDateString("zh-CN")}` : ""}</span>
                              {typeof d.finalScore === "number" && (
                                <span className={`lib-score${ready ? " ready" : ""}`} title={ready ? "已达发布标准" : "建议打磨后再发布"}>
                                  {ready && <span className="lib-score-dot" aria-hidden />}{d.finalScore}
                                </span>
                              )}
                            </button>
                            <span className="lib-acts">
                              <Link href="/platform-export" className="ic" title="去排版导出 / 发布" aria-label="去排版导出"><ArrowUpRight size={15} /></Link>
                              <button type="button" className="ic" title="复制 Markdown" onClick={() => void onCopy(d)}><Copy size={14} /></button>
                              <button type="button" className="ic danger" title="删除" disabled={deleting === d.id} onClick={() => setDeleteTarget(d)}>{deleting === d.id ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}</button>
                            </span>
                          </div>
                          {openId === d.id && (
                            <div className="lib-preview">
                              <div className="lib-preview-text">{stripMarkdown(d.markdown || d.excerpt || "") || "(空)"}</div>
                              <div className="lib-preview-foot">
                                <button type="button" className="lib-fulltext ghost" onClick={() => setFullView(d)}><Maximize2 size={13} /> 查看全文</button>
                                <button type="button" className="lib-fulltext ghost" onClick={() => void onCopy(d)}><Copy size={13} /> 复制全文</button>
                                <Link href="/platform-export" className="lib-fulltext"><Send size={13} /> 去排版导出</Link>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="lib-mainpane-head">
                <span className="lib-mainpane-title"><BookText size={14} /> {active ? `《${activeTitle ?? "—"}》` : "未选择作品"}</span>
                {!!chapters.length && (
                  <StatLine
                    className="lib-mainpane-stat"
                    items={[
                      { n: chapters.length, label: "章" },
                      { n: chapterStats.finished, label: "完成", tone: "ok" },
                      { n: fmtChars(chapterStats.words), label: "字" },
                    ]}
                  />
                )}
              </div>
              <div className="cj-pane-scroll lib-pane-scroll">
                {chaptersLoading && chapters.length === 0 ? (
                  <div className="lib-list">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="skel" style={{ height: 52, borderRadius: "var(--r-lg)" }} />
                    ))}
                  </div>
                ) : chapters.length === 0 ? (
                  <div className="lib-empty">
                    <FileText size={16} />
                    {bookId ? (
                      <>
                        <span>本作品还没有章节。去「章节编辑」开写,成稿会在这里汇总成可发布资产。</span>
                        <Link href="/editor" className="lib-empty-cta"><FileText size={13} /> 去写章节</Link>
                      </>
                    ) : (
                      <span>未选择作品 — 在顶栏切换作品后查看其章节资产。</span>
                    )}
                  </div>
                ) : (
                  <div className="lib-list">
                    {[...chapters].sort((a, b) => b.num - a.num).map((c) => (
                      <Link className="lib-row chap" key={c.id} href={`/editor?chapter=${c.num}`}>
                        <div className="lib-row-main">
                          <span className="lib-num">{String(c.num).padStart(2, "0")}</span>
                          <span className="lib-title">{c.title.zh}</span>
                          <span className="lib-meta">{c.words ? `${c.words.toLocaleString()} 字` : "未写"}</span>
                          <span className="pill" data-state={CH_PILL[c.status] ?? "draft"}><span className="dot" />{CH_STATE[c.status] ?? c.status}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Inspector:资产概览(发布就绪进度 + 状态构成 + 待打磨 / 平台分布)── */}
        <aside className="cj-inspector lib-inspector">
          <div className="cj-pane-scroll lib-insp-scroll">
            {tab === "drafts" ? (
              <>
                <section className="card lib-overview">
                  <div className="card-head" style={{ marginBottom: 10 }}>
                    <div className="card-title lib-card-title"><Gauge size={14} /> 资产概览</div>
                    <Link href="/platform-export" className="card-action">去排版 →</Link>
                  </div>
                  {drafts.length > 0 ? (
                    <>
                      <div className="lib-meters">
                        <Meter
                          label="发布就绪率"
                          value={draftStats.ready}
                          max={Math.max(draftStats.total, 1)}
                          tone="ok"
                          showValue={false}
                        />
                        <div className="lib-meter-cap">
                          <span className="num">{draftStats.ready}</span>
                          <span className="lib-meter-of">/{draftStats.total} 篇达发布标准</span>
                          <span className="lib-meter-pct">{readyShare}%</span>
                        </div>
                        {draftStats.avg != null && (
                          <>
                            <Meter
                              label="平均成品分"
                              value={draftStats.avg}
                              max={100}
                              threshold={READY_SCORE}
                              tone="brand"
                              showValue={false}
                            />
                            <div className="lib-meter-cap">
                              <span className="num">{draftStats.avg}</span>
                              <span className="lib-meter-of">/ 100 · 门槛 {READY_SCORE}</span>
                              <span className="lib-meter-pct" data-tone={draftStats.avg >= READY_SCORE ? "ok" : "warn"}>{draftStats.avg >= READY_SCORE ? "达标" : "待打磨"}</span>
                            </div>
                          </>
                        )}
                      </div>
                      <div className="lib-statgrid">
                        <span className="lib-stat" data-tone="ok">
                          <b className="num">{draftStats.ready}</b>
                          <i>可发布</i>
                        </span>
                        <span className="lib-stat" data-tone="warn">
                          <b className="num">{toPolish.length}</b>
                          <i>待打磨</i>
                        </span>
                        <span className="lib-stat" data-tone="brand">
                          <b className="num">{draftStats.platforms}</b>
                          <i>覆盖平台</i>
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="lib-overview-empty">还没有成品,去「多平台创作」产出后这里会汇总资产状态。</div>
                  )}
                </section>

                {toPolish.length > 0 && (
                  <FoldCard
                    title="待打磨成品"
                    icon={<Wand2 size={14} />}
                    count={toPolish.length}
                    defaultOpen
                    scrollable={toPolish.length > 4}
                    maxHeight={220}
                  >
                    <div className="lib-mini-list">
                      {toPolish.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          className="lib-mini-row"
                          onClick={() => { setTab("drafts"); setOpenId(d.id); }}
                          title={`打磨到 ${READY_SCORE} 分即可发布 · ${d.platformLabel}`}
                        >
                          <span className="lib-mini-ic">{platIcon(d.contentType)}</span>
                          <span className="lib-mini-body">
                            <span className="lib-mini-title">{d.title || "(无标题)"}</span>
                            <span className="lib-mini-meta">{d.platformLabel} · {d.chars ?? 0} 字</span>
                          </span>
                          <span className="lib-mini-score" title="距发布标准还差一点">{d.finalScore}</span>
                        </button>
                      ))}
                    </div>
                  </FoldCard>
                )}

                {drafts.length > 0 && (
                  <FoldCard
                    title="平台分布"
                    icon={<Layers size={14} />}
                    count={`${draftStats.platforms}/${platformCoverage.length}`}
                    defaultOpen={toPolish.length === 0}
                    scrollable={platformCoverage.length > 5}
                    maxHeight={220}
                  >
                    <div className="lib-dist-list">
                      {platformCoverage.map((p) => {
                        const has = p.count > 0
                        const w = draftStats.total ? Math.max(has ? 6 : 0, Math.round((p.count / draftStats.total) * 100)) : 0
                        return (
                          <button
                            key={p.id}
                            type="button"
                            className={`lib-dist-row${plat === p.id ? " on" : ""}${has ? "" : " empty"}`}
                            onClick={() => setPlat(p.id)}
                            aria-pressed={plat === p.id}
                            title={has ? `${p.label} · ${p.count} 篇 · 点击筛选` : `${p.label} · 暂无成品,去创作可开拓此渠道`}
                          >
                            <span className="lib-dist-ic">{platIcon(p.id)}</span>
                            <span className="lib-dist-lbl">{p.label}</span>
                            <span className="lib-dist-bar"><span className="fill" style={{ width: `${w}%` }} /></span>
                            <span className="lib-dist-n">{has ? p.count : "—"}</span>
                          </button>
                        )
                      })}
                    </div>
                  </FoldCard>
                )}
              </>
            ) : (
              <>
                <section className="card lib-overview">
                  <div className="card-head" style={{ marginBottom: 10 }}>
                    <div className="card-title lib-card-title"><Gauge size={14} /> 作品资产概览</div>
                    <Link href="/publish" className="card-action">去发布 →</Link>
                  </div>
                  {active && chapters.length > 0 ? (
                    <>
                      <div className="lib-meters">
                        <Meter
                          label="完成进度"
                          value={chapterStats.finished}
                          max={Math.max(chapterStats.total, 1)}
                          tone="ok"
                          showValue={false}
                        />
                        <div className="lib-meter-cap">
                          <span className="num">{chapterStats.finished}</span>
                          <span className="lib-meter-of">/{chapterStats.total} 章已完成</span>
                          <span className="lib-meter-pct">{chapterPct}%</span>
                        </div>
                      </div>
                      <div className="lib-statgrid">
                        <span className="lib-stat" data-tone="brand">
                          <b className="num">{chapterStats.total}</b>
                          <i>章节</i>
                        </span>
                        <span className="lib-stat" data-tone="ok">
                          <b className="num">{chapterStats.finished}</b>
                          <i>已完成</i>
                        </span>
                        <span className="lib-stat" data-tone="neutral">
                          <b className="num">{fmtChars(chapterStats.words)}</b>
                          <i>累计字</i>
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="lib-overview-empty">
                      {active ? "本作品还没有章节,去「章节编辑」开写后这里会汇总成稿进度。" : "未选择作品 — 在顶栏切换作品后查看其章节资产。"}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </aside>
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这篇成品？</AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>
                此操作会从内容库删除这篇多平台成品,删除后不可撤销。确认前不会发起删除请求。
              </span>
              <span className="rounded-md border bg-muted/50 px-3 py-2 text-foreground">
                {deleteTarget?.platformLabel || "成品"} · {deleteTarget?.title || "(无标题)"}
                {typeof deleteTarget?.chars === "number" ? ` · ${deleteTarget.chars} 字` : ""}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={deleteTarget ? deleting === deleteTarget.id : false}>保留成品</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={deleteTarget ? deleting === deleteTarget.id : false}
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {deleteTarget && deleting === deleteTarget.id ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  删除中...
                </>
              ) : (
                "确认删除"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={fullView !== null} onOpenChange={(open) => { if (!open) setFullView(null) }}>
        <DialogContent className="cj-library-fulltext flex max-h-[82vh] flex-col gap-4 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate">{fullView?.title || "(无标题)"}</DialogTitle>
            <DialogDescription>
              {fullView?.platformLabel}
              {typeof fullView?.chars === "number" ? ` · ${fullView.chars} 字` : ""}
              {fullView?.createdAt ? ` · ${new Date(fullView.createdAt).toLocaleDateString("zh-CN")}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="lib-fulltext-body scroll-thin">{fullView ? stripMarkdown(fullView.markdown || fullView.excerpt || "") || "(空)" : ""}</div>
          {fullView && (
            <div className="lib-fulltext-acts">
              <button type="button" className="lib-fulltext ghost" onClick={() => void onCopy(fullView)}><Copy size={13} /> 复制 Markdown</button>
              <Link href="/platform-export" className="lib-fulltext"><Send size={13} /> 去排版导出</Link>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
