"use client"

import {
  BookText,
  ExternalLink,
  Github,
  HeartHandshake,
} from "lucide-react"
import { useLocale } from "@/lib/i18n"
import { EDITORIAL_STAFF_COUNT } from "@/lib/agent-identity"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export function AboutTab() {
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="bg-card md:col-span-2">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="from-primary/90 to-accent/80 flex size-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm">
              <BookText
                className="text-primary-foreground size-6"
                strokeWidth={1.7}
              />
            </div>
            <div>
              <h2 className="text-foreground text-lg font-semibold tracking-tight">
                Scroll Studio
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {lang === "en"
                  ? `A collaborative writing console with ${EDITORIAL_STAFF_COUNT} AI editors, for novelists who run their own AI workshop.`
                  : `面向把 AI 视为合作伙伴的小说作者的 ${EDITORIAL_STAFF_COUNT} 位编辑协同创作控制台。`}
              </p>
              <p className="text-muted-foreground/70 mt-2 font-mono text-[10.5px]">
                v0.4.0 · build 2026.05.11
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardContent className="p-5">
          <h3 className="text-foreground mb-2 flex items-center gap-2 text-sm font-semibold">
            <Github className="size-4" strokeWidth={1.8} />
            {lang === "en" ? "Source" : "源码"}
          </h3>
          <p className="text-muted-foreground text-xs">
            {lang === "en"
              ? "Studio is open and self-hostable. Bring your own keys, run on your own machine."
              : "Studio 完全开源、可自托管，自带 LLM Key，在本地机器上运行。"}
          </p>
          <Button size="sm" variant="outline" className="mt-3" disabled>
            <ExternalLink className="mr-1.5 size-3.5" strokeWidth={1.8} />
            GitHub
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardContent className="p-5">
          <h3 className="text-foreground mb-2 flex items-center gap-2 text-sm font-semibold">
            <HeartHandshake className="size-4" strokeWidth={1.8} />
            {lang === "en" ? "Credits" : "致谢"}
          </h3>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {lang === "en"
              ? "Built with Next.js, the AI SDK and shadcn/ui. The editorial chain is inspired by the workflows of working novelists. Thanks to all who shared their craft."
              : "基于 Next.js、AI SDK、shadcn/ui 构建。编辑部工作流灵感来自一线网络作家的真实创作流程；感谢所有愿意分享方法论的从业者。"}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
