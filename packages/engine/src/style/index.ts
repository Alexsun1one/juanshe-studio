/**
 * 卷舍 · 风格模块门面
 * 注意:不 `export *` from metrics.js —— 那会把从 quality/text-metrics 再导出的
 * sentenceLengths/stddev/mean/coefficientOfVariation 二次导出,与引擎 barrel 里的
 * quality/text-metrics 冲突(TS2308)。只导出风格自有的函数。
 */
export * from "./profile.js"
export {
  extractRhythm,
  extractLexical,
  extractSyntax,
  extractRhetoric,
  extractDialogue,
  extractPunctuation,
  computeMetrics,
  isStyleSafe,
  assertNoVerbatim,
} from "./metrics.js"
export { mergeStyle } from "./merge.js"
export { scoreStyleAdherence } from "./score.js"
export { renderStyleProfile } from "./apply.js"
export { extractStyle } from "./extract.js"
