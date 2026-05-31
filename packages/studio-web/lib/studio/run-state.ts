import { AGENTS, WORKFLOW_STAGES, type WorkflowStage } from "@/lib/studio-data"
import type { AutoRun, WorkflowSnapshot } from "@/lib/api/types"
import {
  isLiveAutoRunStatus,
  isRecoverableAutoRunStatus,
} from "@/lib/studio/run-status"

const INTERRUPTED_RE =
  /服务重启中断|旧锁已释放|lost in-memory owner|restart|等待继续复修|低分修复未达标|模型返回内容过短/i

export function latestBookRun(runs: AutoRun[] | undefined, bookId: string) {
  return bookRuns(runs, bookId)[0]
}

export function latestActiveBookRun(
  runs: AutoRun[] | undefined,
  bookId: string,
  continuationChapter?: number,
) {
  const scopedRuns = bookRuns(runs, bookId)
  const exactRun = scopedRuns
    .filter((run) => isRunRelevantToContinuation(run, continuationChapter))
    .find(isActiveAutoRun)

  if (typeof continuationChapter === "number" && continuationChapter > 0) {
    // 关键修复：批量复修/欠债修复的 run 区间(如 11–51)可能不覆盖续写章(52)，
    // 旧逻辑会因此判定"无相关 run"→ 工作流链回退到静态快照、看起来"完全没有变化"。
    // 若精确匹配为空，则跟随本书任意一个活跃 run，让实时链路真实推进。
    return exactRun ?? scopedRuns.find(isActiveAutoRun)
  }

  return scopedRuns.find(isActiveAutoRun)
}

export function latestInterruptedBookRun(
  runs: AutoRun[] | undefined,
  bookId: string,
  continuationChapter?: number,
) {
  return bookRuns(runs, bookId, continuationChapter).find(isRecoverableInterruptedRun)
}

export function isActiveAutoRun(run: AutoRun | undefined) {
  return Boolean(
    run &&
      isLiveAutoRunStatus(run.status) &&
      !isRecoverableInterruptedRun(run),
  )
}

export function isRecoverableInterruptedRun(run: AutoRun | undefined) {
  if (!run) return false
  if (isRecoverableAutoRunStatus(run.status)) return true
  const text = [
    run.currentStage,
    run.error,
    run.failureReason,
    run.suggestion,
  ]
    .filter(Boolean)
    .join(" ")
  return INTERRUPTED_RE.test(text)
}

export function runMessage(run: AutoRun | undefined) {
  if (!run) return ""
  if (isRecoverableInterruptedRun(run)) {
    const completedChapter = latestPassedResultChapter(run)
    const nextChapter = Math.max(
      run.fromChapter,
      Math.min(run.toChapter, Math.max(run.currentChapter, completedChapter + 1)),
    )

    if (completedChapter >= run.fromChapter) {
      return `旧任务中断，可从第 ${nextChapter} 章续跑；已落库至第 ${completedChapter} 章`
    }
  }

  return run.currentStage || run.failureReason || run.suggestion || ""
}

export function runProgress(run: AutoRun | undefined) {
  if (!run) return 0
  const chapterSpan = Math.max(1, run.toChapter - run.fromChapter + 1)
  const completedChapters = Math.max(0, run.currentChapter - run.fromChapter)
  const chapterWords =
    run.targetWordsPerChapter > 0
      ? Math.min(1, Math.max(0, run.currentWords / run.targetWordsPerChapter))
      : 0
  return Math.min(1, Math.max(0, (completedChapters + chapterWords) / chapterSpan))
}

export function workflowSnapshotFromRun(
  run: AutoRun | undefined,
): WorkflowSnapshot | null {
  if (!run) return null
  const currentStage = workflowStageForRun(run)
  const currentIndex = WORKFLOW_STAGES.findIndex((stage) => stage.id === currentStage)
  const progress = runProgress(run)
  const stageProgress = Object.fromEntries(
    WORKFLOW_STAGES.map((stage, index) => [
      stage.id,
      index < currentIndex ? 1 : index === currentIndex ? progress : 0,
    ]),
  ) as Record<WorkflowStage, number>
  const activeAgentsByStage = Object.fromEntries(
    WORKFLOW_STAGES.map((stage) => [stage.id, [] as string[]]),
  ) as Record<WorkflowStage, string[]>

  if (run.currentAgentId) {
    activeAgentsByStage[currentStage] = [run.currentAgentId]
  }

  return {
    bookId: run.bookId,
    currentStage,
    stageProgress,
    activeAgentsByStage,
    totalProgress: Math.min(
      1,
      Math.max(0, (Math.max(0, currentIndex) + progress) / WORKFLOW_STAGES.length),
    ),
    startedAt: new Date(run.startedAt).toISOString(),
    etaAt: run.eta ? new Date(run.eta).toISOString() : undefined,
  }
}

function bookRuns(
  runs: AutoRun[] | undefined,
  bookId: string,
  continuationChapter?: number,
) {
  return (runs ?? [])
    .filter((run) => run.bookId === bookId)
    .filter((run) => isRunRelevantToContinuation(run, continuationChapter))
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
}

function isRunRelevantToContinuation(
  run: AutoRun,
  continuationChapter: number | undefined,
) {
  if (typeof continuationChapter !== "number" || continuationChapter <= 0) {
    return true
  }
  return run.fromChapter <= continuationChapter && continuationChapter <= run.toChapter
}

function latestPassedResultChapter(run: AutoRun) {
  return (run.results ?? []).reduce((latest, result) => {
    const accepted =
      result.pass ||
      result.generated ||
      result.skipped ||
      result.applied ||
      result.status === "ready-for-review"

    if (!accepted || typeof result.chapterNumber !== "number") {
      return latest
    }

    return Math.max(latest, result.chapterNumber)
  }, 0)
}

function workflowStageForRun(run: AutoRun): WorkflowStage {
  const agentStage = AGENTS.find((agent) => agent.id === run.currentAgentId)?.stage
  if (agentStage) return agentStage

  const type = run.type ?? ""
  if (/create|foundation|outline/.test(type)) return "prepare"
  if (/write|generate/.test(type)) return "generate"
  if (/quality|repair|rewrite|revise/.test(type)) return "revise"
  if (/persist|state|report/.test(type)) return "persist"
  return "review"
}
