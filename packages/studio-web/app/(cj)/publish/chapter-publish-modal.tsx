"use client"

import * as React from "react"
import { toast } from "sonner"
import { X, Copy, Download, FileText, Hash, Type } from "lucide-react"
import { fetchManuscript } from "@/lib/api/client"
import type { Chapter } from "@/lib/studio-data"

/* ---------- 确定性转换(纯函数,非 Agent) ---------- */

/** Markdown → 纯文本:去掉标题/列表/粗体等标记,保留段落 */
function toPlainText(md: string): string {
  return md
    .split("\n")
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^[-*]\s+/, "· ")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/`(.+?)`/g, "$1"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** 按句末标点切句(不依赖 lookbehind,兼容更低 TS target) */
function splitSentences(p: string): string[] {
  const res: string[] = []
  let cur = ""
  for (const ch of p) {
    cur += ch
    if ("。！？!?".includes(ch)) {
      res.push(cur)
      cur = ""
    }
  }
  if (cur.trim()) res.push(cur)
  return res.map((s) => s.trim()).filter(Boolean)
}

/** Markdown → X/Twitter 分条:按段落聚合,超长按句切,末尾标 (i/n) */
function toThread(md: string, limit = 270): string[] {
  const paras = toPlainText(md)
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const out: string[] = []
  let buf = ""
  const flush = () => {
    if (buf.trim()) out.push(buf.trim())
    buf = ""
  }
  for (const p of paras) {
    if (p.length > limit) {
      flush()
      let sb = ""
      for (const s of splitSentences(p)) {
        if ((sb + s).length > limit) {
          if (sb) out.push(sb.trim())
          sb = s
        } else sb += s
      }
      if (sb) out.push(sb.trim())
    } else if (buf && (buf + "\n\n" + p).length > limit) {
      flush()
      buf = p
    } else {
      buf = buf ? buf + "\n\n" + p : p
    }
  }
  flush()
  const n = out.length || 1
  return out.map((t, i) => `${t}\n\n(${i + 1}/${n})`)
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

type Fmt = "md" | "plain" | "thread"
const FORMATS: { id: Fmt; label: string; icon: React.ComponentType<{ size?: number }>; hint: string }[] = [
  { id: "md", label: "Markdown 原文", icon: FileText, hint: "公众号 / 知乎 / Newsletter 等长文平台可直接粘贴" },
  { id: "plain", label: "纯文本", icon: Type, hint: "去掉所有标记,适合不支持 Markdown 的编辑器" },
  { id: "thread", label: "X / Twitter 分条", icon: Hash, hint: "按长度确定性切分,每条标注 (序号/总数)" },
]

export function ChapterPublishModal({
  bookId,
  chapter,
  onClose,
}: {
  bookId: string
  chapter: Chapter
  onClose: () => void
}) {
  const [content, setContent] = React.useState<string | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const [fmt, setFmt] = React.useState<Fmt>("md")

  React.useEffect(() => {
    let alive = true
    fetchManuscript(bookId, chapter.num)
      .then((m) => {
        if (!alive) return
        const body = (m.paragraphs ?? [])
          .map((p) => (p.quote ? `> ${p.zh}` : p.zh))
          .filter((s) => s.trim())
          .join("\n\n")
          .trim()
        const head = body.trimStart()
        const hasTitle = head.startsWith("#") || head.startsWith(`第${chapter.num}章`)
        const title = chapter.title.zh ? `# 第${chapter.num}章 ${chapter.title.zh}` : `# 第${chapter.num}章`
        setContent(hasTitle || !body ? body : `${title}\n\n${body}`)
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [bookId, chapter.num, chapter.title.zh])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const thread = React.useMemo(() => (content ? toThread(content) : []), [content])
  const exported = React.useMemo(() => {
    if (!content) return ""
    if (fmt === "plain") return toPlainText(content)
    if (fmt === "thread") return thread.join("\n\n———\n\n")
    return content
  }, [content, fmt, thread])

  const chars = React.useMemo(() => (content ? content.replace(/\s/g, "").length : 0), [content])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exported)
      toast.success(`已复制「${FORMATS.find((f) => f.id === fmt)?.label}」`)
    } catch {
      toast.error("复制失败,请手动选择文本复制")
    }
  }
  const dl = () => {
    const ext = fmt === "md" ? "md" : "txt"
    download(`第${chapter.num}章·${chapter.title.zh || "正文"}.${ext}`, exported)
    toast.success("已下载")
  }

  return (
    <div className="cp-overlay" onClick={onClose} role="presentation">
      <div className="cp-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="单章发布预处理">
        <div className="cp-head">
          <div className="cp-title">
            <span className="cp-num">第 {chapter.num} 章</span>
            <span className="cp-name">{chapter.title.zh || "(无标题)"}</span>
          </div>
          <button type="button" className="cp-x" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="cp-tabs">
          {FORMATS.map((f) => {
            const Icon = f.icon
            return (
              <button key={f.id} className={`cp-tab${fmt === f.id ? " on" : ""}`} onClick={() => setFmt(f.id)} type="button">
                <Icon size={13} /> {f.label}
              </button>
            )
          })}
        </div>
        <div className="cp-hint">{FORMATS.find((f) => f.id === fmt)?.hint}</div>

        <div className="cp-body">
          {err ? (
            <div className="cp-empty">读取正文失败:{err}</div>
          ) : content === null ? (
            <div className="cp-empty">正在读取第 {chapter.num} 章正文…</div>
          ) : fmt === "thread" ? (
            <div className="cp-thread">
              {thread.map((t, i) => (
                <div className="cp-tweet" key={i}>
                  <pre>{t}</pre>
                </div>
              ))}
            </div>
          ) : (
            <pre className={`cp-pre${fmt === "md" ? " md" : ""}`}>{exported}</pre>
          )}
        </div>

        <div className="cp-foot">
          <span className="cp-meta">
            {fmt === "thread" ? `${thread.length} 条` : `${chars} 字`}
          </span>
          <span className="cp-note">想按平台风格改写(小红书种草 / 知乎论证)?去「多平台创作」生成</span>
          <div className="cp-actions">
            <button type="button" className="btn sm" onClick={dl} disabled={!content}>
              <Download size={12} /> 下载
            </button>
            <button type="button" className="btn primary sm" onClick={copy} disabled={!content}>
              <Copy size={12} /> 复制
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
