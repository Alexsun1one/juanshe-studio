"use client"

import * as React from "react"
import Link from "next/link"
import useSWR from "swr"
import {
  Activity,
  BookMarked,
  Check,
  GitBranch,
  Grid3x3,
  ListOrdered,
  Milestone,
  PenLine,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"
import { fetchOutline, fetchPlotProgress } from "@/lib/api/client"
import type { OutlineAct, OutlineChapter } from "@/lib/api/types"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import "./outline.css"

const soft = { shouldRetryOnError: false }
const fmt = (n: number | undefined | null) =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "—"

const VOL_MARKS = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌"]

// 章节状态 → 设计系统 pill 的 data-state(语义色只走状态,不用裸文字/杂色)+ 中文标签
function chTag(status: string): { state: string; label: string } {
  const s = (status || "").toLowerCase()
  if (/done|published|complete|finished/.test(s)) return { state: "done", label: "完成" }
  if (/writing|progress|active/.test(s)) return { state: "running", label: "编辑中" }
  if (/review/.test(s)) return { state: "warn", label: "待审" }
  if (/draft|queued|todo|pending|outlin/.test(s)) return { state: "draft", label: "待写" }
  return { state: "pending", label: "构想" }
}
const isDone = (s: string) => /done|published|complete|finished/.test((s || "").toLowerCase())

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function OutlinePage() {
  const { books, bookId, booksLoading } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const { data: outline } = useSWR(bookId ? ["outline", bookId] : null, () => fetchOutline(bookId), soft)
  const { data: plot } = useSWR(bookId ? ["plot", bookId] : null, () => fetchPlotProgress(bookId), soft)

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="大纲与规划" sub="本地工作区还没有作品,创建后这里会出现张力曲线、卷看板与节拍表。" />
  }

  const acts: OutlineAct[] = outline ?? []
  const allChapters = acts.flatMap((a) => a.chapters)
  const totalPlanned = active?.plannedChapters || active?.chapterCount || allChapters.length || 1
  const curChapter = active?.currentChapter ?? 0
  // 没有正式大纲(acts 为空)时,统计回落到作品的真实章节数据,避免出现「已写 2 万字但已完成 0 章 / 平均 0 字」的自相矛盾。
  const writtenCount = allChapters.length || active?.chapterCount || curChapter || 0
  const doneChapters = allChapters.length ? allChapters.filter((c) => isDone(c.status)).length : writtenCount
  const milestones = plot?.milestones ?? []
  const tension = (plot?.tensionCurve ?? []).slice().sort((a, b) => a.chapter - b.chapter)
  const avgWords = allChapters.length
    ? Math.round(allChapters.reduce((s, c) => s + (c.words || 0), 0) / allChapters.length)
    : (writtenCount && active?.totalWords ? Math.round(active.totalWords / writtenCount) : 0)
  const overallPct = totalPlanned ? Math.round((curChapter / totalPlanned) * 100) : 0
  // 焦点带「当前阶段」一字总评:优先用进行中的里程碑,但进度尚浅时不信任后端可能给到的
  // 末尾里程碑(避免出现「0% 进度却显示结局」的自相矛盾,与上方统计回落同一考量)。
  const curMilestone = milestones.find((m) => m.status === "current")
  const phase = curMilestone && overallPct >= 5
    ? { label: curMilestone.label.zh, cls: "brand" as const }
    : overallPct >= 95
      ? { label: "收尾", cls: "ok" as const }
      : overallPct >= 60
        ? { label: "高潮推进", cls: "brand" as const }
        : overallPct > 0
          ? { label: "稳步展开", cls: "brand" as const }
          : { label: "筹备开篇", cls: "muted" as const }

  // ── 张力曲线 SVG (viewBox 0 0 1000 180) ──
  const maxCh = Math.max(totalPlanned, tension.length ? tension[tension.length - 1].chapter : 0, 1)
  const X = (ch: number) => (maxCh > 1 ? ((ch - 1) / (maxCh - 1)) * 1000 : 0)
  const Y = (t: number) => (1 - Math.max(0, Math.min(1, t))) * 150 + 12
  const pts = tension.map((p) => ({ x: X(p.chapter), y: Y(p.tension), ch: p.chapter }))
  const linePath = pts.length ? "M " + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ") : ""
  const areaPath = pts.length ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)},180 L ${pts[0].x.toFixed(1)},180 Z` : ""
  const realizedPts = pts.filter((p) => p.ch <= curChapter)
  const realizedPath = realizedPts.length > 1 ? "M " + realizedPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ") : ""
  const nowPct = maxCh > 1 ? ((curChapter - 1) / (maxCh - 1)) * 100 : 0

  // act 边界(章号范围)
  const actRanges = acts.map((a) => {
    const nums = a.chapters.map((c) => c.num)
    return { act: a, min: Math.min(...nums), max: Math.max(...nums) }
  }).filter((r) => Number.isFinite(r.min))

  const xAxisTicks = (() => {
    const step = Math.max(1, Math.round(maxCh / 8))
    const ticks: number[] = [1]
    for (let c = step; c < maxCh; c += step) ticks.push(c)
    ticks.push(maxCh)
    return ticks
  })()
  const outlineMarkdown = [
    `# ${active?.title.zh ?? "当前作品"} · 大纲与规划`,
    "",
    `- 当前章节: 第 ${curChapter} 章`,
    `- 已写字数: ${fmt(active?.totalWords)}`,
    `- 已完成章: ${doneChapters}`,
    `- 平均章字数: ${fmt(avgWords)}`,
    `- 里程碑: ${milestones.length}`,
    "",
    "## 分卷",
    ...(acts.length
      ? acts.flatMap((a) => [
        "",
        `### ${a.actTitle.zh}`,
        ...a.chapters.map((c) => `- 第 ${c.num} 章《${c.title.zh}》 · ${chTag(c.status).label} · ${c.words ? `${fmt(c.words)} 字` : "未写"} · ${c.beats} 节拍`),
      ])
      : ["- 暂无分卷大纲"]),
    "",
    "## 里程碑",
    ...(milestones.length
      ? milestones.map((m) => `- ${Math.round(m.progress * 100)}% · ${m.label.zh} · ${m.status}`)
      : ["- 暂无里程碑"]),
  ].join("\n")
  const planningPrompt = [
    `请基于《${active?.title.zh ?? "当前作品"}》现有大纲推演下一卷。`,
    "",
    "已知进度:",
    `- 当前第 ${curChapter} 章`,
    `- 已完成章 ${doneChapters}`,
    `- 当前张力曲线覆盖 ${tension.length} 个章节点`,
    "",
    "现有分卷:",
    ...(acts.length ? acts.map((a) => `- ${a.actTitle.zh}: ${a.chapters.map((c) => `第${c.num}章《${c.title.zh}》`).join(" / ")}`) : ["- 暂无分卷,请先从现有正文反推卷结构"]),
    "",
    "输出要求:下一卷主题、核心冲突、角色弧线、10 个章节标题、每章一句剧情推进、伏笔埋收安排。",
  ].join("\n")
  const copyPlanningPrompt = async () => {
    try {
      await navigator.clipboard.writeText(planningPrompt)
      toast.success("已复制下一卷推演提示", { description: "可粘到内容工坊或你常用的模型里继续推演。" })
    } catch {
      downloadText(`${active?.title.zh ?? "AutoW"}-下一卷推演提示.md`, planningPrompt)
      toast.success("剪贴板不可用,已下载推演提示")
    }
  }
  const exportOutline = () => {
    downloadText(`${active?.title.zh ?? "AutoW"}-大纲与规划.md`, outlineMarkdown)
    toast.success("大纲已导出")
  }

  return (
    <div className="cj-screen cj-outline">
      {/* ── 顶部工作条:像素 + 标题 + 操作 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead ol-head">
        <div className="ol-headline">
          <PixelBadge kind="outline" size={44} className="ol-hero-pixel" ariaLabel="大纲与规划" />
          <div className="ol-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">大纲与规划</h1>
              <span className={`ol-phase ${phase.cls}`}>{phase.label}</span>
            </div>
            <div className="page-sub">
              《{active?.title.zh ?? "—"}》的张力曲线、卷看板与节拍表,一屏看清结构推进。
            </div>
          </div>
          <div className="page-actions ol-actions">
            <button type="button" className="btn sm" onClick={copyPlanningPrompt}><Sparkles size={12} /> 复制推演提示</button>
            <button type="button" className="btn sm" onClick={exportOutline}><ListOrdered size={12} /> 导出大纲</button>
            <Link className="btn primary sm" href="/editor"><PenLine size={12} /> 去编辑器</Link>
          </div>
        </div>
        <div className="ol-kpis" role="group" aria-label="结构概览">
          <KpiChip
            label="当前进度"
            value={overallPct}
            unit="%"
            tone="brand"
            sub={<StatLine items={[{ n: curChapter, label: "章" }, { n: fmt(totalPlanned), label: "规划" }]} />}
          />
          <KpiChip label="分卷" value={acts.length} unit="卷" tone="info" />
          <KpiChip
            label="已完成章"
            value={doneChapters}
            unit="章"
            tone={doneChapters > 0 ? "ok" : "neutral"}
          />
          <KpiChip label="累计字数" value={fmt(active?.totalWords)} unit="字" tone="neutral" />
          <KpiChip label="均章字数" value={fmt(avgWords)} unit="字" tone="amber" />
          <KpiChip
            label="里程碑"
            value={milestones.length}
            unit="个"
            tone={milestones.length > 0 ? "brand" : "neutral"}
          />
        </div>
      </header>

      {/* ── 主体:左 主区(曲线 + 热力 + 分卷,pane 内滚) · 右 Inspector(焦点 + 里程碑 + 推进)── */}
      <div className="cj-screen-body ol-body">
        <div className="cj-mainpane ol-mainpane">
          <div className="cj-pane-scroll ol-pane-scroll scroll-thin">
            {/* 张力曲线(图表区,保留卡框) */}
            <section className="card arc-curve">
              <div className="curve-head">
                <h4><Activity size={14} /> 张力曲线 <span className="muted">· 每章张力(后端推算)</span></h4>
                <div className="ctrls"><span className="ch active">张力</span></div>
              </div>
              <div className="curve-stage">
                <div className="axis-y"><span>高</span><span>中</span><span>低</span></div>
                {actRanges.slice(0, -1).map((r) => (
                  <div key={r.act.actId} className="act-band" style={{ left: `${(X(r.max + 0.5) / 1000) * 100}%` }} />
                ))}
                {actRanges.map((r) => (
                  <div key={`l${r.act.actId}`} className="act-label" style={{ left: `${Math.min(80, (X((r.min + r.max) / 2) / 1000) * 100)}%` }}>
                    {r.act.actTitle.zh}
                  </div>
                ))}

                {linePath ? (
                  <svg className="curve" viewBox="0 0 1000 180" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="cjtens" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="var(--brand-500)" stopOpacity="0.32" />
                        <stop offset="1" stopColor="var(--brand-500)" stopOpacity="0.02" />
                      </linearGradient>
                    </defs>
                    <g className="grid">
                      <line x1="0" y1="45" x2="1000" y2="45" />
                      <line x1="0" y1="90" x2="1000" y2="90" />
                      <line x1="0" y1="135" x2="1000" y2="135" />
                    </g>
                    <path d={areaPath} fill="url(#cjtens)" />
                    <path d={linePath} fill="none" stroke="var(--brand-500)" strokeWidth="2.2" />
                    {realizedPath && <path d={realizedPath} fill="none" stroke="var(--brand-700)" strokeWidth="3.4" />}
                    {pts.map((p) => (
                      <circle key={p.ch} cx={p.x} cy={p.y} r={p.ch === curChapter ? 5 : 3}
                        fill={p.ch === curChapter ? "var(--c-focus)" : p.ch <= curChapter ? "var(--ok-500)" : "var(--brand-500)"} />
                    ))}
                  </svg>
                ) : (
                  <div className="empty" style={{ height: "100%" }}>暂无张力数据</div>
                )}

                {milestones.map((m, i) => (
                  <div key={m.id} className="peak-label" style={{ left: `${Math.max(6, Math.min(94, m.progress * 100))}%`, top: i % 2 === 0 ? "16%" : "34%" }}>
                    {m.label.zh}
                  </div>
                ))}
                {curChapter > 0 && linePath && <div className="now" data-label={`当前 第${curChapter}章`} style={{ left: `${Math.max(0, Math.min(100, nowPct))}%` }} />}

                <div className="axis-x">{xAxisTicks.map((t, i) => <span key={i}>{t}</span>)}</div>
              </div>
            </section>

            {/* 章节节奏热力图 — 每章一格,色阶 = words 与目标值的偏差;红=偏离,绿=正中 */}
            {allChapters.length > 0 && (
              <section className="chapter-heat">
                <div className="ch-head">
                  <h4><Grid3x3 size={14} /> 章节节奏 <span className="muted">· {allChapters.length} 章 · 颜色 = 字数偏离目标</span></h4>
                  <div className="ch-legend">
                    <span><i className="hc hc-low" />偏短</span>
                    <span><i className="hc hc-ok" />达标</span>
                    <span><i className="hc hc-high" />偏长</span>
                    <span><i className="hc hc-empty" />未写</span>
                    <span className="ch-cur"><i className="hc hc-cur" />当前</span>
                  </div>
                </div>
                <div className="ch-grid" role="list" aria-label="章节热力图">
                  {allChapters.map((c) => {
                    const w = c.words ?? 0
                    const target = avgWords > 0 ? avgWords : 3000
                    const ratio = target > 0 ? w / target : 0
                    const tone = w === 0
                      ? "empty"
                      : ratio < 0.65 ? "low"
                      : ratio > 1.35 ? "high"
                      : "ok"
                    const isCur = c.num === curChapter
                    return (
                      <div
                        key={c.num}
                        role="listitem"
                        className={`hc-cell hc-${tone}${isCur ? " hc-cur-cell" : ""}`}
                        title={`第 ${c.num} 章 · ${c.title.zh || "未命名"} · ${w ? `${fmt(w)} 字 (${Math.round(ratio * 100)}%)` : "未写"}`}
                      >
                        <span className="hc-num">{c.num}</span>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {/* 分卷一览 — 去卡:无外框分卷块 + 轻量章节行,错落不等宽(大卷占双列,小卷单列) */}
            <h3 className="ol-sh"><ListOrdered size={13} /> 分卷一览 <span className="c">{acts.length}</span></h3>
            <div className="vols">
              {!outline && <div className="skel" style={{ height: 160, gridColumn: "1 / -1" }} />}
              {acts.map((a, ai) => {
                const nums = a.chapters.map((c) => c.num)
                const aMin = Math.min(...nums), aMax = Math.max(...nums)
                const aDone = a.chapters.filter((c) => isDone(c.status)).length
                const hasCurrent = curChapter >= aMin && curChapter <= aMax
                const vmarkCls = aDone === a.chapters.length && a.chapters.length ? "done" : hasCurrent || aDone > 0 ? "" : "future"
                const aWords = a.chapters.reduce((s, c) => s + (c.words || 0), 0)
                // 错落:章节多的卷占双列(span 2),其余占单列,让分卷区不再一排排等宽
                const wide = a.chapters.length >= 6
                // 分卷状态 → pill data-state(语义色统一走状态)
                const volState = aDone === a.chapters.length && a.chapters.length ? "done" : hasCurrent ? "running" : aDone > 0 ? "warn" : "pending"
                const volLabel = aDone === a.chapters.length && a.chapters.length ? "已完成" : hasCurrent ? "推进中" : aDone > 0 ? "进行中" : "规划中"
                return (
                  <section className={`vol${wide ? " wide" : ""}`} key={a.actId}>
                    <div className="vol-head">
                      <span className={`vmark ${vmarkCls}`}>{VOL_MARKS[ai] ?? ai + 1}</span>
                      <div className="vt">
                        <span className="vt-name"><BookMarked size={13} />{a.actTitle.zh}</span>
                        <span className="sub">第 {aMin}–{aMax} 章 · {fmt(aWords)} 字 · {aDone}/{a.chapters.length} 完成</span>
                      </div>
                      <span className="pill" data-state={volState}><span className="dot" />{volLabel}</span>
                    </div>
                    <div className={`chap-rows${wide ? " two" : ""}`}>
                      {a.chapters.map((c: OutlineChapter) => {
                        const tag = chTag(c.status)
                        const isActive = c.num === curChapter
                        return (
                          <Link className={`chap-row${isActive ? " active" : ""}`} key={c.id} href={`/editor?chapter=${c.num}`}>
                            <span className="cr-num">{String(c.num).padStart(2, "0")}</span>
                            <span className="cr-title">{c.title.zh}</span>
                            {c.beats > 0 && (
                              <span className="beats" title={`${c.beats} 节拍`}>
                                {Array.from({ length: Math.min(6, c.beats) }).map((_, bi) => <i key={bi} className="x" />)}
                              </span>
                            )}
                            <span className="cr-words">{c.words ? fmt(c.words) : "—"}</span>
                            <span className="pill cr-tag" data-state={tag.state}><span className="dot" />{tag.label}</span>
                          </Link>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
              {outline && acts.length === 0 && (
                <div className="empty" style={{ gridColumn: "1 / -1" }}>
                  还没有分卷大纲{writtenCount ? ` · 这部作品已有 ${writtenCount} 章正文` : ""}
                  <div style={{ fontSize: "var(--text-cap)", color: "var(--ink-400)", marginTop: 2 }}>
                    用上方「复制推演提示」把现有正文丢给模型反推卷 / 章结构,或「去编辑器」继续写。
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── 右侧 Inspector:焦点(结构架构师 + 阶段 + 进度) / 里程碑 / 分卷推进(只在 pane 内滚)── */}
        <aside className="cj-inspector ol-inspector">
          <div className="cj-pane-scroll ol-insp-scroll scroll-thin">
            {/* 焦点卡:像素「结构架构师」+ 阶段 + 进度计量条 */}
            <section className="card ol-focus">
              <div className="ol-focus-top">
                <AgentPixel id="architect" size={48} className="ol-focus-pix" ariaLabel="结构架构师" />
                <div className="ol-focus-meta">
                  <span className="ol-focus-role">结构架构师</span>
                  <span className="ol-focus-book">《{active?.title.zh ?? "—"}》</span>
                </div>
                <span className={`ol-phase ${phase.cls}`}>{phase.label}</span>
              </div>
              <div className="ol-focus-meter">
                <Meter label="整体进度" value={curChapter} max={Math.max(totalPlanned, curChapter, 1)} tone="brand" showValue={false} />
                <div className="ol-focus-cap">
                  <span className="num">{curChapter}</span>
                  <span className="ol-focus-of">/{fmt(totalPlanned)} 章</span>
                  <span className="ol-focus-pct">{overallPct}%</span>
                </div>
              </div>
              <div className="ol-focus-stats">
                <span className="ol-fstat" data-tone="ok">
                  <b className="num">{doneChapters}</b><i>已完成章</i>
                </span>
                <span className="ol-fstat" data-tone="brand">
                  <b className="num">{acts.length}</b><i>分卷</i>
                </span>
                <span className="ol-fstat" data-tone="amber">
                  <b className="num">{fmt(avgWords)}</b><i>均章字</i>
                </span>
              </div>
            </section>

            {/* 节拍 · 里程碑(折叠卡,信息多时卡内滚,不撑破一屏) */}
            <FoldCard
              title="节拍 · 里程碑"
              icon={<Milestone size={15} />}
              count={milestones.length}
              defaultOpen
              scrollable={milestones.length > 4}
              maxHeight={260}
            >
              {milestones.length ? (
                <div className="ol-beats">
                  {milestones.map((m) => {
                    const state = m.status === "done" ? "done" : m.status === "current" ? "running" : "pending"
                    const label = m.status === "done" ? "已达成" : m.status === "current" ? "进行中" : "未开始"
                    const chAt = Math.max(1, Math.round(m.progress * totalPlanned))
                    return (
                      <div className={`ol-beat is-${m.status}`} key={m.id}>
                        <span className="ol-beat-ico">
                          {m.status === "done" ? <Check size={12} /> : m.label.zh.charAt(0)}
                        </span>
                        <span className="ol-beat-body">
                          <span className="ol-beat-name">{m.label.zh}</span>
                          <span className="ol-beat-ch">第 {chAt} 章 · {Math.round(m.progress * 100)}%</span>
                        </span>
                        <span className="pill" data-state={state}><span className="dot" />{label}</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="empty" style={{ padding: "16px 8px" }}>暂无里程碑</div>
              )}
            </FoldCard>

            {/* 分卷推进(折叠卡:每卷完成率进度条) */}
            <FoldCard
              title="分卷推进"
              icon={<GitBranch size={15} />}
              count={acts.length}
              defaultOpen
              scrollable={acts.length > 5}
              maxHeight={260}
            >
              {acts.length ? (
                <div className="ol-threads">
                  {acts.map((a, ai) => {
                    const aDone = a.chapters.filter((c) => isDone(c.status)).length
                    const pct = a.chapters.length ? Math.round((aDone / a.chapters.length) * 100) : 0
                    const accent = ["var(--c-world)", "var(--c-char)", "var(--c-fore)", "var(--brand-500)", "var(--ok-500)"][ai % 5]
                    return (
                      <div className="ol-thread" key={a.actId}>
                        <div className="ol-th-top">
                          <span className="ol-th-mark" style={{ background: accent }} />
                          <span className="ol-th-name">{a.actTitle.zh}</span>
                          <span className="ol-th-pct">{pct}%</span>
                        </div>
                        <div className="ol-th-progress"><i style={{ width: `${pct}%`, background: accent }} /></div>
                        <div className="ol-th-tags">{a.chapters.length} 章 · 已完成 {aDone} · {fmt(a.chapters.reduce((s, c) => s + (c.words || 0), 0))} 字</div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="empty" style={{ padding: "16px 8px" }}>暂无分卷</div>
              )}
            </FoldCard>

            {/* 下一卷推演:把现有结构丢给模型继续推演(复用上方逻辑) */}
            <section className="card ol-next">
              <div className="ol-next-head">
                <Sparkles size={14} />
                <span className="ol-next-title">推演下一卷</span>
              </div>
              <p className="ol-next-desc">
                把现有 {acts.length} 卷 / {tension.length} 个张力点丢给模型,推下一卷主题、冲突、角色弧线与 10 个章节标题。
              </p>
              <div className="ol-next-acts">
                <button type="button" className="btn primary sm" onClick={copyPlanningPrompt}>
                  <Sparkles size={12} /> 复制推演提示
                </button>
                <button type="button" className="btn sm" onClick={exportOutline}>
                  <ListOrdered size={12} /> 导出大纲
                </button>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  )
}
