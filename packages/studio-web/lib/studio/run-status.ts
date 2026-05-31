import type { AutoRun } from "@/lib/api/types"

const LIVE_STATUSES = new Set([
  "queued",
  "running",
  "model_done",
  "writing",
  "repairing",
  "rewriting",
  "accepted",
  "batch-writing",
  "quality-batch-repairing",
])

const RECOVERABLE_STATUSES = new Set([
  "paused",
  "failed",
  "needs-repair",
  "needs_repair",
  "repair-needed",
  "blocked",
])

export function normalizeAutoRunStatus(status: string | undefined) {
  return String(status ?? "").trim().toLowerCase()
}

export function isLiveAutoRunStatus(
  status: AutoRun["status"] | string | undefined,
) {
  return LIVE_STATUSES.has(normalizeAutoRunStatus(status))
}

export function isRecoverableAutoRunStatus(
  status: AutoRun["status"] | string | undefined,
) {
  return RECOVERABLE_STATUSES.has(normalizeAutoRunStatus(status))
}

export function isAcceptedRunningResult(status: string | undefined) {
  return !status || isLiveAutoRunStatus(status)
}

export function autoRunStatusLabelKey(
  status: AutoRun["status"] | string | undefined,
) {
  const normalized = normalizeAutoRunStatus(status)
  if (["needs_repair", "repair-needed"].includes(normalized)) {
    return "runs.status.needs-repair"
  }
  if (["canceled", "stopped"].includes(normalized)) {
    return "runs.status.cancelled"
  }
  if (
    [
      "queued",
      "running",
      "rewriting",
      "model_done",
      "writing",
      "repairing",
      "accepted",
      "batch-writing",
      "quality-batch-repairing",
      "needs-repair",
      "blocked",
      "unknown",
      "paused",
      "cancelled",
      "completed",
      "failed",
    ].includes(normalized)
  ) {
    return `runs.status.${normalized}`
  }
  return "runs.status.unknown"
}

export function autoRunStatusRank(
  status: AutoRun["status"] | string | undefined,
) {
  if (isLiveAutoRunStatus(status)) return 0
  if (isRecoverableAutoRunStatus(status)) return 1
  return 2
}
