import { normalizeAutoRun } from "./backend-transforms"
import {
  backendJSON,
  frontendFallbackEnabled,
  frontendFallbackResponse,
  isRecord,
  proxyJSONOrFallback,
  standardError,
  type JsonRecord,
} from "./facade"
import type { AutoRun } from "./types"

type Fallback = () => Response | Promise<Response>

export async function proxyRunStopOrFallback(
  request: Request,
  runId: string,
  status: Extract<AutoRun["status"], "paused" | "failed" | "cancelled">,
  reason: string,
  fallback: Fallback,
) {
  const run = await fetchRunRecord(request, runId)
  const bookId = readString(run, ["bookId", "book_id"])
  if (!bookId) return missingRunResponse(runId, fallback)

  return proxyJSONOrFallback(
    request,
    `/api/v1/books/${encodeURIComponent(bookId)}/workflow/stop`,
    fallback,
    {
      method: "POST",
      body: { runId, reason },
      transform: () => normalizeAutoRun({ ...run, id: runId, status }),
    },
  )
}

export async function proxyRunResumeOrFallback(
  request: Request,
  runId: string,
  fallback: Fallback,
) {
  const run = await fetchRunRecord(request, runId)
  const bookId = readString(run, ["bookId", "book_id"])
  if (!bookId) return missingRunResponse(runId, fallback)

  const currentChapter = readNumber(run, ["currentChapter", "chapter", "fromChapter"], 1)
  const toChapter = readNumber(run, ["toChapter", "endChapter"], currentChapter)
  const chapters = Math.max(1, toChapter - currentChapter + 1)
  const targetQuality = readNumber(run, ["targetQuality", "qualityTarget", "targetScore"], 80)
  const maxRewritesPerChapter = readNumber(run, ["maxRewritesPerChapter", "maxRewrites", "maxAutoRounds"], 2)

  return proxyJSONOrFallback(
    request,
    `/api/v1/books/${encodeURIComponent(bookId)}/write-batch`,
    fallback,
    {
      method: "POST",
      body: {
        runId,
        chapterNum: currentChapter,
        chapters,
        wordCount: readNumber(run, ["targetWordsPerChapter", "targetWords"], 5000),
        targetQuality,
        targetScore: targetQuality,
        maxRewrites: maxRewritesPerChapter,
        maxRewritesPerChapter,
        autoRepair: true,
      },
      transform: (data) => normalizeAutoRun(data),
    },
  )
}

async function fetchRunRecord(request: Request, runId: string) {
  try {
    const { response, data } = await backendJSON(
      `/api/v1/runs/${encodeURIComponent(runId)}`,
      request,
    )
    if (!response.ok) return {}
    const source = isRecord(data) && isRecord(data.run) ? data.run : data
    return isRecord(source) ? source : {}
  } catch {
    return {}
  }
}

async function missingRunResponse(runId: string, fallback: Fallback) {
  if (frontendFallbackEnabled()) return frontendFallbackResponse(fallback)
  return Response.json(
    standardError("RUN_NOT_FOUND", `Run ${runId} was not returned by backend`),
    { status: 404 },
  )
}

function readString(source: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

function readNumber(source: JsonRecord, keys: string[], fallback: number) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return fallback
}
