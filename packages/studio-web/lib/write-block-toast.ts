"use client"

import { toast } from "sonner"
import { ApiClientError } from "@/lib/api/client"

/**
 * 把后端"写作被挡"的结构化原因翻译成人话 toast(质量门禁 / 地基未完成)。
 * 返回 true = 已处理并弹了具体提示;false = 不是已知拦截,调用方自行弹通用错误。
 *
 * 背景:续写要求"前面每一章都达标(默认 ≥90)"。连续写作只在『连续性审校』失败时停,
 * 不卡 90 分;而手动续写会回头检查 90 分门槛 —— 所以会出现"写到后面才说前面某章没过"。
 * 这个提示要把"是哪一章、差多少、怎么修"讲清楚。
 */
export function showWriteBlockToast(e: unknown, opts?: { onConfigureLlm?: () => void }): boolean {
  const gate =
    e instanceof ApiClientError && e.payload && typeof e.payload === "object"
      ? (e.payload as Record<string, unknown>)
      : null
  if (!gate) return false

  // 未配 LLM Key(BYOK):清晰可执行提示 + "去配置"(客户端路由,不整页刷新)
  const errObj = gate.error && typeof gate.error === "object" ? (gate.error as Record<string, unknown>) : null
  if (errObj?.code === "LLM_NOT_CONFIGURED") {
    toast.error("还没配置写作模型(BYOK)", {
      description: String(errObj.message ?? "请填入你的 LLM API Key,保存后即可开始写作。"),
      action: opts?.onConfigureLlm ? { label: "去配置", onClick: opts.onConfigureLlm } : undefined,
      duration: 12000,
    })
    return true
  }

  if (gate.status === "quality-gate-blocked") {
    const ch = gate.chapterNumber ?? "?"
    const sc = typeof gate.score === "number" ? Math.round(gate.score as number) : "—"
    const tg = gate.targetScore ?? 90
    toast.error(`续写被挡住 · 第 ${ch} 章只有 ${sc}/${tg} 分`, {
      description: `编辑部不会在没达标的章节上继续往下写。请在编辑器打开第 ${ch} 章,点「修复本章」原地修到 ${tg} 分(只动这一章,不影响后面的章)。⚠️ 别用「改写/润色/扩写」修中间章 —— 那会回滚并重写第 ${ch} 章之后的所有章。`,
      duration: 12000,
    })
    return true
  }

  if (gate.status === "needs-foundation") {
    toast.error("作品地基还没搭好,先补地基", {
      description: String(
        gate.failureReason ||
          gate.suggestion ||
          "请先补齐大纲 / 人物 / 主线设定,编辑部才能开始写。",
      ),
      duration: 10000,
    })
    return true
  }

  return false
}
