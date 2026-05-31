import { isRecord } from "./facade"

export function okResult() {
  return { ok: true as const }
}

export function okRunResult(data: unknown, prefix: string) {
  return { ok: true as const, runId: runIdFrom(data, prefix) }
}

export function runIdFrom(data: unknown, prefix: string) {
  if (isRecord(data)) {
    const direct = firstString(data, ["runId", "id", "taskRunId"])
    if (direct) return direct

    const run = data.run
    if (isRecord(run)) {
      const nested = firstString(run, ["id", "runId", "taskRunId"])
      if (nested) return nested
    }
  }

  return `${prefix}_${Date.now().toString(36)}`
}

function firstString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}
