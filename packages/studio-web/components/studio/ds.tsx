"use client"

/**
 * 长卷写作台 · 设计系统组件 (DS)
 * ----------------------------------------------------------------
 * 把"状态机 / 微交互 / 层级规范"沉淀为可复用原语，全站统一调用：
 *   - RunState / RunStatePill   运行状态机的单一事实来源
 *   - StreamingText             流式正文（token 淡入 + 呼吸光标 + 自动跟随）
 *   - StepFlow                  阶段步进器（规划→写作→润色→落库→发布）
 *   - ScoreRing / MetricBar     质量评分可视化
 *   - StatPair / SectionCard    仪表盘信息层级
 * 所有视觉走 globals.css 的设计令牌；动效统一用 --dur/--ease。
 */

import * as React from "react"
import { cn } from "@/lib/utils"

/* ============================================================
   运行状态机 —— 单一事实来源
   ============================================================ */

export type RunState =
  | "idle"
  | "queued"
  | "running"
  | "streaming"
  | "paused"
  | "success"
  | "error"

type StateMeta = {
  zh: string
  en: string
  /** state-dot 的 data-state，驱动颜色与脉冲 */
  dot: RunState
}

export const RUN_STATE_META: Record<RunState, StateMeta> = {
  idle: { zh: "待命", en: "Idle", dot: "idle" },
  queued: { zh: "排队中", en: "Queued", dot: "queued" },
  running: { zh: "运行中", en: "Running", dot: "running" },
  streaming: { zh: "实时生成", en: "Streaming", dot: "streaming" },
  paused: { zh: "已暂停", en: "Paused", dot: "paused" },
  success: { zh: "已完成", en: "Done", dot: "success" },
  error: { zh: "出错", en: "Error", dot: "error" },
}

const STATE_TONE: Record<RunState, string> = {
  idle: "muted",
  queued: "info",
  running: "brand",
  streaming: "brand",
  paused: "warning",
  success: "success",
  error: "danger",
}

/** 状态机徽章 —— 全站状态显示的唯一组件 */
export function RunStatePill({
  state,
  label,
  lang = "zh",
  className,
  title,
}: {
  state: RunState
  /** 覆盖默认文案 */
  label?: string
  lang?: "zh" | "en"
  className?: string
  title?: string
}) {
  const meta = RUN_STATE_META[state]
  return (
    <span
      className={cn("pill", className)}
      data-tone={STATE_TONE[state]}
      title={title}
      role="status"
      aria-live={state === "running" || state === "streaming" ? "polite" : "off"}
    >
      <span className="state-dot" data-state={meta.dot} aria-hidden />
      {label ?? (lang === "en" ? meta.en : meta.zh)}
    </span>
  )
}

/* ============================================================
   StreamingText —— 流式正文
   token 逐片淡入；生成中尾部呼吸光标；自动跟随到底部，
   用户上滚则暂停跟随并提示"回到最新"。
   ============================================================ */

export function StreamingText({
  text,
  state,
  rate,
  emptyHint,
  className,
}: {
  text: string
  state: RunState
  /** 字/秒，用于角标 */
  rate?: number
  emptyHint?: React.ReactNode
  className?: string
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const followRef = React.useRef(true)
  const [follow, setFollow] = React.useState(true)
  const streaming = state === "streaming" || state === "running"

  // 自动跟随：仅当用户停在底部附近时
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el || !followRef.current) return
    el.scrollTop = el.scrollHeight
  }, [text])

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom =
      el.scrollHeight - el.clientHeight - el.scrollTop < 64
    followRef.current = atBottom
    setFollow(atBottom)
  }, [])

  const jumpToLatest = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    followRef.current = true
    setFollow(true)
  }, [])

  const paras = React.useMemo(
    () => text.split(/\n{2,}/).filter((p) => p.trim().length > 0),
    [text],
  )

  return (
    <div className={cn("relative min-h-0", className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin h-full overflow-y-auto"
      >
        {paras.length === 0 ? (
          <div className="text-muted-foreground/80 flex h-full min-h-[8rem] items-center justify-center px-6 text-center text-body">
            {emptyHint ??
              (state === "queued"
                ? "已排队，等待智能体接管…"
                : state === "paused"
                  ? "已暂停 —— 恢复后继续生成"
                  : state === "error"
                    ? "生成中断，可重试或修复状态后继续"
                    : "启动后，正文将在此实时浮现")}
          </div>
        ) : (
          <div className="prose-manuscript px-6 py-5 md:px-10">
            {paras.map((p, i) => {
              const last = i === paras.length - 1
              return (
                <p key={i} className="stream-token">
                  {p}
                  {last && streaming ? (
                    <span className="stream-caret" aria-hidden />
                  ) : null}
                </p>
              )
            })}
          </div>
        )}
      </div>

      {/* 不在底部时：回到最新 */}
      {!follow && streaming ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="bg-primary text-primary-foreground shadow-pop absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1.5 text-cap font-medium transition-transform duration-[var(--dur-1)] ease-[var(--ease-out)] hover:-translate-y-0.5"
        >
          ↓ 回到最新生成
        </button>
      ) : null}

      {/* 流速角标 */}
      {streaming && typeof rate === "number" && rate > 0 ? (
        <div className="bg-card/85 text-muted-foreground border-border absolute right-3 top-3 rounded-full border px-2 py-0.5 text-micro backdrop-blur tabular-nums">
          {rate} 字/秒
        </div>
      ) : null}
    </div>
  )
}

/* ============================================================
   StepFlow —— 阶段步进器
   ============================================================ */

export type Step = { id: string; title: string; sub?: string }

export function StepFlow({
  steps,
  current,
  className,
}: {
  steps: Step[]
  /** 当前阶段索引（0-based）；之前为已完成 */
  current: number
  className?: string
}) {
  return (
    <ol className={cn("flex items-stretch", className)}>
      {steps.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={s.id} className="flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-cap font-bold transition-colors duration-[var(--dur-2)]",
                  done &&
                    "border-success bg-success text-white",
                  active &&
                    "border-primary bg-primary text-primary-foreground ring-4 ring-[color-mix(in_oklab,var(--primary)_18%,transparent)]",
                  !done &&
                    !active &&
                    "border-border bg-card text-muted-foreground",
                )}
              >
                {done ? (
                  <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <div className="min-w-0">
                <div
                  className={cn(
                    "truncate text-body font-semibold",
                    active
                      ? "text-foreground"
                      : done
                        ? "text-foreground/80"
                        : "text-muted-foreground",
                  )}
                >
                  {s.title}
                </div>
                {s.sub ? (
                  <div className="text-muted-foreground truncate text-micro">
                    {s.sub}
                  </div>
                ) : null}
              </div>
            </div>
            {i < steps.length - 1 ? (
              <div
                className={cn(
                  "mx-3 h-px flex-1 transition-colors duration-[var(--dur-2)]",
                  i < current ? "bg-success" : "bg-border",
                )}
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/* ============================================================
   ScoreRing —— 质量分环
   ============================================================ */

export function ScoreRing({
  value,
  max = 100,
  size = 92,
  label,
}: {
  value: number
  max?: number
  size?: number
  label?: string
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: "999px",
        background: `conic-gradient(var(--primary) ${pct}%, var(--muted) 0)`,
      }}
      role="img"
      aria-label={`${label ?? "评分"} ${value}/${max}`}
    >
      <div
        className="bg-card absolute inset-[8px] rounded-full shadow-card"
        aria-hidden
      />
      <div className="relative text-center leading-none">
        <div className="text-foreground text-h2 font-bold tracking-tight tabular-nums">
          {value}
        </div>
        {label ? (
          <div className="text-muted-foreground mt-0.5 text-micro">
            {label}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ============================================================
   MetricBar —— 指标条
   ============================================================ */

export function MetricBar({
  label,
  value,
  max = 100,
}: {
  label: string
  value: number
  max?: number
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div className="flex items-center gap-3">
      <div className="text-muted-foreground w-20 shrink-0 truncate text-cap">
        {label}
      </div>
      <div className="bg-muted relative h-1.5 flex-1 overflow-hidden rounded-full">
        <div
          className="bg-primary absolute inset-y-0 left-0 rounded-full transition-[width] duration-[var(--dur-3)] ease-[var(--ease-out)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-foreground w-7 shrink-0 text-right text-cap font-semibold tabular-nums">
        {value}
      </div>
    </div>
  )
}

/* ============================================================
   StatPair / SectionCard —— 仪表盘信息层级
   ============================================================ */

export function StatPair({
  label,
  value,
  hint,
  className,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-muted-foreground text-micro">{label}</div>
      <div className="text-foreground mt-0.5 text-head font-bold tracking-tight tabular-nums">
        {value}
      </div>
      {hint ? (
        <div className="text-muted-foreground mt-0.5 truncate text-micro">
          {hint}
        </div>
      ) : null}
    </div>
  )
}

export function SectionCard({
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn("panel", className)}>
      {title ? (
        <header className="panel-head">
          <h2>{title}</h2>
          {action}
        </header>
      ) : null}
      <div className={cn("panel-body", bodyClassName)}>{children}</div>
    </section>
  )
}
