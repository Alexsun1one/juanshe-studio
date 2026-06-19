// 恢复动作的「唯一真相」:落点 + 文案。
//
// 以前 "去配模型" 有 5 种说法、"补地基" 有 4 种、落点还三处不一(/llm、/outline、/books、/system)。
// 全站任何撞墙引导都从这里取文案和 href,保证「撞同一堵墙,到哪都是同一句话、同一个落点」。

import type { WriteErrorKind } from "@/lib/diagnose-write-error"

export const RECOVERY_DEST = {
  /** 配置全局大模型 / API Key(BYOK) */
  model: { href: "/llm", label: "去配模型" },
  /** 补地基 / 重试建书(作品管理里有补地基 + 重试建书按钮,且能看到每本书真实状态) */
  foundation: { href: "/books", label: "去补地基" },
} as const

/** 恢复动作统一文案(放行 / 签发 / 修复) */
export const RECOVERY_LABEL = {
  configModel: "去配模型",
  fixFoundation: "去补地基",
  approveQualifying: "一键放行",
  signOffChapter: "签发并继续",
  repairChapter: "修复本章",
  retry: "重试",
  goInbox: "去处理",
} as const

/** 把诊断 kind 映射到「主恢复落点」(给横幅/卡片选主按钮用);gate/transient/unknown 没有跳转落点。 */
export function primaryDestForKind(kind: WriteErrorKind): { href: string; label: string } | null {
  if (kind === "model") return RECOVERY_DEST.model
  if (kind === "foundation") return RECOVERY_DEST.foundation
  return null
}
