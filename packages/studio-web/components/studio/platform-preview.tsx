"use client"

import * as React from "react"
import { Heart, MessageCircle, Star, Repeat2, Share } from "lucide-react"

/** markdown → 结构化块,供各平台按自己的版式渲染(所见即所得)。 */
type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "ul"; items: string[] }

function parseBlocks(md: string): Block[] {
  const out: Block[] = []
  let list: string[] = []
  const flush = () => { if (list.length) { out.push({ kind: "ul", items: list }); list = [] } }
  for (const raw of (md || "").split("\n")) {
    const t = raw.trim()
    if (!t) { flush(); continue }
    if (t.startsWith("### ")) { flush(); out.push({ kind: "h2", text: t.slice(4) }) }
    else if (t.startsWith("## ")) { flush(); out.push({ kind: "h2", text: t.slice(3) }) }
    else if (t.startsWith("# ")) { flush(); out.push({ kind: "h1", text: t.slice(2) }) }
    else if (t.startsWith("> ")) { flush(); out.push({ kind: "quote", text: t.slice(2) }) }
    else if (t.startsWith("- ") || t.startsWith("* ")) { list.push(t.slice(2)) }
    else { flush(); out.push({ kind: "p", text: t }) }
  }
  flush()
  return out
}

/** 行内 **加粗** → <strong>。 */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <React.Fragment key={i}>{p}</React.Fragment>,
  )
}

const firstHeading = (blocks: Block[]) => blocks.find((b) => b.kind === "h1" || b.kind === "h2") as { text: string } | undefined
const extractTags = (md: string) => [...new Set((md.match(/#[^\s#，。,.]{1,18}/g) || []).map((s) => s.replace(/^#/, "")))].slice(0, 8)

export function PlatformPreview({ platform, markdown }: { platform: string; markdown: string }) {
  const blocks = React.useMemo(() => parseBlocks(markdown), [markdown])
  const tags = React.useMemo(() => extractTags(markdown), [markdown])
  const chars = markdown.replace(/\s/g, "").length

  // —— 公众号:手机版深度长文 ——
  if (platform === "wechat_article") {
    const title = firstHeading(blocks)?.text ?? "未命名文章"
    const body = blocks.filter((b) => b !== firstHeading(blocks))
    return (
      <div className="pp pp-wechat">
        <div className="pp-phone">
          <div className="ppw-bar"><span className="ppw-back">‹</span><span className="ppw-acct">公众号</span><span className="ppw-more">···</span></div>
          <div className="ppw-scroll">
            <h1 className="ppw-title">{title}</h1>
            <div className="ppw-meta"><span className="ppw-av">编</span><span className="ppw-name">AI 编辑部</span><span className="ppw-date">今天</span></div>
            <article className="ppw-body">{body.map((b, i) => <BlockView key={i} b={b} />)}</article>
            <div className="ppw-foot">{chars} 字 · 由 AI 编辑部排版</div>
          </div>
        </div>
      </div>
    )
  }

  // —— 小红书:手机笔记卡 ——
  if (platform === "xiaohongshu_note") {
    const title = firstHeading(blocks)?.text ?? (blocks.find((b) => b.kind === "p") as { text: string })?.text?.slice(0, 20) ?? "笔记"
    const body = blocks.filter((b) => b.kind !== "h1" && b.kind !== "h2")
    return (
      <div className="pp pp-xhs">
        <div className="pp-phone xhs">
          <div className="ppx-cover"><span className="ppx-cover-t">{title}</span></div>
          <div className="ppx-scroll">
            <h2 className="ppx-title">{title}</h2>
            <div className="ppx-body">{body.map((b, i) => <BlockView key={i} b={b} compact />)}</div>
            {tags.length > 0 && <div className="ppx-tags">{tags.map((t) => <span key={t} className="ppx-tag">#{t}</span>)}</div>}
          </div>
          <div className="ppx-actions">
            <span><Heart size={15} /> 1.2k</span><span><Star size={15} /> 收藏</span><span><MessageCircle size={15} /> 评论</span>
          </div>
        </div>
      </div>
    )
  }

  // —— X / Twitter:推文串 ——
  if (platform === "x_thread") {
    const tweets = splitThread(markdown)
    return (
      <div className="pp pp-x">
        {tweets.map((tw, i) => (
          <div className="ppt" key={i}>
            <div className="ppt-av">编</div>
            <div className="ppt-main">
              <div className="ppt-head"><b>AI 编辑部</b> <span className="ppt-handle">@ai_editorial · {i + 1}/{tweets.length}</span></div>
              <div className="ppt-text">{tw.split("\n").map((l, j) => <p key={j}>{inline(l)}</p>)}</div>
              <div className="ppt-acts"><span><MessageCircle size={13} /></span><span><Repeat2 size={13} /></span><span><Heart size={13} /></span><span><Share size={13} /></span></div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // —— 知乎 / Newsletter / 其它:洁净文章版 ——
  return (
    <div className={`pp pp-article ${platform === "zhihu_answer" ? "zhihu" : ""}`}>
      <div className="ppa-meta"><span className="ppa-av">编</span><span className="ppa-name">AI 编辑部</span><span className="ppa-sub">{platform === "zhihu_answer" ? "知乎回答" : "Newsletter"}</span></div>
      <article className="ppa-body">{blocks.map((b, i) => <BlockView key={i} b={b} />)}</article>
    </div>
  )
}

function BlockView({ b, compact }: { b: Block; compact?: boolean }) {
  switch (b.kind) {
    case "h1": return <h1>{inline(b.text)}</h1>
    case "h2": return <h2>{inline(b.text)}</h2>
    case "quote": return <blockquote>{inline(b.text)}</blockquote>
    case "ul": return <ul className={compact ? "compact" : ""}>{b.items.map((it, i) => <li key={i}>{inline(it)}</li>)}</ul>
    default: return <p>{inline(b.text)}</p>
  }
}

/** X 串:按空行/段落切成若干推文,合并到 ~270 字符以内。 */
function splitThread(md: string): string[] {
  const paras = md.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const tweets: string[] = []
  let cur = ""
  for (const p of paras) {
    const clean = p.replace(/^#{1,3}\s+/, "").replace(/\*\*/g, "")
    if ((cur + "\n" + clean).length > 270 && cur) { tweets.push(cur); cur = clean }
    else cur = cur ? `${cur}\n${clean}` : clean
  }
  if (cur) tweets.push(cur)
  return tweets.length ? tweets : [md]
}
