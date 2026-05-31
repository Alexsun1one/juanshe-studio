"use client"

import * as React from "react"
import "./brand-ornaments.css"

const PROPS = [
  { src: "/brand/props/desk-lamp.webp", cls: "lamp" },
  { src: "/brand/props/potted-plant.webp", cls: "plant" },
  { src: "/brand/props/manuscript-stack.webp", cls: "manuscript" },
  { src: "/brand/props/coffee-mug.webp", cls: "mug" },
  { src: "/brand/props/flower-bouquet.webp", cls: "flowers" },
] as const

/**
 * Fixed decorative layer for the product shell.
 * It keeps every route in the same pixel editorial-office world without adding
 * per-page layout weight. Images are tiny WebP props and all motion is CSS-only.
 */
export function BrandOrnaments() {
  return (
    <div className="brand-ornaments" aria-hidden="true">
      <span className="bo-town" />
      {PROPS.map((item) => (
        <img
          key={item.cls}
          className={`bo-prop bo-${item.cls}`}
          src={item.src}
          alt=""
          width={96}
          height={96}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ))}
      <span className="bo-page-prop" />
      <span className="bo-light bo-light-a" />
      <span className="bo-light bo-light-b" />
    </div>
  )
}
