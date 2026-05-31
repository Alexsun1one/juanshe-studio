"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { useStudio } from "@/lib/studio-context"
import { RAIL_BOUNDS } from "@/lib/studio-context"

/**
 * 细栏拖拽分隔条 — Claude Desktop 式三栏布局的左右把手。
 *
 * - 拖拽改变对应栏的像素宽度（带边界 clamp + localStorage 持久化）
 * - 双击复位到默认宽度
 * - 键盘可达：聚焦后方向键以 16px 步进，role=separator
 * - 命中区域 6px，视觉只有 1px 细线，hover/拖拽时高亮成主色
 */
export function RailResizer({ side }: { side: "left" | "right" }) {
  const {
    leftWidth,
    rightWidth,
    setLeftWidth,
    setRightWidth,
    leftCollapsed,
    rightCollapsed,
  } = useStudio()
  const width = side === "left" ? leftWidth : rightWidth
  const setWidth = side === "left" ? setLeftWidth : setRightWidth
  const collapsed = side === "left" ? leftCollapsed : rightCollapsed
  const [dragging, setDragging] = React.useState(false)

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = width
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      setDragging(true)

      const prevCursor = document.body.style.cursor
      const prevSelect = document.body.style.userSelect
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"

      const handleMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX
        // 左栏：向右拖变宽；右栏：向左拖变宽
        setWidth(side === "left" ? startW + delta : startW - delta)
      }
      const handleUp = () => {
        setDragging(false)
        document.body.style.cursor = prevCursor
        document.body.style.userSelect = prevSelect
        window.removeEventListener("pointermove", handleMove)
        window.removeEventListener("pointerup", handleUp)
      }
      window.addEventListener("pointermove", handleMove)
      window.addEventListener("pointerup", handleUp)
    },
    [side, setWidth, width],
  )

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 48 : 16
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        setWidth(side === "left" ? width - step : width + step)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        setWidth(side === "left" ? width + step : width - step)
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault()
        setWidth(RAIL_BOUNDS[side].def)
      }
    },
    [side, setWidth, width],
  )

  // 栏折叠时不显示把手（折叠态是固定 48px 图标条）
  if (collapsed) return null

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "拖拽调整左栏宽度" : "拖拽调整右栏宽度"}
      aria-valuenow={width}
      aria-valuemin={RAIL_BOUNDS[side].min}
      aria-valuemax={RAIL_BOUNDS[side].max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setWidth(RAIL_BOUNDS[side].def)}
      title="拖拽调整宽度 · 双击复位"
      className={cn(
        "group relative z-20 hidden w-1.5 shrink-0 cursor-col-resize touch-none md:block",
        "focus-visible:outline-none",
      )}
    >
      {/* 视觉细线 — 默认贴边几乎不可见，hover/拖拽/聚焦时高亮 */}
      <span
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150",
          dragging
            ? "bg-primary"
            : "bg-transparent group-hover:bg-primary/50 group-focus-visible:bg-primary/70",
        )}
      />
    </div>
  )
}
