"use client"

// ============================================================================
// useFeed —— 站长广播 Feed 的全站单一数据源(SWR 轮询 /feed)。
// 工作台动态条、顶栏小铃铛红点都消费这个 hook,共享同一份缓存与未读计数。
// 设计取舍:
//  · 适度轮询 60s,不新增重型通道(SSE/WS),feed 是低频广播,轮询足矣;
//  · 桌面单机模式后端返回 saas:false → enabled=false,调用方据此整条不渲染;
//  · 标记已读乐观更新本地缓存(unread→0)再后台 revalidate,点开即清红点不闪;
//  · 关闭某条动态记在 localStorage(只关本条),与"已读"语义解耦——关了仍算读过;
//  · 可选系统通知:仅当浏览器已授权 + 用户已在 settings 开过任一通知 + document.hidden
//    时,对"新出现的动态"轻提示一次,绝不主动请求权限、绝不过度打扰。
// ============================================================================

import * as React from "react"
import useSWR from "swr"
import { fetchFeed, markFeedSeen, type FeedItem, type FeedResult } from "@/lib/api/feed"
import { useProjectPrefs } from "@/hooks/use-studio"

const FEED_KEY = "/api/v1/feed"
const POLL_MS = 60_000
const DISMISSED_LS_KEY = "cj.feed.dismissed" // 用户手动关闭的动态 id 列表
const NOTIFIED_LS_KEY = "cj.feed.notified"   // 已系统通知过的动态 id(跨刷新去重)
const BRAND_ICON = "/brand/brand-icon.png"

function readIdSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(key)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.map(String) : [])
  } catch {
    return new Set()
  }
}

function writeIdSet(key: string, set: Set<string>) {
  if (typeof window === "undefined") return
  try {
    // 上限保护:只留最近 200 个 id,避免无限增长
    const arr = Array.from(set).slice(-200)
    window.localStorage.setItem(key, JSON.stringify(arr))
  } catch {
    /* ignore — 隐私模式 / 配额满时静默 */
  }
}

export type UseFeed = {
  /** SaaS 模式且后端可达;false 时调用方应整条不渲染(桌面单机 = false) */
  enabled: boolean
  /** 已排序的全部动态(pinned 置顶 + 新在前,后端已排好) */
  items: FeedItem[]
  /** 当前用户未读数 */
  unreadCount: number
  loading: boolean
  /** 用户本地关闭过的动态 id(只影响工作台动态条,不影响"已读") */
  dismissedIds: Set<string>
  /** 关闭工作台某条动态(只关本条,记 localStorage) */
  dismiss: (id: string) => void
  /** 标记全部已读(清未读红点);乐观更新本地缓存 */
  markSeen: () => Promise<void>
  /** 手动重拉 */
  refresh: () => void
}

export function useFeed(): UseFeed {
  const { data, isLoading, mutate } = useSWR<FeedResult>(FEED_KEY, fetchFeed, {
    refreshInterval: POLL_MS,
    revalidateOnFocus: true,
    // 401/桌面 saas:false 都不是"错误重试"场景;别狂刷
    shouldRetryOnError: false,
    dedupingInterval: 10_000,
  })
  const { data: prefs } = useProjectPrefs()

  const enabled = Boolean(data?.saas)
  const items = React.useMemo(() => (enabled ? data?.items ?? [] : []), [enabled, data?.items])
  const unreadCount = enabled ? data?.unreadCount ?? 0 : 0

  // 本地关闭集:挂载后读,关闭时即时更新内存 + 落盘
  const [dismissedIds, setDismissedIds] = React.useState<Set<string>>(() => new Set())
  React.useEffect(() => {
    setDismissedIds(readIdSet(DISMISSED_LS_KEY))
  }, [])
  const dismiss = React.useCallback((id: string) => {
    setDismissedIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      writeIdSet(DISMISSED_LS_KEY, next)
      return next
    })
  }, [])

  const markSeen = React.useCallback(async () => {
    if (!enabled) return
    // 乐观:先把未读清零(红点立刻消失),失败再 revalidate 回真值
    try {
      await mutate(
        async (cur) => {
          await markFeedSeen()
          // 不写权威数据进缓存,交给随后的 revalidate 取真值;先回当前避免类型空洞
          return cur
        },
        {
          optimisticData: (cur) =>
            cur ? { ...cur, unreadCount: 0 } : { saas: true, items: [], unreadCount: 0, feedSeenAt: null },
          rollbackOnError: true,
          populateCache: false,
          revalidate: true,
        },
      )
    } catch {
      /* 网络抖动:红点保持,下次轮询自愈 */
    }
  }, [enabled, mutate])

  const refresh = React.useCallback(() => {
    void mutate()
  }, [mutate])

  // ── 可选系统通知:新动态 + 已授权 + 用户开过任一通知 + 页面不可见 时,轻提示一次 ──
  // 复用 use-run-notifications 的克制模式:绝不主动请求权限,任何环境缺口(WebView/iOS)静默吞掉。
  const anyNotifyOn = Boolean(
    prefs?.notify && (prefs.notify.onChapterDone || prefs.notify.onRunFailed || prefs.notify.onLowQuality),
  )
  // 首拍基线:不对"打开页面时已存在的动态"补发历史通知,只对此后新出现的提示
  const seededRef = React.useRef(false)
  React.useEffect(() => {
    if (!enabled || items.length === 0) return
    if (typeof window === "undefined" || !("Notification" in window)) return

    const notified = readIdSet(NOTIFIED_LS_KEY)
    // 第一拍:把当前所有 id 视为已知基线,不通知
    if (!seededRef.current) {
      seededRef.current = true
      let changed = false
      for (const it of items) {
        if (!notified.has(it.id)) {
          notified.add(it.id)
          changed = true
        }
      }
      if (changed) writeIdSet(NOTIFIED_LS_KEY, notified)
      return
    }

    if (!anyNotifyOn || Notification.permission !== "granted") return

    // 找此后新增、且页面不可见时尚未通知过的动态(取最新一条,避免一次轰炸多条)
    const fresh = items.filter((it) => !notified.has(it.id))
    if (fresh.length === 0) return
    for (const it of fresh) notified.add(it.id)
    writeIdSet(NOTIFIED_LS_KEY, notified)

    if (!document.hidden) return // 用户正看着页面,动态条已可见,不必再系统打扰
    const latest = fresh[0]
    try {
      const n = new Notification("卷舍有新动态", {
        body: latest.title.slice(0, 80),
        icon: BRAND_ICON,
        tag: `cj-feed-${latest.id}`,
      })
      n.onclick = () => {
        try { window.focus() } catch { /* ignore */ }
        n.close()
      }
    } catch {
      /* 部分 WebView 对 new Notification 直接抛 —— 静默 */
    }
  }, [enabled, items, anyNotifyOn])

  return {
    enabled,
    items,
    unreadCount,
    loading: isLoading,
    dismissedIds,
    dismiss,
    markSeen,
    refresh,
  }
}
