"use client"

/* ════════════════════════════════════════════════════════════════
   卷舍 · 微组件库(Kit)
   ----------------------------------------------------------------
   全站复用的标准件。与 design.css 既有的 .pill/.tag/.btn/.card/.empty
   互补 —— 这里补齐 GPT redesign 方向里高频、现状缺的几个:
   KpiChip / Meter / Spark / StatLine / RelayBar / AgentCard / FoldCard。
   样式见 app/kit.css。气质沿用暖纸+像素+柔紫(随主题切换),不引入新依赖。
   ════════════════════════════════════════════════════════════════ */

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { AgentPixel } from "./agent-pixel"

export type Tone = "brand" | "ok" | "warn" | "err" | "info" | "rose" | "amber" | "neutral"

/* —— KPI 芯片:标签 + 大数值(+单位/迷你火花)。工作台质量指标、各页统计用 —— */
export function KpiChip({
  label, value, unit, tone = "neutral", spark, hint, sub,
}: {
  label: string
  value: React.ReactNode
  unit?: string
  tone?: Tone
  spark?: number[]
  hint?: string
  sub?: React.ReactNode
}) {
  return (
    <div className="cj-kpi" data-tone={tone} title={hint}>
      <div className="cj-kpi-label">{label}</div>
      <div className="cj-kpi-value">
        <span className="cj-kpi-num tabular">{value}</span>
        {unit && <span className="cj-kpi-unit">{unit}</span>}
      </div>
      {sub != null && <div className="cj-kpi-sub">{sub}</div>}
      {spark && spark.length > 1 && <Spark data={spark} tone={tone === "neutral" ? "brand" : tone} className="cj-kpi-spark" />}
    </div>
  )
}

/* —— 计量条:进度 + 可选阈值刻度。质量门槛/达标率用 —— */
export function Meter({
  value, max = 100, threshold, tone = "brand", label, showValue = true, unitMax = true,
}: {
  value: number
  max?: number
  threshold?: number
  tone?: Tone
  label?: React.ReactNode
  showValue?: boolean
  unitMax?: boolean
}) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100))
  const passed = threshold == null || value >= threshold
  return (
    <div className="cj-meter">
      {(label || showValue) && (
        <div className="cj-meter-head">
          {label && <span className="cj-meter-label">{label}</span>}
          {showValue && (
            <span className={`cj-meter-value tabular${threshold != null ? (passed ? " is-pass" : " is-under") : ""}`}>
              {value}
              {unitMax && max !== 100 ? <span className="cj-meter-of">/{max}</span> : null}
            </span>
          )}
        </div>
      )}
      <div className="cj-meter-track">
        <div className="cj-meter-fill" data-tone={passed ? tone : "warn"} style={{ width: `${pct}%` }} />
        {threshold != null && max > 0 && (
          <span className="cj-meter-thresh" style={{ left: `${Math.min(100, (threshold / max) * 100)}%` }} aria-hidden />
        )}
      </div>
    </div>
  )
}

/* —— 火花线:迷你趋势 SVG —— */
export function Spark({
  data, tone = "brand", width = 64, height = 20, className,
}: {
  data: number[]
  tone?: Tone
  width?: number
  height?: number
  className?: string
}) {
  if (!data || data.length < 2) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pts = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * width
      const y = height - ((d - min) / range) * (height - 2) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
  return (
    <svg
      className={`cj-spark${className ? " " + className : ""}`}
      data-tone={tone}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* —— 统计行:inline「9 本书 · 9.9万 字 · 29 章」—— */
export function StatLine({
  items, className,
}: {
  items: { n: React.ReactNode; label: string; tone?: Tone }[]
  className?: string
}) {
  return (
    <div className={`cj-statline${className ? " " + className : ""}`}>
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="cj-statline-sep" aria-hidden />}
          <span className="cj-statline-item">
            <span className="cj-statline-n tabular" data-tone={it.tone}>{it.n}</span>
            <span className="cj-statline-label">{it.label}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}

type Agent = { name: string; fid: string; role?: string }

/* —— Agent 接棒条:当前 → 下一棒,带像素头像。写作工作台「本轮接棒」标准件 —— */
export function RelayBar({
  current, next, reason,
}: {
  current: Agent
  next?: Agent | null
  reason?: React.ReactNode
}) {
  return (
    <div className="cj-relay">
      <div className="cj-relay-flow">
        <div className="cj-relay-node is-current">
          <AgentPixel id={current.fid} size={30} ariaLabel={current.name} />
          <span className="cj-relay-meta">
            <span className="cj-relay-tag">当前</span>
            <span className="cj-relay-name">{current.name}</span>
            {current.role && <span className="cj-relay-role">{current.role}</span>}
          </span>
        </div>
        {next && (
          <>
            <span className="cj-relay-arrow" aria-hidden>→</span>
            <div className="cj-relay-node is-next">
              <AgentPixel id={next.fid} size={30} ariaLabel={next.name} />
              <span className="cj-relay-meta">
                <span className="cj-relay-tag">下一棒</span>
                <span className="cj-relay-name">{next.name}</span>
                {next.role && <span className="cj-relay-role">{next.role}</span>}
              </span>
            </div>
          </>
        )}
      </div>
      {reason && <p className="cj-relay-reason">{reason}</p>}
    </div>
  )
}

/* —— Agent 像素卡:头像 + 名 + 角色 + 状态。roster/system/agents 用 —— */
export function AgentCard({
  fid, name, role, state, onClick, active, right,
}: {
  fid: string
  name: string
  role?: string
  state?: string
  onClick?: () => void
  active?: boolean
  right?: React.ReactNode
}) {
  const interactive = Boolean(onClick)
  return (
    <div
      className={`cj-agent-card${active ? " active" : ""}${interactive ? " is-interactive" : ""}`}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.() } } : undefined}
    >
      <AgentPixel id={fid} size={40} ariaLabel={name} className="cj-agent-card-pixel" />
      <span className="cj-agent-card-body">
        <span className="cj-agent-card-name">{name}</span>
        {role && <span className="cj-agent-card-role">{role}</span>}
      </span>
      {state && <span className="pill" data-state={state}><span className="dot" />{stateLabel(state)}</span>}
      {right}
    </div>
  )
}

function stateLabel(state: string): string {
  const map: Record<string, string> = {
    running: "运行中", queued: "排队", success: "完成", done: "完成",
    warn: "注意", error: "异常", paused: "暂停", pending: "待命",
    idle: "待命", disabled: "停用", draft: "草稿", published: "已发布",
  }
  return map[state] ?? state
}

/* —— 折叠卡(卡内滚):一屏原则的关键载体。信息多时折叠/卡内滚动,不撑破一屏 —— */
export function FoldCard({
  title, children, defaultOpen = true, scrollable = false, maxHeight = 260, right, icon, count, className,
}: {
  title: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  scrollable?: boolean
  maxHeight?: number
  right?: React.ReactNode
  icon?: React.ReactNode
  count?: React.ReactNode
  className?: string
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <section className={`cj-foldcard${open ? " is-open" : ""}${className ? " " + className : ""}`}>
      <button type="button" className="cj-foldcard-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {icon && <span className="cj-foldcard-icon">{icon}</span>}
        <span className="cj-foldcard-title">{title}</span>
        {count != null && <span className="cj-foldcard-count">{count}</span>}
        {right && <span className="cj-foldcard-right" onClick={(e) => e.stopPropagation()}>{right}</span>}
        <ChevronDown size={15} className="cj-foldcard-chevron" aria-hidden />
      </button>
      {open && (
        <div
          className={`cj-foldcard-body${scrollable ? " scroll-thin cj-foldcard-scroll" : ""}`}
          style={scrollable ? { maxHeight } : undefined}
        >
          {children}
        </div>
      )}
    </section>
  )
}
