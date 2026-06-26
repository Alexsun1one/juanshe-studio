// 一本书"卡住 / 失败 / 需补地基"的后端原始 creationStatus 字符串集合 —— 单一真相。
//
// 历史上这套集合在三个地方各写了一份且互相漂移:
//   - components/shell/build-status-indicator.tsx 的 STUCK_STATUSES
//   - lib/studio/book-readiness.ts 的 BLOCKED_STATUSES
//   - lib/studio/book-lifecycle.ts 的 BLOCKED_LIFECYCLE_STATES(那一份是派生枚举,另一层)
// 同一本卡住的书在侧栏胶囊/作品列表/建书弹窗里被判成不同状态、给不同按钮,用户无法建立心智模型。
//
// 这里把"原始状态字符串层"的卡住判定收敛成一份。本文件是叶子模块,不 import 任何业务模块,
// 因此 book-readiness / build-status-indicator 引用它不会和 book-lifecycle 形成循环依赖。

/** 代表"卡住/失败/需补地基、需要用户处理"的后端原始 creationStatus 字符串。 */
export const STUCK_CREATION_STATUSES: ReadonlySet<string> = new Set<string>([
  "needs-foundation",
  "stalled",
  "error",
  "failed",
  "cancelled",
])

/** 仅表示"还没进入写章(没有可写章节)"、写作工作区据此判不可写的状态——不算"卡住/失败",只是还没开写。 */
export const NOT_YET_WRITING_STATUSES: ReadonlySet<string> = new Set<string>([
  "creating",
  "missing",
  "outlining",
  "draft",
])

export function isStuckCreationStatus(status: string | null | undefined): boolean {
  return STUCK_CREATION_STATUSES.has(String(status ?? "").trim().toLowerCase())
}
