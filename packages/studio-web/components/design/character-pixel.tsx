/**
 * CharacterPixel — 通用角色像素头像(无特定 role,只看 color)。
 *
 * 跟 AgentPixel 同一套设计语言:16×16,crispEdges,简短头身剪影。
 * 用于 /knowledge 网络节点、/characters roster chip 等"不属于 17 编辑部"的角色。
 *
 * 与 AgentPixel 区别:
 *  - AgentPixel:每个 id 一个专属道具(笔/镜/十字...)
 *  - CharacterPixel:统一头身,只换 body 主色,头发可选色
 */

import * as React from "react"

const SKIN = "#F5D3A8"
const BLUSH = "#F3A8A0"
const INK = "#2B2620"   // = design.css --pixel-ink 暖棕墨

export function CharacterPixel({
  color,
  hairColor = "#3A2E20",
  size = 24,
  className,
  ariaLabel,
}: {
  color: string         // 衣服 / faction 主色
  hairColor?: string    // 头发色,默认深棕
  size?: number
  className?: string
  ariaLabel?: string
}) {
  // 16x16 grid:头(2-5 行)→ 脸(5-7)→ 脖子(8)→ 衣服(9-13)→ 手臂左右
  // 字符 → 颜色 / 透明: . = 透明, # = INK, S = SKIN, B = BLUSH, H = 头发, C = body color
  const grid = [
    "................",
    "................",
    "......####......",
    ".....HHHHHH.....",
    "....HHHSSSHH....",
    "....#SSSSS#H....",
    "....#SSSSS#H....",
    "....#SSBSS#.....",
    ".....#SSSS#.....",
    "......####......",
    "....##CCCC##....",
    "...#CCCCCCCC#...",
    "..#CCCCCCCCCC#..",
    "..#CC######CC#..",
    "..#CC#....#CC#..",
    "..####....####..",
  ]
  const colorOf = (ch: string): string | null => {
    if (ch === ".") return null
    if (ch === "#") return INK
    if (ch === "S") return SKIN
    if (ch === "B") return BLUSH
    if (ch === "H") return hairColor
    if (ch === "C") return color
    return null
  }
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      role={ariaLabel ? "img" : "presentation"}
      aria-label={ariaLabel}
      style={{ shapeRendering: "crispEdges", imageRendering: "pixelated", display: "block" }}
    >
      {grid.map((row, y) =>
        Array.from(row).map((ch, x) => {
          const c = colorOf(ch)
          if (!c) return null
          return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={c} />
        }),
      )}
    </svg>
  )
}
