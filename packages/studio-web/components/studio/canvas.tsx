"use client"

import * as React from "react"
import { useStudio } from "@/lib/studio-context"
import { WriteMode } from "@/components/studio/modes/write-mode"
import { NewBookMode } from "@/components/studio/modes/new-book-mode"
import { OutlineMode } from "@/components/studio/modes/outline-mode"
import { RewriteMode } from "@/components/studio/modes/rewrite-mode"
import { ReviewMode } from "@/components/studio/modes/review-mode"
import { PublishMode } from "@/components/studio/modes/publish-mode"

export function Canvas() {
  const { mode } = useStudio()

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
      <div className="flex min-h-0 flex-1 flex-col">
        {mode === "new" && <NewBookMode />}
        {mode === "outline" && <OutlineMode />}
        {mode === "write" && <WriteMode />}
        {mode === "rewrite" && <RewriteMode />}
        {mode === "review" && <ReviewMode />}
        {mode === "publish" && <PublishMode />}
      </div>
    </main>
  )
}
