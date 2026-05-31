/**
 * 卷舍 · LLM 客户端接口(provider 无关)
 *
 * 引擎只依赖这个接口;具体实现(Vercel AI SDK 适配:多 provider/结构化输出/流式/按 tier 切模型)
 * 单独放一个适配文件,装了 `ai` SDK 再写——这样引擎核心保持 provider 无关、可单测、可换底座。
 *
 * 砸中"快":generateStructured 用 provider 原生结构化输出(语法级保证),onToken 流式推前端;
 * 调用方按阶段 modelTier 选强/快模型(审稿用强、润色用快)。
 */
import type { z } from "zod"
import type { AbortLike, ModelTier } from "../orchestration/pipeline.js"

export type ChatMessage = { readonly role: "user" | "assistant"; readonly content: string }

export interface LlmCallOptions {
  readonly system: string
  readonly messages: readonly ChatMessage[]
  readonly temperature?: number
  readonly maxOutputTokens?: number
  /** 按阶段选强/快模型(审稿/写作用强,润色用快)——适配器据此切底层模型 */
  readonly modelTier?: ModelTier
  /** 流式逐字回调(写作/润色阶段推前端 SSE)*/
  readonly onToken?: (delta: string) => void
  readonly signal?: AbortLike
}

export interface LlmResult {
  readonly text: string
  readonly tokens?: number
}
export interface LlmStructuredResult<T> {
  readonly data: T
  readonly tokens?: number
}

export interface LlmClient {
  /** 纯文本生成(可流式)*/
  generate(opts: LlmCallOptions): Promise<LlmResult>
  /**
   * 结构化生成:按 zod schema 产出并校验(provider 原生 structured outputs)。
   * 用 `S extends z.ZodTypeAny` + `z.infer<S>` 直接取 schema 的 **输出类型**
   * (含 .default() 填充后的字段),避免 Output/Input 类型歧义。
   */
  generateStructured<S extends z.ZodTypeAny>(
    opts: LlmCallOptions & { schema: S },
  ): Promise<LlmStructuredResult<z.infer<S>>>
}
