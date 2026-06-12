"use client"

import type { LucideIcon } from "lucide-react"
import {
  BookOpenText,
  Cpu,
  Gauge,
  GitCompareArrows,
  PenLine,
  ScanLine,
  ShieldAlert,
  Sparkles,
  Wand2,
} from "lucide-react"

import { AssistantConsole } from "@/components/assistant/assistant-console"
import { KpiChip } from "@/components/design/kit"
import { EDITORIAL_STAFF_COUNT } from "@/lib/agent-identity"
import "./assistant.css"

// 「能直接对它说什么」—— 一行带语义图标的 chip,把真实工作流摊开,替代空白与等大卡片。
// 图标按任务语义精确选取(扫痕/改写/对齐/节奏/护栏),让条目一眼可辨。
const CUES: ReadonlyArray<{ icon: LucideIcon; text: string }> = [
  { icon: ScanLine, text: "检查这一章的 AI 痕迹风险" },
  { icon: PenLine, text: "给出三处可直接改写的句子" },
  { icon: GitCompareArrows, text: "校对设定与时序一致性" },
  { icon: Gauge, text: "把这一章改写成更紧凑的节奏" },
  { icon: ShieldAlert, text: "总结当前作品的整体风险" },
]

export default function AssistantPage() {
  return (
    <div className="cj-screen cj-assistant">
      {/* ── 顶部工作条:像素「AI 助手」+ 标题 + 一行能力数据(密集而克制,非大卡堆)── */}
      <header className="cj-workhead as-head">
        <div className="as-headline">
          <div className="as-hero-pixel as-hero-desk" role="img" aria-label="助手会话台">
            <img src="/brand/props/assistant-desk.webp" alt="" width={124} height={97} draggable={false} />
          </div>
          <div className="as-headline-text">
            <span className="as-kicker">
              <Sparkles aria-hidden /> {EDITORIAL_STAFF_COUNT} 位编辑 + 1 只猫 · 真实 Agent 会话
            </span>
            <div className="page-title-row">
              <h1 className="page-title">编辑部的猫</h1>
            </div>
            {/* 单行省略的页头契约下文案必须短到放得下:保住「小事自己办 / 大事叫编辑」的预期管理 */}
            <p className="page-sub">
              大白话说你想怎么改;小事猫顺手办,大事它去叫醒对应编辑。
            </p>
          </div>
          <div className="as-kpis" role="group" aria-label="助手能力概览">
            <KpiChip
              label="常用任务"
              value={CUES.length}
              unit="项"
              tone="brand"
              hint="下方「可以直接对它说」预置的任务模板数量"
            />
            <div className="as-fact">
              <span className="as-fact-ico" aria-hidden>
                <BookOpenText size={15} />
              </span>
              <span className="as-fact-body">
                <span className="as-fact-v">自动绑定</span>
                <span className="as-fact-l">当前作品上下文</span>
              </span>
            </div>
            <div className="as-fact">
              <span className="as-fact-ico" aria-hidden>
                <Cpu size={15} />
              </span>
              <span className="as-fact-body">
                <span className="as-fact-v">真实接口</span>
                <span className="as-fact-l">Agent 执行</span>
              </span>
            </div>
          </div>
        </div>

        {/* 能力提示条:一行内联「可以直接对它说」,每条带语义图标,chip 而非卡片网格 */}
        <div className="as-cues">
          <span className="as-cues-lead">
            <Wand2 aria-hidden /> 可以直接对它说
          </span>
          <div className="as-cue-strip">
            {CUES.map((cue, i) => {
              const Icon = cue.icon
              return (
                <span className="as-cue" key={cue.text}>
                  <span className="as-cue-k">{String(i + 1).padStart(2, "0")}</span>
                  <Icon className="as-cue-ico" aria-hidden />
                  {cue.text}
                </span>
              )
            })}
          </div>
          {/* 模板数量只在左上 KpiChip 展示一次,行尾不再重复计数 */}
        </div>
      </header>

      {/* ── 主体:对话台本体(共享组件,功能/SWR/handler 不动)铺满工作区,pane 内自滚 ── */}
      <div className="cj-screen-body solo as-body">
        <div className="cj-mainpane as-mainpane">
          <AssistantConsole hideHeader />
        </div>
      </div>
    </div>
  )
}
