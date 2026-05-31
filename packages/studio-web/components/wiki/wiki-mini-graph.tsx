"use client"

import * as React from "react"
import type { WikiNode } from "@/lib/api/types"

const KIND_COLOR: Record<string, string> = {
  chapter: "var(--chart-1)",
  character: "var(--chart-3)",
  setpoint: "var(--chart-4)",
  constraint: "var(--chart-5)",
  agent: "var(--primary)",
  note: "var(--muted-foreground)",
}

type Props = {
  focus: WikiNode
  allNodes: WikiNode[]
  lang: "zh" | "en"
  onSelect: (id: string) => void
}

/**
 * 局部图：聚焦节点居中，1 跳邻居环绕排列。
 *
 * 不做物理仿真，避免引入额外依赖；圆周排布对小数据量的可读性其实更好。
 */
export function WikiMiniGraph({ focus, allNodes, lang, onSelect }: Props) {
  const byId = React.useMemo(() => {
    const m = new Map<string, WikiNode>()
    for (const n of allNodes) m.set(n.id, n)
    return m
  }, [allNodes])

  // 1-hop neighbors: outgoing links + backlinks，去重
  const neighbors = React.useMemo(() => {
    const seen = new Set<string>()
    const list: WikiNode[] = []
    const push = (id: string) => {
      if (id === focus.id || seen.has(id)) return
      const n = byId.get(id)
      if (!n) return
      seen.add(id)
      list.push(n)
    }
    for (const l of focus.links) push(l.id)
    for (const b of focus.backlinks) push(b.id)
    return list
  }, [focus, byId])

  // 圆周布局：viewBox 100x100，居中点 (50, 50)
  const cx = 50
  const cy = 50
  const radius = 33
  const nodes = neighbors.map((n, i) => {
    const angle = (i / Math.max(1, neighbors.length)) * Math.PI * 2 - Math.PI / 2
    return {
      n,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    }
  })

  return (
    <svg
      viewBox="0 0 100 100"
      className="h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <radialGradient id="wikiCenterGlow" cx="50%" cy="50%" r="50%">
          <stop
            offset="0%"
            stopColor={KIND_COLOR[focus.kind] ?? "var(--primary)"}
            stopOpacity="0.35"
          />
          <stop offset="100%" stopColor="transparent" />
        </radialGradient>
      </defs>

      {/* 中心光晕 */}
      <circle cx={cx} cy={cy} r="22" fill="url(#wikiCenterGlow)" />

      {/* 边 */}
      {nodes.map(({ n, x, y }) => (
        <line
          key={n.id}
          x1={cx}
          y1={cy}
          x2={x}
          y2={y}
          stroke="var(--border)"
          strokeWidth="0.4"
          strokeOpacity="0.7"
        />
      ))}

      {/* 中心节点 */}
      <g>
        <circle
          cx={cx}
          cy={cy}
          r="4.5"
          fill={KIND_COLOR[focus.kind] ?? "var(--primary)"}
          stroke="var(--background)"
          strokeWidth="0.9"
        />
        <text
          x={cx}
          y={cy + 9.5}
          textAnchor="middle"
          fontSize="3.2"
          fontWeight="600"
          fill="currentColor"
          className="text-foreground"
        >
          {truncate(focus.title[lang], 12)}
        </text>
      </g>

      {/* 邻居节点 */}
      {nodes.map(({ n, x, y }) => (
        <g
          key={n.id}
          className="cursor-pointer"
          onClick={() => onSelect(n.id)}
        >
          <circle
            cx={x}
            cy={y}
            r="2.6"
            fill={KIND_COLOR[n.kind] ?? "var(--muted-foreground)"}
            stroke="var(--background)"
            strokeWidth="0.6"
            className="transition-[r] hover:[r:3.2]"
          />
          <text
            x={x}
            y={y + 6}
            textAnchor="middle"
            fontSize="2.6"
            fill="currentColor"
            className="text-muted-foreground pointer-events-none"
          >
            {truncate(n.title[lang], 9)}
          </text>
        </g>
      ))}

      {/* 没有邻居时的占位 */}
      {neighbors.length === 0 && (
        <text
          x={cx}
          y={cy + 18}
          textAnchor="middle"
          fontSize="3"
          fill="currentColor"
          className="text-muted-foreground/70"
        >
          {lang === "en" ? "no links yet" : "暂无连边"}
        </text>
      )}
    </svg>
  )
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}
