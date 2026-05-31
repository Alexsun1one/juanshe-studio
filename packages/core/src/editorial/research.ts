/**
 * 研究员(editorial/)—— 给"自带搜索丰富内容"打底的**纯函数**:
 *   - 把 brief 拆成聚焦的搜索查询
 *   - 把检索结果拼成可注入初稿提示词的"参考资料"块(强约束:只采纳可信相关的,引用注明来源,禁编造)
 *
 * 真正的网络检索由 studio 端调外部搜索 API 完成(DeepSeek 官方 API 无原生联网搜索),本文件不联网。
 */

export interface ResearchFinding {
  readonly title: string;
  readonly snippet: string;
  readonly url: string;
}

/** 从 brief 抽出 1-N 个搜索查询(去掉"选题:""要求:"等指令外壳,取主题主干)。 */
export function buildResearchQueries(brief: string, max = 2): string[] {
  const clean = (brief || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const head = clean.split(/[。;；\n]|要求[:：]|口吻[:：]/)[0] ?? clean;
  const topic = head.replace(/^选题[:：]?/, "").replace(/^话题[:：]?/, "").trim().slice(0, 60);
  const base = topic || clean.slice(0, 60);
  const queries = [base];
  if (max > 1) queries.push(`${base} 案例 数据`.trim());
  return queries.slice(0, Math.max(1, max)).filter((q) => q.length > 0);
}

/** 把检索结果拼成注入初稿提示词的参考资料块;无结果返回空串。 */
export function buildResearchContext(findings: readonly ResearchFinding[]): string {
  const usable = findings.filter((f) => (f.title || f.snippet) && f.url);
  if (usable.length === 0) return "";
  const lines = usable.slice(0, 8).map((f, i) => `${i + 1}. ${f.title || "(无标题)"}\n   ${f.snippet}\n   来源:${f.url}`);
  return [
    "# 检索到的参考资料(用于丰富内容)",
    "下面是就本选题检索到的外部资料。**只采纳其中可信、与主题直接相关的信息**;不可信 / 不相关的忽略。",
    "引用具体数据 / 事实 / 案例时**注明来源**,**严禁编造**来源或把检索没有的内容当事实。",
    "",
    ...lines,
  ].join("\n");
}
