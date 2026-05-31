"use client"

import {
  BookPlus,
  ListTree,
  PenLine,
  Sparkles,
  ScanSearch,
  Send,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n"
import { useStudio, type StudioMode } from "@/lib/studio-context"

const STEPS: {
  id: StudioMode
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  descKey: string
}[] = [
  { id: "new", icon: BookPlus, labelKey: "step.new", descKey: "step.new.desc" },
  {
    id: "outline",
    icon: ListTree,
    labelKey: "step.outline",
    descKey: "step.outline.desc",
  },
  {
    id: "write",
    icon: PenLine,
    labelKey: "step.write",
    descKey: "step.write.desc",
  },
  {
    id: "rewrite",
    icon: Sparkles,
    labelKey: "step.rewrite",
    descKey: "step.rewrite.desc",
  },
  {
    id: "review",
    icon: ScanSearch,
    labelKey: "step.review",
    descKey: "step.review.desc",
  },
  {
    id: "publish",
    icon: Send,
    labelKey: "step.publish",
    descKey: "step.publish.desc",
  },
]

export function Stepper() {
  const t = useT()
  const { mode, setMode } = useStudio()
  const currentIdx = STEPS.findIndex((s) => s.id === mode)

  return (
    <nav
      role="tablist"
      aria-label="工作流步骤"
      className="bg-secondary/50 border-border inline-flex shrink-0 items-center gap-0.5 rounded-full border p-1 shadow-sm backdrop-blur-sm"
    >
      {STEPS.map((step, idx) => {
        const Icon = step.icon
        const active = step.id === mode
        const passed = idx < currentIdx
        return (
          <button
            key={step.id}
            role="tab"
            aria-selected={active}
            onClick={() => setMode(step.id)}
            className={cn(
              "group relative flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-all duration-300",
              "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
              active &&
                "bg-background text-foreground shadow-sm ring-1 ring-primary/30",
              !active && passed && "text-foreground/70 hover:text-foreground",
              !active && !passed && "text-muted-foreground hover:text-foreground",
            )}
            title={t(step.descKey)}
          >
            <Icon
              className={cn(
                "size-3.5 transition-colors",
                active && "text-primary",
                passed && !active && "text-status-success",
              )}
            />
            {/* xl 之后才显示文字标签：避免书名 + Stepper + 搜索三者拥挤 */}
            <span className="hidden xl:inline">{t(step.labelKey)}</span>
            {active && (
              <span className="bg-primary/50 absolute -bottom-px left-3 right-3 h-px" />
            )}
          </button>
        )
      })}
    </nav>
  )
}
