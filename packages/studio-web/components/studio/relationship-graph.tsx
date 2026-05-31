"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { useLocale, useT } from "@/lib/i18n"
import type { Cast, Relation } from "@/lib/studio-data"

const KIND_COLOR: Record<Relation["kind"], string> = {
  ally: "var(--chart-1)",
  neutral: "var(--muted-foreground)",
  rival: "var(--chart-4)",
  subord: "var(--chart-5)",
  mentor: "var(--chart-3)",
  family: "var(--chart-2)",
}

const KIND_DASH: Record<Relation["kind"], string | undefined> = {
  ally: undefined,
  neutral: undefined,
  rival: undefined,
  subord: "4 4",
  mentor: "2 4",
  family: undefined,
}

/**
 * 角色关系图谱 — 紧凑径向布局
 * 焦点角色置中，其他节点环形分布；线宽 = strength；线色/虚实 = kind
 */
export function RelationshipGraph({
  nodes,
  edges,
  focusId,
  compact = false,
  className,
}: {
  nodes: Cast[]
  edges: Relation[]
  focusId: string
  compact?: boolean
  className?: string
}) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"

  const w = compact ? 300 : 440
  const h = compact ? 180 : 280
  const cx = w / 2
  const cy = h / 2
  const r = compact ? 60 : 100

  const focus = nodes.find((n) => n.id === focusId) ?? nodes[0]
  const others = nodes.filter((n) => n.id !== focus.id)

  // 计算环形坐标
  const placed = React.useMemo(() => {
    const map = new Map<string, { x: number; y: number; node: Cast }>()
    map.set(focus.id, { x: cx, y: cy, node: focus })
    others.forEach((n, i) => {
      const angle = (Math.PI * 2 * i) / others.length - Math.PI / 2
      map.set(n.id, {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        node: n,
      })
    })
    return map
  }, [focus, others, cx, cy, r])

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* legend */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px]">
        {(["ally", "neutral", "rival", "subord"] as const).map((k) => (
          <div key={k} className="flex items-center gap-1.5">
            <span
              className="inline-block h-[2px] w-4 rounded-full"
              style={{
                background: KIND_COLOR[k],
                outline: KIND_DASH[k] ? "none" : undefined,
                borderTop: KIND_DASH[k] ? `2px dashed ${KIND_COLOR[k]}` : undefined,
                height: KIND_DASH[k] ? 0 : undefined,
              }}
            />
            <span>{t(`relations.kind.${k}`)}</span>
          </div>
        ))}
      </div>

      <div className="bg-card/50 border-border/40 relative overflow-hidden rounded-md border">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="block h-auto w-full"
          aria-label="relationship graph"
        >
          <defs>
            <radialGradient id="rg-focus" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.85" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.1" />
            </radialGradient>
          </defs>

          {/* edges */}
          {edges.map((e, i) => {
            const a = placed.get(e.source)
            const b = placed.get(e.target)
            if (!a || !b) return null
            return (
              <g key={i}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={KIND_COLOR[e.kind]}
                  strokeOpacity={0.55}
                  strokeWidth={1 + e.strength * 1.6}
                  strokeDasharray={KIND_DASH[e.kind]}
                  strokeLinecap="round"
                />
              </g>
            )
          })}

          {/* focus halo */}
          <circle
            cx={cx}
            cy={cy}
            r={compact ? 22 : 32}
            fill="url(#rg-focus)"
            style={{ transformOrigin: `${cx}px ${cy}px` }}
          />

          {/* nodes */}
          {Array.from(placed.values()).map(({ x, y, node }) => {
            const isFocus = node.id === focus.id
            const radius = isFocus ? (compact ? 14 : 20) : compact ? 9 : 13
            return (
              <g key={node.id}>
                <circle
                  cx={x}
                  cy={y}
                  r={radius}
                  fill={node.color}
                  fillOpacity={isFocus ? 1 : 0.85}
                  stroke="var(--card)"
                  strokeWidth={1.5}
                />
                <text
                  x={x}
                  y={y + radius + (compact ? 9 : 12)}
                  textAnchor="middle"
                  fontSize={compact ? 9 : 11}
                  fill="currentColor"
                  className="font-medium"
                  style={{ fontFamily: "var(--font-sans)" }}
                >
                  {node.name[lang]}
                </text>
                {!compact && (
                  <text
                    x={x}
                    y={y + radius + 23}
                    textAnchor="middle"
                    fontSize={9}
                    fill="currentColor"
                    opacity={0.55}
                  >
                    {node.role[lang].split("·")[0]?.trim()}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
