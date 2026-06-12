"use client"

import * as React from "react"
import useSWR from "swr"
import { useRouter } from "next/navigation"
import {
  Globe2,
  Layers,
  Crosshair,
  ScrollText,
  TrendingUp,
  Milestone,
  Flag,
  Check,
  BookOpen,
} from "lucide-react"
import { fetchMemory, fetchOutline, fetchPlotProgress } from "@/lib/api/client"
import type { MemoryItem } from "@/lib/studio-data"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder, EmptyArt, MiniEmpty } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import "./memory.css"

const soft = { shouldRetryOnError: false }
const RAIL = 150
const CELL = 64
const BAND_Y = 12
const CALLOUT_Y = 40
const AXIS_Y = 72
const LANES_Y = 104
const LANE_H = 72

type LaneDef = { kind: MemoryItem["kind"]; label: string; color: string; icon: React.ReactNode }
const LANES: LaneDef[] = [
  { kind: "world", label: "世界观锚点", color: "var(--c-world)", icon: <Globe2 size={13} /> },
  { kind: "long", label: "长期记忆", color: "var(--c-memory)", icon: <Layers size={13} /> },
  { kind: "current", label: "当前焦点", color: "var(--c-focus)", icon: <Crosshair size={13} /> },
]
// 卷彩带的分卷配色:四档分类色循环。走 viz 语义 token + color-mix 调出柔和底/可读字,
// 因此暗色与 7 套主题下都跟随切换(而非锁死在浅色 hex)。
const BAND_COLORS = [
  { bg: "color-mix(in srgb, var(--brand-500) 12%, transparent)", fg: "var(--brand-700)" },
  { bg: "color-mix(in srgb, var(--c-memory) 14%, transparent)", fg: "var(--c-memory)" },
  { bg: "color-mix(in srgb, var(--c-world) 15%, transparent)", fg: "var(--c-world)" },
  { bg: "color-mix(in srgb, var(--c-focus) 16%, transparent)", fg: "var(--c-focus)" },
]

// 泳道 kind → KpiChip 语义色调(只走既有 tone,不引入新色)
const LANE_TONE: Record<MemoryItem["kind"], "info" | "brand" | "amber"> = {
  world: "brand",
  long: "info",
  current: "amber",
}

export default function MemoryPage() {
  const router = useRouter()
  const { books, bookId, booksLoading } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const { data: memory } = useSWR(bookId ? ["memory", bookId] : null, () => fetchMemory(bookId), soft)
  const { data: outline } = useSWR(bookId ? ["outline", bookId] : null, () => fetchOutline(bookId), soft)
  const { data: plot } = useSWR(bookId ? ["plot", bookId] : null, () => fetchPlotProgress(bookId), soft)

  const [hidden, setHidden] = React.useState<Set<string>>(new Set())
  // sparkline 自定义 tooltip:与记忆节点 .pop 统一视觉语言,替代原生 SVG <title>。
  // x 为 0–1 的水平比例(SVG 用 preserveAspectRatio=none 拉伸,按比例定位才不会错位)。
  const [spark, setSpark] = React.useState<{ x: number; title: string; sub: string } | null>(null)

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="记忆长卷" sub="本地工作区还没有作品,创建后这里会出现按章铺开的记忆泳道。" />
  }

  // 加载骨架
  if (bookId && !memory && !outline) {
    return (
      <div className="cj-screen cj-memory">
        <div className="skel" style={{ height: 66, margin: 16 }} />
        <div style={{ display: "flex", flex: "1 1 auto", gap: 0, minHeight: 0 }}>
          <div style={{ flex: "1 1 auto", padding: 16 }}>
            <div className="skel" style={{ height: "100%", borderRadius: "var(--r-xl)" }} />
          </div>
          <div style={{ width: 340, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 120, borderRadius: "var(--r-xl)" }} />)}
          </div>
        </div>
      </div>
    )
  }

  const items = memory ?? []
  const curChapter = active?.currentChapter ?? 0
  // 长卷只铺「已知内容」范围,而非整本规划(plannedChapters 可能高达数千),否则画布会无限拉长。
  const maxItemCh = items.reduce((m, it) => Math.max(m, it.chapter), 0)
  const maxOutlineCh = (outline ?? []).flatMap((a) => a.chapters.map((c) => c.num)).reduce((m, n) => Math.max(m, n), 0)
  const maxCh = Math.max(curChapter, maxItemCh, maxOutlineCh, 8) + 1

  const counts = { world: 0, long: 0, current: 0 } as Record<string, number>
  for (const it of items) counts[it.kind] = (counts[it.kind] ?? 0) + 1
  const lanes = LANES.filter((l) => counts[l.kind] > 0 || items.length === 0)
  const visibleLanes = lanes.filter((l) => !hidden.has(l.kind))

  const cx = (ch: number) => RAIL + (Math.max(1, ch) - 0.5) * CELL
  const canvasWidth = RAIL + maxCh * CELL
  const canvasHeight = LANES_Y + visibleLanes.length * LANE_H + 16

  const acts = outline ?? []
  const milestones = plot?.milestones ?? []

  const axisStep = Math.max(1, Math.ceil(maxCh / 22))

  // ── sparkline 数据:每章新增 vs 累积。线性扫一次,不用 useMemo(避免 hook 顺序问题)。
  const sparkData: { ch: number; add: number; cum: number }[] = []
  {
    let cum = 0
    for (let ch = 1; ch <= maxCh - 1; ch++) {
      const add = items.filter((it) => it.chapter === ch).length
      cum += add
      sparkData.push({ ch, add, cum })
    }
  }
  const maxAdd = Math.max(1, ...sparkData.map((d) => d.add))
  const maxCum = Math.max(1, ...sparkData.map((d) => d.cum))

  // 最新记忆:从已取数据派生(不新增请求),给 Inspector 折叠卡用 —— 按章倒序取最近若干条。
  const recentItems = [...items]
    .sort((a, b) => b.chapter - a.chapter)
    .slice(0, 14)

  const toggleLane = (kind: string) =>
    setHidden((h) => {
      const n = new Set(h)
      n.has(kind) ? n.delete(kind) : n.add(kind)
      return n
    })

  return (
    <div className="cj-screen cj-memory">
      {/* ── 顶部工作条:像素 + 标题 + 泳道开关 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead mem-head">
        <div className="mem-headline">
          <PixelBadge kind="memory" size={44} className="mem-hero-pixel" ariaLabel="记忆长卷" />
          <div className="mem-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">记忆长卷</h1>
              <span className="mem-hero-book">《{active?.title.zh ?? "—"}》</span>
            </div>
            <div className="page-sub">
              {items.length} 条记忆跨 {maxCh} 章铺开 · 当前推进到第 {curChapter} 章 —— 世界观锚点、长期记忆与当前焦点按卷成行。
            </div>
          </div>
          {/* 泳道开关:沿用 chip 切换逻辑,移到工作条右侧 */}
          <div className="lane-toggle mem-head-toggle" role="group" aria-label="泳道筛选">
            {LANES.map((l) => (
              <button
                type="button"
                key={l.kind}
                className={`chip${!hidden.has(l.kind) ? " active" : ""}`}
                onClick={() => toggleLane(l.kind)}
                aria-pressed={!hidden.has(l.kind)}
              >
                <span className="dot" style={{ background: l.color }} />
                {l.label} <span className="num">{counts[l.kind] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="mem-kpis" role="group" aria-label="记忆概览">
          <KpiChip label="记忆总数" value={items.length} unit="条" tone="brand" />
          <KpiChip
            label="长期记忆"
            value={counts.long ?? 0}
            unit="条"
            tone={(counts.long ?? 0) > 0 ? "info" : "neutral"}
          />
          <KpiChip
            label="世界观锚点"
            value={counts.world ?? 0}
            unit="条"
            tone={(counts.world ?? 0) > 0 ? "brand" : "neutral"}
          />
          <KpiChip
            label="当前焦点"
            value={counts.current ?? 0}
            unit="条"
            tone={(counts.current ?? 0) > 0 ? "amber" : "neutral"}
          />
          <KpiChip
            label="覆盖章数"
            value={maxCh}
            unit="章"
            tone="neutral"
            sub={<StatLine items={[{ n: curChapter, label: "当前", tone: "brand" }]} />}
          />
        </div>
      </header>

      {/* ── 主体:左 记忆长卷(主区,横向滚) · 右 Inspector(焦点 + 增长 + 构成 + 最新记忆)── */}
      <div className="cj-screen-body mem-body">
        <div className="cj-mainpane mem-mainpane">
          <div className="mem-mainpane-head">
            <span className="mem-mainpane-title"><ScrollText size={14} /> 记忆长卷</span>
            <span className="mem-mainpane-sub">按章节横向铺开 · 悬停查看全文</span>
            <span className="mem-mainpane-hint">← 横向滚动浏览全书 →</span>
          </div>
          {/* 有界视口:横向滚动,纵向不滚 */}
          <div className="scroll-viewport scroll-thin">
            <div className="scroll-canvas" style={{ width: canvasWidth, height: canvasHeight, minWidth: "100%" }}>
              {/* sticky 泳道栏 */}
              <div className="lane-rail" style={{ height: canvasHeight }}>
                {visibleLanes.map((l, i) => (
                  <div key={l.kind} className="lane-label" style={{ top: LANES_Y + i * LANE_H + LANE_H / 2 - 8 }}>
                    <span className="lane-ico" style={{ color: l.color }}>{l.icon}</span>
                    {l.label}
                    <span className="ct">{counts[l.kind] ?? 0}</span>
                  </div>
                ))}
              </div>

              {/* 卷彩带 */}
              {acts.map((a, ai) => {
                const nums = a.chapters.map((c) => c.num)
                if (!nums.length) return null
                const min = Math.min(...nums), max = Math.max(...nums)
                const c = BAND_COLORS[ai % BAND_COLORS.length]
                return (
                  <div key={a.actId} className="vol-band" style={{ left: RAIL + (min - 1) * CELL + 2, width: (max - min + 1) * CELL - 4, top: BAND_Y, background: c.bg, color: c.fg }}>
                    {a.actTitle.zh}
                  </div>
                )
              })}

              {/* 里程碑气泡 */}
              {milestones.map((m) => (
                <div key={m.id} className={`beat-callout${m.status === "current" ? " cur" : ""}`} style={{ left: cx(Math.max(1, Math.round(m.progress * maxCh))), top: CALLOUT_Y }}>
                  {m.label.zh}
                </div>
              ))}

              {/* 章节竖网格 */}
              {Array.from({ length: maxCh }).map((_, i) => (
                <div key={`g${i}`} className="ch-grid" style={{ left: RAIL + i * CELL, top: AXIS_Y, height: canvasHeight - AXIS_Y - 4 }} />
              ))}

              {/* 章节轴 */}
              <div className="ch-axis" style={{ top: AXIS_Y }}>
                {Array.from({ length: maxCh }).map((_, i) => {
                  const ch = i + 1
                  if (ch !== 1 && ch !== maxCh && ch !== curChapter && (ch - 1) % axisStep !== 0) return null
                  const cls = ch === curChapter ? "cur" : ch <= curChapter ? "done" : ""
                  return <div key={ch} className={`ch-tick ${cls}`} style={{ left: cx(ch), top: 2 }}>{ch}</div>
                })}
              </div>

              {/* 泳道分隔 */}
              {visibleLanes.map((l, i) => (
                <div key={`s${l.kind}`} className="lane-sep" style={{ top: LANES_Y + i * LANE_H }} />
              ))}

              {/* now 线 */}
              {curChapter > 0 && <div className="now-line" style={{ left: cx(curChapter), top: CALLOUT_Y, height: canvasHeight - CALLOUT_Y - 4 }} />}

              {/* 记忆节点 */}
              {visibleLanes.map((l, li) =>
                items.filter((it) => it.kind === l.kind).map((it) => (
                  <div
                    key={it.id}
                    className="mem-node"
                    style={{ left: cx(it.chapter), top: LANES_Y + li * LANE_H + LANE_H / 2 }}
                    title={`回到第 ${it.chapter} 章阅读`}
                    onClick={() => router.push(`/immersive?chapter=${it.chapter}`)}
                  >
                    <span className="nd" style={{ background: l.color }} />
                    {it.text.zh}
                    <span className="pop">
                      <span className="ttl">{it.text.zh}</span>
                      {(it.text.en || "").slice(0, 220) || "(无更多内容)"}
                      <span className="meta">第 {it.chapter} 章 · {l.label}</span>
                    </span>
                  </div>
                )),
              )}

              {items.length === 0 && memory && (
                <div className="empty mem-empty-dock">
                  <div className="mem-empty-art"><EmptyArt variant="memory" /></div>
                  <b>记忆长卷还没铺开</b>
                  <span>开始写作后,世界观与焦点会按章铺到这条长卷上。</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── 右侧 Inspector:焦点(记忆守护) / 增长走势 / 泳道构成 / 最新记忆(只在 pane 内滚)── */}
        <aside className="cj-inspector mem-inspector">
          <div className="cj-pane-scroll mem-insp-scroll scroll-thin">
            {/* 焦点卡:像素「记忆守护」+ 记忆密度 + 推进进度 */}
            <section className="card mem-focus">
              <div className="mem-focus-top">
                <AgentPixel id="state-verifier" size={48} className="mem-focus-pix" ariaLabel="记忆守护" />
                <div className="mem-focus-meta">
                  <span className="mem-focus-role">记忆守护</span>
                  <span className="mem-focus-book">《{active?.title.zh ?? "—"}》</span>
                </div>
                <span className="tag brand mem-focus-tag">
                  <span className="dot" style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", display: "inline-block" }} />
                  {items.length} 条
                </span>
              </div>
              <div className="mem-focus-meter">
                <Meter label="记忆密度" value={items.length} max={Math.max(maxCh, items.length, 1)} tone="brand" showValue={false} />
                <div className="mem-focus-cap">
                  <span className="num">{items.length}</span>
                  <span className="mem-focus-of">条 / 跨 {maxCh} 章</span>
                  <span className="mem-focus-pct">{maxCh > 0 ? (items.length / maxCh).toFixed(1) : "0"}/章</span>
                </div>
              </div>
              <div className="mem-focus-meter">
                <Meter label="当前推进" value={curChapter} max={Math.max(maxCh, curChapter, 1)} tone="ok" showValue={false} />
                <div className="mem-focus-cap">
                  <span className="num">{curChapter}</span>
                  <span className="mem-focus-of">/{maxCh} 章</span>
                  <span className="mem-focus-pct">{maxCh > 0 ? Math.round((curChapter / maxCh) * 100) : 0}%</span>
                </div>
              </div>
            </section>

            {/* ── 记忆增长 sparkline:每章新增 + 累积曲线(图表,保留卡框)──── */}
            {sparkData.length > 0 && (
              <section className="card mem-spark">
                <div className="ms-head">
                  <h4><TrendingUp size={14} /> 记忆增长 <span className="muted">· 累计 {sparkData[sparkData.length - 1]?.cum} 条</span></h4>
                  <div className="ms-legend">
                    <span><i className="ms-bar" />新增</span>
                    <span><i className="ms-line" />累计</span>
                  </div>
                </div>
                {(() => {
                  const W = 800, H = 92, PADL = 8, PADR = 8, PADT = 8, PADB = 14
                  const innerW = W - PADL - PADR, innerH = H - PADT - PADB
                  const n = sparkData.length
                  const xOf = (i: number) => PADL + (i / Math.max(1, n - 1)) * innerW
                  // tooltip 水平定位:用数据索引在内容区的比例(0–1),CSS left:% 即可对齐拉伸后的 SVG。
                  const fracOf = (i: number) => (PADL + (i / Math.max(1, n - 1)) * innerW) / W
                  const cumPath = sparkData
                    .map((d, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${(PADT + innerH - (d.cum / maxCum) * innerH).toFixed(1)}`)
                    .join(" ")
                  const barW = Math.max(2, Math.min(14, innerW / Math.max(1, n) - 2))
                  return (
                    <div className="ms-plot">
                      <svg className="ms-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                        {/* baseline 0 */}
                        <line x1={PADL} y1={PADT + innerH} x2={W - PADR} y2={PADT + innerH} stroke="var(--line-2)" strokeWidth="1" strokeDasharray="3 3" />
                        {/* 每章新增的柱状 */}
                        {sparkData.map((d, i) => {
                          const h = (d.add / maxAdd) * (innerH * 0.55)
                          const x = xOf(i) - barW / 2
                          const y = PADT + innerH - h
                          return d.add > 0 ? (
                            <rect
                              key={`b${i}`}
                              className="ms-rect"
                              x={x.toFixed(1)} y={y.toFixed(1)} width={barW} height={h.toFixed(1)} rx={1.5}
                              fill="var(--brand-400)" opacity={0.55}
                              onMouseEnter={() => setSpark({ x: fracOf(i), title: `第 ${d.ch} 章`, sub: `新增 ${d.add} · 累计 ${d.cum}` })}
                              onMouseLeave={() => setSpark(null)}
                            />
                          ) : null
                        })}
                        {/* 累积曲线 */}
                        <path d={cumPath} fill="none" stroke="var(--brand-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        {/* 当前章浮标 */}
                        {curChapter > 0 && curChapter <= n && (() => {
                          const d = sparkData[curChapter - 1]
                          if (!d) return null
                          const x = xOf(curChapter - 1)
                          const y = PADT + innerH - (d.cum / maxCum) * innerH
                          return (
                            <g
                              onMouseEnter={() => setSpark({ x: fracOf(curChapter - 1), title: `当前第 ${curChapter} 章`, sub: `累计 ${d.cum} 条` })}
                              onMouseLeave={() => setSpark(null)}
                            >
                              <line x1={x} y1={PADT} x2={x} y2={PADT + innerH} stroke="var(--brand-500)" strokeWidth="1" strokeDasharray="2 3" opacity="0.35" />
                              <circle className="ms-now" cx={x} cy={y} r="3.5" fill="var(--brand-500)" stroke="var(--bg-card)" strokeWidth="1.5" />
                            </g>
                          )
                        })()}
                        {/* x 轴标注:每 5 章一个 tick */}
                        {sparkData.filter((_, i) => i % 5 === 0 || i === n - 1).map((d) => (
                          <text
                            key={`t${d.ch}`}
                            x={xOf(sparkData.findIndex((x) => x.ch === d.ch))}
                            y={H - 2}
                            textAnchor="middle"
                            fontSize="9"
                            fill="var(--ink-400)"
                          >
                            {d.ch}
                          </text>
                        ))}
                      </svg>
                      {spark && (
                        <span className="ms-tip" style={{ left: `${(spark.x * 100).toFixed(2)}%` }}>
                          <span className="ttl">{spark.title}</span>
                          {spark.sub}
                        </span>
                      )}
                    </div>
                  )
                })()}
              </section>
            )}

            {/* 泳道构成(折叠卡):每类记忆的占比条 + 计数 */}
            <FoldCard
              title="泳道构成"
              icon={<Layers size={15} />}
              count={items.length}
              defaultOpen
            >
              {items.length ? (
                <div className="mem-lanes">
                  {LANES.map((l) => {
                    const c = counts[l.kind] ?? 0
                    const pct = items.length ? Math.round((c / items.length) * 100) : 0
                    return (
                      <div className="mem-lane" key={l.kind}>
                        <div className="mem-lane-top">
                          <span className="mem-lane-ico" style={{ color: l.color }}>{l.icon}</span>
                          <span className="mem-lane-name">{l.label}</span>
                          <span className="mem-lane-ct">
                            <b className="num">{c}</b>
                            <i>{pct}%</i>
                          </span>
                        </div>
                        <div className="mem-lane-track"><i style={{ width: `${pct}%`, background: l.color }} /></div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <MiniEmpty icon="manuscript-stack">记忆抽屉还空着,开笔后会按类型慢慢攒满</MiniEmpty>
              )}
            </FoldCard>

            {/* 节拍 · 里程碑(折叠卡,信息多时卡内滚,不撑破一屏) */}
            <FoldCard
              title="节拍 · 里程碑"
              icon={<Milestone size={15} />}
              count={milestones.length}
              defaultOpen={milestones.length > 0}
              scrollable={milestones.length > 4}
              maxHeight={224}
            >
              {milestones.length ? (
                <div className="mem-beats">
                  {milestones.map((m) => {
                    const state = m.status === "done" ? "done" : m.status === "current" ? "running" : "pending"
                    const label = m.status === "done" ? "已达成" : m.status === "current" ? "进行中" : "未开始"
                    const chAt = Math.max(1, Math.round(m.progress * maxCh))
                    return (
                      <div className={`mem-beat is-${m.status}`} key={m.id}>
                        <span className="mem-beat-ico">
                          {m.status === "done" ? <Check size={12} /> : <Flag size={12} />}
                        </span>
                        <span className="mem-beat-body">
                          <span className="mem-beat-name">{m.label.zh}</span>
                          <span className="mem-beat-ch">第 {chAt} 章 · {Math.round(m.progress * 100)}%</span>
                        </span>
                        <span className="pill" data-state={state}><span className="dot" />{label}</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <MiniEmpty icon="stamp-seal">里程碑还空着,写到关键章会自动立起来</MiniEmpty>
              )}
            </FoldCard>

            {/* 最新记忆(折叠卡:按章倒序,带类型图标 + 章号 pill) */}
            <FoldCard
              title="最新记忆"
              icon={<BookOpen size={15} />}
              count={items.length}
              defaultOpen={milestones.length === 0}
              scrollable={recentItems.length > 5}
              maxHeight={260}
            >
              {recentItems.length ? (
                <div className="mem-recent">
                  {recentItems.map((it) => {
                    const lane = LANES.find((l) => l.kind === it.kind)
                    return (
                      <div className="mem-rec" key={it.id} title={it.text.zh}>
                        <span className="mem-rec-ico" style={{ color: lane?.color }}>
                          {lane?.icon ?? <Layers size={13} />}
                        </span>
                        <span className="mem-rec-text">{it.text.zh}</span>
                        <span className="mem-rec-ch">第 {it.chapter} 章</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <MiniEmpty icon="ink-quill">最新记忆会按章沉淀到这里,等首章落笔</MiniEmpty>
              )}
            </FoldCard>
          </div>
        </aside>
      </div>
    </div>
  )
}
