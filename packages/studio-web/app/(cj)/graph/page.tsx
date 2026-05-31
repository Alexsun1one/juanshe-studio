"use client"

import * as React from "react"
import useSWR from "swr"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis } from "recharts"
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Box,
  CalendarRange,
  GitBranch,
  Hash,
  MapPin,
  Network,
  Spline,
  Tag,
  Tags,
  User,
  Users,
} from "lucide-react"
import { fetchStoryGraph, type StoryGraphNode } from "@/lib/api/client"
import { predicateLabel } from "@/lib/labels"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { CharacterPixel } from "@/components/design/character-pixel"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import { StoryGraphView } from "@/components/studio/story-graph-view"
import "./graph.css"

const soft = { shouldRetryOnError: false }
const TYPE_LABEL: Record<string, string> = { person: "人物", item: "物件", place: "地点", org: "组织", concept: "概念", other: "其它" }
const TYPE_COLOR: Record<string, string> = { person: "#6E5BFA", item: "#C66E2F", place: "#2BB97A", org: "#B173E8", concept: "#3B82F6", other: "#9aa0aa" }
// 实体类型 → lucide 图标(语义一眼可辨;人物在列表里用像素头像,这里给非人物兜底)
const TYPE_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  person: User,
  item: Box,
  place: MapPin,
  org: Users,
  concept: Tag,
  other: Boxes,
}

// 像素头像的稳定取色(与 story-graph-view 同源,保证同一人物图谱内外配色一致)
const PERSON_PALETTE = ["#6E5BFA", "#4A8AE0", "#F08A4B", "#B173E8", "#2BB97A", "#E04848", "#9D8AFF", "#5C6478"]
function personColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return PERSON_PALETTE[Math.abs(h) % PERSON_PALETTE.length]
}

function graphSourceLabel(graph: { fallback?: string } | undefined) {
  if (!graph) return ""
  if (graph.fallback === "character_matrix") return "角色真相文件 fallback"
  if (graph.fallback) return `Fallback: ${graph.fallback}`
  return "MemoryDB 活图谱"
}

function graphSourceText(graph: { fallback?: string; source?: string } | undefined) {
  if (!graph) return ""
  if (graph.source) return `来源 ${graph.source}`
  if (graph.fallback) return "来源 character_matrix + roles + emotional_arcs"
  return "来源 memory.db"
}

export default function GraphPage() {
  const { bookId, booksLoading } = useWorkspace()
  const router = useRouter()
  const { data: graph, isLoading } = useSWR(bookId ? ["story-graph", bookId] : null, () => fetchStoryGraph(bookId), soft)

  // 选中实体:由枢纽列表点击驱动,在 Inspector 展开该实体的真相档案(摘要 / 现状 / 出场跨度 / 关系)。
  // 不改 StoryGraphView 内部交互:画布里仍是「点节点聚焦、双击进档案」。
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  const goEntity = (n: StoryGraphNode | { name: string }) => router.push(`/characters/${encodeURIComponent(n.name)}`)
  const topNodes = [...(graph?.nodes ?? [])].sort((a, b) => b.degree - a.degree).slice(0, 14)
  const typeDist = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const n of graph?.nodes ?? []) m.set(n.type, (m.get(n.type) ?? 0) + 1)
    return [...m.entries()].map(([type, value]) => ({ type, label: TYPE_LABEL[type] ?? type, value })).sort((a, b) => b.value - a.value)
  }, [graph])
  const relDist = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const e of graph?.edges ?? []) m.set(e.predicate, (m.get(e.predicate) ?? 0) + 1)
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 7)
  }, [graph])
  const sourceLabel = graphSourceLabel(graph)
  const sourceText = graphSourceText(graph)

  // 选中实体 + 其关系(从 edges 派生,如实呈现,不编造)
  const selected = React.useMemo(
    () => (selectedId ? graph?.nodes.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, graph],
  )
  const nameById = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const n of graph?.nodes ?? []) m.set(n.id, n.name)
    return m
  }, [graph])
  const selectedRelations = React.useMemo(() => {
    if (!selected) return []
    const out: { other: string; predicate: string; sinceChapter: number }[] = []
    for (const e of graph?.edges ?? []) {
      if (e.source === selected.id) out.push({ other: nameById.get(e.target) ?? e.target, predicate: e.predicate, sinceChapter: e.sinceChapter })
      else if (e.target === selected.id) out.push({ other: nameById.get(e.source) ?? e.source, predicate: e.predicate, sinceChapter: e.sinceChapter })
    }
    return out
  }, [selected, graph, nameById])

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="故事图谱" sub="本地工作区还没有作品,创建后这里会出现一张随写作自动生长的角色·关系·状态图谱。" />
  }

  const topType = typeDist[0]
  const hubName = topNodes[0]?.name
  const hubDeg = topNodes[0]?.degree ?? 0
  const entityCount = graph?.stats.entities ?? 0
  const activeRel = graph?.stats.activeRelations ?? 0
  const edgeCount = graph?.edges.length ?? 0

  return (
    <div className="cj-screen cj-graph">
      {/* ── 顶部工作条:像素 + 标题 + 来源 pill + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead g-head">
        <div className="g-headline">
          <PixelBadge kind="graph" size={44} className="g-hero-pixel" ariaLabel="故事图谱" />
          <div className="g-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">故事图谱</h1>
              {graph && (
                <span className={`g-source-pill${graph.fallback ? " fallback" : " live"}`}>
                  <i className="g-dot" />{sourceLabel}
                </span>
              )}
            </div>
            <p className="page-sub g-sub">
              随写作自动生长、自动消解矛盾的角色·关系·状态图谱
              {topType ? <> ,以「<b>{topType.label}</b>」为主</> : null}
              {hubName ? <> ,枢纽是 <b>{hubName}</b></> : null}
              。<span className="g-sub-hint">点节点聚焦 · 双击进实体页</span>
            </p>
          </div>
        </div>
        <div className="g-kpis" role="group" aria-label="图谱概览">
          <KpiChip label="实体" value={entityCount} unit="个" tone="brand" hint="图谱中的人物 / 物件 / 地点 / 组织 / 概念" />
          <KpiChip label="现行关系" value={activeRel} unit="条" tone="ok" hint="当前生效的实体间关系" />
          <KpiChip label="连线" value={edgeCount} unit="条" tone="info" hint="画布上渲染的关系连线总数" />
          <KpiChip
            label="枢纽连接度"
            value={hubDeg}
            unit="连"
            tone={hubDeg > 0 ? "amber" : "neutral"}
            sub={hubName ? <StatLine items={[{ n: hubName, label: "", tone: "amber" }]} /> : undefined}
            hint="连接最多的实体的连接数"
          />
          <KpiChip
            label="实体类型"
            value={typeDist.length}
            unit="类"
            tone="neutral"
            sub={topType ? <StatLine items={[{ n: topType.value, label: topType.label, tone: "brand" }]} /> : undefined}
          />
        </div>
      </header>

      {graph?.unavailable && (
        <div className="g-warn" role="status">
          <AlertTriangle size={15} className="g-warn-ico" aria-hidden />
          <span>
            {graph.nodes.length > 0
              ? "MemoryDB 图谱索引暂不可用,当前已使用角色真相文件 fallback。实体与关系可查看,继续写作后会回写为活图谱。"
              : "图谱索引暂不可用,且当前没有可回退的角色真相文件。继续写作或补全角色矩阵后图谱会重新生长。"}
          </span>
        </div>
      )}

      {/* ── 主体:图谱画布(主区)+ 图谱检视(Inspector,只在各自 pane 内滚)── */}
      <div className="cj-screen-body g-body">
        <div className="cj-mainpane g-mainpane">
          <div className="g-mainpane-head">
            <span className="g-mainpane-title">
              <Network size={14} aria-hidden /> 关系画布
            </span>
            <StatLine
              className="g-mainpane-stat"
              items={[
                { n: entityCount, label: "实体", tone: "brand" },
                { n: activeRel, label: "关系", tone: "ok" },
              ]}
            />
            {sourceText && <span className="g-mainpane-src">{sourceText}</span>}
          </div>
          <div className="g-canvas-wrap">
            {isLoading && !graph ? (
              <div className="skel" style={{ height: "100%", minHeight: 440, margin: 0 }} />
            ) : (
              <StoryGraphView
                graph={graph ?? { bookId, stats: { entities: 0, relations: 0, activeRelations: 0 }, nodes: [], edges: [] }}
                onNodeClick={goEntity}
                emptyAction={(
                  <>
                    <Link className="btn primary sm" href="/knowledge">打开知识与资产</Link>
                    <Link className="btn sm" href="/characters">查看角色设定</Link>
                  </>
                )}
              />
            )}
          </div>
        </div>

        <aside className="cj-inspector g-inspector">
          <div className="cj-pane-scroll g-insp-scroll">
            {/* —— 选中实体真相档案:点枢纽实体后展开(摘要 / 现状 / 跨度 / 关系)—— */}
            {selected && (
              <section className="card g-entity">
                <div className="g-entity-head">
                  {selected.type === "person" ? (
                    <CharacterPixel color={personColor(selected.id)} size={36} ariaLabel={selected.name} />
                  ) : (
                    <span className={`g-entity-ico t-${selected.type}`}>{React.createElement(TYPE_ICON[selected.type] ?? Boxes, { size: 18 })}</span>
                  )}
                  <div className="g-entity-id">
                    <span className="g-entity-name" title={selected.name}>{selected.name}</span>
                    <span className="g-entity-tags">
                      <span className={`g-type t-${selected.type}`}>{TYPE_LABEL[selected.type] ?? selected.type}</span>
                      <span className="g-entity-deg"><Hash size={10} aria-hidden />{selected.degree} 连</span>
                    </span>
                  </div>
                  <button type="button" className="g-entity-go" onClick={() => goEntity(selected)} title="进入实体档案页">
                    档案 <ArrowRight size={13} aria-hidden />
                  </button>
                </div>
                {selected.summary && <p className="g-entity-sum">{selected.summary}</p>}
                <div className="g-entity-meta">
                  <span className="g-entity-span" title="出场章节跨度">
                    <CalendarRange size={12} aria-hidden />
                    出场 <b className="num">第 {selected.firstChapter}</b>
                    {selected.lastChapter !== selected.firstChapter ? <> – <b className="num">{selected.lastChapter}</b></> : null} 章
                  </span>
                  {selected.aliases.length > 0 && (
                    <span className="g-entity-alias" title="别名">
                      <Tags size={12} aria-hidden />
                      <span className="g-entity-alias-t">别名 {selected.aliases.join(" / ")}</span>
                    </span>
                  )}
                </div>
                {selected.state.length > 0 && (
                  <div className="g-entity-states">
                    {selected.state.map((s, i) => (
                      <div key={i} className="g-state">
                        <span className="g-state-k">{predicateLabel(s.predicate) || s.predicate}</span>
                        <span className="g-state-v">{s.object}</span>
                      </div>
                    ))}
                  </div>
                )}
                {selectedRelations.length > 0 && (
                  <div className="g-entity-rels">
                    <div className="g-entity-rels-h"><Spline size={12} aria-hidden /> 关系 <b className="num">{selectedRelations.length}</b></div>
                    <div className="g-rel-list">
                      {selectedRelations.map((r, i) => (
                        <div key={i} className="g-rel">
                          <span className="g-rel-pred">{predicateLabel(r.predicate) || r.predicate}</span>
                          <span className="g-rel-arrow" aria-hidden>→</span>
                          <span className="g-rel-other">{r.other}</span>
                          {r.sinceChapter > 0 && <span className="g-rel-since">第 {r.sinceChapter} 章起</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {typeDist.length > 0 && (
              <FoldCard
                title="实体构成"
                icon={<Boxes size={15} />}
                count={`${entityCount} 个`}
                defaultOpen
              >
                <div className="g-donut">
                  <ResponsiveContainer width="100%" height={132}>
                    <PieChart>
                      <Pie data={typeDist} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius={36} outerRadius={58} paddingAngle={typeDist.length > 1 ? 2 : 0} stroke="var(--bg-card)" strokeWidth={2}>
                        {typeDist.map((d) => <Cell key={d.type} fill={TYPE_COLOR[d.type] ?? TYPE_COLOR.other} />)}
                      </Pie>
                      <Tooltip formatter={(v: number, _n, p) => [`${v} 个`, (p?.payload as { label?: string })?.label ?? ""]} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--line-1)" }} />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* 环形中心:总实体数 — 即使只有 1 个类型也有视觉焦点,不再是空心单色环 */}
                  <div className="g-donut-center" aria-hidden>
                    <b>{entityCount}</b>
                    <span>实体</span>
                  </div>
                </div>
                <div className="g-dist-legend">
                  {typeDist.map((d) => {
                    const Ico = TYPE_ICON[d.type] ?? Boxes
                    return (
                      <span key={d.type} className="g-dl">
                        <i style={{ background: TYPE_COLOR[d.type] ?? TYPE_COLOR.other }} />
                        <Ico size={11} aria-hidden />
                        {d.label} <b>{d.value}</b>
                      </span>
                    )
                  })}
                </div>
              </FoldCard>
            )}

            {relDist.length > 0 && (
              <FoldCard
                title="关系类型"
                icon={<GitBranch size={15} />}
                count={`${activeRel} 条`}
                defaultOpen
              >
                <ResponsiveContainer width="100%" height={Math.max(80, relDist.length * 26)}>
                  <BarChart data={relDist} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }} barCategoryGap={4}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="label" width={92} tick={{ fontSize: 10, fill: "var(--ink-600)" }} axisLine={false} tickLine={false} tickFormatter={(v: string) => { const l = predicateLabel(v) || v; return l.length > 7 ? l.slice(0, 6) + "…" : l }} />
                    <Tooltip cursor={{ fill: "var(--bg-sunken)" }} formatter={(v: number) => [`${v} 条`, "关系"]} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--line-1)" }} />
                    <Bar dataKey="value" fill="var(--brand-500)" radius={[0, 4, 4, 0]} maxBarSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </FoldCard>
            )}

            <FoldCard
              title="枢纽实体"
              icon={<Network size={15} />}
              count={topNodes.length > 0 ? `${topNodes.length}` : undefined}
              defaultOpen
              scrollable={topNodes.length > 8}
              maxHeight={332}
            >
              {topNodes.length === 0 ? (
                <div className="g-hub-empty">
                  <Network size={16} aria-hidden />
                  图谱为空,继续写作后枢纽会浮现。
                </div>
              ) : (
                <div className="g-rail-list">
                  {topNodes.map((n, i) => {
                    const Ico = TYPE_ICON[n.type] ?? Boxes
                    return (
                      <button
                        type="button"
                        key={n.id}
                        className={`g-ent${selectedId === n.id ? " active" : ""}`}
                        onClick={() => setSelectedId((cur) => (cur === n.id ? null : n.id))}
                        title={n.summary || n.name}
                        aria-pressed={selectedId === n.id}
                      >
                        <span className={`g-ent-rank${i < 3 ? " top" : ""}`}>{i + 1}</span>
                        {n.type === "person" ? (
                          <CharacterPixel color={personColor(n.id)} size={22} ariaLabel={n.name} />
                        ) : (
                          <span className={`g-ent-ico t-${n.type}`}><Ico size={13} /></span>
                        )}
                        <span className="g-ent-body">
                          <span className="g-ent-name">{n.name}</span>
                          <span className="g-ent-meta">
                            <span className={`g-type t-${n.type}`}>{TYPE_LABEL[n.type] ?? n.type}</span>
                            <span className="g-deg">{n.degree} 连</span>
                          </span>
                        </span>
                        <span className="g-ent-bar" aria-hidden style={{ width: `${Math.round((n.degree / (topNodes[0]?.degree || 1)) * 100)}%` }} />
                      </button>
                    )
                  })}
                </div>
              )}
            </FoldCard>
          </div>
        </aside>
      </div>
    </div>
  )
}
