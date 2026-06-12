"use client"

import * as React from "react"
import useSWR from "swr"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import {
  Archive,
  Bell,
  BellRing,
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileCheck2,
  Gauge,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plus,
  Repeat2,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Sun,
  Target,
  TriangleAlert,
  Type,
} from "lucide-react"
import Link from "next/link"
import { fetchProjectPrefs, updateProjectPrefs } from "@/lib/api/client"
import type { ProjectPrefs } from "@/lib/api/types"
import { useNotifyPermission } from "@/components/settings/use-notify-permission"
import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import "./settings.css"

const NAV = [
  { id: "ai", label: "AI 行为", icon: Settings2 },
  { id: "appear", label: "外观", icon: Palette },
  { id: "notify", label: "通知", icon: Bell },
  { id: "model", label: "大模型", icon: Bot },
  { id: "danger", label: "危险区", icon: TriangleAlert, danger: true },
]

export default function PreferencesPage() {
  const { data: prefs, mutate } = useSWR("prefs", fetchProjectPrefs)
  const { theme, setTheme } = useTheme()
  const [active, setActive] = React.useState("ai")
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const save = async (patch: Partial<ProjectPrefs>) => {
    if (!prefs) return
    mutate({ ...prefs, ...patch }, false)
    try {
      await updateProjectPrefs(patch)
      mutate()
      toast.success("已保存")
    } catch (e) {
      toast.error(`保存失败:${e instanceof Error ? e.message : String(e)}`)
      mutate()
    }
  }
  const saveRun = (key: keyof ProjectPrefs["defaultRun"], val: number) => prefs && save({ defaultRun: { ...prefs.defaultRun, [key]: val } })
  // 首次开启任一通知开关时才向浏览器要权限;被拒不阻断保存(降级为标签页标题提醒),下方显示小字提示
  const { permission: notifyPerm, ensurePermission } = useNotifyPermission()
  const saveNotify = async (key: keyof ProjectPrefs["notify"], val: boolean) => {
    if (!prefs) return
    if (val) await ensurePermission()
    save({ notify: { ...prefs.notify, [key]: val } })
  }

  const go = (id: string) => {
    setActive(id)
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const dr = prefs?.defaultRun
  const nt = prefs?.notify
  const curTheme = mounted ? theme ?? "system" : "system"
  const themeLabel = curTheme === "dark" ? "深色" : curTheme === "light" ? "浅色" : "跟随系统"
  const ThemeIcon = curTheme === "dark" ? Moon : curTheme === "light" ? Sun : Monitor
  const notifyOn = nt ? Object.values(nt).filter(Boolean).length : 0
  const notifyTotal = nt ? Object.values(nt).length : 3
  // 质量门槛分档(仅展示用,门槛本身仍是用户设的值):≥85 稳 / ≥70 中 / 其余偏松
  const qualityTone = dr ? (dr.targetQuality >= 85 ? "ok" : dr.targetQuality >= 70 ? "warn" : "neutral") : "neutral"

  const Stepper = ({
    value,
    onDec,
    onInc,
    decLabel,
    incLabel,
    disabled,
  }: {
    value: React.ReactNode
    onDec: () => void
    onInc: () => void
    decLabel: string
    incLabel: string
    disabled?: boolean
  }) => (
    <div className="stepper" role="group" aria-label={`${decLabel} / ${incLabel}`}>
      <button type="button" onClick={onDec} aria-label={decLabel} title={decLabel} disabled={disabled}><Minus size={13} aria-hidden="true" /></button>
      <span className="val" aria-live="polite">{value}</span>
      <button type="button" onClick={onInc} aria-label={incLabel} title={incLabel} disabled={disabled}><Plus size={13} aria-hidden="true" /></button>
    </div>
  )

  return (
    <div className="cj-screen cj-settings">
      {/* ── 顶部工作条:像素「偏好」徽章 + 标题 + 一行密集 KPI(当前配置,数据原地呈现)── */}
      <header className="cj-workhead set-head">
        <div className="set-headline">
          <PixelBadge kind="preferences" size={44} className="set-hero-pixel" ariaLabel="偏好设置" />
          <div className="set-headline-text">
            <div className="page-title-row"><h1 className="page-title">偏好设置</h1></div>
            <p className="page-sub">写作环境、AI 行为、外观与通知 · 修改即时保存到本地后端。</p>
          </div>
        </div>
        <div className="set-kpis" role="group" aria-label="当前配置概览">
          <KpiChip label="单章字数目标" value={dr ? dr.targetWordsPerChapter.toLocaleString() : "—"} unit="字" tone="brand" hint="每章自动写作的目标字数" />
          <KpiChip label="质量门槛" value={dr ? dr.targetQuality : "—"} unit="分" tone={qualityTone} hint="低于此分自动触发改稿" />
          <KpiChip label="改写上限" value={dr ? dr.maxRewritesPerChapter : "—"} unit="轮" tone="amber" hint="达不到门槛时的自动重写上限" />
          <KpiChip label="界面主题" value={themeLabel} tone="info" hint="当前界面主题" />
          <KpiChip label="通知开启" value={nt ? notifyOn : "—"} unit={`/ ${notifyTotal}`} tone={notifyOn > 0 ? "ok" : "neutral"} hint="已开启的通知项" />
        </div>
      </header>

      {/* ── 主体:设置主区(pane 内滚) + 当前配置 Inspector ── */}
      <div className="cj-screen-body set-body">
        <div className="cj-mainpane set-mainpane">
          {/* 主区头:分类导航(可跳转,保留可访问性) */}
          <div className="set-mainpane-head">
            <nav className="set-nav" aria-label="设置分组">
              {NAV.map((n) => {
                const Icon = n.icon
                return (
                  <button
                    type="button"
                    key={n.id}
                    className={`sn${active === n.id ? " active" : ""}${n.danger ? " danger" : ""}`}
                    onClick={() => go(n.id)}
                    aria-current={active === n.id ? "true" : undefined}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {n.label}
                  </button>
                )
              })}
            </nav>
          </div>

          <div className="cj-pane-scroll set-pane-scroll">
            {/* AI 行为 */}
            <section className="sec" id="sec-ai">
              <div className="sec-head">
                <span className="sec-no" aria-hidden="true">01</span>
                <span className="sec-ico" aria-hidden="true"><Settings2 size={15} /></span>
                <div className="sec-ht"><h3>AI 行为</h3><div className="sub">控制自动写作流水线的默认目标与质量门槛。</div></div>
              </div>
              <div className="opt">
                <span className="opt-ico" aria-hidden="true"><Type size={15} /></span>
                <div className="ot"><div className="on">单章字数目标</div><div className="od">每章自动写作的目标字数。</div></div>
                <div className="oc"><Stepper value={dr ? dr.targetWordsPerChapter.toLocaleString() : "—"} onDec={() => dr && saveRun("targetWordsPerChapter", Math.max(500, dr.targetWordsPerChapter - 500))} onInc={() => dr && saveRun("targetWordsPerChapter", dr.targetWordsPerChapter + 500)} decLabel="减少单章字数目标" incLabel="增加单章字数目标" disabled={!dr} /></div>
              </div>
              <div className="opt">
                <span className="opt-ico" aria-hidden="true"><Gauge size={15} /></span>
                <div className="ot"><div className="on">质量门槛</div><div className="od">低于此分自动触发改稿(0–100)。</div></div>
                <div className="oc"><Stepper value={dr ? `${dr.targetQuality} 分` : "—"} onDec={() => dr && saveRun("targetQuality", Math.max(0, dr.targetQuality - 5))} onInc={() => dr && saveRun("targetQuality", Math.min(100, dr.targetQuality + 5))} decLabel="降低质量门槛" incLabel="提高质量门槛" disabled={!dr} /></div>
              </div>
              <div className="opt">
                <span className="opt-ico" aria-hidden="true"><Repeat2 size={15} /></span>
                <div className="ot"><div className="on">单章最多改写轮数</div><div className="od">达不到门槛时的自动重写上限。</div></div>
                <div className="oc"><Stepper value={dr ? `${dr.maxRewritesPerChapter} 轮` : "—"} onDec={() => dr && saveRun("maxRewritesPerChapter", Math.max(0, dr.maxRewritesPerChapter - 1))} onInc={() => dr && saveRun("maxRewritesPerChapter", dr.maxRewritesPerChapter + 1)} decLabel="减少单章最多改写轮数" incLabel="增加单章最多改写轮数" disabled={!dr} /></div>
              </div>
            </section>

            {/* 外观 */}
            <section className="sec" id="sec-appear">
              <div className="sec-head">
                <span className="sec-no" aria-hidden="true">02</span>
                <span className="sec-ico" aria-hidden="true"><Palette size={15} /></span>
                <div className="sec-ht"><h3>外观</h3><div className="sub">选择界面主题。深色适合长时间夜间写作。</div></div>
              </div>
              <div className="theme-cards">
                {([["light", "浅色", Sun], ["dark", "深色", Moon], ["system", "跟随系统", Monitor]] as const).map(([val, label, Icon]) => (
                  <button type="button" key={val} className={`tc ${val}${curTheme === val ? " sel" : ""}`} onClick={() => setTheme(val)}>
                    <div className="prev"><div className="a" /><div className="b" /></div>
                    <div className="tl"><Icon size={14} />{label}</div>
                  </button>
                ))}
              </div>
            </section>

            {/* 通知 */}
            <section className="sec" id="sec-notify">
              <div className="sec-head">
                <span className="sec-no" aria-hidden="true">03</span>
                <span className="sec-ico" aria-hidden="true"><Bell size={15} /></span>
                <div className="sec-ht"><h3>通知 <span className="sec-tag">{notifyOn}/{notifyTotal} 开启</span></h3><div className="sub">在关键事件发生时提醒你。</div></div>
              </div>
              {([["onChapterDone", "章节完成", "一章写完并通过质量门禁时通知", FileCheck2], ["onRunFailed", "运行失败", "自动写作流水线出错时通知", TriangleAlert], ["onLowQuality", "质量偏低", "成稿质量低于门槛时通知", CircleAlert]] as const).map(([key, name, desc, Icon]) => (
                <div className="opt" key={key}>
                  <span className="opt-ico" aria-hidden="true"><Icon size={15} /></span>
                  <div className="ot"><div className="on">{name}</div><div className="od">{desc}</div></div>
                  <div className="oc"><button type="button" className={`sw${nt?.[key] ? " on" : ""}`} role="switch" aria-checked={!!nt?.[key]} onClick={() => saveNotify(key, !nt?.[key])} aria-label={`${name}${nt?.[key] ? "已开启" : "已关闭"}`} /></div>
                </div>
              ))}
              {notifyPerm === "denied" && notifyOn > 0 && (
                <p className="notify-perm-tip" role="status">
                  <TriangleAlert size={12} aria-hidden="true" />
                  浏览器已拦截系统通知 —— 去浏览器设置允许本站通知,否则只能靠标签页标题提醒。
                </p>
              )}
            </section>

            {/* 大模型 */}
            <section className="sec" id="sec-model">
              <div className="sec-head">
                <span className="sec-no" aria-hidden="true">04</span>
                <span className="sec-ico" aria-hidden="true"><Bot size={15} /></span>
                <div className="sec-ht"><h3>大模型</h3><div className="sub">配置写作 / 评审使用的大模型服务。</div></div>
              </div>
              <Link href="/llm" className="link-row">
                <span className="lr-ico"><Bot size={16} aria-hidden="true" /></span>
                <div className="lr-text"><div className="lr-t">大模型配置</div><div className="lr-d">接入服务商、填 Key、一键测试连通性</div></div>
                <ChevronRight size={18} className="lr-chev" aria-hidden="true" />
              </Link>
            </section>

            {/* 危险区 */}
            <section className="sec" id="sec-danger">
              <div className="sec-head">
                <span className="sec-no danger" aria-hidden="true">05</span>
                <span className="sec-ico danger" aria-hidden="true"><TriangleAlert size={15} /></span>
                <div className="sec-ht"><h3 className="danger">危险区</h3><div className="sub">这些操作不可逆,请谨慎。</div></div>
              </div>
              <div className="danger-zone">
                <div className="opt">
                  <span className="opt-ico danger" aria-hidden="true"><RotateCcw size={15} /></span>
                  <div className="ot"><div className="on">重置 AI 学习数据</div><div className="od">清空账号风格自我进化沉淀的规则。</div></div>
                  <div className="oc"><button type="button" className="btn danger sm" onClick={() => toast("已记录,请在后端确认后执行", { description: "出于安全,破坏性操作不在前端直接执行。" })}><RotateCcw size={13} aria-hidden="true" />重置</button></div>
                </div>
                <div className="opt">
                  <span className="opt-ico danger" aria-hidden="true"><Archive size={15} /></span>
                  <div className="ot"><div className="on">归档当前工作区</div><div className="od">归档后将从活跃列表移除。</div></div>
                  <div className="oc"><button type="button" className="btn danger sm" onClick={() => toast("已记录,请在后端确认后执行")}><Archive size={13} aria-hidden="true" />归档</button></div>
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* ── Inspector:当前配置(写作目标计量 + 状态汇总 + 快速跳转)── */}
        <aside className="cj-inspector set-inspector">
          <div className="cj-pane-scroll set-insp-scroll">
            <section className="card set-overview">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-title">当前配置</div>
                <button type="button" className="card-action" onClick={() => go("ai")}>调整 →</button>
              </div>
              {dr ? (
                <>
                  <div className="set-meters">
                    <Meter
                      label="质量门槛"
                      value={dr.targetQuality}
                      max={100}
                      threshold={dr.targetQuality}
                      tone={qualityTone === "neutral" ? "warn" : qualityTone}
                    />
                    <div className="set-meter-cap">
                      <Target size={12} aria-hidden="true" />
                      <span>单章目标</span>
                      <span className="num">{dr.targetWordsPerChapter.toLocaleString()}</span>
                      <em>字</em>
                      <span className="set-dot" aria-hidden />
                      <Repeat2 size={12} aria-hidden="true" />
                      <span>至多改</span>
                      <span className="num">{dr.maxRewritesPerChapter}</span>
                      <em>轮</em>
                    </div>
                  </div>
                  <div className="set-statgrid">
                    <span className="set-stat" data-tone="brand">
                      <ThemeIcon size={15} aria-hidden="true" />
                      <b>{themeLabel}</b>
                      <i>界面主题</i>
                    </span>
                    <span className="set-stat" data-tone={notifyOn > 0 ? "ok" : "neutral"}>
                      <BellRing size={15} aria-hidden="true" />
                      <b className="num">{notifyOn}<span className="set-stat-of">/{notifyTotal}</span></b>
                      <i>通知开启</i>
                    </span>
                    <span className="set-stat" data-tone="info">
                      <SlidersHorizontal size={15} aria-hidden="true" />
                      <b className="num">{NAV.length}</b>
                      <i>设置分组</i>
                    </span>
                  </div>
                </>
              ) : (
                <div className="set-overview-empty">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="skel" style={{ height: 32, borderRadius: "var(--r-md)" }} />
                  ))}
                </div>
              )}
            </section>

            <FoldCard title="快速跳转" count={NAV.length} defaultOpen icon={<SlidersHorizontal size={15} />}>
              <div className="set-jump-list">
                {NAV.map((n) => {
                  const Icon = n.icon
                  return (
                    <button
                      key={n.id}
                      type="button"
                      className={`set-jump${n.danger ? " danger" : ""}${active === n.id ? " active" : ""}`}
                      onClick={() => go(n.id)}
                    >
                      <span className="set-jump-ico"><Icon size={15} aria-hidden="true" /></span>
                      <span className="set-jump-label">{n.label}</span>
                      {n.id === "notify" && nt ? (
                        <span className="pill" data-state={notifyOn > 0 ? "running" : "pending"}>
                          <span className="dot" />
                          {notifyOn}/{notifyTotal}
                        </span>
                      ) : n.id === "appear" ? (
                        <span className="set-jump-tag">{themeLabel}</span>
                      ) : null}
                      <ChevronRight size={15} className="set-jump-chev" aria-hidden="true" />
                    </button>
                  )
                })}
              </div>
            </FoldCard>

            <FoldCard title="提示" defaultOpen={false} icon={<CircleCheck size={15} />}>
              <div className="set-tips">
                <p>所有修改即时保存到本地后端,无需手动提交。</p>
                <p>质量门槛越高,自动改稿越严格;改写上限决定单章最多重写几轮。</p>
                <p>危险区操作不在前端直接执行,会先记录待后端确认。</p>
              </div>
            </FoldCard>
          </div>
        </aside>
      </div>
    </div>
  )
}
