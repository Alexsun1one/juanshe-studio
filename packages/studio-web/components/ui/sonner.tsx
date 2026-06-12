'use client'

import { useTheme } from 'next-themes'
import { Toaster as Sonner, ToasterProps } from 'sonner'

// 5×5 像素星 —— 成功 toast 的图标,与 celebration-burst 的星徽同形
// (那边是局部组件不归本流改造,先各自持有这 5 行点阵;颜色走 design.css 的 [data-icon] 着色)。
function PixelStar() {
  const cells = [[2], [1, 2, 3], [0, 1, 2, 3, 4], [1, 2, 3], [0, 2, 4]]
  return (
    <svg viewBox="0 0 5 5" width="16" height="16" aria-hidden="true" shapeRendering="crispEdges">
      {cells.flatMap((row, y) => row.map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="currentColor" />))}
    </svg>
  )
}

// 全站唯一 toast 通道(挂在根布局)。皮肤主体在 design.css 的 [data-sonner-toast] 块:
// 暖纸卡 + 像素 UI 字 + 语义色图标;这里只配位置/间距/图标与基础色变量。
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      position="bottom-right"
      offset={18}
      gap={10}
      icons={{ success: <PixelStar /> }}
      style={
        {
          '--normal-bg': 'var(--bg-card)',
          '--normal-text': 'var(--ink-800)',
          '--normal-border': 'var(--line-2)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
