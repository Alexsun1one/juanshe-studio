"use client"

import { Sparkles, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n"

/**
 * 运行台空态：第一次访问时引导用户开始一次自动续写。
 *
 * 这里有意做得"克制" —— 一个轻量的视觉占位 + 主行动按钮，
 * 不堆功能介绍卡，避免与首页造成噪声重复。
 */
export function RunsEmpty({ onCreate }: { onCreate: () => void }) {
  const t = useT()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-5 py-24 text-center">
      <div className="bg-primary/8 ring-primary/20 relative flex size-20 items-center justify-center rounded-full ring-1">
        <Sparkles className="text-primary size-9" strokeWidth={1.6} />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-balance">
          {t("runs.empty.title")}
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          {t("runs.empty.desc")}
        </p>
      </div>

      <Button type="button" onClick={onCreate} size="sm" className="gap-2">
        <Zap className="size-4" />
        {t("runs.newRun")}
      </Button>
    </div>
  )
}
