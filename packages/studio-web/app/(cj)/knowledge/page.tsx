"use client"

import * as React from "react"
import useSWR from "swr"
import Link from "next/link"
import { toast } from "sonner"
import {
  Boxes,
  ChevronRight,
  Crosshair,
  GitBranch,
  Globe,
  Heart,
  HeartCrack,
  HelpCircle,
  Loader2,
  Network,
  ScanSearch,
  ScrollText,
  Sparkles,
  Users,
} from "lucide-react"
import {
  fetchPlotProgress,
  fetchRelationshipGraph,
  fetchWorld,
} from "@/lib/api/client"
import type { Cast, Relation } from "@/lib/studio-data"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder, EmptyArt } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, Meter } from "@/components/design/kit"
import "./knowledge.css"

const soft = { shouldRetryOnError: false }
const W = 1000, H = 700, CX = 500, CY = 330

const initial = (s: string) => (s || "?").trim().replace(/[《》"'\s]/g, "").charAt(0) || "?"
function relPolarity(r: Relation): "pos" | "neg" | "unk" {
  const t = `${r.kind ?? ""}${r.label?.zh ?? ""}`
  if (/未明|谜|unknown|疑/.test(t)) return "unk"
  if (/敌|仇|恨|对抗|宿敌|rival|enemy|背叛|反目/.test(t)) return "neg"
  return "pos"
}
const POL_COLOR = { pos: "#2BB97A", neg: "#E04848", unk: "#8B7DFF" }
// 关系极性 → 设计系统状态 pill 的 data-state(语义色只走状态,不再裸色点)
const POL_STATE: Record<"pos" | "neg" | "unk", string> = { pos: "success", neg: "error", unk: "queued" }
const POL_ICON = { pos: Heart, neg: HeartCrack, unk: HelpCircle }
// 关系类型中文标签:后端 kind 是裸枚举,无 label.zh 时回退到这里,别把 "ally"/"rival" 直接漏给用户
const KIND_LABEL: Record<string, string> = {
  ally: "盟友", neutral: "中立", rival: "宿敌", subord: "下属", mentor: "师徒", family: "亲属",
}
const kindLabel = (k: string) => KIND_LABEL[k] ?? "关系"

export default function KnowledgePage() {
  const { books, bookId, booksLoading } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const { data: graph, mutate: mutateGraph } = useSWR(bookId ? ["relgraph", bookId] : null, () => fetchRelationshipGraph(bookId), soft)
  const { data: world } = useSWR(bookId ? ["world", bookId] : null, () => fetchWorld(bookId), soft)
  const { data: plot } = useSWR(bookId ? ["plot", bookId] : null, () => fetchPlotProgress(bookId), soft)

  const [selId, setSelId] = React.useState<string | null>(null)
  const [hoverId, setHoverId] = React.useState<string | null>(null)
  const [extracting, setExtracting] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement>(null)

  const onExtract = async () => {
    if (!bookId) return
    setExtracting(true)
    try {
      // 关系来自角色档案(character_matrix,写作时由章节分析官抽取/维护);后端 GET 每次从真相文件重建,
      // 所以这里的"重新生成"= 重新拉取最新派生结果,真实、即时,不再走假任务轮询。
      toast.info("正在从角色档案与正文重新生成关系图谱…")
      const fresh = await mutateGraph()
      const n = fresh?.nodes?.length ?? 0
      const e = fresh?.edges?.length ?? 0
      toast.success(`关系图谱已刷新 · ${n} 节点 / ${e} 关系`)
    } catch (e) {
      toast.error(`刷新失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExtracting(false)
    }
  }

  // 按 id 去重,防止后端派生出现重复实体时 React key 冲突(同时也避免重复渲染)
  const nodes = React.useMemo(() => {
    const seen = new Set<string>()
    return (graph?.nodes ?? []).filter((n) => {
      if (seen.has(n.id)) return false
      seen.add(n.id)
      return true
    })
  }, [graph])
  const edges = React.useMemo(() => graph?.edges ?? [], [graph])
  const factions = React.useMemo(() => graph?.factions ?? [], [graph])
  const factionMap = React.useMemo(() => new Map(factions.map((f) => [f.id, f])), [factions])

  // 确定性聚类布局:派系成簇环绕,簇内成圈
  const layout = React.useMemo(() => {
    const pos = new Map<string, { x: number; y: number; n: Cast }>()
    const facs = factions.length ? factions.map((f) => f.id) : ["_"]
    const clusters = new Map<string, { x: number; y: number }>()
    facs.forEach((fid, fi) => {
      const ang = (2 * Math.PI * fi) / facs.length - Math.PI / 2
      const R = facs.length > 1 ? 210 : 0
      clusters.set(fid, { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) })
    })
    const byFac = new Map<string, Cast[]>()
    for (const n of nodes) {
      const fid = (n.factionId && clusters.has(n.factionId)) ? n.factionId : facs[0]
      if (!byFac.has(fid)) byFac.set(fid, [])
      byFac.get(fid)!.push(n)
    }
    byFac.forEach((members, fid) => {
      const c = clusters.get(fid)!
      const rr = 46 + members.length * 7
      members.forEach((n, i) => {
        if (members.length === 1) { pos.set(n.id, { x: c.x, y: c.y, n }); return }
        const a = (2 * Math.PI * i) / members.length
        pos.set(n.id, { x: c.x + rr * Math.cos(a), y: c.y + rr * Math.sin(a), n })
      })
    })
    return { pos, clusters }
  }, [nodes, factions])

  const colorOf = (n: Cast) => (n.factionId && factionMap.get(n.factionId)?.color) || n.color || "var(--brand-500)"
  const sel = nodes.find((n) => n.id === selId) ?? nodes.find((n) => n.id === graph?.focusId) ?? nodes[0]
  const selFaction = sel?.factionId ? factionMap.get(sel.factionId) : undefined
  const selEdges = edges.filter((e) => e.source === sel?.id || e.target === sel?.id)

  const neighbors = React.useMemo(() => {
    if (!hoverId) return null
    const s = new Set<string>([hoverId])
    for (const e of edges) {
      if (e.source === hoverId) s.add(e.target)
      if (e.target === hoverId) s.add(e.source)
    }
    return s
  }, [hoverId, edges])

  // 章节时间线
  const curChapter = active?.currentChapter ?? 0
  const maxCh = Math.max(curChapter, 8, (plot?.tensionCurve ?? []).reduce((m, t) => Math.max(m, t.chapter), 0))
  const milestones = plot?.milestones ?? []

  const startDrag = (side: "l" | "r") => (e: React.PointerEvent) => {
    e.preventDefault()
    const body = bodyRef.current
    if (!body) return
    const startX = e.clientX
    const prop = side === "l" ? "--kl" : "--kr"
    const cur = parseInt(getComputedStyle(body).getPropertyValue(prop)) || (side === "l" ? 260 : 320)
    ;(e.currentTarget as HTMLElement).classList.add("dragging")
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      let v = side === "l" ? cur + dx : cur - dx
      v = Math.max(190, Math.min(460, v))
      body.style.setProperty(prop, `${v}px`)
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.cursor = ""
      document.querySelectorAll(".cj-knowledge .kg-resizer.dragging").forEach((el) => el.classList.remove("dragging"))
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    document.body.style.cursor = "col-resize"
  }
  const resetCol = (side: "l" | "r") => () => bodyRef.current?.style.setProperty(side === "l" ? "--kl" : "--kr", side === "l" ? "260px" : "320px")

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="知识与资产" sub="本地工作区还没有作品,创建后这里会出现知识图谱、实体树与章节时间线。" />
  }

  const settingTotal = (world ?? []).reduce((s, w) => s + (w.count || 0), 0)
  const unfactioned = nodes.filter((n) => !n.factionId || !factionMap.has(n.factionId))
  // 关系极性构成:正向 / 敌对 / 未明 —— 派生自已有 edges,不编造
  const polCounts = edges.reduce(
    (acc, e) => {
      acc[relPolarity(e)] += 1
      return acc
    },
    { pos: 0, neg: 0, unk: 0 } as Record<"pos" | "neg" | "unk", number>,
  )
  // 实体规模 → 一行密集 KpiChip(替代彩虹平铺):规模→brand,分组→amber,关系→rose,设定→info,章节→ok
  const KPIS: { icon: typeof Users; label: string; value: number; unit: string; tone: "brand" | "amber" | "rose" | "info" | "ok" }[] = [
    { icon: Users, label: "角色", value: nodes.length, unit: "位", tone: "brand" },
    { icon: GitBranch, label: "派系", value: factions.length, unit: "个", tone: "amber" },
    { icon: Network, label: "关系", value: edges.length, unit: "条", tone: "rose" },
    { icon: Boxes, label: "设定条目", value: settingTotal, unit: "项", tone: "info" },
    { icon: ScrollText, label: "覆盖章节", value: graph?.uptoChapter ?? active?.chapterCount ?? curChapter, unit: "章", tone: "ok" },
  ]

  // 选中实体的弧光 / 重要度(已有字段)→ Meter,信息密度更高
  const selArcPct = Math.round((sel?.arc || 0) * 100)

  return (
    <div className="cj-screen cj-knowledge">
      {/* ── 顶部工作条:像素徽章 + 标题 + 一行密集 KPI(非彩虹平铺)── */}
      <header className="cj-workhead kg-head">
        <div className="kg-headline">
          <PixelBadge kind="knowledge" size={44} className="kg-hero-pixel" ariaLabel="知识与资产" />
          <div className="kg-headline-text">
            <h1 className="page-title">知识与资产</h1>
            <span className="kg-headline-sub">
              <span className="bk">《{active?.title.zh ?? "—"}》</span>
              <span className="sep" aria-hidden />
              角色社交网 · 派系阵营与人物关系（区别于「故事图谱」的全实体自动图）
              {graph?.updatedAt ? (
                <>
                  <span className="sep" aria-hidden />
                  <span className="kg-ver">v{graph.version ?? 0}</span>
                </>
              ) : null}
            </span>
          </div>
          <div className="kg-head-actions">
            <Link href="/consistency" className="btn sm">
              <ScanSearch size={13} aria-hidden /> 一致性扫描
            </Link>
            <button type="button" className="btn primary sm" onClick={onExtract} disabled={extracting || !bookId}>
              {extracting ? <Loader2 size={13} className="kg-spin" aria-hidden /> : <Sparkles size={13} aria-hidden />}
              {extracting ? "重新生成中…" : "重新生成关系图谱"}
            </button>
          </div>
        </div>
        <div className="kg-kpis" role="group" aria-label="知识规模">
          {KPIS.map((k) => {
            const Icon = k.icon
            return (
              <KpiChip
                key={k.label}
                label={
                  (
                    <span className="kg-kpi-label">
                      <Icon size={12} aria-hidden /> {k.label}
                    </span>
                  ) as unknown as string
                }
                value={k.value}
                unit={k.unit}
                tone={k.tone}
              />
            )
          })}
        </div>
      </header>

      {/* ── 主体:实体树 + 图谱 + 详情抽屉(三栏可拖拽,本身即主区 + Inspector,故单列)── */}
      <div className="cj-screen-body solo kg-screen-body">
        <div className="cj-mainpane kg-mainpane">
          {/* 三栏可拖拽(实体树 | 图谱 | 详情抽屉)*/}
          <div className="kg-body" ref={bodyRef}>
            {/* 左:实体树 */}
            <div className="kg-tree cj-pane-scroll">
              {factions.map((f) => {
                const members = nodes.filter((n) => n.factionId === f.id)
                return (
                  <div className="tree-group" key={f.id}>
                    <div className="tg-head">
                      <span className="nd" style={{ background: f.color }} aria-hidden />
                      {f.name.zh}
                      <span className="ct">{members.length}</span>
                    </div>
                    {members.map((n) => (
                      <button type="button" key={n.id} className={`tree-node${sel?.id === n.id ? " sel" : ""}`} onClick={() => setSelId(n.id)} onMouseEnter={() => setHoverId(n.id)} onMouseLeave={() => setHoverId(null)} aria-pressed={sel?.id === n.id}>
                        <span className="nd" style={{ background: colorOf(n) }} />
                        <span className="nm">{n.name.zh}</span>
                        <span className="imp" title={`重要度 ${n.importance} / 5`}>{n.importance}</span>
                      </button>
                    ))}
                  </div>
                )
              })}
              {unfactioned.length > 0 && (
                <div className="tree-group">
                  <div className="tg-head">
                    <Users size={12} className="tg-ico" aria-hidden />
                    未归派
                    <span className="ct">{unfactioned.length}</span>
                  </div>
                  {unfactioned.map((n) => (
                    <button type="button" key={n.id} className={`tree-node${sel?.id === n.id ? " sel" : ""}`} onClick={() => setSelId(n.id)} onMouseEnter={() => setHoverId(n.id)} onMouseLeave={() => setHoverId(null)} aria-pressed={sel?.id === n.id}>
                      <span className="nd" style={{ background: colorOf(n) }} />
                      <span className="nm">{n.name.zh}</span>
                      <span className="imp" title={`重要度 ${n.importance} / 5`}>{n.importance}</span>
                    </button>
                  ))}
                </div>
              )}
              {(world ?? []).length > 0 && (
                <div className="tree-group">
                  <div className="tg-head">
                    <Globe size={12} className="tg-ico" aria-hidden />
                    设定 · 世界观
                    <span className="ct">{settingTotal}</span>
                  </div>
                  {(world ?? []).map((w) => (
                    <div key={w.id} className="tree-node static">
                      <span className="nd" style={{ background: "var(--c-world)" }} />
                      <span className="nm">{w.title.zh}</span>
                      <span className="imp">{w.count}</span>
                    </div>
                  ))}
                </div>
              )}
              {!graph && (
                <div className="kg-tree-loading" aria-label="正在加载实体树">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>

            <div className="kg-resizer" onPointerDown={startDrag("l")} onDoubleClick={resetCol("l")} />

            {/* 中:图谱 */}
            <div className="kg-graph">
              {nodes.length ? (
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
                  {/* cluster labels */}
                  {factions.map((f) => {
                    const c = layout.clusters.get(f.id)
                    if (!c) return null
                    return <text key={f.id} className="cluster-label" x={c.x} y={c.y - (46 + nodes.filter((n) => n.factionId === f.id).length * 7) - 14} textAnchor="middle">{f.name.zh}</text>
                  })}
                  {/* edges */}
                  {edges.map((e) => {
                    const a = layout.pos.get(e.source), b = layout.pos.get(e.target)
                    if (!a || !b) return null
                    const dim = neighbors ? !(neighbors.has(e.source) && neighbors.has(e.target)) : false
                    const pol = relPolarity(e)
                    return <line key={`${e.source}-${e.target}-${e.kind}`} className={`gedge${dim ? " dim" : ""}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={neighbors && !dim ? POL_COLOR[pol] : undefined} strokeWidth={1 + (e.strength || 0) * 3} strokeOpacity={dim ? undefined : 0.5} />
                  })}
                  {/* nodes — 像素头像替代纯色圆 */}
                  {nodes.map((n) => {
                    const p = layout.pos.get(n.id)
                    if (!p) return null
                    const r = 9 + n.importance * 2.4
                    const dim = neighbors ? !neighbors.has(n.id) : false
                    const isSel = sel?.id === n.id
                    const selectNode = () => setSelId(n.id)
                    // 像素头像尺寸:跟节点大小成比例(28-46px)
                    const pxSize = Math.round((r + (isSel ? 3 : 0)) * 2.4)
                    const half = pxSize / 2
                    const fill = colorOf(n)
                    return (
                      <g
                        key={n.id}
                        className={`gnode${dim ? " dim" : ""}`}
                        onClick={selectNode}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectNode() } }}
                        onMouseEnter={() => setHoverId(n.id)}
                        onMouseLeave={() => setHoverId(null)}
                        role="button"
                        tabIndex={0}
                        aria-label={`查看实体 ${n.name.zh}`}
                      >
                        {/* 选中态:外圈品牌色光晕 */}
                        {isSel && (
                          <circle cx={p.x} cy={p.y} r={r + 6} fill="none" stroke="var(--brand-600)" strokeWidth={2} opacity={0.7} />
                        )}
                        {/* 实色背景圆 — 给像素头像一个 faction 色底,信息密度更高 */}
                        <circle cx={p.x} cy={p.y} r={r + 1} fill={fill} opacity={0.18} stroke={fill} strokeWidth={1.5} />
                        {/* 16×16 像素头像,绘制为内嵌 svg,定位在节点中心 */}
                        <svg
                          x={p.x - half}
                          y={p.y - half}
                          width={pxSize}
                          height={pxSize}
                          viewBox="0 0 16 16"
                          style={{ shapeRendering: "crispEdges", imageRendering: "pixelated", pointerEvents: "none" }}
                        >
                          {/* 头发 */}
                          <rect x={6} y={2} width={4} height={1} fill="#3A2E20" />
                          <rect x={5} y={3} width={6} height={1} fill="#3A2E20" />
                          <rect x={4} y={4} width={3} height={1} fill="#3A2E20" />
                          <rect x={9} y={4} width={3} height={1} fill="#3A2E20" />
                          {/* 脸 + 描边 */}
                          <rect x={4} y={4} width={1} height={3} fill="#2B2620" />
                          <rect x={11} y={4} width={1} height={3} fill="#2B2620" />
                          <rect x={5} y={5} width={6} height={2} fill="#F5D3A8" />
                          {/* 眼睛 */}
                          <rect x={6} y={5} width={1} height={1} fill="#2B2620" />
                          <rect x={9} y={5} width={1} height={1} fill="#2B2620" />
                          {/* 嘴 / 腮红 */}
                          <rect x={7} y={6} width={2} height={1} fill="#F3A8A0" />
                          {/* 脖子 */}
                          <rect x={6} y={7} width={4} height={1} fill="#F5D3A8" />
                          {/* 衣服(faction 色)*/}
                          <rect x={4} y={8} width={8} height={1} fill={fill} />
                          <rect x={3} y={9} width={10} height={4} fill={fill} />
                          <rect x={3} y={9} width={1} height={4} fill="#2B2620" opacity={0.4} />
                          <rect x={12} y={9} width={1} height={4} fill="#2B2620" opacity={0.4} />
                          <rect x={3} y={13} width={4} height={1} fill={fill} />
                          <rect x={9} y={13} width={4} height={1} fill={fill} />
                        </svg>
                        <text x={p.x} y={p.y + r + 14} textAnchor="middle">{n.name.zh}</text>
                      </g>
                    )
                  })}
                </svg>
              ) : !graph ? (
                <div className="kg-graph-loading" role="status">
                  <div className="kg-empty-art"><EmptyArt variant="knowledge" /></div>
                  <b>正在铺开关系板</b>
                  <span>实体、派系和章节线索会汇到这张像素白板上。</span>
                </div>
              ) : (
                <div className="empty kg-empty">
                  <div className="kg-empty-art"><EmptyArt variant="knowledge" /></div>
                  <span className="empty-ico"><Network size={24} aria-hidden /></span>
                  <div className="kg-empty-title">关系网络还未生成</div>
                  <div className="kg-empty-desc">触发「重新生成关系图谱」后,角色与派系的关系会在这里编织成网。</div>
                  <button type="button" className="btn primary sm" onClick={onExtract} disabled={extracting || !bookId}>
                    {extracting ? <Loader2 size={13} className="kg-spin" aria-hidden /> : <Sparkles size={13} aria-hidden />}
                    {extracting ? "重新生成中…" : "重新生成关系图谱"}
                  </button>
                </div>
              )}
              {/* 图谱内浮层:左下派系图例 + 右下关系极性构成(均派生自真实数据) */}
              <div className="kg-legend">
                {factions.map((f) => <span className="li" key={f.id}><span className="sw" style={{ background: f.color }} />{f.name.zh}</span>)}
              </div>
              {edges.length > 0 && (
                <div className="kg-polkey" aria-label="关系极性构成">
                  <span className="pk" data-pol="pos"><Heart size={11} aria-hidden /><b className="num">{polCounts.pos}</b>正向</span>
                  <span className="pk" data-pol="neg"><HeartCrack size={11} aria-hidden /><b className="num">{polCounts.neg}</b>敌对</span>
                  <span className="pk" data-pol="unk"><HelpCircle size={11} aria-hidden /><b className="num">{polCounts.unk}</b>未明</span>
                </div>
              )}
            </div>

            <div className="kg-resizer" onPointerDown={startDrag("r")} onDoubleClick={resetCol("r")} />

            {/* 右:详情抽屉 */}
            <div className="kg-drawer cj-pane-scroll">
              {sel ? (
                <>
                  <div className="dh">
                    <div className="dav" style={{ background: colorOf(sel) }}>{initial(sel.name.zh)}</div>
                    <div className="dh-id">
                      <div className="dnm">{sel.name.zh}</div>
                      <div className="dsub">{sel.role?.zh || sel.tagline?.zh || selFaction?.name.zh || "实体"}</div>
                    </div>
                  </div>
                  {sel.id === graph?.focusId && (
                    <div className="dh-focus"><Crosshair size={12} aria-hidden /> 焦点角色</div>
                  )}
                  <div className="ds">
                    <h5><Boxes size={12} aria-hidden /> 核心设定</h5>
                    <div className="kv"><span className="k">派系</span><span className="v">{selFaction?.name.zh ?? "未归派"}</span></div>
                    <div className="kv"><span className="k">重要度</span><span className="v">{sel.importance} / 5</span></div>
                    {selFaction && <div className="kv"><span className="k">阵营</span><span className="v">{selFaction.desc.zh}</span></div>}
                    <div className="ds-meter">
                      <Meter label="人物弧光" value={selArcPct} tone="brand" />
                    </div>
                  </div>
                  <div className="ds">
                    <h5><Network size={12} aria-hidden /> 关系网 <span className="ds-ct">{selEdges.length}</span></h5>
                    {selEdges.length ? selEdges.slice(0, 12).map((e) => {
                      const otherId = e.source === sel.id ? e.target : e.source
                      const other = nodes.find((n) => n.id === otherId)
                      const pol = relPolarity(e)
                      const PolIcon = POL_ICON[pol]
                      return (
                        <button type="button" className="rel-line" key={`${e.source}-${e.target}-${e.kind}`} onClick={() => setSelId(otherId)}>
                          <span className="rel-ico" data-pol={pol}><PolIcon size={12} aria-hidden /></span>
                          <span className="rn">{other?.name.zh ?? "未知实体"}</span>
                          <span className="pill" data-state={POL_STATE[pol]}>{e.label?.zh || kindLabel(e.kind)}</span>
                          <span className="rk num">{Math.round((e.strength || 0) * 100)}</span>
                          <ChevronRight size={13} className="rel-go" aria-hidden />
                        </button>
                      )
                    }) : <div className="ds-empty">暂无已知关系 · 随正文推进会自动补全</div>}
                  </div>
                </>
              ) : (
                <div className="empty kg-empty">
                  <div className="kg-empty-art mini"><EmptyArt variant="knowledge" /></div>
                  <span className="empty-ico"><Users size={22} aria-hidden /></span>
                  <div className="kg-empty-title">尚未选择实体</div>
                  <div className="kg-empty-desc">在左侧实体树或中间图谱中点选一个角色,这里会展开 TA 的设定与关系网。</div>
                </div>
              )}
            </div>
          </div>

          {/* 底部章节时间线 · 里程碑 — 跨全宽细条,固定不滚,保证整体一屏 */}
          <div className="kg-timeline">
            <div className="tl-head">
              <ScrollText size={13} className="tl-head-ico" aria-hidden />
              <span className="tl-head-title">章节时间线 · 里程碑</span>
              <span className="tl-head-ct num">{curChapter}/{maxCh}</span>
            </div>
            <div className="tl-track">
              <div className="tl-axis"><div className="fill" style={{ width: `${maxCh ? (curChapter / maxCh) * 100 : 0}%` }} /></div>
              {milestones.map((m) => (
                <div key={m.id} className="tl-mlabel" style={{ left: `${Math.max(2, Math.min(98, m.progress * 100))}%` }}>{m.label.zh}</div>
              ))}
              {Array.from({ length: maxCh }).map((_, i) => {
                const ch = i + 1
                const step = Math.max(1, Math.ceil(maxCh / 16))
                if (ch !== 1 && ch !== maxCh && ch !== curChapter && (ch - 1) % step !== 0) return null
                const cls = ch === curChapter ? "cur" : ch <= curChapter ? "done" : ""
                const left = `${maxCh > 1 ? ((ch - 1) / (maxCh - 1)) * 100 : 0}%`
                return (
                  <React.Fragment key={ch}>
                    <Link className={`tl-node ${cls}`} style={{ left }} title={`第 ${ch} 章`} href={`/editor?chapter=${ch}`} aria-label={`打开第 ${ch} 章`} />
                    <div className="tl-label" style={{ left }}>{ch}</div>
                  </React.Fragment>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
