"use client"

import * as React from "react"
import useSWR from "swr"
import {
  ArrowUpRight,
  Atom,
  BookMarked,
  BookText,
  Boxes,
  CalendarClock,
  CornerDownLeft,
  FileText,
  Flag,
  Gavel,
  GitBranch,
  Hash,
  Link2,
  ListTree,
  MapPin,
  Network,
  Package,
  Search,
  Sparkles,
  SearchX,
  StickyNote,
  Swords,
  Users,
  Workflow,
  X,
} from "lucide-react"
import { fetchWiki } from "@/lib/api/client"
import type { WikiNode } from "@/lib/api/types"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder, EmptyArt } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import "./wiki.css"

const soft = { shouldRetryOnError: false }
const KIND_LABEL: Record<string, string> = {
  setpoint: "设定点", character: "角色", world: "世界观", lore: "设定", concept: "概念",
  rule: "规则", item: "道具", faction: "势力", event: "事件", recipe: "配方", agent: "智能体",
  chapter: "章节", note: "笔记", constraint: "约束", book: "作品", plot: "剧情",
  relation: "关系", location: "地点", timeline: "时间线", theme: "主题",
}

// 每个词条类别一个贴切的 lucide 图标 —— 让分组标题/条目一眼可辨(语义准,不堆砌)。
// 仅作展示锚点;颜色仍走墨色变量,不引入新配色。
const KIND_ICON: Record<string, React.ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean }>> = {
  setpoint: Flag, character: Users, world: Boxes, lore: BookMarked, concept: Atom,
  rule: Gavel, item: Package, faction: Swords, event: CalendarClock, recipe: FileText,
  agent: Workflow, chapter: BookText, note: StickyNote, constraint: Gavel, book: BookText,
  plot: GitBranch, relation: Link2, location: MapPin, timeline: CalendarClock, theme: Sparkles,
}
function KindIcon({ kind, size = 13, className }: { kind: string | undefined; size?: number; className?: string }) {
  const Ico = (kind && KIND_ICON[kind]) || Hash
  return <Ico size={size} className={className} aria-hidden />
}

function renderBody(body: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let list: string[] = []
  const flush = () => { if (list.length) { out.push(<ul key={`u${out.length}`}>{list.map((l, i) => <li key={i}>{l}</li>)}</ul>); list = [] } }
  for (const [i, ln] of String(body || "").split("\n").entries()) {
    const t = ln.trim()
    if (!t) { flush(); continue }
    if (t.startsWith("## ") || t.startsWith("### ")) { flush(); out.push(<h2 key={i}>{t.replace(/^#+\s/, "")}</h2>) }
    else if (t.startsWith("# ")) { flush(); out.push(<h2 key={i}>{t.slice(2)}</h2>) }
    else if (t.startsWith("> ")) { flush(); out.push(<blockquote key={i}>{t.slice(2)}</blockquote>) }
    else if (t.startsWith("- ") || t.startsWith("* ")) { list.push(t.slice(2)) }
    else { flush(); out.push(<p key={i}>{t.replace(/\*\*/g, "")}</p>) }
  }
  flush()
  return out
}

export default function WikiPage() {
  const { books, bookId, booksLoading } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  // 词条会随写作/改写增长:定时+聚焦自动重拉,避免停在"空"的旧缓存
  const { data } = useSWR(bookId ? ["wiki", bookId] : null, () => fetchWiki(bookId), { ...soft, refreshInterval: 15000 })
  const [selId, setSelId] = React.useState<string | null>(null)
  const [q, setQ] = React.useState("")

  const nodes: WikiNode[] = data?.nodes ?? []
  const filtered = q ? nodes.filter((n) => `${n.title.zh}${n.body ?? ""}`.toLowerCase().includes(q.toLowerCase())) : nodes
  const groups = React.useMemo(() => {
    const m = new Map<string, WikiNode[]>()
    for (const n of filtered) { const k = (n as { kind?: string }).kind || "其它"; if (!m.has(k)) m.set(k, []); m.get(k)!.push(n) }
    return [...m.entries()]
  }, [filtered])

  const sel = nodes.find((n) => n.id === selId) ?? filtered[0] ?? nodes[0]
  const selKind = (sel as { kind?: string } | undefined)?.kind
  const selTags = (sel?.tags ?? []).filter(Boolean)
  // 相关条目优先用真实词条图谱(正向/反向链接,去重),链接为空时回退到同类词条,避免该区空着
  const linked = React.useMemo(() => {
    if (!sel) return [] as { id: string; title: string }[]
    const seen = new Set<string>([sel.id])
    const out: { id: string; title: string }[] = []
    for (const l of [...(sel.links ?? []), ...(sel.backlinks ?? [])]) {
      if (!l?.id || seen.has(l.id)) continue
      seen.add(l.id)
      if (nodes.some((n) => n.id === l.id)) out.push({ id: l.id, title: l.title.zh })
    }
    return out
  }, [sel, nodes])
  const related = React.useMemo(() => {
    if (!sel) return [] as { id: string; title: string }[]
    if (linked.length) return linked.slice(0, 10)
    return nodes
      .filter((n) => (n as { kind?: string }).kind === selKind && n.id !== sel.id)
      .slice(0, 8)
      .map((n) => ({ id: n.id, title: n.title.zh }))
  }, [sel, linked, nodes, selKind])
  const relatedFromLinks = linked.length > 0

  // 知识库规模:一行内联数据,数据原地变化(参考 knowledge/insights,不做卡片平铺)
  const kindCount = groups.length
  const taggedCount = nodes.reduce((s, n) => s + ((n.tags?.length ?? 0) > 0 ? 1 : 0), 0)

  // ── Inspector 派生信号:全部从已取的 nodes 计算,不新增请求、不编造任何数字 ──
  // 1) 全库类别构成(按数量降序),给「知识库构成」分布条
  const allGroups = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const n of nodes) {
      const k = (n as { kind?: string }).kind || "其它"
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [nodes])
  // 2) 链接覆盖:有正向/反向链接的词条数(图谱连通度的诚实读数)
  const linkedNodeCount = React.useMemo(
    () => nodes.reduce((s, n) => s + (((n.links?.length ?? 0) + (n.backlinks?.length ?? 0)) > 0 ? 1 : 0), 0),
    [nodes],
  )
  // 3) 孤立词条:既无正向也无反向链接(提示「该补关联了」),给 Inspector 折叠卡
  const orphanNodes = React.useMemo(
    () => nodes.filter((n) => (n.links?.length ?? 0) === 0 && (n.backlinks?.length ?? 0) === 0),
    [nodes],
  )
  // 4) 连接最密的词条(links + backlinks 计数 Top),作为「枢纽词条」一眼定位主线
  const hubNodes = React.useMemo(() => {
    return nodes
      .map((n) => ({ node: n, deg: (n.links?.length ?? 0) + (n.backlinks?.length ?? 0) }))
      .filter((x) => x.deg > 0)
      .sort((a, b) => b.deg - a.deg)
      .slice(0, 6)
  }, [nodes])

  const linkPct = nodes.length > 0 ? Math.round((linkedNodeCount / nodes.length) * 100) : 0
  const tagPct = nodes.length > 0 ? Math.round((taggedCount / nodes.length) * 100) : 0
  const maxGroup = allGroups.length ? allGroups[0][1] : 0

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="LLM Wiki" sub="本地工作区还没有作品,创建后这里会出现作品知识库 Wiki。" />
  }

  return (
    <div className="cj-screen cj-wiki">
      {/* ── 顶部工作条:像素徽章 + 标题 + 一行密集 KPI(数据原地变化)── */}
      <header className="cj-workhead wiki-hero">
        <PixelBadge kind="wiki" size={42} className="wiki-hero-pix" ariaLabel="LLM Wiki" />
        <div className="wiki-hero-id">
          <h1 className="page-title">LLM Wiki</h1>
          <span className="wiki-hero-book">
            <BookMarked size={12} aria-hidden />
            《{active?.title.zh ?? "—"}》知识库
          </span>
        </div>
        <div className="wiki-kpis" role="group" aria-label="知识库规模">
          <KpiChip label="词条总数" value={nodes.length} unit="条" tone="brand" />
          <KpiChip label="类别" value={kindCount} unit="类" tone="amber" />
          <KpiChip
            label="已标注"
            value={taggedCount}
            unit="条"
            tone={taggedCount > 0 ? "ok" : "neutral"}
            sub={<StatLine items={[{ n: `${tagPct}%`, label: "覆盖", tone: "ok" }]} />}
          />
          <KpiChip
            label="已关联"
            value={linkedNodeCount}
            unit="条"
            tone={linkedNodeCount > 0 ? "info" : "neutral"}
            sub={<StatLine items={[{ n: `${linkPct}%`, label: "连通", tone: "info" }]} />}
          />
        </div>
      </header>

      {/* ── 主体:TOC + 词条正文(主区) + 知识库检视(Inspector)── */}
      <div className="cj-screen-body wiki-body">
        {/* 左:目录 —— 分组标题与每个词条前带类别图标,一眼可辨 */}
        <nav className="wiki-toc">
          <div className="wiki-toc-search">
            <div className="box">
              <Search size={14} aria-hidden />
              <input placeholder="搜索词条" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索词条" />
              {q && (
                <button type="button" className="wiki-toc-clear" onClick={() => setQ("")} aria-label="清除搜索" title="清除搜索">
                  <X size={13} aria-hidden />
                </button>
              )}
            </div>
          </div>
          <div className="wiki-toc-list cj-pane-scroll">
            {!data && <div className="skel wiki-toc-skel" />}
            {groups.map(([kind, ns]) => (
              <div className="wiki-toc-group" key={kind}>
                <div className="tg">
                  <KindIcon kind={kind} size={12} className="tg-ic" />
                  <span className="tg-label">{KIND_LABEL[kind] ?? kind}</span>
                  <span className="tg-ct">{ns.length}</span>
                </div>
                {ns.map((n) => {
                  const isAgent = (n as { kind?: string }).kind === "agent"
                  const profileId = (n as { agentProfileId?: string }).agentProfileId
                  return (
                    <button
                      type="button"
                      key={n.id}
                      className={`wiki-toc-node${sel?.id === n.id ? " sel" : ""}`}
                      onClick={() => setSelId(n.id)}
                      aria-pressed={sel?.id === n.id}
                    >
                      {isAgent && profileId ? (
                        <AgentPixel id={profileId} size={16} className="nd-pix" ariaLabel={n.title.zh} />
                      ) : (
                        <KindIcon kind={kind} size={13} className="nd-ic" />
                      )}
                      <span className="tx">{n.title.zh}</span>
                    </button>
                  )
                })}
              </div>
            ))}
            {data && nodes.length === 0 && (
              <div className="empty wiki-toc-empty">
                <ListTree size={16} aria-hidden />
                <span>暂无 Wiki 词条</span>
              </div>
            )}
            {data && nodes.length > 0 && filtered.length === 0 && (
              <div className="empty wiki-toc-empty">
                <SearchX size={16} aria-hidden />
                <span>没有匹配「{q.trim()}」的词条</span>
                <button type="button" className="wiki-toc-empty-clear" onClick={() => setQ("")}>
                  清除搜索
                </button>
              </div>
            )}
          </div>
        </nav>

        {/* 中:词条正文(只在此 pane 内滚) */}
        <article className="wiki-content cj-pane-scroll">
          {(!data || nodes.length === 0) ? (
            <div className="wiki-empty-stage">
              <div className="wiki-empty-art">
                <EmptyArt variant="wiki" />
              </div>
              <h2>{data ? "Wiki 书页还没翻开" : "正在翻找作品词条"}</h2>
              <p>
                {data
                  ? "写作推进时,角色、设定、伏笔和章节摘要会沉淀成词条,这里会变成作品的本地知识书架。"
                  : "本地知识库还在整理索引,先把书页、台灯和档案册铺好。"}
              </p>
            </div>
          ) : sel ? (
            <div className="wc-article">
              <header className="wc-head">
                {(() => {
                  const selIsAgent = selKind === "agent"
                  const selProfile = (sel as { agentProfileId?: string }).agentProfileId
                  return (
                    <div className="wc-kindrow">
                      {selIsAgent && selProfile ? (
                        <AgentPixel id={selProfile} size={20} className="wc-kind-pix" ariaLabel={sel.title.zh} />
                      ) : null}
                      <span className="wc-kind">
                        <KindIcon kind={selKind} size={12} />
                        {KIND_LABEL[selKind ?? ""] ?? selKind ?? "词条"}
                      </span>
                    </div>
                  )
                })()}
                <h1 className="wc-title">{sel.title.zh}</h1>
                {selTags.length > 0 && (
                  <div className="wc-tags">
                    {selTags.slice(0, 8).map((t) => (
                      <span className="wc-tag" key={t}><Hash size={10} aria-hidden />{t}</span>
                    ))}
                  </div>
                )}
              </header>
              <div className="wc-body">
                {sel.html
                  ? <div className="wc-html" dangerouslySetInnerHTML={{ __html: sel.html }} />
                  : sel.body && sel.body !== sel.title.zh
                    ? renderBody(sel.body)
                    : <p className="muted">(此词条暂无正文)</p>}
              </div>
              {related.length > 0 && (
                <div className="wc-related">
                  <h5>
                    <Network size={13} aria-hidden />
                    {relatedFromLinks ? "关联词条" : "相关条目"}
                    <span className="ct">{related.length}</span>
                  </h5>
                  <div className="rel-chips">
                    {related.map((n) => (
                      <button type="button" key={n.id} className="rel-chip" onClick={() => setSelId(n.id)}>
                        {relatedFromLinks && <ArrowUpRight size={12} className="ic" aria-hidden />}
                        {n.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="wc-empty">
              <CornerDownLeft size={18} aria-hidden />
              <span>选择左侧词条查看</span>
            </div>
          )}
        </article>

        {/* 右:知识库检视 —— 构成 / 覆盖 / 枢纽 / 待补关联(全部从已取词条派生)*/}
        <aside className="cj-inspector wiki-inspector">
          <div className="cj-pane-scroll wiki-insp-scroll">
            <section className="card wiki-comp">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-title">知识库构成</div>
                <span className="wiki-comp-total">
                  <span className="num">{nodes.length}</span> 条
                </span>
              </div>
              {nodes.length > 0 ? (
                <>
                  <div className="wiki-cov">
                    <Meter label="标注覆盖" value={taggedCount} max={Math.max(nodes.length, 1)} tone="ok" showValue={false} />
                    <div className="wiki-cov-cap">
                      <span className="num">{taggedCount}</span>
                      <span className="of">/{nodes.length} 条已打标签</span>
                      <span className="pct">{tagPct}%</span>
                    </div>
                    <Meter label="链接连通" value={linkedNodeCount} max={Math.max(nodes.length, 1)} tone="info" showValue={false} />
                    <div className="wiki-cov-cap">
                      <span className="num">{linkedNodeCount}</span>
                      <span className="of">/{nodes.length} 条已关联</span>
                      <span className="pct">{linkPct}%</span>
                    </div>
                  </div>
                  <div className="wiki-dist">
                    {allGroups.slice(0, 8).map(([kind, n]) => {
                      const isActive = kind === selKind
                      return (
                        <div className={`wiki-dist-row${isActive ? " is-active" : ""}`} key={kind}>
                          <span className="wd-ic"><KindIcon kind={kind} size={12} /></span>
                          <span className="wd-label">{KIND_LABEL[kind] ?? kind}</span>
                          <span className="wd-bar" aria-hidden>
                            <i style={{ width: `${maxGroup > 0 ? Math.max(6, (n / maxGroup) * 100) : 0}%` }} />
                          </span>
                          <span className="wd-n num">{n}</span>
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <div className="wiki-comp-empty">写作推进时,角色 / 设定 / 伏笔会自动沉淀成词条,这里汇总整库构成。</div>
              )}
            </section>

            {hubNodes.length > 0 && (
              <FoldCard
                title="枢纽词条"
                count={hubNodes.length}
                icon={<Network size={15} />}
                defaultOpen
                scrollable={hubNodes.length > 4}
                maxHeight={208}
              >
                <div className="wiki-mini-list">
                  {hubNodes.map(({ node, deg }) => {
                    const k = (node as { kind?: string }).kind
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className={`wiki-mini-row${sel?.id === node.id ? " sel" : ""}`}
                        onClick={() => setSelId(node.id)}
                        title={`${node.title.zh} · ${deg} 条关联`}
                      >
                        <span className="wm-ic"><KindIcon kind={k} size={13} /></span>
                        <span className="wm-body">
                          <span className="wm-title">{node.title.zh}</span>
                          <span className="wm-kind">{KIND_LABEL[k ?? ""] ?? k ?? "词条"}</span>
                        </span>
                        <span className="wm-deg">
                          <Link2 size={11} aria-hidden />
                          <b className="num">{deg}</b>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </FoldCard>
            )}

            {orphanNodes.length > 0 && (
              <FoldCard
                title="待补关联"
                count={orphanNodes.length}
                icon={<Link2 size={15} />}
                defaultOpen={hubNodes.length === 0}
                scrollable={orphanNodes.length > 4}
                maxHeight={208}
              >
                <div className="wiki-mini-list">
                  {orphanNodes.slice(0, 30).map((node) => {
                    const k = (node as { kind?: string }).kind
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className={`wiki-mini-row${sel?.id === node.id ? " sel" : ""}`}
                        onClick={() => setSelId(node.id)}
                        title={`${node.title.zh} · 暂无关联词条`}
                      >
                        <span className="wm-ic"><KindIcon kind={k} size={13} /></span>
                        <span className="wm-body">
                          <span className="wm-title">{node.title.zh}</span>
                          <span className="wm-kind">{KIND_LABEL[k ?? ""] ?? k ?? "词条"}</span>
                        </span>
                        <span className="pill" data-state="draft"><span className="dot" />孤立</span>
                      </button>
                    )
                  })}
                </div>
              </FoldCard>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
