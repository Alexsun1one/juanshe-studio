"use client"

import * as React from "react"
import { ArrowRight, Workflow } from "lucide-react"

import { useT, useLocale } from "@/lib/i18n"
import {
  useAgentProfiles,
  useLLMProviders,
  useWorkflowContract,
} from "@/hooks/use-studio"
import { updateAgentProfile } from "@/lib/api/client"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useToast } from "@/hooks/use-toast"

export function WorkflowTab() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { data: contract } = useWorkflowContract()
  const { data: agents, mutate: mutateAgents } = useAgentProfiles()
  const { data: providers } = useLLMProviders()
  const { toast } = useToast()

  const allModels = (providers ?? [])
    .filter((p) => p.enabled)
    .flatMap((p) => p.models)

  const agentMap = new Map((agents ?? []).map((a) => [a.id, a]))

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-foreground text-base font-semibold">
          {t("settings.llm.routing")}
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          {lang === "en"
            ? "Set which model each agent uses; the workflow contract on the right shows handoffs."
            : "为每个智能体指派模型；右侧合约展示数据接力关系。"}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Routing */}
        <section className="lg:col-span-3">
          <ScrollArea className="border-border bg-card h-[60vh] rounded-2xl border">
            <ul className="divide-border/40 divide-y">
              {(agents ?? [])
                .slice()
                .sort((a, b) => a.step - b.step)
                .map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-4 px-4 py-3"
                  >
                    <div className="bg-secondary text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md font-mono text-[10px]">
                      {a.step.toString().padStart(2, "0")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-[13px] font-medium">
                        {a.name[lang]}
                      </div>
                      <div className="text-muted-foreground truncate text-[10.5px]">
                        {a.tools.length > 0
                          ? a.tools.join(" · ")
                          : lang === "en"
                            ? "no tools"
                            : "无工具"}
                      </div>
                    </div>
                    <Select
                      value={a.model}
                      disabled={a.locked || allModels.length === 0}
                      onValueChange={async (v) => {
                        await updateAgentProfile(a.id, { model: v })
                        mutateAgents()
                        toast({
                          title:
                            lang === "en"
                              ? `${a.name.en} → ${v}`
                              : `${a.name.zh} 已切换到 ${v}`,
                        })
                      }}
                    >
                      <SelectTrigger className="w-56 font-mono text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {allModels.map((m) => (
                          <SelectItem
                            key={m}
                            value={m}
                            className="font-mono text-[11px]"
                          >
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </li>
                ))}
            </ul>
          </ScrollArea>
        </section>

        {/* Contract preview */}
        <aside className="lg:col-span-2">
          <div className="border-border bg-card flex h-[60vh] flex-col rounded-2xl border">
            <div className="border-border flex items-center gap-2 border-b px-4 py-3">
              <Workflow className="text-primary size-4" strokeWidth={1.8} />
              <span className="text-foreground text-sm font-medium">
                {lang === "en" ? "Handoff contract" : "数据接力合约"}
              </span>
            </div>
            <ScrollArea className="min-h-0 flex-1 p-3">
              <ol className="space-y-2">
                {(contract?.steps ?? []).map((s, i) => {
                  const agent = agentMap.get(s.agentId)
                  return (
                    <li
                      key={s.id}
                      className="bg-card rounded-lg p-3"
                    >
                      <div className="text-muted-foreground font-mono text-[10px] uppercase tracking-wider">
                        {String(i + 1).padStart(2, "0")} · {s.id}
                      </div>
                      <div className="text-foreground mt-0.5 text-[12.5px] font-medium">
                        {agent?.name[lang] ?? s.agentId}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px]">
                        {s.inputs.map((x) => (
                          <Badge
                            key={"i" + x}
                            variant="outline"
                            className="border-border font-mono"
                          >
                            ←{x}
                          </Badge>
                        ))}
                        {s.outputs.length > 0 && (
                          <ArrowRight className="text-muted-foreground/60 size-3" />
                        )}
                        {s.outputs.map((x) => (
                          <Badge
                            key={"o" + x}
                            variant="outline"
                            className="border-primary/30 text-primary font-mono"
                          >
                            {x}
                          </Badge>
                        ))}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </ScrollArea>
          </div>
        </aside>
      </div>
    </div>
  )
}
