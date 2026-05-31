"use client"

import * as React from "react"
import {
  Bot,
  Columns2,
  Command,
  CornerDownLeft,
  FileSearch,
  Flame,
  Keyboard,
  LayoutGrid,
  Maximize2,
  Network,
  Palette,
  Pencil,
  PenLine,
  RotateCcw,
  Save,
  Scroll,
  Search,
  Sparkles,
  SquareDashedBottomCode,
  TextQuote,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react"

import { PixelBadge } from "@/components/design/pixel-badge"
import { KpiChip, Meter, StatLine, FoldCard } from "@/components/design/kit"
import "./shortcuts.css"

type SC = { id: string; group: string; action: string; hint: string; scope: string; keys: string }
const DEFAULTS: SC[] = [
  { id: "cmdk", group: "全局", action: "命令面板", hint: "快速跳转 / 搜索一切", scope: "全局", keys: "⌘K" },
  { id: "save", group: "全局", action: "保存", hint: "保存当前章节 / 配置", scope: "全局", keys: "⌘S" },
  { id: "theme", group: "全局", action: "切换主题", hint: "浅色 / 深色", scope: "全局", keys: "⌘." },
  { id: "help", group: "全局", action: "快捷键帮助", hint: "打开本页", scope: "全局", keys: "⌘/" },
  { id: "continue", group: "写作", action: "AI 续写", hint: "让写手继续本章", scope: "编辑器", keys: "⌘↵" },
  { id: "polish", group: "写作", action: "润色", hint: "精修选中段落", scope: "编辑器", keys: "⌘⇧P" },
  { id: "expand", group: "写作", action: "扩写", hint: "扩展当前内容", scope: "编辑器", keys: "⌘⇧E" },
  { id: "immersive", group: "写作", action: "全屏沉浸", hint: "进入 / 退出沉浸模式", scope: "编辑器", keys: "⌘⇧F" },
  { id: "nav-home", group: "导航", action: "工作台", hint: "回到首页", scope: "全局", keys: "⌘1" },
  { id: "nav-editor", group: "导航", action: "章节编辑", hint: "打开编辑器", scope: "全局", keys: "⌘2" },
  { id: "collapse", group: "导航", action: "收起侧栏", hint: "展开 / 收起", scope: "全局", keys: "⌘B" },
  { id: "agents", group: "智能体", action: "智能体面板", hint: "系统与智能体", scope: "全局", keys: "⌘⇧A" },
  { id: "test", group: "智能体", action: "测试连通", hint: "测试当前模型", scope: "设置", keys: "⌘⇧T" },
  { id: "graph", group: "知识", action: "知识图谱", hint: "打开图谱", scope: "全局", keys: "⌘⇧K" },
  { id: "memory", group: "知识", action: "记忆长卷", hint: "打开记忆", scope: "全局", keys: "⌘⇧M" },
]
const GROUPS = ["全局", "写作", "导航", "智能体", "知识"]
const SCOPES = ["全局", "编辑器", "设置"]

// 分组标题图标(语义对齐编辑部模块)
const GROUP_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  全局: Command,
  写作: PenLine,
  导航: LayoutGrid,
  智能体: Bot,
  知识: Network,
}
// 范围筛选图标
const SCOPE_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  全局: Command,
  编辑器: PenLine,
  设置: SquareDashedBottomCode,
}
// 每条动作的贴切图标(一眼可辨,不堆砌)
const ACTION_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  cmdk: Command,
  save: Save,
  theme: Palette,
  help: Keyboard,
  continue: Wand2,
  polish: Sparkles,
  expand: TextQuote,
  immersive: Maximize2,
  "nav-home": LayoutGrid,
  "nav-editor": Pencil,
  collapse: Columns2,
  agents: Bot,
  test: SquareDashedBottomCode,
  graph: Network,
  memory: Scroll,
}

function chordFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey) parts.push("⌘")
  if (e.ctrlKey) parts.push("⌃")
  if (e.altKey) parts.push("⌥")
  if (e.shiftKey) parts.push("⇧")
  let k = e.key
  if (k === " ") k = "Space"
  else if (k === "Enter") k = "↵"
  else if (k === "ArrowUp") k = "↑"; else if (k === "ArrowDown") k = "↓"
  else if (k === "ArrowLeft") k = "←"; else if (k === "ArrowRight") k = "→"
  else if (k.length === 1) k = k.toUpperCase()
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return parts.join("")
  parts.push(k)
  return parts.join("")
}

export default function ShortcutsPage() {
  const [overrides, setOverrides] = React.useState<Record<string, string>>({})
  const [editing, setEditing] = React.useState<string | null>(null)
  const [recorded, setRecorded] = React.useState("")
  const [q, setQ] = React.useState("")
  const [scope, setScope] = React.useState<string>("")

  React.useEffect(() => {
    try { const s = localStorage.getItem("cj.shortcuts"); if (s) setOverrides(JSON.parse(s)) } catch { /* ignore */ }
  }, [])
  const persist = (next: Record<string, string>) => {
    setOverrides(next)
    try { localStorage.setItem("cj.shortcuts", JSON.stringify(next)) } catch { /* ignore */ }
  }

  React.useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === "Escape") { setEditing(null); setRecorded(""); return }
      const chord = chordFromEvent(e)
      setRecorded(chord)
      if (!["Meta", "Control", "Alt", "Shift"].includes(e.key)) {
        persist({ ...overrides, [editing]: chord })
        setEditing(null); setRecorded("")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [editing, overrides])

  const keysOf = (s: SC) => overrides[s.id] ?? s.keys
  const all = DEFAULTS.map((s) => ({ ...s, eff: keysOf(s) }))
  const counts = new Map<string, number>()
  all.forEach((s) => counts.set(s.eff, (counts.get(s.eff) ?? 0) + 1))
  const conflicts = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k))
  const customCount = Object.keys(overrides).length

  const filtered = all.filter((s) => {
    if (scope && s.scope !== scope) return false
    if (q && !`${s.action}${s.hint}${s.eff}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })
  const isFiltering = Boolean(q || scope)

  // ── Inspector 派生(纯展示,不新增请求,不编造数据)──────────────────
  // 各分组条目数:给 Inspector「按模块分布」用既有数据如实呈现
  const groupCounts = GROUPS.map((g) => ({ g, n: all.filter((s) => s.group === g).length })).filter((x) => x.n > 0)
  // 最常用一组快捷键:从默认集挑「高频核心」如实列出(只展示,不改逻辑)
  const ESSENTIALS = ["cmdk", "continue", "save", "immersive", "help"]
  const essentials = ESSENTIALS.map((id) => all.find((s) => s.id === id)).filter((s): s is (SC & { eff: string }) => Boolean(s))
  // 已自定义条目:从 overrides 派生
  const customRows = all.filter((s) => overrides[s.id] != null)

  // 渲染单个组合键为分隔键帽
  const renderKbd = (combo: string) =>
    combo.split(/(?=[⌘⌃⌥⇧])|(?<=[⌘⌃⌥⇧])/).filter(Boolean).map((k, i) => <span className="kbd" key={i}>{k}</span>)

  return (
    <div className="cj-screen cj-shortcuts">
      {/* ── 顶部工作条:像素键盘 + 标题 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead sc-head">
        <div className="sc-headline">
          <PixelBadge kind="shortcuts" size={44} className="sc-hero-pixel" ariaLabel="快捷键" />
          <div className="sc-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">快捷键</h1>
            </div>
            <p className="page-sub">点「编辑」后按下新组合键即可自定义,修改即时保存到本地。</p>
          </div>
        </div>
        <div className="sc-kpis" role="group" aria-label="快捷键概览">
          <KpiChip label="快捷键" value={DEFAULTS.length} unit="个" tone="brand" />
          <KpiChip
            label="已自定义"
            value={customCount}
            unit="个"
            tone={customCount ? "info" : "neutral"}
            hint="相对默认改过的组合键"
          />
          <KpiChip
            label="冲突"
            value={conflicts.size}
            unit="组"
            tone={conflicts.size ? "warn" : "ok"}
            hint="同一组合键被多个动作占用"
          />
          <KpiChip
            label="范围"
            value={SCOPES.length}
            unit="类"
            tone="neutral"
            sub={<StatLine items={[{ n: GROUPS.length, label: "分组", tone: "brand" }]} />}
          />
        </div>
      </header>

      {/* ── 主体:分组清单(主区,pane 内滚) + 速查(Inspector)── */}
      <div className="cj-screen-body sc-body">
        <div className="cj-mainpane sc-mainpane">
          {/* 工具条:搜索 + 范围筛选 + 实时计数(数据原地变化,不另起卡片) */}
          <div className="sc-bar">
            <div className="sc-search">
              <Search size={14} />
              <input placeholder="搜索动作 / 提示 / 组合键" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索快捷键" />
              {q && <button type="button" className="sc-clear" onClick={() => setQ("")} aria-label="清除搜索"><X size={13} /></button>}
            </div>
            <div className="sc-scopes" role="group" aria-label="按范围筛选">
              <button type="button" className={`chip${!scope ? " active" : ""}`} onClick={() => setScope("")}>
                <LayoutGrid size={12} /> 全部
              </button>
              {SCOPES.map((s) => {
                const Ico = SCOPE_ICON[s] ?? Command
                return (
                  <button type="button" key={s} className={`chip${scope === s ? " active" : ""}`} onClick={() => setScope(scope === s ? "" : s)}>
                    <Ico size={12} /> {s}
                  </button>
                )
              })}
            </div>
            <span className="sc-count">显示 <b>{filtered.length}</b> / {all.length}</span>
          </div>

          {conflicts.size > 0 && (
            <div className="sc-alert" role="alert">
              <TriangleAlert size={15} />
              <span><b>{conflicts.size}</b> 组快捷键重复,会相互覆盖,建议调整。</span>
              <button type="button" className="sc-alert-act" onClick={() => persist({})}>全部重置</button>
            </div>
          )}

          <div className="cj-pane-scroll sc-pane-scroll">
            <div className="sc-groups">
              {GROUPS.map((g) => {
                const items = filtered.filter((s) => s.group === g)
                if (!items.length) return null
                const GIco = GROUP_ICON[g] ?? Command
                return (
                  <section className="grp" key={g}>
                    <h3>
                      <span className="gi" aria-hidden><GIco size={13} /></span>
                      <span className="gn">{g}</span>
                      <span className="gc">{items.length}</span>
                    </h3>
                    <div className="grp-list">
                      {items.map((s) => {
                        const isEditing = editing === s.id
                        const isConflict = conflicts.has(s.eff)
                        const isChanged = overrides[s.id] != null
                        const cls = isEditing ? "editing" : isConflict ? "conflict" : isChanged ? "changed" : ""
                        const AIco = ACTION_ICON[s.id] ?? Command
                        return (
                          <div className={`row ${cls}`} key={s.id}>
                            <span className="ico" aria-hidden><AIco size={15} /></span>
                            <div className="info">
                              <div className="ac">
                                {s.action}
                                {isChanged && !isEditing && <span className="pill" data-state="published"><span className="dot" />已改</span>}
                                {isConflict && !isEditing && <span className="pill" data-state="warn"><span className="dot" />冲突</span>}
                              </div>
                              <div className="hint">{s.hint}</div>
                            </div>
                            <span className="scope">{s.scope}</span>
                            {isEditing ? (
                              <span className="recording">{recorded || "按下组合键…"}<i>Esc 取消</i></span>
                            ) : (
                              <span className="kbd-combo">{renderKbd(s.eff)}</span>
                            )}
                            <div className="acts">
                              <button type="button" onClick={() => { setEditing(isEditing ? null : s.id); setRecorded("") }} title={isEditing ? "取消" : "编辑"} aria-label={isEditing ? "取消编辑" : "编辑快捷键"}>{isEditing ? <X size={14} /> : <Pencil size={14} />}</button>
                              {isChanged && <button type="button" onClick={() => { const n = { ...overrides }; delete n[s.id]; persist(n) }} title="重置此项" aria-label="重置此项"><RotateCcw size={14} /></button>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
              {filtered.length === 0 && (
                <div className="sc-empty">
                  <span className="sc-empty-icon" aria-hidden="true"><FileSearch size={18} /></span>
                  <p className="sc-empty-title">
                    没有匹配 {q ? <b>「{q}」</b> : null} 的快捷键{scope ? <> · 范围 <b>{scope}</b></> : null}
                  </p>
                  <p className="sc-empty-sub">换个关键词,或清除筛选看看全部 {all.length} 个快捷键。</p>
                  {isFiltering && <button type="button" className="sc-reset sc-empty-act" onClick={() => { setQ(""); setScope("") }}><RotateCcw size={12} /> 清除筛选</button>}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Inspector:概览 + 模块分布 + 最常用 + 已自定义(只在 pane 内滚)── */}
        <aside className="cj-inspector sc-inspector">
          <div className="cj-pane-scroll sc-insp-scroll">
            <section className="card sc-overview">
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div className="card-title">键位概览</div>
                {customCount > 0 && (
                  <button type="button" className="card-action sc-reset-link" onClick={() => persist({})} title="恢复全部默认">
                    <RotateCcw size={12} /> 恢复默认
                  </button>
                )}
              </div>
              <div className="sc-meters">
                <Meter
                  label="自定义占比"
                  value={customCount}
                  max={Math.max(DEFAULTS.length, 1)}
                  tone="info"
                  showValue={false}
                />
                <div className="sc-meter-cap">
                  <span className="num">{customCount}</span>
                  <span className="sc-meter-of">/{DEFAULTS.length} 个已改</span>
                  <span className="sc-meter-pct">{Math.round((customCount / DEFAULTS.length) * 100)}%</span>
                </div>
              </div>
              <div className="sc-statgrid">
                <span className="sc-stat" data-tone="brand">
                  <b className="num">{DEFAULTS.length}</b>
                  <i>快捷键</i>
                </span>
                <span className="sc-stat" data-tone="info">
                  <b className="num">{customCount}</b>
                  <i>已自定义</i>
                </span>
                <span className="sc-stat" data-tone={conflicts.size ? "warn" : "ok"}>
                  <b className="num">{conflicts.size}</b>
                  <i>冲突</i>
                </span>
              </div>
            </section>

            <FoldCard
              title="按模块分布"
              icon={<LayoutGrid size={15} />}
              count={groupCounts.length}
              defaultOpen
            >
              <div className="sc-dist">
                {groupCounts.map(({ g, n }) => {
                  const GIco = GROUP_ICON[g] ?? Command
                  return (
                    <button
                      key={g}
                      type="button"
                      className="sc-dist-row"
                      onClick={() => { setScope(""); setQ("") }}
                      title={`查看「${g}」分组`}
                    >
                      <span className="sc-dist-ico" aria-hidden><GIco size={14} /></span>
                      <span className="sc-dist-name">{g}</span>
                      <span className="sc-dist-bar" aria-hidden>
                        <i style={{ width: `${Math.round((n / DEFAULTS.length) * 100)}%` }} />
                      </span>
                      <span className="sc-dist-n num">{n}</span>
                    </button>
                  )
                })}
              </div>
            </FoldCard>

            <FoldCard
              title="最常用"
              icon={<Flame size={15} />}
              count={essentials.length}
              defaultOpen
            >
              <div className="sc-quick">
                {essentials.map((s) => {
                  const AIco = ACTION_ICON[s.id] ?? Command
                  return (
                    <div className="sc-quick-row" key={s.id}>
                      <span className="sc-quick-ico" aria-hidden><AIco size={14} /></span>
                      <span className="sc-quick-body">
                        <span className="sc-quick-name">{s.action}</span>
                        <span className="sc-quick-hint">{s.hint}</span>
                      </span>
                      <span className="kbd-combo">{renderKbd(s.eff)}</span>
                    </div>
                  )
                })}
              </div>
            </FoldCard>

            {customRows.length > 0 && (
              <FoldCard
                title="已自定义"
                icon={<Pencil size={15} />}
                count={customRows.length}
                defaultOpen={false}
                scrollable={customRows.length > 4}
                maxHeight={200}
              >
                <div className="sc-quick">
                  {customRows.map((s) => {
                    const AIco = ACTION_ICON[s.id] ?? Command
                    return (
                      <div className="sc-quick-row" key={s.id}>
                        <span className="sc-quick-ico" aria-hidden><AIco size={14} /></span>
                        <span className="sc-quick-body">
                          <span className="sc-quick-name">{s.action}</span>
                          <span className="sc-quick-hint">默认 {DEFAULTS.find((d) => d.id === s.id)?.keys}</span>
                        </span>
                        <span className="kbd-combo">{renderKbd(s.eff)}</span>
                        <button
                          type="button"
                          className="sc-quick-reset"
                          onClick={() => { const n = { ...overrides }; delete n[s.id]; persist(n) }}
                          title="重置此项"
                          aria-label="重置此项"
                        >
                          <RotateCcw size={13} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </FoldCard>
            )}

            <div className="sc-legend">
              <CornerDownLeft size={13} />
              <span>选中一项「编辑」后,直接按下新组合键即可保存;<kbd className="kbd">Esc</kbd> 取消。</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
