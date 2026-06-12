"use client"

/**
 * StreamFollowChip — 流式画布「↓ 回到最新」浮钮。
 *
 * 用户在流式期间往上回读(解除贴底跟随)时出现,点一下跳回正在生成的最新位置并恢复跟随。
 * 用 position: sticky 钉在滚动容器可视区底部 —— 作为滚动容器的最后一个子元素渲染即可,
 * 不依赖父容器 position,工作台 / 编辑器 / 剧场三处共用。配 hooks/use-stick-to-bottom。
 */
import * as React from "react"
import "./stream-follow-chip.css"

export function StreamFollowChip({ show, onJump }: { show: boolean; onJump: () => void }) {
  if (!show) return null
  return (
    <div className="stream-follow">
      <button type="button" className="stream-follow-btn" onClick={onJump}>
        <span className="stream-follow-arrow" aria-hidden>↓</span>
        回到最新
      </button>
    </div>
  )
}
