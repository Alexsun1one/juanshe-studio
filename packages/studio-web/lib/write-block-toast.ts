"use client"

import { toast } from "sonner"
import { ApiClientError } from "@/lib/api/client"

/**
 * 把后端"写作被挡"的结构化原因翻译成人话 toast(质量门禁 / 地基未完成)。
 * 返回 true = 已处理并弹了具体提示;false = 不是已知拦截,调用方自行弹通用错误。
 */
export function showWriteBlockToast(
  e: unknown,
  opts?: {
    onConfigureLlm?: () => void
    /** 一键放行所有达标章节(调 /chapters/approve-qualifying),完成后回调 */
    onApproveQualifying?: () => Promise<void>
    bookId?: string
  },
): boolean {
  const gate =
    e instanceof ApiClientError && e.payload && typeof e.payload === "object"
      ? (e.payload as Record<string, unknown>)
      : null
  if (!gate) return false

  // 未配 LLM Key(BYOK)
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
    const tg = typeof gate.targetScore === "number" ? gate.targetScore : 80

    // 如果分数已经达到当前阈值(阈值可能已改低),直接给"一键放行"按钮
    const scoreNum = typeof gate.score === "number" ? gate.score : 0
    const alreadyQualified = scoreNum >= tg

    if (alreadyQualified && opts?.onApproveQualifying) {
      toast.warning(`第 ${ch} 章 ${sc} 分已达标，点下方按钮放行继续写`, {
        description: `当前阈值 ${tg} 分，此章 ${sc} 分已满足。点「一键放行」把所有达标章节标记通过，即可继续续写。`,
        action: {
          label: "一键放行",
          onClick: () => {
            toast.promise(opts.onApproveQualifying!(), {
              loading: "正在放行达标章节…",
              success: "已放行，请重新点「继续写」",
              error: (err) => `放行失败: ${err instanceof Error ? err.message : String(err)}`,
            })
          },
        },
        duration: 20000,
      })
      return true
    }

    // 分数确实不够
    toast.error(`续写被挡住 · 第 ${ch} 章 ${sc}/${tg} 分`, {
      description: `第 ${ch} 章还差 ${tg - scoreNum} 分未达标。点下方「修复此章」让编辑部自动重修，达标后自动继续写下一章。`,
      action: opts?.onApproveQualifying
        ? {
            label: "修复此章",
            onClick: () => {
              toast.promise(opts.onApproveQualifying!(), {
                loading: "正在启动复修…",
                success: "已启动复修，达标后自动续写",
                error: (err) => `启动失败: ${err instanceof Error ? err.message : String(err)}`,
              })
            },
          }
        : undefined,
      duration: 15000,
    })
    return true
  }

  if (gate.status === "needs-foundation") {
    toast.error("作品地基还没搭好，先补地基", {
      description: String(
        gate.failureReason ||
          gate.suggestion ||
          "请先补齐大纲 / 人物 / 主线设定，编辑部才能开始写。",
      ),
      duration: 10000,
    })
    return true
  }

  return false
}
