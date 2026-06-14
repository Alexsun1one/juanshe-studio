"use client"

import * as React from "react"
import { Palette, Check } from "lucide-react"

/* 卷舍 · 主题配色切换器
   切换 <html data-cj-theme>,themes.css 据此换「主色性格」(暖纸/像素/语义色不变)。
   默认 violet = 卷舍紫(移除属性,沿用 design.css 原值)。持久化 localStorage cj.theme-color,
   首屏防闪由 public/cj-theme-init.js 负责。 */

export type CjThemeId = "violet" | "jade" | "peacock" | "mint" | "rouge" | "berry" | "brass"

export const CJ_THEMES: ReadonlyArray<{ id: CjThemeId; name: string; color: string }> = [
  { id: "violet", name: "卷舍紫", color: "#6E5BFA" },
  { id: "jade", name: "墨青", color: "#1C8C77" },
  { id: "peacock", name: "孔雀蓝", color: "#0F84A4" },
  { id: "mint", name: "月白薄荷", color: "#20A37C" },
  { id: "rouge", name: "相思红", color: "#C04766" },
  { id: "berry", name: "莓红", color: "#AE3A68" },
  { id: "brass", name: "古铜", color: "#A9762E" },
]

export function applyThemeColor(id: CjThemeId) {
  if (id === "violet") document.documentElement.removeAttribute("data-cj-theme")
  else document.documentElement.setAttribute("data-cj-theme", id)
}

export function ThemeColorPicker() {
  const [open, setOpen] = React.useState(false)
  const [theme, setTheme] = React.useState<CjThemeId>("jade")
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    try {
      const t = (localStorage.getItem("cj.theme-color") as CjThemeId) || "jade"
      if (CJ_THEMES.some((x) => x.id === t)) setTheme(t)
    } catch {
      /* ignore */
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const pick = (id: CjThemeId) => {
    setTheme(id)
    try {
      localStorage.setItem("cj.theme-color", id)
    } catch {
      /* ignore */
    }
    applyThemeColor(id)
    setOpen(false)
  }

  const current = CJ_THEMES.find((t) => t.id === theme) ?? CJ_THEMES[0]

  return (
    <div className="theme-color-picker" ref={ref}>
      <button
        type="button"
        className="theme-color-trigger"
        onClick={() => setOpen((o) => !o)}
        title={`主题配色 · ${current.name}`}
        aria-label="主题配色"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="theme-color-dot" style={{ background: current.color }} />
        <Palette size={15} />
      </button>
      {open && (
        <div className="theme-color-menu" role="menu">
          <div className="theme-color-menu-h">主题配色</div>
          <div className="theme-color-grid">
            {CJ_THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitemradio"
                aria-checked={t.id === theme}
                className={`theme-color-chip${t.id === theme ? " active" : ""}`}
                onClick={() => pick(t.id)}
                title={t.name}
              >
                <span className="theme-color-swatch" style={{ background: t.color }}>
                  {t.id === theme && <Check size={12} />}
                </span>
                <span className="theme-color-name">{t.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
