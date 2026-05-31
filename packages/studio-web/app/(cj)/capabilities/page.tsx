import Link from "next/link"
import type { LucideIcon } from "lucide-react"
import {
  ArrowUpRight,
  BarChart3,
  BookPlus,
  Boxes,
  FileDown,
  FileText,
  FlaskConical,
  HeartPulse,
  Import,
  Network,
  PenLine,
  Radar,
  Route,
  ScanSearch,
  SlidersHorizontal,
  Tags,
  Wand2,
  Workflow,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { CapabilityOps } from "@/components/capabilities/capability-ops"
import { CapabilityWorkbench } from "@/components/capabilities/capability-workbench"
import { PixelBadge, type PixelBadgeKind } from "@/components/design/pixel-badge"
import { KpiChip } from "@/components/design/kit"

import "./capabilities.css"

const capabilityGroups: Array<{
  title: string
  kind: PixelBadgeKind
  summary: string
  items: { label: string; href: string; icon: LucideIcon }[]
}> = [
  {
    title: "创作与作品",
    kind: "editor",
    summary: "新建作品、续写、审阅、改名和导出走真实 Web 入口。",
    items: [
      { label: "新建作品", href: "/books", icon: BookPlus },
      { label: "正文写作台", href: "/", icon: PenLine },
      { label: "作品改名", href: "/books", icon: FileText },
      { label: "TXT 导出", href: "/books", icon: FileDown },
    ],
  },
  {
    title: "资产与真相文件",
    kind: "library",
    summary: "题材、素材、Wiki、Truth files 与风格样本进入统一工作面。",
    items: [
      { label: "题材库", href: "/genres", icon: Tags },
      { label: "素材导入", href: "/import", icon: Import },
      { label: "Wiki 图谱", href: "/wiki", icon: Network },
      { label: "知识与资产", href: "/knowledge", icon: Boxes },
    ],
  },
  {
    title: "质量与市场",
    kind: "detect",
    summary: "检测、质量统计、洞察和 Doctor 都能从 CJ 产品面进入。",
    items: [
      { label: "章节 AI 检测", href: "/detect", icon: ScanSearch },
      { label: "全书检测统计", href: "/detect", icon: BarChart3 },
      { label: "洞察中心", href: "/insights", icon: Radar },
      { label: "系统健康", href: "/system", icon: HeartPulse },
    ],
  },
  {
    title: "运维与并行",
    kind: "runs",
    summary: "运行台、Agent Lab、模型路由和偏好设置已经从旧壳剥离。",
    items: [
      { label: "运行台", href: "/runs", icon: Workflow },
      { label: "Agent Lab", href: "/agents", icon: FlaskConical },
      { label: "模型路由", href: "/llm", icon: Route },
      { label: "偏好设置", href: "/preferences", icon: SlidersHorizontal },
    ],
  },
]

// 实时探针路数:与 CapabilityOps 的 Doctor / Daemon / Radar / Style / Genres 五路对齐(常量,不编数据)。
const LIVE_PROBE_COUNT = 5

export default function CapabilitiesPage() {
  const totalEntries = capabilityGroups.reduce(
    (sum, group) => sum + group.items.length,
    0,
  )
  const uniqueDestinations = new Set(
    capabilityGroups.flatMap((group) => group.items.map((item) => item.href)),
  ).size

  return (
    <div className="cj-screen cj-cap">
      {/* ── 顶部工作条:像素 + 标题 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead cap-head">
        <div className="cap-headline">
          <PixelBadge
            kind="capabilities"
            size={44}
            className="cap-hero-pixel"
            ariaLabel="能力台"
          />
          <div className="cap-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">能力台</h1>
              <span className="cap-live-tag">
                <span className="dot" aria-hidden />
                全部走真实 Web
              </span>
            </div>
            <div className="page-sub">
              编辑部的创作、资产、质量、运行能力都已从旧壳剥离,统一收进产品面——一处直达。
            </div>
          </div>
          <div className="page-actions cap-head-actions">
            <Button asChild size="sm">
              <Link href="/">
                <Wand2 className="size-4" />
                写作台
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/books">
                <FileText className="size-4" />
                作品管理
              </Link>
            </Button>
          </div>
        </div>
        <div className="cap-kpis" role="group" aria-label="能力台概览">
          <KpiChip label="能力入口" value={totalEntries} unit="个" tone="brand" />
          <KpiChip
            label="能力分组"
            value={capabilityGroups.length}
            unit="组"
            tone="amber"
          />
          <KpiChip
            label="工作目的地"
            value={uniqueDestinations}
            unit="处"
            tone="ok"
            hint="去重后的真实 Web 路由数"
          />
          <KpiChip
            label="实时探针"
            value={LIVE_PROBE_COUNT}
            unit="路"
            tone="info"
            hint="Doctor / Daemon / Radar / Style / Genres"
          />
        </div>
      </header>

      {/* ── 主体:单主区,所有长内容只在 pane 内滚(整体一屏)── */}
      <div className="cj-screen-body solo cap-body">
        <div className="cj-mainpane cap-mainpane">
          <div className="cj-pane-scroll cap-pane-scroll">
            {/* 能力分组:像素图标分组头 + 带 lucide 图标的内联入口行 */}
            <section className="cap-block cap-groups-block">
              <h2 className="cap-sh">
                <Boxes className="size-4 cap-sh-ico" aria-hidden />
                能力分组
                <span className="c">
                  <b className="num">{capabilityGroups.length}</b> 组 ·{" "}
                  <b className="num">{totalEntries}</b> 个入口
                </span>
              </h2>
              <div className="cap-groups">
                {capabilityGroups.map((group) => (
                  <article key={group.title} className="cap-group">
                    <header className="cap-group-head">
                      <PixelBadge
                        kind={group.kind}
                        size={26}
                        className="cap-group-pix"
                        ariaLabel={group.title}
                      />
                      <div className="cap-group-meta">
                        <div className="cap-group-title">{group.title}</div>
                        <p className="cap-group-sum">{group.summary}</p>
                      </div>
                      <span className="cap-group-count">{group.items.length}</span>
                    </header>
                    <div className="cap-rows">
                      {group.items.map((item) => {
                        const Icon = item.icon
                        return (
                          <Link
                            key={item.label}
                            href={item.href}
                            className="cap-row"
                          >
                            <span className="cap-row-ico" aria-hidden>
                              <Icon className="size-4" />
                            </span>
                            <span className="cap-row-label">{item.label}</span>
                            <ArrowUpRight className="cap-row-arrow size-4" />
                          </Link>
                        )
                      })}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            {/* 实时能力探针(功能组件保持原样) */}
            <section className="cap-block cap-live">
              <CapabilityOps />
            </section>

            {/* 工作面板:题材 / 导入 / 检测(功能组件保持原样) */}
            <section className="cap-block cap-live">
              <CapabilityWorkbench />
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
