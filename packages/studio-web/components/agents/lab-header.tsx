"use client"

import * as React from "react"
import { Zap } from "lucide-react"

import { useT, useLocale } from "@/lib/i18n"
import { testAllAgentProfiles } from "@/lib/api/client"
import { Button } from "@/components/ui/button"
import { PixelBadge } from "@/components/design/pixel-badge"
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

export function LabHeader() {
  const t = useT()
  const { locale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { toast } = useToast()
  const [testing, setTesting] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const runConnectivityTest = async () => {
    setConfirmOpen(false)
    setTesting(true)
    try {
      const res = await testAllAgentProfiles()
      const passed = res.filter((r) => r.ok).length
      toast({
        title:
          lang === "en"
            ? `Connectivity: ${passed}/${res.length} agents OK`
            : `连通性测试：${passed}/${res.length} 通过`,
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <header className="border-border bg-card sticky top-0 z-30 border-b backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <PixelBadge kind="agents" size={40} className="page-title-pixel" ariaLabel={t("agents.title")} />
          <div className="leading-tight">
            <h1 className="text-foreground text-lg font-semibold tracking-tight">
              {t("agents.title")}
            </h1>
            <p className="text-muted-foreground text-xs">
              {t("agents.subtitle")}
            </p>
          </div>
        </div>

        <Button
          size="sm"
          variant="outline"
          disabled={testing}
          onClick={() => setConfirmOpen(true)}
        >
          <Zap className="mr-1.5 size-3.5" strokeWidth={1.8} />
          {t("agents.connectivity.test")}
        </Button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
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
              <span className="rounded-md border border-border bg-secondary px-3 py-2 text-foreground">
                {lang === "en" ? "Scope: all agent profiles" : "范围：全部 Agent 档案"}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={testing}>
              {lang === "en" ? "Not now" : "先不测试"}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={testing}
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
    </header>
  )
}
