"use client"

import * as React from "react"
import "./celebration-burst.css"

// 进展庆祝:一章/一轮写作完成时,顶部短暂浮现一句温暖鼓励 + 像素星徽。
// 纯前端、无 token、不烧钱;6.5s 自动消失,点一下也可关;尊重 prefers-reduced-motion。
// 触发方式:父组件每完成一次写作就把 signal +1(0 表示从未触发)。

const CHEERS = [
  "辛苦了,又往前推了一程",
  "稳稳的,这一章拿下了",
  "好状态,保持住这股劲",
  "编辑部全员为你鼓掌",
  "一个字一个字,你在变强",
  "今天的你,值得这一下庆祝",
  "故事又长大了一点点",
]

// 5×5 像素星
function PixelStar() {
  const cells = [[2], [1, 2, 3], [0, 1, 2, 3, 4], [1, 2, 3], [0, 2, 4]]
  return (
    <svg viewBox="0 0 5 5" width="22" height="22" aria-hidden="true" className="cb-star" shapeRendering="crispEdges">
      {cells.flatMap((row, y) => row.map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" />))}
    </svg>
  )
}

export function CelebrationBurst({ signal, score }: { signal: number; score?: number }) {
  const [show, setShow] = React.useState(false)
  const [cheer, setCheer] = React.useState(CHEERS[0])

  React.useEffect(() => {
    if (!signal) return
    setCheer(CHEERS[signal % CHEERS.length])
    setShow(true)
    const t = setTimeout(() => setShow(false), 6500)
    return () => clearTimeout(t)
  }, [signal])

  if (!show) return null

  return (
    <div className="cb-wrap" role="status" aria-live="polite" onClick={() => setShow(false)}>
      <div className="cb-card">
        <span className="cb-spark cb-spark-1" aria-hidden="true">✦</span>
        <span className="cb-spark cb-spark-2" aria-hidden="true">✧</span>
        <span className="cb-spark cb-spark-3" aria-hidden="true">✦</span>
        <PixelStar />
        <div className="cb-text">
          <div className="cb-title">写好了</div>
          <div className="cb-sub">
            {cheer}
            {typeof score === "number" && score > 0 ? <span className="cb-score"> · 本章 {score} 分</span> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
