"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import {
  ArrowUpRight,
  BookOpen,
  Download,
  FileText,
  Flame,
  Gauge,
  Minus,
  Radar,
  ScrollText,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react"
import { toast } from "sonner"
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { fetchBookAnalytics, fetchChapters, fetchDockMetrics, fetchOpportunities, fetchPlotProgress, fetchReaderFeedback } from "@/lib/api/client"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder, MiniEmpty } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { KpiChip, Meter, FoldCard } from "@/components/design/kit"
import { EarnPath } from "@/components/workbench/earn-path"
import "./insights.css"

const soft = { shouldRetryOnError: false }
const fmt = (n: number | undefined | null) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "—")
// 统一的评分→色阶:高(达标)/中(接近)/低,供各处复用,避免阈值色散落多处
const SCORE_HI = 85
const SCORE_MID = 70
const scoreColor = (n: number | undefined | null) =>
  typeof n === "number" && Number.isFinite(n)
    ? n >= SCORE_HI
      ? "var(--ok-500)"
      : n >= SCORE_MID
        ? "var(--brand-600)"
        : "var(--warn-500)"
    : "var(--ink-400)"
// 综合质量 → 一字总评 + 语义类(供 hero 焦点条原地呈现「这本书现在写得怎样」)
const verdictOf = (n: number) =>
  n >= 90 ? { label: "优秀", cls: "ok" } : n >= SCORE_HI ? { label: "达标", cls: "ok" } : n >= SCORE_MID ? { label: "良好", cls: "brand" } : n > 0 ? { label: "待打磨", cls: "warn" } : { label: "暂无评分", cls: "muted" }
// 机会评分 → 「为什么能赚」的读者承诺判读(只用后端已给的相对排名分,不编收益)
// 高分=读者承诺强、值得优先押注;中分=有盘子但要做出差异;低分=需求薄/拥挤,谨慎。
const oppRead = (score: number) =>
  score >= SCORE_HI
    ? { label: "读者承诺强", hint: "需求明确、值得优先押注", cls: "ok" }
    : score >= SCORE_MID
      ? { label: "有盘子可做", hint: "盘子在,靠差异化吃下", cls: "brand" }
      : { label: "需求偏薄", hint: "拥挤或冷门,谨慎投入", cls: "warn" }
const cleanTitle = (t: string) => {
  const base = (t.split("/").pop() ?? t).replace(/\.md$/, "")
  const m = base.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/)
  if (m) return `市场扫描 · ${m[2]}-${m[3]} ${m[4]}:${m[5]}`
  return base.replace(/^雷达扫描-?/, "市场扫描 ")
}
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

function TrendTip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: number }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rc-tip">
      <div className="t">第 {label} 章</div>
      {payload.map((p) => (
        <div className="r" key={p.name}><span style={{ width: 8, height: 8, borderRadius: 999, background: p.color, display: "inline-block" }} />{p.name}<b>{p.value}</b></div>
      ))}
    </div>
  )
}

export default function InsightsPage() {
  const router = useRouter()
  const { books, bookId, booksLoading } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const { data: metrics } = useSWR(bookId ? ["metrics", bookId] : null, () => fetchDockMetrics(bookId), soft)
  const { data: plot } = useSWR(bookId ? ["plot", bookId] : null, () => fetchPlotProgress(bookId), soft)
  const { data: chapters } = useSWR(bookId ? ["chapters", bookId] : null, () => fetchChapters(bookId), soft)
  const { data: opps } = useSWR("opportunities", fetchOpportunities, soft)
  const { data: reader } = useSWR(bookId ? ["reader", bookId] : null, () => fetchReaderFeedback(bookId), soft)
  const { data: analytics } = useSWR(bookId ? ["analytics", bookId] : null, () => fetchBookAnalytics(bookId), soft)

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="洞察中心" sub="本地工作区还没有作品,创建后这里会出现创作趋势与市场机会。" />
  }

  // 加载骨架:数据未到位时给结构占位,避免空白闪烁
  if (bookId && !metrics && !chapters) {
    return (
      <div className="cj-screen cj-insights">
        <header className="cj-workhead ins-head">
          <div className="ins-headline">
            <div className="skel" style={{ height: 44, width: 44, borderRadius: 12 }} />
            <div style={{ flex: 1 }}>
              <div className="skel" style={{ height: 22, width: 200, marginBottom: 8 }} />
              <div className="skel" style={{ height: 13, width: 340 }} />
            </div>
          </div>
          <div className="ins-kpis">
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 58, borderRadius: 12 }} />)}
          </div>
        </header>
        <div className="cj-screen-body ins-body">
          <div className="cj-mainpane ins-mainpane">
            <div className="skel" style={{ height: 260, borderRadius: 14, margin: 14 }} />
            <div className="skel" style={{ height: 200, borderRadius: 14, margin: "0 14px 14px" }} />
          </div>
          <aside className="cj-inspector ins-inspector">
            <div className="skel" style={{ height: 220, borderRadius: 14, margin: 14 }} />
          </aside>
        </div>
      </div>
    )
  }

  const q = Math.round(metrics?.quality ?? 0)
  const c = Math.round(metrics?.consistency ?? 0)
  const adopted = Math.round(metrics?.adopted ?? 0)
  const chaps = [...(chapters ?? [])].sort((a, b) => a.num - b.num)
  const tension = [...(plot?.tensionCurve ?? [])].sort((a, b) => a.chapter - b.chapter)

  // 真实每章序列
  const tensionSeries = tension.map((t) => ({ chapter: t.chapter, v: Math.round(t.tension * 100) }))
  const wordsSeries = chaps.map((c2) => ({ chapter: c2.num, v: c2.words || 0 }))
  let cum = 0
  const cumSeries = chaps.map((c2) => ({ chapter: c2.num, v: (cum += c2.words || 0) }))
  const merged = (() => {
    const m = new Map<number, { chapter: number; tension: number; words: number }>()
    for (const t of tension) m.set(t.chapter, { chapter: t.chapter, tension: Math.round(t.tension * 100), words: 0 })
    for (const c2 of chaps) { const e = m.get(c2.num) ?? { chapter: c2.num, tension: 0, words: 0 }; e.words = c2.words || 0; m.set(c2.num, e) }
    return [...m.values()].sort((a, b) => a.chapter - b.chapter)
  })()
  const avgTension = tensionSeries.length ? Math.round(tensionSeries.reduce((s, x) => s + x.v, 0) / tensionSeries.length) : 0
  const avgWords = wordsSeries.length ? Math.round(wordsSeries.reduce((s, x) => s + x.v, 0) / wordsSeries.length) : 0

  // 整体进度:仅当规划章数合理(已写≤规划≤已写×6)时才算百分比,否则不显示误导性的 1%
  const writtenCh = chaps.length || (active?.currentChapter ?? 0)
  const planned = active?.plannedChapters ?? 0
  const planRealistic = planned >= writtenCh && planned > 0 && planned <= Math.max(writtenCh * 6, 60)
  const progressPct = planRealistic ? Math.round((writtenCh / planned) * 100) : 0
  const progressSub = planRealistic ? `已写 ${writtenCh} / ${planned} 章` : `已写 ${writtenCh} 章 · 未设总规划`
  // 初稿采纳率:首版直接采纳占累计字数比(只用已有字段,不编数字)
  const adoptedPct = active?.totalWords ? Math.min(100, Math.round((adopted / active.totalWords) * 100)) : null

  const trendIcon = (t: string) => (t === "up" ? <TrendingUp size={12} /> : t === "down" ? <TrendingDown size={12} /> : <Minus size={12} />)
  const report = [
    `# ${active?.title.zh ?? "当前作品"} · 洞察报告`,
    "",
    `- 累计字数: ${fmt(active?.totalWords)}`,
    `- 单章均字: ${fmt(avgWords)}`,
    `- 平均张力: ${avgTension}/100`,
    `- 综合质量: ${q || "—"}/100`,
    `- 一致性: ${c || "—"}/100`,
    `- 进度: ${progressSub}`,
    "",
    "## 市场机会",
    ...((opps ?? []).slice(0, 8).map((o) => `- ${cleanTitle(o.title.zh)} · ${o.score} · ${o.change}`)),
    (opps ?? []).length ? "" : "- 暂无市场机会数据",
    "## 读者反馈",
    ...(reader?.signals.length
      ? reader.signals.slice(-12).map((s) => `- 第 ${s.chapter} 章《${s.title}》: ${s.verdict}, 读者分 ${s.readerScore ?? "—"}`)
      : ["- 暂无读者信号"]),
  ].join("\n")
  const exportReport = () => {
    downloadText(`${active?.title.zh ?? "AutoW"}-洞察报告.md`, report)
    toast.success("洞察报告已导出")
  }
  const copyWeekly = async () => {
    try {
      await navigator.clipboard.writeText(report)
      toast.success("本周创作摘要已复制", { description: "基于真实章节、质量、张力与读者信号生成。" })
    } catch {
      downloadText(`${active?.title.zh ?? "AutoW"}-创作周报.md`, report)
      toast.success("剪贴板不可用,已下载周报")
    }
  }

  const verdict = verdictOf(q)
  const opCount = (opps ?? []).length
  const sortedOpps = opps && opps.length ? [...opps].sort((a, b) => b.score - a.score) : []
  const topOpp = sortedOpps[0] ?? null

  // 「离能变现还差什么」:把已有真实信号转成单一、可行动的判断,不编收益数字。
  // 把质量(对齐 85 Gate)、一致性、读者追更意愿当作上架/适配前的三道关,挑出最该补的那道。
  const willFollowPct = reader?.summary.willFollowPct ?? null
  const readiness = (() => {
    const gaps: { key: string; gap: number; label: string; tip: string; href: string; cta: string }[] = []
    if (q > 0 && q < SCORE_HI) gaps.push({ key: "quality", gap: SCORE_HI - q, label: `综合质量 ${q} 分,还差 ${SCORE_HI - q} 分到达标`, tip: "把卡分章推到达标,成品才扛得住平台读者", href: "/consistency", cta: "去打磨质量" })
    if (c > 0 && c < SCORE_HI) gaps.push({ key: "consistency", gap: SCORE_HI - c, label: `一致性 ${c} 仍有连贯漏洞`, tip: "设定/角色/时序的硬伤会劝退追读", href: "/consistency", cta: "去查一致性" })
    if (willFollowPct != null && willFollowPct < 60) gaps.push({ key: "reader", gap: 60 - willFollowPct, label: `愿意追更仅 ${willFollowPct}%`, tip: "追读意愿是连载变现的命脉,先补章末钩子", href: "#ins-reader", cta: "看读者反馈" })
    gaps.sort((a, b) => b.gap - a.gap)
    if (!q && !c) return { state: "none" as const, line: "写出并评分章节后,这里会告诉你离能上架/适配平台还差哪一步。" }
    if (!gaps.length) return { state: "ready" as const, line: "质量、一致性、追读意愿都达标 — 这本已经具备把成品推向平台变现的底子。", top: topOpp }
    return { state: "gap" as const, line: "离能稳定变现还差这几步,先啃最关键的一道:", gaps: gaps.slice(0, 3) }
  })()

  // 「按这个机会去适配/创作」:路由到真实的多平台导出页(把成品适配成可发布资产)。
  const actOnOpportunity = (o: { title: { zh: string } }) => {
    toast.success("已打开多平台适配", { description: `参考机会:「${cleanTitle(o.title.zh)}」—— 在平台导出里把成品改写成该平台的可发布版本` })
    router.push("/platform-export")
  }

  // 创作健康度四项:统一用 Meter 呈现(门槛 85 的两项标阈值线),不再各画一个环
  const healthRows: { key: string; label: string; value: number; sub: string; tone: "brand" | "ok" | "warn" | "info"; threshold?: number }[] = [
    { key: "quality", label: "综合质量", value: q, sub: "9 维质量加权,门槛 85", tone: "brand", threshold: SCORE_HI },
    { key: "consistency", label: "一致性", value: c, sub: "设定 / 角色 / 时序连贯", tone: "ok", threshold: SCORE_HI },
    { key: "tension", label: "平均张力", value: avgTension, sub: "全书张力曲线均值", tone: "info" },
    { key: "progress", label: "整体进度", value: progressPct, sub: progressSub, tone: "warn" },
  ]

  return (
    <div className="cj-screen cj-insights">
      {/* ── 顶部工作条:像素「洞察」+ 焦点总评 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead ins-head">
        <div className="ins-headline">
          <PixelBadge kind="insights" size={44} className="ins-hero-pixel" ariaLabel="洞察中心" />
          <div className="ins-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">洞察中心</h1>
              <span className={`ins-grade ${verdict.cls}`} title="当前作品综合质量">
                <b>{q || "—"}</b><i>/ 100 · {verdict.label}</i>
              </span>
              {topOpp ? (
                <button
                  type="button"
                  className="ins-hero-opp"
                  title={`最热机会:${cleanTitle(topOpp.title.zh)} · 点击去适配`}
                  onClick={() => actOnOpportunity(topOpp)}
                >
                  <Flame size={11} /> 最热机会 <b>{cleanTitle(topOpp.title.zh)}</b>
                  <span className="num" style={{ color: scoreColor(topOpp.score) }}>{topOpp.score}</span>
                  <ArrowUpRight size={12} className="ins-hero-opp-go" />
                </button>
              ) : null}
            </div>
            <div className="page-sub">
              《{active?.title.zh ?? "—"}》的创作趋势、市场机会与读者反馈一屏看清 —— 评分、张力、追读意愿都从真实章节派生,可一步带去适配变现。
            </div>
          </div>
          <div className="ins-head-acts">
            <button type="button" className="btn sm" onClick={exportReport}><Download size={12} /> 导出报告</button>
            <button type="button" className="btn primary sm" onClick={copyWeekly}><Sparkles size={12} /> 生成周报</button>
          </div>
        </div>
        <div className="ins-kpis" role="group" aria-label="创作概览">
          <KpiChip label="累计字数" value={fmt(active?.totalWords)} unit="字" tone="brand" spark={cumSeries.length > 1 ? cumSeries.map((d) => d.v) : undefined} />
          <KpiChip label="单章均字" value={fmt(avgWords)} unit="字" tone="amber" spark={wordsSeries.length > 1 ? wordsSeries.map((d) => d.v) : undefined} />
          <KpiChip label="已写章节" value={fmt(writtenCh)} unit="章" tone="neutral" sub={planRealistic ? `规划 ${planned} 章` : "未设总规划"} />
          <KpiChip label="平均张力" value={avgTension || "—"} unit="/100" tone="info" />
          <KpiChip
            label="初稿采纳率"
            value={adoptedPct == null ? "—" : adoptedPct}
            unit="%"
            tone="ok"
            sub={`已采纳 ${fmt(adopted)} 字`}
          />
        </div>
      </header>

      {/* ── 主体:趋势 + 机会 + 读者(主区,pane 内滚) | 创作健康度 + 变现就绪(Inspector)── */}
      <div className="cj-screen-body ins-body">
        <div className="cj-mainpane ins-mainpane">
          <div className="cj-pane-scroll ins-pane-scroll">
            {/* 变现路径 wayfinding */}
            <EarnPath current="idea" />

            {/* 多维趋势 — composed chart(主视觉) */}
            <section className="card ins-trend">
              <div className="card-head">
                <div className="card-title"><ScrollText size={14} className="ins-card-ic" /> 多维趋势 · 按章节</div>
                <div className="ins-legend">
                  <span className="li"><span className="sw sw-tension" />张力</span>
                  <span className="li"><span className="sw sw-words" />字数</span>
                </div>
              </div>
              <div className="ins-chart-box">
                {merged.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={merged} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
                      <defs>
                        <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--brand-500)" stopOpacity={0.3} /><stop offset="1" stopColor="var(--brand-500)" stopOpacity={0.02} /></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 5" stroke="var(--line-1)" vertical={false} />
                      <XAxis dataKey="chapter" tickLine={false} axisLine={false} tickMargin={8} />
                      <YAxis yAxisId="t" domain={[0, 100]} tickLine={false} axisLine={false} width={28} />
                      <YAxis yAxisId="w" orientation="right" tickLine={false} axisLine={false} width={36} />
                      <Tooltip content={<TrendTip />} cursor={{ stroke: "var(--line-3)" }} />
                      <Bar yAxisId="w" dataKey="words" name="字数" fill="var(--c-memory)" radius={[3, 3, 0, 0]} barSize={9} opacity={0.5} isAnimationActive animationDuration={700} animationEasing="ease-out" />
                      <Area yAxisId="t" type="monotone" dataKey="tension" name="张力" stroke="var(--brand-500)" strokeWidth={2.2} fill="url(#tg)" dot={{ r: 2.5, fill: "var(--brand-500)" }} isAnimationActive animationDuration={850} animationEasing="ease-out" />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : <MiniEmpty fill icon="ink-quill">张力曲线等首章开笔,写起来这里就会爬坡</MiniEmpty>}
              </div>
            </section>

            {/* Token 用量 · 模型消耗(后端 computeAnalytics.tokenStats,只读)*/}
            <section className="card ins-tokens">
              <div className="card-head">
                <div className="card-title"><Sparkles size={14} className="ins-card-ic" /> Token 用量 · 模型消耗</div>
                <span className="ins-token-total">{fmt(analytics?.tokenStats?.totalTokens)} <em>tokens</em></span>
              </div>
              <div className="ins-token-stats">
                <div className="ins-token-stat ts-prompt"><b>{fmt(analytics?.tokenStats?.totalPromptTokens)}</b><span>读入设定</span></div>
                <div className="ins-token-stat ts-completion"><b>{fmt(analytics?.tokenStats?.totalCompletionTokens)}</b><span>生成正文</span></div>
                <div className="ins-token-stat ts-avg"><b>{fmt(analytics?.tokenStats?.avgTokensPerChapter)}</b><span>章均用量</span></div>
              </div>
              <div className="ins-chart-box ins-token-chart">
                {(analytics?.tokenStats?.recentTrend?.length ?? 0) > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={analytics?.tokenStats?.recentTrend ?? []} margin={{ top: 8, right: 8, bottom: 4, left: -6 }}>
                      <defs>
                        <linearGradient id="tkg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--c-focus)" stopOpacity={0.9} /><stop offset="1" stopColor="var(--c-focus)" stopOpacity={0.25} /></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 5" stroke="var(--line-1)" vertical={false} />
                      <XAxis dataKey="chapter" tickLine={false} axisLine={false} tickMargin={8} fontSize={10} />
                      <YAxis tickLine={false} axisLine={false} width={42} fontSize={10} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                      <Tooltip cursor={{ fill: "var(--bg-sunken)" }} formatter={(v: number) => [fmt(v), "token"]} labelFormatter={(l) => `第 ${l} 章`} />
                      <Bar dataKey="totalTokens" name="token" fill="url(#tkg)" radius={[4, 4, 0, 0]} barSize={12} isAnimationActive animationDuration={700} animationEasing="ease-out" />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : <MiniEmpty fill icon="sleeping-cat">本书还没有 token 用量记录 —— 写几章就有啦 🐾</MiniEmpty>}
              </div>
            </section>

            {/* 市场机会雷达 — 每个机会是「能赚在哪 + 一步去做」的可行动选题 */}
            <section className="ins-block ins-opps">
              <h3 className="sh"><Radar size={14} /> 市场机会雷达 <span className="c">{opCount}</span></h3>
              {sortedOpps.length ? (
                <div className="opp-list">
                  {sortedOpps.slice(0, 6).map((o, i) => {
                    const read = oppRead(o.score)
                    const top = i === 0
                    return (
                      <button
                        type="button"
                        className={`opp${top ? " is-top" : ""}`}
                        key={`${o.id}-${i}`}
                        onClick={() => actOnOpportunity(o)}
                        title={`${cleanTitle(o.title.zh)} · 点击带去多平台适配`}
                      >
                        <span className={`opp-score ${read.cls}`}>
                          <b>{o.score}</b>
                          {top ? <i className="opp-flame"><Flame size={9} /></i> : null}
                        </span>
                        <span className="opp-main">
                          <span className="opp-name">{cleanTitle(o.title.zh)}</span>
                          <span className="opp-why">
                            <span className={`opp-tag ${read.cls}`}>{read.label}</span>
                            <span className="opp-hint">{read.hint}</span>
                          </span>
                        </span>
                        <span className="opp-side">
                          <span className={`opp-trend ${o.trend}`}>{trendIcon(o.trend)} {o.change}</span>
                          <span className="opp-go">{top ? "去建书 / 适配" : "去适配"} <ArrowUpRight size={11} /></span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="opp-empty">
                  <AgentPixel id="market-radar" size={40} ariaLabel="市场雷达" />
                  <p>雷达暂时没扫到机会。<br />写出几章并完成评分后,这里会按读者承诺与热度,给出值得押注的选题。</p>
                </div>
              )}
              {sortedOpps.length ? (
                <p className="opp-foot">分数越高 = 读者承诺越强、越值得优先押注 · 点任意机会即可带去多平台适配成可发布成品</p>
              ) : null}
            </section>

            {/* 读者反馈 · 读者评审官 */}
            <section className="ins-block ins-reader" id="ins-reader">
              <h3 className="sh"><Users size={14} /> 读者反馈 · 读者评审官 <span className="c">{reader?.summary.count ?? 0}</span>
                {reader && reader.summary.count > 0 && (
                  <span className="rf-sum">
                    <span>愿意追更 <b>{reader.summary.willFollowPct}%</b></span>
                    <span>平均追读意愿 <b>{reader.summary.avgReadOn}</b>/100</span>
                  </span>
                )}
              </h3>
              {reader && reader.signals.length ? (
                <div className="rf-list">
                  {[...reader.signals].reverse().slice(0, 12).map((s) => {
                    const follow = s.verdict.includes("愿意追更")
                    return (
                      <div className="rf-row" key={s.chapter}>
                        <span className="rf-ch"><FileText size={12} className="rf-ch-ic" />第 {s.chapter} 章</span>
                        <span className="rf-title">{s.title}</span>
                        <span className={`rf-verdict${follow ? " ok" : ""}`}><span className="dot" />{s.verdict}</span>
                        <span className="rf-metrics">
                          <span title="开篇钩子">钩 {s.hook ?? "—"}</span>
                          <span title="沉浸感">浸 {s.immersion ?? "—"}</span>
                          <span title="清晰度">晰 {s.clarity ?? "—"}</span>
                        </span>
                        <span className="rf-score" style={{ color: scoreColor(s.readerScore) }}>{s.readerScore ?? "—"}</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <MiniEmpty icon="editor-bot">读者评审官还在等首批章节 —— 每章 Gate 前,这里会给出「追读意愿 / 开篇钩子 / 沉浸感」信号</MiniEmpty>
              )}
            </section>
          </div>
        </div>

        {/* ── Inspector:创作健康度(Meter 密集)+ 变现就绪度 ── */}
        <aside className="cj-inspector ins-inspector">
          <div className="cj-pane-scroll ins-insp-scroll">
            <section className="card ins-health">
              <div className="card-head" style={{ marginBottom: 12 }}>
                <div className="card-title"><Gauge size={14} className="ins-card-ic" /> 创作健康度</div>
                <span className="ins-radar-chip"><Radar size={11} /> {opCount} 个机会</span>
              </div>
              <div className="ins-health-meters">
                {healthRows.map((g) => (
                  <div className="ins-health-row" key={g.key}>
                    <Meter
                      label={g.label}
                      value={g.value}
                      max={100}
                      threshold={g.threshold}
                      tone={g.tone}
                    />
                    <span className="ins-health-sub">{g.sub}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* 焦点统计:hero 里那行总评下沉为一组紧凑读数 */}
            <section className="card ins-focus">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-title"><BookOpen size={14} className="ins-card-ic" /> 本书速览</div>
              </div>
              <div className="ins-focus-grid">
                <span className="ins-focus-cell">
                  <i>累计字数</i>
                  <b className="num">{fmt(active?.totalWords)}</b>
                </span>
                <span className="ins-focus-cell">
                  <i>已写章节</i>
                  <b className="num">{fmt(writtenCh)}<em>章</em></b>
                </span>
                <span className="ins-focus-cell">
                  <i>平均张力</i>
                  <b className="num">{avgTension || "—"}<em>/100</em></b>
                </span>
                <span className="ins-focus-cell">
                  <i>愿意追更</i>
                  <b className="num" style={{ color: willFollowPct != null && willFollowPct >= 60 ? "var(--ok-600, var(--ok-500))" : undefined }}>
                    {willFollowPct ?? "—"}<em>%</em>
                  </b>
                </span>
              </div>
            </section>

            {/* 变现就绪度:把真实评分转成单一、可行动的上架/适配判断,不编收益 */}
            <FoldCard
              title={readiness.state === "ready" ? "已具备变现底子" : readiness.state === "gap" ? "离能变现还差什么" : "变现就绪度"}
              icon={<Target size={14} />}
              defaultOpen
              className={`ins-ready ${readiness.state}`}
            >
              <div className="ins-ready-body">
                <p className="mon-line">{readiness.line}</p>
                {readiness.state === "gap" && readiness.gaps ? (
                  <ul className="mon-gaps">
                    {readiness.gaps.map((g, i) => (
                      <li key={g.key} className={i === 0 ? "is-key" : ""}>
                        <span className="mon-gap-body">
                          <span className="mon-gap-label">{g.label}</span>
                          <span className="mon-gap-tip">{g.tip}</span>
                        </span>
                        {i === 0 ? (
                          <button type="button" className="mon-gap-cta" onClick={() => g.href.startsWith("#") ? document.querySelector(g.href)?.scrollIntoView({ behavior: "smooth", block: "start" }) : router.push(g.href)}>{g.cta} <ArrowUpRight size={11} /></button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {readiness.state === "ready" && readiness.top ? (
                  <button type="button" className="mon-ready-cta" onClick={() => actOnOpportunity(readiness.top!)}>
                    <Sparkles size={12} /> 把成品推向「{cleanTitle(readiness.top.title.zh)}」
                  </button>
                ) : null}
              </div>
            </FoldCard>
          </div>
        </aside>
      </div>
    </div>
  )
}
