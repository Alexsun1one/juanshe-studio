"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { useStudio } from "@/lib/studio-context"
import { useChapterQualityRaw } from "@/hooks/use-studio"
import { blockerLabels } from "@/lib/blocker-labels"

/** 9 维评分的中文名 + 出版级硬门槛（仅作配色参考） */
const DIM: { key: string; label: string; floor: number }[] = [
  { key: "total", label: "总分", floor: 90 },
  { key: "continuity", label: "连续性", floor: 88 },
  { key: "style", label: "风格", floor: 88 },
  { key: "hook", label: "钩子", floor: 88 },
  { key: "immersion", label: "沉浸感", floor: 88 },
  { key: "rhythm", label: "节奏", floor: 85 },
  { key: "readability", label: "可读性", floor: 85 },
  { key: "reader", label: "读者追更", floor: 90 },
  { key: "clarity", label: "清晰度", floor: 85 },
  { key: "length", label: "字数达标", floor: 85 },
]

const TARGET_OPTIONS = [80, 85, 88, 90, 95]
const LS_KEY = "studio:qualityTarget"

export function ChapterQualityPanel() {
  const { bookId, currentChapter } = useStudio()
  const [target, setTargetState] = React.useState(90)

  React.useEffect(() => {
    try {
      const v = Number(window.localStorage.getItem(LS_KEY))
      if (v >= 60 && v <= 98) setTargetState(v)
    } catch {
      /* ignore */
    }
  }, [])

  const setTarget = React.useCallback((v: number) => {
    setTargetState(v)
    try {
      window.localStorage.setItem(LS_KEY, String(v))
    } catch {
      /* ignore */
    }
  }, [])

  const { data, isLoading } = useChapterQualityRaw(
    bookId,
    currentChapter,
    target,
  )
  const q = data?.quality
  const total = Number(q?.total ?? 0)
  const gate = q?.gate
  const pass = gate?.pass === true
  const metrics = q?.metrics ?? {}
  const blockers = gate?.blockers ?? []
  const reasons = q?.reasons ?? []

  return (
    <div className="border-border bg-card mx-2 my-2 rounded-lg border p-3 shadow-sm">
      {/* 头部：总分 + 达标判定 + 达标分选择 */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-muted-foreground text-[11px]">
            第 {currentChapter} 章评分
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span
              className={cn(
                "text-2xl font-bold tabular-nums",
                pass ? "text-status-success" : "text-status-warning",
              )}
            >
              {isLoading ? "··" : total || "--"}
            </span>
            {q?.band && (
              <span className="text-muted-foreground text-[11px]">
                {q.band}
              </span>
            )}
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                pass
                  ? "bg-status-success/15 text-status-success"
                  : "bg-status-warning/15 text-status-warning",
              )}
            >
              {pass ? "已达标" : "未达标"}
            </span>
          </div>
        </div>
        <label className="flex flex-col items-end gap-1">
          <span className="text-muted-foreground text-[10px]">达标分</span>
          <select
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
            className="border-border bg-background h-7 rounded-md border px-1.5 text-xs outline-none"
            aria-label="设定达标分数"
          >
            {TARGET_OPTIONS.map((t) => (
              <option key={t} value={t}>
                ≥ {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      {target < 90 && (
        <p className="text-muted-foreground mt-2 text-[10.5px] leading-snug">
          已设为 ≥{target}：低于 90 时风格/钩子/沉浸不再硬卡（仅作提示），
          仅状态损坏/critical/缺报告/过短仍硬性拦截。
        </p>
      )}

      {/* 9 维明细 */}
      <div className="mt-2.5 space-y-1">
        {DIM.map(({ key, label, floor }) => {
          const v =
            key === "total" ? total : Number((metrics as Record<string, number>)[key] ?? 0)
          if (!v && key !== "total") return null
          const ok = v >= (target < 90 ? Math.min(floor, target) : floor)
          return (
            <div key={key} className="flex items-center gap-2">
              <span className="text-muted-foreground w-14 shrink-0 text-[11px]">
                {label}
              </span>
              <div className="bg-secondary relative h-1.5 flex-1 overflow-hidden rounded-full">
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    ok ? "bg-status-success" : "bg-status-warning",
                  )}
                  style={{ width: `${Math.max(0, Math.min(100, v))}%` }}
                />
              </div>
              <span
                className={cn(
                  "w-7 shrink-0 text-right text-[11px] tabular-nums",
                  ok ? "text-foreground" : "text-status-warning",
                )}
              >
                {v || "--"}
              </span>
            </div>
          )
        })}
      </div>

      {/* 阻断项 / 原因 */}
      {blockers.length > 0 && (
        <div className="text-status-warning mt-2 text-[10.5px] leading-snug">
          阻断：{blockerLabels(blockers).join(" · ")}
        </div>
      )}
      {reasons.length > 0 && (
        <ul className="text-muted-foreground mt-1.5 space-y-0.5 text-[10.5px] leading-snug">
          {reasons.slice(0, 4).map((r, i) => (
            <li key={i}>· {r}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
