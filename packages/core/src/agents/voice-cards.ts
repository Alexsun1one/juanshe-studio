/**
 * 人物声音卡(「说话」字段)落地工具——补上"设定与产出之间没有验收闭环"的缺口。
 *
 * character_matrix 给每个角色都写了「说话」卡,但此前没有任何环节拿台词对照它:
 * governed 写手路径根本看不到卡原文,审稿 38 维也不含声音验收,一到紧张戏全员塌成同一种腔。
 * 这里从矩阵抽「说话」原文(与 story-graph 同源的 parseCharacterMatrix),按出场/台词量
 * 选活跃角色,分别渲染给写手(写前遵守)与审稿官(写后验收)。纯函数、零 LLM。
 */

import { parseCharacterMatrix } from "../knowledge/character-matrix.js";

export interface VoiceCard {
  readonly name: string;
  /** 「说话」卡原文,逐字保留——验收必须对照原文,不接受概述转写。 */
  readonly voice: string;
}

const MISSING_FILE_RE = /^\((?:文件不存在|文件尚未创建)\)$/;

/** 从 character_matrix markdown 抽出所有带「说话」字段的角色卡。 */
export function extractVoiceCards(matrixMarkdown: string): VoiceCard[] {
  if (!matrixMarkdown || MISSING_FILE_RE.test(matrixMarkdown.trim())) return [];
  return parseCharacterMatrix(matrixMarkdown)
    .filter((entry) => (entry.voice ?? "").trim().length > 0)
    .map((entry) => ({ name: entry.name.replace(/[（(].*$/, "").trim() || entry.name, voice: entry.voice!.trim() }));
}

/** 台词归属启发式:段落同时含角色名与引号 ≈ 该角色的一句台词。确定性、无 LLM,够审稿选人用。 */
export function countAttributedDialogue(content: string, name: string): number {
  if (!name || !content) return 0;
  let hits = 0;
  for (const paragraph of content.split(/\n+/)) {
    if (paragraph.includes(name) && /[“”"「『]/.test(paragraph)) hits++;
  }
  return hits;
}

/** 审稿用:选出本章出场且台词 ≥ minDialogueLines 句的角色卡(按台词量降序,封顶 limit)。 */
export function selectActiveVoiceCards(
  cards: ReadonlyArray<VoiceCard>,
  chapterContent: string,
  opts?: { readonly minDialogueLines?: number; readonly limit?: number },
): ReadonlyArray<VoiceCard & { readonly dialogueLines: number }> {
  const minLines = opts?.minDialogueLines ?? 3;
  const limit = opts?.limit ?? 6;
  return cards
    .map((card) => ({ ...card, dialogueLines: countAttributedDialogue(chapterContent, card.name) }))
    .filter((card) => card.dialogueLines >= minLines)
    .sort((a, b) => b.dialogueLines - a.dialogueLines)
    .slice(0, limit);
}

/** 写手用:按本章意图/memo 文本点名的角色选卡;一个都没点到时给全量(封顶),宁多勿缺。 */
export function selectVoiceCardsByMention(
  cards: ReadonlyArray<VoiceCard>,
  focusText: string,
  limit = 6,
): ReadonlyArray<VoiceCard> {
  if (cards.length === 0) return [];
  const mentioned = focusText
    ? cards.filter((card) => focusText.includes(card.name))
    : [];
  return (mentioned.length > 0 ? mentioned : cards).slice(0, limit);
}

/** 审稿官上下文块:卡原文逐条贴入 + 要求对每人摘违背声音卡的台词进 issues。 */
export function renderVoiceCardAuditBlock(
  cards: ReadonlyArray<VoiceCard & { readonly dialogueLines?: number }>,
  language: "zh" | "en" = "zh",
): string {
  if (cards.length === 0) return "";
  if (language === "en") {
    const lines = cards.map((card) => `- ${card.name}: ${card.voice}`);
    return [
      "\n## Voice Card Verification (dialogue vs. character sheet)",
      "The characters below speak in this chapter. Their verbatim Speech cards:",
      ...lines,
      "For EACH character, compare their lines against the card. If any line violates the card, add an issue (severity=\"warning\", category=\"Dialogue Authenticity Check\") quoting the offending line verbatim and showing how that character would actually say it. If swapping any two supporting characters' lines reads natural, that is also a Dialogue Authenticity issue. If all lines fit their cards, do not emit an issue for this block.\n",
    ].join("\n");
  }
  const lines = cards.map((card) => `- ${card.name}:${card.voice}`);
  return [
    "\n## 本章声音卡验收(台词对照)",
    "以下角色本章有台词,其「说话」卡原文如下:",
    ...lines,
    "要求:逐人把本章台词与其「说话」卡对照。任何一句违背声音卡,就出一条 issue(severity=\"warning\",category=\"台词失真\"),原句照抄进 description,并在 suggestion 里写出该角色照卡应有的说法;任意两名配角的台词遮名互换不违和,同样记一条「台词失真」。全部贴合时不必为此输出 issue。\n",
  ].join("\n");
}

/** 写手上下文块:卡原文 + 遮名测试硬要求(写前遵守,与审稿验收同一把尺)。 */
export function renderWriterVoiceCardBlock(
  cards: ReadonlyArray<VoiceCard>,
  language: "zh" | "en" = "zh",
): string {
  if (cards.length === 0) return "";
  if (language === "en") {
    const lines = cards.map((card) => `- ${card.name}: ${card.voice}`);
    return [
      "\n## Character Voice Cards (binding for all dialogue)",
      ...lines,
      "Every line of dialogue must obey its speaker's card. Masking the names, a reader must still tell who is speaking; never let everyone collapse into the same clipped thriller register.\n",
    ].join("\n");
  }
  const lines = cards.map((card) => `- ${card.name}:${card.voice}`);
  return [
    "\n## 人物声音卡(台词硬约束)",
    ...lines,
    "每句台词必须遵守说话人的卡:用词层次、句长、口头禅、答话节奏都要对得上。遮住人名只看台词,读者要能认出是谁;严禁全员塌成同一种压低声音的短句腔。\n",
  ].join("\n");
}
