"use client"

import * as React from "react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

/**
 * 全局统一抽屉 —— 所有重面板（AI 助手、工作流与控制、图谱/曲线全量等）
 * 都走这一个组件：一致的右侧滑出、宽度档位、粘性标题、滚动体。
 *
 * 设计契约（资产统一）：
 * - side 固定 right；宽度只有三档 sm/md/lg
 * - 头部 sticky + 统一留白；体区滚动、p-4
 * - 触发器用调用方传入的 trigger（启动卡/按钮），SheetTrigger asChild
 */
const WIDTH = {
  sm: "w-[min(86vw,440px)] sm:w-[min(86vw,440px)] !max-w-[440px]",
  md: "w-[min(86vw,680px)] sm:w-[min(86vw,680px)] !max-w-[680px]",
  lg: "w-[min(90vw,960px)] sm:w-[min(90vw,960px)] !max-w-[960px]",
} as const

export function StudioDrawer({
  trigger,
  title,
  description,
  size = "md",
  children,
  open,
  onOpenChange,
}: {
  trigger: React.ReactNode
  title: string
  description?: string
  size?: keyof typeof WIDTH
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side="right"
        className={`${WIDTH[size]} overflow-y-auto p-0`}
      >
        <SheetHeader className="border-border bg-background/95 sticky top-0 z-10 border-b px-5 py-3 backdrop-blur">
          <SheetTitle className="text-base">{title}</SheetTitle>
          {description && (
            <SheetDescription className="text-xs">
              {description}
            </SheetDescription>
          )}
        </SheetHeader>
        <div className="p-4">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
