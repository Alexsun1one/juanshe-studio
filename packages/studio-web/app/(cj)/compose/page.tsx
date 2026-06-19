"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  ArrowRight,
  Check,
  Copy,
  FileText,
  Gauge,
  GripVertical,
  Hash,
  Layers,
  Loader2,
  PenLine,
  Ruler,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react"
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
import { PlatformPreview } from "@/components/studio/platform-preview"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"

import "./compose.css"

type Platform = { id: string; name: string; logo: string; grad: string; len: string; desc: string }
const PLATFORMS: Platform[] = [
  { id: "wechat_article", name: "公众号", logo: "公", grad: "linear-gradient(135deg,#07C160,#3FD394)", len: "1500–5000 字", desc: "深度 / 观点 / 故事长文:选题 → 角度 → 资料 → 精排。" },
  { id: "xiaohongshu_note", name: "小红书", logo: "红", grad: "linear-gradient(135deg,#FF2442,#FF6E8A)", len: "200–1000 字", desc: "强痛点标题、前 3 行抓人、短段、可收藏、话题标签。" },
  { id: "zhihu_answer", name: "知乎", logo: "知", grad: "linear-gradient(135deg,#0084FF,#5FA0F0)", len: "800–4000 字", desc: "问题导向、论证充分、案例与可信度优先。" },
  { id: "x_thread", name: "X / Twitter", logo: "X", grad: "linear-gradient(135deg,#1D1D1F,#555)", len: "100–1500 字", desc: "强 hook、短句、每条独立可读、结尾行动。" },
  { id: "newsletter", name: "Newsletter", logo: "N", grad: "linear-gradient(135deg,#6E5BFA,#9D8AFF)", len: "1000–3500 字", desc: "邮件订阅长文/专栏信,首屏摘要、短段、轻 CTA,沉淀私域读者。" },
]

type ContentDraft = { id: string; contentType: string; platformLabel: string; title: string; finalScore?: number | null; revised?: boolean; chars?: number; createdAt?: string; excerpt?: string; markdown?: string }

export default function ComposePage() {
  const [sel, setSel] = React.useState<Platform>(PLATFORMS[0])
  const [brief, setBrief] = React.useState("")
  const [voice, setVoice] = React.useState("")
  // 刷新/重连导致页面 remount 时,把酝酿很久的选题/口吻找回来(存 sessionStorage),别让人白写一遍。
  React.useEffect(() => {
    try {
      const b = sessionStorage.getItem("cj.compose.brief")
      const v = sessionStorage.getItem("cj.compose.voice")
      if (b) setBrief(b)
      if (v) setVoice(v)
    } catch { /* 隐私模式等忽略 */ }
  }, [])
  React.useEffect(() => {
    try { sessionStorage.setItem("cj.compose.brief", brief) } catch { /* ignore */ }
  }, [brief])
  React.useEffect(() => {
    try { sessionStorage.setItem("cj.compose.voice", voice) } catch { /* ignore */ }
  }, [voice])
  const [revise, setRevise] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<{ content: string; score?: number; revised?: boolean } | null>(null)
  const [drafts, setDrafts] = React.useState<ContentDraft[]>([])
  const [order, setOrder] = React.useState<string[]>(() => PLATFORMS.map((p) => p.id))
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [confirmGenerateOpen, setConfirmGenerateOpen] = React.useState(false)

  // 平台卡片顺序:个人偏好(把常用平台拖到前面),本地持久化
  React.useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("autow:compose-order") || "null")
      if (Array.isArray(saved)) {
        const known = PLATFORMS.map((p) => p.id)
        const merged = [...saved.filter((id): id is string => typeof id === "string" && known.includes(id)), ...known.filter((id) => !saved.includes(id))]
        setOrder(merged)
      }
    } catch {
      /* 无持久化顺序则用默认 */
    }
  }, [])

  const orderedPlatforms = React.useMemo(
    () => order.map((id) => PLATFORMS.find((p) => p.id === id)).filter((p): p is Platform => Boolean(p)),
    [order],
  )

  const dropOn = (targetId: string) => {
    setDragId((dragging) => {
      if (dragging && dragging !== targetId) {
        setOrder((prev) => {
          const next = prev.filter((id) => id !== dragging)
          const idx = next.indexOf(targetId)
          next.splice(idx < 0 ? next.length : idx, 0, dragging)
          try { localStorage.setItem("autow:compose-order", JSON.stringify(next)) } catch { /* ignore */ }
          return next
        })
      }
      return null
    })
  }

  const loadDrafts = React.useCallback(async () => {
    try {
      const r = await fetch("/api/v1/content-drafts")
      const d = await r.json().catch(() => ({}))
      setDrafts(Array.isArray(d.drafts) ? d.drafts : [])
    } catch {
      /* 空库不报错 */
    }
  }, [])

  React.useEffect(() => { void loadDrafts() }, [loadDrafts])

  const draftTitle = (d: ContentDraft) => {
    const h = d.markdown?.match(/^#{1,3}\s+(.+)$/m)
    if (h?.[1]) return h[1].trim().slice(0, 42)
    const firstLine = (d.markdown || "").split("\n").map((s) => s.trim()).find(Boolean)
    if (firstLine) return firstLine.replace(/^#+\s*/, "").replace(/^[>*-]\s*/, "").slice(0, 42)
    return (d.title || "(无标题)").slice(0, 42)
  }

  const openDraft = (d: ContentDraft) => {
    const p = PLATFORMS.find((x) => x.id === d.contentType)
    if (p) setSel(p)
    setResult({ content: d.markdown || d.excerpt || "", score: typeof d.finalScore === "number" ? d.finalScore : undefined, revised: Boolean(d.revised) })
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const generate = async () => {
    if (!brief.trim()) { toast.error("请填写选题 / 要求"); return }
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`/api/v1/content-type/${encodeURIComponent(sel.id)}/write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief: brief.trim(), accountVoice: voice.trim() || undefined, revise }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error?.message || `生成失败 (${res.status})`)
      const content = String(data.content ?? data.markdown ?? data.article ?? data.text ?? data.draft ?? "")
      const score = data.critique?.score ?? data.score ?? data.quality?.score
      if (!content) throw new Error("后端未返回正文")
      setResult({ content, score: typeof score === "number" ? score : undefined, revised: Boolean(data.revised) })
      toast.success(`已生成${data.revised ? " · 经评审修订" : ""}·已入库`)
      void loadDrafts()
    } catch (e) {
      toast.error(`生成失败:${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const requestGenerate = () => {
    if (!brief.trim()) {
      toast.error("请填写选题 / 要求")
      return
    }
    setConfirmGenerateOpen(true)
  }

  const writeClipboard = async (text: string, ok: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(ok)
    } catch {
      toast.error("复制失败,请手动选择文本复制")
    }
  }
  const copy = () => { if (result) void writeClipboard(result.content, "已复制 Markdown") }
  // 一键导出纯文本(去 markdown 标记)——直接粘进公众号/小红书编辑器即用。
  const copyPlain = () => {
    if (!result) return
    const plain = result.content
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*>\s+/gm, "")
      .replace(/^\s*[-*]\s+/gm, "· ")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    void writeClipboard(plain, "已复制纯文本 · 可直接粘进平台编辑器")
  }

  // 焦点条用的真实派生量(只读已有数据,不编造)——成品库规模 + 已覆盖了几个目标平台
  const draftCount = drafts.length
  const coveredPlatforms = React.useMemo(() => {
    const ids = new Set(drafts.map((d) => d.contentType).filter(Boolean))
    return PLATFORMS.filter((p) => ids.has(p.id)).length
  }, [drafts])
  // 每个平台已沉淀几篇成品(只读已有数据)——给 Inspector 平台覆盖清单用
  const draftsByPlatform = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const d of drafts) {
      if (!d.contentType) continue
      map.set(d.contentType, (map.get(d.contentType) ?? 0) + 1)
    }
    return map
  }, [drafts])
  // 当前平台已生成成品(只读已有数据)——给 Inspector 成品库折叠卡用
  const draftsForSel = React.useMemo(
    () => drafts.filter((d) => d.contentType === sel.id),
    [drafts, sel.id],
  )
  // 一行「下一步」:把当前最该做的一步说清楚(降焦虑、指向变现),只判断真实状态
  const nextStep = !brief.trim()
    ? `先给「${sel.name}」一个选题,一键就能出可发布成品`
    : !result
      ? `选题已就绪 — 点「生成」让 AI 编辑部产出可发布的「${sel.name}」成品`
      : `成品已就绪 — 复制正文/Markdown 粘进${sel.name}即可发布,或换个平台再产一篇`

  return (
    <div className="cj-screen cj-compose">
      {/* ── 顶部工作条:像素 + 标题 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead cmp-head">
        <div className="cmp-headline">
          <PixelBadge kind="platform" size={44} className="cmp-hero-pixel" ariaLabel="内容工坊 · 多平台创作" />
          <div className="cmp-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">内容工坊 · 多平台创作</h1>
            </div>
            <div className="page-sub">
              为每个平台定制选题→写作→评审→适配,一步产出可直接发布的成品并落进成品库。
            </div>
          </div>
          <button type="button" className="btn primary cmp-head-cta" onClick={requestGenerate} disabled={busy}>
            {busy ? <Loader2 size={14} className="cmp-spin" /> : <Sparkles size={14} />}
            生成「{sel.name}」成品
          </button>
        </div>
        <div className="cmp-kpis" role="group" aria-label="创作概览">
          <KpiChip label="目标平台" value={PLATFORMS.length} unit="个" tone="brand" hint="公众号 / 小红书 / 知乎 / X / Newsletter" />
          <KpiChip label="已生成成品" value={draftCount} unit="篇" tone={draftCount > 0 ? "ok" : "neutral"} hint="成品库累计落盘篇数" />
          <KpiChip
            label="已覆盖平台"
            value={coveredPlatforms}
            unit={`/ ${PLATFORMS.length}`}
            tone={coveredPlatforms > 0 ? "info" : "neutral"}
            sub={<StatLine items={[{ n: PLATFORMS.length - coveredPlatforms, label: "个待开" }]} />}
          />
          <KpiChip label="当前体裁" value={sel.name} tone="amber" hint="当前正在产出的平台体裁" />
          <KpiChip label="目标字数" value={sel.len} tone="neutral" sub={<StatLine items={[{ n: revise ? "评审修订" : "直出", label: "模式", tone: revise ? "ok" : "neutral" }]} />} />
        </div>
      </header>

      {/* ── 主体:创作主区(选材 → 表单 → 预览,pane 内滚) + 成品库 Inspector ── */}
      <div className="cj-screen-body cmp-body">
        <div className="cj-mainpane cmp-mainpane">
          <div className="cj-pane-scroll cmp-pane-scroll">
            {/* 下一步引导:把「现在最该做的一步」说清楚,降低创作焦虑 */}
            <button type="button" className="cmp-next" onClick={requestGenerate} disabled={busy}>
              <span className="cmp-next-pin"><Sparkles size={13} /></span>
              <span className="cmp-next-text">下一步 · {nextStep}</span>
              <span className="cmp-next-cta">{result ? "再产一篇" : "去生成"} <ArrowRight size={13} /></span>
            </button>

            <h3 className="cmp-sec">
              <Layers size={13} className="cmp-sec-ico" aria-hidden />
              选平台体裁
              <span className="hint"><GripVertical size={11} aria-hidden /> 拖动排序 · 把常用平台放前面</span>
            </h3>
            <div className="plat-grid">
              {orderedPlatforms.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`plat${sel.id === p.id ? " sel" : ""}${dragId === p.id ? " dragging" : ""}`}
                  draggable
                  aria-pressed={sel.id === p.id}
                  onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = "move" }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); dropOn(p.id) }}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => setSel(p)}
                >
                  <span className="pt">
                    <span className="logo" style={{ background: p.grad }}>{p.logo}</span>
                    <span className="pt-text">
                      <span className="pn">{p.name}</span>
                      <span className="plen"><Ruler size={9} aria-hidden /> {p.len}</span>
                    </span>
                    {draftsByPlatform.get(p.id) ? (
                      <span className="pcount" title={`已沉淀 ${draftsByPlatform.get(p.id)} 篇成品`}>
                        <FileText size={9} aria-hidden />{draftsByPlatform.get(p.id)}
                      </span>
                    ) : null}
                  </span>
                  <span className="pd">{p.desc}</span>
                </button>
              ))}
            </div>

            <div className="work">
              <div className="form-col">
                <div className="fld">
                  <label>
                    <PenLine size={12} aria-hidden /> 选题 / 要求 <span className="fld-req" aria-hidden>*</span>
                  </label>
                  <textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={`描述你想写的内容主题、角度、受众…\n例如:35 岁职场人如何应对 AI 焦虑,要有真实案例和可落地建议。`} />
                </div>
                <div className="fld">
                  <label><Target size={12} aria-hidden /> 账号语气(可选)</label>
                  <input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="例如:过来人认真聊、克制不煽情" />
                </div>
                <div className="opts">
                  <button type="button" className={`toggle${revise ? " on" : ""}`} role="switch" aria-checked={revise} onClick={() => setRevise((r) => !r)} aria-label={revise ? "关闭评审修订" : "开启评审修订"} />
                  <span className="opts-text"><ShieldCheck size={12} aria-hidden /> 生成→评审→修订(更高质量,更慢)</span>
                </div>
                <button type="button" className={`btn primary gen-btn${busy ? " is-loading" : ""}`} onClick={requestGenerate} disabled={busy}>
                  {busy ? <Loader2 size={15} className="cmp-spin" /> : <Sparkles size={15} />} 生成「{sel.name}」成品
                </button>
              </div>

              <div className="result">
                <div className="result-head">
                  <span className="rt"><FileText size={13} aria-hidden /> {sel.name} · 所见即所得预览</span>
                  {result && <div className="ra">
                    <button type="button" className="btn sm" onClick={copyPlain}><FileText size={12} /> 复制正文</button>
                    <button type="button" className="btn sm" onClick={copy}><Copy size={12} /> Markdown</button>
                  </div>}
                </div>
                {busy ? (
                  <div className="gen-loading">
                    <AgentPixel id="style-fingerprint" size={44} className="gen-loading-pix" ariaLabel="AI 编辑部" />
                    <div className="spin" />
                    <div>AI 编辑部创作中…{revise ? "(含评审修订,请稍候)" : ""}</div>
                  </div>
                ) : result ? (
                  <>
                    <div className="result-body"><PlatformPreview platform={sel.id} markdown={result.content} /></div>
                    <div className="crit">
                      {result.score != null && (
                        <span className="crit-score">
                          <span className="sc" style={{ color: result.score >= 85 ? "var(--ok-500)" : result.score >= 70 ? "var(--brand-600)" : "var(--warn-500)" }}>{result.score}</span>
                          <span className="crit-score-label"><Gauge size={11} aria-hidden /> 评审评分</span>
                        </span>
                      )}
                      {result.revised && <span className="pill" data-state="success"><Check size={11} /> 已评审修订</span>}
                      <span className="crit-chars"><Hash size={11} aria-hidden /><span className="num">{result.content.replace(/\s/g, "").length}</span> 字</span>
                    </div>
                  </>
                ) : (
                  <div className="gen-empty">
                    <AgentPixel id="style-fingerprint" size={48} className="gen-empty-pix" ariaLabel="AI 编辑部" />
                    <div className="gen-empty-t">这里会出现可直接发布的「{sel.name}」成品</div>
                    <div className="gen-empty-s">选好平台、填好选题,点「生成」—— AI 编辑部产出后,在这里复制就能拿去发布。</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Inspector:成品库(覆盖进度 + 平台清单 + 当前平台成品 + 全部成品)── */}
        <aside className="cj-inspector cmp-inspector">
          <div className="cj-pane-scroll cmp-insp-scroll">
            <section className="card cmp-overview">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-title">成品库概览</div>
                <span className="cmp-overview-tag"><FileText size={11} aria-hidden />{draftCount} 篇</span>
              </div>
              <div className="cmp-meters">
                <Meter
                  label="平台覆盖率"
                  value={coveredPlatforms}
                  max={PLATFORMS.length}
                  tone="brand"
                  showValue={false}
                />
                <div className="cmp-meter-cap">
                  <span className="num">{coveredPlatforms}</span>
                  <span className="cmp-meter-of">/{PLATFORMS.length} 平台已开张</span>
                  <span className="cmp-meter-pct">{Math.round((coveredPlatforms / PLATFORMS.length) * 100)}%</span>
                </div>
              </div>
              <div className="cmp-statgrid">
                <span className="cmp-stat" data-tone="ok">
                  <b className="num">{draftCount}</b>
                  <i>已生成</i>
                </span>
                <span className="cmp-stat" data-tone="info">
                  <b className="num">{coveredPlatforms}</b>
                  <i>已覆盖</i>
                </span>
                <span className="cmp-stat" data-tone="warn">
                  <b className="num">{PLATFORMS.length - coveredPlatforms}</b>
                  <i>待开张</i>
                </span>
              </div>
            </section>

            <FoldCard
              title="平台清单"
              icon={<Layers size={14} />}
              count={`${coveredPlatforms}/${PLATFORMS.length}`}
              defaultOpen
            >
              <div className="cmp-plat-list">
                {orderedPlatforms.map((p) => {
                  const n = draftsByPlatform.get(p.id) ?? 0
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`cmp-plat-row${sel.id === p.id ? " active" : ""}`}
                      onClick={() => setSel(p)}
                      title={`切到「${p.name}」· ${p.len}`}
                    >
                      <span className="cmp-plat-logo" style={{ background: p.grad }}>{p.logo}</span>
                      <span className="cmp-plat-body">
                        <span className="cmp-plat-name">{p.name}</span>
                        <span className="cmp-plat-len"><Ruler size={9} aria-hidden /> {p.len}</span>
                      </span>
                      {sel.id === p.id && <span className="cmp-plat-cur">当前</span>}
                      <span className="pill" data-state={n > 0 ? "success" : "pending"}>
                        <span className="dot" />
                        {n > 0 ? `${n} 篇` : "待开张"}
                      </span>
                    </button>
                  )
                })}
              </div>
            </FoldCard>

            {draftsForSel.length > 0 && (
              <FoldCard
                title={`${sel.name} · 成品`}
                icon={<FileText size={14} />}
                count={draftsForSel.length}
                defaultOpen
                scrollable={draftsForSel.length > 4}
                maxHeight={208}
              >
                <div className="cmp-draft-list">
                  {draftsForSel.map((d) => (
                    <button className="cmp-draft-row" key={d.id} onClick={() => openDraft(d)} type="button" title="打开 → 上方预览 → 复制取走发布">
                      <span className="cmp-draft-body">
                        <span className="cmp-draft-title">{draftTitle(d)}</span>
                        <span className="cmp-draft-meta">
                          <span className="num">{d.chars ?? 0}</span><em>字</em>
                          {d.createdAt ? (
                            <>
                              <span className="cmp-dot" aria-hidden />
                              <span>{new Date(d.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</span>
                            </>
                          ) : null}
                        </span>
                      </span>
                      {typeof d.finalScore === "number" && (
                        <span className="cmp-draft-sc" style={{ color: d.finalScore >= 85 ? "var(--ok-600, var(--ok-500))" : "var(--brand-600)" }}>{d.finalScore}</span>
                      )}
                    </button>
                  ))}
                </div>
              </FoldCard>
            )}

            {drafts.length > 0 && (
              <FoldCard
                title="全部成品"
                icon={<FileText size={14} />}
                count={drafts.length}
                defaultOpen={draftsForSel.length === 0}
                scrollable={drafts.length > 5}
                maxHeight={260}
              >
                <div className="cmp-draft-list">
                  {drafts.map((d) => (
                    <button className="cmp-draft-row" key={d.id} onClick={() => openDraft(d)} type="button" title="打开 → 上方预览 → 复制取走发布">
                      <span className="cmp-draft-plat">{d.platformLabel}</span>
                      <span className="cmp-draft-body">
                        <span className="cmp-draft-title">{draftTitle(d)}</span>
                        <span className="cmp-draft-meta">
                          <span className="num">{d.chars ?? 0}</span><em>字</em>
                          {d.createdAt ? (
                            <>
                              <span className="cmp-dot" aria-hidden />
                              <span>{new Date(d.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</span>
                            </>
                          ) : null}
                        </span>
                      </span>
                      {typeof d.finalScore === "number" && (
                        <span className="cmp-draft-sc" style={{ color: d.finalScore >= 85 ? "var(--ok-600, var(--ok-500))" : "var(--brand-600)" }}>{d.finalScore}</span>
                      )}
                    </button>
                  ))}
                </div>
              </FoldCard>
            )}

            {drafts.length === 0 && (
              <div className="cmp-insp-empty">
                <FileText size={18} aria-hidden />
                <span>还没有成品。选好平台、填好选题,生成后这里会汇总整库,点开任意一篇即可在上方预览并复制取走。</span>
              </div>
            )}
          </div>
        </aside>
      </div>

      <AlertDialog open={confirmGenerateOpen} onOpenChange={setConfirmGenerateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>生成真实{sel.name}成品？</AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>
                这会调用后端 content-type 写作链路和真实 LLM,可能消耗 token,生成结果会进入成品库并展示在当前预览区。
              </span>
              <span className="rounded-md border bg-muted/50 px-3 py-2 text-foreground">
                平台:{sel.name} · 评审修订:{revise ? "开启" : "关闭"}
                {brief.trim() ? ` · 选题:${brief.trim().length > 90 ? `${brief.trim().slice(0, 90)}…` : brief.trim()}` : ""}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={busy}>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                setConfirmGenerateOpen(false)
                void generate()
              }}
            >
              {busy ? "生成中..." : "确认生成"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
