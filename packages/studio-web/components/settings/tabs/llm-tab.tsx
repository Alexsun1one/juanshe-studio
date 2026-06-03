"use client"

import * as React from "react"
import {
  AlertCircle,
  Check,
  KeyRound,
  Loader2,
  Plus,
  Zap,
} from "lucide-react"

import { useT, useLocale } from "@/lib/i18n"
import { useLLMProviders } from "@/hooks/use-studio"
import {
  createLLMProvider,
  fetchLLMProviders,
  testLLMProvider,
  updateLLMProvider,
} from "@/lib/api/client"
import type { LLMProvider } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"

export function LLMTab() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { data, error, isLoading, mutate } = useLLMProviders()
  const { toast } = useToast()
  const [testingAll, setTestingAll] = React.useState(false)
  const [adding, setAdding] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [fallbackProviders, setFallbackProviders] = React.useState<
    LLMProvider[]
  >([])
  const [fallbackError, setFallbackError] = React.useState<string | null>(null)
  const [customDraft, setCustomDraft] = React.useState({
    name: "",
    baseUrl: "",
    model: "",
    apiKey: "",
  })
  const addEndpointFormId = React.useId()
  const swrProviders = Array.isArray(data) ? data : []
  const providers =
    swrProviders.length > 0 ? swrProviders : fallbackProviders
  const providerError =
    fallbackError ||
    (error instanceof Error ? error.message : error ? String(error) : null)
  const loadProviders = React.useCallback(async () => {
    try {
      const fresh = await fetchLLMProviders()
      setFallbackProviders(Array.isArray(fresh) ? fresh : [])
      setFallbackError(null)
    } catch (e) {
      setFallbackError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  const refreshProviders = React.useCallback(async () => {
    await Promise.allSettled([mutate(), loadProviders()])
  }, [loadProviders, mutate])

  React.useEffect(() => {
    if (Array.isArray(data) && data.length > 0) {
      setFallbackProviders(data)
      setFallbackError(null)
      return
    }
    loadProviders()
  }, [data, loadProviders])

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h2 className="text-foreground text-base font-semibold">
            {t("settings.llm.providers")}
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {lang === "en"
              ? "Configure base URL, API key and which models are available for each provider."
              : "为每个提供商配置 Base URL、API Key 与可用模型；前端不会展示明文 key。"}
          </p>
          <p className="text-muted-foreground/60 mt-1.5 text-[11px] leading-relaxed">
            {lang === "en"
              ? "💡 Tip: You can add multiple providers and assign different models to different agents (e.g. faster model for polishing, stronger model for writing & reviewing) in Agent Settings."
              : "💡 提示：可添加多个服务商、配置不同 Key，然后在「智能体设置」里为不同角色指定不同模型——例如写手/审稿官用强模型(DeepSeek/GPT-4)，润色用快模型(Kimi/Moonshot)，降低成本的同时保证写作质量。"}
          </p>
          <p className="text-muted-foreground/70 mt-1 text-[11px]">
            {providers.length > 0
              ? lang === "en"
                ? `${providers.length} real providers loaded`
                : `已从后端加载 ${providers.length} 个真实提供商`
              : isLoading
                ? lang === "en"
                  ? "Loading providers..."
                  : "正在从后端读取提供商..."
                : providerError
                  ? lang === "en"
                    ? "Provider API failed"
                    : "提供商接口读取失败"
                  : lang === "en"
                    ? "No providers"
                    : "暂无提供商"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={testingAll || providers.length === 0}
            onClick={async () => {
              setTestingAll(true)
              try {
                const results = await Promise.all(
                  providers
                    .filter((p) => p.enabled)
                    .map(async (p) => ({
                      id: p.id,
                      ...(await testLLMProvider(p.id)),
                    })),
                )
                const passed = results.filter((r) => r.ok).length
                toast({
                  title:
                    lang === "en"
                      ? `${passed}/${results.length} providers OK`
                      : `${passed}/${results.length} 个提供商通过`,
                })
                refreshProviders()
              } finally {
                setTestingAll(false)
              }
            }}
          >
            <Zap className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("settings.llm.test")}
          </Button>
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("settings.llm.add")}
          </Button>
        </div>
      </header>

      {adding && (
        <form
          className="border-border bg-card grid gap-3 rounded-2xl border p-5 md:grid-cols-[1fr_1.4fr_1fr] lg:grid-cols-[1fr_1.6fr_1fr_1fr_auto]"
          onSubmit={async (event) => {
            event.preventDefault()
            setCreating(true)
            try {
              await createLLMProvider({
                name: customDraft.name.trim(),
                baseUrl: customDraft.baseUrl.trim(),
                model: customDraft.model.trim(),
                apiKey: customDraft.apiKey.trim(),
                enabled: true,
              })
              setCustomDraft({ name: "", baseUrl: "", model: "", apiKey: "" })
              setAdding(false)
              await refreshProviders()
              toast({
                title:
                  lang === "en" ? "Custom endpoint added" : "自定义端点已添加",
              })
            } finally {
              setCreating(false)
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${addEndpointFormId}-name`} className="text-xs">
              {lang === "en" ? "Name" : "名称"}
            </Label>
            <Input
              id={`${addEndpointFormId}-name`}
              required
              value={customDraft.name}
              onChange={(e) =>
                setCustomDraft((draft) => ({ ...draft, name: e.target.value }))
              }
              placeholder="DeepSeek Backup"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${addEndpointFormId}-base-url`} className="text-xs">
              Base URL
            </Label>
            <Input
              id={`${addEndpointFormId}-base-url`}
              required
              value={customDraft.baseUrl}
              onChange={(e) =>
                setCustomDraft((draft) => ({
                  ...draft,
                  baseUrl: e.target.value,
                }))
              }
              placeholder="https://api.example.com/v1"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${addEndpointFormId}-model`} className="text-xs">
              Model
            </Label>
            <Input
              id={`${addEndpointFormId}-model`}
              value={customDraft.model}
              onChange={(e) =>
                setCustomDraft((draft) => ({ ...draft, model: e.target.value }))
              }
              placeholder="model-id"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${addEndpointFormId}-api-key`} className="text-xs">
              API Key
            </Label>
            <Input
              id={`${addEndpointFormId}-api-key`}
              type="password"
              value={customDraft.apiKey}
              onChange={(e) =>
                setCustomDraft((draft) => ({
                  ...draft,
                  apiKey: e.target.value,
                }))
              }
              placeholder="sk-..."
              className="font-mono text-xs"
            />
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm" disabled={creating}>
              {creating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              {lang === "en" ? "Add" : "添加"}
            </Button>
          </div>
        </form>
      )}

      <div className="grid gap-3">
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            onChange={() => refreshProviders()}
          />
        ))}
        {providers.length === 0 && (
          <div className="border-border bg-card text-muted-foreground rounded-2xl border px-5 py-8 text-sm">
            {providerError
              ? lang === "en"
                ? `Provider API error: ${providerError}`
                : `提供商接口异常：${providerError}`
              : lang === "en"
                ? "Waiting for provider data from the backend."
                : "正在等待后端提供商数据。"}
          </div>
        )}
      </div>
    </div>
  )
}

function ProviderRow({
  provider,
  onChange,
}: {
  provider: LLMProvider
  onChange: () => void
}) {
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { toast } = useToast()
  const [open, setOpen] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [baseUrl, setBaseUrl] = React.useState(provider.baseUrl)
  const [apiKey, setApiKey] = React.useState("")
  const [model, setModel] = React.useState(
    provider.selectedModel || provider.models[0] || "",
  )
  const editFormId = React.useId()
  const availableModels = React.useMemo(
    () =>
      [provider.selectedModel, ...provider.models]
        .filter((item): item is string => Boolean(item))
        .filter((item, index, array) => array.indexOf(item) === index),
    [provider.models, provider.selectedModel],
  )

  React.useEffect(() => {
    setBaseUrl(provider.baseUrl)
    setModel(provider.selectedModel || provider.models[0] || "")
  }, [provider.baseUrl, provider.models, provider.selectedModel])

  const selectedModel = provider.selectedModel || provider.models[0] || ""
  const dirty =
    baseUrl !== provider.baseUrl ||
    model !== selectedModel ||
    apiKey.trim().length > 0

  return (
    <div className="border-border bg-card overflow-hidden rounded-2xl border">
      {/* Row */}
      <div className="flex items-center gap-4 px-5 py-4">
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-lg font-mono text-[10px] font-semibold uppercase",
            provider.enabled
              ? "bg-primary/10 text-primary"
              : "bg-secondary text-muted-foreground",
          )}
        >
          {(provider.kind || provider.id || "llm").slice(0, 3)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground truncate text-sm font-medium">
              {provider.name}
            </span>
            {!provider.hasKey && (
              <Badge
                variant="outline"
                className="border-status-warning/40 text-status-warning text-[10px]"
              >
                <KeyRound className="mr-1 size-3" strokeWidth={1.8} />
                {lang === "en" ? "no key" : "未配置 Key"}
              </Badge>
            )}
            {provider.lastTestedAt &&
              (provider.lastTestOk ? (
                <Badge
                  variant="outline"
                  className="border-status-success/40 text-status-success text-[10px]"
                >
                  <Check className="mr-1 size-3" strokeWidth={2.2} />
                  ok
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-status-error/40 text-status-error text-[10px]"
                >
                  <AlertCircle className="mr-1 size-3" strokeWidth={1.8} />
                  fail
                </Badge>
              ))}
          </div>
          <div className="text-muted-foreground/80 mt-0.5 truncate font-mono text-[11px]">
            {(provider.selectedModel || provider.models[0] || "未选模型")} ·{" "}
            {provider.models.length}{" "}
            {lang === "en" ? "models" : "模型"}
          </div>
        </div>

        <Switch
          checked={provider.enabled}
          aria-label={
            lang === "en"
              ? `Enable ${provider.name}`
              : `启用 ${provider.name}`
          }
          onCheckedChange={async (v) => {
            await updateLLMProvider(provider.id, {
              enabled: v,
              ...(model ? { model } : {}),
            })
            onChange()
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={testing || !provider.enabled || !provider.hasKey}
          aria-label={
            lang === "en"
              ? `Test ${provider.name}`
              : `测试 ${provider.name}`
          }
          onClick={async () => {
            setTesting(true)
            try {
              const r = await testLLMProvider(provider.id)
              toast({
                title: r.ok
                  ? `${provider.name} · ${r.latencyMs}ms`
                  : (r.error ?? "failed"),
              })
              onChange()
            } finally {
              setTesting(false)
            }
          }}
        >
          {testing ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
          ) : (
            <Zap className="size-3.5" strokeWidth={1.8} />
          )}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open
            ? lang === "en"
              ? "Close"
              : "关闭"
            : lang === "en"
              ? "Edit"
              : "编辑"}
        </Button>
      </div>

      {/* Expanded edit panel */}
      {open && (
        <div className="border-border bg-card grid gap-4 border-t px-5 py-5 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${editFormId}-model`} className="text-xs">
              {lang === "en" ? "Model" : "模型"}
            </Label>
            {availableModels.length > 0 ? (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger
                  id={`${editFormId}-model`}
                  className="w-full font-mono text-xs"
                >
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {availableModels.map((m) => (
                    <SelectItem key={m} value={m} className="font-mono text-xs">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={`${editFormId}-model`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="model-id"
                className="font-mono text-xs"
              />
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${editFormId}-base-url`} className="text-xs">
              Base URL
            </Label>
            <Input
              id={`${editFormId}-base-url`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${editFormId}-api-key`} className="text-xs">
              API Key{" "}
              {provider.hasKey && (
                <span className="text-muted-foreground/70 font-mono text-[10px]">
                  ({lang === "en" ? "stored" : "已存"})
                </span>
              )}
            </Label>
            <Input
              id={`${editFormId}-api-key`}
              type="password"
              placeholder={
                lang === "en" ? "Leave blank to keep" : "留空保持不变"
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs">
              {lang === "en" ? "Available models" : "可用模型"}
            </Label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {provider.models.map((m) => (
                <Badge
                  key={m}
                  variant="outline"
                  className="font-mono text-[10px]"
                >
                  {m}
                </Badge>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 md:col-span-2">
            <Button
              size="sm"
              disabled={!dirty}
              onClick={async () => {
                const patch: Partial<LLMProvider> & {
                  apiKey?: string
                  model?: string
                } = {}
                if (baseUrl !== provider.baseUrl) patch.baseUrl = baseUrl
                if (model) patch.model = model
                if (apiKey.trim()) patch.apiKey = apiKey.trim()
                await updateLLMProvider(provider.id, patch)
                setApiKey("")
                onChange()
                toast({
                  title: lang === "en" ? "Provider saved" : "已保存",
                })
              }}
            >
              {lang === "en" ? "Save" : "保存"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
