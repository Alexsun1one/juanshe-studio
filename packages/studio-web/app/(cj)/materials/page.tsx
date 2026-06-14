"use client"

import * as React from "react"
import Link from "next/link"
import useSWR from "swr"
import {
  AlertCircle,
  Check,
  Clock,
  Copy,
  FileInput,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Music,
  Search,
  Video,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { fetchAssets } from "@/lib/api/client"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder, EmptyArt } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import "./materials.css"

type AssetItem = { id: string; name: { zh: string; en: string }; type: "doc" | "image" | "audio" | "video"; size?: number; updatedAt?: string }
const soft = { shouldRetryOnError: false }
const ICON = { doc: FileText, image: ImageIcon, audio: Music, video: Video }
const TYPE_LABEL = { doc: "文档", image: "图片", audio: "音频", video: "视频" }
const TYPE_TONE = { doc: "info", image: "brand", audio: "amber", video: "rose" } as const
const basename = (p: string) => p.split("/").pop() ?? p
const folderOf = (p: string) => (p.includes("/") ? p.split("/").slice(0, -1).join("/") : "根目录")
// 过滤掉内部流水线产物(状态/日志/草稿/复审/统计/恢复),素材库只展示真正的创作资料
const isInternalAsset = (p: string) => {
  const lower = p.toLowerCase()
  if (/(^|\/)(agent_assets|recovery|runs?|tasks?|telemetry|logs?|snapshots?|state|\.cache)\//.test(lower)) return true
  const b = basename(lower)
  if (/\.(json|jsonl|log|tmp|lock|bak)$/.test(b)) return true
  if (/^chapter-?\d+[.\-_]/.test(b)) return true
  if (/[.\-_](writer-draft|post-review|pre-review|review|audit|repair|stat|telemetry|state|snapshot)\b/.test(b)) return true
  if (/^(quality-reporter|puzzle|length-normalize|run-|task-|workflow-|last_status)/.test(b)) return true
  return false
}
const fmtSize = (n?: number) => (n == null ? "—" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const fmtDate = (s?: string) => { if (!s) return "—"; try { return new Date(s).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) } catch { return "—" } }
// 相对时间(克制):刚刚 / N 分钟 / N 小时 / N 天前,更久回落日期。纯展示,不编数据。
const relTime = (s?: string): string => {
  if (!s) return ""
  const t = new Date(s).getTime()
  if (!Number.isFinite(t)) return ""
  const diff = Date.now() - t
  if (diff < 0) return ""
  const min = Math.floor(diff / 60000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(t).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
}

export default function MaterialsPage() {
  const { books, bookId, booksLoading } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const { data, error } = useSWR(bookId ? ["assets", bookId] : null, () => fetchAssets(bookId) as Promise<AssetItem[]>, soft)
  const [q, setQ] = React.useState("")
  const [folder, setFolder] = React.useState("all")
  const [selected, setSelected] = React.useState<AssetItem | null>(null)

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="素材库" sub="本地工作区还没有作品,创建后这里会出现素材与资产文件。" />
  }

  const assets = (data ?? []).filter((a) => !isInternalAsset(a.name.zh))
  const folders = (() => {
    const m = new Map<string, number>()
    for (const a of assets) { const f = folderOf(a.name.zh); m.set(f, (m.get(f) ?? 0) + 1) }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  })()
  // 概览:总量 + 目录数 + 各类型分布(给 KPI 带 + Inspector 构成条用)
  const typeCount = { doc: 0, image: 0, audio: 0, video: 0 } as Record<AssetItem["type"], number>
  for (const a of assets) { if (a.type in typeCount) typeCount[a.type] += 1 }
  const folderCount = new Set(assets.map((a) => folderOf(a.name.zh))).size
  const typeBreakdown = (["doc", "image", "audio", "video"] as const).filter((t) => typeCount[t] > 0)
  const totalSize = assets.reduce((sum, a) => sum + (a.size ?? 0), 0)
  // 最近更新:从已取数据派生(不新增请求),按 updatedAt 排序给 Inspector 折叠卡用
  const recent = [...assets]
    .filter((a) => a.updatedAt)
    .sort((a, b) => new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime())
    .slice(0, 8)

  const filtered = assets.filter((a) => {
    if (folder !== "all" && folderOf(a.name.zh) !== folder) return false
    if (q && !a.name.zh.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })
  const copyPath = async (asset: AssetItem) => {
    try {
      await navigator.clipboard.writeText(asset.name.zh)
      toast.success("已复制素材路径")
    } catch {
      toast.error("复制失败,请手动选择路径复制")
    }
  }

  return (
    <div className="cj-screen cj-materials">
      {/* ── 顶部工作条:像素 + 标题 + 内联搜索 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead mt-head">
        <div className="mt-headline">
          <PixelBadge kind="materials" size={44} className="mt-hero-pixel" ariaLabel="素材库" />
          <div className="mt-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">素材库</h1>
            </div>
            <div className="page-sub">
              《{active?.title.zh ?? "—"}》的创作资料与资产文件 —— 文档、图片、音频、视频按目录归集,随用随取。
            </div>
          </div>
          <div className="mt-search">
            <Search size={14} />
            <input placeholder="搜索素材 / 文件名" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button type="button" className="mt-search-clear" onClick={() => setQ("")} aria-label="清除搜索">
                <X size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="mt-kpis" role="group" aria-label="素材概览">
          <KpiChip label="素材总数" value={assets.length} unit="项" tone="brand" />
          <KpiChip label="目录" value={folderCount} unit="个" tone="amber" />
          {(["doc", "image", "audio", "video"] as const).map((t) => (
            <KpiChip key={t} label={TYPE_LABEL[t]} value={typeCount[t]} unit="项" tone={TYPE_TONE[t]} />
          ))}
          <KpiChip label="占用空间" value={fmtSize(totalSize || undefined)} tone="neutral" />
        </div>
      </header>

      {/* ── 主体:素材清单(主区,pane 内滚)+ 资产概览(Inspector)── */}
      <div className="cj-screen-body mt-body">
        <div className="cj-mainpane mt-mainpane">
          <div className="mt-mainpane-head">
            <span className="mt-mainpane-title">素材清单</span>
            {folder !== "all" && (
              <span className="mt-scope"><Folder size={12} />{folder}</span>
            )}
            {data && (
              <StatLine
                className="mt-mainpane-stat"
                items={[
                  { n: filtered.length, label: "项" },
                  ...(q || folder !== "all" ? [{ n: assets.length, label: "总" } as const] : []),
                ]}
              />
            )}
          </div>
          <div className="cj-pane-scroll mt-pane-scroll">
            {error && !data && (
              <div className="empty empty-lg mt-empty">
                <span className="mt-empty-ico mt-empty-ico-err"><AlertCircle size={22} /></span>
                <div className="empty-title">素材列表没能加载出来</div>
                <div className="empty-desc">和本地工作区的连接出了点状况,稍候它会自动重连,或刷新页面再试。</div>
              </div>
            )}
            {!data && !error && (
              <div className="mt-rows">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="skel mt-skel-row" />)}
              </div>
            )}
            {data && filtered.length === 0 && (
              <div className="empty empty-lg mt-empty">
                {assets.length === 0 ? (
                  <>
                    <div className="mt-empty-art"><EmptyArt variant="materials" /></div>
                    <div className="empty-title">素材箱还没拆封</div>
                    <div className="empty-desc">导入参考资料、图片或设定文档后,它们会按目录汇集成这本书的可检索资产库。</div>
                    <div className="mt-empty-actions">
                      <Link href="/import" className="btn primary sm"><FileInput size={13} /> 去导入素材</Link>
                      <Link href="/editor?chapter=1" className="btn sm">先写第一章</Link>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="mt-empty-ico"><FolderOpen size={22} /></span>
                    <div className="empty-title">{q ? `没有匹配「${q}」的素材` : "这个目录暂时没有素材"}</div>
                    <div className="empty-desc">调整搜索词或切换右侧目录,创作资料会在这里汇集。</div>
                    {(q || folder !== "all") && (
                      <button type="button" className="btn sm" onClick={() => { setQ(""); setFolder("all") }}>
                        清除筛选
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {data && filtered.length > 0 && (
              <div className="mt-rows">
                {filtered.slice(0, 200).map((a) => {
                  const Icon = ICON[a.type] ?? FileText
                  return (
                    <button type="button" className="mt-row" key={a.id} title={a.name.zh} onClick={() => setSelected(a)}>
                      <span className={`mt-ico ${a.type}`}><Icon size={15} /></span>
                      <span className="mt-name">
                        <span className="nm">{basename(a.name.zh)}</span>
                        <span className="fd"><Folder size={10} />{folderOf(a.name.zh)}</span>
                      </span>
                      <span className={`mt-tag ${a.type}`}>{TYPE_LABEL[a.type] ?? a.type}</span>
                      <span className="mt-meta">{fmtSize(a.size)}</span>
                      <span className="mt-meta mt-date">{fmtDate(a.updatedAt)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Inspector:资产概览(类型构成)+ 目录导航 + 最近更新 ── */}
        <aside className="cj-inspector mt-inspector">
          <div className="cj-pane-scroll mt-insp-scroll">
            <section className="card mt-overview">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-title"><Layers size={14} /> 资产构成</div>
                <span className="mt-overview-total"><b className="num">{assets.length}</b> 项</span>
              </div>
              {assets.length > 0 ? (
                <>
                  <div className="mt-meters">
                    {typeBreakdown.map((t) => {
                      const Icon = ICON[t]
                      return (
                        <div className="mt-meter-row" key={t}>
                          <Meter
                            label={
                              <span className="mt-meter-label">
                                <span className={`mt-meter-dot ${t}`}><Icon size={11} /></span>
                                {TYPE_LABEL[t]}
                              </span>
                            }
                            value={typeCount[t]}
                            max={assets.length}
                            tone={TYPE_TONE[t]}
                            showValue={false}
                          />
                          <span className="mt-meter-val">
                            <b className="num">{typeCount[t]}</b>
                            <i>{Math.round((typeCount[t] / Math.max(assets.length, 1)) * 100)}%</i>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-overview-foot">
                    <span className="mt-of-cell"><b className="num">{folderCount}</b><i>目录</i></span>
                    <span className="mt-of-cell"><b className="num">{fmtSize(totalSize || undefined)}</b><i>占用</i></span>
                  </div>
                </>
              ) : (
                <div className="mt-overview-empty">还没有素材,创作资料会在这里汇集成可检索的资产库。</div>
              )}
            </section>

            <FoldCard
              title="目录"
              icon={<FolderOpen size={14} />}
              count={folderCount || folders.length}
              defaultOpen
              scrollable={folders.length > 7}
              maxHeight={236}
            >
              <div className="mt-nav">
                <button type="button" className={`mt-navi${folder === "all" ? " active" : ""}`} onClick={() => setFolder("all")}>
                  <Layers size={13} className="mt-navi-ico" />
                  <span className="fl">全部素材</span>
                  <span className="ct">{assets.length}</span>
                </button>
                {folders.map(([f, n]) => (
                  <button type="button" key={f} className={`mt-navi${folder === f ? " active" : ""}`} onClick={() => setFolder(f)} title={f}>
                    <Folder size={13} className="mt-navi-ico" />
                    <span className="fl">{f}</span>
                    <span className="ct">{n}</span>
                  </button>
                ))}
                {assets.length === 0 && data && <div className="mt-nav-empty">暂无目录</div>}
              </div>
            </FoldCard>

            {recent.length > 0 && (
              <FoldCard
                title="最近更新"
                icon={<Clock size={14} />}
                count={recent.length}
                defaultOpen={false}
                scrollable={recent.length > 6}
                maxHeight={232}
              >
                <div className="mt-recent">
                  {recent.map((a) => {
                    const Icon = ICON[a.type] ?? FileText
                    return (
                      <button type="button" key={a.id} className="mt-recent-row" title={a.name.zh} onClick={() => setSelected(a)}>
                        <span className={`mt-ico sm ${a.type}`}><Icon size={13} /></span>
                        <span className="mt-recent-body">
                          <span className="mt-recent-name">{basename(a.name.zh)}</span>
                          <span className="mt-recent-meta">
                            {fmtSize(a.size)}
                            {relTime(a.updatedAt) ? (
                              <>
                                <span className="mt-recent-dot" aria-hidden />
                                {relTime(a.updatedAt)}
                              </>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </FoldCard>
            )}
          </div>
        </aside>
      </div>

      {selected && (
        <div className="mat-overlay" role="presentation" onClick={() => setSelected(null)}>
          <div className="mat-panel" role="dialog" aria-modal="true" aria-label="素材详情" onClick={(e) => e.stopPropagation()}>
            <div className="mat-head">
              <span className={`mt-ico lg ${selected.type}`}>
                {React.createElement(ICON[selected.type] ?? FileText, { size: 20 })}
              </span>
              <div className="mat-head-text">
                <div className="mat-kicker">{TYPE_LABEL[selected.type] ?? selected.type}</div>
                <h2>{basename(selected.name.zh)}</h2>
              </div>
              <button type="button" className="mat-x" onClick={() => setSelected(null)} aria-label="关闭素材详情"><X size={16} /></button>
            </div>
            <div className="mat-body">
              <div className="mat-row"><span><Folder size={12} /> 所在目录</span><b>{folderOf(selected.name.zh)}</b></div>
              <div className="mat-row"><span><Layers size={12} /> 文件大小</span><b>{fmtSize(selected.size)}</b></div>
              <div className="mat-row"><span><Clock size={12} /> 更新时间</span><b>{fmtDate(selected.updatedAt)}</b></div>
              <div className="mat-path">{selected.name.zh}</div>
            </div>
            <div className="mat-actions">
              <button type="button" className="btn sm" onClick={() => copyPath(selected)}><Copy size={12} /> 复制路径</button>
              <button type="button" className="btn primary sm" onClick={() => setSelected(null)}><Check size={12} /> 完成</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
