"use client"

import { Settings } from "lucide-react"
import { useT } from "@/lib/i18n"

export function SettingsHeader() {
  const t = useT()
  return (
    <header className="border-border bg-card sticky top-0 z-30 border-b backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-5">
        <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl">
          <Settings className="size-5" strokeWidth={1.7} />
        </div>
        <div className="leading-tight">
          <h1 className="text-foreground text-lg font-semibold tracking-tight">
            {t("settings.title")}
          </h1>
          <p className="text-muted-foreground text-xs">
            LLM · workflow · books · appearance
          </p>
        </div>
      </div>
    </header>
  )
}
