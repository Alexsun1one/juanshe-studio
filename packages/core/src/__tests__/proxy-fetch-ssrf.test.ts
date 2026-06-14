// SSRF 防护回归测试:托管 SaaS 上用户可控的 LLM baseUrl(BYOK)绝不能让服务器去打
// 内网 / 回环 / 链路本地 / 云元数据端点(阿里云 100.100.100.200、AWS/GCP 169.254.169.254)。
import { describe, expect, it } from "vitest";

import { assertPublicHttpTarget, isBlockedHostIp } from "../utils/proxy-fetch.js";

describe("SSRF 防护 · isBlockedHostIp", () => {
  it("拦回环 / 私网 / 链路本地 / 云元数据 / 保留网段", () => {
    for (const ip of [
      "127.0.0.1", "127.1.2.3", // 回环
      "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", // 私网
      "169.254.169.254", // 链路本地(AWS/GCP 元数据)
      "100.100.100.200", "100.64.0.1", // CGNAT(阿里云元数据)
      "0.0.0.0", "224.0.0.1", "239.1.1.1", // 未指定 / 组播
      "::1", "fe80::1", "fc00::1", "fd12::3456", // IPv6 回环/链路本地/唯一本地
      "::ffff:127.0.0.1", "::ffff:10.0.0.1", // IPv4-mapped
    ]) {
      expect(isBlockedHostIp(ip), `应拦 ${ip}`).toBe(true);
    }
  });

  it("放行公网 IP(含私网相邻边界)", () => {
    for (const ip of [
      "1.1.1.1", "8.8.8.8", "104.16.0.1",
      "172.15.0.1", "172.32.0.1", // 172.16/12 的两侧边界外
      "100.63.255.255", "100.128.0.1", // 100.64/10 两侧边界外
      "11.0.0.1", "223.255.255.255", // 224 以下
      "2606:4700::1111", // Cloudflare IPv6
    ]) {
      expect(isBlockedHostIp(ip), `应放行 ${ip}`).toBe(false);
    }
  });
});

describe("SSRF 防护 · assertPublicHttpTarget(IP 字面量,免 DNS)", () => {
  it("拒绝元数据 / 回环 / 私网目标", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/",
      "http://127.0.0.1:8080/v1/models",
      "http://[::1]/",
      "http://10.1.2.3/",
      "http://192.168.0.1/",
    ]) {
      await expect(assertPublicHttpTarget(url), url).rejects.toThrow();
    }
  });

  it("拒绝非 http(s) 协议与内嵌凭据", async () => {
    await expect(assertPublicHttpTarget("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicHttpTarget("ftp://1.1.1.1/")).rejects.toThrow();
    await expect(assertPublicHttpTarget("http://user:pass@1.1.1.1/")).rejects.toThrow();
  });

  it("拒绝 localhost 主机名", async () => {
    await expect(assertPublicHttpTarget("http://localhost:11434/v1")).rejects.toThrow();
  });

  it("放行公网 IP 字面量目标", async () => {
    await expect(assertPublicHttpTarget("https://1.1.1.1/v1/models")).resolves.toBeUndefined();
    await expect(assertPublicHttpTarget("https://8.8.8.8/")).resolves.toBeUndefined();
  });
});
