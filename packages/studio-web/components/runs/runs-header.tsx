"use client"

import * as React from "react"
import { Activity } from "lucide-react"
import { useT } from "@/lib/i18n"

export function RunsHeader({
  title,
  subtitle,
  runningCount,
  action,
}: {
  title: string
  subtitle: string
  runningCount: number
  action?: React.ReactNode
}) {
  const t = useT()
  return (
    <header className="border-border bg-card sticky top-0 z-20 border-b backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-6 py-4 md:px-10">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-foreground/90 truncate text-[18px] font-semibold tracking-tight">
              {title}
            </h1>
            {runningCount > 0 && (
              <span className="bg-status-running/12 text-status-success inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
                <Activity className="size-3" />
                {runningCount} {t("workspace.runningOf")}
              </span>
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 truncate text-[12px]">
            {subtitle}
          </p>
        </div>
        {action}
      </div>
    </header>
  )
}
