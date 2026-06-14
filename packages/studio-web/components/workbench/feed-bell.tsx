"use client"

// ============================================================================
// FeedBell —— 顶栏站长动态小铃铛 + 未读红点。
// 与工作台动态条共享 useFeed(同一份 SWR 缓存),点开弹层看全部动态;
// 打开即标记已读(清红点)。桌面单机 / 无动态时整个铃铛不渲染(顶栏不留空壳)。
// 复用 feed-strip.css 的 .feed-pop / .feed-bell 样式,零新依赖。
// ============================================================================

import * as React from "react"
import { Bell, ExternalLink, Megaphone, Pin } from "lucide-react"
import { useFeed } from "@/lib/use-feed"
import type { FeedItem, FeedType } from "@/lib/api/feed"
import "./feed-strip.css"

const TYPE_LABEL: Record<FeedType, string> = {
  update: "更新",
  article: "文章",
  product: "新品",
}

function oneLine(text: string, max = 140): string {
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

export function FeedBell() {
  const { enabled, items, unreadCount, markSeen } = useFeed()
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  // 桌面单机 / 非 SaaS / 接口不可达 → 不渲染铃铛(顶栏保持洁净)
  if (!enabled) return null

  const toggle = () => {
    setOpen((o) => {
      const next = !o
      // 打开即视为看过广播:清未读红点
      if (next && unreadCount > 0) void markSeen()
      return next
    })
  }

  return (
    <div className="feed-bell-wrap" ref={ref}>
      <button
        type="button"
        className={`feed-bell${unreadCount > 0 ? " has-unread" : ""}`}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `站长动态,${unreadCount} 条未读` : "站长动态"}
        title={unreadCount > 0 ? `${unreadCount} 条未读动态` : "站长动态"}
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="feed-bell-dot" aria-hidden>{unreadCount > 99 ? "99+" : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="feed-pop" role="dialog" aria-label="编辑部动态">
          <div className="feed-pop-head">
            <Megaphone size={13} />
            <span>编辑部动态</span>
            {items.length > 0 && <span className="feed-pop-count">{items.length}</span>}
          </div>
          {items.length === 0 ? (
            <div className="feed-pop-empty">暂时还没有动态,编辑部安静着呢。</div>
          ) : (
            <div className="feed-pop-list scroll-thin">
              {items.map((it) => (
                <FeedRow key={it.id} item={it} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function FeedRow({ item }: { item: FeedItem }) {
  return (
    <div className={`feed-pop-row type-${item.type}`}>
      <span className="feed-pop-row-top">
        <span className={`feed-strip-tag tag-${item.type}`}>{TYPE_LABEL[item.type]}</span>
        {item.pinned && <Pin size={11} className="feed-pop-pin" aria-label="置顶" />}
        <strong className="feed-pop-title">{item.title}</strong>
        <span className="feed-pop-date">{fmtDate(item.createdAt)}</span>
      </span>
      {item.body && <p className="feed-pop-body">{oneLine(item.body)}</p>}
      {item.link && (
        <a className="feed-pop-link" href={item.link} target="_blank" rel="noopener noreferrer">
          查看 <ExternalLink size={11} />
        </a>
      )}
    </div>
  )
}
