"use client"

import { Network } from "lucide-react"

export function WikiHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle: string
}) {
  return (
    <header className="border-border from-background to-background/80 border-b bg-gradient-to-b px-6 py-5 md:px-10">
      <div className="mx-auto flex max-w-[1600px] items-center gap-3">
        <div className="bg-primary/10 ring-primary/20 flex size-9 items-center justify-center rounded-xl ring-1">
          <Network className="text-primary size-4" strokeWidth={1.7} />
        </div>
        <div className="flex min-w-0 flex-col leading-tight">
          <h1 className="text-base font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-[11px]">{subtitle}</p>
        </div>
      </div>
    </header>
  )
}
