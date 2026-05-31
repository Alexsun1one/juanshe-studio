"use client"

import * as React from "react"
import {
  BookText,
  Cpu,
  Info,
  Palette,
  Workflow,
} from "lucide-react"

import { useT } from "@/lib/i18n"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs"
import { LLMTab } from "./tabs/llm-tab"
import { WorkflowTab } from "./tabs/workflow-tab"
import { BooksTab } from "./tabs/books-tab"
import { AppearanceTab } from "./tabs/appearance-tab"
import { AboutTab } from "./tabs/about-tab"

export function SettingsBody() {
  const t = useT()
  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <Tabs defaultValue="llm">
        <TabsList className="bg-secondary mb-6">
          <TabsTrigger value="llm">
            <Cpu className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("settings.tabs.llm")}
          </TabsTrigger>
          <TabsTrigger value="workflow">
            <Workflow className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("settings.tabs.workflow")}
          </TabsTrigger>
          <TabsTrigger value="books">
            <BookText className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("settings.tabs.books")}
          </TabsTrigger>
          <TabsTrigger value="appearance">
            <Palette className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("settings.tabs.appearance")}
          </TabsTrigger>
          <TabsTrigger value="about">
            <Info className="mr-1.5 size-3.5" strokeWidth={1.8} />
            {t("settings.tabs.about")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="llm">
          <LLMTab />
        </TabsContent>
        <TabsContent value="workflow">
          <WorkflowTab />
        </TabsContent>
        <TabsContent value="books">
          <BooksTab />
        </TabsContent>
        <TabsContent value="appearance">
          <AppearanceTab />
        </TabsContent>
        <TabsContent value="about">
          <AboutTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
