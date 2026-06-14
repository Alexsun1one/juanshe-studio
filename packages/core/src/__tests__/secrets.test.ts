import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadSecrets, saveSecrets, getServiceApiKey } from "../llm/secrets.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("secrets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "autow-secrets-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("loadSecrets", () => {
    it("returns empty when .autow/secrets.json does not exist", async () => {
      const secrets = await loadSecrets(root);
      expect(secrets).toEqual({ services: {} });
    });

    it("reads existing secrets file", async () => {
      await mkdir(join(root, ".autow"), { recursive: true });
      await writeFile(
        join(root, ".autow", "secrets.json"),
        JSON.stringify({ services: { moonshot: { apiKey: "sk-test" } } }),
      );
      const secrets = await loadSecrets(root);
      expect(secrets.services.moonshot.apiKey).toBe("sk-test");
    });
  });

  describe("saveSecrets", () => {
    it("creates .autow dir and writes secrets file", async () => {
      await saveSecrets(root, {
        services: { deepseek: { apiKey: "sk-deep" } },
      });
      const raw = await readFile(join(root, ".autow", "secrets.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.services.deepseek.apiKey).toBe("sk-deep");
    });

    it("overwrites existing secrets file", async () => {
      await mkdir(join(root, ".autow"), { recursive: true });
      await writeFile(
        join(root, ".autow", "secrets.json"),
        JSON.stringify({ services: { old: { apiKey: "old-key" } } }),
      );
      await saveSecrets(root, {
        services: { new: { apiKey: "new-key" } },
      });
      const secrets = await loadSecrets(root);
      expect(secrets.services.new.apiKey).toBe("new-key");
      expect(secrets.services.old).toBeUndefined();
    });
  });

  describe("getServiceApiKey", () => {
    it("returns key from secrets.json first", async () => {
      await mkdir(join(root, ".autow"), { recursive: true });
      await writeFile(
        join(root, ".autow", "secrets.json"),
        JSON.stringify({ services: { moonshot: { apiKey: "sk-from-file" } } }),
      );
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBe("sk-from-file");
    });

    it("falls back to environment variable", async () => {
      vi.stubEnv("MOONSHOT_API_KEY", "sk-from-env");
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBe("sk-from-env");
      vi.unstubAllEnvs();
    });

    it("returns null when neither secrets nor env exists", async () => {
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBeNull();
    });

    it("SaaS mode disables env key fallback (no cross-tenant operator key leak)", async () => {
      vi.stubEnv("MOONSHOT_API_KEY", "sk-operator-global");
      vi.stubEnv("HARDWRITE_SAAS_MODE", "1");
      // 租户没自己的 secrets.json → SaaS 模式下不得回退到运维的全局 env key。
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBeNull();
      vi.unstubAllEnvs();
    });

    it("SaaS mode still honors the tenant's own secrets.json", async () => {
      await mkdir(join(root, ".autow"), { recursive: true });
      await writeFile(
        join(root, ".autow", "secrets.json"),
        JSON.stringify({ services: { moonshot: { apiKey: "sk-tenant-own" } } }),
      );
      vi.stubEnv("MOONSHOT_API_KEY", "sk-operator-global");
      vi.stubEnv("HARDWRITE_SAAS_MODE", "1");
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBe("sk-tenant-own");
      vi.unstubAllEnvs();
    });

    it("handles custom service with colon key format", async () => {
      await mkdir(join(root, ".autow"), { recursive: true });
      await writeFile(
        join(root, ".autow", "secrets.json"),
        JSON.stringify({
          services: { "custom:内网GPT": { apiKey: "sk-custom" } },
        }),
      );
      const key = await getServiceApiKey(root, "custom:内网GPT");
      expect(key).toBe("sk-custom");
    });
  });
});
