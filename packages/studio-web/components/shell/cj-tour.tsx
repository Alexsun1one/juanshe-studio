"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { ArrowRight, X } from "lucide-react"

/* 卷舍 · 新手引导(spotlight)
   入职过场("走,带你认认这帮家伙")的兑现:进站后总编口吻逐步点亮工作台关键区。
   只首次播放:welcome 设 cj.onboarded 后,这里检查 cj.toured 未设才启动;结束设 cj.toured。
   高亮用遮罩挖洞(box-shadow spread),气泡贴目标。响应式与边界为基础版,后续打磨。 */

type Step = {
  sel: string
  title: string
  body: string
  place?: "bottom" | "right" | "top"
}

const STEPS: Step[] = [
  { sel: ".sidebar", title: "这是你的编辑部", body: "17 个编辑分管选题、写作、审稿、润色、排版到发布。每个工种点开都能调教。", place: "right" },
  { sel: ".workspace-sel", title: "作品在这儿切换", body: "你的每一部书都在这里。新建一本,编辑部就开始为它起稿故事框架。", place: "bottom" },
  { sel: ".writer-actions", title: "来,写第一章", body: "点「继续创作」—— 规划师先读设定,再把意图交给写手落正文,流式刷给你看。", place: "top" },
  { sel: ".theme-color-trigger", title: "换个心情", body: "想要别的颜色?这儿 7 套主题随你切,暖纸和像素魂都不变。", place: "bottom" },
]

export function CjTour() {
  const [mounted, setMounted] = React.useState(false)
  const [active, setActive] = React.useState(false)
  const [step, setStep] = React.useState(0)
  const [rect, setRect] = React.useState<DOMRect | null>(null)

  React.useEffect(() => setMounted(true), [])

  React.useEffect(() => {
    try {
      if (localStorage.getItem("cj.onboarded") === "1" && localStorage.getItem("cj.toured") !== "1") {
        const t = window.setTimeout(() => setActive(true), 650)
        return () => window.clearTimeout(t)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const measure = React.useCallback(() => {
    const el = document.querySelector(STEPS[step].sel)
    if (el) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" })
      setRect(el.getBoundingClientRect())
    } else {
      setRect(null)
    }
  }, [step])

  React.useEffect(() => {
    if (!active) return
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [active, measure])

  const finish = React.useCallback(() => {
    try { localStorage.setItem("cj.toured", "1") } catch { /* ignore */ }
    setActive(false)
  }, [])

  const next = React.useCallback(() => {
    setStep((s) => {
      if (s < STEPS.length - 1) return s + 1
      finish()
      return s
    })
  }, [finish])

  if (!mounted || !active) return null

  const s = STEPS[step]
  const pad = 6
  const hole = rect
    ? { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : null

  // 气泡定位(基础版:按 place 贴目标,夹取到视口内)
  const bubbleW = 300
  let bx = 24
  let by = 24
  if (rect) {
    const place = s.place ?? "bottom"
    if (place === "right") { bx = rect.right + 14; by = rect.top }
    else if (place === "top") { bx = rect.left; by = Math.max(16, rect.top - 150) }
    else { bx = rect.left; by = rect.bottom + 14 }
    bx = Math.min(Math.max(16, bx), window.innerWidth - bubbleW - 16)
    by = Math.min(Math.max(16, by), window.innerHeight - 170)
  }

  return createPortal(
    <div className="cj-tour" role="dialog" aria-label="新手引导">
      {hole ? (
        <div className="cj-tour-hole" style={{ left: hole.left, top: hole.top, width: hole.width, height: hole.height }} />
      ) : (
        <div className="cj-tour-scrim" />
      )}
      <div className="cj-tour-bubble" style={{ left: bx, top: by, width: bubbleW }}>
        <button type="button" className="cj-tour-x" onClick={finish} aria-label="跳过引导"><X size={14} /></button>
        <div className="cj-tour-step">总编带逛 · {step + 1}/{STEPS.length}</div>
        <div className="cj-tour-title">{s.title}</div>
        <p className="cj-tour-body">{s.body}</p>
        <div className="cj-tour-foot">
          <button type="button" className="cj-tour-skip" onClick={finish}>跳过</button>
          <button type="button" className="cj-tour-next" onClick={next}>
            {step < STEPS.length - 1 ? "下一个" : "开始创作"}
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
