"use client"

/**
 * WechatTemplatePicker —— 公众号模板选择器(带迷你预览缩略图)。
 *
 * 替换原来的纯文字 <select> —— 5 个模板各自有视觉特征(衬线、号字、底色、accent 等),
 * 用 64×44 的 SVG mini-preview 让用户一眼区分。
 *
 * 用 native button + 自管理 popover(不依赖 shadcn DropdownMenu 的默认 item 样式),
 * 风格对齐 BookSwitcher 的 bare-button 卡片列表。
 */

import * as React from "react"

export type WechatTpl = { id: string; label: string; tagline?: string }

interface Props {
  templates: readonly WechatTpl[]
  value: string
  onChange: (id: string) => void
  className?: string
}

export function WechatTemplatePicker({ templates, value, onChange, className }: Props) {
  const [open, setOpen] = React.useState(false)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
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

  const active = templates.find((t) => t.id === value) ?? templates[0]

  return (
    <div ref={wrapRef} className={`wtp ${className ?? ""}`} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="wtp-trigger bg-card border-border flex items-center gap-2 rounded-md border px-2 py-1 text-cap"
        title={active?.tagline}
      >
        <span className="text-muted-foreground">模板</span>
        <WechatTemplateThumb id={active?.id ?? "minimal"} small />
        <span className="text-foreground font-medium">{active?.label ?? "—"}</span>
        <span className="text-muted-foreground/70" aria-hidden>▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          className="wtp-menu bg-card border-border shadow-pop"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 50,
            minWidth: 280,
            padding: 6,
            borderRadius: 10,
            border: "1px solid var(--border)",
          }}
        >
          {templates.map((t) => {
            const isActive = t.id === value
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => { onChange(t.id); setOpen(false) }}
                className="wtp-item"
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: 10,
                  alignItems: "center",
                  width: "100%",
                  padding: "8px 8px",
                  borderRadius: 8,
                  background: isActive ? "var(--brand-50, rgba(91,91,214,0.10))" : "transparent",
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "var(--muted, rgba(0,0,0,0.04))"
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "transparent"
                }}
              >
                <WechatTemplateThumb id={t.id} />
                <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--foreground)",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {t.label}
                    {isActive && (
                      <span
                        style={{
                          display: "inline-block",
                          width: 6,
                          height: 6,
                          borderRadius: 999,
                          background: "var(--brand-500, #5b5bd6)",
                        }}
                        aria-hidden
                      />
                    )}
                  </span>
                  {t.tagline && (
                    <span
                      style={{
                        fontSize: 11.5,
                        color: "var(--muted-foreground)",
                        lineHeight: 1.4,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.tagline}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 模板迷你预览 —— 64×44 SVG,每个模板的视觉签名:
 *   business: 紫蓝侧条 + 标题 + CTA 按钮 → 商业稳重
 *   knowledge: 绿底 H2 pill + 三条 ▸ 列表 → 知识结构
 *   story: 米黄底 + 『 』居中标题 + dropcap + ❀ 分割 → 故事文艺
 *   literary: 米色底 + 长破折号居中标题 + 紧密衬线 + ⁂ 三角分割 → 严肃文学
 *   minimal: 纯白 + 粗体标题 + 紧凑灰色正文,无装饰 → 极简
 */
export function WechatTemplateThumb({ id, small = false }: { id: string; small?: boolean }) {
  const w = small ? 28 : 64
  const h = small ? 20 : 44
  const baseStyle: React.CSSProperties = {
    display: "block",
    borderRadius: small ? 3 : 5,
    flexShrink: 0,
    overflow: "hidden",
  }

  if (id === "business") {
    return (
      <svg viewBox="0 0 64 44" width={w} height={h} aria-hidden style={{ ...baseStyle, background: "#fff", border: "1px solid #d8dae6" }}>
        <rect x="0" y="0" width="6" height="44" fill="#5b5bd6" />
        <rect x="11" y="6" width="36" height="3" rx="1" fill="#1f2433" />
        <rect x="11" y="14" width="46" height="2" rx="1" fill="#9aa1b2" />
        <rect x="11" y="19" width="42" height="2" rx="1" fill="#9aa1b2" />
        <rect x="11" y="24" width="46" height="2" rx="1" fill="#9aa1b2" />
        <rect x="11" y="32" width="20" height="6" rx="1.5" fill="#5b5bd6" />
      </svg>
    )
  }
  if (id === "knowledge") {
    return (
      <svg viewBox="0 0 64 44" width={w} height={h} aria-hidden style={{ ...baseStyle, background: "#fff", border: "1px solid #d8e6dd" }}>
        <rect x="6" y="5" width="28" height="7" rx="1.5" fill="#E5F7EE" />
        <rect x="9" y="7" width="22" height="3" rx="1" fill="#0F6F45" />
        <rect x="6" y="17" width="2" height="2" rx="0.5" fill="#2BB97A" />
        <rect x="11" y="17" width="48" height="2" rx="1" fill="#1F2937" />
        <rect x="6" y="23" width="2" height="2" rx="0.5" fill="#2BB97A" />
        <rect x="11" y="23" width="40" height="2" rx="1" fill="#1F2937" />
        <rect x="6" y="29" width="2" height="2" rx="0.5" fill="#2BB97A" />
        <rect x="11" y="29" width="44" height="2" rx="1" fill="#1F2937" />
        <text x="32" y="40" fontSize="5" fill="#dcdce6" textAnchor="middle" fontWeight="700" letterSpacing="3">···</text>
      </svg>
    )
  }
  if (id === "story") {
    return (
      <svg viewBox="0 0 64 44" width={w} height={h} aria-hidden style={{ ...baseStyle, background: "#FFF8E8", border: "1px solid #F1DFB8" }}>
        <text x="32" y="11" fontSize="6" fill="#8A4F00" textAnchor="middle" fontWeight="700" fontFamily="'Songti SC',serif">『 故事 』</text>
        <rect x="6" y="17" width="8" height="9" rx="0.5" fill="#D97706" opacity="0.85" />
        <rect x="16" y="17" width="42" height="2" rx="1" fill="#26221C" />
        <rect x="16" y="21" width="38" height="2" rx="1" fill="#26221C" />
        <rect x="6" y="29" width="52" height="2" rx="1" fill="#26221C" />
        <text x="32" y="40" fontSize="5" fill="#D97706" textAnchor="middle" letterSpacing="2">━ ❀ ━</text>
      </svg>
    )
  }
  if (id === "literary") {
    return (
      <svg viewBox="0 0 64 44" width={w} height={h} aria-hidden style={{ ...baseStyle, background: "#FBF9F5", border: "1px solid #E5DFD2" }}>
        <line x1="6" y1="11" x2="14" y2="11" stroke="#3C3633" strokeWidth="0.8" />
        <rect x="18" y="8" width="28" height="5" rx="0.5" fill="#1A1614" />
        <line x1="50" y1="11" x2="58" y2="11" stroke="#3C3633" strokeWidth="0.8" />
        <rect x="6" y="18" width="50" height="1.5" rx="0.5" fill="#3C3633" />
        <rect x="6" y="22" width="52" height="1.5" rx="0.5" fill="#3C3633" />
        <rect x="6" y="26" width="48" height="1.5" rx="0.5" fill="#3C3633" />
        <rect x="6" y="30" width="50" height="1.5" rx="0.5" fill="#3C3633" />
        <text x="32" y="40" fontSize="6" fill="#3C3633" textAnchor="middle" fontWeight="700">⁂</text>
      </svg>
    )
  }
  // minimal (fallback)
  return (
    <svg viewBox="0 0 64 44" width={w} height={h} aria-hidden style={{ ...baseStyle, background: "#fff", border: "1px solid #e6e6ef" }}>
      <rect x="6" y="6" width="36" height="4" rx="0.5" fill="#111" />
      <rect x="6" y="14" width="52" height="2" rx="1" fill="#888" />
      <rect x="6" y="19" width="48" height="2" rx="1" fill="#888" />
      <rect x="6" y="24" width="52" height="2" rx="1" fill="#888" />
      <rect x="6" y="29" width="44" height="2" rx="1" fill="#888" />
      <rect x="6" y="34" width="50" height="2" rx="1" fill="#888" />
    </svg>
  )
}
