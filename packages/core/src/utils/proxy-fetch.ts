import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { ProxyAgent } from "undici";

type ProxyEnv = Record<string, string | undefined>;
type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };

export function resolveProxyUrl(explicitProxyUrl?: string, env: ProxyEnv = process.env): string | undefined {
  const candidate = [
    explicitProxyUrl,
    env.HARDWRITE_LLM_PROXY_URL,
    env.AUTOW_LLM_PROXY_URL,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ].find((value) => typeof value === "string" && value.trim().length > 0)?.trim();

  if (!candidate) return undefined;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
  }
  return candidate;
}

export function buildProxyFetchInit(
  init: RequestInit = {},
  explicitProxyUrl?: string,
  env: ProxyEnv = process.env,
): FetchInitWithDispatcher {
  const proxyUrl = resolveProxyUrl(explicitProxyUrl, env);
  if (!proxyUrl) return init;
  return {
    ...init,
    dispatcher: new ProxyAgent(proxyUrl),
  };
}

/**
 * SSRF 防护:判定一个 IP 是否落在回环 / 私网 / 链路本地 / 云元数据 / 保留网段。
 * 托管 SaaS 跑在 VPS 上,用户可控的 LLM baseUrl(BYOK)若指向这些地址,就能让服务器替他们
 * 去打内网或云厂商元数据端点(如阿里云 100.100.100.200、AWS/GCP 169.254.169.254)窃取实例凭据。
 */
export function isBlockedHostIp(ip: string): boolean {
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true; // 回环 / 未指定
    if (low.startsWith("fe80")) return true; // 链路本地
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // 唯一本地 fc00::/7
    const mapped = low.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped) return isBlockedHostIp(mapped[1]);
    return false;
  }
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // 异常一律拦
  const [a, b] = parts;
  if (a === 127) return true; // 回环 127/8
  if (a === 10) return true; // 私网 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网 172.16/12
  if (a === 192 && b === 168) return true; // 私网 192.168/16
  if (a === 169 && b === 254) return true; // 链路本地 169.254/16(含 AWS/GCP 元数据)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10(含阿里云元数据 100.100.100.200)
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // 组播 / 保留 224+
  return false;
}

/**
 * 出站前置校验:协议必须 http(s)、不得带凭据、主机名解析后的所有 IP 都不得落在内网/保留网段。
 * 解析后复检(而非只看字面)可挡 DNS rebinding(域名指向内网 IP)。
 */
export async function assertPublicHttpTarget(input: Parameters<typeof fetch>[0]): Promise<void> {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request)?.url;
  if (!raw || typeof raw !== "string") throw new Error("SSRF 防护:无法解析请求目标");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SSRF 防护:非法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`SSRF 防护:不允许的协议 ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error("SSRF 防护:URL 不得携带凭据");
  const host = url.hostname.replace(/^\[|\]$/g, ""); // 去掉 IPv6 字面量的方括号
  if (/^(localhost|.*\.localhost|metadata\.google\.internal|metadata)$/i.test(host)) {
    throw new Error("SSRF 防护:不允许访问本地/元数据主机");
  }
  let ips: string[];
  if (isIP(host)) {
    ips = [host];
  } else {
    try {
      ips = (await lookup(host, { all: true })).map((r) => r.address);
    } catch {
      throw new Error("SSRF 防护:域名解析失败");
    }
  }
  if (ips.length === 0 || ips.some((ip) => isBlockedHostIp(ip))) {
    throw new Error("SSRF 防护:目标解析到内网/保留地址,已拦截");
  }
}

function ssrfGuardEnabled(env: ProxyEnv): boolean {
  // 仅托管 SaaS 启用:桌面/本地版连本机 localhost Ollama 是合法用法,不能拦。
  return env.HARDWRITE_SAAS_MODE === "1";
}

export async function fetchWithProxy(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  explicitProxyUrl?: string,
  env: ProxyEnv = process.env,
): Promise<Response> {
  if (ssrfGuardEnabled(env)) {
    await assertPublicHttpTarget(input);
  }
  return fetch(input, buildProxyFetchInit(init, explicitProxyUrl, env));
}
