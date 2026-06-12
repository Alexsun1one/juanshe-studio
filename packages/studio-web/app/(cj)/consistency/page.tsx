"use client"

import * as React from "react"
import useSWR from "swr"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, FileWarning, ShieldCheck, Wrench } from "lucide-react"
import { toast } from "sonner"
import { fetchChapters, fetchQuality, repairLowScore, startRepairQualityBatch } from "@/lib/api/client"
import type { QualityMetrics } from "@/lib/api/types"
import { useWorkspace } from "@/lib/workspace-context"
import { blockerLabel, blockerLabels } from "@/lib/blocker-labels"
import { CjPlaceholder } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { bandLabel } from "@/lib/labels"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import "./consistency.css"

const soft = { shouldRetryOnError: false }
// 扫描范围:挂机连写几十章后,「最近 6」看不全欠债清单 —— 给分段切换,「全部」分批拉不打爆后端
type ScanRange = 6 | 20 | "all"
const SCAN_RANGES: { key: ScanRange; label: string }[] = [
  { key: 6, label: "最近 6" },
  { key: 20, label: "最近 20" },
  { key: "all", label: "全部" },
]
const DIMS: { key: keyof QualityMetrics; label: string }[] = [
  { key: "consistency", label: "一致性" },
  { key: "pacing", label: "节奏" },
  { key: "emotion", label: "情感" },
  { key: "diction", label: "文笔" },
]

type Scan = { num: number; title: string; q: QualityMetrics | null }

function scoreOf(q: QualityMetrics) {
  return Math.round(q.total ?? q.overall ?? 0)
}

function qualityPrompt(scan: Scan) {
  const q = scan.q
  if (!q) {
    return [
      `请为第 ${scan.num} 章《${scan.title}》补做质量报告。`,
      "",
      "要求:",
      "- 检查连续性、节奏、情感、文笔四项。",
      "- 列出阻塞项、责任 Agent、修复建议。",
      "- 给出是否通过质量门禁的明确结论。",
    ].join("\n")
  }

  const blockers = q.gate?.blockers?.length ? blockerLabels(q.gate.blockers).join("；") : "无阻塞项"
  const dims = DIMS.map(({ key, label }) => `${label}:${Math.round(Number(q[key] ?? 0))}`).join(" / ")
  return [
    `请修复第 ${scan.num} 章《${scan.title}》的质量问题。`,
    "",
    `当前总分:${scoreOf(q)}/100`,
    `目标门禁:${q.gate?.target ?? 85}`,
    `门禁状态:${q.gate?.pass ? "通过" : "未通过"}`,
    `维度:${dims}`,
    `阻塞项:${blockers}`,
    q.gate?.rule ? `门禁规则:${q.gate.rule}` : "",
    q.gate?.repairStrategy ? `建议策略:${q.gate.repairStrategy}` : "",
    "",
    "修复要求:",
    "- 只修本章,不要回滚后续章节。",
    "- 优先处理阻塞项,其次拉齐最低维度。",
    "- 修完后重新生成质量报告并复核门禁。",
  ].filter(Boolean).join("\n")
}

export default function ConsistencyPage() {
  const { books, bookId, booksLoading } = useWorkspace()
  const router = useRouter()
  const active = books.find((b) => b.id === bookId)
  const { data: chapters } = useSWR(bookId ? ["chapters", bookId] : null, () => fetchChapters(bookId), soft)

  const [scanRange, setScanRange] = React.useState<ScanRange>(6)
  const recent = React.useMemo(() => {
    const list = chapters ?? []
    return (scanRange === "all" ? [...list] : list.slice(-scanRange)).reverse()
  }, [chapters, scanRange])
  const { data: scans, isLoading } = useSWR<Scan[]>(
    bookId && recent.length ? ["qscans", bookId, scanRange, recent.map((c) => c.num).join(",")] : null,
    async () => {
      // 按章并发但分批(每批 10 章):「全部」对 200+ 章的书也不会一次打爆后端;单章失败不拖垮整批
      const out: Scan[] = []
      for (let i = 0; i < recent.length; i += 10) {
        const batch = recent.slice(i, i + 10)
        out.push(...(await Promise.all(batch.map((c) =>
          fetchQuality(bookId, c.num).then((q) => ({ num: c.num, title: c.title.zh, q })).catch(() => ({ num: c.num, title: c.title.zh, q: null }))))))
      }
      return out
    },
    soft,
  )

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="一致性扫描" sub="本地工作区还没有作品,创建后这里会出现按章的一致性与质量门禁扫描。" />
  }

  const scanRows = scans ?? []
  const rows = scanRows.filter((s): s is Scan & { q: QualityMetrics } => Boolean(s.q))
  const missingRows = scanRows.filter((s) => !s.q)
  const missing = missingRows.length
  const scores = rows.map((s) => scoreOf(s.q)).filter((n) => n > 0)
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
  const passed = rows.filter((s) => s.q.gate?.pass).length
  const issueCount = rows.reduce((n, s) => n + (s.q.gate?.blockers?.length ?? 0), missing)
  const dash = Math.round((avg / 100) * 264)
  const band = !rows.length ? "待扫描" : avg >= 90 ? "优秀" : avg >= 85 ? "稳" : avg >= 70 ? "良好" : "待提升"

  // 「能不能上架」一句话信心判读:把已扫描的真实门禁结果转成单一可行动结论,不编任何数字。
  const allScanned = scanRows.length > 0 && missing === 0
  const blocked = rows.filter((s) => !s.q.gate?.pass)
  const ready = allScanned && rows.length > 0 && blocked.length === 0
  const confidence: { tone: "ok" | "warn" | "muted"; line: string } = !rows.length
    ? { tone: "muted", line: "还没有可读的章节质量报告。补做后,这里会判断这本离能稳定上架/适配平台还差哪几章。" }
    : ready
      ? { tone: "ok", line: `${scanRange === "all" ? "全书" : "最近"} ${rows.length} 章全部过 ${rows[0].q.gate?.target ?? 85} 门禁 — 连贯度扛得住平台读者,这批已具备上架信心。` }
      : { tone: "warn", line: `还有 ${blocked.length} 章卡在门禁线下,先把它们推到达标,成品才稳得住追读与变现。` }

  // 最该先修的一章:卡门禁里分数最低的那章(只读真实分,不排已通过/缺失章)
  const worst = blocked.length
    ? [...blocked].sort((a, b) => scoreOf(a.q) - scoreOf(b.q))[0]
    : null

  const copyPrompt = async (scan: Scan) => {
    try {
      await navigator.clipboard.writeText(qualityPrompt(scan))
      toast.success(`已复制第 ${scan.num} 章质量提示`)
    } catch {
      toast.error("复制失败,请手动选择文本复制")
    }
  }

  // 上架闸里就地一键复修:点哪章修哪章,不必跳别处或手动喂提示词。
  // 会触发真实写作流水线(耗 token);后端自带防重复 + 熔断,UI 侧一次只允许一章在修,避免并发烧 token。
  const [repairing, setRepairing] = React.useState<number | null>(null)
  const onRepair = async (scan: Scan & { q: QualityMetrics }) => {
    if (!bookId || repairing !== null) return
    setRepairing(scan.num)
    try {
      await repairLowScore(bookId, scan.num, { targetScore: scan.q.gate?.target })
      toast.success(`已派修稿师复修第 ${scan.num} 章…`, {
        description: "复修后自动复验质量;过一会儿回来刷新看新分。",
      })
    } catch (e) {
      toast.error(`复修触发失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRepairing(null)
    }
  }

  // 按严重度分组:卡门禁(最该动手)→ 已达标(轻量收束)→ 报告缺失(补做)。组内保持新章在前。
  const failRows = rows.filter((s) => !s.q.gate?.pass)
  const passRows = rows.filter((s) => s.q.gate?.pass)

  // 一键批量复修:兑现工作台无人值守承诺的「事后批量重修」—— 取待修章号区间走 repair-quality-batch。
  // 这是全站最烧 token 的操作:必须先弹确认列清章数/区间/门槛;区间内已达标章后端会按分数自动跳过。
  const failNums = failRows.map((s) => s.num)
  const batchFrom = failNums.length ? Math.min(...failNums) : 0
  const batchTo = failNums.length ? Math.max(...failNums) : 0
  const batchTarget = failRows[0]?.q.gate?.target ?? 85
  const batchSpansPassed = batchTo - batchFrom + 1 > failNums.length
  const [batchConfirm, setBatchConfirm] = React.useState(false)
  const [batchBusy, setBatchBusy] = React.useState(false)
  const onBatchRepair = async () => {
    if (!bookId || batchBusy || !failNums.length) return
    setBatchBusy(true)
    try {
      await startRepairQualityBatch(bookId, { fromChapter: batchFrom, toChapter: batchTo, targetScore: batchTarget })
      setBatchConfirm(false)
      toast.success(`已开始批量复修第 ${batchFrom}–${batchTo} 章`, {
        description: `逐章修到 ${batchTarget} 分门槛,已达标章自动跳过;修完自动复验,回来刷新看新分。`,
        action: { label: "去运行台", onClick: () => router.push("/runs") },
      })
    } catch (e) {
      toast.error(`批量复修触发失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBatchBusy(false)
    }
  }

  const renderFail = (s: Scan & { q: QualityMetrics }, isWorst: boolean) => {
    const q = s.q
    const sc = scoreOf(q)
    const sev = sc >= 70 ? "warn" : "err"
    const blockers = q.gate?.blockers ?? []
    return (
      <div className={`issue ${sev}${isWorst ? " is-worst" : ""}`} key={s.num}>
        <span className="sev" />
        <div className="im">
          <div className="it">
            <AlertTriangle size={14} className="it-ico" />
            <span className="it-ch">第 {s.num} 章</span>
            <span className="it-title">{s.title}</span>
            {isWorst && <span className="it-flag">先修这章</span>}
            <span className="pill" data-state="warn"><span className="dot" />门禁 {q.gate?.target ?? 85}</span>
          </div>
          {blockers.length > 0
            ? <div className="blk">{blockers.map((b, i) => <span className="tag warn" key={i}>{blockerLabel(b)}</span>)}</div>
            : <div className="id">未过门禁,但无具名阻塞项 — 拉齐下方最低维度即可达标。</div>}
          {q.gate?.repairStrategy && <div className="gate-note">修复策略 · {q.gate.repairStrategy}</div>}
          <div className="dims">
            {DIMS.map(({ key, label }) => {
              const v = Math.round(Number(q[key] ?? 0))
              return <div className="dim" key={key}><div className="dl"><span>{label}</span><span className="dv">{v}</span></div><div className="bar"><i className={v < 80 ? "low" : ""} style={{ width: `${v}%` }} /></div></div>
            })}
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="btn sm primary"
              onClick={() => onRepair(s)}
              disabled={repairing !== null}
              title={`派修稿师把第 ${s.num} 章复修到 ${q.gate?.target ?? 85} 分门槛 —— 会调用写作流水线、消耗 token`}
            >
              <Wrench size={12} /> {repairing === s.num ? "复修中…" : "修复本章"}
            </button>
            <Link className="btn sm" href={`/editor?chapter=${s.num}`}><ExternalLink size={12} /> 打开章节</Link>
            <button type="button" className="btn sm" onClick={() => copyPrompt(s)}><Copy size={12} /> 复制提示词</button>
          </div>
        </div>
        <div className="right">
          <div className="sc warn">{sc || "—"}</div>
          <div className="ch">{bandLabel(q.band)}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="page cj-consistency">
      <div className="consistency-head">
        <span className="head-eyebrow">上架前最后一道连贯关</span>
        <div className="page-title-row">
          <PixelBadge kind="detect" size={28} className="page-title-pixel" ariaLabel="一致性扫描" />
          <h1 className="page-title">一致性扫描</h1>
        </div>
        <div className="head-sub-row">
          <span className="head-sub">《{active?.title.zh ?? "—"}》{scanRange === "all" ? `全部 ${recent.length}` : `最近 ${recent.length}`} 章质量门禁逐章扫描</span>
          <div className="con-range" role="tablist" aria-label="扫描范围">
            {SCAN_RANGES.map((r) => (
              <button
                key={String(r.key)}
                type="button"
                role="tab"
                aria-selected={scanRange === r.key}
                className={scanRange === r.key ? "on" : ""}
                onClick={() => setScanRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 焦点带:综合评分环 + 「能不能上架」一句话信心判读(可爱像素点睛,数据原地呈现) */}
      <section className="con-hero">
        <span className="con-ring">
          <svg viewBox="0 0 100 100"><circle className="track" cx="50" cy="50" r="42" strokeWidth="7.5" fill="none" /><circle className="prog" cx="50" cy="50" r="42" strokeWidth="7.5" fill="none" strokeDasharray={`${dash} 264`} strokeLinecap="round" /></svg>
          <span className="t"><span className="big">{avg || "—"}</span><span className="sm">/ 100</span></span>
        </span>
        <div className="con-hero-body">
          <p className="con-hero-line">
            综合一致性评分
            <span className={`con-grade ${avg >= 85 ? "ok" : avg >= 70 ? "brand" : avg > 0 ? "warn" : "muted"}`}>{band}</span>
          </p>
          <p className={`con-conf ${confidence.tone}`}>
            <ShieldCheck size={13} />{confidence.line}
          </p>
          <p className="con-hero-stats">
            <span>已扫描 <b className="num">{rows.length}</b><i>/{recent.length} 章</i></span>
            <span className="sep" aria-hidden />
            <span className={recent.length && passed === recent.length ? "ok" : undefined}>通过门禁 <b className="num">{passed}</b><i>/{recent.length}</i></span>
            <span className="sep" aria-hidden />
            <span className={issueCount ? "warn" : "ok"}>待处理 <b className="num">{issueCount}</b><i> 项</i></span>
          </p>
        </div>
        <AgentPixel id="setup-auditor" size={50} className="con-hero-pix" ariaLabel="一致性审校" />
      </section>

      {isLoading && (
        <>
          <div className="skel" style={{ height: 14, width: 120, marginBottom: 14 }} />
          <div className="skel" style={{ height: 120, marginBottom: 10, borderRadius: "var(--r-lg)" }} />
          <div className="skel" style={{ height: 120, borderRadius: "var(--r-lg)" }} />
        </>
      )}

      {!isLoading && scanRows.length === 0 && (
        <div className="con-empty">
          <AgentPixel id="setup-auditor" size={44} ariaLabel="一致性审校" />
          <p>暂无可扫描的章节质量数据。<br />写出几章并完成评分后,这里会按严重度逐章列出连贯隐患与门禁结论。</p>
        </div>
      )}

      {/* 卡门禁的章节:最该动手,放最前并给最重的视觉权重;批量复修是这组的主动线 */}
      {!isLoading && failRows.length > 0 && (
        <section className="con-group">
          <h3 className="sh sev-warn">
            需修复 <span className="c">{failRows.length} 章</span><span className="sh-hint">未过门禁 · 修完即可纳入可上架批次</span>
            <button
              type="button"
              className="btn sm primary sh-act"
              onClick={() => setBatchConfirm(true)}
              disabled={batchBusy || repairing !== null}
              title={`派修稿师把这 ${failRows.length} 章逐章复修到 ${batchTarget} 分门槛 —— 会调用写作流水线、消耗 token`}
            >
              <Wrench size={12} /> {batchBusy ? "派工中…" : `一键复修这 ${failRows.length} 章`}
            </button>
          </h3>
          <div className="issue-list">
            {failRows.map((s) => renderFail(s, worst != null && s.num === worst.num))}
          </div>
        </section>
      )}

      {/* 报告缺失:补做即可纳入平均分,轻量行不抢戏 */}
      {!isLoading && missingRows.length > 0 && (
        <section className="con-group">
          <h3 className="sh sev-muted">报告缺失 <span className="c">{missingRows.length} 章</span><span className="sh-hint">无法纳入平均分 · 先补做质量报告</span></h3>
          <div className="lite-list">
            {missingRows.map((s) => (
              <div className="lite-row missing" key={s.num}>
                <FileWarning size={14} className="lite-ico" />
                <span className="lite-ch">第 {s.num} 章</span>
                <span className="lite-title">{s.title}</span>
                <span className="lite-state">报告缺失</span>
                <div className="lite-acts">
                  <Link className="ic" href={`/editor?chapter=${s.num}`} title="打开章节"><ExternalLink size={13} /></Link>
                  <button type="button" className="ic" onClick={() => copyPrompt(s)} title="复制补报告提示"><Copy size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 已达标:这批是放心的,轻量收束,为进展庆祝而不堆卡 */}
      {!isLoading && passRows.length > 0 && (
        <section className="con-group">
          <h3 className="sh sev-ok">已达标 <span className="c">{passRows.length} 章</span><span className="sh-hint">连贯无阻塞 · 已具备上架信心</span></h3>
          <div className="lite-list">
            {passRows.map((s) => {
              const sc = scoreOf(s.q)
              return (
                <Link className="lite-row ok" href={`/editor?chapter=${s.num}`} key={s.num} title="打开章节">
                  <CheckCircle2 size={14} className="lite-ico ok" />
                  <span className="lite-ch">第 {s.num} 章</span>
                  <span className="lite-title">{s.title}</span>
                  <span className="lite-band">{bandLabel(s.q.band)}</span>
                  <span className="lite-score">{sc || "—"}</span>
                </Link>
              )
            })}
          </div>
        </section>
      )}

      {/* 批量复修确认:guardrail 文案沿用工作台模式 —— 列清范围/门槛/token 代价,界面检查时保持当前状态 */}
      <AlertDialog open={batchConfirm} onOpenChange={(open) => { if (!open) setBatchConfirm(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>批量复修 {failRows.length} 章到 {batchTarget} 分？</AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>这会启动质量复修流水线,从第 {batchFrom} 章修到第 {batchTo} 章,逐章复修并自动复验;每章都可能消耗 LLM token 并更新稿件文件。</span>
              <span className="border-border bg-secondary text-foreground/80 rounded-md border px-3 py-2 font-mono text-[11px] leading-relaxed">
                《{active?.title.zh ?? "—"}》 · 待修 {failRows.length} 章 · 区间 第 {batchFrom}–{batchTo} 章 · 门槛 {batchTarget} 分
              </span>
              <span>{batchSpansPassed ? "区间内已达标的章会按分数自动跳过,只修没过门禁的。" : ""}修不到门槛不硬放行,会停在那一章等你处置。只做界面检查时请保持当前状态。</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={batchBusy}>保持当前状态</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={batchBusy}
              onClick={(event) => {
                event.preventDefault()
                void onBatchRepair()
              }}
            >
              确认复修 {failRows.length} 章
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
