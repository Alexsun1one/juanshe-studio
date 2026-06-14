"use client"

import * as React from "react"
import {
  ArrowRight,
  ClipboardPaste,
  FileInput,
  Link2,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Tags,
  Wand2,
} from "lucide-react"

import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { KpiChip } from "@/components/design/kit"
import { CapabilityWorkbench } from "@/components/capabilities/capability-workbench"
import { PlatformHint } from "@/components/design/platform-hint"
import { useWorkspace, type BookSummary } from "@/lib/workspace-context"
import "./import.css"

// 本页可作为「文风源 / 可检测对象」的作品数,只用 BookSummary 已有字段派生,不编任何数字。
const chapterCount = (b: BookSummary) =>
  Math.max(0, b.chapterCount || 0, b.currentChapter || 0)

// 导入台的能力通道:每条都先放一个语义贴切的 lucide 图标(吸收 GPT「每个操作前加图标」),
// 一眼可辨「这是粘贴正文 / 抓 URL / 学文风 / 检测 / 题材 / 同步」。terminal=链路落点(变现去向)。
type Lane = {
  icon: React.ComponentType<{ className?: string }>
  name: string
  hint: string
  terminal?: boolean
}
const IMPORT_LANES: ReadonlyArray<Lane> = [
  { icon: ClipboardPaste, name: "参考素材", hint: "粘贴正文入库" },
  { icon: Link2, name: "URL 抓取", hint: "链接直接导入" },
  { icon: Wand2, name: "文风样本", hint: "分析 / 写入作品" },
  { icon: ScanSearch, name: "AI 痕迹检测", hint: "单章 / 全书" },
  { icon: Tags, name: "题材库", hint: "模板管理" },
  { icon: RefreshCw, name: "同步索引", hint: "作品 → 素材库" },
  { icon: Sparkles, name: "纳入编辑部", hint: "继续创作 · 适配变现", terminal: true },
]

export default function ImportPage() {
  const { books, booksLoading } = useWorkspace()

  // 真实派生:全部作品 / 可作为文风源(已有正文)/ 可检测(有章节)。三者口径如实,不编。
  const writable = React.useMemo(
    () => books.filter((b) => chapterCount(b) > 0).length,
    [books],
  )
  const dash = booksLoading ? "—" : undefined

  // 焦点带就绪度:语义只走 .pill[data-state](对齐检测台 det-verdict,不另造杂色)。
  // 读取中=pending;有可作文风源的作品=success;无则 pending(温和,不报错——导入入口始终可用)。
  const verdict = booksLoading
    ? { state: "pending" as const, label: "读取作品中" }
    : writable > 0
      ? { state: "success" as const, label: "可学文风" }
      : { state: "pending" as const, label: "待导入素材" }

  return (
    <div className="page cj-import">
      {/* ── 顶部工作条:像素「导入台」+ 标题 + 一行密集 KPI(对齐 books 标杆 workhead)── */}
      <header className="imp-head">
        <div className="imp-headline">
          <PixelBadge
            kind="import"
            size={44}
            className="imp-head-pixel"
            ariaLabel="导入台"
          />
          <div className="imp-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">导入台</h1>
            </div>
            <div className="page-sub">
              把外部素材、URL、文风样本和风格指纹从 Web 直接喂进 Studio，沉淀成可复用的创作资产——让已有作品接着在编辑部里写下去、适配平台变现。
            </div>
            <PlatformHint type="import-method" variant="quiet" />
          </div>
          <span className="imp-head-meta">
            <Wand2 className="imp-head-meta-ico" /> 走通 Studio API
          </span>
        </div>
        <div className="imp-kpis" role="group" aria-label="导入概览">
          <KpiChip label="全部作品" value={dash ?? books.length} unit="本" tone="brand" />
          <KpiChip
            label="可作文风源"
            value={dash ?? writable}
            unit="本"
            tone={writable > 0 ? "ok" : "neutral"}
            hint="已有正文、可作为文风学习 / AI 痕迹检测对象"
          />
          <KpiChip label="导入入口" value={3} unit="类" tone="info" hint="参考素材 · URL 抓取 · 文风样本" />
          <KpiChip label="检测方式" value={2} unit="种" tone="amber" hint="单章检测 · 全书检测" />
          <KpiChip
            label="写入确认"
            value="每次"
            tone="rose"
            sub="所有写入前都先二次确认"
          />
        </div>
      </header>

      {/* 焦点带:像素「风格指纹官」+ 能力链路一行图标化排开,替代裸文字流程 */}
      <section className="imp-hero">
        <AgentPixel
          id="style-fingerprint"
          size={42}
          className="imp-hero-pix"
          ariaLabel="风格指纹官"
        />
        <div className="imp-hero-body">
          <div className="imp-hero-top">
            <span className="imp-hero-eyebrow">
              <FileInput className="imp-hero-eyebrow-ico" />
              能力概览(操作在下方面板)
            </span>
            <span className="pill imp-verdict" data-state={verdict.state}>
              <span className="dot" aria-hidden />
              {verdict.label}
            </span>
          </div>
          <div className="imp-lanes" role="list" aria-label="导入与学习链路">
            {IMPORT_LANES.map((lane, i) => {
              const Icon = lane.icon
              const showArrow = i === 2 || i === 5
              return (
                <React.Fragment key={lane.name}>
                  <span
                    className={`imp-lane${lane.terminal ? " is-goal" : ""}`}
                    role="listitem"
                  >
                    <Icon className="imp-lane-ico" />
                    <span className="imp-lane-text">
                      <b className="imp-lane-name">{lane.name}</b>
                      <i className="imp-lane-hint">{lane.hint}</i>
                    </span>
                  </span>
                  {showArrow ? (
                    <ArrowRight className="imp-lane-arrow" aria-hidden />
                  ) : null}
                </React.Fragment>
              )
            })}
          </div>
        </div>
      </section>

      <CapabilityWorkbench initialTab="import" />
    </div>
  )
}
