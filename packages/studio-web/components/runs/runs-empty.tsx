"use client"

import { Zap } from "lucide-react"
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
    <div className="runs-empty-state">
      <img
        className="runs-empty-prop"
        src="/brand/props/run-console.webp"
        alt=""
        width={560}
        height={425}
        loading="lazy"
        decoding="async"
        draggable={false}
      />

      <div className="runs-empty-copy">
        <h2>
          {t("runs.empty.title")}
        </h2>
        <p>
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
