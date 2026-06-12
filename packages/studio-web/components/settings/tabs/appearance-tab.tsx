"use client"

import * as React from "react"
import { Languages, Moon, Sun, Sunset } from "lucide-react"

import { useT, useLocale } from "@/lib/i18n"
import { useProjectPrefs } from "@/hooks/use-studio"
import { updateProjectPrefs } from "@/lib/api/client"
import { useNotifyPermission } from "@/components/settings/use-notify-permission"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"

const THEME_OPTIONS: {
  value: "light" | "dark" | "system"
  icon: React.ComponentType<{
    className?: string
    strokeWidth?: number | string
  }>
  zh: string
  en: string
}[] = [
  { value: "light", icon: Sun, zh: "明亮", en: "Light" },
  { value: "dark", icon: Moon, zh: "暗色", en: "Dark" },
  { value: "system", icon: Sunset, zh: "跟随系统", en: "System" },
]

export function AppearanceTab() {
  const t = useT()
  const { locale, setLocale } = useLocale()
  const lang = locale === "en" ? "en" : "zh"
  const { data: prefs, mutate } = useProjectPrefs()
  // 首次开启任一通知开关时才向浏览器要权限;被拒不阻断保存(降级为标签页标题提醒)
  const { permission: notifyPerm, ensurePermission } = useNotifyPermission()

  if (!prefs) {
    return (
      <div className="text-muted-foreground py-12 text-center text-xs">
        Loading…
      </div>
    )
  }

  const setTheme = async (theme: "light" | "dark" | "system") => {
    await updateProjectPrefs({ theme })
    mutate()
  }

  return (
    <div className="grid gap-5 md:grid-cols-2">
      {/* Appearance */}
      <Card className="bg-card">
        <CardHeader className="pb-4">
          <CardTitle className="text-sm">
            {lang === "en" ? "Theme" : "主题"}
          </CardTitle>
          <CardDescription className="text-xs">
            {lang === "en"
              ? "Choose between light, dark, or follow the system."
              : "明亮、暗色或跟随系统。"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map((o) => {
              const Icon = o.icon
              const active = prefs.theme === o.value
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setTheme(o.value)}
                  className={
                    active
                      ? "border-primary bg-primary/10 text-foreground flex flex-col items-center gap-2 rounded-xl border-2 px-3 py-4 text-xs"
                      : "border-border hover:bg-secondary text-muted-foreground flex flex-col items-center gap-2 rounded-xl border-2 px-3 py-4 text-xs transition-colors"
                  }
                >
                  <Icon className="size-5" strokeWidth={1.7} />
                  {o[lang]}
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Language */}
      <Card className="bg-card">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Languages className="size-4" strokeWidth={1.8} />
            {lang === "en" ? "Language" : "语言"}
          </CardTitle>
          <CardDescription className="text-xs">
            {lang === "en"
              ? "Interface language for menus and labels — does not change manuscript content."
              : "界面语言；不会更改稿件内容。"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={locale} onValueChange={(v) => setLocale(v as "zh-CN" | "en")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">简体中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Auto-run defaults */}
      <Card className="bg-card md:col-span-2">
        <CardHeader className="pb-4">
          <CardTitle className="text-sm">
            {lang === "en" ? "Auto-run defaults" : "自动续写默认参数"}
          </CardTitle>
          <CardDescription className="text-xs">
            {lang === "en"
              ? "Used when you create a new auto-run task. You can override per task."
              : "新建续写任务时的默认值，单次任务可单独覆盖。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-3">
          <div>
            <Label className="text-xs">
              {t("runs.targetWords")}{" "}
              <span className="text-muted-foreground font-mono">
                {prefs.defaultRun.targetWordsPerChapter}
              </span>
            </Label>
            <Input
              type="number"
              defaultValue={prefs.defaultRun.targetWordsPerChapter}
              className="mt-1.5 font-mono"
              onBlur={async (e) => {
                const v = Number(e.target.value)
                if (v && v !== prefs.defaultRun.targetWordsPerChapter) {
                  await updateProjectPrefs({
                    defaultRun: {
                      ...prefs.defaultRun,
                      targetWordsPerChapter: v,
                    },
                  })
                  mutate()
                }
              }}
            />
          </div>
          <div>
            <Label className="text-xs">
              {t("runs.targetQuality")}{" "}
              <span className="text-muted-foreground font-mono">
                {prefs.defaultRun.targetQuality}
              </span>
            </Label>
            <Slider
              value={[prefs.defaultRun.targetQuality]}
              min={50}
              max={100}
              step={1}
              className="mt-3.5"
              onValueChange={async (v) => {
                await updateProjectPrefs({
                  defaultRun: {
                    ...prefs.defaultRun,
                    targetQuality: v[0],
                  },
                })
                mutate()
              }}
            />
          </div>
          <div>
            <Label className="text-xs">
              {t("runs.maxRetries")}{" "}
              <span className="text-muted-foreground font-mono">
                {prefs.defaultRun.maxRewritesPerChapter}
              </span>
            </Label>
            <Input
              type="number"
              defaultValue={prefs.defaultRun.maxRewritesPerChapter}
              min={0}
              max={10}
              className="mt-1.5 font-mono"
              onBlur={async (e) => {
                const v = Number(e.target.value)
                if (v >= 0 && v !== prefs.defaultRun.maxRewritesPerChapter) {
                  await updateProjectPrefs({
                    defaultRun: {
                      ...prefs.defaultRun,
                      maxRewritesPerChapter: v,
                    },
                  })
                  mutate()
                }
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card className="bg-card md:col-span-2">
        <CardHeader className="pb-4">
          <CardTitle className="text-sm">
            {lang === "en" ? "Notifications" : "通知"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <NotifySwitch
            checked={prefs.notify.onChapterDone}
            onCheckedChange={async (v) => {
              if (v) await ensurePermission()
              await updateProjectPrefs({
                notify: { ...prefs.notify, onChapterDone: v },
              })
              mutate()
            }}
            label={lang === "en" ? "Chapter completed" : "章节完成"}
          />
          <NotifySwitch
            checked={prefs.notify.onRunFailed}
            onCheckedChange={async (v) => {
              if (v) await ensurePermission()
              await updateProjectPrefs({
                notify: { ...prefs.notify, onRunFailed: v },
              })
              mutate()
            }}
            label={lang === "en" ? "Run failed" : "运行失败"}
          />
          <NotifySwitch
            checked={prefs.notify.onLowQuality}
            onCheckedChange={async (v) => {
              if (v) await ensurePermission()
              await updateProjectPrefs({
                notify: { ...prefs.notify, onLowQuality: v },
              })
              mutate()
            }}
            label={lang === "en" ? "Quality below threshold" : "质量低于阈值"}
          />
          {notifyPerm === "denied" &&
            (prefs.notify.onChapterDone || prefs.notify.onRunFailed || prefs.notify.onLowQuality) && (
              <p
                role="status"
                className="text-[11px] leading-relaxed"
                style={{ color: "var(--warn-600, var(--warn-500, #C8841C))" }}
              >
                {lang === "en"
                  ? "Browser blocked system notifications — allow this site in browser settings, otherwise only the tab title will flash."
                  : "浏览器已拦截系统通知 —— 去浏览器设置允许本站通知,否则只能靠标签页标题提醒。"}
              </p>
            )}
        </CardContent>
      </Card>
    </div>
  )
}

function NotifySwitch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  label: string
}) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
