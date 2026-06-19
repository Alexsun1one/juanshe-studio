"use client"

import { toast } from "sonner"
import { ApiClientError } from "@/lib/api/client"
import { RECOVERY_LABEL } from "@/lib/recovery"

/**
 * 把后端"写作被挡"的结构化原因翻译成人话 toast(质量门禁 / 地基未完成)。
 * 返回 true = 已处理并弹了具体提示;false = 不是已知拦截,调用方自行弹通用错误。
 * 按钮文案统一从 RECOVERY_LABEL 取(去配模型 / 一键放行 / 签发并继续 / 去补地基),
 * 配合 useRecoveryActions 传齐回调,做到「撞同一堵墙,到哪都是同一套按钮」。
 */
export function showWriteBlockToast(
  e: unknown,
  opts?: {
    onConfigureLlm?: () => void
    /** 一键放行所有达标章节(调 /chapters/approve-qualifying),完成后回调 */
    onApproveQualifying?: () => Promise<void>
    /** 强制签发卡住的低分章(调 /chapters/:num/approve),解除门禁阻塞、可继续往下写 */
    onSignOffChapter?: (chapterNumber: number) => Promise<void>
    /** 地基没搭好时,跳去作品管理(那里有补地基 / 重试建书),别让用户卡在"知道要补但不知去哪补" */
    onFixFoundation?: () => void
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
      action: opts?.onConfigureLlm ? { label: RECOVERY_LABEL.configModel, onClick: opts.onConfigureLlm } : undefined,
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

    // 分数确实不够 —— 卡住了。给"签发放行(认下这章、继续往下写)"逃生口,而不是死卡在这。
    const blockingCh = typeof gate.chapterNumber === "number" ? gate.chapterNumber : null
    toast.warning(`续写卡在第 ${ch} 章 · ${sc}/${tg} 分`, {
      description:
        blockingCh != null && opts?.onSignOffChapter
          ? `第 ${ch} 章还差 ${tg - scoreNum} 分未达标。点「${RECOVERY_LABEL.signOffChapter}」认下这一章、往下写(事后还能再修);或点「${RECOVERY_LABEL.repairChapter}」让编辑部自动重修到达标。`
          : `第 ${ch} 章还差 ${tg - scoreNum} 分未达标。点「${RECOVERY_LABEL.repairChapter}」让编辑部自动重修,达标后自动继续。`,
      action:
        blockingCh != null && opts?.onSignOffChapter
          ? {
              label: RECOVERY_LABEL.signOffChapter,
              onClick: () => {
                toast.promise(opts.onSignOffChapter!(blockingCh), {
                  loading: `正在签发第 ${blockingCh} 章…`,
                  success: "已签发,请重新点「继续写」往下续",
                  error: (err) => `签发失败: ${err instanceof Error ? err.message : String(err)}`,
                })
              },
            }
          : undefined,
      duration: 18000,
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
      action: opts?.onFixFoundation ? { label: RECOVERY_LABEL.fixFoundation, onClick: opts.onFixFoundation } : undefined,
      duration: 12000,
    })
    return true
  }

  return false
}
