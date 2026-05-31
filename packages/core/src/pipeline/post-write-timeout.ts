/**
 * 写后分析(整章重读结算)的超时助手。
 *
 * 写手交稿后,章节分析 / 真相结算这步偶尔会因为上游模型挂起而长时间不返回。这里提供一个
 * 可配置的超时上限和一个 Promise.race 包装器,让 pipeline 能"超时即放弃、沿用写手阶段状态"
 * 而不是被永久卡死。纯工具、无 pipeline 实例状态,从 runner.ts 抽离独立成模块。
 */

const DEFAULT_POST_WRITE_ANALYSIS_TIMEOUT_MS = 180_000;

/**
 * 写后分析的超时上限(ms)。优先读环境变量
 * `HARDWRITE_POST_WRITE_ANALYSIS_TIMEOUT_MS`(向后兼容旧名 `HARDWRITE_SETTLEMENT_CHAT_TIMEOUT_MS`),
 * 非法 / 未配置时回退到默认 180s。
 */
export function postWriteAnalysisTimeoutMs(): number {
  const configured = Number(
    process.env.HARDWRITE_POST_WRITE_ANALYSIS_TIMEOUT_MS
      ?? process.env.HARDWRITE_SETTLEMENT_CHAT_TIMEOUT_MS,
  );
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_POST_WRITE_ANALYSIS_TIMEOUT_MS;
}

/**
 * 给一个 Promise 套上超时:超过 `timeoutMs` 仍未 settle 就以 `message` reject。
 * 无论成败都会清理定时器,避免悬挂的 setTimeout 拖住进程退出。
 */
export async function withPostWriteAnalysisTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
