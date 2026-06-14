"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import {
  Activity,
  Bot,
  Boxes,
  Brain,
  CheckCircle2,
  CircleHelp,
  Cpu,
  Eye,
  EyeOff,
  Gauge,
  Globe,
  KeyRound,
  Link2,
  Plug,
  PlugZap,
  Plus,
  Radio,
  Rocket,
  ServerCog,
  Settings2,
  Sparkles,
  Waypoints,
  XCircle,
  Zap,
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  createLLMProvider,
  fetchLLMProviders,
  testLLMProvider,
  updateLLMProvider,
} from "@/lib/api/client"
import type { LLMProvider } from "@/lib/api/types"
import { providerKindLabel } from "@/lib/labels"
import { PixelBadge } from "@/components/design/pixel-badge"
import { PlatformHint } from "@/components/design/platform-hint"
import { KpiChip, FoldCard } from "@/components/design/kit"
import "./llm.css"

type Preset = { id: string; name: string; baseUrl: string; model: string; hint: string; cost?: string }
type LLMConfirmAction = {
  title: string
  description: string
  detail: string
  confirmLabel: string
  run: () => Promise<void>
}

// 预填网址 + 默认模型 —— 用户只需粘一个 Key 即可。
const PRESETS: Preset[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", hint: "深度求索 · 高性价比", cost: "成本极低" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", hint: "GPT-4o / o 系列", cost: "成本偏高" },
  { id: "moonshot", name: "Moonshot · Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k", hint: "月之暗面 · 长上下文", cost: "成本适中" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus", hint: "清华智谱", cost: "成本适中" },
  { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", hint: "阿里 · OpenAI 兼容", cost: "成本适中" },
  { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3", hint: "多模型聚合", cost: "随模型而定" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o", hint: "全球模型聚合", cost: "随模型而定" },
  { id: "custom", name: "自定义", baseUrl: "", model: "", hint: "手填地址与模型" },
]

// —— 给每个预设/服务商配一枚贴切的 lucide 图标(语义优先,不堆砌)——
const PRESET_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  deepseek: Brain,
  openai: Sparkles,
  moonshot: Rocket,
  zhipu: Cpu,
  qwen: Globe,
  siliconflow: Waypoints,
  openrouter: Radio,
  custom: Settings2,
}

// 已接入服务商:按显示名/类型猜一枚图标,猜不中回落到通用「服务节点」图标。
function providerIcon(p: LLMProvider): React.ComponentType<{ size?: number }> {
  const hay = `${p.name} ${p.baseUrl} ${p.kind}`.toLowerCase()
  if (/deepseek/.test(hay)) return Brain
  if (/openai|gpt/.test(hay)) return Sparkles
  if (/moonshot|kimi/.test(hay)) return Rocket
  if (/zhipu|glm|bigmodel/.test(hay)) return Cpu
  if (/qwen|dashscope|aliyun|通义/.test(hay)) return Globe
  if (/silicon|硅基/.test(hay)) return Waypoints
  if (/openrouter/.test(hay)) return Radio
  if (/ollama|localhost|127\.0\.0\.1/.test(hay)) return ServerCog
  if (/anthropic|claude/.test(hay)) return Bot
  return Boxes
}

type TestState = { ok: boolean; latencyMs: number; error?: string }

// 单个服务的连通态 → 设计系统 .pill[data-state] 语义(只走状态色,不裸字/杂色)。
type ConnTone = "success" | "error" | "warn" | "disabled" | "pending"
function connStatus(p: LLMProvider, tested: { ok: boolean; latencyMs: number } | undefined): {
  tone: ConnTone
  label: string
} {
  if (!p.enabled) return { tone: "disabled", label: "已停用" }
  if (!p.hasKey) return { tone: "warn", label: "缺少密钥" }
  if (tested) return tested.ok ? { tone: "success", label: "连通正常" } : { tone: "error", label: "连通失败" }
  return { tone: "pending", label: "待测试" }
}

// 把后端原始连通错误翻成"作者能照做的一句话":别只丢一个 401/ECONNREFUSED 给非技术用户。
function describeConnError(raw?: string): string {
  const e = String(raw ?? "").toLowerCase()
  if (/401|403|unauthor|invalid.*(key|api)|api.?key|forbidden|no permission/.test(e)) return "API Key 可能无效或没权限 — 请核对密钥是否复制完整、是否已开通该模型"
  if (/429|rate|quota|insufficient|balance|余额|欠费|exceed/.test(e)) return "额度不足或被限流 — 请检查账户余额 / 充值,或稍后再试"
  if (/timeout|etimedout|econnrefused|enotfound|econnreset|network|fetch failed|socket|dns|getaddrinfo/.test(e)) return "连不上服务器 — 请检查网络 / 代理是否开启,或服务地址是否正确"
  if (/404|not found|no such model|model.*(not|unknown|invalid)|unsupported model/.test(e)) return "地址或模型名可能不对 — 请核对服务地址与默认模型名"
  if (/cors|mixed content|ssl|certificate/.test(e)) return "证书 / 跨域问题 — 请确认服务地址用的是 https 且可直连"
  return raw ? `服务返回:${raw}` : "未知错误 — 可检查密钥、网络、服务地址与模型名"
}

export default function LLMConfigPage() {
  const { data: providers, mutate, isLoading } = useSWR("llm-providers", fetchLLMProviders)
  const [testing, setTesting] = React.useState<Record<string, boolean>>({})
  const [results, setResults] = React.useState<Record<string, TestState>>({})

  // add-form
  const [preset, setPreset] = React.useState<Preset>(PRESETS[0])
  const [name, setName] = React.useState(PRESETS[0].name)
  const [baseUrl, setBaseUrl] = React.useState(PRESETS[0].baseUrl)
  const [model, setModel] = React.useState(PRESETS[0].model)
  const [apiKey, setApiKey] = React.useState("")
  const [showKey, setShowKey] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<LLMConfirmAction | null>(null)
  const [confirmBusy, setConfirmBusy] = React.useState(false)

  const list = providers ?? []
  const configured = list.filter((p) => p.hasKey).length
  const testedOk = list.filter((p) => p.lastTestOk).length
  const enabledCount = list.filter((p) => p.enabled).length
  const defaultModel = list.find((p) => p.enabled && p.selectedModel)?.selectedModel

  const pickPreset = (p: Preset) => {
    setPreset(p)
    setName(p.name)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
  }

  const executeTest = async (id: string) => {
    setTesting((t) => ({ ...t, [id]: true }))
    try {
      const r = await testLLMProvider(id)
      setResults((s) => ({ ...s, [id]: r }))
      if (r.ok) toast.success(`连通成功 · ${r.latencyMs}ms`)
      else toast.error("连通失败", { description: describeConnError(r.error) })
      mutate()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setResults((s) => ({ ...s, [id]: { ok: false, latencyMs: 0, error: msg } }))
      toast.error("测试失败", { description: describeConnError(msg) })
    } finally {
      setTesting((t) => ({ ...t, [id]: false }))
    }
  }

  const requestTest = (p: LLMProvider) => {
    setConfirmAction({
      title: "测试模型连通性？",
      description: "这会向该模型服务发起一次真实连通测试,可能消耗少量额度或触发服务商侧请求日志。",
      detail: `${p.name} · ${p.selectedModel ?? p.models[0] ?? "未选择模型"}`,
      confirmLabel: "确认测试",
      run: () => executeTest(p.id),
    })
  }

  const executeToggleEnabled = async (p: LLMProvider) => {
    mutate(list.map((x) => (x.id === p.id ? { ...x, enabled: !p.enabled } : x)), false)
    try {
      await updateLLMProvider(p.id, { enabled: !p.enabled })
      mutate()
    } catch (e) {
      toast.error(`更新失败:${e instanceof Error ? e.message : String(e)}`)
      mutate()
    }
  }

  const requestToggleEnabled = (p: LLMProvider) => {
    setConfirmAction({
      title: p.enabled ? "停用这个模型服务？" : "启用这个模型服务？",
      description: p.enabled
        ? "停用后,写作、评审或 Agent 链路将不会继续使用这个服务作为可选模型。"
        : "启用后,写作、评审或 Agent 链路可能会把任务路由到这个服务。",
      detail: `${p.name} · ${p.selectedModel ?? p.models[0] ?? "未选择模型"}`,
      confirmLabel: p.enabled ? "确认停用" : "确认启用",
      run: () => executeToggleEnabled(p),
    })
  }

  const executeChangeModel = async (p: LLMProvider, selectedModel: string) => {
    mutate(list.map((x) => (x.id === p.id ? { ...x, selectedModel } : x)), false)
    try {
      await updateLLMProvider(p.id, { selectedModel })
      toast.success(`默认模型 → ${selectedModel}`)
      mutate()
    } catch (e) {
      toast.error(`更新失败:${e instanceof Error ? e.message : String(e)}`)
      mutate()
    }
  }

  const requestChangeModel = (p: LLMProvider, selectedModel: string) => {
    if (!selectedModel || selectedModel === p.selectedModel) return
    setConfirmAction({
      title: "切换默认模型？",
      description: "这会更新本地模型配置,后续写作、评审和 Agent 链路会按新的默认模型执行。",
      detail: `${p.name} · ${p.selectedModel ?? "未设置"} → ${selectedModel}`,
      confirmLabel: "确认切换",
      run: () => executeChangeModel(p, selectedModel),
    })
  }

  const executeSaveAndTest = async () => {
    if (!baseUrl.trim() || !model.trim()) {
      toast.error("请填写服务地址与模型名")
      return
    }
    if (!apiKey.trim()) {
      toast.error("请粘贴 API Key")
      return
    }
    setSaving(true)
    try {
      const created = await createLLMProvider({ name: name.trim() || preset.name, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim(), enabled: true })
      toast.success(`已添加 ${created.name},正在测试连通…`)
      setApiKey("")
      await mutate()
      await executeTest(created.id)
    } catch (e) {
      toast.error("保存失败", { description: describeConnError(e instanceof Error ? e.message : String(e)) })
    } finally {
      setSaving(false)
    }
  }

  const requestSaveAndTest = () => {
    if (!baseUrl.trim() || !model.trim()) {
      toast.error("请填写服务地址与模型名")
      return
    }
    if (!apiKey.trim()) {
      toast.error("请粘贴 API Key")
      return
    }
    setConfirmAction({
      title: "保存并测试模型服务？",
      description: "这会把 API Key 保存到本地后端,随后向模型服务发起一次真实连通测试。",
      detail: `${name.trim() || preset.name} · ${model.trim()} · ${baseUrl.trim()}`,
      confirmLabel: "确认保存并测试",
      run: executeSaveAndTest,
    })
  }

  const runConfirmedAction = async () => {
    if (!confirmAction || confirmBusy) return
    setConfirmBusy(true)
    try {
      await confirmAction.run()
      setConfirmAction(null)
    } finally {
      setConfirmBusy(false)
    }
  }

  const PresetIcon = PRESET_ICON[preset.id] ?? Settings2

  return (
    <div className="cj-screen cj-llm">
      {/* ── 顶部工作条:像素芯片 + 标题 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead llm-head">
        <div className="llm-headline">
          <PixelBadge kind="llm" size={44} className="llm-hero-pixel" ariaLabel="大模型配置" />
          <div className="llm-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">大模型配置</h1>
            </div>
            <div className="page-sub">
              接入任意 OpenAI 兼容大模型。选服务商 → 只填一个 API Key → 一键测试连通即可开始创作。
            </div>
            <PlatformHint type="local-llm" variant="info" />
          </div>
        </div>
        <div className="llm-kpis" role="group" aria-label="模型接入概览">
          <KpiChip label="已接入服务" value={list.length} unit="个" tone="brand" />
          <KpiChip
            label="已配置密钥"
            value={configured}
            unit="个"
            tone={configured > 0 ? "info" : "neutral"}
            hint="已保存 API Key 的服务数"
          />
          <KpiChip
            label="连通正常"
            value={testedOk}
            unit="个"
            tone={testedOk > 0 ? "ok" : "neutral"}
            hint="最近一次连通测试通过"
          />
          <KpiChip
            label="已启用"
            value={enabledCount}
            unit="个"
            tone={enabledCount > 0 ? "ok" : "warn"}
            hint="可被写作 / 评审 / Agent 链路路由"
          />
          <KpiChip
            label="主链路模型"
            value={defaultModel ?? "—"}
            tone="neutral"
            hint={defaultModel ? `写作 / 评审默认走 ${defaultModel}` : "尚未选定默认模型"}
          />
        </div>
      </header>

      {/* ── 主体:已接入服务(主区,pane 内滚) + 添加服务(Inspector)── */}
      <div className="cj-screen-body llm-body">
        <div className="cj-mainpane llm-mainpane">
          <div className="llm-mainpane-head">
            <span className="llm-mainpane-title">
              <Plug size={15} aria-hidden /> 已接入的模型服务
            </span>
            <span className="llm-mainpane-meta">
              <span className="num">{list.length}</span> 个
              {configured > 0 && (
                <>
                  <span className="llm-dot" aria-hidden />
                  <span className="num">{configured}</span> 个已配密钥
                </>
              )}
            </span>
          </div>
          <div className="cj-pane-scroll llm-pane-scroll">
            {isLoading && (
              <div className="llm-list">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="skel" style={{ height: 72, borderRadius: "var(--r-lg)" }} />
                ))}
              </div>
            )}
            {!isLoading && list.length === 0 && (
              <div className="empty empty-lg llm-empty">
                <PixelBadge kind="llm" size={56} ariaLabel="" />
                <div className="empty-title">还没有接入任何模型服务</div>
                <div className="empty-desc">
                  在右侧选一个服务商,粘贴一个 API Key 即可接入。密钥只存本地后端,不会上传。
                </div>
              </div>
            )}
            {!isLoading && list.length > 0 && (
              <div className="llm-list">
                {list.map((p) => {
                  const res = results[p.id]
                  const tested = res ?? (typeof p.lastTestOk === "boolean" ? { ok: p.lastTestOk, latencyMs: 0 } : undefined)
                  const status = connStatus(p, tested)
                  const Icon = providerIcon(p)
                  return (
                    <div className="llm-prov" key={p.id} data-state={status.tone}>
                      <span className="llm-prov-logo" aria-hidden>
                        <Icon size={19} />
                      </span>
                      <div className="llm-prov-main">
                        <div className="llm-prov-titleline">
                          <span className="llm-prov-name" title={p.name}>{p.name}</span>
                          <span className="pill" data-state={status.tone}>
                            <span className="dot" />
                            {status.label}
                          </span>
                          <span className="tag">{providerKindLabel(p.kind)}</span>
                          {tested && tested.ok ? (
                            <span className="llm-lat" title="最近一次连通耗时">
                              {tested.latencyMs ? `${tested.latencyMs}ms` : "已连通"}
                            </span>
                          ) : null}
                        </div>
                        <div className="llm-prov-url" title={p.baseUrl || "(默认地址)"}>
                          <Link2 size={12} aria-hidden />
                          {p.baseUrl || "(默认地址)"}
                        </div>
                        <div className="llm-prov-models">
                          <Cpu size={13} className="llm-prov-models-ic" aria-hidden />
                          {p.models.length > 0 ? (
                            <select
                              className="llm-select"
                              value={p.selectedModel ?? p.models[0]}
                              onChange={(e) => requestChangeModel(p, e.target.value)}
                              aria-label={`${p.name} 默认模型`}
                            >
                              {p.models.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                          ) : (
                            <span className="llm-prov-model-static">{p.selectedModel ?? "无模型列表"}</span>
                          )}
                          {tested && (
                            <span className="llm-test-res" data-ok={tested.ok ? "1" : "0"}>
                              {tested.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                              {tested.ok ? "连通正常" : "连通失败"}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="llm-prov-actions">
                        <button
                          type="button"
                          className={`llm-switch${p.enabled ? " on" : ""}`}
                          role="switch"
                          aria-checked={p.enabled}
                          onClick={() => requestToggleEnabled(p)}
                          title={p.enabled ? "已启用 · 点击停用" : "已停用 · 点击启用"}
                          aria-label={`${p.name}${p.enabled ? "已启用" : "已停用"}`}
                        />
                        <button
                          type="button"
                          className={`btn sm${testing[p.id] ? " is-loading" : ""}`}
                          onClick={() => requestTest(p)}
                          disabled={testing[p.id]}
                        >
                          {/* .btn.is-loading 自带居中转圈并淡化子元素,这里只保留静态图标,避免双重转圈 */}
                          <Zap size={12} /> 测试
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── 右侧 Inspector:添加模型服务(预设 → 表单 → 密钥)+ 接入须知 ── */}
        <aside className="cj-inspector llm-inspector">
          <div className="cj-pane-scroll llm-insp-scroll">
            <section className="card llm-add">
              <div className="card-head" style={{ marginBottom: 12 }}>
                <span className="llm-add-ic" aria-hidden><PlugZap size={16} /></span>
                <div className="card-title">添加模型服务</div>
              </div>

              <div className="llm-field-label">
                <Boxes size={13} aria-hidden /> 选择服务商
              </div>
              <div className="llm-preset-grid">
                {PRESETS.map((p) => {
                  const Ico = PRESET_ICON[p.id] ?? Settings2
                  return (
                    <button
                      type="button"
                      key={p.id}
                      className={`llm-preset${preset.id === p.id ? " sel" : ""}`}
                      onClick={() => pickPreset(p)}
                      title={p.hint}
                    >
                      <span className="llm-preset-ic" aria-hidden><Ico size={15} /></span>
                      <span className="llm-preset-text">
                        <span className="pn">{p.name}</span>
                        <span className="ph">{p.hint}{p.cost ? <em className="llm-preset-cost"> · {p.cost}</em> : null}</span>
                      </span>
                    </button>
                  )
                })}
              </div>

              <div className="llm-form">
                <div className="llm-fld">
                  <label>
                    <span className="llm-fld-ic" aria-hidden><PresetIcon size={13} /></span>
                    显示名称
                  </label>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 DeepSeek" />
                </div>
                {preset.id === "custom" ? (
                  <>
                    <div className="llm-fld">
                      <label>
                        <span className="llm-fld-ic" aria-hidden><Link2 size={13} /></span>
                        服务地址 (Base URL) <span className="req">*</span>
                      </label>
                      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
                    </div>
                    <div className="llm-fld">
                      <label>
                        <span className="llm-fld-ic" aria-hidden><Cpu size={13} /></span>
                        默认模型 <span className="req">*</span>
                      </label>
                      <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
                    </div>
                  </>
                ) : (
                  // 选了预设时,地址与模型已自动配好,普通作者无需关心这两个技术字段——
                  // 只读摘要给个确认即可,把焦点收窄到"贴 API Key 就能用"。要改去「自定义」。
                  <div className="llm-fld llm-fld-auto">
                    <label>
                      <span className="llm-fld-ic" aria-hidden><Cpu size={13} /></span>
                      已自动配置
                    </label>
                    <div className="llm-auto-summary" title={`服务地址 ${baseUrl}`}>
                      模型 <b>{model}</b>
                      <span className="llm-auto-url">{baseUrl}</span>
                      <span className="llm-auto-tip">需自定义地址/模型?选上方<b>「自定义」</b></span>
                    </div>
                  </div>
                )}
                <div className="llm-fld">
                  <label>
                    <span className="llm-fld-ic" aria-hidden><KeyRound size={13} /></span>
                    API Key <span className="req">*</span>
                  </label>
                  <div className="llm-key-wrap">
                    <input type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." autoComplete="off" />
                    <button type="button" className="llm-eye" onClick={() => setShowKey((s) => !s)} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                  </div>
                </div>
              </div>

              <button
                type="button"
                className={`btn primary llm-add-cta${saving ? " is-loading" : ""}`}
                onClick={requestSaveAndTest}
                disabled={saving}
              >
                <Plus size={14} /> 保存并测试连通
              </button>
              <div className="llm-add-hint">
                <KeyRound size={12} aria-hidden /> 密钥仅存于本地后端,不会上传。
              </div>
            </section>

            <FoldCard
              title="接入须知"
              icon={<CircleHelp size={15} />}
              defaultOpen={list.length === 0}
            >
              <ul className="llm-tips">
                <li>
                  <span className="llm-tip-ic" aria-hidden><Globe size={13} /></span>
                  只要是 <b>OpenAI 兼容</b> 接口都能接:填对 Base URL 与模型名即可。
                </li>
                <li>
                  <span className="llm-tip-ic" aria-hidden><Zap size={13} /></span>
                  保存后会自动发一次连通测试;<b>连通正常</b> 才会被写作链路使用。
                </li>
                <li>
                  <span className="llm-tip-ic" aria-hidden><Gauge size={13} /></span>
                  每个服务可单独选默认模型、随时 <b>启用/停用</b>,不影响其它服务。
                </li>
                <li>
                  <span className="llm-tip-ic" aria-hidden><Activity size={13} /></span>
                  启用多个服务时,写作 / 评审 / Agent 链路会按配置路由到可用模型。
                </li>
              </ul>
            </FoldCard>
          </div>
        </aside>
      </div>

      <AlertDialog open={Boolean(confirmAction)} onOpenChange={(open) => {
        if (!open && !confirmBusy) setConfirmAction(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.title ?? "确认模型动作？"}</AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>{confirmAction?.description}</span>
              {confirmAction?.detail ? (
                <span className="rounded-md border bg-muted/50 px-3 py-2 text-foreground">
                  {confirmAction.detail}
                </span>
              ) : null}
              <span>确认前不会保存配置、切换模型或发起连通测试。</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={confirmBusy}>保持当前配置</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={confirmBusy}
              onClick={(event) => {
                event.preventDefault()
                void runConfirmedAction()
              }}
            >
              {confirmBusy ? "执行中..." : confirmAction?.confirmLabel ?? "确认执行"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
