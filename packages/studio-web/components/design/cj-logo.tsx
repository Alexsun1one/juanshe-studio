import * as React from "react"

/**
 * 全站统一品牌标:使用 ImageGen 生成的像素书本 + 羽毛笔资产。
 * 这样侧栏、登录页、favicon/png 图标和 README 主视觉里的书本语言保持一致。
 */
export function CjLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/brand/props/logo-book-quill.webp"
      alt=""
      width={size}
      height={size}
      className={className ? `cj-logo-img ${className}` : "cj-logo-img"}
      draggable={false}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        display: "block",
        objectFit: "contain",
        imageRendering: "pixelated",
      }}
    />
  )
}
