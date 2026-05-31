"use client"

/**
 * WarmWhisper — 工作台一句"会呼吸"的温暖低语。
 * 时段感知 + 写作态感知,写死的短句池里轮换(不调 LLM、不烧 token),
 * 每隔 ~42s 或重新进页面换一句。像素图标 + 闪烁方块光标,做出"像素/终端"质感。
 *
 * 想要"正文也是真像素字形"的话,需要自托管一个像素中文字体(如 Zpix/fusion-pixel);
 * 给本组件根节点加 class="ww-pixelfont" 即可切换,字体没就绪时退回 UI 字体也好看。
 */

import * as React from "react"
import "./warm-whisper.css"

type Bucket = "deepNight" | "morning" | "afternoon" | "evening" | "writing"

const POOLS: Record<Bucket, readonly string[]> = {
  deepNight: [
    "夜深了,还没休息吗?身体比进度重要。",
    "凌晨写下的字,记得明天醒了再读一遍。",
    "编辑部的灯还亮着 —— 但你的眼睛该合一会儿了。",
    "这个点了,存个稿,去睡吧,故事跑不掉。",
  ],
  morning: [
    "早。新的一章,从一杯水开始。",
    "清晨脑子最清楚,先啃最难写的那一段。",
    "醒了就好,慢慢来,今天也只写一章。",
  ],
  afternoon: [
    "午后容易困,写不动就先起来走两步。",
    "卡住了别硬磕,让规划师先帮你理一理。",
    "写到一半的章,留个钩子,再去吃饭。",
  ],
  evening: [
    "入夜了,灯光调暖一点,故事也会软一点。",
    "今天写了多少不重要,有没有写下去才重要。",
    "晚上灵感多,但别忘了随手存稿。",
  ],
  writing: [
    "写手正伏在案上 —— 你可以去喝口水。",
    "交给编辑部了,放轻松,它在替你跑。",
    "这一章在生成,要不要顺手伸个懒腰?",
  ],
}

function bucketForHour(h: number): Bucket {
  if (h >= 0 && h < 5) return "deepNight"
  if (h < 11) return "morning"
  if (h < 17) return "afternoon"
  return "evening"
}

/** 小像素图标:夜=月、晨/午=日、晚=心、写作中=笔。crispEdges 保持像素感。 */
function PixelGlyph({ bucket }: { bucket: Bucket }) {
  const common = { width: 14, height: 14, viewBox: "0 0 14 14", shapeRendering: "crispEdges" as const, "aria-hidden": true }
  if (bucket === "deepNight") {
    return (
      <svg {...common} className="ww-glyph">
        <rect x="3" y="2" width="6" height="2" fill="#9D8AFF" />
        <rect x="2" y="4" width="3" height="6" fill="#9D8AFF" />
        <rect x="3" y="10" width="6" height="2" fill="#9D8AFF" />
        <rect x="7" y="3" width="2" height="2" fill="#6E5BFA" />
        <rect x="9" y="5" width="2" height="2" fill="#6E5BFA" />
      </svg>
    )
  }
  if (bucket === "writing") {
    return (
      <svg {...common} className="ww-glyph">
        <rect x="8" y="2" width="3" height="3" fill="#2BB97A" />
        <rect x="6" y="4" width="3" height="3" fill="#2BB97A" />
        <rect x="4" y="6" width="3" height="3" fill="#2BB97A" />
        <rect x="3" y="9" width="2" height="2" fill="#F8C994" />
        <rect x="2" y="11" width="2" height="1" fill="#5C6478" />
      </svg>
    )
  }
  if (bucket === "evening") {
    return (
      <svg {...common} className="ww-glyph">
        <rect x="2" y="3" width="3" height="2" fill="#E0688A" />
        <rect x="9" y="3" width="3" height="2" fill="#E0688A" />
        <rect x="2" y="5" width="10" height="3" fill="#E0688A" />
        <rect x="3" y="8" width="8" height="2" fill="#E0688A" />
        <rect x="5" y="10" width="4" height="2" fill="#E0688A" />
      </svg>
    )
  }
  // morning / afternoon — 太阳
  return (
    <svg {...common} className="ww-glyph">
      <rect x="5" y="5" width="4" height="4" fill="#F8B84A" />
      <rect x="6" y="1" width="2" height="2" fill="#F8C994" />
      <rect x="6" y="11" width="2" height="2" fill="#F8C994" />
      <rect x="1" y="6" width="2" height="2" fill="#F8C994" />
      <rect x="11" y="6" width="2" height="2" fill="#F8C994" />
    </svg>
  )
}

export function WarmWhisper({ writing = false }: { writing?: boolean }) {
  const [msg, setMsg] = React.useState<string>("")
  const [bucket, setBucket] = React.useState<Bucket>("afternoon")

  React.useEffect(() => {
    const pick = () => {
      const b: Bucket = writing && Math.random() < 0.5 ? "writing" : bucketForHour(new Date().getHours())
      const pool = POOLS[b]
      setBucket(b)
      setMsg(pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!)
    }
    pick()
    const timer = setInterval(pick, 42000)
    return () => clearInterval(timer)
  }, [writing])

  if (!msg) return null
  return (
    <div className="warm-whisper" role="status" aria-live="polite">
      <PixelGlyph bucket={bucket} />
      <span className="ww-text" key={msg}>{msg}</span>
      <span className="ww-cursor" aria-hidden>▮</span>
    </div>
  )
}
