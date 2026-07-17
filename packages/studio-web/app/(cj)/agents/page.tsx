"use client"

import * as React from "react"
import Link from "next/link"
import {
  AlertCircle,
  Check,
  CircuitBoard,
  FileCode2,
  Gauge,
  History,
  Lock,
  Save,
  Settings2,
  Sparkles,
  Thermometer,
  Wand2,
  Wrench,
  Zap,
} from "lucide-react"

import { useT, useLocale } from "@/lib/i18n"
import { useAgentProfiles, useLLMProviders } from "@/hooks/use-studio"
import {
  restoreAgentProfileVersion,
  testAgentProfile,
  testAllAgentProfiles,
  updateAgentProfile,
} from "@/lib/api/client"
import type { AgentProfile } from "@/lib/api/types"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs"
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
import { toast } from "sonner"
import { EmptyArt } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { KpiChip, StatLine } from "@/components/design/kit"
import { cn } from "@/lib/utils"
import { describeFailure } from "@/lib/describe-error"
import "./agents.css"

type EditorConfirmAction =
  | { kind: "test" }
  | { kind: "save" }
  | { kind: "restore"; versionId: string; note?: string }

// 把 agent 档案的真实属性映射到设计系统状态 pill(只走语义状态,不随手杂色):
// 确定性编排器 -> disabled(只读)/ 治理锁定 -> paused / 否则可配置 -> success。不编造运行态。
function profileTone(p: AgentProfile): { state: string; label: { zh: string; en: string } } {
  if (p.deterministic) return { state: "disabled", label: { zh: "确定性", en: "Deterministic" } }
  if (p.locked) return { state: "paused", label: { zh: "已锁定", en: "Locked" } }
  return { state: "success", label: { zh: "可配置", en: "Editable" } }
}

export default function AgentLabPage() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { data, error, isLoading, mutate } = useAgentProfiles()
  const profiles = data ?? []
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0]
  const [testingAll, setTestingAll] = React.useState(false)
  const [confirmAllOpen, setConfirmAllOpen] = React.useState(false)

  React.useEffect(() => {
    if (!activeId && profiles.length > 0) setActiveId(profiles[0].id)
  }, [activeId, profiles])

  const runConnectivityTest = async () => {
    setConfirmAllOpen(false)
    setTestingAll(true)
    try {
      const res = await testAllAgentProfiles()
      const passed = res.filter((r) => r.ok).length
      toast.success(lang === "en" ? `Connectivity: ${passed}/${res.length} agents OK` : `连通性测试:${passed}/${res.length} 通过`)
    } catch (e) {
      toast.error("连通性测试失败", { description: describeFailure(e) || undefined })
    } finally {
      setTestingAll(false)
    }
  }

  // 加载骨架:结构占位,避免空白闪烁
  if (profiles.length === 0 && isLoading && !error) {
    return (
      <div className="cj-screen cj-agents">
        <header className="cj-workhead ag-head">
          <div className="skel" style={{ height: 56, borderRadius: "var(--r-lg)" }} />
        </header>
        <div className="cj-screen-body ag-body">
          <aside className="ag-rail">
            <div className="skel" style={{ height: "100%", borderRadius: 0 }} />
          </aside>
          <div className="cj-mainpane ag-editorpane">
            <div className="skel" style={{ height: "100%", borderRadius: 0 }} />
          </div>
        </div>
      </div>
    )
  }

  if (profiles.length === 0) {
    return <AgentLabUnavailable lang={lang} error={error} />
  }

  const lockedCount = profiles.filter((p) => p.locked).length
  const deterministicCount = profiles.filter((p) => p.deterministic).length
  const editableCount = profiles.length - lockedCount - deterministicCount
  const totalSteps = Math.max(15, ...profiles.map((p) => p.step))

  return (
    <div className="cj-screen cj-agents">
      {/* 顶部工作条:像素徽标 + 标题 + 测试全部 + 一行密集 KPI(非大卡平铺) */}
      <header className="cj-workhead ag-head">
        <div className="ag-headline">
          {active ? (
            <AgentPixel
              id={active.id}
              size={44}
              className="ag-hero-pixel"
              ariaLabel={active.name[lang]}
            />
          ) : (
            <PixelBadge kind="agents" size={44} className="ag-hero-pixel" ariaLabel={t("agents.title")} />
          )}
          <div className="ag-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">{t("agents.title")}</h1>
            </div>
            <p className="page-sub">{t("agents.subtitle")}</p>
          </div>
          <button
            type="button"
            className={cn("btn primary ag-head-cta", testingAll && "is-loading")}
            disabled={testingAll}
            onClick={() => setConfirmAllOpen(true)}
          >
            <Zap size={14} strokeWidth={1.9} />
            {t("agents.connectivity.test")}
          </button>
        </div>
        <div className="ag-kpis" role="group" aria-label={lang === "en" ? "Agent overview" : "成员概览"}>
          <KpiChip label={lang === "en" ? "Agents" : "编辑部成员"} value={profiles.length} unit={lang === "en" ? "" : "位"} tone="brand" />
          <KpiChip
            label={lang === "en" ? "Editable" : "可配置"}
            value={editableCount}
            unit={lang === "en" ? "" : "位"}
            tone={editableCount > 0 ? "ok" : "neutral"}
            hint={lang === "en" ? "Assign a model to each editor" : "在这里给每个编辑单独换大模型"}
          />
          <KpiChip
            label={lang === "en" ? "Locked" : "已锁定"}
            value={lockedCount}
            unit={lang === "en" ? "" : "位"}
            tone={lockedCount > 0 ? "warn" : "neutral"}
            hint={lang === "en" ? "Locked by prompt-governance" : "被提示词治理官锁定"}
          />
          <KpiChip
            label={lang === "en" ? "Deterministic" : "确定性"}
            value={deterministicCount}
            unit={lang === "en" ? "" : "位"}
            tone="neutral"
            hint={lang === "en" ? "Pipeline runners — no LLM prompt" : "编排器 · 不经 LLM,无提示词"}
          />
          {active && (
            <KpiChip
              label={lang === "en" ? "Selected" : "当前成员"}
              value={active.name[lang]}
              tone="info"
              sub={
                <StatLine
                  items={[
                    { n: `${active.step}`, label: lang === "en" ? `/ ${totalSteps} step` : `/ ${totalSteps} 位`, tone: "brand" },
                  ]}
                />
              }
            />
          )}
        </div>
      </header>

      {/* 主体:左 编辑部流水线(pane 内滚) + 右 成员档案编辑器 */}
      <div className="cj-screen-body ag-body">
        <aside className="ag-rail">
          <div className="ag-rail-head">
            <CircuitBoard size={13} strokeWidth={2} />
            {lang === "en" ? "Editorial chain" : "编辑部流水线"}
            <span className="c">{profiles.length}</span>
          </div>
          <div className="cj-pane-scroll ag-rail-list">
            {profiles
              .slice()
              .sort((a, b) => a.step - b.step)
              .map((p) => {
                const isActive = p.id === active?.id
                const tone = profileTone(p)
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setActiveId(p.id)}
                    className={cn("ag-item", isActive && "active")}
                    data-state={tone.state}
                  >
                    <span className="step">{p.step.toString().padStart(2, "0")}</span>
                    <AgentPixel id={p.id} size={28} className="pix" ariaLabel={p.name[lang]} />
                    <span className="ag-item-body">
                      <span className="ag-item-name">
                        <span className="nm">{p.name[lang]}</span>
                        {p.locked && <Lock className="lock" size={11} strokeWidth={2} />}
                      </span>
                      <span className="ag-item-model">{p.model}</span>
                    </span>
                    <span className="pill ag-item-pill" data-state={tone.state}>
                      <span className="dot" />
                      {tone.label[lang]}
                    </span>
                  </button>
                )
              })}
          </div>
        </aside>

        <div className="cj-mainpane ag-editorpane">
          {active && (
            <AgentEditor key={active.id} profile={active} totalSteps={totalSteps} onChange={() => mutate()} />
          )}
        </div>
      </div>

      {/* 测试全部确认 */}
      <AlertDialog open={confirmAllOpen} onOpenChange={setConfirmAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {lang === "en" ? "Test every agent connection?" : "测试全部 Agent 连通性？"}
            </AlertDialogTitle>
            <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
              <span>
                {lang === "en"
                  ? "This calls the backend connectivity check for every agent profile and may consume model resources."
                  : "这会调用后端逐个测试所有 Agent 档案，可能消耗模型资源。"}
              </span>
              <span className="cj-agents-dialog-meta">
                {lang === "en"
                  ? `Scope: all ${profiles.length} agent profiles`
                  : `范围：全部 ${profiles.length} 个 Agent 档案`}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={testingAll}>
              {lang === "en" ? "Not now" : "先不测试"}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={testingAll}
              onClick={(event) => {
                event.preventDefault()
                void runConnectivityTest()
              }}
            >
              {lang === "en" ? "Confirm test" : "确认测试"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function AgentLabUnavailable({
  lang,
  error,
}: {
  lang: "zh" | "en"
  error: unknown
}) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""

  return (
    <div className="cj-screen cj-agents">
      <header className="cj-workhead ag-head">
        <div className="ag-headline">
          <PixelBadge kind="agents" size={44} className="ag-hero-pixel" ariaLabel={lang === "en" ? "Editorial Members" : "编辑部成员"} />
          <div className="ag-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">{lang === "en" ? "Editorial Members" : "编辑部成员"}</h1>
            </div>
            <p className="page-sub">
              {lang === "en"
                ? "The editorial roster is waiting for the backend profile desk to come back online."
                : "编辑部成员档案暂时没有拿到，先保留一个不空白的降级工作面。"}
            </p>
          </div>
        </div>
      </header>
      <div className="ag-unavailable-wrap">
        <section className="empty empty-lg editorial-empty ag-unavailable" data-empty-variant="agents">
          <div className="empty-art">
            <EmptyArt variant="agents" />
          </div>
          <div className="empty-title">
            {lang === "en" ? "Agent profiles are temporarily unavailable" : "编辑部档案柜暂时打不开"}
          </div>
          <div className="empty-desc">
            {lang === "en"
              ? "The real agent-profile API returned an error, so this page is showing a guarded fallback instead of pretending data exists."
              : "真实 agent-profile 接口正在返回错误；这里不伪造档案，只把页面稳稳接住，避免首屏空白。"}
          </div>
          {message ? <div className="ag-unavailable-error">{message}</div> : null}
          <div className="empty-actions">
            <Link href="/system" className="btn primary">
              {lang === "en" ? "Open system desk" : "查看系统台"}
            </Link>
            <Link href="/capabilities" className="btn">
              {lang === "en" ? "Open capability desk" : "查看能力台"}
            </Link>
          </div>
        </section>
      </div>
    </div>
  )
}

// -----------------------------------------------------------
// 右栏 — 编辑器(提示词 / 模板 / 配置 / 历史)
// -----------------------------------------------------------
function AgentEditor({
  profile,
  totalSteps,
  onChange,
}: {
  profile: AgentProfile
  totalSteps: number
  onChange: () => void
}) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { data: providers } = useLLMProviders()

  const [systemPrompt, setSystemPrompt] = React.useState(profile.systemPrompt)
  const [userTemplate, setUserTemplate] = React.useState(profile.userTemplate ?? "")
  const [model, setModel] = React.useState(profile.model)
  const [temperature, setTemperature] = React.useState(profile.temperature)
  const [maxTokens, setMaxTokens] = React.useState(profile.maxTokens)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<EditorConfirmAction | null>(null)
  // §17#4 审计视图:高亮 AUTO_PROMPT_GOVERNANCE 区块、区分人手写 vs 治理官追加
  const [auditView, setAuditView] = React.useState(false)

  const dirty =
    systemPrompt !== profile.systemPrompt ||
    userTemplate !== (profile.userTemplate ?? "") ||
    model !== profile.model ||
    temperature !== profile.temperature ||
    maxTokens !== profile.maxTokens
  // 确定性 agent(执行主编 pipeline runner)按只读处理:无可配置提示词,改动不生效
  const editLocked = profile.locked || !!profile.deterministic
  const modelOptions = React.useMemo(() => {
    const providerModels = (providers ?? [])
      .filter((provider) => provider.enabled)
      .flatMap((provider) => provider.models)
    return Array.from(new Set([...providerModels, profile.model, model].filter(Boolean)))
  }, [providers, profile.model, model])
  const busy = saving || testing || restoring
  const wordCount = React.useMemo(
    () => systemPrompt.trim().split(/\s+/).filter(Boolean).length,
    [systemPrompt],
  )
  // 选中模型所属服务 + Key 是否已配置(就地感知,不用跳去 /llm 才知道)
  const provider = React.useMemo(
    () => (providers ?? []).find((p) => p.models?.includes(model) || p.selectedModel === model),
    [providers, model],
  )
  const tone = profileTone(profile)
  const confirmCopy = confirmAction?.kind === "test" ? {
    title: lang === "en" ? "Test this agent connection?" : "测试当前 Agent 连通性？",
    body:
      lang === "en"
        ? `This calls the backend connectivity check for ${profile.name[lang]}.`
        : `这会调用后端测试「${profile.name[lang]}」的模型配置。`,
    meta: `${profile.id} · ${model} · temperature ${temperature.toFixed(2)}`,
    cancel: lang === "en" ? "Not now" : "先不测试",
    action: lang === "en" ? "Confirm test" : "确认测试",
  } : confirmAction?.kind === "save" ? {
    title: lang === "en" ? "Save a new agent profile version?" : "保存 Agent 档案新版本？",
    body:
      lang === "en"
        ? "This updates the runtime prompt/config and writes a new version record."
        : "这会更新运行时提示词/模型配置，并写入新的版本记录。",
    meta: `${profile.id} · ${systemPrompt.length} chars · ${model}`,
    cancel: lang === "en" ? "Keep editing" : "继续检查",
    action: lang === "en" ? "Confirm save" : "确认保存",
  } : confirmAction?.kind === "restore" ? {
    title: lang === "en" ? "Restore this agent version?" : "回滚到这个 Agent 版本？",
    body:
      lang === "en"
        ? "This replaces the current runtime prompt with the selected historical version."
        : "这会用选中的历史版本替换当前运行时提示词。",
    meta: `${profile.id} · ${confirmAction.note ?? (lang === "en" ? "selected version" : "选中版本")}`,
    cancel: lang === "en" ? "Keep current" : "保留当前版本",
    action: lang === "en" ? "Confirm restore" : "确认回滚",
  } : null

  const runTest = async () => {
    setTesting(true)
    try {
      const res = await testAgentProfile(profile.id)
      if (res.ok) toast.success(lang === "en" ? `OK (${res.latencyMs}ms)` : `连通正常 (${res.latencyMs}ms)`, { description: res.sample })
      else toast.error(lang === "en" ? "Failed" : "连通失败", { description: res.error ?? res.sample })
    } catch (e) {
      toast.error("测试失败", { description: describeFailure(e) || undefined })
    } finally {
      setTesting(false)
    }
  }

  const runSave = async () => {
    setSaving(true)
    try {
      await updateAgentProfile(profile.id, {
        systemPrompt,
        userTemplate,
        model,
        temperature,
        maxTokens,
      })
      onChange()
      toast.success(lang === "en" ? "Prompt saved" : "提示词已保存")
    } catch (e) {
      toast.error("保存失败", { description: describeFailure(e) || undefined })
    } finally {
      setSaving(false)
    }
  }

  const runRestore = async (versionId: string) => {
    setRestoring(true)
    try {
      await restoreAgentProfileVersion(profile.id, versionId)
      onChange()
      toast.success(lang === "en" ? "Version restored" : "已回滚到该版本")
    } catch (e) {
      toast.error("回滚失败", { description: describeFailure(e) || undefined })
    } finally {
      setRestoring(false)
    }
  }

  const runConfirmedAction = async () => {
    const action = confirmAction
    if (!action) return
    setConfirmAction(null)
    if (action.kind === "test") {
      await runTest()
    } else if (action.kind === "save") {
      await runSave()
    } else {
      await runRestore(action.versionId)
    }
  }

  return (
    <div className="ag-editor">
      {/* 成员档案带:像素角色 + 名称 + 状态 pill + 内联规模 StatLine + 动作 */}
      <div className="ag-ed-head">
        <div className="ag-ed-profile">
          <AgentPixel
            id={profile.id}
            size={46}
            className="ag-ed-pixel"
            ariaLabel={profile.name[lang]}
          />
          <div className="ag-ed-id">
            <div className="ag-ed-titleline">
              <h2 className="ag-ed-title">{profile.name[lang]}</h2>
              <span className="pill" data-state={tone.state}>
                <span className="dot" />
                {tone.label[lang]}
              </span>
            </div>
            <StatLine
              className="ag-ed-stats"
              items={[
                { n: `${profile.step}`, label: lang === "en" ? `/ ${totalSteps} step` : `/ ${totalSteps} 流程位`, tone: "brand" },
                { n: systemPrompt.length, label: lang === "en" ? "chars" : "字符" },
                { n: wordCount, label: lang === "en" ? "words" : "词" },
                { n: profile.versions.length, label: lang === "en" ? "versions" : "版本" },
              ]}
            />
          </div>
          <div className="ag-ed-actions">
            <button
              type="button"
              className={cn("btn sm", testing && "is-loading")}
              disabled={busy || editLocked}
              onClick={() => setConfirmAction({ kind: "test" })}
            >
              <Zap size={13} strokeWidth={1.9} />
              {t("agents.editor.test")}
            </button>
            <button
              type="button"
              className={cn("btn primary sm", saving && "is-loading")}
              disabled={!dirty || busy || editLocked}
              onClick={() => setConfirmAction({ kind: "save" })}
            >
              <Save size={13} strokeWidth={1.9} />
              {t("agents.editor.save")}
            </button>
          </div>
        </div>

        {/* 元信息行:id · 模型 · Key 状态 · 工具数 · 最近动作(密集内联,不堆卡) */}
        <div className="ag-ed-meta">
          <span className="ag-meta-cell mono">{profile.id}</span>
          <span className="sep" aria-hidden />
          <span className="ag-meta-cell mono" title={model}>
            <FileCode2 size={12} strokeWidth={1.9} />
            {model}
          </span>
          <span className="sep" aria-hidden />
          <span className="ag-meta-cell ag-key" title={lang === "en" ? "Provider key status" : "所属服务 Key 状态"}>
            <span className="ks-dot" data-ok={provider ? String(!!provider.hasKey) : "na"} aria-hidden />
            {provider
              ? `${provider.name} · ${provider.hasKey ? (lang === "en" ? "Key set" : "Key 已配置") : (lang === "en" ? "no Key" : "未配置 Key")}`
              : (lang === "en" ? "default provider key" : "用默认服务 Key")}
            <Link href="/llm" className="ag-meta-link">{lang === "en" ? "manage →" : "配置 →"}</Link>
          </span>
          {profile.tools.length > 0 && (
            <>
              <span className="sep" aria-hidden />
              <span className="ag-meta-cell">
                <Wrench size={12} strokeWidth={1.9} />
                {profile.tools.length} {lang === "en" ? "tools" : "工具"}
              </span>
            </>
          )}
          <Link className="ag-ed-activity" href="/system">{lang === "en" ? "Recent activity →" : "最近动作 →"}</Link>
        </div>

        {profile.locked && (
          <div className="ag-lock">
            <AlertCircle size={14} strokeWidth={1.9} />
            {lang === "en"
              ? "This agent is locked by prompt-governance. Unlock in Settings."
              : "该智能体已被提示词治理官锁定，去「设置 / 工作流」解锁"}
          </div>
        )}
        {profile.deterministic && (
          <div className="ag-lock ag-det">
            <AlertCircle size={14} strokeWidth={1.9} />
            {lang === "en"
              ? "Deterministic orchestrator (pipeline runner) — runs without an LLM, so there is no configurable prompt. Read-only."
              : "确定性编排器(pipeline runner)—— 不经 LLM,没有可配置提示词,此处只读。"}
          </div>
        )}
      </div>

      {/* tabs */}
      <Tabs defaultValue="prompt" className="ag-ed-body">
        <TabsList className="ag-tabs-list">
          <TabsTrigger value="prompt">
            <Wand2 className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("agents.editor.system")}
          </TabsTrigger>
          <TabsTrigger value="user">
            <Sparkles className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("agents.editor.user")}
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings2 className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("agents.editor.model")}
          </TabsTrigger>
          <TabsTrigger value="history">
            <History className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("agents.editor.history")}
            {profile.versions.length > 0 && <span className="ag-tab-count">{profile.versions.length}</span>}
          </TabsTrigger>
        </TabsList>

        {/* 系统提示词 */}
        <TabsContent value="prompt" className="ag-tabpanel">
          {auditView ? (
            <PromptAuditView body={systemPrompt} locked={editLocked} lang={lang} />
          ) : (
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              disabled={editLocked}
              className="ag-prompt cj-pane-scroll"
              spellCheck={false}
            />
          )}
          <div className="ag-prompt-foot">
            <span className="ag-count">
              <b>{systemPrompt.length}</b> {lang === "en" ? "chars" : "字符"} · <b>{wordCount}</b>{" "}
              {lang === "en" ? "words" : "词"}
            </span>
            <div className="ag-foot-right">
              <button
                type="button"
                onClick={() => setAuditView((v) => !v)}
                className={cn("ag-toggle", auditView && "on")}
                aria-pressed={auditView}
              >
                {auditView
                  ? lang === "en" ? "Back to edit" : "返回编辑"
                  : lang === "en" ? "Audit view" : "审计视图"}
              </button>
              {profile.tools.length > 0 && (
                <span className="ag-tools">
                  {profile.tools.map((tool) => (
                    <span key={tool} className="ag-tool">
                      <Wrench size={10} strokeWidth={2} />
                      {tool}
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>
        </TabsContent>

        {/* 用户模板 */}
        <TabsContent value="user" className="ag-tabpanel">
          <textarea
            value={userTemplate}
            onChange={(e) => setUserTemplate(e.target.value)}
            disabled={editLocked}
            placeholder={
              lang === "en"
                ? "User message template with {{variables}}…"
                : "用户消息模板（可用 {{变量}}）…"
            }
            className="ag-prompt tpl cj-pane-scroll"
            spellCheck={false}
          />
          <div className="ag-prompt-foot">
            <span className="ag-count">
              <b>{userTemplate.length}</b> {lang === "en" ? "chars" : "字符"}
            </span>
          </div>
        </TabsContent>

        {/* 模型配置 */}
        <TabsContent value="config" className="ag-tabpanel">
          <div className="ag-cfg cj-pane-scroll">
            <div className="ag-cfg-grid">
              <div className="ag-field">
                <Label className="ag-field-label">
                  <FileCode2 size={12} strokeWidth={2} />
                  {t("agents.editor.model")}
                </Label>
                <p className="ag-field-note">
                  {lang === "en" ? (
                    <>
                      Pick the model for this role. Set the provider Key in <Link href="/llm">LLM Config</Link> first.
                    </>
                  ) : (
                    <>
                      这个角色用哪个大模型(在<Link href="/llm">大模型配置</Link>里配好对应服务的 Key)
                    </>
                  )}
                </p>
                <Select value={model} onValueChange={setModel} disabled={editLocked}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((m) => (
                      <SelectItem key={m} value={m} className="font-mono text-xs">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* 模型 & Key 就地感知:定位选中模型所属服务 + Key 是否已配置,不用跳去 /llm 才知道 */}
                <div className="ag-key-status">
                  <span className="ks-dot" data-ok={provider ? String(!!provider.hasKey) : "na"} aria-hidden />
                  <span className="ks-txt">
                    {provider
                      ? `${provider.name} · ${provider.hasKey ? (lang === "en" ? "Key set" : "Key 已配置") : (lang === "en" ? "no Key" : "未配置 Key")}`
                      : (lang === "en" ? "uses default provider key" : "用默认服务的 Key")}
                  </span>
                  <Link href="/llm" className="ks-link">{lang === "en" ? "Manage Key →" : "配置 Key →"}</Link>
                </div>
              </div>

              <div className="ag-field">
                <Label className="ag-field-label">
                  <Gauge size={12} strokeWidth={2} />
                  {t("agents.editor.maxTokens")}
                </Label>
                <Input
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                  disabled={editLocked}
                  min={256}
                  max={32768}
                  step={256}
                  className="font-mono"
                />
              </div>
            </div>

            <div className="ag-field">
              <Label className="ag-field-label">
                <Thermometer size={12} strokeWidth={2} />
                {t("agents.editor.temperature")} · <span className="val">{temperature.toFixed(2)}</span>
              </Label>
              <Slider
                value={[temperature]}
                min={0}
                max={2}
                step={0.05}
                onValueChange={(v) => setTemperature(v[0])}
                disabled={editLocked}
                className="mt-3"
              />
            </div>

            {profile.outputSchema && (
              <div className="ag-field">
                <Label className="ag-field-label">
                  <FileCode2 size={12} strokeWidth={2} />
                  {lang === "en" ? "Output contract" : "输出约束"}
                </Label>
                <pre className="ag-schema">{profile.outputSchema}</pre>
              </div>
            )}
          </div>
        </TabsContent>

        {/* 版本历史 */}
        <TabsContent value="history" className="ag-tabpanel">
          {profile.versions.length === 0 ? (
            <div className="ag-empty">
              <span className="ag-empty-ic" aria-hidden>
                <History size={20} strokeWidth={1.6} />
              </span>
              <p className="ag-empty-t">{lang === "en" ? "No previous versions" : "暂无历史版本"}</p>
              <p className="ag-empty-d">
                {lang === "en"
                  ? "Each save writes a version here — you can restore any of them later."
                  : "每次保存都会在这里留下一个版本，之后可随时回滚。"}
              </p>
            </div>
          ) : (
            <div className="ag-hist cj-pane-scroll">
              {profile.versions
                .slice()
                .reverse()
                .map((v) => (
                  <div key={v.id} className="ag-ver">
                    <div className="ag-ver-body">
                      <div className="ag-ver-note">
                        {v.note ?? (lang === "en" ? "Saved" : "已保存")}
                      </div>
                      <div className="ag-ver-meta">
                        <History size={11} strokeWidth={1.9} />
                        {new Date(v.ts).toLocaleString()}
                        {v.author ? ` · ${v.author}` : ""}
                      </div>
                      <pre className="ag-ver-snip">
                        {v.systemPrompt.slice(0, 240)}
                        {v.systemPrompt.length > 240 ? "…" : ""}
                      </pre>
                    </div>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy || editLocked}
                      onClick={() =>
                        setConfirmAction({
                          kind: "restore",
                          versionId: v.id,
                          note: v.note ?? new Date(v.ts).toLocaleString(),
                        })
                      }
                    >
                      <Check size={13} strokeWidth={1.9} />
                      {t("agents.editor.restore")}
                    </button>
                  </div>
                ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {confirmCopy ? (
        <AlertDialog
          open={confirmAction !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmAction(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmCopy.title}</AlertDialogTitle>
              <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
                <span>{confirmCopy.body}</span>
                <span className="cj-agents-dialog-meta">{confirmCopy.meta}</span>
                <span>
                  {lang === "en"
                    ? "Cancel if you are only reviewing content. Continue only when this runtime action is intentional."
                    : "只做查看或审计时保持当前状态；确认需要影响运行时行为后再继续。"}
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={busy}>
                {confirmCopy.cancel}
              </AlertDialogCancel>
              <AlertDialogAction
                type="button"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault()
                  void runConfirmedAction()
                }}
              >
                {confirmCopy.action}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// §17#4 审计视图:把提示词里 <!-- AUTO_PROMPT_GOVERNANCE:START/END --> 区块
// 单独高亮,标"治理官自动追加",便于人工审计哪些是人写、哪些是 AI 改的
// ---------------------------------------------------------------------------
function PromptAuditView({
  body,
  locked,
  lang,
}: {
  body: string
  locked?: boolean
  lang: "zh" | "en"
}) {
  const segments = React.useMemo(() => splitGovernanceSegments(body), [body])
  const govCount = segments.filter((s) => s.kind === "governance").length
  const humanCount = segments.filter((s) => s.kind === "human").length
  return (
    <div className="ag-audit-wrap">
      <div className="ag-audit-legend">
        <span className="pill human">
          {lang === "en" ? `Human ${humanCount}` : `人手写段 ${humanCount}`}
        </span>
        <span className="pill gov">
          {lang === "en" ? `Governance ${govCount}` : `治理官追加段 ${govCount}`}
        </span>
        {locked && (
          <span className="pill lock">
            {lang === "en" ? "Locked (governance can't override)" : "已锁定（治理官无法覆盖）"}
          </span>
        )}
        <span className="hint">
          {lang === "en" ? "Read-only · switch back to edit" : "只读 · 编辑请返回编辑视图"}
        </span>
      </div>
      <div className="ag-audit cj-pane-scroll">
        {segments.map((seg, i) =>
          seg.kind === "governance" ? (
            <div key={i} className="gov">
              <span className="tag">
                {lang === "en" ? "Auto-appended by governance" : "治理官自动追加段"}
              </span>
              <pre>{seg.text}</pre>
            </div>
          ) : (
            <pre key={i} className="seg">
              {seg.text || "​"}
            </pre>
          ),
        )}
      </div>
    </div>
  )
}

function splitGovernanceSegments(
  raw: string,
): Array<{ kind: "human" | "governance"; text: string }> {
  const re =
    /<!--\s*AUTO_PROMPT_GOVERNANCE:START\s*-->([\s\S]*?)<!--\s*AUTO_PROMPT_GOVERNANCE:END\s*-->/g
  const out: Array<{ kind: "human" | "governance"; text: string }> = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    if (m.index > last) {
      out.push({ kind: "human", text: raw.slice(last, m.index).trim() })
    }
    out.push({ kind: "governance", text: m[1].trim() })
    last = m.index + m[0].length
  }
  if (last < raw.length) {
    const tail = raw.slice(last).trim()
    if (tail) out.push({ kind: "human", text: tail })
  }
  if (out.length === 0) out.push({ kind: "human", text: raw })
  return out
}
