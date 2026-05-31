/**
 * 卷舍 · 风格蒸馏(extractStyle:样本 → StyleProfile)
 *
 * 主体确定性(computeMetrics 算齐数值,零 token);LLM 只补它算不出的语义:
 * POV/时态/内心独白、母题(模式级)、把数值翻成可执行 descriptors。
 * 出口跑 assertNoVerbatim 双保险:返回值里 0 字节样本原文(法律红线)。
 */
import { computeMetrics, assertNoVerbatim } from "./metrics.js"
import { StyleLlmAddendum, type StyleProfile } from "./profile.js"
import type { LlmClient } from "../llm/client.js"

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

export async function extractStyle(
  samples: string | string[],
  llm: LlmClient,
  opts: { lang?: "zh" | "en"; bookId?: string; now?: string } = {},
): Promise<StyleProfile> {
  const text = (Array.isArray(samples) ? samples.join("\n\n") : samples).trim()
  const lang = opts.lang ?? "zh"
  const base = computeMetrics(text, lang)

  // LLM 补全:仅语义判定 + 人话化(显式禁止复述原文)
  let add: StyleLlmAddendum = {
    pov: { person: "third-limited", tense: "past", interiorityRatio: 0.2 },
    motifs: [],
    descriptors: [],
  }
  try {
    const { data } = await llm.generateStructured({
      system:
        "你是文体分析专家。基于给定样本的统计特征与少量节选,判定:叙事人称(first/third-limited/third-omniscient/mixed)、" +
        "时态(past/present/mixed)、内心独白占比(0–1);提炼 ≤8 个母题(模式级,如\"用食物隐喻孤独\",严禁照搬原句);" +
        "把统计数值翻成 ≤12 条可执行写作风格戒律(descriptors)。严禁复述/引用样本任何原句,只输出抽象模式与参数解读。",
      messages: [
        { role: "user", content: `样本统计特征:\n${JSON.stringify(base)}\n\n样本节选(仅供判定语义,切勿在输出中复述):\n${text.slice(0, 1200)}` },
      ],
      temperature: 0.2,
      modelTier: "fast",
      schema: StyleLlmAddendum,
    })
    add = data
  } catch {
    /* 降级:用确定性默认 pov + 空母题/descriptor */
  }

  // assertNoVerbatim 守卫(出口双保险)
  const motifs = add.motifs.map((m) => assertNoVerbatim(m, text, 24)).filter((x): x is string => !!x).slice(0, 8)
  const descriptors = add.descriptors.map((d) => assertNoVerbatim(d, text, 48)).filter((x): x is string => !!x).slice(0, 12)
  const confidence = Math.round(sigmoid((base.sampleStats.chars - 2000) / 4000) * 100) / 100

  return {
    schemaVersion: 1,
    bookId: opts.bookId,
    lang,
    rhythm: base.rhythm,
    lexical: base.lexical,
    syntax: base.syntax,
    rhetoric: base.rhetoric,
    dialogue: base.dialogue,
    punctuation: base.punctuation,
    pov: add.pov,
    motifs,
    descriptors,
    sampleStats: { ...base.sampleStats, updatedAt: opts.now ?? "" },
    confidence,
  }
}
