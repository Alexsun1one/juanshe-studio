"use client"

import * as React from "react"
import useSWR from "swr"
import Link from "next/link"
import { Network, Search, Sparkles, Share2, Globe, Users, GitBranch } from "lucide-react"
import { toast } from "sonner"
import { fetchCast, fetchRelationshipGraph, fetchWorld } from "@/lib/api/client"
import type { Cast, Relation } from "@/lib/studio-data"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder, EmptyArt } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, StatLine, Meter, FoldCard } from "@/components/design/kit"
import "./characters.css"

const soft = { shouldRetryOnError: false }

function tierOf(c: Cast): "core" | "major" | "minor" {
  if (c.importance >= 4) return "core"
  if (c.importance === 3) return "major"
  return "minor"
}
const initial = (s: string) => (s || "?").trim().replace(/[《》"'\s]/g, "").charAt(0) || "?"

// 关系 kind 是内部英文枚举(family/ally/rival/neutral…),给用户看时翻成中文,
// 避免裸枚举 id 外泄。优先用后端给的 label.zh,缺失时回落到这里。
const REL_KIND_LABEL: Record<string, string> = {
  family: "亲缘", ally: "盟友", friend: "盟友", rival: "对手", enemy: "宿敌",
  romance: "情感", lover: "情感", mentor: "师承", subordinate: "从属", neutral: "关联",
}
const relLabel = (e: Relation, fallback = "关系") =>
  e.label?.zh || (e.kind ? REL_KIND_LABEL[e.kind] ?? fallback : fallback)

export default function CharactersPage() {
  const { bookId, booksLoading } = useWorkspace()
  const { data: cast } = useSWR(bookId ? ["cast", bookId] : null, () => fetchCast(bookId), soft)
  const { data: graph } = useSWR(bookId ? ["relgraph", bookId] : null, () => fetchRelationshipGraph(bookId), soft)
  const { data: world } = useSWR(bookId ? ["world", bookId] : null, () => fetchWorld(bookId), soft)

  const [factionFilter, setFactionFilter] = React.useState<string>("all")
  const [q, setQ] = React.useState("")
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  const factions = graph?.factions ?? []
  const factionMap = React.useMemo(
    () => new Map(factions.map((f) => [f.id, f])),
    [factions],
  )
  const edges = graph?.edges ?? []

  const list = cast ?? []
  const filtered = list.filter((c) => {
    if (factionFilter !== "all" && c.factionId !== factionFilter) return false
    if (q && !`${c.name.zh}${c.tagline?.zh ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })

  const selected = list.find((c) => c.id === selectedId) ?? list.find((c) => c.id === graph?.focusId) ?? list[0]
  const selFaction = selected?.factionId ? factionMap.get(selected.factionId) : undefined
  const selEdges = edges.filter((e) => e.source === selected?.id || e.target === selected?.id)

  // 阵营色:rel graph faction.color 优先,fallback cast.color
  const colorOf = (c: Cast) => (c.factionId && factionMap.get(c.factionId)?.color) || c.color || "var(--c-char)"

  // strip 统计
  const core = list.filter((c) => tierOf(c) === "core").length
  const major = list.filter((c) => tierOf(c) === "major").length
  const minor = list.filter((c) => tierOf(c) === "minor").length
  const settingCount = (world ?? []).reduce((s, w) => s + (w.count || 0), 0)
  // 平均弧光推进(角色弧线整体完成度的概览指标)
  const avgArc = list.length
    ? Math.round((list.reduce((s, c) => s + (c.arc || 0), 0) / list.length) * 100)
    : 0
  // 关系类型分布
  const kindCounts = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const e of edges) {
      const k = relLabel(e, "其它")
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [edges])

  const characterPrompt = [
    "请基于当前角色矩阵衍生 3 个新角色候选。",
    "",
    "已有核心角色:",
    ...(list.length
      ? list.slice(0, 12).map((c) => `- ${c.name.zh}: ${c.tagline?.zh || "暂无定位"} · 重要度 ${c.importance}/5 · 弧光 ${Math.round((c.arc || 0) * 100)}%`)
      : ["- 暂无角色,请先从作品设定反推主角/对手/盟友"]),
    "",
    "已有阵营:",
    ...(factions.length
      ? factions.map((f) => `- ${f.name.zh}: ${f.desc.zh}`)
      : ["- 暂无阵营,请同时提出阵营归属建议"]),
    "",
    "输出要求:每个角色给出姓名、阵营、功能定位、与主角/反派/关键物件的关系、首次出场章节建议、不能破坏现有设定的约束。",
  ].join("\n")

  const copyCharacterPrompt = async () => {
    try {
      await navigator.clipboard.writeText(characterPrompt)
      toast.success("已复制角色衍生提示")
    } catch {
      toast.error("复制失败,请手动选择文本复制")
    }
  }

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="角色与设定" sub="本地工作区还没有作品,创建后这里会出现角色卡、关系矩阵与设定库。" />
  }

  return (
    <div className="cj-screen cj-characters">
      {/* ── 顶部工作条:像素点睛 + 标题 + 一行密集 KPI + 操作 ── */}
      <header className="cj-workhead ch-head">
        <div className="ch-head-lead">
          <PixelBadge kind="characters" size={40} className="ch-hero-pixel" ariaLabel="角色与设定" />
          <div className="ch-head-titles">
            <h1 className="page-title">角色与设定</h1>
            <StatLine
              className="ch-head-stat"
              items={[
                { n: core, label: "核心 ≥4", tone: "brand" },
                { n: major, label: "重要 =3" },
                { n: minor, label: "配角 ≤2" },
                { n: factions.length, label: "派系", tone: "amber" },
                { n: edges.length, label: "关系", tone: "rose" },
              ]}
            />
          </div>
          <div className="page-actions ch-head-actions">
            <button type="button" className="btn sm" onClick={copyCharacterPrompt}><Sparkles size={12} /> 复制衍生提示</button>
            <Link className="btn sm" href="/graph"><Network size={12} /> 故事图谱</Link>
            <Link className="btn primary sm" href="/knowledge"><Share2 size={12} /> 知识资产</Link>
          </div>
        </div>

        {/* 关键指标芯片 — 角色总数 / 关系连接 / 设定条数 / 平均弧光 */}
        <div className="ch-kpis">
          <KpiChip label="角色总数" value={list.length} unit="位" tone="brand" sub={`核心 ${core} · 重要 ${major}`} />
          <KpiChip label="关系连接" value={edges.length} unit="条" tone="rose" sub={`${kindCounts.length} 种类型`} />
          <KpiChip label="世界观设定" value={settingCount} unit="条" tone="amber" sub={`${(world ?? []).length} 个分类`} />
          <KpiChip label="平均弧光" value={avgArc} unit="%" tone="ok" sub={`${factions.length} 派系阵营`} />
        </div>
      </header>

      {/* ── 主体:左 关系网络 + 名册;右 Inspector 角色档案 + 设定折叠 ── */}
      <div className="cj-screen-body ch-body">
        <div className="cj-mainpane ch-mainpane">
          {/* 过滤条 — 搜索 + 派系 chip */}
          <div className="cf-row">
            <div className="cf-search">
              <Search size={14} />
              <input placeholder="搜索角色 · 别名 · 标签" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button type="button" className={`cf-chip${factionFilter === "all" ? " active" : ""}`} onClick={() => setFactionFilter("all")} aria-pressed={factionFilter === "all"}>全部 {list.length}</button>
            {factions.map((f) => {
              const n = list.filter((c) => c.factionId === f.id).length
              if (!n) return null
              return (
                <button type="button" key={f.id} className={`cf-chip${factionFilter === f.id ? " active" : ""}`} onClick={() => setFactionFilter(f.id)} aria-pressed={factionFilter === f.id}>
                  {f.name.zh} {n}
                </button>
              )
            })}
          </div>

          <div className="cj-pane-scroll ch-main-scroll scroll-thin">
            {/* === 关系网络图 ===
                重要度高的角色在内圈,边按极性着色(正/负/未明),hover/click 聚焦邻居 */}
            <CharacterNetwork
              cast={filtered}
              edges={edges}
              colorOf={colorOf}
              selectedId={selected?.id ?? null}
              onSelect={(id) => setSelectedId(id)}
              loading={!cast}
            />

            {/* 紧凑名册 — 当作过滤器/快速跳转 */}
            <div className="roster-strip">
              <div className="roster-head">
                <span>角色名册 <span className="muted-c">· {filtered.length} 位</span></span>
                <span className="muted-c roster-hint">点击切换详情</span>
              </div>
              <div className="roster-chips">
                {!cast && <div className="skel" style={{ height: 36, gridColumn: "1 / -1" }} />}
                {cast && filtered.length === 0 && <div className="empty">没有匹配的角色</div>}
                {filtered.map((c) => {
                  const color = colorOf(c)
                  const arcPct = Math.round((c.arc || 0) * 100)
                  const relN = edges.filter((e) => e.source === c.id || e.target === c.id).length
                  const sel = selected?.id === c.id
                  return (
                    <button
                      type="button"
                      key={c.id}
                      className={`roster-chip${sel ? " sel" : ""}`}
                      onClick={() => setSelectedId(c.id)}
                      title={`${c.name.zh} · 重要度 ${c.importance}/5 · 弧光 ${arcPct}% · ${relN} 条关系`}
                    >
                      <span className="rc-av" style={{ background: color }}>{initial(c.name.zh)}</span>
                      <span className="rc-name">{c.name.zh}</span>
                      <span className="rc-meta">
                        <span className="rc-stars" title="重要度">{"★".repeat(c.importance)}</span>
                        <span className="rc-arc" title="弧光"><i style={{ width: `${arcPct}%`, background: color }} /></span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {/* ── 右侧 Inspector:角色档案(常驻) + 设定/派系/关系折叠卡(卡内滚) ── */}
        <aside className="cj-inspector ch-inspector">
          <div className="cj-pane-scroll ch-insp-scroll scroll-thin">
            {/* 选中角色档案 */}
            <section className="card det-card">
              {selected ? (
                <>
                  <div className="det-hero">
                    <div className="row1">
                      <div className="av" style={{ background: colorOf(selected) }}>{initial(selected.name.zh)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="nm">{selected.name.zh}</div>
                        <div className="al">{selected.tagline?.zh || "—"}</div>
                      </div>
                    </div>
                    <div className="tag-row">
                      {selFaction && <span className="tag brand">{selFaction.name.zh}</span>}
                      <span className="tag" style={{ background: "var(--c-char-bg)", color: "var(--c-char)" }}>重要度 {selected.importance}/5</span>
                      <span className="tag info">弧光 {Math.round((selected.arc || 0) * 100)}%</span>
                      {selected.id === graph?.focusId && <span className="tag ok">焦点角色</span>}
                    </div>
                    <Link href={`/characters/${encodeURIComponent(selected.name.zh)}`} className="btn sm" style={{ marginTop: 10, width: "100%", justifyContent: "center" }}>
                      <Network size={12} /> 查看故事图谱档案(状态·关系·邻居)
                    </Link>
                  </div>

                  <div className="det-stats">
                    <div className="det-stat"><div className="lbl">重要度</div><div className="v v-brand">{selected.importance}</div></div>
                    <div className="det-stat"><div className="lbl">弧光</div><div className="v v-rose">{Math.round((selected.arc || 0) * 100)}<span style={{ fontSize: 11 }}>%</span></div></div>
                    <div className="det-stat"><div className="lbl">关系</div><div className="v v-ok">{selEdges.length}</div></div>
                    <div className="det-stat"><div className="lbl">派系</div><div className="v v-warm" style={{ fontSize: 13 }}>{selFaction?.name.zh.slice(0, 4) ?? "—"}</div></div>
                  </div>

                  <div className="det-sec">
                    <h5>弧光推进</h5>
                    <Meter
                      label={`已推进 · 重要度 ${selected.importance}/5`}
                      value={Math.round((selected.arc || 0) * 100)}
                      tone="brand"
                    />
                  </div>

                  <div className="det-sec">
                    <h5>核心档案</h5>
                    <div className="det-row"><span className="k">定位</span><span className="v">{selected.tagline?.zh || "—"}</span></div>
                    <div className="det-row"><span className="k">派系</span><span className="v">{selFaction ? `${selFaction.name.zh} — ${selFaction.desc.zh}` : "未归派"}</span></div>
                    <div className="det-row"><span className="k">弧光</span><span className="v">已推进 {Math.round((selected.arc || 0) * 100)}% · 重要度 {selected.importance}/5</span></div>
                  </div>

                  <div className="det-sec det-sec-rel">
                    <h5>关系 ({selEdges.length})</h5>
                    {selEdges.length ? selEdges.slice(0, 8).map((e, i) => {
                      const otherId = e.source === selected.id ? e.target : e.source
                      const other = list.find((c) => c.id === otherId)
                      const neg = /敌|仇|恨|对抗|宿敌|rival|enemy|背叛|反目/.test(`${e.kind ?? ""}${e.label?.zh ?? ""}`)
                      return (
                        <div className="det-row" key={i}>
                          <span className="k">{other?.name.zh ?? "未命名角色"}</span>
                          <span className="v" style={neg ? { color: "var(--err-500)" } : undefined}>
                            {relLabel(e)} — 强度 {Math.round((e.strength || 0) * 100)}
                            {e.evolved ? " · 已演变" : ""}
                          </span>
                        </div>
                      )
                    }) : <div className="muted" style={{ fontSize: 12 }}>暂无关系记录</div>}
                  </div>
                </>
              ) : (
                <div className="empty">选择左侧角色查看档案</div>
              )}
            </section>

            {/* 设定 / 派系 / 关系类型 — 折叠卡(卡内滚),不撑破 Inspector */}
            <FoldCard
              title="世界观 · 设定"
              icon={<Globe size={15} />}
              count={`${settingCount} 条`}
              scrollable
              maxHeight={180}
            >
              <div className="ms-list">
                {(world ?? []).map((w) => (
                  <div className="ms-row" key={w.id}><span>{w.title.zh}</span><b>{w.count}</b></div>
                ))}
                {!(world ?? []).length && <div className="ms-empty">尚未抽取</div>}
              </div>
            </FoldCard>

            <FoldCard
              title="派系 · 阵营"
              icon={<Users size={15} />}
              count={`${factions.length} 个`}
              scrollable
              maxHeight={180}
            >
              <div className="ms-list">
                {factions.map((f) => (
                  <div className="ms-row" key={f.id}><span><span className="ms-dot" style={{ background: f.color, marginRight: 6 }} />{f.name.zh}</span><b>{list.filter((c) => c.factionId === f.id).length} 人</b></div>
                ))}
                {!factions.length && <div className="ms-empty">尚未划分</div>}
              </div>
            </FoldCard>

            <FoldCard
              title="关系类型"
              icon={<GitBranch size={15} />}
              count={`${edges.length} 条`}
              defaultOpen={false}
              scrollable
              maxHeight={180}
            >
              <div className="ms-list">
                {kindCounts.map(([k, n]) => (
                  <div className="ms-row" key={k}><span>{k}</span><b>{n}</b></div>
                ))}
                {!kindCounts.length && <div className="ms-empty">尚未抽取关系</div>}
              </div>
            </FoldCard>
          </div>
        </aside>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// CharacterNetwork — 角色关系网络图(纯 SVG,无 D3 依赖)
//
// 设计:
//  - 按 importance 分内/中/外 3 圈,核心节点在内
//  - 每圈节点等角度分布,稳定排序(按 id)使位置确定
//  - 边按极性着色(正/负/未明),粗细按 strength
//  - hover/select 节点 → 高亮邻居,其他节点淡化
//  - 节点直径与 importance 成正比;选中节点有品牌色环
// ───────────────────────────────────────────────────────────────────────────
function CharacterNetwork({
  cast,
  edges,
  colorOf,
  selectedId,
  onSelect,
  loading = false,
}: {
  cast: Cast[]
  edges: Relation[]
  colorOf: (c: Cast) => string
  selectedId: string | null
  onSelect: (id: string) => void
  loading?: boolean
}) {
  const [hoverId, setHoverId] = React.useState<string | null>(null)

  // 按 importance 分组并稳定排序
  const tiers = React.useMemo(() => {
    const inner = cast.filter((c) => c.importance >= 4)
    const mid = cast.filter((c) => c.importance === 3)
    const outer = cast.filter((c) => c.importance <= 2)
    const sort = (arr: Cast[]) => [...arr].sort((a, b) => a.id.localeCompare(b.id))
    return [sort(inner), sort(mid), sort(outer)]
  }, [cast])

  const W = 520, H = 480
  const cx = W / 2, cy = H / 2
  const radii = [88, 168, 220]  // 内/中/外圈半径

  const positions = React.useMemo(() => {
    const pos = new Map<string, { x: number; y: number; r: number }>()
    tiers.forEach((tier, ringIdx) => {
      if (tier.length === 0) return
      // 1 个节点放正中心(内圈)或正上方(外圈)
      const isInnerSolo = ringIdx === 0 && tier.length === 1
      tier.forEach((c, i) => {
        const angle = isInnerSolo
          ? 0
          : (i / tier.length) * Math.PI * 2 - Math.PI / 2  // 第一个在 12 点钟方向
        const r = isInnerSolo ? 0 : radii[ringIdx]
        const x = cx + Math.cos(angle) * r
        const y = cy + Math.sin(angle) * r
        const nodeR = c.importance >= 4 ? 22 : c.importance === 3 ? 17 : 13
        pos.set(c.id, { x, y, r: nodeR })
      })
    })
    return pos
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiers])

  // 高亮目标:hover > select > 全部
  const focusId = hoverId ?? selectedId
  const focusEdgeIds = React.useMemo(() => {
    if (!focusId) return new Set<string>()
    const ids = new Set<string>()
    edges.forEach((e, i) => {
      if (e.source === focusId || e.target === focusId) {
        ids.add(`${i}`)
        ids.add(e.source)
        ids.add(e.target)
      }
    })
    return ids
  }, [focusId, edges])

  const edgeStroke = (r: Relation) => {
    const t = `${r.kind ?? ""} ${r.label?.zh ?? ""}`
    if (/未明|谜|unknown|疑/.test(t)) return "#C9C0F4"
    if (/敌|仇|恨|对抗|宿敌|rival|enemy|背叛|反目/.test(t)) return "#E07A7A"
    return "#7EC4A8"
  }

  if (cast.length === 0) {
    return (
      <div className="char-network empty-net">
        <div className="char-empty-art" aria-hidden>
          <EmptyArt variant="characters" />
        </div>
        <h2>{loading ? "正在整理角色档案" : "角色席位还在等人入场"}</h2>
        <p>{loading ? "本地角色库还在读取,先把选角台和关系线铺好。" : "建立人物档案后,这里会渲染角色关系网络、阵营与弧光推进。"}</p>
      </div>
    )
  }

  return (
    <div className="char-network">
      <div className="cn-head">
        <div className="cn-title">
          关系网络
          <span className="muted-c">· {cast.length} 节点 · {edges.length} 条边{focusId ? " · 已聚焦" : ""}</span>
        </div>
        <div className="cn-legend">
          <span><i style={{ background: "#7EC4A8" }} />正向</span>
          <span><i style={{ background: "#E07A7A" }} />对抗</span>
          <span><i style={{ background: "#C9C0F4" }} />未明</span>
          <span className="cn-rings">内圈 · 核心 ★4–5 / 中圈 ★3 / 外圈 ★1–2</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="cn-svg" role="img" aria-label="角色关系网络">
        {/* 同心圆参考线 */}
        {radii.map((r) => (
          <circle key={r} cx={cx} cy={cy} r={r} fill="none" stroke="var(--line-2)" strokeDasharray="3 4" strokeWidth={1} />
        ))}
        {/* 边层 */}
        <g>
          {edges.map((e, i) => {
            const sp = positions.get(e.source)
            const tp = positions.get(e.target)
            if (!sp || !tp) return null
            const isActive = !focusId || focusEdgeIds.has(`${i}`)
            const width = Math.max(0.8, Math.min(3, (e.strength || 0.5) * 3))
            const color = edgeStroke(e)
            return (
              <line
                key={`${e.source}-${e.target}-${i}`}
                x1={sp.x} y1={sp.y} x2={tp.x} y2={tp.y}
                stroke={color}
                strokeWidth={width}
                opacity={isActive ? 0.65 : 0.10}
                strokeLinecap="round"
              >
                <title>{relLabel(e)} · 强度 {Math.round((e.strength || 0) * 100)}</title>
              </line>
            )
          })}
        </g>
        {/* 节点层 */}
        <g>
          {cast.map((c) => {
            const p = positions.get(c.id)
            if (!p) return null
            const isActive = !focusId || focusEdgeIds.has(c.id)
            const isSel = selectedId === c.id
            const isHover = hoverId === c.id
            const color = colorOf(c)
            return (
              <g
                key={c.id}
                className="cn-node"
                transform={`translate(${p.x},${p.y})`}
                style={{ cursor: "pointer", opacity: isActive ? 1 : 0.18 }}
                onClick={() => onSelect(c.id)}
                onMouseEnter={() => setHoverId(c.id)}
                onMouseLeave={() => setHoverId(null)}
              >
                {(isSel || isHover) && (
                  <circle r={p.r + 5} fill="none" stroke="var(--brand-500)" strokeWidth={2} opacity={0.8} />
                )}
                <circle r={p.r} fill={color} stroke="white" strokeWidth={2} />
                <text
                  textAnchor="middle"
                  dy={p.r >= 18 ? 5 : 4}
                  fill="white"
                  fontSize={p.r >= 18 ? 14 : 11}
                  fontWeight={700}
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {initial(c.name.zh)}
                </text>
                <text
                  textAnchor="middle"
                  y={p.r + 14}
                  fill="var(--ink-700)"
                  fontSize={p.r >= 18 ? 11.5 : 10.5}
                  fontWeight={isSel || isHover ? 700 : 500}
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {c.name.zh}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
