"use client"

import * as React from "react"
import type { StreakDay } from "@/lib/api/types"
import "./writing-heatmap.css"

// ── 写作打卡热力图（GitHub 贡献图风格）─────────────────────────────────────
// 周为列、7 天为行；当日字数分 5 档暖色阶（无写作=纸色描边，低→高=柔紫由浅到深）。
// hover/聚焦显示「日期 + 字数」。打卡卡与分享卡共用同一套色阶（见 heatmapTier / TIER_COLORS）。
// 纯展示、无副作用、SSR 安全；尊重 prefers-reduced-motion（CSS 控制）。

// 5 档色阶阈值（当日字数）。0 = 空格（纸色描边），其余按字数深浅。
// 5000 ≈ 单章默认目标，故 ≥1 章即进入第 3-5 档，让"今天写了一章"明显点亮。
const TIER_THRESHOLDS = [0, 1, 1500, 3500, 6000] as const

export function heatmapTier(words: number): 0 | 1 | 2 | 3 | 4 {
  if (words <= 0) return 0
  if (words < TIER_THRESHOLDS[2]) return 1
  if (words < TIER_THRESHOLDS[3]) return 2
  if (words < TIER_THRESHOLDS[4]) return 3
  return 4
}

// 色阶（CSS 变量驱动，亮暗自动适配；分享卡 SVG 导出复用同一组解析后的颜色，见 share-card）。
export const HEATMAP_TIER_VARS = [
  "var(--hm-0)",
  "var(--hm-1)",
  "var(--hm-2)",
  "var(--hm-3)",
  "var(--hm-4)",
] as const

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const
const MONTH_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const

type Week = Array<StreakDay | null>

// 把升序密集日历切成「周列」：每列 7 行（周日→周六对齐），首列前补 null 占位到周日。
export function toWeeks(calendar: StreakDay[]): Week[] {
  if (!calendar.length) return []
  const weeks: Week[] = []
  let current: Week = []
  // 第一天是星期几（0=周日）→ 在它前面补几个空格让列对齐周日开头。
  const firstDow = new Date(`${calendar[0].date}T00:00:00`).getDay()
  for (let i = 0; i < firstDow; i++) current.push(null)
  for (const day of calendar) {
    current.push(day)
    if (current.length === 7) {
      weeks.push(current)
      current = []
    }
  }
  if (current.length) {
    while (current.length < 7) current.push(null)
    weeks.push(current)
  }
  return weeks
}

function fmtWords(n: number): string {
  return n.toLocaleString("en-US")
}

function fmtDate(date: string): string {
  // 2026-06-14 → 6月14日（周X）
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date
  return `${d.getMonth() + 1}月${d.getDate()}日 · 周${WEEKDAY_LABELS[d.getDay()]}`
}

export function WritingHeatmap({
  calendar,
  weeks: weeksToShow = 22,
  cell = 11,
  gap = 3,
  showLabels = true,
  className,
}: {
  calendar: StreakDay[]
  /** 只显示最近多少周（默认 22 周 ≈ 半年，工作台卡片宽度友好；分享卡可调宽） */
  weeks?: number
  cell?: number
  gap?: number
  showLabels?: boolean
  className?: string
}) {
  const allWeeks = React.useMemo(() => toWeeks(calendar), [calendar])
  const weeks = React.useMemo(
    () => (weeksToShow > 0 ? allWeeks.slice(-weeksToShow) : allWeeks),
    [allWeeks, weeksToShow],
  )
  const [hover, setHover] = React.useState<{ day: StreakDay; x: number; y: number } | null>(null)

  // 月份刻度：每列若其首个非空日的月份与上一列不同，则在该列上方打月份标签。
  const monthTicks = React.useMemo(() => {
    const ticks: Array<{ col: number; label: string }> = []
    let prevMonth = -1
    weeks.forEach((week, col) => {
      const firstDay = week.find((d): d is StreakDay => d != null)
      if (!firstDay) return
      const m = new Date(`${firstDay.date}T00:00:00`).getMonth()
      if (m !== prevMonth) {
        ticks.push({ col, label: `${MONTH_LABELS[m]}月` })
        prevMonth = m
      }
    })
    return ticks
  }, [weeks])

  if (!weeks.length) {
    return <div className={`hm-empty${className ? ` ${className}` : ""}`}>还没有写作记录 · 写下第一章就会亮起来</div>
  }

  const colStep = cell + gap
  const gridW = weeks.length * colStep - gap
  const labelW = showLabels ? 16 : 0
  const monthH = showLabels ? 14 : 0

  return (
    <div className={`hm-wrap${className ? ` ${className}` : ""}`} onMouseLeave={() => setHover(null)}>
      <div className="hm-grid-area" style={{ paddingLeft: labelW, paddingTop: monthH }}>
        {/* 月份刻度 */}
        {showLabels && (
          <div className="hm-months" style={{ left: labelW, top: 0, height: monthH }}>
            {monthTicks.map((t) => (
              <span key={`${t.col}-${t.label}`} className="hm-month" style={{ left: t.col * colStep }}>
                {t.label}
              </span>
            ))}
          </div>
        )}
        {/* 周几标签（只标 一/三/五，避免拥挤）*/}
        {showLabels && (
          <div className="hm-weekdays" style={{ top: monthH }}>
            {[1, 3, 5].map((dow) => (
              <span
                key={dow}
                className="hm-weekday"
                style={{ top: dow * colStep, height: cell, lineHeight: `${cell}px` }}
              >
                {WEEKDAY_LABELS[dow]}
              </span>
            ))}
          </div>
        )}
        <div className="hm-grid" style={{ width: gridW, height: 7 * colStep - gap }} role="img" aria-label="写作打卡热力图">
          {weeks.map((week, col) =>
            week.map((day, row) => {
              if (!day) return null
              const tier = heatmapTier(day.words)
              return (
                <div
                  key={day.date}
                  className="hm-cell"
                  data-tier={tier}
                  style={{ left: col * colStep, top: row * colStep, width: cell, height: cell }}
                  tabIndex={0}
                  onMouseEnter={(e) => {
                    const host = (e.currentTarget.closest(".hm-wrap") as HTMLElement | null)?.getBoundingClientRect()
                    const r = e.currentTarget.getBoundingClientRect()
                    setHover({
                      day,
                      x: r.left - (host?.left ?? 0) + cell / 2,
                      y: r.top - (host?.top ?? 0),
                    })
                  }}
                  onFocus={(e) => {
                    const host = (e.currentTarget.closest(".hm-wrap") as HTMLElement | null)?.getBoundingClientRect()
                    const r = e.currentTarget.getBoundingClientRect()
                    setHover({
                      day,
                      x: r.left - (host?.left ?? 0) + cell / 2,
                      y: r.top - (host?.top ?? 0),
                    })
                  }}
                  onBlur={() => setHover(null)}
                  aria-label={`${fmtDate(day.date)}：${day.words > 0 ? `${fmtWords(day.words)} 字` : "未写作"}`}
                />
              )
            }),
          )}
        </div>
      </div>
      {/* 图例 */}
      {showLabels && (
        <div className="hm-legend">
          <span className="hm-legend-text">少</span>
          {[0, 1, 2, 3, 4].map((t) => (
            <span key={t} className="hm-legend-cell" data-tier={t} />
          ))}
          <span className="hm-legend-text">多</span>
        </div>
      )}
      {hover && (
        <div className="hm-tip" style={{ left: hover.x, top: hover.y }} role="status">
          <strong>{hover.day.words > 0 ? `${fmtWords(hover.day.words)} 字` : "这天没动笔"}</strong>
          <span>{fmtDate(hover.day.date)}</span>
        </div>
      )}
    </div>
  )
}
