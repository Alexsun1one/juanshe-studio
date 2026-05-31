"use client"

import * as React from "react"
import { Plus, History } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT, useLocale } from "@/lib/i18n"
import { useAutoRuns } from "@/hooks/use-studio"
import { RunCard } from "@/components/runs/run-card"
import { RunsEmpty } from "@/components/runs/runs-empty"
import { NewRunDialog } from "@/components/runs/new-run-dialog"
import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, StatLine, Meter, FoldCard } from "@/components/design/kit"
import {
  autoRunStatusLabelKey,
  autoRunStatusRank,
  isLiveAutoRunStatus,
} from "@/lib/studio/run-status"
import type { AutoRun } from "@/lib/api/types"
import "./runs.css"

/**
 * 运行台 — 多本书并行自动续写的可视化(工作站版式)。
 *
 * 对齐工作台标杆:不再整页下拉。改成工作站原语——
 *   .cj-workhead    标题 + 一行密集舰队 KPI(活跃/在册/采纳字/Token/改写/均分)
 *   .cj-screen-body 主区(进行中任务,焦点)+ 右侧 Inspector(舰队汇总 + 历史折叠卡)
 *   .cj-pane-scroll 滚动只在各自 pane 内,整体恒为一屏。
 *
 * 进行中任务仍走 12 列错落网格(交错 span,横竖错落而非等大卡墙);已结束/历史收进
 * Inspector 的 FoldCard 卡内滚,密而不挤。RunCard 自身保留卡框(含进度/agent 链/事件流的
 * 真实数据密集模块),这里只重排排布与轻重,不动卡片内部逻辑。
 */
export default function RunsPage() {
  const t = useT()
  const { locale } = useLocale()
  const en = locale === "en"
  const { data: runs } = useAutoRuns()
  const [open, setOpen] = React.useState(false)

  const list = runs ?? []
  const active = list.filter((run) => isLiveAutoRunStatus(run.status))
  const others = list.filter((run) => !isLiveAutoRunStatus(run.status))
  const otherSummary = summarizeOtherRuns(others, t)
  const fleet = summarizeFleet(list)

  return (
    <div className="cj-screen cj-runs">
      {/* ── 顶部工作条:像素徽章 + 标题 + 运行 pill + 新建,下挂一行舰队 KPI ── */}
      <header className="cj-workhead runs-head">
        <div className="runs-head-bar">
          <div className="runs-head-id">
            <PixelBadge
              kind="runs"
              size={44}
              className="page-title-pixel"
              ariaLabel={t("runs.title")}
            />
            <div className="runs-head-titles">
              <h1 className="page-title">{t("runs.title")}</h1>
              <div className="page-sub">{t("runs.subtitle")}</div>
            </div>
          </div>
          <div className="page-actions">
            {active.length > 0 && (
              <span className="pill" data-state="running">
                <span className="dot" />
                <span className="num">{active.length}</span> {t("workspace.runningOf")}
              </span>
            )}
            <Button
              type="button"
              onClick={() => setOpen(true)}
              className="gap-2"
              size="sm"
            >
              <Plus className="size-4" />
              {t("runs.newRun")}
            </Button>
          </div>
        </div>

        {/* 舰队 KPI 一行 —— 全部从已取数据派生,只读、密集、不另发请求 */}
        {list.length > 0 && (
          <div className="runs-kpis">
            <KpiChip
              label={t("workspace.runningOf")}
              value={active.length}
              tone={active.length > 0 ? "brand" : "neutral"}
              sub={
                <StatLine
                  items={[
                    { n: list.length, label: en ? "books" : "在册" },
                    ...(fleet.repairing > 0
                      ? [{ n: fleet.repairing, label: en ? "repair" : "复修", tone: "warn" as const }]
                      : []),
                  ]}
                />
              }
            />
            <KpiChip
              label={t("runs.adopted")}
              value={formatThousand(fleet.adoptedWords)}
              unit={t("common.words")}
              tone="ok"
            />
            <KpiChip
              label={t("runs.tokens")}
              value={formatThousand(fleet.tokens)}
              tone="info"
            />
            <KpiChip
              label={t("runs.retries")}
              value={fleet.rewrites}
              tone={fleet.rewrites > 0 ? "amber" : "neutral"}
            />
            <div className="runs-kpi runs-kpi--meter">
              <div className="runs-kpi-label">{t("workspace.quality")}</div>
              {fleet.avgQuality != null ? (
                <Meter
                  value={fleet.avgQuality}
                  threshold={fleet.avgTargetQuality ?? undefined}
                  tone="ok"
                  showValue
                  unitMax={false}
                  max={100}
                />
              ) : (
                <div className="runs-kpi-empty">—</div>
              )}
              <div className="runs-kpi-foot">
                <StatLine
                  items={[
                    { n: `${fleet.completedChapters}/${fleet.scheduledChapters}`, label: t("common.chapter") },
                  ]}
                />
              </div>
            </div>
          </div>
        )}
      </header>

      {/* ── 主体:进行中(主区)+ 历史 / 舰队汇总(Inspector)── */}
      {list.length === 0 ? (
        <div className="cj-screen-body solo runs-body">
          <div className="cj-mainpane runs-mainpane">
            <div className="cj-pane-scroll runs-pane-scroll">
              <RunsEmpty onCreate={() => setOpen(true)} />
            </div>
          </div>
        </div>
      ) : (
        <div className={`cj-screen-body runs-body${others.length === 0 ? " solo" : ""}`}>
          {/* 主区:进行中任务的错落网格(焦点),只在 pane 内滚 */}
          <div className="cj-mainpane runs-mainpane">
            <div className="cj-pane-scroll runs-pane-scroll">
              {active.length > 0 ? (
                <div className="runs-grid runs-grid--live">
                  {active.map((run, i) => (
                    <div
                      key={run.id}
                      className="runs-cell"
                      // 错落:用 12 列里交错的 span(7/5、6/6、8/4…)打破等宽等高的网格感。
                      data-span={liveSpan(i, active.length)}
                    >
                      <RunCard run={run} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="runs-idle">
                  <span className="pill" data-state="paused">
                    <span className="dot" />
                    {t("runs.empty.title")}
                  </span>
                  <p className="runs-idle-desc">{t("runs.empty.desc")}</p>
                  <Button type="button" onClick={() => setOpen(true)} size="sm" className="gap-2">
                    <Plus className="size-4" />
                    {t("runs.newRun")}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* 右侧 Inspector:历史 / 已结束收进折叠卡(卡内滚),保证整体一屏 */}
          {others.length > 0 && (
            <aside className="cj-inspector runs-inspector">
              <div className="cj-pane-scroll runs-insp-scroll">
                <FoldCard
                  title={en ? "History" : "历史任务"}
                  icon={<History size={15} />}
                  count={others.length}
                  scrollable
                  maxHeight={9999}
                  className="runs-history-fold"
                >
                  <div className="runs-history-sub">{otherSummary}</div>
                  {/* 历史泳道:轻量(dim),按错落跨度铺;每行跨度之和恒为 12,右缘整齐而相邻行结构不同。 */}
                  <div className="runs-grid runs-grid--past">
                    {pastSpans(others.length).map((span, i) => {
                      const run = others[i]
                      return (
                        <div key={run.id} className="runs-cell" data-span={span}>
                          <RunCard run={run} dim />
                        </div>
                      )
                    })}
                  </div>
                </FoldCard>
              </div>
            </aside>
          )}
        </div>
      )}

      <NewRunDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}

// 进行中任务的错落跨度:奇数个时让首个占宽(7)、其余 5/6 交错;偶数个用 6/6 与 7/5 交替,
// 始终避免一排排等宽。返回值是 12 列网格里的列跨度。
function liveSpan(i: number, total: number): number {
  if (total === 1) return 12
  if (total === 2) return i === 0 ? 7 : 5
  // 3+:首张做「主」卡占 7,之后按 5 / 6 / 6 / 5… 错落
  if (i === 0) return 7
  const cycle = [5, 6, 6, 5]
  return cycle[(i - 1) % cycle.length]
}

// 历史泳道的错落跨度:把 n 张卡按一组「每行求和=12 但结构各异」的模板铺开,
// 让相邻行的宽窄不同(7/5、5/4/3、4/8、6/6…),既不是等宽卡墙,右缘又保持整齐。
const PAST_ROW_PATTERNS: number[][] = [
  [7, 5],
  [5, 4, 3],
  [4, 8],
  [6, 6],
  [3, 5, 4],
  [8, 4],
]
function pastSpans(n: number): number[] {
  const spans: number[] = []
  let row = 0
  while (spans.length < n) {
    const pattern = PAST_ROW_PATTERNS[row % PAST_ROW_PATTERNS.length]
    for (const s of pattern) {
      if (spans.length >= n) break
      spans.push(s)
    }
    row += 1
  }
  // 收尾:若最后一行没填满 12 列,把这行各卡按比例放大补满,避免右侧留豁口。
  let tail = spans.length
  let used = 0
  // 找出最后一整行的起点(从后往前累加到 ≥12 为止)
  const lastRow: number[] = []
  for (let i = spans.length - 1; i >= 0; i--) {
    used += spans[i]
    lastRow.unshift(spans[i])
    tail = i
    if (used >= 12) break
  }
  if (used < 12 && lastRow.length > 0) {
    const grow = 12 - used
    // 把缺口加到该行最后一张卡上(简单稳健,视觉上最后一张略宽收尾)
    spans[tail + lastRow.length - 1] += grow
  }
  return spans
}

function summarizeOtherRuns(others: AutoRun[], t: (key: string) => string) {
  const counts = new Map<string, number>()
  for (const run of others) {
    counts.set(run.status, (counts.get(run.status) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => autoRunStatusRank(a) - autoRunStatusRank(b))
    .slice(0, 3)
    .map(([status, count]) => `${count} · ${t(autoRunStatusLabelKey(status))}`)
    .join(" / ")
}

const REPAIR_STATUSES = new Set([
  "rewriting",
  "repairing",
  "quality-batch-repairing",
  "needs-repair",
])

// 舰队汇总:从已取的 runs 列表派生只读聚合指标(采纳字 / Token / 改写 / 均分 / 章节进度)。
// 不发任何请求,只是把 RunCard 里逐卡的数据在页头汇总成一行密集 KPI。
function summarizeFleet(list: AutoRun[]) {
  let adoptedWords = 0
  let tokens = 0
  let rewrites = 0
  let repairing = 0
  let completedChapters = 0
  let scheduledChapters = 0
  let qualitySum = 0
  let qualityCount = 0
  let targetSum = 0
  let targetCount = 0

  for (const run of list) {
    adoptedWords += run.totalAdoptedWords || 0
    tokens += run.totalTokens || 0
    rewrites += run.totalRewrites || 0
    if (REPAIR_STATUSES.has(String(run.status))) repairing += 1

    const total = Math.max(1, run.toChapter - run.fromChapter + 1)
    scheduledChapters += total
    const done = isLiveAutoRunStatus(run.status)
      ? Math.max(0, Math.min(total, run.currentChapter - run.fromChapter))
      : run.status === "completed"
      ? total
      : Math.max(0, Math.min(total, run.currentChapter - run.fromChapter))
    completedChapters += done

    if (typeof run.currentQuality === "number" && run.currentQuality > 0) {
      qualitySum += run.currentQuality
      qualityCount += 1
    }
    if (typeof run.targetQuality === "number" && run.targetQuality > 0) {
      targetSum += run.targetQuality
      targetCount += 1
    }
  }

  return {
    adoptedWords,
    tokens,
    rewrites,
    repairing,
    completedChapters,
    scheduledChapters,
    avgQuality: qualityCount > 0 ? Math.round(qualitySum / qualityCount) : null,
    avgTargetQuality: targetCount > 0 ? Math.round(targetSum / targetCount) : null,
  }
}

function formatThousand(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
