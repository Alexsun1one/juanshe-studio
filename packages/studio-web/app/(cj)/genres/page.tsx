import * as React from "react"
import {
  ArrowRight,
  Compass,
  FileInput,
  Gauge,
  Languages,
  ScanSearch,
  ShieldCheck,
  Tags,
} from "lucide-react"

import { CapabilityWorkbench } from "@/components/capabilities/capability-workbench"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { StatLine } from "@/components/design/kit"
import "./genres.css"

// 题材模板的稳定事实:每个题材模板写清「在哪个平台、用什么节奏吃下读者」,
// 是选题前的市场契合度判断。下面的内联数据只描述模板本身能配置的维度,
// 不编市场热度/收益数字;真实题材计数仍由共享面板自身呈现(它的状态 chip)。
const PLATFORMS = ["公众号", "小红书", "知乎", "X", "Newsletter"]

// 题材模板可配置的几个稳定维度(静态事实,非市场指标),用 lucide 图标标注语义。
const FACETS = [
  { icon: Compass, n: PLATFORMS.length, tone: "brand" as const, label: "目标平台 · 各有读者口味" },
  { icon: Gauge, n: 3, tone: "amber" as const, label: "契合维度 · 定位 / 节奏 / 审核" },
  { icon: Languages, n: 2, tone: "ok" as const, label: "可写语言 · 中 / 英" },
]

// 下方共享能力面板暴露的三条能力流水线:题材库 → 导入台 → 检测台。
// 这里在焦点带把「能做什么、由哪个编辑部角色把关」先讲清,再落到面板操作。
// agent 用编辑部规范 id(像素头像),不编任何运行数据。
const PIPELINE = [
  {
    icon: Tags,
    agent: "market-radar",
    title: "题材库",
    desc: "定平台定位、爽点节奏与审核风险,写进可版本化的模板",
    state: "draft" as const,
    stateLabel: "可编辑",
  },
  {
    icon: FileInput,
    agent: "style-fingerprint",
    title: "导入台",
    desc: "导入参考素材 / URL,学习文风并写回作品风格指纹",
    state: "queued" as const,
    stateLabel: "可导入",
  },
  {
    icon: ScanSearch,
    agent: "state-verifier",
    title: "检测台",
    desc: "对单章或全书跑 AI 痕迹检测,沉淀人味提升的历史统计",
    state: "running" as const,
    stateLabel: "可检测",
  },
]

export default function GenresPage() {
  return (
    <div className="page cj-genres">
      <header className="gn-hero">
        <div className="gn-hero-top">
          <div className="gn-hero-head">
            <PixelBadge kind="genres" size={40} className="gn-hero-pixel page-title-pixel" ariaLabel="题材库" />
            <div className="gn-hero-id">
              <span className="gn-eyebrow">
                <Tags className="ic" />
                选题前的市场契合度
              </span>
              <div className="page-title-row">
                <h1 className="page-title">题材库</h1>
              </div>
              <p className="gn-hero-sub">
                每个题材模板说清一条赛道<b>在哪个平台、用什么节奏吃下读者</b>:把平台定位、爽点节奏与审核风险写进可版本化的{" "}
                <code>genres/*.md</code>,挑准契合的题材,后面的选题、写作与多平台改稿才接得住。
              </p>
            </div>
          </div>

          {/* 静态可配置维度:横向密集铺,数字走 v-tone 语义色,图标标注含义(非市场指标) */}
          <div className="gn-facets" role="group" aria-label="题材模板可配置维度">
            {FACETS.map((f) => {
              const Icon = f.icon
              return (
                <span className="gn-facet" key={f.label}>
                  <Icon className="gn-facet-ic" aria-hidden />
                  <b className={`num v-${f.tone === "amber" ? "warm" : f.tone}`}>{f.n}</b>
                  <span className="lbl">{f.label}</span>
                </span>
              )
            })}
          </div>
        </div>

        {/* 能力流水线:把下方面板的三条能力先讲清「做什么 / 谁把关」,每条带像素角色 + 状态 pill */}
        <div className="gn-pipeline" aria-label="可操作能力流水线">
          {PIPELINE.map((step, i) => {
            const Icon = step.icon
            return (
              <React.Fragment key={step.title}>
                {i > 0 && (
                  <span className="gn-pipe-arrow" aria-hidden>
                    <ArrowRight />
                  </span>
                )}
                <div className="gn-pipe">
                  <AgentPixel id={step.agent} size={30} className="gn-pipe-pixel" ariaLabel={step.title} />
                  <div className="gn-pipe-body">
                    <div className="gn-pipe-titleline">
                      <Icon className="gn-pipe-ic" aria-hidden />
                      <span className="gn-pipe-title">{step.title}</span>
                      <span className="pill" data-state={step.state}>
                        <span className="dot" />
                        {step.stateLabel}
                      </span>
                    </div>
                    <p className="gn-pipe-desc">{step.desc}</p>
                  </div>
                </div>
              </React.Fragment>
            )
          })}
        </div>

        {/* 平台对位 + 流程引导:中性 chip 带 token,一行收口 */}
        <div className="gn-foot">
          <div className="gn-plats" aria-label="题材模板可对位的目标平台">
            <span className="gn-plats-k">
              <Compass className="ic" aria-hidden />
              对位平台
            </span>
            {PLATFORMS.map((p) => (
              <span key={p} className="gn-plat">{p}</span>
            ))}
          </div>
          <div className="gn-guard">
            <ShieldCheck className="ic" aria-hidden />
            <StatLine
              items={[
                { n: "Web", label: "直连 Studio API", tone: "brand" },
                { n: "确认", label: "后再写入", tone: "ok" },
              ]}
            />
          </div>
        </div>
      </header>

      <CapabilityWorkbench initialTab="genres" />
    </div>
  )
}
