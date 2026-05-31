/**
 * 自动续写任务的"伪后端" —— 进程内单例，按 wall-clock 推进状态。
 *
 * - codex 接手后，整个文件由真实 agent runner / 队列 / DB 替代。
 * - 期间所有路由 handler 仅通过本文件读写。
 * - 状态机：queued → running ⇄ rewriting → completed/failed/paused/cancelled
 */

import type { AutoRun, AutoRunCreate, AutoRunEvent } from "@/lib/api/types"

const AGENT_CHAIN: { id: string; nameZh: string; nameEn: string }[] = [
  { id: "market-radar", nameZh: "市场雷达", nameEn: "Market Radar" },
  { id: "architect", nameZh: "架构师", nameEn: "Architect" },
  { id: "setup-auditor", nameZh: "建书复审官", nameEn: "Setup Auditor" },
  { id: "planner", nameZh: "规划师", nameEn: "Planner" },
  { id: "writer", nameZh: "正文写手", nameEn: "Writer" },
  { id: "editor", nameZh: "审稿官", nameEn: "Editor" },
  { id: "reviser", nameZh: "修稿师", nameEn: "Reviser" },
  { id: "word-steward", nameZh: "字数治理官", nameEn: "Word Steward" },
  { id: "polisher", nameZh: "语句润色", nameEn: "Polisher" },
  { id: "chapter-analyst", nameZh: "章节分析官", nameEn: "Chapter Analyst" },
  { id: "state-verifier", nameZh: "状态校验员", nameEn: "State Verifier" },
  { id: "style-fingerprint", nameZh: "风格指纹官", nameEn: "Style Fingerprint" },
  { id: "reader-critic", nameZh: "读者评审官", nameEn: "Reader Critic" },
  { id: "quality-report", nameZh: "质量报告官", nameEn: "Quality Report" },
  { id: "prompt-steward", nameZh: "提示词治理官", nameEn: "Prompt Steward" },
]

type Internal = AutoRun & { _baseSeed: number }

const store: Map<string, Internal> = new Map()
let nextId = 1

// ---------- 写入 / 读取 ----------

export function listAutoRuns(): AutoRun[] {
  // 每次 list 都按 wall-clock 推进
  const list: AutoRun[] = []
  for (const r of store.values()) {
    list.push(advance(r))
  }
  return list.sort((a, b) => b.startedAt - a.startedAt)
}

export function getAutoRun(id: string): AutoRun | undefined {
  const r = store.get(id)
  if (!r) return undefined
  return advance(r)
}

export function createAutoRun(input: AutoRunCreate, bookTitle: { zh: string; en: string }): AutoRun {
  const id = `run-${String(nextId++).padStart(4, "0")}`
  const now = Date.now()
  const totalChapters = Math.max(1, input.toChapter - input.fromChapter + 1)
  // 假设 1500 字/分钟（包含改写）
  const etaMinutes = (totalChapters * input.targetWordsPerChapter) / 1500
  const run: Internal = {
    id,
    bookId: input.bookId,
    bookTitle,
    fromChapter: input.fromChapter,
    toChapter: input.toChapter,
    targetWordsPerChapter: input.targetWordsPerChapter,
    targetQuality: input.targetQuality,
    maxRewritesPerChapter: input.maxRewritesPerChapter,
    status: "running",
    currentChapter: input.fromChapter,
    currentRewrite: 0,
    currentWords: 0,
    currentAgentId: AGENT_CHAIN[4].id, // writer
    currentQuality: undefined,
    startedAt: now,
    eta: now + etaMinutes * 60_000,
    totalAdoptedWords: 0,
    totalTokens: 0,
    totalRewrites: 0,
    results: [],
    recentEvents: [
      mkEvent(now, "chapter.start", input.fromChapter, "writer", {
        zh: `开始续写第 ${input.fromChapter} 章`,
        en: `Started chapter ${input.fromChapter}`,
      }),
    ],
    _baseSeed: now,
  }
  store.set(id, run)
  return advance(run)
}

export function pauseAutoRun(id: string): AutoRun | undefined {
  const r = store.get(id)
  if (!r || r.status === "completed" || r.status === "failed" || r.status === "cancelled") return r ? advance(r) : undefined
  // 先把当前进度落库再暂停
  const advanced = advance(r)
  advanced.status = "cancelled"
  advanced.recentEvents = pushEvent(advanced.recentEvents, mkEvent(Date.now(), "run.error", undefined, undefined, { zh: "用户停止", en: "Stopped by user" }))
  ;(advanced as Internal)._baseSeed = (r as Internal)._baseSeed
  store.set(id, advanced as Internal)
  return advanced
}

export function resumeAutoRun(id: string): AutoRun | undefined {
  const r = store.get(id)
  if (!r) return undefined
  if (r.status !== "paused") return advance(r)
  const now = Date.now()
  // 重置基线时间，让 wall-clock 推进继续
  const internal: Internal = {
    ...(r as Internal),
    status: "running",
    _baseSeed: now - elapsedSeed(r as Internal),
    recentEvents: pushEvent(r.recentEvents, mkEvent(now, "run.resume", undefined, undefined, { zh: "继续运行", en: "Resumed" })),
  }
  store.set(id, internal)
  return advance(internal)
}

export function cancelAutoRun(id: string): AutoRun | undefined {
  const r = store.get(id)
  if (!r) return undefined
  const now = Date.now()
  const advanced = advance(r)
  advanced.status = "cancelled"
  advanced.recentEvents = pushEvent(advanced.recentEvents, mkEvent(now, "run.error", undefined, undefined, { zh: "用户终止", en: "Cancelled by user" }))
  ;(advanced as Internal)._baseSeed = (r as Internal)._baseSeed
  store.set(id, advanced as Internal)
  return advanced
}

// ---------- 内部：按 wall-clock 推进 ----------

function elapsedSeed(r: Internal): number {
  return Date.now() - r._baseSeed
}

/**
 * 推进一个任务到「现在」 —— 仅依赖 startedAt 与基线 seed，
 * 同一时刻多次调用得到一致结果（只读快照）。
 */
function advance(snap: Internal): Internal {
  if (snap.status === "paused" || snap.status === "completed" || snap.status === "failed" || snap.status === "cancelled") {
    return snap
  }
  const now = Date.now()
  const elapsed = (now - snap._baseSeed) / 1000 // seconds since start
  // 假定 25 字/秒（≈1500 字/分），改写额外耗时 0.4×
  const wordsPerSec = 25
  const wordsPerChapter = snap.targetWordsPerChapter

  // 模型化质量：基础 70 + 改写次数 +6 + 抖动；首次写出可能不达标
  const baseQuality = 70 + Math.sin(snap._baseSeed % 1000) * 6 + (snap.fromChapter % 3) * 2
  const qualityAfterRewrite = (rewrites: number) => Math.min(99, baseQuality + rewrites * 6)

  // 顺序流过：每章先写 wordsPerChapter，然后 review；review 不达标则改写一次（等量耗时×0.5）
  let cursor = elapsed * wordsPerSec
  let chapter = snap.fromChapter
  let rewrites = 0
  let totalAdopted = 0
  let totalRewrites = 0
  let curQuality: number | undefined = undefined
  let currentAgentId: string | undefined
  const events: AutoRunEvent[] = [...snap.recentEvents]

  while (chapter <= snap.toChapter) {
    // 写正文
    if (cursor < wordsPerChapter) {
      const wordsThis = Math.max(0, Math.floor(cursor))
      // 流程中段切换到 15-agent canonical chain.
      const phaseFraction = wordsThis / wordsPerChapter
      currentAgentId =
        phaseFraction < 0.55 ? "writer"
        : phaseFraction < 0.7 ? "editor"
        : phaseFraction < 0.85 ? "reviser"
        : phaseFraction < 0.95 ? "polisher"
        : "chapter-analyst"
      curQuality = undefined
      const accepted = totalAdopted + wordsThis
      return commit(snap, {
        status: "running",
        currentChapter: chapter,
        currentRewrite: rewrites,
        currentWords: wordsThis,
        currentAgentId,
        currentQuality: curQuality,
        totalAdoptedWords: accepted,
        totalRewrites: totalRewrites,
        totalTokens: Math.floor(accepted * 1.4),
        recentEvents: events,
      })
    }
    // 完成正文 → reviewer 评分
    cursor -= wordsPerChapter
    let q = qualityAfterRewrite(rewrites)
    while (q < snap.targetQuality && rewrites < snap.maxRewritesPerChapter) {
      // 改写阶段
      events.unshift(mkEvent(snap._baseSeed + (snap.toChapter - chapter) * 1000, "quality.gate.fail", chapter, "editor", {
        zh: `第 ${chapter} 章评分 ${q.toFixed(0)} 未达 ${snap.targetQuality}，触发改写`,
        en: `Ch.${chapter} scored ${q.toFixed(0)}, below ${snap.targetQuality} — rewriting`,
      }))
      events.unshift(mkEvent(snap._baseSeed + (snap.toChapter - chapter) * 1000 + 1, "rewrite.trigger", chapter, "reviser", {
        zh: `修稿师 + 润色师 重写第 ${chapter} 章`,
        en: `Reviser + Polisher rewriting ch.${chapter}`,
      }))
      const rewriteCost = wordsPerChapter * 0.5
      if (cursor < rewriteCost) {
        // 还在改写中
        return commit(snap, {
          status: "rewriting",
          currentChapter: chapter,
          currentRewrite: rewrites + 1,
          currentWords: Math.floor(cursor / 0.5), // 改写已写字数
          currentAgentId: "reviser",
          currentQuality: q,
          totalAdoptedWords: totalAdopted,
          totalRewrites: totalRewrites,
          totalTokens: Math.floor(totalAdopted * 1.4),
          recentEvents: events,
        })
      }
      cursor -= rewriteCost
      rewrites += 1
      totalRewrites += 1
      q = qualityAfterRewrite(rewrites)
      events.unshift(mkEvent(snap._baseSeed + (snap.toChapter - chapter) * 1000 + 2, "rewrite.success", chapter, "editor", {
        zh: `改写后第 ${chapter} 章评分 ${q.toFixed(0)}`,
        en: `Rewrite #${rewrites} on ch.${chapter} scored ${q.toFixed(0)}`,
      }))
    }
    // 章节通过或失败
    if (q >= snap.targetQuality) {
      events.unshift(mkEvent(snap._baseSeed + (snap.toChapter - chapter) * 1000 + 3, "chapter.complete", chapter, "quality-report", {
        zh: `第 ${chapter} 章完成 · 评分 ${q.toFixed(0)}`,
        en: `Ch.${chapter} complete · score ${q.toFixed(0)}`,
      }))
      totalAdopted += wordsPerChapter
      curQuality = q
    } else {
      // 改写超限失败
      return commit(snap, {
        status: "failed",
        currentChapter: chapter,
        currentRewrite: rewrites,
        currentWords: 0,
        currentAgentId: "quality-report",
        currentQuality: q,
        totalAdoptedWords: totalAdopted,
        totalRewrites: totalRewrites,
        totalTokens: Math.floor(totalAdopted * 1.4),
        recentEvents: pushEvent(events, mkEvent(Date.now(), "run.error", chapter, undefined, {
          zh: `第 ${chapter} 章经 ${rewrites} 次改写仍未达阈值，运行终止`,
          en: `Ch.${chapter} failed quality gate after ${rewrites} rewrites`,
        })),
      })
    }
    chapter += 1
    rewrites = 0
    if (chapter <= snap.toChapter) {
      events.unshift(mkEvent(snap._baseSeed + (snap.toChapter - chapter) * 1000 + 4, "chapter.start", chapter, "writer", {
        zh: `开始续写第 ${chapter} 章`,
        en: `Started chapter ${chapter}`,
      }))
    }
  }

  // 全部完成
  return commit(snap, {
    status: "completed",
    currentChapter: snap.toChapter,
    currentRewrite: 0,
    currentWords: snap.targetWordsPerChapter,
    currentAgentId: "quality-report",
    currentQuality: curQuality,
    totalAdoptedWords: totalAdopted,
    totalRewrites: totalRewrites,
    totalTokens: Math.floor(totalAdopted * 1.4),
    recentEvents: events,
  })
}

function commit(prev: Internal, patch: Partial<AutoRun>): Internal {
  const next: Internal = { ...prev, ...patch }
  // 截断事件流
  next.recentEvents = next.recentEvents.slice(0, 12)
  return next
}

function mkEvent(
  ts: number,
  type: AutoRunEvent["type"],
  chapter: number | undefined,
  agentId: string | undefined,
  message: AutoRunEvent["message"],
): AutoRunEvent {
  return { ts, type, chapter, agentId, message }
}

function pushEvent(arr: AutoRunEvent[], e: AutoRunEvent): AutoRunEvent[] {
  return [e, ...arr].slice(0, 12)
}

// ---------- 演示种子：启动时预置两本运行中的任务 ----------

let seeded = false
export function ensureSeeded(): void {
  if (seeded) return
  seeded = true
  const now = Date.now()
  // 第一本：开始 4 分钟前，正在写第 6 章，3000 字目标
  store.set("run-0001", {
    id: "run-0001",
    bookId: "book-instance-arrival",
    bookTitle: { zh: "星尘邮局今晚开张", en: "After the Instance" },
    fromChapter: 6,
    toChapter: 12,
    targetWordsPerChapter: 3000,
    targetQuality: 82,
    maxRewritesPerChapter: 3,
    status: "running",
    currentChapter: 6,
    currentRewrite: 0,
    currentWords: 0,
    startedAt: now - 4 * 60_000,
    eta: now + 18 * 60_000,
    totalAdoptedWords: 0,
    totalTokens: 0,
    totalRewrites: 0,
    results: [],
    recentEvents: [],
    _baseSeed: now - 4 * 60_000,
  })
  // 第二本：开始 11 分钟前，写第 19 章，2200 字目标，更激进的质量门槛
  store.set("run-0002", {
    id: "run-0002",
    bookId: "book-cyber-cultivation",
    bookTitle: { zh: "赛博修仙：代码入道", en: "Cyber Cultivation" },
    fromChapter: 19,
    toChapter: 24,
    targetWordsPerChapter: 2200,
    targetQuality: 86,
    maxRewritesPerChapter: 4,
    status: "running",
    currentChapter: 19,
    currentRewrite: 0,
    currentWords: 0,
    startedAt: now - 11 * 60_000,
    eta: now + 9 * 60_000,
    totalAdoptedWords: 0,
    totalTokens: 0,
    totalRewrites: 0,
    results: [],
    recentEvents: [],
    _baseSeed: now - 11 * 60_000,
  })
  nextId = 3
}
