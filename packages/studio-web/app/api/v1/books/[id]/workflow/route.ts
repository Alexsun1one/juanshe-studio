import { WORKFLOW_STAGES, type WorkflowStage } from "@/lib/studio-data"
import { normalizeWorkflowSnapshot } from "@/lib/api/backend-transforms"
import { proxyJSONOrFallback } from "@/lib/api/facade"
import { jsonOK } from "@/lib/api/route-helpers"

/** GET /api/v1/books/:id/workflow */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  return proxyJSONOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/workflow-status`,
    () => {
      const activeAgentsByStage = emptyStages<string[]>((stage) => [])
      const stageProgress = emptyStages<number>(() => 0)

      return jsonOK({
        bookId: id,
        currentStage: "prepare" as WorkflowStage,
        stageProgress,
        activeAgentsByStage,
        totalProgress: 0,
        startedAt: new Date().toISOString(),
      })
    },
    { transform: (data) => normalizeWorkflowSnapshot(data, id) },
  )
}

function emptyStages<T>(value: (stage: WorkflowStage) => T) {
  return WORKFLOW_STAGES.reduce(
    (acc, stage) => {
      acc[stage.id] = value(stage.id)
      return acc
    },
    {} as Record<WorkflowStage, T>,
  )
}
