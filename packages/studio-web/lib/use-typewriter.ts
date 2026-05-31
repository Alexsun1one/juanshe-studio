"use client"

/**
 * 把"累计文本"以打字机方式逐字吐出来 —— 无论上游 SSE 是一个字一个字推、还是一大块一大块推
 * (deepseek 往往比 MiMo 块更大),前端都呈现优雅的逐字效果。
 *
 * 策略:每 ~24ms 揭示一批字符,批大小随"积压"自适应(积压越多揭得越快但仍逐字),
 * 这样大块也能在 ~1 秒内顺滑追上,小块则慢慢敲。文本被替换(换章)时从头重敲。
 */
import * as React from "react"

const TICK_MS = 24
const MAX_STEP = 16
const BACKLOG_DIVISOR = 22

export function useTypewriter(full: string, active: boolean): string {
  const [display, setDisplay] = React.useState("")
  const shownRef = React.useRef(0)
  const fullRef = React.useRef(full)
  fullRef.current = full

  React.useEffect(() => {
    if (!active) {
      // 收尾/空闲:直接显示完整文本,不要卡在半截
      shownRef.current = fullRef.current.length
      setDisplay(fullRef.current)
      return
    }
    const id = setInterval(() => {
      const target = fullRef.current.length
      let shown = shownRef.current
      if (shown > target) shown = 0 // 文本被换掉(新章) → 从头重敲
      if (shown < target) {
        const backlog = target - shown
        const step = Math.max(1, Math.min(MAX_STEP, Math.ceil(backlog / BACKLOG_DIVISOR)))
        shown = Math.min(target, shown + step)
        shownRef.current = shown
        setDisplay(fullRef.current.slice(0, shown))
      } else {
        shownRef.current = shown
      }
    }, TICK_MS)
    return () => clearInterval(id)
  }, [active])

  return active ? display : full
}
