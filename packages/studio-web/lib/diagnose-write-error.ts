// ──────────────────────────────────────────────────────────────────────────
// 统一的「写作 / 建书失败」诊断器
//
// 历史上同一类失败被四处各写一遍判定(write-block-toast 看 code、new-book-dialog
// 用 isModelConfigFailure 正则、page.tsx 用 failIsModel/failIsFoundation 正则、
// llm 页用 describeConnError),口径不一致 → 同一个上游错误,在 A 入口被识别成
// 「模型坏了·去配模型」、在 B 入口只给「重试」。这里收成唯一真相:任何地方撞墙,
// 都先过这个诊断器,拿到同一种 kind + 同一句人话,再由 useRecoveryActions 配同一套按钮。
// ──────────────────────────────────────────────────────────────────────────

import { ApiClientError } from "@/lib/api/client"

export type WriteErrorKind = "model" | "foundation" | "gate" | "transient" | "unknown"

export interface WriteErrorDiagnosis {
  kind: WriteErrorKind
  /** 短标题 */
  title: string
  /** 给用户看的人话(不含原始英文/技术串) */
  human: string
  /** 原始错误文本,供悬浮 title / 调试保留 */
  raw: string
  /** gate 类:卡住的章节 / 分数 / 目标分 / 是否其实已达标 */
  gate?: { chapterNumber?: number; score?: number; targetScore?: number; alreadyQualified?: boolean }
}

// 模型 / Key / 上游故障(鉴权、无可用渠道、余额、模型挂起超时、网关过载、连不上、4xx/5xx…)。
// 只放"明确指向你这把 Key / 这个模型 / 这家中转站配置"的信号:鉴权、额度、无可用渠道、模型不存在、
// 401/402/403/429。**故意不含 5xx / Bad Gateway / nginx / 网关 / 上游 / 挂起超时**——那些是"服务一时
// 没接通",归 TRANSIENT。否则一次 nginx 502(我们后端在重启)会被误判成"你的模型坏了,去改设置",把人带错路。
const MODEL_RE =
  /鉴权|API\s*Key|密钥|令牌|无效或过期|未授权|请求被拒绝?|无可用渠道|no available channel|余额|额度|欠费|insufficient|限流|请求过多|请求过于频繁|模型权限|模型不存在|未上架|model not found|\b(401|402|403|429)\b/i

// 地基没搭完(故事框架 / 大纲生成失败 / 复审没过)。
const FOUNDATION_RE =
  /foundation\s+(is\s+)?incomplete|blocked-foundation|地基(未|没|还没|不完整)|需补地基|story[_\s]?bible|架构(未|没)完成/i

// 质量门禁挡续写(从纯文本里识别;结构化 payload 会走更精确的分支)。
const GATE_RE = /quality[-\s]?gate|质量门|过线分|未达标|低于门槛|分数未达|未过线/i

// 瞬时 / 网关错(服务一时没接通):nginx/Cloudflare 的 HTML 错误页、5xx、Bad Gateway、网关/上游/过载、
// 网络抖动、超时、模型挂起空闲。这些是"等几秒重试就行",不是"你的 Key 坏了"。**在 MODEL 之后判**——
// 这样 relay 的"503 无可用渠道"仍归 MODEL(无可用渠道命中在先),而纯"502 Bad Gateway"才归这里。
const TRANSIENT_RE =
  /<!doctype html|<html|<head>|bad gateway|gateway time-?out|\bnginx\b|cloudflare|\b(500|502|503|504)\b|网关|上游|upstream|过载|overload|service unavailable|temporarily unavailable|无法连接|连不上|econn|socket|getaddrinfo|\bdns\b|reset|refused|unreachable|disconnect|timeout|timed out|aborted?|网络|连接超时|超时|稍后重试|临时|temporar|模型.{0,8}(挂起|空闲|超时)|LLM_CALL_TIMEOUT/i

const HUMAN: Record<Exclude<WriteErrorKind, "unknown">, { title: string; human: string }> = {
  model: {
    title: "模型 / API Key 出问题了",
    human:
      "这次失败出在你的大模型 / API Key 那一侧,跟你的故事构思无关。多半是 Key 失效或没填、额度/余额用尽、没开通这个模型,或中转站不稳。先去「模型配置」把它修好(或换个更稳的模型),再回来重试。",
  },
  foundation: {
    title: "地基还没搭好",
    human:
      "这本书的地基(故事框架 / 大纲)还没生成成功,没法直接写正文。先去补好地基,再开写 —— 跟正文写得好不好无关。",
  },
  gate: {
    title: "卡在质量门槛",
    human:
      "有章节没到你设的过线分,挡住了继续写。可以放行已达标的章节、签发卡住的低分章往下写(事后还能再修),或让编辑部复修到达标。",
  },
  transient: {
    title: "服务一时没接通",
    human:
      "这次没接通,多半是后端在重启、或网关 / 中转站临时抖动 —— 跟你的故事和 Key 都没关系。等几秒直接重试通常就好;要是反复这样,再去「模型配置」看看 Key 和额度。",
  },
}

function errorText(e: unknown): string {
  if (e == null) return ""
  if (typeof e === "string") return e
  if (e instanceof Error) return e.message
  try {
    return String((e as { message?: unknown }).message ?? e)
  } catch {
    return ""
  }
}

/** 从纯文本错误判定(横幅 run.lastError、建书弹窗 errMsg 等没有结构化 payload 的场景)。 */
export function classifyErrorText(text: string): WriteErrorDiagnosis {
  const raw = String(text ?? "")
  // 模型优先:模型/Key 坏了是续写、建地基的共同前置,先修它;纯地基(无模型特征)才归 foundation。
  if (MODEL_RE.test(raw)) return { kind: "model", ...HUMAN.model, raw }
  if (FOUNDATION_RE.test(raw)) return { kind: "foundation", ...HUMAN.foundation, raw }
  if (GATE_RE.test(raw)) return { kind: "gate", ...HUMAN.gate, raw }
  if (TRANSIENT_RE.test(raw)) return { kind: "transient", ...HUMAN.transient, raw }
  return { kind: "unknown", title: "上次没能正常完成", human: raw.slice(0, 160) || "上次写作没能正常结束,可以直接重试。", raw }
}

/** 任意错误的统一诊断:优先信任后端结构化 payload,否则退回文本判定。 */
export function diagnoseWriteError(e: unknown): WriteErrorDiagnosis {
  const raw = errorText(e)
  const payload =
    e instanceof ApiClientError && e.payload && typeof e.payload === "object"
      ? (e.payload as Record<string, unknown>)
      : null

  if (payload) {
    const errObj =
      payload.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : null
    if (errObj?.code === "LLM_NOT_CONFIGURED") {
      return {
        kind: "model",
        title: "还没配置写作模型",
        human: String(errObj.message ?? "填入你的大模型 API Key,保存后就能开始写。"),
        raw,
      }
    }
    if (payload.status === "needs-foundation") {
      return {
        kind: "foundation",
        ...HUMAN.foundation,
        human: String(payload.failureReason || payload.suggestion || HUMAN.foundation.human),
        raw,
      }
    }
    if (payload.status === "quality-gate-blocked") {
      const score = typeof payload.score === "number" ? payload.score : undefined
      const targetScore = typeof payload.targetScore === "number" ? payload.targetScore : 80
      return {
        kind: "gate",
        ...HUMAN.gate,
        raw,
        gate: {
          chapterNumber: typeof payload.chapterNumber === "number" ? payload.chapterNumber : undefined,
          score,
          targetScore,
          alreadyQualified: typeof score === "number" ? score >= targetScore : false,
        },
      }
    }
  }

  return classifyErrorText(raw)
}

/** 便捷布尔(给只关心「是不是模型/地基故障」的横幅用),内部仍走同一判定。 */
export function isModelFailure(text: string): boolean {
  return classifyErrorText(text).kind === "model"
}
export function isFoundationFailure(text: string): boolean {
  return classifyErrorText(text).kind === "foundation"
}
