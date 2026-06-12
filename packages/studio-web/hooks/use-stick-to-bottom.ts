"use client"

/**
 * 流式画布「贴底跟随」—— 工作台写作器 / 编辑器 / 剧场三处共用。
 *
 * 行为契约:
 *   · 用户本就贴底(距底 < 80px)时,内容增长自动钉底跟随;
 *   · 用户向上回读即解除跟随,绝不再拽回(修:流式期间每 24ms 无条件滚底,完全无法回读);
 *   · 用户滚回底部、或点「回到最新」浮钮 → 恢复跟随;
 *   · 新一轮流式开始(active 上升沿)恢复跟随,上一轮的回读状态不粘到下一章。
 *
 * 实现要点:贴底判定在 scroll 事件里采样(内容写入「之前」的位置)——若在钉底 effect 里读,
 * 彼时 scrollHeight 已长高,永远判不贴底。程序性钉底落点就是底部,scroll 回调重算后跟随不变,
 * 无需区分「程序滚动 / 用户滚动」。滚动容器可能随视图切换条件渲染(剧场 full/mini),
 * 监听器按「当前元素」惰性绑定,元素一换就重绑。
 */
import * as React from "react"

const NEAR_BOTTOM_PX = 80

export function useStickToBottom(
  ref: React.RefObject<HTMLElement | null>,
  dep: unknown,
  active: boolean,
): { following: boolean; jumpToBottom: () => void } {
  const [following, setFollowing] = React.useState(true)
  const followingRef = React.useRef(true)
  const boundRef = React.useRef<HTMLElement | null>(null)
  const cleanupRef = React.useRef<(() => void) | null>(null)

  const setFollow = React.useCallback((v: boolean) => {
    followingRef.current = v
    setFollowing((prev) => (prev === v ? prev : v))
  }, [])

  // 惰性绑定:容器元素一变(条件渲染 / 视图切换重挂载)就重挂监听
  const bind = React.useCallback(() => {
    const el = ref.current
    if (boundRef.current === el) return
    cleanupRef.current?.()
    boundRef.current = el
    if (!el) {
      cleanupRef.current = null
      return
    }
    const onScroll = () => {
      setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    cleanupRef.current = () => el.removeEventListener("scroll", onScroll)
  }, [ref, setFollow])

  React.useEffect(() => () => {
    cleanupRef.current?.()
    cleanupRef.current = null
    boundRef.current = null
  }, [])

  // 新一轮流式开始 → 恢复跟随
  React.useEffect(() => {
    if (active) setFollow(true)
  }, [active, setFollow])

  // 内容增长 → 仅在「跟随中」钉底
  React.useEffect(() => {
    bind()
    const el = ref.current
    if (!el || !active || !followingRef.current) return
    el.scrollTop = el.scrollHeight
  }, [dep, active, bind, ref])

  const jumpToBottom = React.useCallback(() => {
    bind()
    const el = ref.current
    if (!el) return
    setFollow(true)
    el.scrollTop = el.scrollHeight
  }, [bind, ref, setFollow])

  return { following, jumpToBottom }
}
