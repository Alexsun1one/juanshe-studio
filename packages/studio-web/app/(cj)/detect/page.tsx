"use client"

import * as React from "react"
import {
  ArrowRight,
  FileSearch,
  Gauge,
  History,
  Radar,
  Repeat,
  ScanFace,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  SpellCheck2,
} from "lucide-react"

import { CapabilityWorkbench } from "@/components/capabilities/capability-workbench"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { KpiChip } from "@/components/design/kit"
import { useWorkspace, pickPreferredBook, type BookSummary } from "@/lib/workspace-context"
import "./detect.css"

const bookTitle = (b: BookSummary) => b.title.zh || b.title.en || b.id
const chapterCount = (b: BookSummary) =>
  Math.max(0, b.chapterCount || 0, b.currentChapter || 0)

// 检测台默认会优先选「有章节」的作品(与 CapabilityWorkbench 的 detect tab 逻辑一致),
// 焦点带据此原地呈现「现在能不能检测、检测哪本」。
function preferredDetectBook(books: BookSummary[]) {
  return (
    pickPreferredBook(books.filter((b) => chapterCount(b) > 0)) ??
    pickPreferredBook(books)
  )
}

// 下方共享面板的 AI 痕迹检测流水线:选对象 → 单章/全书检测 → 历史统计 → 沉淀人味。
// 这里在页头先把「做什么、由哪个编辑部角色把关」讲清,每条带语义贴切的 lucide 图标 +
// 像素角色 + 状态 pill;不编任何运行数据,真实评分仍由面板自身的检测结果呈现。
const PIPELINE = [
  {
    icon: FileSearch,
    agent: "market-radar",
    title: "选检测对象",
    desc: "挑作品与章节,只对有正文的章节发起检测",
    state: "draft" as const,
    stateLabel: "选目标",
  },
  {
    icon: ScanSearch,
    agent: "state-verifier",
    title: "单章 / 全书检测",
    desc: "跑 AI 痕迹检测,定位机械表达与同质句式",
    state: "running" as const,
    stateLabel: "可检测",
  },
  {
    icon: History,
    agent: "style-fingerprint",
    title: "刷新历史统计",
    desc: "汇总检测次数、人味提升与通过率走势",
    state: "queued" as const,
    stateLabel: "可统计",
  },
] as const

// AI 痕迹检测器关注的稳定维度(静态语义标签,非评分):每条配一个语义图标。
// 真实分数(人味分 / 通过率 / 各维度命中)由下方面板的检测结果给出,这里只解释「看什么」。
const DIMS = [
  { icon: ScanFace, label: "AI 痕迹", hint: "机械化表达密度" },
  { icon: Repeat, label: "同质句式", hint: "句式重复与节奏雷同" },
  { icon: SpellCheck2, label: "用词偏好", hint: "高频套路词与口头禅" },
  { icon: Gauge, label: "人味分", hint: "综合可读性评估" },
] as const

export default function DetectPage() {
  const { books, booksLoading } = useWorkspace()

  const target = React.useMemo(() => preferredDetectBook(books), [books])
  const detectable = books.filter((b) => chapterCount(b) > 0).length
  const targetChapters = target ? chapterCount(target) : 0
  // 可检测章节总量:只累加「有正文章节」的作品,口径如实,不编造。
  const detectableChapters = React.useMemo(
    () => books.reduce((sum, b) => sum + chapterCount(b), 0),
    [books],
  )

  const verdict = booksLoading
    ? { cls: "muted", label: "读取作品中" }
    : !target
      ? { cls: "muted", label: "暂无作品" }
      : targetChapters > 0
        ? { cls: "ok", label: "可检测" }
        : { cls: "warn", label: "暂无章节" }

  const dash = booksLoading ? "—" : undefined

  return (
    <div className="page cj-detect">
      {/* ── 顶部工作条:像素「检测台」+ 标题 + 一行密集 KPI(对齐 books / import 标杆 workhead)── */}
      <header className="det-head">
        <div className="det-headline">
          <PixelBadge
            kind="detect"
            size={44}
            className="det-head-pixel"
            ariaLabel="检测台"
          />
          <div className="det-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">检测台</h1>
            </div>
            <div className="page-sub">
              对作品做 AI 痕迹与质量检测——单章或全书跑一遍，定位机械化表达，沉淀人味提升的历史统计，让发布前的稿子经得起平台审视。
            </div>
          </div>
          <span className="det-head-meta">
            <Radar className="det-head-meta-ico" /> 走通 Studio API
          </span>
        </div>
        <div className="det-kpis" role="group" aria-label="检测概览">
          <KpiChip label="全部作品" value={dash ?? books.length} unit="本" tone="brand" />
          <KpiChip
            label="可检测"
            value={dash ?? detectable}
            unit="本"
            tone={detectable > 0 ? "ok" : "neutral"}
            hint="已有正文章节、可发起 AI 痕迹检测"
          />
          <KpiChip
            label="可检测章节"
            value={dash ?? detectableChapters}
            unit="章"
            tone="info"
            hint="全部作品已有正文章节之和"
          />
          <KpiChip
            label="目标章节"
            value={targetChapters > 0 ? targetChapters : dash ?? "—"}
            unit="章"
            tone={targetChapters > 0 ? "amber" : "neutral"}
            sub={target ? bookTitle(target) : "未选择作品"}
          />
          <KpiChip label="检测方式" value={2} unit="种" tone="rose" hint="单章检测 · 全书检测" />
        </div>
      </header>

      {/* ── 焦点带:像素「状态核验官」+ 当前检测目标/就绪度 + 图标化检测流水线 ── */}
      <section className="det-hero">
        <AgentPixel
          id="state-verifier"
          size={42}
          className="det-hero-pix"
          ariaLabel="状态核验官"
        />
        <div className="det-hero-body">
          <span className="det-hero-eyebrow">
            <ScanSearch className="det-hero-eyebrow-ico" />
            AI 痕迹与质量检测
          </span>
          <p className="det-hero-line">
            {target ? (
              <>
                当前检测目标 《<b>{bookTitle(target)}</b>》
              </>
            ) : (
              <>对当前作品执行章节检测、全书检测与历史统计</>
            )}
            <span className="pill det-verdict" data-state={verdictState(verdict.cls)}>
              <span className="dot" aria-hidden />
              {verdict.label}
            </span>
          </p>

          {/* 检测流水线:把面板的三步能力先讲清「做什么 / 谁把关」,每条带像素角色 + 状态 pill */}
          <div className="det-pipeline" aria-label="AI 痕迹检测流水线">
            {PIPELINE.map((step, i) => {
              const Icon = step.icon
              return (
                <React.Fragment key={step.title}>
                  {i > 0 && (
                    <span className="det-pipe-arrow" aria-hidden>
                      <ArrowRight />
                    </span>
                  )}
                  <div className="det-pipe">
                    <AgentPixel
                      id={step.agent}
                      size={28}
                      className="det-pipe-pixel"
                      ariaLabel={step.title}
                    />
                    <div className="det-pipe-body">
                      <div className="det-pipe-titleline">
                        <Icon className="det-pipe-ic" aria-hidden />
                        <span className="det-pipe-title">{step.title}</span>
                        <span className="pill" data-state={step.state}>
                          <span className="dot" />
                          {step.stateLabel}
                        </span>
                      </div>
                      <p className="det-pipe-desc">{step.desc}</p>
                    </div>
                  </div>
                </React.Fragment>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── 检测维度 + 确认守则:一行收口(维度=看什么,守则=写入前确认)── */}
      <div className="det-foot">
        <div className="det-dims" aria-label="AI 痕迹检测关注的维度">
          <span className="det-dims-k">
            <ShieldCheck className="ic" aria-hidden />
            检测维度
          </span>
          {DIMS.map((d) => {
            const Icon = d.icon
            return (
              <span key={d.label} className="det-dim" title={d.hint}>
                <Icon className="det-dim-ic" aria-hidden />
                <b className="det-dim-name">{d.label}</b>
                <i className="det-dim-hint">{d.hint}</i>
              </span>
            )
          })}
        </div>
        <span className="det-foot-goal">
          <Sparkles className="ic" aria-hidden />
          人味达标 · 安心发布
        </span>
      </div>

      <CapabilityWorkbench initialTab="detect" />
    </div>
  )
}

// 把就绪度判定映射到设计系统状态 pill 的 data-state(语义色只走状态,不另造杂色)。
function verdictState(cls: string): "success" | "warn" | "pending" {
  if (cls === "ok") return "success"
  if (cls === "warn") return "warn"
  return "pending"
}
