/**
 * BrandPixel — 「卷 · 编辑部」品牌 logo,像素风。
 *
 * 构图:
 *   - 一摞 3 本书(品牌渐变三色)
 *   - 顶上斜插一根羽毛笔(暖橙笔尖蘸墨)
 *   - 右上角飘一个微小的红印章
 *
 * 20x20 viewBox,放大到任意尺寸都保持 crispEdges。
 */

import * as React from "react"

const INK = "#1A1F2E"
const BOOK_HI = "#9D8AFF"   // 顶层书:亮紫
const BOOK_MD = "#6E5BFA"   // 中层书:品牌紫
const BOOK_LO = "#4A38C7"   // 底层书:深紫
const QUILL = "#F8C994"     // 羽毛笔:暖橙
const QUILL_DK = "#C66E2F"  // 羽毛深色
const SEAL = "#E04848"      // 印章红
const PAGE = "#FFF5DA"      // 书页米色

// 20x20 grid:
//   . = 透明  # = INK  P = 书页  H = 上书亮紫  M = 中书紫  L = 底书深紫
//   Q = 羽毛暖橙  D = 羽毛深色  S = 印章红  W = 高光白
const GRID = [
  "....................",
  ".................Q..",
  "................QQ..",
  "...............QQDQ.",
  "..............QQDQ..",
  ".............QDDQ...",
  "..........#######...",
  "..........#HHHHH#...",
  ".........##HHHHH#...",
  ".........#PPPPP##...",
  ".........##MMMMM#SS.",
  "........##MMMMMM#SS.",
  "........#PPPPPPP##S.",
  "........##LLLLLL#...",
  ".......##LLLLLLLL#..",
  ".......#PPPPPPPPP#..",
  ".......###########..",
  "....................",
  "....................",
  "....................",
]

const COLOR_MAP: Record<string, string> = {
  "#": INK,
  "H": BOOK_HI,
  "M": BOOK_MD,
  "L": BOOK_LO,
  "P": PAGE,
  "Q": QUILL,
  "D": QUILL_DK,
  "S": SEAL,
  "W": "#FFFFFF",
}

export function BrandPixel({
  size = 28,
  className,
  ariaLabel = "卷 · 编辑部",
}: {
  size?: number
  className?: string
  ariaLabel?: string
}) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={ariaLabel}
      style={{ shapeRendering: "crispEdges", imageRendering: "pixelated", display: "block" }}
    >
      {GRID.map((row, y) =>
        Array.from(row).map((ch, x) => {
          const c = COLOR_MAP[ch]
          if (!c) return null
          return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={c} />
        }),
      )}
    </svg>
  )
}
