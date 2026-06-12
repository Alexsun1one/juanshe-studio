"use client"

import * as React from "react"
import Link from "next/link"
import type { AutoRun } from "@/lib/api/types"
import "./batch-progress.css"

/** 剩余时长展示:与 components/runs/run-card.tsx 的 formatDuration 同口径(那边未导出,改动它会牵连运行台)。 */
export function formatEta(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

/** 刻度太密就没有信息量:超过 40 章的批次只画整条进度,不画按章刻度 */
const MAX_TICKS = 40

/**
 * BatchProgress —— 连续写批次的微进度组件(工作台 writer-head 用)。
 * 挂机长任务最核心的安心感信息就地给:写到第几章/共几章、还剩几章、重写第几轮、预计还要多久,
 * 配按章打刻度的细进度条;数据与 /runs 的 RunCard 同源(useAutoRuns),overallPct 同口径。
 * 只在查到本书活跃 AutoRun 时由父组件渲染 —— 批次结束即消失,不残留「0/10」。
 */
export function BatchProgress({ run }: { run: AutoRun }) {
  const total = Math.max(1, run.toChapter - run.fromChapter + 1)
  const done = Math.max(0, Math.min(total, run.currentChapter - run.fromChapter))
  const pct =
    Math.min(100, ((done + run.currentWords / Math.max(1, run.targetWordsPerChapter)) / total) * 100) || 0
  const remain = Math.max(0, run.toChapter - run.currentChapter)
  const eta = run.eta ? Math.max(0, run.eta - Date.now()) : null

  return (
    <div className="batch-progress" title={`本批连写 第 ${run.fromChapter}–${run.toChapter} 章 · 数据与运行台同源`}>
      <span className="bp-chip">
        批次 第 <b className="num">{run.currentChapter}</b>/<b className="num">{run.toChapter}</b> 章
        <span className="bp-dim">· 还剩 {remain} 章</span>
        {run.currentRewrite > 0 && (
          <span className="bp-rewrite">· 重写 {run.currentRewrite}/{run.maxRewritesPerChapter}</span>
        )}
        {eta !== null && <span className="bp-dim">· 预计还要 {formatEta(eta)}</span>}
      </span>
      <span className="bp-bar" aria-hidden>
        <i style={{ width: `${pct}%` }} />
        {total <= MAX_TICKS &&
          Array.from({ length: total - 1 }).map((_, i) => (
            <em key={i} style={{ left: `${((i + 1) / total) * 100}%` }} />
          ))}
      </span>
      <Link href="/runs" className="bp-link">运行台 →</Link>
    </div>
  )
}
