/**
 * 卷舍 · LlmClient 的 Vercel AI SDK 适配(BYOK + 强/快双模型 + 流式 + 结构化)
 *
 * 引擎核心只认 LlmClient 接口;provider 细节全锁在这一个文件,因此:
 *  - 换底座/加 provider 只动这里;
 *  - 引擎其余部分零 `ai` 依赖,可单测、可跑在无 SDK 的环境。
 *
 * 设计:
 *  - BYOK:用户自带 key/baseURL → createOpenAICompatible 通吃 OpenAI/DeepSeek/Moonshot/… 任意兼容端;
 *          provider==="anthropic" 走 createAnthropic。
 *  - tier:strong/fast 各一套 LlmConfig(fast 缺省回落 strong),按调用的 modelTier 切模型。
 *  - 流式:有 onToken → streamText 逐字回调;否则 generateText。
 *  - 结构化:generateObject(provider 原生 JSON schema 约束,语法级保证形状)。
 *
 * 故意不从 index.ts 导出:避免未装 `ai` 的消费者被牵连;按需 `import ".../llm/vercel.js"`。
 */
import { generateText, streamText, generateObject } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import type { LlmConfig } from "../models/index.js"
import type { LlmClient, LlmCallOptions } from "./client.js"
import type { ModelTier, AbortLike } from "../orchestration/pipeline.js"

export interface VercelLlmConfig {
  /** 强模型(写作/审稿/规划/修订/判官)*/
  strong: LlmConfig
  /** 快模型(润色等;缺省回落到 strong)*/
  fast?: LlmConfig
}

// 已知 OpenAI 兼容端的默认 baseURL(BYOK 自带 baseUrl 时以用户的为准)。
// createOpenAICompatible 要求 baseURL 必填(任意兼容端必须显式给地址)。
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1",
  kimi: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  // 本机 Exo 集群等自部署端点请在 LlmConfig.baseUrl 显式给出
}

function buildModel(cfg: LlmConfig) {
  const headers = cfg.extraHeaders
  if (cfg.provider === "anthropic") {
    const anthropic = createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, headers })
    return anthropic(cfg.model)
  }
  const baseURL = cfg.baseUrl ?? DEFAULT_BASE_URLS[cfg.provider] ?? "https://api.openai.com/v1"
  const provider = createOpenAICompatible({
    name: cfg.provider || "openai-compatible",
    apiKey: cfg.apiKey,
    baseURL,
    headers,
    // BYOK 全兼容:DeepSeek/Kimi 等多数兼容端不支持 OpenAI 的 json_schema response_format,
    // 关掉它 → generateObject 退回 json_object 模式(把 schema 注入提示词 + 客户端 zod 校验),
    // 结构化输出在任意兼容端都能跑;严格性由引擎自己的 zod 守住,不丢。
    supportsStructuredOutputs: false,
  })
  return provider(cfg.model)
}

function toMessages(opts: LlmCallOptions) {
  return opts.messages.map((m) => ({ role: m.role, content: m.content }))
}

// 容错抽取模型返回里的 JSON(剥 ```json 围栏 / 前后缀解说,取最外层 { } 或 [ ])。
// 纯文本拒答 / 非法 JSON 时抛"带原文片段"的明确错误,而非裸 SyntaxError(便于诊断与上层降级)。
function extractJson(text: string): unknown {
  let s = (text ?? "").trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence) s = fence[1].trim()
  const start = s.search(/[{[]/)
  if (start < 0) throw new Error(`模型未返回 JSON(疑似纯文本拒答):${(text ?? "").slice(0, 120)}`)
  const open = s[start]
  const close = open === "{" ? "}" : "]"
  const end = s.lastIndexOf(close)
  if (end > start) s = s.slice(start, end + 1)
  try {
    return JSON.parse(s)
  } catch {
    throw new Error(`模型输出的 JSON 无法解析:${s.slice(0, 120)}`)
  }
}

// 单次模型调用硬超时:provider 卡死时不致整条流水线无限挂起、空占并发槽。
// 与上层 BYOK 中断信号合并(真 AbortSignal 才用 AbortSignal.any;自定义/缺失则各自降级,绝不抛)。
const CALL_TIMEOUT_MS = 180_000
function callSignal(sig?: AbortLike): AbortSignal | undefined {
  let timeout: AbortSignal | undefined
  try {
    timeout = AbortSignal.timeout(CALL_TIMEOUT_MS)
  } catch {
    timeout = undefined
  }
  if (!timeout) return sig as AbortSignal | undefined
  if (sig) {
    try {
      if (sig instanceof AbortSignal) return AbortSignal.any([timeout, sig])
    } catch {
      /* 降级:用上层信号 */
    }
    return sig as AbortSignal | undefined
  }
  return timeout
}

export function createVercelLlm(cfg: VercelLlmConfig): LlmClient {
  const pick = (tier?: ModelTier): LlmConfig => (tier === "fast" && cfg.fast ? cfg.fast : cfg.strong)

  return {
    async generate(opts) {
      const conf = pick(opts.modelTier)
      const base = {
        model: buildModel(conf),
        system: opts.system,
        messages: toMessages(opts),
        temperature: opts.temperature ?? conf.temperature,
        maxOutputTokens: opts.maxOutputTokens ?? conf.maxOutputTokens,
        abortSignal: callSignal(opts.signal),
      }
      if (opts.onToken) {
        const result = streamText(base)
        for await (const delta of result.textStream) opts.onToken(delta)
        const [text, usage] = await Promise.all([result.text, result.usage])
        return { text, tokens: usage?.totalTokens }
      }
      const { text, usage } = await generateText(base)
      return { text, tokens: usage?.totalTokens }
    },

    async generateStructured(opts) {
      const conf = pick(opts.modelTier)
      const base = {
        model: buildModel(conf),
        system: opts.system,
        messages: toMessages(opts),
        temperature: opts.temperature ?? conf.temperature,
        maxOutputTokens: opts.maxOutputTokens ?? conf.maxOutputTokens,
        abortSignal: callSignal(opts.signal),
      }
      try {
        const { object, usage } = await generateObject({ ...base, schema: opts.schema })
        return { data: object, tokens: usage?.totalTokens }
      } catch {
        // 兜底:多数 OpenAI 兼容端(DeepSeek/Kimi/自部署…)不支持 json_schema 强约束,
        // generateObject 会失败或返回不可解析文本。退回纯文本 + 强 JSON 指令 + 容错解析,
        // 严格性由我们自己的 zod.parse 守住(失败则抛错触发阶段重试)。
        const sys = `${opts.system}\n\n【输出格式】只输出一个 JSON 对象,严格对应所需结构;不要 markdown 代码围栏,不要任何解释或前后缀文字。`
        const { text, usage } = await generateText({ ...base, system: sys })
        const data = opts.schema.parse(extractJson(text))
        return { data, tokens: usage?.totalTokens }
      }
    },
  }
}
