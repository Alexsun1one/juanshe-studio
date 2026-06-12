"use client"

import * as React from "react"
import "./celebration-burst.css"

// 进展庆祝:里程碑时刻顶部短暂浮现一句温暖鼓励 + 像素星徽。
// 纯前端、无 token、不烧钱;自动消失,点一下也可关;尊重 prefers-reduced-motion。
// 触发方式:父组件每到一次里程碑就把 signal +1(0 表示从未触发)。
// tone 分档:write=写完一章(默认) / approve=批准达标章 / finish=全书完本(停更久、三颗星)。

export type CelebrationTone = "write" | "approve" | "finish"

const CHEERS: Record<CelebrationTone, readonly string[]> = {
  write: [
    "辛苦了,又往前推了一程",
    "稳稳的,这一章拿下了",
    "好状态,保持住这股劲",
    "编辑部全员为你鼓掌",
    "一个字一个字,你在变强",
    "今天的你,值得这一下庆祝",
    "故事又长大了一点点",
  ],
  approve: [
    "过审啦,这一批可以见读者了",
    "主编点头,正式定稿",
    "盖章签发,这一批稳了",
    "达标稿入库,离完本又近一步",
  ],
  finish: [
    "完本了!这本书走完了全程",
    "从第一章到最后一章,都是你的",
    "编辑部全员起立鼓掌",
  ],
}

const TITLES: Record<CelebrationTone, string> = {
  write: "写好了",
  approve: "过审了",
  finish: "完本了!",
}

// 5×5 像素星
function PixelStar() {
  const cells = [[2], [1, 2, 3], [0, 1, 2, 3, 4], [1, 2, 3], [0, 2, 4]]
  return (
    <svg viewBox="0 0 5 5" width="22" height="22" aria-hidden="true" className="cb-star" shapeRendering="crispEdges">
      {cells.flatMap((row, y) => row.map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" />))}
    </svg>
  )
}

export function CelebrationBurst({
  signal,
  score,
  tone = "write",
  note,
}: {
  signal: number
  score?: number
  tone?: CelebrationTone
  note?: string
}) {
  const [show, setShow] = React.useState(false)
  const [cheer, setCheer] = React.useState<string>(CHEERS.write[0])

  React.useEffect(() => {
    if (!signal) return
    const pool = CHEERS[tone]
    setCheer(pool[signal % pool.length])
    setShow(true)
    // 完本是最大的里程碑,卡片停留更久(9s),其余 6.5s 即收
    const t = setTimeout(() => setShow(false), tone === "finish" ? 9000 : 6500)
    return () => clearTimeout(t)
  }, [signal, tone])

  if (!show) return null

  return (
    <div className="cb-wrap" role="status" aria-live="polite" onClick={() => setShow(false)}>
      <div className="cb-card" data-tone={tone}>
        <span className="cb-spark cb-spark-1" aria-hidden="true">✦</span>
        <span className="cb-spark cb-spark-2" aria-hidden="true">✧</span>
        <span className="cb-spark cb-spark-3" aria-hidden="true">✦</span>
        {tone === "finish" ? (
          <span className="cb-stars" aria-hidden="true"><PixelStar /><PixelStar /><PixelStar /></span>
        ) : (
          <PixelStar />
        )}
        <div className="cb-text">
          <div className="cb-title">{TITLES[tone]}</div>
          <div className="cb-sub">
            {cheer}
            {note ? <span className="cb-score"> · {note}</span> : null}
            {typeof score === "number" && score > 0 ? <span className="cb-score"> · 本章 {score} 分</span> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
