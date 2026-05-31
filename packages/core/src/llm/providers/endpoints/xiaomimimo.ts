/**
 * 小米 MiMo
 *
 * - 官网：https://api-ai.xiaomi.com/
 * - API 端点：https://api-ai.xiaomi.com/v1 (OpenAI 兼容)
 * - 模型卡 (HuggingFace)：https://huggingface.co/XiaomiMiMo
 *
 * MiMo 是小米自研模型系列，除小米官方 /v1 外，也在 PPIO / 百炼等第三方平台开放。
 */
import type { HardWriteEndpoint } from "../types.js";

export const XIAOMI_MIMO: HardWriteEndpoint = {
  id: "xiaomimimo",
  label: "小米 MiMo",
  group: "china",
  api: "openai-completions",
  baseUrl: "https://api-ai.xiaomi.com/v1",
  temperatureRange: [0, 2],
  defaultTemperature: 0.7,
  writingTemperature: 1,
  models: [
    // v2.5 系列(Token Plan / token-plan-cn.xiaomimimo.com)。注意 v2.5-pro 的最大输出仅 16384,
    // 远小于 fallback 24576——没有这张卡时写手会按 24576 请求 → 上游 400。务必保留正确的 maxOutput。
    { id: "mimo-v2.5-pro", maxOutput: 16384, contextWindowTokens: 1048576, enabled: true, releasedAt: "2026-05-01", fastSibling: "mimo-v2-flash" },
    { id: "mimo-v2.5", maxOutput: 131072, contextWindowTokens: 1048576, enabled: true, releasedAt: "2026-05-01", fastSibling: "mimo-v2-flash" },
    { id: "mimo-v2-pro", maxOutput: 131072, contextWindowTokens: 1000000, enabled: true, releasedAt: "2026-03-18", fastSibling: "mimo-v2-flash" },
    { id: "mimo-v2-omni", maxOutput: 131072, contextWindowTokens: 262144, enabled: true, releasedAt: "2026-03-18" },
    { id: "mimo-v2-flash", maxOutput: 65536, contextWindowTokens: 262144, enabled: true, releasedAt: "2026-03-03" },
  ],
};
