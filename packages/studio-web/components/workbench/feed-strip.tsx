"use client"

// ============================================================================
// FeedStrip —— 工作台顶部的站长动态条。
// 显示「最新 pinned 或最新一条」动态:类型徽 + 标题 + 一句话 + 「查看」(外链);
// 可关闭(只关本条,记 localStorage);多条时可展开成小列表看全部。
// 暖纸柔紫、克制不喧宾;无动态 / 桌面单机 / 当前条已被关 → 整条不渲染。
// 数据走全站单一源 useFeed(与顶栏铃铛共享缓存)。本组件不直接拉接口。
// ============================================================================

import * as React from "react"
import { ChevronDown, ExternalLink, Megaphone, Pin, X } from "lucide-react"
import { useFeed } from "@/lib/use-feed"
import type { FeedItem, FeedType } from "@/lib/api/feed"
import "./feed-strip.css"

const TYPE_LABEL: Record<FeedType, string> = {
  update: "更新",
  article: "文章",
  product: "新品",
}

function oneLine(text: string, max = 88): string {
  const flat = (text || "").replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function FeedStrip() {
  const { enabled, items, dismissedIds, dismiss, markSeen } = useFeed()
  const [expanded, setExpanded] = React.useState(false)
  const wrapRef = React.useRef<HTMLDivElement>(null)

  // 展开层:点外面 / Esc 收起
  React.useEffect(() => {
    if (!expanded) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setExpanded(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false) }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [expanded])

  // 展示候选:排除已被本地关闭的条;后端已按 pinned 置顶 + 新在前排好,取第一条即"最新 pinned 或最新"
  const visible = React.useMemo(
    () => items.filter((it) => !dismissedIds.has(it.id)),
    [items, dismissedIds],
  )
  const lead = visible[0]

  // 标记已读 = 用户对广播的「真实动作」(点开链接 / 展开看全部),不是被动看见就清。
  // 被动渲染即 markSeen 会让顶栏铃铛的未读红点在每次进工作台时瞬清——未读提醒就形同虚设;
  // 红点必须撑到用户实际理睬这条广播为止(铃铛点开同样清,二者一致)。
  const seenOnceRef = React.useRef(false)
  const engage = React.useCallback(() => {
    if (seenOnceRef.current) return
    seenOnceRef.current = true
    void markSeen()
  }, [markSeen])

  if (!enabled || !lead) return null

  const moreCount = visible.length - 1
  // 去重:不少动态 title 与 body 填了同一句,显两遍既丑又占地方 —— 一样就只留标题。
  const leadSub = oneLine(lead.body || "")
  const showSub = leadSub.length > 0 && leadSub !== (lead.title || "").trim()

  return (
    <div className="feed-strip-wrap" ref={wrapRef}>
      <div className={`feed-strip type-${lead.type}`} role="status" aria-label="站长动态">
        <span className="feed-strip-ico" aria-hidden>
          {lead.pinned ? <Pin size={13} /> : <Megaphone size={13} />}
        </span>
        <span className={`feed-strip-tag tag-${lead.type}`}>{TYPE_LABEL[lead.type]}</span>
        <span className="feed-strip-body">
          <strong className="feed-strip-title">{lead.title}</strong>
          {showSub && <span className="feed-strip-sub">{leadSub}</span>}
        </span>
        <div className="feed-strip-actions">
          {lead.link && (
            <a
              className="feed-strip-link"
              href={lead.link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={engage}
            >
              查看 <ExternalLink size={12} />
            </a>
          )}
          {moreCount > 0 && (
            <button
              type="button"
              className={`feed-strip-more${expanded ? " open" : ""}`}
              onClick={() => {
                engage()
                setExpanded((o) => !o)
              }}
              aria-expanded={expanded}
              title="查看全部动态"
            >
              还有 {moreCount} 条 <ChevronDown size={12} />
            </button>
          )}
          <button
            type="button"
            className="feed-strip-close"
            onClick={() => dismiss(lead.id)}
            aria-label="关闭这条动态"
            title="关闭(只关本条)"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {expanded && moreCount > 0 && (
        <div className="feed-pop" role="dialog" aria-label="全部站长动态">
          <div className="feed-pop-head">
            <Megaphone size={13} />
            <span>编辑部动态</span>
            <span className="feed-pop-count">{visible.length}</span>
          </div>
          <div className="feed-pop-list scroll-thin">
            {visible.map((it) => (
              <FeedPopRow key={it.id} item={it} onDismiss={() => dismiss(it.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function FeedPopRow({ item, onDismiss }: { item: FeedItem; onDismiss: () => void }) {
  return (
    <div className={`feed-pop-row type-${item.type}`}>
      <span className="feed-pop-row-top">
        <span className={`feed-strip-tag tag-${item.type}`}>{TYPE_LABEL[item.type]}</span>
        {item.pinned && <Pin size={11} className="feed-pop-pin" aria-label="置顶" />}
        <strong className="feed-pop-title">{item.title}</strong>
        <span className="feed-pop-date">{fmtDate(item.createdAt)}</span>
        <button
          type="button"
          className="feed-pop-close"
          onClick={onDismiss}
          aria-label="关闭这条动态"
          title="关闭(只关本条)"
        >
          <X size={12} />
        </button>
      </span>
      {item.body && <p className="feed-pop-body">{oneLine(item.body, 140)}</p>}
      {item.link && (
        <a className="feed-pop-link" href={item.link} target="_blank" rel="noopener noreferrer">
          查看 <ExternalLink size={11} />
        </a>
      )}
    </div>
  )
}
