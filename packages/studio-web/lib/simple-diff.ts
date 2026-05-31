/**
 * 极简行级 diff(LCS),无三方依赖。用于编辑部评审里"写手原稿 vs 改后"的红删/绿增对比。
 * 章节正文按行(段落)切,体量小(几十~上百行),O(n·m) DP 完全够用。
 */
export type DiffSeg = { type: "same" | "add" | "del"; text: string }

export function diffLines(before: string, after: string): DiffSeg[] {
  const a = String(before ?? "").replace(/\r\n/g, "\n").split("\n")
  const b = String(after ?? "").replace(/\r\n/g, "\n").split("\n")
  const n = a.length
  const m = b.length
  // LCS 长度表(自底向上)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffSeg[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "same", text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++ }
    else { out.push({ type: "add", text: b[j] }); j++ }
  }
  while (i < n) out.push({ type: "del", text: a[i++] })
  while (j < m) out.push({ type: "add", text: b[j++] })
  return out
}

/** 统计增删行数,用于摘要("+12 / −8") */
export function diffStats(segs: DiffSeg[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const s of segs) {
    if (!s.text.trim()) continue
    if (s.type === "add") added++
    else if (s.type === "del") removed++
  }
  return { added, removed }
}
