"use client"

import * as React from "react"
import { StudioProvider } from "@/lib/studio-context"
import { BreathingBg } from "@/components/studio/breathing-bg"
import { TopBar } from "@/components/studio/top-bar"
import { LeftRail } from "@/components/studio/left-rail"
import { RailResizer } from "@/components/studio/rail-resizer"
import { RightRail } from "@/components/studio/right-rail"
import { Stepper } from "@/components/studio/stepper"
import { AssistantBar } from "@/components/studio/assistant-bar"
import { EventBridge } from "@/components/studio/event-bridge"

/**
 * 持久三栏外壳 — 参考设计工具：左右栏常驻、可拖拽，
 * 点导航只替换中间区域（{children} 为当前路由内容）。
 *
 * 顶栏 / 左菜单栏 / 右面板 / 底部 Dock 跨路由保持不变，
 * 浏览器 URL / 前进后退 / 深链 / 刷新定位全部保留。
 */
export function StudioShell({ children }: { children: React.ReactNode }) {
  return (
    <StudioProvider>
      {/* SSE 事件 → SWR 缓存桥（无 UI） */}
      <EventBridge />

      {/* 背景呼吸层 */}
      <BreathingBg />

      <div className="relative flex h-dvh min-h-0 flex-col overflow-hidden">
        {/* 顶部导航 + Stepper（常驻） */}
        <TopBar />

        {/* 三列主体 — 左/右细栏可拖拽，中央随路由切换 */}
        <div className="flex min-h-0 flex-1 overflow-hidden pb-[76px]">
          {/* 左：章节树 / 角色 / 世界观 / 素材（常驻 + 可拖拽） */}
          <LeftRail />
          <RailResizer side="left" />

          {/* 中央：浅灰画布上的圆角卡片（仿参考设计工具的画板）。
              顶部 gutter 居中悬浮工作流工具条；内层卡片裁剪滚动，路由内容自适应填满。 */}
          <div className="bg-muted/40 relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-2.5 pb-2.5 pt-2">
            {/* 中央悬浮工具条（仿参考设计工具的浮动工具栏） */}
            <div className="flex shrink-0 justify-center pb-2">
              <Stepper />
            </div>
            <div className="bg-card border-border shadow-sm relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border">
              {children}
            </div>
          </div>

          {/* 右：工作流 / AI 阵列 / 记忆 / 图谱 / 剧情 / 洞察（常驻 + 可拖拽） */}
          <RailResizer side="right" />
          <RightRail />
        </div>

        {/* 全局底部常驻 AI 对话栏 —— 每个功能页都在，可直接改任何东西 */}
        <AssistantBar />
      </div>
    </StudioProvider>
  )
}
