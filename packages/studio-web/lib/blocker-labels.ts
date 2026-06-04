/**
 * 质量门禁 / 地基阻塞项的"人话"翻译。
 *
 * 后端章节质量门禁返回的是英文枚举码(state-degraded / quality-below-target …),
 * 直接显给作者就是"原始数据外泄"——作者看不懂。这里集中翻译成一句白话;
 * 已是中文的地基阻塞项(如"存在待补/占位标记")会原样透传,不被破坏。
 */

const BLOCKER_LABELS: Record<string, string> = {
  "state-degraded": "状态文件有异常,需校验",
  "critical-audit": "有严重审稿问题待修",
  "missing-quality-report": "还没生成质量报告",
  "chapter-missing": "章节正文缺失",
  "chapter-quality-unreadable": "质量报告读取失败",
  "too-short": "字数不足,需补长",
  "quality-below-target": "质量分未达门槛",
  "length-normalizer": "字数待调整",
};

/** 把单个阻塞项码翻成白话;未知码或已是中文的描述原样返回。 */
export function blockerLabel(code: string): string {
  const key = String(code ?? "").trim();
  if (!key) return "";
  return BLOCKER_LABELS[key] ?? key;
}

/** 批量翻译,顺带去空。 */
export function blockerLabels(codes: ReadonlyArray<string> | undefined | null): string[] {
  return (codes ?? []).map(blockerLabel).filter(Boolean);
}
