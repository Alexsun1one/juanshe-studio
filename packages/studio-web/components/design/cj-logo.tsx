import * as React from "react"

/**
 * 卷舍 像素 Logo —— 翻开的书 + 斜插一支羽毛笔(16×16 网格)。
 * 全站唯一品牌标:侧栏、登录页、favicon(public/juanshe-logo.svg)同源。
 * 字符 → 颜色:# 描边深紫 / 0 书脊品牌紫 / 1 书页米白 / 2 笔杆暖橙 / 3 笔尖金。
 */
const GRID: ReadonlyArray<string> = [
  "................",
  ".............##.",
  "............#33#",
  "...........#332#",
  "..........#3322#",
  ".........#33222#",
  "........#332222#",
  ".####.##332222#.",
  "#0111##322222#..",
  "#011111#2222#...",
  "#0111111#22#....",
  "#01111111##.....",
  "#0##1##1##......",
  "#000000000#.....",
  ".##########.....",
  "................",
]

function colorOf(ch: string): string | null {
  switch (ch) {
    case "#": return "#1F2433"
    case "0": return "#6E5BFA"
    case "1": return "#FFFAF0"
    case "2": return "#F8C994"
    case "3": return "#FFD66A"
    default: return null
  }
}

export function CjLogo({ size = 28, className }: { size?: number; className?: string }) {
  const rects: React.ReactElement[] = []
  GRID.forEach((row, y) =>
    Array.from(row).forEach((ch, x) => {
      const c = colorOf(ch)
      if (c) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={c} />)
    }),
  )
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      style={{ shapeRendering: "crispEdges", imageRendering: "pixelated", display: "block" }}
      aria-hidden="true"
    >
      {rects}
    </svg>
  )
}
