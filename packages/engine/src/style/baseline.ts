/**
 * 卷舍 · 风格度量的标记词常量(无版权文本,纯停用词/标记级)
 * 修辞标记尽量与 anti-slop 词表同源,避免重复维护两套"节奏/套话"信号。
 */

// 比喻标记(simile)
export const SIMILE_MARKERS = ["像", "如同", "仿佛", "宛如", "宛若", "好似", "犹如", "似的", "一般", "好比", "恰似"] as const

// 五感词(sensory)——近似,用于 sensoryDensity
export const SENSORY_WORDS = [
  "看", "见", "望", "瞧", "盯", "听", "闻", "嗅", "尝", "摸", "触", "碰",
  "声", "响", "光", "色", "味", "香", "臭", "痛", "疼", "冷", "热", "凉", "烫", "软", "硬", "亮", "暗", "甜", "苦", "咸",
] as const

// 抽象名词标记(高=报告/概念腔)——用于 abstractionRatio
export const ABSTRACT_MARKERS = ["意义", "本质", "存在", "概念", "关系", "状态", "过程", "系统", "结构", "价值", "意识", "情况", "方面", "层面", "角度", "因素"] as const

// 中文虚词(function words)——stylometry 最稳的作者指纹基
export const CN_FUNCTION_WORDS = [
  "的", "了", "着", "过", "在", "是", "和", "与", "也", "就", "都", "而", "并", "其", "之", "以", "于", "等", "被", "把",
  "从", "对", "为", "所", "则", "却", "且", "或", "但", "因", "故", "若", "虽", "又", "再", "很", "更", "最", "太", "还",
  "这", "那", "些", "个", "吧", "呢", "啊", "吗", "嘛", "呀",
] as const

// 英文虚词(fallback)
export const EN_FUNCTION_WORDS = [
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by", "from", "as", "is", "was",
  "be", "been", "are", "were", "it", "he", "she", "they", "we", "you", "i", "that", "this", "which", "who", "his", "her",
] as const

const cnFn = new Set<string>(CN_FUNCTION_WORDS)
const enFn = new Set<string>(EN_FUNCTION_WORDS)
export function isFunctionWord(token: string, lang: "zh" | "en"): boolean {
  return lang === "en" ? enFn.has(token.toLowerCase()) : cnFn.has(token)
}
