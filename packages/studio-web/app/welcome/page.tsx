"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowRight } from "lucide-react"
import { AgentPixel } from "@/components/design/agent-pixel"
import { useAuthorName } from "@/lib/use-author-name"
import "./welcome.css"

/* 卷舍 · 编辑部入职过场
   登录成功后(首次)总编逐字寒暄,同事探头搭腔,一点进站。
   情感:一群闲坏了、爱写书、很卷、终于等到搭档的伙伴,温暖地欢迎你入伙。
   称呼性别中立(全程"你");打字手感复用 design.css 的 stream-caret。
   只首次播放(localStorage cj.onboarded),复访由 /login 直接跳 /。 */

const LINES = [
  "哎呀,你可算来了!",
  "说实话,我们这帮编辑闲了好一阵,手都痒了。",
  "我们这群人,爱好就一个 —— 写书;毛病也就一个 —— 卷。",
  "往后你只管把脑子里的故事丢进来,剩下的,交给我们。",
  "选题、写、审、润色、排版、发布,一条龙,我们好好给你干,你放心。",
  "对了——动笔前你得先把写作模型的钥匙交给我,谁来执笔、谁来润色,都能单独挑模型。",
  "走,我带你认认这帮家伙 —",
] as const

// 同事探头:某句出现时,旁边 agent 冒头搭一句腔,制造"一屋子人"的热闹
const CHEERS: Record<number, { fid: string; name: string; word: string }> = {
  2: { fid: "writer", name: "写手", word: "正文我包了,熬夜那种。" },
  4: { fid: "editor", name: "审稿官", word: "错别字?在我这儿过不去。" },
}

// 底部待命的编辑部成员(像素全家福)
const CAST: ReadonlyArray<{ fid: string; name: string }> = [
  { fid: "market-radar", name: "市场雷达" },
  { fid: "architect", name: "架构师" },
  { fid: "planner", name: "规划师" },
  { fid: "writer", name: "写手" },
  { fid: "editor", name: "审稿官" },
  { fid: "reader-critic", name: "读者评审官" },
  { fid: "reviser", name: "修稿师" },
  { fid: "polisher", name: "润色师" },
  { fid: "style-fingerprint", name: "风格指纹官" },
  { fid: "managing-editor", name: "执行主编" },
]

export default function WelcomePage() {
  const router = useRouter()
  const authorName = useAuthorName()
  const [idx, setIdx] = React.useState(0)
  const [typed, setTyped] = React.useState("")
  const full = LINES[idx]
  const lineDone = typed === full
  const allDone = idx >= LINES.length - 1 && lineDone
  const cheer = CHEERS[idx]

  // 逐字打字当前句
  React.useEffect(() => {
    setTyped("")
    let i = 0
    const t = window.setInterval(() => {
      i += 1
      setTyped(full.slice(0, i))
      if (i >= full.length) window.clearInterval(t)
    }, 52)
    return () => window.clearInterval(t)
  }, [idx, full])

  // 当前句打完后自动推进到下一句(最后一句停住,等"进入")
  React.useEffect(() => {
    if (!lineDone || idx >= LINES.length - 1) return
    const t = window.setTimeout(() => setIdx((x) => x + 1), cheer ? 1700 : 1000)
    return () => window.clearTimeout(t)
  }, [lineDone, idx, cheer])

  const enter = React.useCallback(() => {
    try {
      localStorage.setItem("cj.onboarded", "1")
    } catch {
      /* ignore */
    }
    router.push("/")
  }, [router])

  // 点击/空格:未打完→秒显全句;已打完→下一句;全部完→进站
  const advance = React.useCallback(() => {
    if (!lineDone) {
      setTyped(full)
      return
    }
    if (idx < LINES.length - 1) setIdx((x) => x + 1)
    else enter()
  }, [lineDone, full, idx, enter])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        advance()
      } else if (e.key === "Escape") {
        enter()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [advance, enter])

  return (
    <div className="cj-welcome" onClick={advance} role="presentation">
      <div className="cj-welcome-stage" onClick={(e) => e.stopPropagation()} role="presentation">
        <button type="button" className="cj-welcome-skip" onClick={enter}>跳过</button>

        <div className="cj-welcome-top">
          <div className="cj-welcome-chief">
            <span className="cj-welcome-chief-pixel">
              <AgentPixel id="editor-in-chief" size={92} ariaLabel="总编" />
            </span>
            <span className="cj-welcome-chief-badge">总编</span>
          </div>

          <div className="cj-welcome-bubble" aria-live="polite">
            <p className="cj-welcome-line">
              {typed}
              <span className="stream-caret" aria-hidden />
            </p>
            {cheer && lineDone && (
              <div className="cj-welcome-cheer">
                <AgentPixel id={cheer.fid} size={26} ariaLabel={cheer.name} />
                <span className="cj-welcome-cheer-name">{cheer.name}</span>
                <span className="cj-welcome-cheer-word">{cheer.word}</span>
              </div>
            )}
          </div>
        </div>

        <div className="cj-welcome-cast" aria-hidden>
          {CAST.map((m, i) => (
            <span className="cj-welcome-cast-m" key={m.fid} style={{ ["--d" as string]: `${i * 0.07}s` }} title={m.name}>
              <AgentPixel id={m.fid} size={30} ariaLabel={m.name} />
            </span>
          ))}
        </div>

        <div className="cj-welcome-foot">
          <div className="cj-welcome-dots" aria-hidden>
            {LINES.map((_, i) => (
              <span key={i} className={`cj-welcome-dot${i <= idx ? " on" : ""}`} />
            ))}
          </div>
          <button
            type="button"
            className={`cj-welcome-enter${allDone ? " ready" : ""}`}
            onClick={(e) => { e.stopPropagation(); advance() }}
          >
            {allDone ? "进入编辑部" : "继续"}
            <ArrowRight size={16} />
          </button>
        </div>

        {authorName && authorName !== "作者大大" && (
          <p className="cj-welcome-hi">—— 欢迎入伙,{authorName}</p>
        )}
      </div>
    </div>
  )
}
