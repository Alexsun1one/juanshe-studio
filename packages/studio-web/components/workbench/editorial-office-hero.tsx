"use client"

/**
 * EditorialOfficeHero — 工作台首页的「卷·编辑部」全景插画。
 *
 * 17 位角色按 6 个部门分布在像素工作室里,每人有自己的工位(桌 + 椅 + 台灯)。
 * 真数据驱动:
 *   - agent 正在跑 → 台灯亮(身份色),呼吸动画
 *   - 已完成本轮 → 台灯余温(淡绿)
 *   - 待命 → 灯灭
 * 点击任一工位 → 跳到 /system?agent=<fid>
 *
 * 暗/明 自适配:用 CSS 变量 + currentColor。
 */

import * as React from "react"
import Link from "next/link"
import { AgentPixel } from "@/components/design/agent-pixel"
import { useAgentActivity } from "@/lib/use-agent-activity"
import { useRunState } from "@/lib/use-run-state"
import { useLiveRun } from "@/lib/use-live-run"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"
import "./editorial-office-hero.css"

/** 编辑部部门 + 角色排布(对应 17 位) */
const DEPTS: ReadonlyArray<{
  id: string
  label: string
  agents: ReadonlyArray<{ fid: string; name: string }>
}> = [
  {
    id: "strategy", label: "战略选题",
    agents: [
      { fid: "market-radar", name: "市场雷达" },
      { fid: "architect", name: "架构师" },
      { fid: "setup-auditor", name: "建书复审官" },
    ],
  },
  {
    id: "writing", label: "写作",
    agents: [
      { fid: "planner", name: "规划师" },
      { fid: "writer", name: "写手" },
      { fid: "chapter-analyst", name: "章节分析官" },
    ],
  },
  {
    id: "review", label: "评审",
    agents: [
      { fid: "editor", name: "审稿官" },
      { fid: "reader-critic", name: "读者评审官" },
      { fid: "quality-report", name: "质量报告官" },
    ],
  },
  {
    id: "revision", label: "修改打磨",
    agents: [
      { fid: "reviser", name: "修稿师" },
      { fid: "word-steward", name: "字数治理官" },
      { fid: "polisher", name: "润色师" },
    ],
  },
  {
    id: "ops", label: "运营质保",
    agents: [
      { fid: "state-verifier", name: "状态校验员" },
      { fid: "style-fingerprint", name: "风格指纹官" },
      { fid: "prompt-steward", name: "提示词治理官" },
    ],
  },
  {
    id: "eic", label: "总编室",
    agents: [
      { fid: "managing-editor", name: "执行主编" },
      { fid: "editor-in-chief", name: "总编" },
    ],
  },
]

export function EditorialOfficeHero({
  bookId,
  layout = "horizontal",
}: {
  bookId?: string
  /** horizontal:全屏首页全景;vertical:右侧竖列(部门堆叠) */
  layout?: "horizontal" | "vertical"
}) {
  const activity = useAgentActivity(bookId)
  const run = useRunState(bookId)
  const live = useLiveRun(bookId)
  const isRunning = run.isRunning || live.active

  // 算每个角色的状态
  const statusOf = (fid: string): "running" | "done" | "idle" => {
    const live = activity.statusByAgent[fid]
    if (live) return live
    return "idle"
  }

  const runningCount = DEPTS.flatMap((d) => d.agents).filter((a) => statusOf(a.fid) === "running").length
  const doneCount = DEPTS.flatMap((d) => d.agents).filter((a) => statusOf(a.fid) === "done").length

  // ① 仿真:追踪"当前在写的人";真实接棒(running 的人变了)时,让一份手稿从上一个人
  //   的工位滑到下一个人的工位(发光轨迹 + 轻微抛物线),下一个人的台灯随之亮起。
  const runningFid = (() => {
    for (const d of DEPTS) for (const a of d.agents) if (statusOf(a.fid) === "running") return a.fid
    return null
  })()
  const floorRef = React.useRef<HTMLDivElement>(null)
  const prevRunningRef = React.useRef<string | null>(null)
  const courierKeyRef = React.useRef(0)
  const [courier, setCourier] = React.useState<{ x1: number; y1: number; x2: number; y2: number; key: number } | null>(null)
  const [departFrom, setDepartFrom] = React.useState<string | null>(null)
  const [deliverTo, setDeliverTo] = React.useState<string | null>(null)

  // 全员扁平(17 位,按流水线顺序);竖排切成 4 人一桌的 pod(面对面工位),空闲态按此顺序演示"送稿"
  const ALL = React.useMemo(() => DEPTS.flatMap((d) => d.agents.map((a) => ({ fid: a.fid, name: a.name }))), [])
  const ORDER = React.useMemo(() => ALL.map((a) => a.fid), [ALL])
  const PODS = React.useMemo(() => {
    const out: { fid: string; name: string }[][] = []
    for (let i = 0; i < ALL.length; i += 4) out.push(ALL.slice(i, i + 4))
    return out
  }, [ALL])

  // 发一次"送稿":算工位坐标 → 稿子抛物线飞过去;发出方起身递出、送达方收到一闪
  const fireCourier = React.useCallback((fromFid: string, toFid: string) => {
    const floor = floorRef.current
    if (!floor || fromFid === toFid) return
    const fromEl = floor.querySelector<HTMLElement>(`[data-fid="${CSS.escape(fromFid)}"]`)
    const toEl = floor.querySelector<HTMLElement>(`[data-fid="${CSS.escape(toFid)}"]`)
    if (!fromEl || !toEl) return
    const fr = floor.getBoundingClientRect()
    const a = fromEl.getBoundingClientRect()
    const b = toEl.getBoundingClientRect()
    setCourier({
      x1: a.left - fr.left + a.width / 2 - 7,
      y1: a.top - fr.top + 4,
      x2: b.left - fr.left + b.width / 2 - 7,
      y2: b.top - fr.top + 4,
      key: ++courierKeyRef.current,
    })
    setDepartFrom(fromFid)
    setDeliverTo(toFid)
  }, [])

  // 真实运行:running 的人变了 → 从上一个人送到下一个人
  React.useEffect(() => {
    const prev = prevRunningRef.current
    const next = runningFid
    if (next && prev && next !== prev) fireCourier(prev, next)
    prevRunningRef.current = next
  }, [runningFid, fireCourier])

  // 空闲态:按流水线顺序周期性演示交接,让工作室始终"活着"(尊重 reduced-motion)
  const idleIdxRef = React.useRef(0)
  React.useEffect(() => {
    if (isRunning) return
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const span = Math.max(1, ORDER.length - 1)
    const tick = () => {
      const i = idleIdxRef.current % span
      fireCourier(ORDER[i], ORDER[i + 1])
      idleIdxRef.current = (idleIdxRef.current + 1) % span
    }
    const first = setTimeout(tick, 800)
    const id = setInterval(tick, 2600)
    return () => { clearTimeout(first); clearInterval(id) }
  }, [isRunning, ORDER, fireCourier])

  // 清理:稿子飞完移除;起身/收到高亮稍后清
  React.useEffect(() => {
    if (!courier) return
    const t = setTimeout(() => setCourier(null), 920)
    return () => clearTimeout(t)
  }, [courier])
  React.useEffect(() => {
    if (!departFrom && !deliverTo) return
    const t = setTimeout(() => { setDepartFrom(null); setDeliverTo(null) }, 1100)
    return () => clearTimeout(t)
  }, [departFrom, deliverTo])

  // 单个工位(台灯 + 角色 + 桌 + 名牌);两种布局复用,竖排里 figure 更小更清爽
  const renderStation = (fid: string, name: string) => {
    const status = statusOf(fid)
    return (
      <Link
        key={fid}
        data-fid={fid}
        href={`/system?agent=${encodeURIComponent(fid)}`}
        className={`eo-station eo-${status}${fid === deliverTo ? " eo-deliver" : ""}${fid === departFrom ? " eo-depart" : ""}`}
        title={`${name} · ${status === "running" ? "进行中" : status === "done" ? "已完成本轮" : "待命"}`}
      >
        <span className="eo-lamp" aria-hidden>
          <span className="eo-lamp-arm" />
          <span className="eo-lamp-shade" />
          <span className="eo-lamp-bulb" />
          {status === "running" && <span className="eo-lamp-glow" />}
        </span>
        <span className="eo-figure">
          <AgentPixel id={fid} size={layout === "vertical" ? 30 : 44} ariaLabel={name} />
        </span>
        <span className="eo-desk" aria-hidden />
        <span className="eo-name">{name}</span>
      </Link>
    )
  }

  return (
    <section className={`eo-hero eo-${layout}`}>
      {/* 顶部状态栏 — 在场景上方,给场景留干净空间 */}
      <div className="eo-status-bar">
        <span className="eo-title">编辑部 · 全员视图</span>
        <span className="eo-status-pills">
          <span className={`eo-pill ${isRunning ? "live" : "idle"}`}>
            <span className="eo-pill-dot" />
            {isRunning ? "运营中" : "全员待命"}
          </span>
          {runningCount > 0 && <span className="eo-pill brand">{runningCount} 个在跑</span>}
          {doneCount > 0 && <span className="eo-pill ok">{doneCount} 已完成本轮</span>}
        </span>
      </div>

      {/* 场景画布 — SVG 背景 + 工位 grid */}
      <div className="eo-scene">
        {/* 背景:书架(顶) + 木地板(底) */}
        <div className="eo-bg" aria-hidden>
          <svg viewBox="0 0 800 240" className="eo-bg-svg" preserveAspectRatio="none">
            {/* 木地板渐变 */}
            <defs>
              <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--eo-floor-top)" />
                <stop offset="1" stopColor="var(--eo-floor-bot)" />
              </linearGradient>
              <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--eo-wall-top)" />
                <stop offset="1" stopColor="var(--eo-wall-bot)" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width="800" height="160" fill="url(#wall)" />
            <rect x="0" y="160" width="800" height="80" fill="url(#floor)" />
            {/* 书架(顶部) — 3 排平行架子,上面随机摆书 */}
            {[20, 50, 80].map((y) =>
              <g key={`shelf-${y}`}>
                <rect x="0" y={y} width="800" height="2" fill="var(--eo-shelf)" />
                {Array.from({ length: 32 }).map((_, i) => {
                  const bx = 8 + i * 24
                  const bh = 14 + ((i * 7) % 8)
                  const colors = ["#6E5BFA", "#F8C994", "#2BB97A", "#E04848", "#9D8AFF", "#5C6478"]
                  const c = colors[(i + y) % colors.length]
                  return <rect key={`b-${y}-${i}`} x={bx} y={y - bh} width={6 + ((i * 3) % 4)} height={bh} fill={c} opacity={0.85} />
                })}
              </g>
            )}
            {/* 地板纹理:暗一档的水平线 */}
            {[170, 185, 200, 215, 230].map((y) =>
              <rect key={`fl-${y}`} x="0" y={y} width="800" height="1" fill="var(--eo-floor-line)" opacity={0.4} />
            )}
          </svg>
        </div>

        {/* 工位 grid — 6 部门横向排,每部门 2-3 工位竖列。
            vertical 模式下,隔行 has-shelf(0/2/4 部门顶有书架装饰,其余朴素) */}
        <div className={`eo-floor${layout === "vertical" ? " eo-grid" : ""}`} ref={floorRef}>
          {layout === "vertical" ? (
            <>
              {/* 装饰层:门 / 时钟 / 花草 / 报纸 —— 给工作室生活感(纯装饰)*/}
              <div className="eo-decor" aria-hidden>
                <span className="eo-door"><span className="eo-door-knob" /></span>
                <span className="eo-clock" />
                <span className="eo-plant eo-plant-a"><span className="eo-pot" /></span>
                <span className="eo-plant eo-plant-b"><span className="eo-pot" /></span>
                <span className="eo-plant eo-plant-center"><span className="eo-pot" /></span>
                <span className="eo-rug" />
                <span className="eo-news" />
              </div>
              {/* 4 人一桌的 pod(面对面工位):上 2 人 / 共享桌 / 下 2 人;pod 分散排布像真实公司 */}
              <div className="eo-pods">
                {PODS.map((pod, i) => (
                  <div className={`eo-pod${pod.length <= 1 ? " eo-pod-solo" : ""}`} key={i}>
                    <span className="eo-pod-table" aria-hidden />
                    {pod.map((a) => renderStation(a.fid, a.name))}
                  </div>
                ))}
              </div>
            </>
          ) : (
            DEPTS.map((dept) => {
              const deptRunning = dept.agents.filter((a) => statusOf(a.fid) === "running").length
              const deptDone = dept.agents.filter((a) => statusOf(a.fid) === "done").length
              const deptState = deptRunning > 0 ? "running" : deptDone === dept.agents.length ? "done" : "idle"
              return (
                <div key={dept.id} className={`eo-dept eo-dept-${deptState}`}>
                  <div className="eo-dept-tag">
                    <span className="eo-dept-name">{dept.label}</span>
                  </div>
                  <div className="eo-stations">{dept.agents.map((a) => renderStation(a.fid, a.name))}</div>
                </div>
              )
            })
          )}
          {courier && (
            <span
              className="eo-courier"
              key={courier.key}
              aria-hidden
              style={{ "--x1": `${courier.x1}px`, "--y1": `${courier.y1}px`, "--x2": `${courier.x2}px`, "--y2": `${courier.y2}px` } as React.CSSProperties}
            >
              <span className="eo-courier-page" />
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
