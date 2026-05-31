// 测试辅助:agent 消息的 content 现在可能是 [{text, cache}] 块数组(另一会话的 prompt 缓存化重构),
// 不再是纯字符串。把它拍平成字符串后再做 toContain 断言,兼容「字符串」与「块数组」两种形态,
// 对该重构的最终形态鲁棒。文件名非 *.test.ts,不会被 vitest 当测试收集。
export function flat(m: { content?: unknown } | undefined | null): string {
  const c = m?.content;
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === "string" ? b : (b as { text?: string })?.text ?? "")).join("\n");
  }
  return typeof c === "string" ? c : "";
}
