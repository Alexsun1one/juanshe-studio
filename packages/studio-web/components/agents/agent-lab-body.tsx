"use client"

import * as React from "react"
import {
  AlertCircle,
  Check,
  History,
  Lock,
  Save,
  Settings2,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react"

import { useT, useLocale } from "@/lib/i18n"
import { useAgentProfiles, useLLMProviders } from "@/hooks/use-studio"
import {
  restoreAgentProfileVersion,
  testAgentProfile,
  updateAgentProfile,
} from "@/lib/api/client"
import type { AgentProfile } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
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
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"

type EditorConfirmAction =
  | { kind: "test" }
  | { kind: "save" }
  | { kind: "restore"; versionId: string; note?: string }

export function AgentLabBody() {
  const { data, mutate } = useAgentProfiles()
  const profiles = data ?? []
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0]

  React.useEffect(() => {
    if (!activeId && profiles.length > 0) setActiveId(profiles[0].id)
  }, [activeId, profiles])

  if (profiles.length === 0) {
    return (
      <div className="text-muted-foreground flex h-[60vh] items-center justify-center text-sm">
        Loading agents…
      </div>
    )
  }

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-12 gap-6 px-6 py-6">
      <aside className="col-span-12 lg:col-span-4 xl:col-span-3">
        <AgentList
          profiles={profiles}
          activeId={active?.id ?? null}
          onSelect={setActiveId}
        />
      </aside>
      <section className="col-span-12 lg:col-span-8 xl:col-span-9">
        {active && (
          <AgentEditor
            key={active.id}
            profile={active}
            onChange={() => mutate()}
          />
        )}
      </section>
    </div>
  )
}

// -----------------------------------------------------------
// Left column — 15 agents as a vertical chain
// -----------------------------------------------------------
function AgentList({
  profiles,
  activeId,
  onSelect,
}: {
  profiles: AgentProfile[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"

  return (
    <ScrollArea className="border-border bg-card h-[calc(100vh-200px)] rounded-2xl border">
      <ul className="space-y-1 p-2">
        {profiles
          .slice()
          .sort((a, b) => a.step - b.step)
          .map((p) => {
            const active = p.id === activeId
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onSelect(p.id)}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all",
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <div
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-[11px]",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-muted-foreground",
                    )}
                  >
                    {p.step.toString().padStart(2, "0")}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium leading-tight">
                        {p.name[lang]}
                      </span>
                      {p.locked && (
                        <Lock
                          className="text-muted-foreground size-3 shrink-0"
                          strokeWidth={1.8}
                        />
                      )}
                    </div>
                    <div className="text-muted-foreground/70 mt-0.5 truncate font-mono text-[10px]">
                      {p.model}
                    </div>
                  </div>
                </button>
              </li>
            )
          })}
      </ul>
    </ScrollArea>
  )
}

// -----------------------------------------------------------
// Right column — full editor with tabs
// -----------------------------------------------------------
function AgentEditor({
  profile,
  onChange,
}: {
  profile: AgentProfile
  onChange: () => void
}) {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { toast } = useToast()
  const { data: providers } = useLLMProviders()

  const [systemPrompt, setSystemPrompt] = React.useState(profile.systemPrompt)
  const [userTemplate, setUserTemplate] = React.useState(
    profile.userTemplate ?? "",
  )
  const [model, setModel] = React.useState(profile.model)
  const [temperature, setTemperature] = React.useState(profile.temperature)
  const [maxTokens, setMaxTokens] = React.useState(profile.maxTokens)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)
  const [confirmAction, setConfirmAction] = React.useState<EditorConfirmAction | null>(null)
  // §17#4 审计视图：高亮 AUTO_PROMPT_GOVERNANCE 区块、清晰区分人手写 vs 治理官追加
  const [auditView, setAuditView] = React.useState(false)

  const dirty =
    systemPrompt !== profile.systemPrompt ||
    userTemplate !== (profile.userTemplate ?? "") ||
    model !== profile.model ||
    temperature !== profile.temperature ||
    maxTokens !== profile.maxTokens
  const modelOptions = React.useMemo(() => {
    const providerModels = (providers ?? [])
      .filter((provider) => provider.enabled)
      .flatMap((provider) => provider.models)
    return Array.from(new Set([...providerModels, profile.model, model].filter(Boolean)))
  }, [providers, profile.model, model])
  const busy = saving || testing || restoring
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
      toast({
        title: res.ok
          ? lang === "en"
            ? `OK (${res.latencyMs}ms)`
            : `连通正常 (${res.latencyMs}ms)`
          : lang === "en"
            ? "Failed"
            : "失败",
        description: res.error ?? res.sample,
      })
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
      toast({
        title:
          lang === "en" ? "Prompt saved" : "提示词已保存",
      })
    } finally {
      setSaving(false)
    }
  }

  const runRestore = async (versionId: string) => {
    setRestoring(true)
    try {
      await restoreAgentProfileVersion(profile.id, versionId)
      onChange()
      toast({
        title:
          lang === "en"
            ? "Version restored"
            : "已回滚到该版本",
      })
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
    <div className="border-border bg-card rounded-2xl border">
      {/* Header */}
      <div className="border-border border-b px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-muted-foreground font-mono text-[10px] uppercase tracking-wider">
              {profile.id} · step {profile.step}/15
            </div>
            <h2 className="text-foreground text-lg font-semibold">
              {profile.name[lang]}
            </h2>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || profile.locked}
              onClick={() => setConfirmAction({ kind: "test" })}
            >
              <Zap className="mr-1.5 size-3.5" strokeWidth={1.8} />
              {t("agents.editor.test")}
            </Button>
            <Button
              size="sm"
              disabled={!dirty || busy || profile.locked}
              onClick={() => setConfirmAction({ kind: "save" })}
            >
              <Save className="mr-1.5 size-3.5" strokeWidth={1.8} />
              {t("agents.editor.save")}
            </Button>
          </div>
        </div>

        {profile.locked && (
          <div className="bg-status-warning/10 text-status-warning mt-3 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs">
            <AlertCircle className="size-3.5" strokeWidth={1.8} />
            {lang === "en"
              ? "This agent is locked by prompt-governance. Unlock in Settings."
              : "该智能体已被提示词治理官锁定，去「设置 / 工作流」解锁"}
          </div>
        )}
      </div>

      {/* Body — tabs */}
      <Tabs defaultValue="prompt" className="px-6 py-5">
        <TabsList className="bg-secondary">
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
          </TabsTrigger>
        </TabsList>

        <TabsContent value="prompt" className="mt-4">
          {/* §17#4 审计视图：把 AUTO_PROMPT_GOVERNANCE 区块单独高亮，让"哪些是治理官自动追加 / 哪些是人手写"一眼看清 */}
          {auditView ? (
            <PromptAuditView body={systemPrompt} locked={profile.locked} />
          ) : (
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              disabled={profile.locked}
              className="bg-card min-h-[60vh] resize-y font-mono text-[12.5px] leading-relaxed"
              spellCheck={false}
            />
          )}
          <div className="text-muted-foreground mt-2 flex items-center justify-between gap-2 text-[11px]">
            <span className="font-mono">
              {systemPrompt.length} chars · {systemPrompt.split(/\s+/).length}{" "}
              words
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAuditView((v) => !v)}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                  auditView
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={auditView}
              >
                {auditView ? "返回编辑" : "审计视图"}
              </button>
              {profile.tools.length > 0 && (
                <div className="flex gap-1">
                  {profile.tools.map((tool) => (
                    <Badge
                      key={tool}
                      variant="outline"
                      className="font-mono text-[10px]"
                    >
                      {tool}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="user" className="mt-4">
          <Textarea
            value={userTemplate}
            onChange={(e) => setUserTemplate(e.target.value)}
            disabled={profile.locked}
            placeholder={
              lang === "en"
                ? "User message template with {{variables}}…"
                : "用户消息模板（可用 {{变量}}）…"
            }
            className="bg-card min-h-[40vh] resize-y font-mono text-[12.5px]"
            spellCheck={false}
          />
        </TabsContent>

        <TabsContent value="config" className="mt-4 space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label className="text-xs">{t("agents.editor.model")}</Label>
              <Select
                value={model}
                onValueChange={setModel}
                disabled={profile.locked}
              >
                <SelectTrigger className="mt-1.5">
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
            </div>

            <div>
              <Label className="text-xs">{t("agents.editor.maxTokens")}</Label>
              <Input
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                disabled={profile.locked}
                min={256}
                max={32768}
                step={256}
                className="mt-1.5 font-mono"
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">
              {t("agents.editor.temperature")} ·{" "}
              <span className="font-mono">{temperature.toFixed(2)}</span>
            </Label>
            <Slider
              value={[temperature]}
              min={0}
              max={2}
              step={0.05}
              onValueChange={(v) => setTemperature(v[0])}
              disabled={profile.locked}
              className="mt-3"
            />
          </div>

          {profile.outputSchema && (
            <div>
              <Label className="text-xs">
                {lang === "en" ? "Output contract" : "输出约束"}
              </Label>
              <pre className="bg-card text-muted-foreground mt-1.5 max-h-40 overflow-auto rounded-md p-3 font-mono text-[11px]">
                {profile.outputSchema}
              </pre>
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          {profile.versions.length === 0 ? (
            <p className="text-muted-foreground py-12 text-center text-sm">
              {lang === "en" ? "No previous versions" : "暂无历史版本"}
            </p>
          ) : (
            <ScrollArea className="h-[60vh] pr-3">
              <ul className="space-y-2">
                {profile.versions
                  .slice()
                  .reverse()
                  .map((v) => (
                    <li
                      key={v.id}
                      className="border-border bg-card rounded-lg border p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground text-xs font-medium">
                            {v.note ??
                              (lang === "en" ? "Saved" : "已保存")}
                          </div>
                          <div className="text-muted-foreground mt-0.5 font-mono text-[10px]">
                            {new Date(v.ts).toLocaleString()}
                            {v.author ? ` · ${v.author}` : ""}
                          </div>
                          <pre className="text-muted-foreground/80 mt-2 max-h-24 overflow-hidden font-mono text-[10.5px] leading-relaxed">
                            {v.systemPrompt.slice(0, 240)}
                            {v.systemPrompt.length > 240 ? "…" : ""}
                          </pre>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0"
                          disabled={busy || profile.locked}
                          onClick={() => setConfirmAction({
                            kind: "restore",
                            versionId: v.id,
                            note: v.note ?? new Date(v.ts).toLocaleString(),
                          })}
                        >
                          <Check className="mr-1 size-3.5" strokeWidth={1.8} />
                          {t("agents.editor.restore")}
                        </Button>
                      </div>
                    </li>
                  ))}
              </ul>
            </ScrollArea>
          )}
        </TabsContent>
      </Tabs>
      {confirmCopy ? (
        <AlertDialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmCopy.title}</AlertDialogTitle>
              <AlertDialogDescription className="grid gap-3 text-left text-xs leading-relaxed">
                <span>{confirmCopy.body}</span>
                <span className="rounded-md border border-border bg-secondary px-3 py-2 text-foreground">{confirmCopy.meta}</span>
                <span>
                  {lang === "en"
                    ? "Cancel if you are only reviewing content. Continue only when this runtime action is intentional."
                    : "只做查看或审计时保持当前状态；确认需要影响运行时行为后再继续。"}
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={busy}>{confirmCopy.cancel}</AlertDialogCancel>
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
// §17#4 审计视图：把提示词里 <!-- AUTO_PROMPT_GOVERNANCE:START/END --> 区块
// 单独高亮，标"治理官自动追加"，便于人工审计哪些是人写、哪些是 AI 改的
// ---------------------------------------------------------------------------
function PromptAuditView({
  body,
  locked,
}: {
  body: string
  locked?: boolean
}) {
  const segments = React.useMemo(() => splitGovernanceSegments(body), [body])
  const govCount = segments.filter((s) => s.kind === "governance").length
  const humanCount = segments.filter((s) => s.kind === "human").length
  return (
    <div className="space-y-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded bg-secondary px-1.5 py-0.5">
          人手写段 {humanCount}
        </span>
        <span className="bg-primary/15 text-primary rounded px-1.5 py-0.5">
          治理官追加段 {govCount}
        </span>
        {locked && (
          <span className="bg-status-warning/15 text-status-warning rounded px-1.5 py-0.5">
            🔒 已锁定（治理官无法覆盖）
          </span>
        )}
        <span className="ml-auto">只读 · 编辑请返回编辑视图</span>
      </div>
      <div className="bg-card border-border max-h-[60vh] overflow-auto rounded-md border p-3 font-mono text-[12.5px] leading-relaxed">
        {segments.map((seg, i) =>
          seg.kind === "governance" ? (
            <div
              key={i}
              className="border-primary/30 bg-primary/[0.06] my-2 rounded-md border px-3 py-2"
            >
              <div className="text-primary mb-1 text-[10px] font-semibold uppercase tracking-wider">
                🤖 治理官自动追加段
              </div>
              <pre className="text-foreground/85 whitespace-pre-wrap break-words font-mono text-[12px]">
                {seg.text}
              </pre>
            </div>
          ) : (
            <pre
              key={i}
              className="text-foreground/90 my-1 whitespace-pre-wrap break-words font-mono text-[12.5px]"
            >
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
  const re = /<!--\s*AUTO_PROMPT_GOVERNANCE:START\s*-->([\s\S]*?)<!--\s*AUTO_PROMPT_GOVERNANCE:END\s*-->/g
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
  // 如果整篇都没有标记，至少给出一段 human
  if (out.length === 0) out.push({ kind: "human", text: raw })
  return out
}
