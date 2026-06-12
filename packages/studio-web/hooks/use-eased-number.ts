"use client"

import * as React from "react"

/**
 * useEasedNumber —— 实时数字滚动:值一变就从「当前显示值」rAF 缓动到新值(easeOutCubic)。
 * 给字数/进度这类"写作正在发生"的核心数字用,流式期间不再生硬瞬移。
 * 约束:
 *   - 连续快速更新时以当前显示值为起点续滚,不会越追越远;
 *   - prefers-reduced-motion 或变化量很小(<3)时直接跳变,不做动画;
 *   - 只滚整数(配 tabular-nums 数字字体,滚动不抖宽)。
 */
export function useEasedNumber(value: number, duration = 280): number {
  const [display, setDisplay] = React.useState(value)
  // shown = 当前真实显示值(动画中间值也算),raf = 进行中的动画帧句柄
  const stateRef = React.useRef({ shown: value, raf: 0 })

  React.useEffect(() => {
    const from = stateRef.current.shown
    const delta = value - from
    if (delta === 0) return
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    if (reduced || Math.abs(delta) < 3) {
      stateRef.current.shown = value
      setDisplay(value)
      return
    }
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = t >= 1 ? value : Math.round(from + delta * eased)
      stateRef.current.shown = next
      setDisplay(next)
      if (t < 1) stateRef.current.raf = requestAnimationFrame(tick)
    }
    cancelAnimationFrame(stateRef.current.raf)
    stateRef.current.raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(stateRef.current.raf)
  }, [value, duration])

  return display
}
