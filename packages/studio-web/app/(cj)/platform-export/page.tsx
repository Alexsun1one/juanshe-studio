"use client"

/**
 * 平台导出 —— AI 编辑部多平台输出。
 *
 * 左侧正文(可「从章节载入」真实章节,或直接编辑 Markdown)→ 右侧目标平台即时预览
 * →「复制」把成品写入剪贴板(公众号/知乎=富文本,小红书/X=纯文本+话题/分条),粘进编辑器无需二次排版。
 *
 * 渲染统一走后端 /api/v1/render(底层是 core 的渲染器,单一来源)。
 */

import * as React from "react"
import {
  Copy,
  Check,
  DownloadCloud,
  FileDown,
  Loader2,
  Sparkles,
  AlertTriangle,
  MessageSquare,
  BookOpen,
  MessagesSquare,
  AtSign,
  Mail,
  Ruler,
  AlignLeft,
  FileCode2,
  ClipboardCheck,
  ListChecks,
  type LucideIcon,
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
import { useWorkspace } from "@/lib/workspace-context"
import { PixelBadge } from "@/components/design/pixel-badge"
import { PlatformHint } from "@/components/design/platform-hint"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import { WechatTemplatePicker, type WechatTpl } from "@/components/studio/wechat-template-picker"
import "./platform-export.css"

const SAMPLE = `# 星尘邮局今晚开张

> 当整座小城都在等一封迟到的信时，她点亮了第一盏蓝色邮灯。

## 一、谜题初现

云桥小镇的夜色落下来时，旧邮局的铜铃忽然响了三声。柜台后的纸鹤抖了抖翅膀，把一封没有署名的信推到灯下。

信封边缘洒着细小的星屑，邮戳却来自三十年后的今天。这意味着，有人把一段还没有发生的故事，提前寄了回来。

## 二、关键线索

她顺着邮戳上的银线看去，发现窗外那条平平无奇的巷子，正在月光里慢慢折成一张地图。

- 蓝色邮灯 = 第一枚路标
- 纸鹤柜台 = 会记住寄件人的旧机关
- 未来邮戳 = 小镇真正秘密的入口

---

下一章，第一位深夜寄信人，将带着整座小镇的秘密推门而入。`

/**
 * 每个目标平台:展示用篇幅区间 `len`,以及结构化的 `min/max`(同一组真实建议字数,
 * 用于「这稿在该平台合不合身」的可行动判断,不另造数字)。`ext` 决定导出成品资产的文件后缀。
 * `icon` 给平台一个一眼可辨的语义图标(lucide,主题中性,不引入新色)。
 */
const PLATFORMS = [
  { id: "wechat", label: "公众号", copy: "复制到公众号", len: "1500–5000 字", min: 1500, max: 5000, fmt: "富文本(粘进编辑器即排版)", ext: "html", icon: MessageSquare },
  { id: "xiaohongshu", label: "小红书", copy: "复制到小红书", len: "200–1000 字", min: 200, max: 1000, fmt: "纯文本 + 话题标签", ext: "txt", icon: BookOpen },
  { id: "zhihu", label: "知乎", copy: "复制到知乎", len: "800–4000 字", min: 800, max: 4000, fmt: "富文本(论证排版)", ext: "html", icon: MessagesSquare },
  { id: "x", label: "X", copy: "复制到 X", len: "100–1500 字", min: 100, max: 1500, fmt: "纯文本 · 分条 thread", ext: "txt", icon: AtSign },
  { id: "newsletter", label: "Newsletter", copy: "复制到 Newsletter", len: "1000–3500 字", min: 1000, max: 3500, fmt: "邮件富文本", ext: "html", icon: Mail },
] as const

type PlatformId = (typeof PLATFORMS)[number]["id"]

/** 平台 → 内容类型档案 id(后端真生成端点 /api/v1/content-type/:id/write)。 */
const CONTENT_TYPE_BY_PLATFORM: Record<PlatformId, string> = {
  wechat: "wechat_article",
  xiaohongshu: "xiaohongshu_note",
  zhihu: "zhihu_answer",
  x: "x_thread",
  newsletter: "newsletter",
}

type Platform = (typeof PLATFORMS)[number]
type FitState = "empty" | "ready" | "short" | "long"

/**
 * 这稿在某平台「合不合身」——只看真实正文字符数 vs 该平台的建议区间,
 * 给一个温和、可一步行动的判断(偏短/正合适/偏长 + 差多少字)。不造任何阅读量/收益数字。
 */
function fitFor(chars: number, p: Platform): { state: FitState; gap: number; label: string; hint: string } {
  if (chars === 0) return { state: "empty", gap: 0, label: "待填正文", hint: `${p.label}建议 ${p.len}` }
  if (chars < p.min) return { state: "short", gap: p.min - chars, label: "偏短", hint: `离${p.label}下限还差 ${(p.min - chars).toLocaleString("en-US")} 字` }
  if (chars > p.max) return { state: "long", gap: chars - p.max, label: "偏长", hint: `比${p.label}上限多 ${(chars - p.max).toLocaleString("en-US")} 字,可精简` }
  return { state: "ready", gap: 0, label: "正合身", hint: `正落在${p.label}建议区间,可直接投` }
}

/** 合身态 → 设计系统状态 pill 的 data-state(语义色只走状态)。 */
const FIT_PILL_STATE: Record<FitState, string> = {
  ready: "success",
  short: "running",
  long: "warn",
  empty: "disabled",
}

export default function PlatformExportPage() {
  const { books, bookId } = useWorkspace()
  const [md, setMd] = React.useState(SAMPLE)
  const [platform, setPlatform] = React.useState<PlatformId>("wechat")
  const [html, setHtml] = React.useState("")
  const [plainText, setPlainText] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [copied, setCopied] = React.useState(false)

  const [selBook, setSelBook] = React.useState("")
  const [chapter, setChapter] = React.useState(1)
  const [loadingChapter, setLoadingChapter] = React.useState(false)

  // B9 公众号模板系统:仅 wechat 平台有 5 个模板可选,其他平台忽略
  const [wechatTemplates, setWechatTemplates] = React.useState<WechatTpl[]>([])
  const [wechatTemplate, setWechatTemplate] = React.useState<string>("business")
  React.useEffect(() => {
    fetch("/api/v1/render/templates")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.wechat)) setWechatTemplates(d.wechat as WechatTpl[])
        if (typeof d?.default === "string") setWechatTemplate(d.default as string)
      })
      .catch(() => { /* ignore */ })
  }, [])

  const [brief, setBrief] = React.useState("")
  const [generating, setGenerating] = React.useState(false)
  const [genError, setGenError] = React.useState("")
  const [confirmGenerateOpen, setConfirmGenerateOpen] = React.useState(false)
  type CritIssue = { severity: string; where: string; problem: string; fix: string }
  const [genInfo, setGenInfo] = React.useState<
    null | { revised: boolean; issues: CritIssue[]; overall: string; warnings: string[] }
  >(null)
  const [showCritique, setShowCritique] = React.useState(false)
  React.useEffect(() => {
    if (!selBook && (bookId || books[0]?.id)) setSelBook(bookId || books[0]!.id)
  }, [bookId, books, selBook])

  // 防抖渲染:正文/平台变化 → 调后端
  React.useEffect(() => {
    const t = setTimeout(async () => {
      if (!md.trim()) {
        setHtml(""); setPlainText(""); return
      }
      setLoading(true); setError("")
      try {
        const res = await fetch("/api/v1/render", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            platform,
            markdown: md,
            ...(platform === "wechat" ? { template: wechatTemplate } : {}),
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error?.message || "渲染失败")
        setHtml(data.html ?? ""); setPlainText(data.plainText ?? "")
      } catch (e) {
        setError(e instanceof Error ? e.message : "渲染失败")
      } finally {
        setLoading(false)
      }
    }, 350)
    return () => clearTimeout(t)
  }, [md, platform, wechatTemplate])

  async function loadChapter() {
    if (!selBook) return
    setLoadingChapter(true); setError("")
    try {
      const res = await fetch(`/api/v1/books/${encodeURIComponent(selBook)}/chapters/${chapter}`, {
        headers: { Accept: "application/json" },
      })
      const data = await res.json().catch(() => ({}))
      const text: string =
        data?.markdown ?? data?.content ?? data?.body ?? data?.chapter?.markdown ?? ""
      if (text.trim()) {
        const title = data?.title ?? data?.chapter?.title
        setMd(title ? `# ${title}\n\n${text}` : text)
      } else {
        setError("该章节暂无可载入正文")
      }
    } catch {
      setError("载入章节失败(后端是否在运行?)")
    } finally {
      setLoadingChapter(false)
    }
  }

  // 真生成:选题/要求 → 后端 content-type 装配 + LLM → 填入左侧正文,复用现有渲染预览。
  async function generate() {
    const topic = brief.trim()
    if (!topic) { setGenError("先填选题/要求"); return }
    setGenerating(true); setGenError(""); setGenInfo(null)
    try {
      const res = await fetch(`/api/v1/content-type/${CONTENT_TYPE_BY_PLATFORM[platform]}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ brief: topic }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error?.message || "生成失败")
      const markdown: string = data?.markdown ?? ""
      if (!markdown.trim()) throw new Error("模型未返回正文")
      setMd(markdown)
      setGenInfo({
        revised: Boolean(data?.revised),
        issues: Array.isArray(data?.critique?.issues) ? data.critique.issues : [],
        overall: typeof data?.critique?.overall === "string" ? data.critique.overall : "",
        warnings: Array.isArray(data?.warnings) ? data.warnings : [],
      })
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "生成失败(后端是否在运行/是否已配置模型与密钥?)")
    } finally {
      setGenerating(false)
    }
  }

  function requestGenerate() {
    const topic = brief.trim()
    if (!topic) {
      setGenError("先填选题/要求")
      return
    }
    setGenError("")
    setConfirmGenerateOpen(true)
  }

  async function copy() {
    let ok = false
    try {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      })
      await navigator.clipboard.write([item]); ok = true
    } catch {
      try { await navigator.clipboard.writeText(plainText); ok = true } catch { ok = false }
    }
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1800) }
  }

  // 导出成品资产:把已渲染的平台输出存成文件(富文本平台 → .html 可直接预览/再用,纯文本 → .txt)。
  // 用的是真实渲染结果(html/plainText),不另生成内容。
  function downloadAsset() {
    const p = PLATFORMS.find((pp) => pp.id === platform)
    const ext = p?.ext ?? "txt"
    const body =
      ext === "html"
        ? `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${platformLabel}成品</title></head><body style="max-width:680px;margin:0 auto;padding:32px 20px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.8;color:#1f2433;">${html}</body></html>`
        : plainText
    const mime = ext === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8"
    const blob = new Blob([body], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${platformLabel}成品.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#fff;padding:24px 20px;">${html}</body></html>`
  const activePlatform = PLATFORMS.find((p) => p.id === platform)
  const platformLabel = activePlatform?.label ?? platform
  const copyLabel = activePlatform?.copy ?? "复制"
  const generatePreview = brief.trim().slice(0, 90)
  const ActiveIcon: LucideIcon = activePlatform?.icon ?? MessageSquare

  // 内联实时数据:正文规模(字符 / 段落)随编辑原地变化,不做卡片
  const charCount = md.length
  const paraCount = md.split(/\n{2,}/).filter((p) => p.trim()).length

  // 预览三态(纯展示派生,不碰数据层):正文清空=温和空态引导;首次渲染中=骨架;有成品=真预览。
  const mdEmpty = !md.trim()
  const previewSkeleton = loading && !html && !error

  // 「一稿多投」:这一稿在每个平台合不合身(只用真实字符数 vs 各平台建议区间)。
  // readyCount = 当前就能直接投的平台数,把"写一次、多平台分发"的变现路径变成可见、可一步行动的信号。
  const fits = PLATFORMS.map((p) => ({ p, fit: fitFor(charCount, p) }))
  const readyCount = fits.filter((f) => f.fit.state === "ready").length
  const activeFit = (activePlatform ? fitFor(charCount, activePlatform) : null)

  // 「导出准备度」:这一稿离「能直接复制/导出去投」还差几步,全部由真实状态派生,不造分数。
  // 五个真实关口:① 正文已填 ② 字数落在区间 ③ 预览已渲染 ④ 成品可复制 ⑤ 已过 AI 评审。
  const checks: { id: string; label: string; ok: boolean; hint: string }[] = [
    { id: "draft", label: "正文已填", ok: charCount > 0, hint: charCount > 0 ? `${charCount.toLocaleString("en-US")} 字符就位` : "左侧还没有正文" },
    {
      id: "fit",
      label: "字数合身",
      ok: activeFit?.state === "ready",
      hint: activeFit ? activeFit.hint : "选择目标平台",
    },
    { id: "render", label: "预览已渲染", ok: Boolean(html) && !loading, hint: loading ? "渲染中…" : html ? `${platformLabel}排版已生成` : "等待正文渲染" },
    { id: "asset", label: "成品可复制/导出", ok: Boolean(html) && !error, hint: error ? error : html ? `富文本 + 纯文本就绪 · .${activePlatform?.ext ?? "txt"}` : "渲染成功后可复制" },
    { id: "review", label: "已过 AI 评审", ok: Boolean(genInfo), hint: genInfo ? (genInfo.revised ? "已评审并修订" : "评审完成") : "选填:可让 AI 评审去腔" },
  ]
  // 必备关口(前 4 项)就绪即「可投」;评审为选填,只加分不挡。
  const requiredDone = checks.slice(0, 4).filter((c) => c.ok).length
  const readyPct = Math.round((requiredDone / 4) * 100)

  return (
    <div className="cj-screen cj-platform-export">
      {/* ── 顶部工作条:像素点睛 + 标题 + 一行密集 KPI(当前平台真实指标)+ 导出组 ── */}
      <header className="cj-workhead pe-head">
        <div className="pe-headline">
          <PixelBadge kind="platform" size={42} className="pe-hero-pixel" ariaLabel="平台导出" />
          <div className="pe-headline-text">
            <div className="pe-title-row">
              <h1 className="page-title">平台导出</h1>
              <span className="pe-tag">一稿多投 · 一键复制</span>
            </div>
            <div className="page-sub pe-sub">
              一份正文，按目标平台即时排版预览，复制即成品——公众号/知乎富文本、小红书/X 纯文本带话题，粘进编辑器无需二次排版。
            </div>
            <div className="page-sub pe-sub" style={{ opacity: 0.62 }}>
              本页只管「单篇排版导出」 · 成品总览去「内容库」、发布进度与平台频道去「发布管理」。
            </div>
          </div>

          <PlatformHint type="browser-download" variant="quiet" />
          <div className="pe-export-group">
            <button
              type="button"
              onClick={copy}
              disabled={!html || loading}
              className={`btn primary pe-copy${copied ? " is-copied" : ""}`}
              data-copied={copied ? "" : undefined}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "已复制 · 去粘贴" : copyLabel}
            </button>
            <button
              type="button"
              onClick={downloadAsset}
              disabled={!html || loading}
              className="btn pe-download"
              title={`把${platformLabel}成品存成文件`}
            >
              <FileDown className="size-4" />
              <span className="pe-download-text">存成文件</span>
            </button>
          </div>
        </div>

        {/* 一行密集 KPI:目标平台 / 合身 / 实时字数 / 段落 / 可投平台,随编辑原地变化,不做大卡 */}
        <div className="pe-kpis" role="group" aria-label="本稿概览">
          <KpiChip
            label="目标平台"
            value={
              <span className="pe-kpi-plat">
                <ActiveIcon className="size-4" aria-hidden />
                {platformLabel}
              </span>
            }
            tone="brand"
            hint={activePlatform?.fmt}
            sub={<span className="pe-kpi-fmt">{activePlatform?.fmt ?? ""}</span>}
          />
          <KpiChip
            label="字数合身"
            value={activeFit?.label ?? "—"}
            unit={activeFit && activeFit.gap > 0 ? `${activeFit.state === "short" ? "差" : "多"}${activeFit.gap.toLocaleString("en-US")}` : undefined}
            tone={activeFit?.state === "ready" ? "ok" : activeFit?.state === "long" ? "warn" : activeFit?.state === "short" ? "brand" : "neutral"}
            hint={activeFit?.hint}
            sub={<span className="pe-kpi-fmt">建议 {activePlatform?.len ?? "—"}</span>}
          />
          <KpiChip label="正文字符" value={charCount.toLocaleString("en-US")} unit="字符" tone="neutral" sub={<StatLine items={[{ n: paraCount, label: "段" }]} />} />
          <KpiChip
            label="可投平台"
            value={readyCount}
            unit={`/ ${PLATFORMS.length}`}
            tone={readyCount > 0 ? "ok" : "neutral"}
            hint={`这一稿当前正落在 ${readyCount} 个平台的建议篇幅内,可直接投`}
            sub={<span className="pe-kpi-fmt">落在建议区间</span>}
          />
          <KpiChip
            label="导出准备度"
            value={readyPct}
            unit="%"
            tone={readyPct >= 100 ? "ok" : readyPct >= 50 ? "brand" : "warn"}
            hint="正文 / 字数 / 渲染 / 成品 四关就绪度"
            sub={<span className="pe-kpi-fmt">{requiredDone}/4 关就绪</span>}
          />
        </div>
      </header>

      {/* ── 主体:左中(编辑 + 预览)为主区,右侧 Inspector(导出准备度 / 全平台合身 / 规格)── */}
      <div className="cj-screen-body pe-body">
        <div className="cj-mainpane pe-mainpane">
          {/* 平台选择条:带语义图标的 tab,一眼可辨 + 合身小圆点(只看真实字数 vs 区间) */}
          <div className="pe-platbar" role="tablist" aria-label="目标平台 · 一稿多投">
            {fits.map(({ p, fit }) => {
              const Icon = p.icon
              return (
                <button
                  key={p.id}
                  role="tab"
                  aria-selected={platform === p.id}
                  data-active={platform === p.id ? "" : undefined}
                  className="pe-plat-tab"
                  onClick={() => setPlatform(p.id)}
                  title={fit.hint}
                >
                  <Icon className="pe-plat-ico size-4" aria-hidden />
                  <span className="pe-plat-name">{p.label}</span>
                  <span className={`pe-dot pe-dot-${fit.state}`} aria-hidden />
                </button>
              )
            })}
            {/* B9 — 仅 wechat 平台显示模板选择(带迷你预览缩略图) */}
            {platform === "wechat" && wechatTemplates.length > 0 && (
              <div className="pe-platbar-tpl">
                <WechatTemplatePicker
                  templates={wechatTemplates}
                  value={wechatTemplate}
                  onChange={setWechatTemplate}
                />
              </div>
            )}
          </div>

          <div className="pe-split">
            {/* 左:正文输入 + 章节载入 */}
            <section className="pe-pane pe-pane-edit">
              {/* 工具行:章节载入 + AI 生成,语义分两栏,克制不喧宾 */}
              <div className="pe-toolbar">
                <div className="pe-tool-row">
                  <span className="pe-tool-label">从章节载入</span>
                  <select
                    value={selBook}
                    onChange={(e) => setSelBook(e.target.value)}
                    className="pe-field pe-select"
                    aria-label="选择书籍"
                  >
                    {books.length === 0 ? <option value="">无书籍</option> : null}
                    {books.map((b) => (
                      <option key={b.id} value={b.id}>{b.title.zh}</option>
                    ))}
                  </select>
                  <span className="pe-tool-hint">第</span>
                  <input
                    type="number" min={1} value={chapter}
                    onChange={(e) => setChapter(Math.max(1, Number(e.target.value) || 1))}
                    className="pe-field pe-num num"
                    aria-label="章节号"
                  />
                  <span className="pe-tool-hint">章</span>
                  <button
                    type="button"
                    onClick={loadChapter}
                    disabled={!selBook || loadingChapter}
                    className="pe-ghost"
                  >
                    {loadingChapter ? <Loader2 className="size-3.5 animate-spin" /> : <DownloadCloud className="size-3.5" />}
                    载入
                  </button>
                </div>

                <div className="pe-tool-row pe-tool-gen">
                  <Sparkles className="pe-gen-icon size-3.5" />
                  <input
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !generating) {
                        e.preventDefault()
                        requestGenerate()
                      }
                    }}
                    placeholder={`选题/要求 → AI 生成${platformLabel}初稿`}
                    className="pe-field pe-gen-input"
                    aria-label="AI 生成选题/要求"
                  />
                  <button
                    type="button"
                    onClick={requestGenerate}
                    disabled={generating || !brief.trim()}
                    className="btn primary sm pe-gen-btn"
                  >
                    {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    {generating ? "生成中…" : "AI 生成"}
                  </button>
                  {genError ? (
                    <span className="pe-gen-err" title={genError}>{genError}</span>
                  ) : null}
                </div>
              </div>

              {genInfo ? (
                <div className="pe-critique">
                  <div className="pe-critique-head">
                    {genInfo.revised ? (
                      <span className="pe-verdict ok"><Check className="size-3" /> 已评审并修订 · 去 AI 腔</span>
                    ) : (
                      <span className="pe-verdict muted">评审完成,无需修订</span>
                    )}
                    {genInfo.issues.length > 0 ? (
                      <button type="button" className="pe-critique-toggle" onClick={() => setShowCritique((v) => !v)}>
                        {showCritique ? "收起" : `查看 ${genInfo.issues.length} 条评审意见`}
                      </button>
                    ) : null}
                    {genInfo.warnings.length > 0 ? (
                      <span className="pe-warn" title={genInfo.warnings[0]}>
                        <AlertTriangle className="size-3" /> {genInfo.warnings[0]}
                      </span>
                    ) : null}
                  </div>
                  {showCritique && genInfo.issues.length > 0 ? (
                    <ul className="pe-issues">
                      {genInfo.issues.map((it, i) => (
                        <li key={i} className="pe-issue">
                          <span className={`pe-sev pe-sev-${it.severity === "critical" ? "crit" : it.severity === "significant" ? "sig" : "minor"}`}>
                            {it.severity}
                          </span>
                          <span className="pe-issue-body">
                            {it.where ? <b className="pe-issue-where">{it.where}</b> : null}
                            <span className="pe-issue-problem">{it.problem}</span>
                            {it.fix ? <span className="pe-issue-fix">→ {it.fix}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="pe-editor-wrap">
                <div className="pe-editor-rail">
                  <span className="pe-editor-label"><AlignLeft className="size-3.5" aria-hidden /> Markdown 正文</span>
                  <span className="pe-editor-meta num">{charCount.toLocaleString("en-US")} 字符 · {paraCount} 段</span>
                </div>
                <textarea
                  value={md}
                  onChange={(e) => setMd(e.target.value)}
                  spellCheck={false}
                  className="pe-editor scroll-thin"
                  aria-label="Markdown 正文"
                />
              </div>
            </section>

            {/* 右:平台预览 */}
            <section className="pe-pane pe-pane-preview">
              <div className="pe-preview-rail">
                <span className="pe-preview-title"><ActiveIcon className="size-3.5" aria-hidden /> {platformLabel} 预览</span>
                {loading ? <Loader2 className="pe-preview-spin size-3.5 animate-spin" /> : null}
                {error ? <span className="pe-preview-err"><AlertTriangle className="size-3" /> {error}</span> : null}
                <span className="pe-preview-hint">{activePlatform?.fmt ?? ""}</span>
              </div>
              <div className="pe-preview-stage scroll-thin">
                {mdEmpty ? (
                  <div className="pe-preview-empty">
                    <span className="pe-preview-empty-ico"><ActiveIcon className="size-5" aria-hidden /></span>
                    <p className="pe-preview-empty-title">还没有正文可预览</p>
                    <p className="pe-preview-empty-desc">
                      从左侧「从章节载入」拉入真实章节,或用 <Sparkles className="size-3.5" aria-hidden /> AI 生成{platformLabel}初稿——这里会即时排出{platformLabel}成品。
                    </p>
                  </div>
                ) : previewSkeleton ? (
                  <div className="pe-device pe-device-skel" aria-hidden>
                    <div className="pe-skel-doc">
                      <span className="skel pe-skel-line pe-skel-h" />
                      <span className="skel pe-skel-line w-90" />
                      <span className="skel pe-skel-line w-96" />
                      <span className="skel pe-skel-line w-80" />
                      <span className="skel pe-skel-line w-60" />
                      <span className="skel pe-skel-line w-92" />
                      <span className="skel pe-skel-line w-72" />
                    </div>
                  </div>
                ) : (
                  <div className="pe-device">
                    <iframe title="平台预览" srcDoc={srcDoc} className="pe-device-frame" />
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>

        {/* ── Inspector:导出准备度 + 全平台合身 + 当前平台规格(只在 pane 内滚)── */}
        <aside className="cj-inspector pe-inspector">
          <div className="cj-pane-scroll pe-insp-scroll">
            {/* 导出准备度:Meter + 真实关口清单(不造分数,全部由当前状态派生) */}
            <section className="card pe-ready">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-title"><ClipboardCheck className="size-4 pe-card-ico" aria-hidden /> 导出准备度</div>
                <span className="pe-ready-pct num" data-done={readyPct >= 100 ? "" : undefined}>{readyPct}%</span>
              </div>
              <Meter label={`${platformLabel} · 必备四关`} value={requiredDone} max={4} tone={readyPct >= 100 ? "ok" : "brand"} showValue={false} />
              <ul className="pe-checks">
                {checks.map((c) => (
                  <li key={c.id} className={`pe-check${c.ok ? " is-ok" : ""}`} title={c.hint}>
                    <span className="pe-check-mark" aria-hidden>
                      {c.ok ? <Check className="size-3" /> : <span className="pe-check-empty" />}
                    </span>
                    <span className="pe-check-body">
                      <span className="pe-check-label">{c.label}</span>
                      <span className="pe-check-hint">{c.hint}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {/* 全平台合身:一份正文在每个平台合不合身,点一下即切目标平台(只看真实字数 vs 区间) */}
            <FoldCard
              title="全平台合身"
              icon={<ListChecks className="size-4" aria-hidden />}
              count={<span className="pe-fold-count"><b>{readyCount}</b>/{PLATFORMS.length} 可投</span>}
              defaultOpen
            >
              <div className="pe-fit-list">
                {fits.map(({ p, fit }) => {
                  const Icon = p.icon
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="pe-fit-row"
                      data-active={platform === p.id ? "" : undefined}
                      onClick={() => setPlatform(p.id)}
                      title={fit.hint}
                    >
                      <span className="pe-fit-ico"><Icon className="size-4" aria-hidden /></span>
                      <span className="pe-fit-main">
                        <span className="pe-fit-name">{p.label}</span>
                        <span className="pe-fit-range">{p.len}</span>
                      </span>
                      <span className="pill" data-state={FIT_PILL_STATE[fit.state]}>
                        <span className="dot" />
                        {fit.label}
                        {fit.gap > 0 ? (
                          <i className="pe-fit-gap num">{fit.state === "short" ? "差" : "多"}{fit.gap.toLocaleString("en-US")}</i>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            </FoldCard>

            {/* 当前平台规格:目标平台的真实建议/格式/导出后缀,密集呈现 */}
            <section className="card pe-spec">
              <div className="card-head" style={{ marginBottom: 8 }}>
                <div className="card-title"><ActiveIcon className="size-4 pe-card-ico" aria-hidden /> {platformLabel} 规格</div>
              </div>
              <div className="pe-spec-grid">
                <span className="pe-spec-cell">
                  <span className="pe-spec-k"><Ruler className="size-3.5" aria-hidden /> 建议篇幅</span>
                  <span className="pe-spec-v num">{activePlatform?.len ?? "—"}</span>
                </span>
                <span className="pe-spec-cell">
                  <span className="pe-spec-k"><AlignLeft className="size-3.5" aria-hidden /> 当前字数</span>
                  <span className={`pe-spec-v num pe-spec-fit-${activeFit?.state ?? "empty"}`}>{charCount.toLocaleString("en-US")} 字</span>
                </span>
                <span className="pe-spec-cell pe-spec-wide">
                  <span className="pe-spec-k"><AlignLeft className="size-3.5" aria-hidden /> 输出格式</span>
                  <span className="pe-spec-v">{activePlatform?.fmt ?? "—"}</span>
                </span>
                <span className="pe-spec-cell pe-spec-wide">
                  <span className="pe-spec-k"><FileCode2 className="size-3.5" aria-hidden /> 导出后缀</span>
                  <span className="pe-spec-v"><code className="pe-spec-ext">.{activePlatform?.ext ?? "txt"}</code> · 复制为富文本 + 纯文本</span>
                </span>
              </div>
            </section>
          </div>
        </aside>
      </div>

      <AlertDialog open={confirmGenerateOpen} onOpenChange={setConfirmGenerateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>生成真实{platformLabel}初稿？</AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>
                这会调用后端 content-type 写作链路和真实 LLM,可能消耗 token,并把生成结果写入左侧正文用于平台预览。
              </span>
              <span className="rounded-md border bg-muted/50 px-3 py-2 text-foreground">
                平台:{platformLabel}
                {generatePreview ? ` · 选题:${generatePreview}` : ""}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={generating}>保持当前正文</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={generating}
              onClick={(event) => {
                event.preventDefault()
                setConfirmGenerateOpen(false)
                void generate()
              }}
            >
              {generating ? "生成中..." : "确认生成"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
