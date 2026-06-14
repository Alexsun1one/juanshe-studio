import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";

export const GLOBAL_CONFIG_DIR = join(homedir(), ".autow");
export const GLOBAL_ENV_PATH = join(GLOBAL_CONFIG_DIR, ".env");

export type LLMEnvMap = Record<string, string | undefined>;

const LLM_ENV_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ["JUANSHE_LLM_SERVICE", "HARDWRITE_LLM_SERVICE", "AUTOW_LLM_SERVICE"],
  ["JUANSHE_LLM_PROVIDER", "HARDWRITE_LLM_PROVIDER", "AUTOW_LLM_PROVIDER"],
  ["JUANSHE_LLM_BASE_URL", "HARDWRITE_LLM_BASE_URL", "AUTOW_LLM_BASE_URL"],
  ["JUANSHE_LLM_MODEL", "HARDWRITE_LLM_MODEL", "AUTOW_LLM_MODEL"],
  ["JUANSHE_LLM_API_KEY", "HARDWRITE_LLM_API_KEY", "AUTOW_LLM_API_KEY"],
  ["JUANSHE_LLM_TEMPERATURE", "HARDWRITE_LLM_TEMPERATURE", "AUTOW_LLM_TEMPERATURE"],
  ["JUANSHE_LLM_THINKING_BUDGET", "HARDWRITE_LLM_THINKING_BUDGET", "AUTOW_LLM_THINKING_BUDGET"],
  ["JUANSHE_LLM_PROXY_URL", "HARDWRITE_LLM_PROXY_URL", "AUTOW_LLM_PROXY_URL"],
  ["JUANSHE_LLM_API_FORMAT", "HARDWRITE_LLM_API_FORMAT", "AUTOW_LLM_API_FORMAT"],
  ["JUANSHE_LLM_STREAM", "HARDWRITE_LLM_STREAM", "AUTOW_LLM_STREAM"],
  ["JUANSHE_LLM_HEADERS", "HARDWRITE_LLM_HEADERS", "AUTOW_LLM_HEADERS"],
  ["JUANSHE_DEFAULT_LANGUAGE", "HARDWRITE_DEFAULT_LANGUAGE", "AUTOW_DEFAULT_LANGUAGE"],
];

export interface LLMEnvLayers {
  readonly global: LLMEnvMap;
  readonly project: LLMEnvMap;
  readonly process: LLMEnvMap;
}

function isSaasModeEnabled(): boolean {
  return process.env.HARDWRITE_SAAS_MODE === "1" || process.env.HARDWRITE_SAAS_MODE === "true";
}

// LLM 端点相关的环境键(service/provider/baseUrl/model/apiKey/proxy 等)在 SaaS 多租户下绝不能
// 从全局层泄漏:否则运维机器上的全局 HARDWRITE_LLM_* / ~/.autow/.env 会污染所有租户配置 + 计费边界。
// 与 secrets.ts 的 getServiceApiKey env 回退同款 SaaS-gating。
const LLM_ENV_KEY_PREFIXES = ["JUANSHE_LLM_", "HARDWRITE_LLM_", "AUTOW_LLM_"] as const;
function stripLLMEnvKeys(env: LLMEnvMap): LLMEnvMap {
  const filtered: LLMEnvMap = {};
  for (const [key, value] of Object.entries(env)) {
    if (LLM_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    filtered[key] = value;
  }
  return filtered;
}

export async function loadLLMEnvLayers(
  root: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<LLMEnvLayers> {
  const saas = isSaasModeEnabled();
  // SaaS:丢弃全局 ~/.autow/.env 的 LLM 端点键(各租户只认自己 .saas/tenants/{tid}/ 下的配置/secrets)。
  const global = saas ? stripLLMEnvKeys(await parseEnvFile(GLOBAL_ENV_PATH)) : await parseEnvFile(GLOBAL_ENV_PATH);
  const project = await parseEnvFile(join(root, ".env"));
  if (saas) {
    // SaaS:绝不把全局/进程级 LLM 端点键回灌进 process.env(会被 modelOverrides.apiKeyEnv 等直读 → 串户)。
    // 只回灌 tenant 自己 .env 的键(project 层),全局键剥掉。
    hydrateProcessEnvFromEnvFiles(processEnv, {}, project);
    return {
      global,
      project,
      // process 层也剥掉 LLM 端点键:SaaS 下进程级全局 LLM env 同样不可作为租户回退源。
      process: stripLLMEnvKeys(normalizeHardWriteEnvAliases({ ...processEnv })),
    };
  }
  // Compatibility: modelOverrides.apiKeyEnv and detector config still read process.env directly.
  hydrateProcessEnvFromEnvFiles(processEnv, global, project);

  return {
    global,
    project,
    process: normalizeHardWriteEnvAliases({ ...processEnv }),
  };
}

export function mergeEnvMaps(...layers: readonly LLMEnvMap[]): LLMEnvMap {
  const merged: LLMEnvMap = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

export function studioIgnoredEnv(layers: LLMEnvLayers): LLMEnvMap {
  return mergeEnvMaps(layers.global, layers.project, layers.process);
}

export function cliOverlayEnv(layers: LLMEnvLayers): LLMEnvMap {
  return mergeEnvMaps(layers.global, layers.project, layers.process);
}

export function legacyEnv(layers: LLMEnvLayers): LLMEnvMap {
  return mergeEnvMaps(layers.global, layers.project, layers.process);
}

async function parseEnvFile(path: string): Promise<LLMEnvMap> {
  try {
    return normalizeHardWriteEnvAliases(parse(await readFile(path, "utf-8")));
  } catch {
    return {};
  }
}

export function normalizeHardWriteEnvAliases(env: LLMEnvMap): LLMEnvMap {
  const normalized = { ...env };
  for (const group of LLM_ENV_ALIAS_GROUPS) {
    const firstValue = group.map((key) => normalized[key]).find((value) => value !== undefined);
    if (firstValue === undefined) continue;
    for (const key of group) {
      if (normalized[key] === undefined) normalized[key] = firstValue;
    }
  }
  const extraPrefixes = ["JUANSHE_LLM_EXTRA_", "HARDWRITE_LLM_EXTRA_", "AUTOW_LLM_EXTRA_"] as const;
  for (const [key, value] of Object.entries(env)) {
    const matchedPrefix = extraPrefixes.find((prefix) => key.startsWith(prefix));
    if (!matchedPrefix || value === undefined) continue;
    const suffix = key.slice(matchedPrefix.length);
    for (const prefix of extraPrefixes) {
      const aliasKey = `${prefix}${suffix}`;
      if (normalized[aliasKey] === undefined) normalized[aliasKey] = value;
    }
  }
  return normalized;
}

function hydrateProcessEnvFromEnvFiles(
  processEnv: NodeJS.ProcessEnv,
  global: LLMEnvMap,
  project: LLMEnvMap,
): void {
  const fileEnv = mergeEnvMaps(global, project);
  for (const [key, value] of Object.entries(fileEnv)) {
    if (value !== undefined && processEnv[key] === undefined) {
      processEnv[key] = value;
    }
  }
}
