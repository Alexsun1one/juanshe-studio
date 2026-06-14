"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { StreakDay } from "@/lib/api/types"
import { heatmapTier, toWeeks } from "@/components/workbench/writing-heatmap"
import "./share-card.css"

// ── 一键分享卡（暖纸柔紫，SVG→canvas→PNG 原生导出，无新依赖）─────────────
// 两种模板：
//   ① streak：晒连更 = 热力图 + 连更天数 + 书名 + 累计字数
//   ② prose ：晒正文 = 一段精选正文 + 书名 + 作者
// 角落品牌「卷舍 · write.nextapi.top」。下载用 SVG 序列化 → new Image → canvas → toBlob('image/png')。

export type ShareCardMode = "streak" | "prose"

const CARD_W = 880
const CARD_H = 560

// 卡片专用色板（不依赖 CSS 变量，导出 SVG 自包含；亮暗两套，跟随当前主题）。
type Palette = {
  paper: string // 卡纸底
  paper2: string // 渐变第二色
  ink: string // 主墨色（书名/数字）
  ink2: string // 次墨色（正文/说明）
  inkSoft: string // 弱化（角标/日期）
  brand: string // 柔紫主色
  brandSoft: string // 柔紫浅底
  line: string // 细线
  accent: string // 暖橙点睛
  hm: [string, string, string, string, string] // 热力图 5 档
}

const LIGHT: Palette = {
  paper: "#FCFAF5",
  paper2: "#F6F2EB",
  ink: "#3B2E1B",
  ink2: "#4E4638",
  inkSoft: "#9B8E77",
  brand: "#6E5BFA",
  brandSoft: "#EFECFF",
  line: "#E1D7C4",
  accent: "#E8965A",
  hm: ["#EDE7DC", "#D8CFF6", "#B7A6F2", "#8E78EC", "#6E5BFA"],
}
const DARK: Palette = {
  paper: "#262136",
  paper2: "#1F1A2C",
  ink: "#ECE3D2",
  ink2: "#C2B49A",
  inkSoft: "#897C66",
  brand: "#8B79FF",
  brandSoft: "#2A2348",
  line: "#403A5C",
  accent: "#FFA56A",
  hm: ["#2E2942", "#3F3470", "#5448A0", "#6E5FC9", "#8B79FF"],
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

// 把正文按宽度软换行成多行（粗略按字符数估算，中文友好）。
function wrapProse(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim()
  const lines: string[] = []
  let buf = ""
  for (const ch of clean) {
    buf += ch
    // 中文按 1 计，ASCII 按 0.5 计的近似
    const weight = [...buf].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 1 : 0.5), 0)
    if (weight >= maxCharsPerLine || ch === "\n") {
      lines.push(buf.trim())
      buf = ""
      if (lines.length >= maxLines) break
    }
  }
  if (buf.trim() && lines.length < maxLines) lines.push(buf.trim())
  if (lines.length >= maxLines && (buf.trim() || clean.length > lines.join("").length)) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/.$/, "")}…`
  }
  return lines
}

// 热力图 SVG 片段（rect 网格），供 streak 模板嵌入。
function heatmapSvgRects(
  calendar: StreakDay[],
  pal: Palette,
  opts: { x: number; y: number; cell: number; gap: number; weeks: number },
): string {
  const weeks = toWeeks(calendar).slice(-opts.weeks)
  const step = opts.cell + opts.gap
  const rects: string[] = []
  weeks.forEach((week, col) => {
    week.forEach((day, row) => {
      if (!day) return
      const tier = heatmapTier(day.words)
      const fill = pal.hm[tier]
      rects.push(
        `<rect x="${(opts.x + col * step).toFixed(1)}" y="${(opts.y + row * step).toFixed(1)}" width="${opts.cell}" height="${opts.cell}" rx="2.5" fill="${fill}"${tier === 0 ? ` stroke="${pal.line}" stroke-width="1"` : ""} />`,
      )
    })
  })
  return rects.join("")
}

export type ShareCardData = {
  bookTitle: string
  author: string
  // streak 模板用
  calendar?: StreakDay[]
  currentStreak?: number
  longestStreak?: number
  totalWords?: number
  // prose 模板用
  prose?: string
  chapterLabel?: string
}

// 生成完整自包含 SVG 字符串（用于预览 + 导出）。
export function buildShareCardSvg(mode: ShareCardMode, data: ShareCardData, pal: Palette): string {
  const titleFont =
    "'Songti SC','Source Han Serif SC','Noto Serif SC',Georgia,serif"
  const uiFont =
    "'PingFang SC','HarmonyOS Sans SC','Microsoft YaHei',system-ui,sans-serif"
  const proseFont = titleFont

  const brandLine = `卷舍 · write.nextapi.top`
  const pad = 56

  const header = `
    <text x="${pad}" y="${pad + 6}" font-family="${uiFont}" font-size="22" font-weight="700" fill="${pal.brand}" letter-spacing="1">卷舍</text>
    <text x="${pad + 56}" y="${pad + 6}" font-family="${uiFont}" font-size="14" fill="${pal.inkSoft}">JUANSHE · AI 小说写作台</text>
  `

  const footer = `
    <line x1="${pad}" y1="${CARD_H - 64}" x2="${CARD_W - pad}" y2="${CARD_H - 64}" stroke="${pal.line}" stroke-width="1" />
    <text x="${pad}" y="${CARD_H - 36}" font-family="${uiFont}" font-size="14" fill="${pal.inkSoft}">${escapeXml(brandLine)}</text>
    <text x="${CARD_W - pad}" y="${CARD_H - 36}" text-anchor="end" font-family="${proseFont}" font-size="14" fill="${pal.ink2}">— ${escapeXml(data.author || "作者大大")}</text>
  `

  const body = mode === "streak" ? buildStreakBody() : buildProseBody()

  function buildStreakBody(): string {
    const streak = data.currentStreak ?? 0
    const longest = data.longestStreak ?? 0
    const words = (data.totalWords ?? 0).toLocaleString("en-US")
    const cal = data.calendar ?? []
    const heat = heatmapSvgRects(cal, pal, { x: pad, y: 286, cell: 14, gap: 4, weeks: 40 })
    return `
      <text x="${pad}" y="150" font-family="${titleFont}" font-size="40" font-weight="700" fill="${pal.ink}">《${escapeXml(data.bookTitle || "我的作品")}》</text>
      <g>
        <text x="${pad}" y="222" font-family="${uiFont}" font-size="64" font-weight="800" fill="${pal.brand}">${streak}</text>
        <text x="${pad + (streak >= 10 ? 92 : 56)}" y="222" font-family="${uiFont}" font-size="20" fill="${pal.ink2}">天连续写作</text>
      </g>
      <text x="${pad}" y="252" font-family="${uiFont}" font-size="14" fill="${pal.inkSoft}">最长连更 ${longest} 天 · 累计 ${words} 字</text>
      <text x="${pad}" y="282" font-family="${uiFont}" font-size="12" fill="${pal.inkSoft}">— 写作打卡热力图（越深写得越多）—</text>
      ${heat}
    `
  }

  function buildProseBody(): string {
    const lines = wrapProse(data.prose ?? "", 26, 7)
    const proseY = 170
    const lineH = 40
    const proseTspans = lines
      .map(
        (ln, i) =>
          `<tspan x="${pad}" y="${proseY + i * lineH}">${escapeXml(ln)}</tspan>`,
      )
      .join("")
    return `
      <text x="${pad}" y="128" font-family="${titleFont}" font-size="30" font-weight="700" fill="${pal.ink}">《${escapeXml(data.bookTitle || "我的作品")}》${data.chapterLabel ? `<tspan font-family="${uiFont}" font-size="15" font-weight="400" fill="${pal.inkSoft}">  ·  ${escapeXml(data.chapterLabel)}</tspan>` : ""}</text>
      <text x="${pad - 18}" y="${proseY - 26}" font-family="${proseFont}" font-size="64" fill="${pal.brandSoft}" opacity="0.9">“</text>
      <text font-family="${proseFont}" font-size="25" fill="${pal.ink2}" letter-spacing="0.5">${proseTspans}</text>
    `
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
    <defs>
      <linearGradient id="scbg" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stop-color="${pal.paper}" />
        <stop offset="1" stop-color="${pal.paper2}" />
      </linearGradient>
      <radialGradient id="scglow" cx="0.82" cy="0.06" r="0.5">
        <stop offset="0" stop-color="${pal.brand}" stop-opacity="0.12" />
        <stop offset="1" stop-color="${pal.brand}" stop-opacity="0" />
      </radialGradient>
    </defs>
    <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="22" fill="url(#scbg)" />
    <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="22" fill="url(#scglow)" />
    <rect x="1" y="1" width="${CARD_W - 2}" height="${CARD_H - 2}" rx="21" fill="none" stroke="${pal.line}" stroke-width="1.5" />
    <rect x="0" y="0" width="6" height="${CARD_H}" rx="3" fill="${pal.brand}" />
    ${header}
    ${body}
    ${footer}
  </svg>`
}

function currentPalette(): Palette {
  if (typeof document === "undefined") return LIGHT
  const root = document.documentElement
  const isDark =
    root.classList.contains("dark") ||
    root.getAttribute("data-theme") === "dark"
  return isDark ? DARK : LIGHT
}

// SVG 字符串 → PNG Blob（原生：序列化 → data URL → Image → canvas → toBlob）。
async function svgToPngBlob(svg: string, scale = 2): Promise<Blob> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const img = new Image()
  img.decoding = "async"
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error("SVG 渲染失败"))
    img.src = url
  })
  const canvas = document.createElement("canvas")
  canvas.width = CARD_W * scale
  canvas.height = CARD_H * scale
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("无法创建画布")
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, CARD_W, CARD_H)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("导出 PNG 失败"))),
      "image/png",
    )
  })
}

export function ShareCardDialog({
  open,
  onOpenChange,
  initialMode = "streak",
  data,
  allowModeSwitch = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialMode?: ShareCardMode
  data: ShareCardData
  /** 是否允许在弹层内切换「晒连更/晒正文」（晒正文需有 prose 数据）*/
  allowModeSwitch?: boolean
}) {
  const [mode, setMode] = React.useState<ShareCardMode>(initialMode)
  const [downloading, setDownloading] = React.useState(false)
  const [pal, setPal] = React.useState<Palette>(LIGHT)

  React.useEffect(() => {
    if (open) {
      setMode(initialMode)
      setPal(currentPalette())
    }
  }, [open, initialMode])

  const hasProse = Boolean(data.prose && data.prose.trim().length > 0)
  const effectiveMode: ShareCardMode = mode === "prose" && !hasProse ? "streak" : mode

  const svg = React.useMemo(
    () => buildShareCardSvg(effectiveMode, data, pal),
    [effectiveMode, data, pal],
  )

  // 预览走 Blob URL <img>，避免 dangerouslySetInnerHTML（SVG 渲染在隔离图像上下文，
  // 不进 DOM；即便如此，所有用户串已 escapeXml，无注入面）。
  const [previewUrl, setPreviewUrl] = React.useState<string>("")
  React.useEffect(() => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [svg])

  const onDownload = async () => {
    setDownloading(true)
    try {
      const blob = await svgToPngBlob(svg, 2)
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      const stamp = new Date().toISOString().slice(0, 10)
      a.href = url
      a.download = `卷舍-${effectiveMode === "streak" ? "连更打卡" : "精选正文"}-${stamp}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success("已下载分享卡", { description: "晒到朋友圈/社群，带上链接拉新～" })
    } catch (e) {
      toast.error(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="share-card-dialog" showCloseButton>
        <DialogHeader>
          <DialogTitle>做一张分享卡</DialogTitle>
          <DialogDescription>
            把你的写作成就做成精美卡片，下载后晒到朋友圈、社群 —— 角落带上卷舍链接，帮你拉来新读者。
          </DialogDescription>
        </DialogHeader>

        {allowModeSwitch && (
          <div className="share-card-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === "streak"}
              className={`sct-tab${effectiveMode === "streak" ? " on" : ""}`}
              onClick={() => setMode("streak")}
            >
              晒连更
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === "prose"}
              className={`sct-tab${effectiveMode === "prose" ? " on" : ""}`}
              onClick={() => setMode("prose")}
              disabled={!hasProse}
              title={hasProse ? "晒一段得意正文" : "去编辑器选中一段正文再来「晒这段」"}
            >
              晒正文
            </button>
          </div>
        )}

        {/* 预览：与导出完全同源的 SVG，经 Blob URL 以 <img> 渲染（隔离图像上下文）*/}
        <div className="share-card-preview" aria-label="分享卡预览">
          {previewUrl && (
            <img className="share-card-canvas" src={previewUrl} alt="分享卡预览" />
          )}
        </div>

        <div className="share-card-foot">
          <button
            type="button"
            className="scf-btn primary"
            onClick={onDownload}
            disabled={downloading}
          >
            {downloading ? "导出中…" : "下载图片"}
          </button>
          <button type="button" className="scf-btn" onClick={() => onOpenChange(false)}>
            关闭
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
