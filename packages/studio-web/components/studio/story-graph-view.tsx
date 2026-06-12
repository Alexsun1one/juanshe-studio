"use client"

import * as React from "react"
import type { StoryGraph, StoryGraphNode } from "@/lib/api/client"
import { predicateLabel } from "@/lib/labels"
import { CharacterPixel } from "@/components/design/character-pixel"

/**
 * 实体类型 → 颜色:走 design.css 暖纸柔紫世界观 token(亮 / 暗双套自动切换,暗色深堇紫底自带亮档)。
 * 人物=柔紫(--brand-500)/ 物件=暖橙(--c-focus)/ 地点=沉静青(--c-fore)/
 * 组织=玫瑰(--c-memory)/ 概念=琥珀(--accent-amber-deep)/ 其它=暖灰墨(--ink-400)。
 * graph/page.tsx 的环形图 / 图例 / 枢纽列表直接 import 本表,实体配色全站只此一份。
 */
export const TYPE_COLOR: Record<string, string> = {
  person: "var(--brand-500)",
  item: "var(--c-focus)",
  place: "var(--c-fore)",
  org: "var(--c-memory)",
  concept: "var(--accent-amber-deep)",
  other: "var(--ink-400)",
}
const typeColor = (t: string) => TYPE_COLOR[t] ?? TYPE_COLOR.other
/**
 * 像素头像稳定取色:CharacterPixel 是逐格 rect 像素画,身份锚点色用字面量保证跨页一致;
 * 值与 token 对应:brand-500 / c-fore / c-focus / c-style / c-char / st-error / brand-400 /
 * 暖卡其(ink-500 同族,保留一个低饱和位)。
 */
const PERSON_PALETTE = ["#6E5BFA", "#2FA39A", "#F08A4B", "#B173E8", "#2BB97A", "#E04848", "#9D8AFF", "#8A7A5C"]
export function personColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return PERSON_PALETTE[Math.abs(h) % PERSON_PALETTE.length]
}

/**
 * 关系类型 → 颜色 / 线型。基于 predicate 文本启发式判断。
 * 亲友绿 / 敌对红 / 师徒琥珀(师承金线)/ 商业暖灰 / 未明紫 ——
 * 颜色集中在 EDGE_COLOR,连线与底部图例同一来源,避免两处漂移。
 */
const EDGE_COLOR = {
  敌对: "var(--st-error)",
  亲友: "var(--c-char)",
  师徒: "var(--accent-amber-deep)",
  商业: "var(--ink-400)",
  未明: "var(--brand-400)",
  默认: "var(--ink-300)",
} as const
type EdgeStyle = { color: string; dash: string; weight: number; kind: string }
function edgeStyle(predicate: string): EdgeStyle {
  const p = (predicate ?? "").toLowerCase()
  // 敌对(实线红)
  if (/敌|仇|恨|对抗|宿敌|rival|enemy|foe|hostile|背叛|反目/.test(p))
    return { color: EDGE_COLOR.敌对, dash: "0", weight: 2.4, kind: "敌对" }
  // 亲友(实线绿)
  if (/亲|爱|友|爱人|家|妻|夫|父|母|子|女|友|love|family|friend|ally|妹|兄|姐|弟/.test(p))
    return { color: EDGE_COLOR.亲友, dash: "0", weight: 2.0, kind: "亲友" }
  // 师徒(实线琥珀)
  if (/师|徒|teach|mentor|student|学生|师傅|师父/.test(p))
    return { color: EDGE_COLOR.师徒, dash: "0", weight: 1.8, kind: "师徒" }
  // 商业/同事(暖灰)
  if (/同事|partner|商|合|交易|business|colleague|上下级|老板|boss|员工/.test(p))
    return { color: EDGE_COLOR.商业, dash: "0", weight: 1.4, kind: "商业" }
  // 未明(虚线紫)
  if (/未明|疑|unknown|mystery|谜/.test(p))
    return { color: EDGE_COLOR.未明, dash: "4 4", weight: 1.4, kind: "未明" }
  // 默认(浅暖灰实线)
  return { color: EDGE_COLOR.默认, dash: "0", weight: 1.2, kind: predicate || "关系" }
}

const W = 1000
const H = 640

/** 节点视觉半径:与渲染层 radiusOf 同一公式,布局碰撞消解要用同一口径。 */
function nodeRadius(degree: number, maxDeg: number): number {
  return 12 + Math.round((degree / Math.max(1, maxDeg)) * 16)
}

/**
 * 力导向布局(Fruchterman–Reingold 改良版),在 useMemo 里一次性算稳定坐标,无依赖、确定性。
 * 针对故事图谱的真实形态(主角 = 高度数枢纽,邻居动辄 30+)做了三处关键修正:
 * 1. 斥力按度数加权 —— 枢纽把它的邻居环推得更开,解决"全图坍缩成一坨";
 * 2. 理想边长按度数拉长 —— 连枢纽的边天然更长,形成放射状而不是抱团;
 * 3. 收尾跑碰撞消解 —— 在最终画布坐标系里把残余重叠硬性推开(节点半径 + 标签呼吸位)。
 * 另外迭代数随节点规模递减,长篇书几百实体时不再卡主线程。
 */
function computeLayout(nodes: StoryGraphNode[], edges: { source: string; target: string }[]) {
  const n = nodes.length
  const map = new Map<string, { x: number; y: number }>()
  if (n === 0) return map
  if (n === 1) { map.set(nodes[0].id, { x: W / 2, y: H / 2 }); return map }

  const idIndex = new Map(nodes.map((nd, i) => [nd.id, i]))
  const k = Math.sqrt((W * H) / n) * 0.72
  const pos = nodes.map((_, i) => {
    const angle = i * 2.399963 // 黄金角,初始铺开避免重叠
    const radius = Math.sqrt((i + 0.5) / n) * Math.min(W, H) * 0.42
    return { x: W / 2 + Math.cos(angle) * radius, y: H / 2 + Math.sin(angle) * radius }
  })
  const links = edges
    .map((e) => ({ s: idIndex.get(e.source), t: idIndex.get(e.target) }))
    .filter((l): l is { s: number; t: number } => l.s != null && l.t != null && l.s !== l.t)

  // 布局用度数从边集现算(与渲染层 n.degree 同源不同径,避免后端字段缺失时布局退化)
  const deg = new Array<number>(n).fill(0)
  for (const l of links) { deg[l.s]++; deg[l.t]++ }
  const maxDeg = Math.max(1, ...deg)

  // 大图降迭代:38 节点跑 320 轮没问题;几百实体时 O(n²·iter) 会卡主线程,按规模递减
  const iterations = n <= 80 ? 320 : n <= 200 ? 160 : 96
  let temp = W * 0.1
  for (let it = 0; it < iterations; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }))
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x
        const dy = pos[i].y - pos[j].y
        const dist = Math.hypot(dx, dy) || 0.01
        // 度数加权斥力:枢纽(主角)对周围推力更强,防止 30+ 邻居挤进同一坨
        const w = 1 + Math.sqrt(deg[i] * deg[j]) * 0.16
        const rep = (k * k * w) / dist
        const ux = dx / dist, uy = dy / dist
        disp[i].x += ux * rep; disp[i].y += uy * rep
        disp[j].x -= ux * rep; disp[j].y -= uy * rep
      }
    }
    for (const l of links) {
      const dx = pos[l.s].x - pos[l.t].x
      const dy = pos[l.s].y - pos[l.t].y
      const dist = Math.hypot(dx, dy) || 0.01
      // 理想边长按两端最大度数拉伸:连枢纽的边更长 → 放射状布局
      const ideal = k * (1 + Math.log1p(Math.max(deg[l.s], deg[l.t])) * 0.3)
      const att = (dist * dist) / ideal
      const ux = dx / dist, uy = dy / dist
      disp[l.s].x -= ux * att; disp[l.s].y -= uy * att
      disp[l.t].x += ux * att; disp[l.t].y += uy * att
    }
    for (let i = 0; i < n; i++) {
      disp[i].x += (W / 2 - pos[i].x) * 0.006
      disp[i].y += (H / 2 - pos[i].y) * 0.006
      const d = Math.hypot(disp[i].x, disp[i].y) || 0.01
      const cap = Math.min(d, temp)
      pos[i].x += (disp[i].x / d) * cap
      pos[i].y += (disp[i].y / d) * cap
    }
    temp *= 0.965
  }

  // fit-to-canvas;限制放大倍数,避免节点很少时小聚团被过度拉伸到画布边缘
  const xs = pos.map((p) => p.x), ys = pos.map((p) => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const pad = 46
  const s = Math.min(
    (W - pad * 2) / Math.max(1, maxX - minX),
    (H - pad * 2) / Math.max(1, maxY - minY),
    1.5,
  )
  const fitted = pos.map((p) => ({
    x: pad + (p.x - minX) * s + ((W - pad * 2) - (maxX - minX) * s) / 2,
    y: pad + (p.y - minY) * s + ((H - pad * 2) - (maxY - minY) * s) / 2,
  }))

  // 碰撞消解:在最终坐标系里把残余重叠对推开(半径 + 14px 标签呼吸位),并夹回画布
  const radii = deg.map((d) => nodeRadius(d, maxDeg))
  for (let round = 0; round < 36; round++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = fitted[j].x - fitted[i].x
        const dy = fitted[j].y - fitted[i].y
        const dist = Math.hypot(dx, dy) || 0.01
        const minDist = radii[i] + radii[j] + 14
        if (dist < minDist) {
          const push = (minDist - dist) / 2
          const ux = dx / dist, uy = dy / dist
          fitted[i].x -= ux * push; fitted[i].y -= uy * push
          fitted[j].x += ux * push; fitted[j].y += uy * push
          moved = true
        }
      }
    }
    if (!moved) break
  }
  for (let i = 0; i < n; i++) {
    fitted[i].x = Math.min(W - pad, Math.max(pad, fitted[i].x))
    fitted[i].y = Math.min(H - pad, Math.max(pad, fitted[i].y))
  }

  nodes.forEach((nd, i) => { map.set(nd.id, fitted[i]) })
  return map
}

export function StoryGraphView({
  graph,
  onNodeClick,
  emptyAction,
}: {
  graph: StoryGraph
  onNodeClick?: (node: StoryGraphNode) => void
  emptyAction?: React.ReactNode
}) {
  const { nodes, edges } = graph
  const layout = React.useMemo(() => computeLayout(nodes, edges), [nodes, edges])
  const maxDeg = React.useMemo(() => Math.max(1, ...nodes.map((n) => n.degree)), [nodes])

  const [hover, setHover] = React.useState<string | null>(null)
  /** 选中 = "focus mode":显示 1-2 层邻居,其他全部淡化。再点同一节点取消。 */
  const [focusId, setFocusId] = React.useState<string | null>(null)
  /** 展开深度:1 = 直接邻居,2 = 2 跳邻居。选中 + Shift 可加深 */
  const [focusDepth, setFocusDepth] = React.useState<number>(1)
  const [view, setView] = React.useState({ tx: 0, ty: 0, k: 1 })
  /** 节点拖拽的位置覆盖(覆盖布局算出的坐标) */
  const [posOverride, setPosOverride] = React.useState<Map<string, { x: number; y: number }>>(new Map())
  const svgRef = React.useRef<SVGSVGElement>(null)
  /** 画布拖拽 vs 节点拖拽,二选一 */
  const canvasDrag = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const nodeDrag = React.useRef<{ id: string; startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null)

  // SVG 坐标系换算:client -> svg local
  const clientToSvg = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: clientX, y: clientY }
    const pt = svg.createSVGPoint()
    pt.x = clientX; pt.y = clientY
    const m = svg.getScreenCTM()
    if (!m) return { x: clientX, y: clientY }
    const inv = m.inverse()
    const out = pt.matrixTransform(inv)
    // 还要再补 view 的 translate/scale 反变换,得到内部 g 里的坐标
    const localX = (out.x - view.tx) / view.k
    const localY = (out.y - view.ty) / view.k
    return { x: localX, y: localY }
  }

  // 合并:posOverride 优先于 layout
  const posOf = (id: string) => posOverride.get(id) ?? layout.get(id)

  // 焦点模式:从 focusId 出发 BFS focusDepth 层
  const focusSet = React.useMemo(() => {
    if (!focusId) return null
    const adjacency = new Map<string, Set<string>>()
    for (const e of edges) {
      if (!adjacency.has(e.source)) adjacency.set(e.source, new Set())
      if (!adjacency.has(e.target)) adjacency.set(e.target, new Set())
      adjacency.get(e.source)!.add(e.target)
      adjacency.get(e.target)!.add(e.source)
    }
    const visited = new Set<string>([focusId])
    let frontier = new Set<string>([focusId])
    for (let d = 0; d < focusDepth; d++) {
      const next = new Set<string>()
      for (const id of frontier) {
        const adj = adjacency.get(id)
        if (!adj) continue
        for (const a of adj) if (!visited.has(a)) { visited.add(a); next.add(a) }
      }
      frontier = next
    }
    return visited
  }, [focusId, focusDepth, edges])

  // 综合活跃集 = focus(优先)或 hover 邻居
  const activeSet: Set<string> | null = focusSet
    ?? (hover
      ? (() => {
        const s = new Set<string>([hover])
        for (const e of edges) {
          if (e.source === hover) s.add(e.target)
          if (e.target === hover) s.add(e.source)
        }
        return s
      })()
      : null)

  const radiusOf = (n: StoryGraphNode) => nodeRadius(n.degree, maxDeg)

  // ─── 缩放 / 平移 / 拖节点 ────────────────────────────────────────
  // 滚轮缩放走原生非 passive 监听:React 18 的合成 wheel 是 passive 的,
  // preventDefault() 不生效 —— 图上缩放会连带整页滚动,且 console 每滚一格刷一条错。
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault()
      setView((v) => {
        const k = Math.min(3.0, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.12 : 0.89)))
        return { ...v, k }
      })
    }
    svg.addEventListener("wheel", onWheelNative, { passive: false })
    return () => svg.removeEventListener("wheel", onWheelNative)
  }, [])
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (nodeDrag.current) return
    canvasDrag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    // 节点拖拽优先(局部 pointermove 已经处理)
    if (nodeDrag.current) {
      const local = clientToSvg(e.clientX, e.clientY)
      setPosOverride((prev) => {
        const next = new Map(prev)
        next.set(nodeDrag.current!.id, { x: local.x, y: local.y })
        return next
      })
      if (Math.hypot(e.clientX - nodeDrag.current.startX, e.clientY - nodeDrag.current.startY) > 4) {
        nodeDrag.current.moved = true
      }
      return
    }
    if (!canvasDrag.current) return
    setView((v) => ({ ...v, tx: canvasDrag.current!.tx + (e.clientX - canvasDrag.current!.x), ty: canvasDrag.current!.ty + (e.clientY - canvasDrag.current!.y) }))
  }
  const onCanvasPointerUp = () => {
    canvasDrag.current = null
    // 节点拖拽收尾在 node 自己的 onPointerUp 里处理
  }
  const onNodePointerDown = (e: React.PointerEvent, n: StoryGraphNode) => {
    e.stopPropagation()
    const p = posOf(n.id)
    if (!p) return
    nodeDrag.current = { id: n.id, startX: e.clientX, startY: e.clientY, baseX: p.x, baseY: p.y, moved: false }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onNodePointerUp = (e: React.PointerEvent, n: StoryGraphNode) => {
    e.stopPropagation()
    const drag = nodeDrag.current
    nodeDrag.current = null
    // 没拖动 = 视为点击 → 切焦点
    if (drag && !drag.moved && drag.id === n.id) {
      if (focusId === n.id) {
        // 同节点二次点击 → 加深 1 层(最多 3 层)
        if (focusDepth < 3) setFocusDepth((d) => d + 1)
        else { setFocusId(null); setFocusDepth(1) }
      } else {
        setFocusId(n.id)
        setFocusDepth(1)
      }
    }
  }
  const resetView = () => { setView({ tx: 0, ty: 0, k: 1 }); setPosOverride(new Map()); setFocusId(null); setFocusDepth(1) }
  const activateNode = (node: StoryGraphNode) => onNodeClick?.(node)

  if (nodes.length === 0) {
    return (
      <div className="sg-empty">
        <div className="sg-empty-ill" />
        <p className="sg-empty-t">故事图谱还是空的</p>
        <p className="sg-empty-s">写作或续写时,章节分析官会把角色、关系、状态自动入图;也可在「角色与设定」补全 character_matrix 后重跑。</p>
        {emptyAction ? <div className="sg-empty-actions">{emptyAction}</div> : null}
      </div>
    )
  }

  return (
    <div className="sg-wrap">
      <div className="sg-toolbar">
        <span className="sg-stat">{graph.stats.entities} 实体 · {graph.stats.activeRelations} 关系</span>
        {focusId && (() => {
          const focused = nodes.find((n) => n.id === focusId)
          return (
            <span className="sg-focus-pill" onClick={() => { setFocusId(null); setFocusDepth(1) }}>
              聚焦:{focused?.name ?? focusId} · {focusDepth} 层 · ✕
            </span>
          )
        })()}
        <span className="sg-sp" />
        <button type="button" className="sg-btn" onClick={() => setView((v) => ({ ...v, k: Math.min(3.0, v.k * 1.18) }))} title="放大">＋</button>
        <button type="button" className="sg-btn" onClick={() => setView((v) => ({ ...v, k: Math.max(0.3, v.k * 0.85) }))} title="缩小">－</button>
        <button type="button" className="sg-btn" onClick={resetView} title="复位(还原拖动 + 取消聚焦)">复位</button>
      </div>
      <svg
        ref={svgRef}
        className="sg-svg"
        viewBox={`0 0 ${W} ${H}`}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerLeave={onCanvasPointerUp}
      >
        {/* edge 箭头 marker(可选,目前关系图谱是无向,留作扩展) */}
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
          {/* ─ edges:bezier 曲线 + 关系类型颜色 ─ */}
          {edges.map((e, i) => {
            const a = posOf(e.source), b = posOf(e.target)
            if (!a || !b) return null
            const style = edgeStyle(e.predicate)
            const active = !activeSet || (activeSet.has(e.source) && activeSet.has(e.target))
            // 控制点:中点 + 垂直偏移,做出温柔的曲线
            const mx = (a.x + b.x) / 2
            const my = (a.y + b.y) / 2
            const dx = b.x - a.x, dy = b.y - a.y
            const len = Math.hypot(dx, dy) || 1
            const offset = Math.min(40, len * 0.18) * ((i % 2 === 0) ? 1 : -1)  // 交替正负,看着更自然
            const cx = mx + (-dy / len) * offset
            const cy = my + (dx / len) * offset
            const showLabel = hover && (e.source === hover || e.target === hover) && active
            return (
              <g key={i} opacity={active ? 0.85 : 0.10}>
                <path
                  d={`M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`}
                  fill="none"
                  stroke={style.color}
                  strokeWidth={style.weight}
                  strokeLinecap="round"
                  strokeDasharray={style.dash}
                  opacity={focusId && active ? 0.95 : undefined}
                />
                {showLabel && (
                  <text x={cx} y={cy - 4} textAnchor="middle" className="sg-edge-label" style={{ fill: style.color }}>
                    {predicateLabel(e.predicate) || style.kind}
                  </text>
                )}
              </g>
            )
          })}
          {/* ─ nodes:CharacterPixel 头像 + 类型环 ─ */}
          {nodes.map((n) => {
            const p = posOf(n.id)
            if (!p) return null
            const r = radiusOf(n)
            const active = !activeSet || activeSet.has(n.id)
            const isHover = hover === n.id
            const isFocus = focusId === n.id
            const tc = typeColor(n.type)
            const pcSize = Math.round(r * 1.8)  // pixel head size
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                opacity={active ? 1 : 0.18}
                className="sg-node"
                role="button"
                tabIndex={0}
                aria-label={`点击聚焦 / 双击进实体 ${n.name}`}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
                onPointerDown={(ev) => onNodePointerDown(ev, n)}
                onPointerUp={(ev) => onNodePointerUp(ev, n)}
                onDoubleClick={() => activateNode(n)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault()
                    activateNode(n)
                  } else if (ev.key === " ") {
                    ev.preventDefault()
                    setFocusId((cur) => cur === n.id ? null : n.id)
                    setFocusDepth(1)
                  }
                }}
                style={{ cursor: "grab" }}
              >
                {/* focus 高亮环 */}
                {(isFocus || isHover) && (
                  <circle r={r + 6} fill="none" stroke={isFocus ? "var(--brand-500)" : tc} strokeWidth={2} opacity={0.7} />
                )}
                {/* 类型色光晕;底盘随主题用卡面色(暗色深堇紫底上不再是刺眼纯白) */}
                <circle r={r + 2} fill={tc} opacity={0.18} />
                <circle r={r} fill="var(--bg-card)" stroke={tc} strokeWidth={2} />
                {/* 人物用 CharacterPixel,其他类型用类型色填充 */}
                {n.type === "person" ? (
                  <foreignObject x={-pcSize / 2} y={-pcSize / 2} width={pcSize} height={pcSize} style={{ pointerEvents: "none" }}>
                    <CharacterPixel color={personColor(n.id)} size={pcSize} ariaLabel={n.name} />
                  </foreignObject>
                ) : (
                  <text textAnchor="middle" dy="5" fill={tc} fontSize={r * 0.9} fontWeight={700} style={{ pointerEvents: "none", userSelect: "none" }}>
                    {n.name.charAt(0) || "?"}
                  </text>
                )}
                {/* 超长实体名(别名链)截断,完整名进 <title> 悬浮提示,避免标签互相压盖 */}
                <text y={r + 16} textAnchor="middle" className="sg-node-label" style={{ fontWeight: isFocus ? 700 : 500 }}>
                  {n.name.length > 12 ? `${n.name.slice(0, 11)}…` : n.name}
                  <title>{n.name}</title>
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      <div className="sg-legend">
        <span className="sg-leg-title">关系</span>
        <span className="sg-leg"><i style={{ background: EDGE_COLOR.亲友 }} />亲友</span>
        <span className="sg-leg"><i style={{ background: EDGE_COLOR.敌对 }} />敌对</span>
        <span className="sg-leg"><i style={{ background: EDGE_COLOR.师徒 }} />师徒</span>
        <span className="sg-leg"><i style={{ background: EDGE_COLOR.商业 }} />商业</span>
        <span className="sg-leg"><i style={{ background: EDGE_COLOR.未明, borderTop: "1px dashed currentColor" }} />未明</span>
        <span className="sg-sep" />
        <span className="sg-leg-title">实体</span>
        {Object.entries({ person: "人物", item: "物件", place: "地点", org: "组织", concept: "概念" }).map(([t, label]) => (
          <span key={t} className="sg-leg"><i style={{ background: typeColor(t) }} />{label}</span>
        ))}
        <span className="sg-sp" />
        <span className="sg-hint">滚轮缩放 · 拖背景平移 · 拖节点 · 点节点聚焦(再点加深一层) · 双击进档案</span>
      </div>
    </div>
  )
}
