// 只收「真小说正文里几乎不可能出现、但 polisher/reviser 推理前言里典型」的超高区分度标记。
// 任一命中(.some)即判为污染,所以每条都必须保守——宁可漏掉变体,也绝不误杀用户合法正文
// (该判定也用在用户手改章节的保存校验里;误判=用户存不进合法内容,代价最大)。
// 实测泄漏("我们被要求输出 JSON…weighted targets…low metrics…revised 字段…")会同时命中下面多条,
// 故刻意删掉了高误杀风险项:① 英文 `hook 63`/`length 60`(科幻/英文对白会撞)② `目标是达到 N 分`
// (校园小说"他的目标是达到 90 分"会撞)。若后续真书观察到只靠裸指标的变体漏网,再按真数据加紧。
const REASONING_NOT_PROSE_MARKERS: readonly RegExp[] = [
  /我们被要求输出\s*JSON/,
  /weighted targets?/i,
  /low metrics?/i,
  /revised 字段/,
  /===\s*REVISED/i,
  /当前章节\s*\d+\s*字[,，]\s*目标\s*\d+\s*字/,
  /必须扩写但不能灌水/,
];

export function looksLikeReasoningNotProse(text: string): boolean {
  if (!text) return false;
  return REASONING_NOT_PROSE_MARKERS.some((marker) => marker.test(text));
}
