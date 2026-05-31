"use client"

/**
 * 静态氛围背景层。
 * 流式写作时主线程预算要优先给正文和状态台，避免大面积模糊层持续动画。
 */
export function BreathingBg() {
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden
    >
      {/* 噪点纸纹 */}
      <div
        className="absolute inset-0 opacity-[0.025] mix-blend-overlay"
        style={{
          backgroundImage:
            "radial-gradient(circle at 25% 25%, currentColor 1px, transparent 1px), radial-gradient(circle at 75% 75%, currentColor 1px, transparent 1px)",
          backgroundSize: "32px 32px, 24px 24px",
        }}
      />
    </div>
  )
}
