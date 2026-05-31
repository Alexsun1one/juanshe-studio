import { NextResponse } from "next/server"
import { runIdFrom } from "@/lib/api/action-results"
import {
  isRecord,
  proxyJSON,
  proxyJSONOrFallback,
  readJsonBody,
  standardError,
} from "@/lib/api/facade"
import { normalizeAutoRun, normalizeAutoRuns } from "@/lib/api/backend-transforms"
import { autoRunStatusRank } from "@/lib/studio/run-status"
import type { AutoRun, AutoRunCreate } from "@/lib/api/types"

const AUTO_RUN_LIST_LIMIT = 24
const AUTO_RUN_RECENT_EVENTS_LIMIT = 36

export async function GET(req: Request) {
  return proxyJSONOrFallback(
    req,
    `/api/v1/runs?limit=${AUTO_RUN_LIST_LIMIT}&recentEvents=${AUTO_RUN_RECENT_EVENTS_LIMIT}`,
    () => NextResponse.json(
      standardError(
        "AUTO_RUNS_BACKEND_MISSING",
        "Auto-run list is unavailable because the real backend route did not respond.",
      ),
      { status: 503 },
    ),
    { transform: normalizeAutoRunsForList },
  )
}

export async function POST(req: Request) {
  const body = (await readJsonBody(req)) as AutoRunCreate
  const chapterCount = Math.max(1, body.toChapter - body.fromChapter + 1)

  return proxyJSON(
    req,
    `/api/v1/books/${encodeURIComponent(body.bookId)}/write-batch`,
    {
      method: "POST",
      body: {
        ...body,
        chapterNum: body.fromChapter,
        chapters: chapterCount,
        wordCount: body.targetWordsPerChapter,
        targetWords: body.targetWordsPerChapter,
        targetQuality: body.targetQuality,
        targetScore: body.targetQuality,
        maxRewrites: body.maxRewritesPerChapter,
        maxRewritesPerChapter: body.maxRewritesPerChapter,
        autoRepair: true,
      },
      transform: (data) => {
        const source = isRecord(data) && isRecord(data.run) ? data.run : data
        return normalizeAutoRun(
          {
            ...(isRecord(source) ? source : {}),
            ...body,
            id: runIdFrom(data, "batch"),
          },
          0,
        )
      },
    },
  )
}

function normalizeAutoRunsForList(data: unknown) {
  return normalizeAutoRuns(data)
    .sort(compareRunsForWorkbench)
    .slice(0, AUTO_RUN_LIST_LIMIT)
    .map((run) => ({
      ...run,
      recentEvents: run.recentEvents.slice(0, AUTO_RUN_RECENT_EVENTS_LIMIT),
    }))
}

function compareRunsForWorkbench(a: AutoRun, b: AutoRun) {
  return (
    autoRunStatusRank(a.status) - autoRunStatusRank(b.status) ||
    b.startedAt - a.startedAt
  )
}
