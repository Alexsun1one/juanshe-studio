/**
 * 阶段追踪 + 时间预算(工作流可观测性 & 防卡死)。
 * 记录每个 stage 的起始与耗时,并提供"是否超出单章时间预算"判断,
 * 让上层在阶段之间优雅停止(而不是无限重试 / 无限挂起)。纯逻辑,时钟可注入便于测试。
 */

export interface StageRecord {
  readonly stage: string;
  readonly startedAt: number;
  readonly elapsedMs: number;
}

export class StageTracker {
  private readonly records: { stage: string; startedAt: number; elapsedMs?: number }[] = [];
  private readonly startedAt: number;
  readonly deadlineAt: number;

  constructor(budgetMs: number, private readonly now: () => number = Date.now) {
    this.startedAt = this.now();
    this.deadlineAt = this.startedAt + Math.max(1, budgetMs);
  }

  /** 标记进入一个新阶段(自动结算上一阶段耗时)。 */
  mark(stage: string): void {
    const t = this.now();
    const prev = this.records[this.records.length - 1];
    if (prev && prev.elapsedMs === undefined) prev.elapsedMs = t - prev.startedAt;
    this.records.push({ stage, startedAt: t });
  }

  get current(): string {
    return this.records[this.records.length - 1]?.stage ?? "";
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** 是否已超出本章时间预算(供阶段之间 / 循环里做优雅停止)。 */
  get overBudget(): boolean {
    return this.now() > this.deadlineAt;
  }

  remainingMs(): number {
    return this.deadlineAt - this.now();
  }

  /** 已记录阶段的耗时时间线(最后一个阶段用当前时间结算)。 */
  timeline(): StageRecord[] {
    const t = this.now();
    return this.records.map((r, i) => ({
      stage: r.stage,
      startedAt: r.startedAt,
      elapsedMs: r.elapsedMs ?? (i === this.records.length - 1 ? t - r.startedAt : 0),
    }));
  }

  /** 一行式耗时摘要,如 "撰写:42s → 审计:18s → 修复:96s"。 */
  summary(): string {
    return this.timeline()
      .map((r) => `${r.stage}:${Math.round(r.elapsedMs / 1000)}s`)
      .join(" → ");
  }
}
