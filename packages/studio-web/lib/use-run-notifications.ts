"use client"

/**
 * 挂机连写的「离开页面感知通道」—— settings 三个通知开关(prefs.notify)的唯一消费者。
 * ① 标签页标题:运行中改成「✍ 第X章 写作中 · 卷舍」,空闲/卸载可靠还原(零权限,所有浏览器生效);
 * ② 系统通知:document.hidden 时按三开关分别推「章节完成(章题+字数)/ 运行失败(错误摘要)/
 *    评分低于阈值」,icon 用品牌图,点击聚焦回窗口;
 * ③ 权限按需请求:任务启动且任一开关打开时才问(用户此刻大概率在页面上),
 *    被拒 / 不支持(iOS Safari)静默降级为仅标题变化,绝不报错。
 * 由 (cj) layout 经 <RunNotificationsBridge /> 挂载一次,全站生效。
 */
import * as React from "react"
import { useWorkspace } from "@/lib/workspace-context"
import { useRunState } from "@/lib/use-run-state"
import { useProjectPrefs } from "@/hooks/use-studio"
import { fetchChapters } from "@/lib/api/client"
import { subscribeSharedAgentEvents } from "@/lib/agent-event-stream"

const TITLE_MARK = "✍ "
const BRAND_ICON = "/brand/brand-icon.png"
// SSE 连接会回放最近事件;只认事件自身时间戳足够新的,避免历史评分误报(与 use-live-run 同口径)
const FRESH_MS = 25_000

/** 仅在用户看不见页面且已授权时打扰;任何环境缺口(WebView/iOS)都静默吞掉 */
function pushSystemNotification(title: string, body: string, tag: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return
  if (!document.hidden || Notification.permission !== "granted") return
  try {
    const n = new Notification(title, { body, icon: BRAND_ICON, tag })
    n.onclick = () => {
      try { window.focus() } catch { /* ignore */ }
      n.close()
    }
  } catch { /* ignore — 部分 WebView 对 new Notification 直接抛 */ }
}

/** activeRun.chapter 偶尔缺失,从阶段文案「第 4 章重写中」兜底解析章号 */
function stageChapter(stage: string | undefined): number | undefined {
  const m = stage?.match(/第\s*(\d+)\s*章/)
  return m ? Number(m[1]) : undefined
}

export function useRunNotifications() {
  const { bookId } = useWorkspace()
  const run = useRunState(bookId || undefined)
  const { data: prefs } = useProjectPrefs()

  const notify = prefs?.notify
  const threshold = prefs?.defaultRun.targetQuality
  const rawChapter = run.activeRun?.chapter ?? stageChapter(run.currentStage)
  const chapter = typeof rawChapter === "number" && rawChapter > 0 ? rawChapter : undefined

  // ① 标签页标题:写作中可感知;空闲恢复进入前的标题(只还原自己写的,不踩别人改的标题)
  const baseTitleRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (run.isRunning) {
      if (!document.title.startsWith(TITLE_MARK)) baseTitleRef.current = document.title
      document.title = chapter
        ? `${TITLE_MARK}第${chapter}章 写作中 · 卷舍`
        : `${TITLE_MARK}写作中 · 卷舍`
    } else if (baseTitleRef.current != null && document.title.startsWith(TITLE_MARK)) {
      document.title = baseTitleRef.current
    }
  }, [run.isRunning, chapter])
  React.useEffect(() => () => {
    // 卸载(路由离开 (cj) 组)时可靠还原
    if (baseTitleRef.current != null && document.title.startsWith(TITLE_MARK)) {
      document.title = baseTitleRef.current
    }
  }, [])

  // ② 章节完成:成稿刚入库,拉一次章节列表补「章题+字数」;拉不到就发通用文案
  const notifyChapterDone = React.useCallback((book: string, num: number) => {
    const fallback = "成稿已入库,回来看看吧"
    const tag = `cj-chapter-done-${book}-${num}`
    void fetchChapters(book)
      .then((chapters) => {
        const ch = chapters.find((c) => c.num === num)
        const detail = [ch?.title.zh ? `《${ch.title.zh}》` : "", ch?.words ? `${ch.words} 字` : ""]
          .filter(Boolean)
          .join(" · ")
        pushSystemNotification(`第 ${num} 章完成`, detail || fallback, tag)
      })
      .catch(() => pushSystemNotification(`第 ${num} 章完成`, fallback, tag))
  }, [])

  // 运行状态的「上一拍」,用于识别 启动/章号推进/收尾 三种转变;切书重建基线,绝不补发历史通知
  const prevRef = React.useRef<{
    bookId: string
    running: boolean
    chapter?: number
    lastError?: string
  } | null>(null)
  const askedPermissionRef = React.useRef(false)
  const lowQualityNotifiedRef = React.useRef(new Set<number>())

  React.useEffect(() => {
    const prev = prevRef.current
    prevRef.current = { bookId, running: run.isRunning, chapter, lastError: run.lastError }
    if (!prev || prev.bookId !== bookId) return

    // 启动:清每章去重账本;③ 任一开关打开且权限待定 → 此刻按需请求(被拒静默降级)
    if (!prev.running && run.isRunning) {
      lowQualityNotifiedRef.current = new Set()
      const anyOn = notify && (notify.onChapterDone || notify.onRunFailed || notify.onLowQuality)
      if (
        anyOn &&
        !askedPermissionRef.current &&
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "default"
      ) {
        askedPermissionRef.current = true
        try { void Notification.requestPermission() } catch { /* ignore */ }
      }
      return
    }

    // 连写中章号推进 = 上一章已完成
    if (prev.running && run.isRunning) {
      if (notify?.onChapterDone && prev.chapter && chapter && chapter > prev.chapter) {
        notifyChapterDone(bookId, prev.chapter)
      }
      return
    }

    // 收尾:本次运行新出现的错误 = 失败;否则按最后一章完成处理
    if (prev.running && !run.isRunning) {
      const failed = Boolean(run.lastError && run.lastError !== prev.lastError)
      if (failed && notify?.onRunFailed) {
        const summary = (run.lastError || "").replace(/\s+/g, " ").slice(0, 90)
        pushSystemNotification(
          "写作任务中断",
          summary || "任务失败,回来看看发生了什么",
          `cj-run-failed-${bookId}`,
        )
      } else if (!failed && notify?.onChapterDone && prev.chapter) {
        notifyChapterDone(bookId, prev.chapter)
      }
    }
  }, [bookId, run.isRunning, run.lastError, chapter, notify, notifyChapterDone])

  // 评分低于阈值:judge 的 verdict/audit 事件带分数,阈值取连写默认 targetQuality;
  // 仅运行中订阅(共享 SSE,引用计数,不常驻);每章每次任务至多报一次,返修轮不连环轰炸
  React.useEffect(() => {
    if (!bookId || !run.isRunning || !notify?.onLowQuality || typeof threshold !== "number") return
    return subscribeSharedAgentEvents(bookId, (e) => {
      if (e.type !== "verdict" && e.type !== "audit") return
      if (typeof e.score !== "number" || e.score >= threshold) return
      const ts = e.ts ? Date.parse(e.ts) : NaN
      if (!Number.isFinite(ts) || Date.now() - ts > FRESH_MS) return
      if (!(typeof e.chapter === "number" && e.chapter > 0)) return
      if (lowQualityNotifiedRef.current.has(e.chapter)) return
      lowQualityNotifiedRef.current.add(e.chapter)
      pushSystemNotification(
        `第 ${e.chapter} 章评分低于阈值`,
        `本轮评分 ${Math.round(e.score)} · 目标 ${threshold}`,
        `cj-low-quality-${bookId}-${e.chapter}`,
      )
    })
  }, [bookId, run.isRunning, notify?.onLowQuality, threshold])
}

/** (cj) layout 是服务端组件,不能直接调 hook —— 用这个空渲染桥挂载一次 */
export function RunNotificationsBridge() {
  useRunNotifications()
  return null
}
