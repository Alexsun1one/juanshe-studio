"use client"

// 统一的恢复动作工厂。
//
// 痛点根因:showWriteBlockToast 的恢复按钮「有没有」取决于调用方传不传回调 —— 工作台传齐了
// 所以有「一键放行」,编辑器漏传所以同一堵墙却没按钮,一致性页连 toast 都是裸的。这个 hook 把
// 四个回调一次性配齐、落点统一,任何写作面只要 `showWriteBlockToast(e, recovery)` 即可,
// 保证「撞同一堵墙,到哪都是同一套按钮、同一个落点」。

import { useRouter } from "next/navigation"
import * as React from "react"
import { approveQualifyingChapters, approveChapter } from "@/lib/api/client"
import { RECOVERY_DEST } from "@/lib/recovery"

export interface RecoveryActions {
  onConfigureLlm: () => void
  onFixFoundation: () => void
  onApproveQualifying?: () => Promise<void>
  onSignOffChapter?: (chapterNumber: number) => Promise<void>
  bookId?: string
}

/**
 * @param bookId 当前书;为空时放行/签发类回调自动省略(showWriteBlockToast 会据此不渲染对应按钮)
 * @param opts.targetScore 放行达标章节用的过线分(默认 80;各页应传本书的 targetQuality)
 */
export function useRecoveryActions(
  bookId: string | null | undefined,
  opts?: { targetScore?: number },
): RecoveryActions {
  const router = useRouter()
  const targetScore = opts?.targetScore
  return React.useMemo<RecoveryActions>(
    () => ({
      onConfigureLlm: () => router.push(RECOVERY_DEST.model.href),
      onFixFoundation: () => router.push(RECOVERY_DEST.foundation.href),
      onApproveQualifying: bookId
        ? async () => {
            await approveQualifyingChapters(bookId, { targetScore: targetScore ?? 80 })
          }
        : undefined,
      onSignOffChapter: bookId
        ? async (n: number) => {
            await approveChapter(bookId, n)
          }
        : undefined,
      bookId: bookId ?? undefined,
    }),
    [router, bookId, targetScore],
  )
}
