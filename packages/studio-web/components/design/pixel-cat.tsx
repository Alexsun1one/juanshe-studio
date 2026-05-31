"use client"

/**
 * 编辑部的猫:工作台脚边的像素陪伴。
 * 大部分时间睡觉,偶尔起身踱两步再趴下。纯陪伴,pointer-events:none 永不挡操作。
 * 状态机:sleep(久) -> wake(伸懒腰) -> walk(踱步,左右移动) -> sleep...,带轻微错相,不用 Math.random。
 */

import * as React from "react"
import "./pixel-cat.css"

type CatState = "sleep" | "wake" | "walk"

// 一段会"自己过日子"的时间表(秒):睡很久 → 醒 → 走 → 再睡,循环。
const TIMELINE: ReadonlyArray<{ state: CatState; ms: number; dir?: 1 | -1 }> = [
  { state: "sleep", ms: 17000 },
  { state: "wake", ms: 2200 },
  { state: "walk", ms: 5200, dir: 1 },
  { state: "sleep", ms: 14000 },
  { state: "wake", ms: 1800 },
  { state: "walk", ms: 4600, dir: -1 },
  { state: "sleep", ms: 20000 },
]

export function PixelCat({ className }: { className?: string } = {}) {
  const [step, setStep] = React.useState(0)
  const [reduced, setReduced] = React.useState(false)

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener?.("change", onChange)
    return () => mq.removeEventListener?.("change", onChange)
  }, [])

  React.useEffect(() => {
    if (reduced) return // 减少动效:永远安睡
    const cur = TIMELINE[step % TIMELINE.length]
    const t = setTimeout(() => setStep((s) => s + 1), cur.ms)
    return () => clearTimeout(t)
  }, [step, reduced])

  const cur = TIMELINE[step % TIMELINE.length]
  const state: CatState = reduced ? "sleep" : cur.state
  const dir = cur.dir ?? 1
  // 走动时整只猫在一小段地板上左右平移(配合 CSS),用 step 奇偶给一点位置变化
  const walkShift = state === "walk" ? (dir === 1 ? 14 : -14) : 0

  return (
    <div className={`cj-cat${className ? ` ${className}` : ""}`} data-state={state} aria-hidden="true">
      <div className="cj-cat-stage" style={{ transform: `translateX(${walkShift}px)` }}>
        {/* Zzz 仅睡觉时 */}
        <div className="cj-cat-zzz">
          <span>z</span><span>z</span><span>z</span>
        </div>
        <span className="cj-cat-shadow" />
        <img
          className="cj-cat-img"
          src="/agent-avatars-imagined/18-juanshe-cat.png"
          width={68}
          height={68}
          alt=""
          draggable={false}
          style={{ transform: `scaleX(${dir})` }}
        />
      </div>
    </div>
  )
}
