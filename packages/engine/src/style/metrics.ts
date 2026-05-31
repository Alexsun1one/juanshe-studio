/**
 * 卷舍 · 风格度量层(确定性,零 LLM,可单测)——"风格的 L0"
 *
 * 节奏维度强制复用 quality/text-metrics(同一把尺,与 detectSlop / judge.deAiTell 同源)。
 * 词汇分词用 Node20 Intl.Segmenter,降级到正则/逐字。其余维度全用确定性标记词/正则近似。
 */
import { sentenceLengths, mean, coefficientOfVariation } from "../quality/text-metrics.js"
import { SIMILE_MARKERS, SENSORY_WORDS, ABSTRACT_MARKERS, isFunctionWord } from "./baseline.js"
import type {
  RhythmSignature, LexicalProfile, SyntaxProfile, RhetoricProfile, DialogueProfile, PunctuationHabit,
} from "./profile.js"

export { sentenceLengths, stddev, mean, coefficientOfVariation } from "../quality/text-metrics.js"

const round2 = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
function occ(text: string, term: string): number {
  let n = 0
  let i = text.indexOf(term)
  while (i !== -1) { n++; i = text.indexOf(term, i + term.length) }
  return n
}
function countAny(text: string, terms: readonly string[]): number {
  let n = 0
  for (const t of terms) n += occ(text, t)
  return n
}

// 分词:Intl.Segmenter(Node20)→ 降级正则/逐字
function tokenize(text: string, lang: "zh" | "en"): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => { segment(s: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter
  if (Seg) {
    try {
      const seg = new Seg(lang === "en" ? "en" : "zh", { granularity: "word" })
      const out: string[] = []
      for (const s of seg.segment(text)) if (s.isWordLike) out.push(s.segment)
      if (out.length) return out
    } catch {
      /* fall through */
    }
  }
  if (lang === "en") return text.toLowerCase().match(/[a-z']+/g) ?? []
  return [...text.replace(/[\s\p{P}]/gu, "")] // 中文降级:逐字
}

export function extractRhythm(text: string): RhythmSignature {
  const lens = sentenceLengths(text)
  const n = lens.length || 1
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean)
  const standalone = paras.filter((p) => sentenceLengths(p).length <= 1 && p.replace(/\s/g, "").length < 12).length
  return {
    avgSentenceLen: round2(mean(lens)),
    sentenceLenCV: round2(coefficientOfVariation(lens)),
    shortRatio: round2(lens.filter((l) => l < 8).length / n),
    longRatio: round2(lens.filter((l) => l > 30).length / n),
    midBandRatio: round2(lens.filter((l) => l >= 15 && l <= 25).length / n),
    standaloneShortFreq: round2(paras.length ? standalone / paras.length : 0),
    avgParagraphLen: round2(mean(paras.map((p) => p.replace(/\s/g, "").length))),
  }
}

export function extractLexical(text: string, lang: "zh" | "en"): LexicalProfile {
  const tokens = tokenize(text, lang)
  const n = tokens.length || 1
  const freq = new Map<string, number>()
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  const hapax = [...freq.values()].filter((c) => c === 1).length
  const fnCount = tokens.filter((t) => isFunctionWord(t, lang)).length
  const avgWordLen = mean(tokens.map((t) => [...t].length))

  // signatureNGrams:高频相邻 2-gram,短(≤4字)、过反原文过滤
  const bi = new Map<string, number>()
  for (let i = 0; i + 1 < tokens.length; i++) {
    const g = tokens[i] + tokens[i + 1]
    if ([...g].length > 4) continue
    bi.set(g, (bi.get(g) ?? 0) + 1)
  }
  const total2 = Math.max(1, tokens.length - 1)
  const signatureNGrams = [...bi.entries()]
    .filter(([, c]) => c >= 2)
    .map(([gram, c]) => ({ gram, z: round2((c / total2) * 100) }))
    .sort((a, b) => b.z - a.z)
    .filter((g) => isStyleSafe(g.gram))
    .slice(0, 8)

  return {
    ttr: round2(freq.size / n),
    hapaxRatio: round2(hapax / n),
    functionWordRatio: round2(fnCount / n),
    avgWordLen: round2(avgWordLen),
    signatureNGrams,
  }
}

export function extractSyntax(text: string): SyntaxProfile {
  const lens = sentenceLengths(text)
  const n = lens.length || 1
  const clean = text.replace(/\s/g, "")
  const chars = clean.length || 1
  const commas = (clean.match(/[,，、;；]/g) ?? []).length
  const sentences = text.split(/(?<=[。!?！?…])/u).map((s) => s.trim()).filter((s) => [...s].length >= 2)
  let parallel = 0
  for (let i = 1; i < sentences.length; i++) {
    const a = sentences[i - 1]
    const b = sentences[i]
    if (a[0] && a[0] === b[0] && Math.abs([...a].length - [...b].length) <= 2) parallel++
  }
  return {
    subordinationIndex: round2(clamp01((commas / chars) * 10)),
    clausesPerSentence: round2((commas + n) / n),
    parallelismRate: round2(sentences.length ? parallel / sentences.length : 0),
    fragmentRate: round2(lens.filter((l) => l < 6).length / n),
  }
}

export function extractRhetoric(text: string): RhetoricProfile {
  const clean = text.replace(/\s/g, "")
  const kchar = Math.max(1, clean.length / 1000)
  const simile = countAny(clean, SIMILE_MARKERS)
  const sensory = countAny(clean, SENSORY_WORDS)
  const abstract = countAny(clean, ABSTRACT_MARKERS)
  return {
    simileDensity: round2(clamp01(simile / kchar / 20)),
    metaphorMarkers: round2(clamp01((simile / kchar) / 30)),
    sensoryDensity: round2(clamp01(sensory / kchar / 40)),
    abstractionRatio: round2(clamp01(abstract / kchar / 15)),
  }
}

export function extractDialogue(text: string): DialogueProfile {
  const clean = text.replace(/\s/g, "")
  const matches = text.match(/[「“"][^」”"]*[」”"]/g) ?? []
  const dialogueChars = matches.reduce((s, m) => s + Math.max(0, m.replace(/\s/g, "").length - 2), 0)
  const advTags = (text.match(/地\s*[说道喊问答叫嚷]/g) ?? []).length
  const bareTags = (text.match(/[」”"][^。\n]{0,3}[说道问答]/g) ?? []).length
  let dialogueTagStyle: "bare" | "adverbial" | "action-beat" = "bare"
  if (advTags > bareTags) dialogueTagStyle = "adverbial"
  else if (matches.length > 0 && bareTags === 0) dialogueTagStyle = "action-beat"
  return {
    dialogueRatio: round2(clean.length ? dialogueChars / clean.length : 0),
    avgDialogueLen: round2(matches.length ? dialogueChars / matches.length : 0),
    dialogueTagStyle,
  }
}

export function extractPunctuation(text: string): PunctuationHabit {
  const clean = text.replace(/\s/g, "")
  const kchar = Math.max(1, clean.length / 1000)
  const sentences = Math.max(1, sentenceLengths(text).length)
  return {
    emDashPerKchar: round2((text.match(/——|—/g) ?? []).length / kchar),
    ellipsisPerKchar: round2((text.match(/……|\.\.\.|…/g) ?? []).length / kchar),
    exclamationRatio: round2(clamp01((text.match(/[!！]/g) ?? []).length / sentences)),
    questionRatio: round2(clamp01((text.match(/[?？]/g) ?? []).length / sentences)),
  }
}

/** 一次算齐所有确定性维度(pov/motifs/descriptors 需 LLM,不在此)*/
export function computeMetrics(text: string, lang: "zh" | "en") {
  return {
    lang,
    rhythm: extractRhythm(text),
    lexical: extractLexical(text, lang),
    syntax: extractSyntax(text),
    rhetoric: extractRhetoric(text),
    dialogue: extractDialogue(text),
    punctuation: extractPunctuation(text),
    sampleStats: {
      chars: text.replace(/\s/g, "").length,
      sentences: sentenceLengths(text).length,
      mergedSamples: 1,
      updatedAt: "",
    },
  }
}

// ── 反洗稿守卫(法律红线落到代码)──
/** 模式串安全:短(≤6字)、非空。用于 signatureNGrams.gram。*/
export function isStyleSafe(gram: string): boolean {
  const g = gram.trim()
  return g.length > 0 && [...g].length <= 6
}
/** descriptor/motif 守卫:不得包含样本任一连续 12 字原文;过长则截断;命中原文则丢弃(返回 null)。
 *  比对前去掉空白+标点(防"改个标点就绕过"的洗稿)。*/
export function assertNoVerbatim(value: string, sample: string, maxLen = 48): string | null {
  const v = value.trim()
  if (!v) return null
  const strip = (s: string) => s.replace(/[\s\p{P}]/gu, "")
  const clean = strip(sample)
  const vc = strip(v)
  for (let i = 0; i + 12 <= vc.length; i++) {
    if (clean.includes(vc.slice(i, i + 12))) return null // 命中样本原文 → 丢弃
  }
  return [...v].length > maxLen ? [...v].slice(0, maxLen).join("") : v
}
