/**
 * 卷舍 · 风格注入(renderStyleProfile:StyleProfile → 提示词区块)
 * 与 assemble.ts 的 renderGenre/renderPlatform 同构同风格;实际注入在 assemble.ts 的唯一缝。
 */
import type { StyleProfile } from "./profile.js"

const POV_LABEL: Record<string, string> = {
  first: "第一人称",
  "third-limited": "第三人称限知",
  "third-omniscient": "第三人称全知",
  mixed: "混合视角",
}
const TENSE_LABEL: Record<string, string> = { past: "过去时", present: "现在时", mixed: "混合时态" }
const TAG_LABEL: Record<string, string> = { bare: "裸提示语(他说)", adverbial: "带状语(他冷冷地说)", "action-beat": "动作节拍替代提示语" }

export function renderStyleProfile(p: StyleProfile): string {
  const lines = ["## 本作文风指纹(请贴合;与去AI味、情节冲突时,优先服从去AI味与情节)"]
  for (const d of p.descriptors) lines.push(`· ${d}`)
  lines.push(
    `节奏锚:平均句长约 ${p.rhythm.avgSentenceLen} 字、句长 CV 目标 ${p.rhythm.sentenceLenCV}(越高越长短交错);独立短句停顿频率 ${p.rhythm.standaloneShortFreq}`,
  )
  lines.push(`对白:占比约 ${Math.round(p.dialogue.dialogueRatio * 100)}%、提示语风格「${TAG_LABEL[p.dialogue.dialogueTagStyle] ?? p.dialogue.dialogueTagStyle}」`)
  lines.push(`视角/时态:${POV_LABEL[p.pov.person] ?? p.pov.person} · ${TENSE_LABEL[p.pov.tense] ?? p.pov.tense}`)
  if (p.motifs.length) lines.push(`母题(可呼应,勿生搬):${p.motifs.join("、")}`)
  return lines.filter(Boolean).join("\n")
}
