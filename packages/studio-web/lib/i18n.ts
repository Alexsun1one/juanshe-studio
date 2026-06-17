"use client"

import * as React from "react"

import { EDITORIAL_STAFF_COUNT, PIPELINE_AGENT_COUNT } from "@/lib/agent-identity"

// ----------------------------------------------------------------------
// 轻量 i18n — 不引第三方库，最小可用：dictionary + Provider + useT()
// 人数口径:编辑部对外说 EDITORIAL_STAFF_COUNT 位编辑,泳道/链路说 PIPELINE_AGENT_COUNT 条
// (常量定义见 lib/agent-identity.ts),文案里不手写 15/17,避免再打架。
// ----------------------------------------------------------------------

export type Locale = "zh-CN" | "en"

type Dict = Record<string, string>

const zh: Dict = {
  // brand
  "brand.name": "长卷写作台",
  "brand.tag": "以写作为中心的 AI 协同",

  // top bar
  "top.workspace": "默认工作区",
  "top.search": "搜索作品、章节、角色、素材…",
  "top.synced": "已同步",
  "top.justNow": "刚刚",
  "top.envHealthy": "本地创作环境 · 运行中",
  "top.notifications": "通知",
  "top.toggleTheme": "切换主题",
  "top.toggleLocale": "中 / EN",
  "top.exitFocus": "退出全屏",
  "top.enterFocus": "全屏沉浸",
  "top.collapseLeft": "收起侧栏",
  "top.collapseRight": "收起右栏",

  // stepper
  "step.new": "新建",
  "step.outline": "大纲",
  "step.write": "写作",
  "step.rewrite": "改写",
  "step.review": "审稿",
  "step.publish": "发布",
  "step.new.desc": "立项 · 设定 · 前 3 章规划",
  "step.outline.desc": "卷 / 章 / 节结构与节奏",
  "step.write.desc": "正文创作 · 续写 · 流式生成",
  "step.rewrite.desc": "对比修订 · 风格润色",
  "step.review.desc": "审稿官批注 · 一致性校验",
  "step.publish.desc": "审核通过 · 导出资料",

  // left rail
  "left.tabs.chapters": "章节",
  "left.tabs.cast": "角色",
  "left.tabs.world": "世界观",
  "left.tabs.assets": "素材",
  "left.chapters.title": "星尘邮局今晚开张",
  "left.chapters.subtitle": "长篇小说 · 第 5 章 · 连载中",
  "left.chapters.new": "新建章节",
  "left.cast.new": "新建角色",
  "left.world.new": "新建设定",
  "left.assets.new": "导入素材",

  // canvas common
  "canvas.title": "中央画布",
  "canvas.placeholder.continue": "AI 正在续写…",
  "canvas.continue": "继续创作",
  "canvas.pause": "停止生成",
  "canvas.resume": "继续生成",
  "canvas.revise": "修订",
  "canvas.write": "我来写",
  "canvas.target": "章节目标",
  "canvas.progress": "本章进度",
  "canvas.elapsed": "已运行",
  "canvas.wordsThisRun": "本次生成",
  "canvas.currentChapterWords": "当前章节字数",
  "canvas.aiWriting": "AI 写作中",
  "canvas.aiPaused": "已暂停",
  "canvas.aiIdle": "待命中",

  // new book
  "new.title": "开启一卷新长篇",
  "new.subtitle": "几个轻问题，AI 与你一起把书立起来",
  "new.bookTitle": "书名",
  "new.bookTitlePlaceholder": "起一个让人想点开的名字…",
  "new.genre": "题材",
  "new.tone": "基调",
  "new.length": "篇幅预期",
  "new.synopsis": "一句话简介",
  "new.synopsisPlaceholder": "主角是谁，遇到了什么，为何让人放不下",
  "new.protagonist": "主角设定",
  "new.world": "世界观骨架",
  "new.start": "建书并进入大纲",
  "new.aiHint": "建书复审官会同步给出风险提示与改进建议",

  // outline
  "outline.title": "卷 · 章 · 节",
  "outline.subtitle": "拖拽排序，点击展开节奏卡片",
  "outline.newChapter": "新建章节",
  "outline.act": "卷",
  "outline.beats": "节奏点",
  "outline.estWords": "预估字数",

  // rewrite
  "rewrite.original": "原文",
  "rewrite.revised": "改写",
  "rewrite.style": "风格策略",
  "rewrite.accept": "采纳改写",
  "rewrite.reject": "保留原文",
  "rewrite.styles.tighten": "收紧节奏",
  "rewrite.styles.lyric": "增强抒情",
  "rewrite.styles.dialog": "对白驱动",
  "rewrite.styles.sensory": "感官细节",

  // review
  "review.title": "审稿与一致性",
  "review.subtitle": "审稿官在文中标注问题；本页操作只做处理标记，不会自动改正文",
  "review.severity.high": "严重",
  "review.severity.med": "警告",
  "review.severity.low": "信息",
  "review.fix": "标记已处理",
  "review.ignore": "忽略",

  // publish
  "publish.title": "发布准备",
  "publish.subtitle": "这里执行章节审核通过；外部分发必须接入真实渠道出口",
  "publish.draft": "草稿",
  "publish.queue": "待校验",
  "publish.releasing": "审核通过中",
  "publish.published": "已发布",
  "publish.failed": "失败",

  // right rail
  "right.tabs.workflow": "工作流",
  "right.tabs.agents": "AI 角色",
  "right.tabs.memory": "记忆长卷",
  "right.tabs.relations": "关系图谱",
  "right.tabs.plot": "剧情推进",
  "right.tabs.knowledge": "知识图谱",
  "right.tabs.insight": "市场洞察",

  // workflow stages
  "stage.prepare": "准备",
  "stage.generate": "生成",
  "stage.review": "审稿",
  "stage.revise": "修订",
  "stage.persist": "落库",
  "stage.publish": "发布",
  "workflow.current": "当前阶段",
  "workflow.activeAgents": "在场角色",
  "workflow.totalProgress": "总进度",
  "workflow.subtitle": `${PIPELINE_AGENT_COUNT} 条泳道按调度链接力`,

  // relations
  "relations.subtitle": "从书里自动提取的角色关系",
  "relations.kind.ally": "盟友",
  "relations.kind.neutral": "中立",
  "relations.kind.rival": "对立",
  "relations.kind.subord": "从属",
  "relations.focus": "焦点角色",
  "relations.lastUpdate": "最近更新",
  "relations.version": "版本",

  // plot
  "plot.subtitle": "里程碑与张力曲线",
  "plot.tension": "张力曲线",
  "plot.milestone": "里程碑",

  "agents.running": "运行中",
  "agents.idle": "待命",
  "agents.done": "完成",
  "agents.error": "失败",
  "agents.warning": "警告",
  "agents.paused": "暂停",
  "agents.expand": "展开全部",
  "agents.collapse": "收起",
  "agents.heartbeat": "心跳",
  "agents.queued": "待命",
  "agents.task": "当前任务",
  "agents.noTask": "暂无任务",

  "memory.long": "长期记忆",
  "memory.current": "当前伏笔",
  "memory.world": "世界观提醒",
  "memory.viewMore": "查看更多记忆",

  "knowledge.title": "知识图谱",
  "knowledge.subtitle": "世界观 · 角色 · 伏笔 · 长期记忆",
  "knowledge.entities": "条知识单元",

  "insight.title": "市场洞察",
  "insight.subtitle": "热度 · 风格指纹 · 趋势",
  "insight.hot": "高潜机会",
  "insight.style": "你的风格指纹",
  "insight.trend": "趋势信号",

  // bottom dock
  "dock.speed": "写作速度",
  "dock.speed.unit": "字/分钟",
  "dock.quality": "质量评分",
  "dock.consistency": "一致性",
  "dock.adopted": "已采纳字数",
  "dock.token": "Token 消耗",
  "dock.remaining": "章节剩余目标",
  "dock.eta": "预估完成",
  "dock.expand": "展开 Dock",
  "dock.collapse": "收起 Dock",

  // common
  "common.collapse": "收起",
  "common.expand": "展开",
  "common.more": "更多",
  "common.viewAll": "查看全部",
  "common.cancel": "取消",
  "common.confirm": "确认",
  "common.status": "状态",
  "common.minute": "分钟",
  "common.minutes": "分钟",
  "common.seconds": "秒",
  "common.words": "字",
  "common.chapter": "章",
  "common.now": "刚刚",
  "common.minAgo": "分钟前",
  "common.character": "角色",

  // 多书工作区
  "workspace.switchBook": "切换作品",
  "workspace.myBooks": "我的作品",
  "workspace.newBook": "新建作品…",
  "workspace.chapter": "第",
  "workspace.runningOf": "运行中",
  "workspace.totalWords": "累计字数",
  "workspace.target": "目标",
  "workspace.quality": "质量",

  // 主导航
  "nav.studio": "工作台",
  "nav.runs": "运行台",
  "nav.agents": "编辑部成员",
  "nav.capabilities": "能力台",
  "nav.genres": "题材库",
  "nav.import": "导入台",
  "nav.detect": "检测台",
  "nav.assistant": "AI 助手",
  "nav.wiki": "知识图谱",
  "nav.settings": "设置",
  "nav.group.write": "写作",
  "nav.group.assets": "资产",
  "nav.group.ops": "运营",
  "nav.group.settings": "设置",
  "nav.search": "搜索章节、人物、设定、命令…",
  "nav.brandTagline": "本地优先 · AI 协同长篇创作",

  // 运行台
  "runs.title": "并行运行台",
  "runs.subtitle": "多本书同时自动续写 · 实时进度 · 质量阈值控制",
  "runs.newRun": "新建续写任务",
  "runs.empty.title": "还没有运行中的任务",
  "runs.empty.desc": `点击「新建续写任务」让 ${EDITORIAL_STAFF_COUNT} 位编辑接力写下去 — 达不到目标会自动改写`,
  "runs.status.running": "续写中",
  "runs.status.rewriting": "改写中",
  "runs.status.model_done": "模型完成",
  "runs.status.writing": "写作中",
  "runs.status.repairing": "复修中",
  "runs.status.accepted": "已采纳",
  "runs.status.batch-writing": "批量写作",
  "runs.status.quality-batch-repairing": "批量复修",
  "runs.status.needs-repair": "待复修",
  "runs.status.blocked": "已阻塞",
  "runs.status.unknown": "未知",
  "runs.status.paused": "已暂停",
  "runs.status.cancelled": "已终止",
  "runs.status.completed": "已完成",
  "runs.status.failed": "失败",
  "runs.status.queued": "排队",
  "runs.fromTo": "起始 → 终止",
  "runs.targetWords": "每章字数",
  "runs.targetQuality": "质量阈值",
  "runs.maxRetries": "最大改写次数",
  "runs.elapsed": "已用",
  "runs.eta": "预计剩余",
  "runs.adopted": "已采纳",
  "runs.tokens": "Token",
  "runs.retries": "改写",
  "runs.currentAgent": "当前智能体",
  "runs.recentEvents": "最近事件",
  "runs.pause": "停止",
  "runs.resume": "恢复",
  "runs.cancel": "终止",
  "runs.viewBook": "进入作品",

  // 编辑部成员
  "agents.title": "编辑部成员",
  "agents.subtitle": `给 ${EDITORIAL_STAFF_COUNT} 位编辑部成员分别调提示词、模型与发稿职责`,
  "agents.tabs.prompts": "提示词",
  "agents.tabs.workflow": "工作流",
  "agents.tabs.connectivity": "连通性",
  "agents.editor.system": "系统提示词",
  "agents.editor.user": "用户模板",
  "agents.editor.tools": "工具/MCP",
  "agents.editor.model": "模型",
  "agents.editor.temperature": "温度",
  "agents.editor.maxTokens": "最大输出",
  "agents.editor.save": "保存",
  "agents.editor.test": "试运行",
  "agents.editor.history": "版本历史",
  "agents.editor.restore": "回滚",
  "agents.connectivity.test": "测试全部",
  "agents.connectivity.testOne": "Ping",

  // Wiki
  "wiki.title": "本地 LLM Wiki",
  "wiki.subtitle": "Obsidian 风格的创作宇宙：章节 / 人物 / 伏笔 / 约束 / Agent 都是节点",
  "wiki.search": "搜索节点、双向链接、标签…",
  "wiki.kinds.chapter": "章节",
  "wiki.kinds.character": "人物",
  "wiki.kinds.setpoint": "设定 · 大纲 · 伏笔",
  "wiki.kinds.constraint": "工程约束",
  "wiki.kinds.agent": "Agent",
  "wiki.kinds.note": "笔记",
  "wiki.feed": "继续喂给…",
  "wiki.backlinks": "反向链接",

  // Settings
  "settings.title": "设置",
  "settings.tabs.llm": "LLM 配置",
  "settings.tabs.workflow": "工作流",
  "settings.tabs.books": "作品库",
  "settings.tabs.appearance": "外观",
  "settings.tabs.about": "关于",
  "settings.llm.providers": "提供商",
  "settings.llm.add": "添加 Endpoint",
  "settings.llm.test": "一键测试",
  "settings.llm.routing": "智能体模型路由",
  "settings.books.create": "新建作品",
  "settings.books.archive": "归档",
}

const en: Dict = {
  "brand.name": "Scroll Studio",
  "brand.tag": "Writing-first AI co-creation",

  "top.workspace": "Default workspace",
  "top.search": "Search works, chapters, cast, assets…",
  "top.synced": "Synced",
  "top.justNow": "just now",
  "top.envHealthy": "Local studio · running",
  "top.notifications": "Notifications",
  "top.toggleTheme": "Toggle theme",
  "top.toggleLocale": "中 / EN",
  "top.exitFocus": "Exit focus",
  "top.enterFocus": "Focus mode",
  "top.collapseLeft": "Collapse left",
  "top.collapseRight": "Collapse right",

  "step.new": "New",
  "step.outline": "Outline",
  "step.write": "Write",
  "step.rewrite": "Rewrite",
  "step.review": "Review",
  "step.publish": "Publish",
  "step.new.desc": "Setup · settings · first chapters",
  "step.outline.desc": "Acts / chapters / beats",
  "step.write.desc": "Drafting · continuation · streaming",
  "step.rewrite.desc": "Diff revision · style polish",
  "step.review.desc": "Editor notes · consistency check",
  "step.publish.desc": "Approve · export copy",

  "left.tabs.chapters": "Chapters",
  "left.tabs.cast": "Cast",
  "left.tabs.world": "World",
  "left.tabs.assets": "Assets",
  "left.chapters.title": "After the Instance Came, I Drew the Map",
  "left.chapters.subtitle": "Novel · Chapter 5 · ongoing",
  "left.chapters.new": "New chapter",
  "left.cast.new": "New character",
  "left.world.new": "New setting",
  "left.assets.new": "Import asset",

  "canvas.title": "Canvas",
  "canvas.placeholder.continue": "AI is continuing…",
  "canvas.continue": "Continue",
  "canvas.pause": "Stop",
  "canvas.resume": "Resume",
  "canvas.revise": "Revise",
  "canvas.write": "I'll write",
  "canvas.target": "Chapter target",
  "canvas.progress": "Chapter progress",
  "canvas.elapsed": "Elapsed",
  "canvas.wordsThisRun": "This run",
  "canvas.currentChapterWords": "Current chapter words",
  "canvas.aiWriting": "AI writing",
  "canvas.aiPaused": "Paused",
  "canvas.aiIdle": "Standby",

  "new.title": "Start a new long-form work",
  "new.subtitle": "A few light questions to set the book up together",
  "new.bookTitle": "Title",
  "new.bookTitlePlaceholder": "A title that begs to be opened…",
  "new.genre": "Genre",
  "new.tone": "Tone",
  "new.length": "Length",
  "new.synopsis": "One-line pitch",
  "new.synopsisPlaceholder": "Who, what they meet, why we can't put it down",
  "new.protagonist": "Protagonist",
  "new.world": "World skeleton",
  "new.start": "Create & open outline",
  "new.aiHint": "The setup auditor will surface risks and suggestions",

  "outline.title": "Acts · Chapters · Beats",
  "outline.subtitle": "Drag to reorder, click to expand beats",
  "outline.newChapter": "New chapter",
  "outline.act": "Act",
  "outline.beats": "Beats",
  "outline.estWords": "Est. words",

  "rewrite.original": "Original",
  "rewrite.revised": "Revised",
  "rewrite.style": "Style",
  "rewrite.accept": "Accept",
  "rewrite.reject": "Keep original",
  "rewrite.styles.tighten": "Tighten pace",
  "rewrite.styles.lyric": "More lyrical",
  "rewrite.styles.dialog": "Dialogue-driven",
  "rewrite.styles.sensory": "Sensory detail",

  "review.title": "Review & consistency",
  "review.subtitle": "Editor flags issues; actions here only mark items and do not edit the manuscript",
  "review.severity.high": "Critical",
  "review.severity.med": "Warning",
  "review.severity.low": "Info",
  "review.fix": "Mark handled",
  "review.ignore": "Ignore",

  "publish.title": "Publish prep",
  "publish.subtitle": "Approve chapters here; external distribution still needs a real channel",
  "publish.draft": "Draft",
  "publish.queue": "Queued",
  "publish.releasing": "Approving",
  "publish.published": "Published",
  "publish.failed": "Failed",

  "right.tabs.workflow": "Workflow",
  "right.tabs.agents": "Agents",
  "right.tabs.memory": "Memory",
  "right.tabs.relations": "Relations",
  "right.tabs.plot": "Plot",
  "right.tabs.knowledge": "Knowledge",
  "right.tabs.insight": "Insight",

  "stage.prepare": "Prepare",
  "stage.generate": "Generate",
  "stage.review": "Review",
  "stage.revise": "Revise",
  "stage.persist": "Persist",
  "stage.publish": "Publish",
  "workflow.current": "Current stage",
  "workflow.activeAgents": "Active agents",
  "workflow.totalProgress": "Total progress",
  "workflow.subtitle": `${PIPELINE_AGENT_COUNT} lanes along the dispatch chain`,

  "relations.subtitle": "Auto-extracted from the manuscript",
  "relations.kind.ally": "Ally",
  "relations.kind.neutral": "Neutral",
  "relations.kind.rival": "Rival",
  "relations.kind.subord": "Subord",
  "relations.focus": "Focus",
  "relations.lastUpdate": "Updated",
  "relations.version": "Version",

  "plot.subtitle": "Milestones & tension curve",
  "plot.tension": "Tension",
  "plot.milestone": "Milestone",

  "agents.running": "running",
  "agents.idle": "idle",
  "agents.done": "done",
  "agents.error": "failed",
  "agents.warning": "warning",
  "agents.paused": "paused",
  "agents.expand": "Expand all",
  "agents.collapse": "Collapse",
  "agents.heartbeat": "Heartbeat",
  "agents.queued": "Queued",
  "agents.task": "Current task",
  "agents.noTask": "No task",

  "memory.long": "Long-term",
  "memory.current": "Current threads",
  "memory.world": "World reminders",
  "memory.viewMore": "More memories",

  "knowledge.title": "Knowledge graph",
  "knowledge.subtitle": "World · cast · threads · memory",
  "knowledge.entities": "units",

  "insight.title": "Market insight",
  "insight.subtitle": "Heat · style fingerprint · trends",
  "insight.hot": "Hot opportunities",
  "insight.style": "Your style fingerprint",
  "insight.trend": "Trend signals",

  "dock.speed": "Speed",
  "dock.speed.unit": "wpm",
  "dock.quality": "Quality",
  "dock.consistency": "Consistency",
  "dock.adopted": "Words adopted",
  "dock.token": "Tokens used",
  "dock.remaining": "Remaining target",
  "dock.eta": "ETA",
  "dock.expand": "Expand dock",
  "dock.collapse": "Collapse dock",

  "common.collapse": "Collapse",
  "common.expand": "Expand",
  "common.more": "More",
  "common.viewAll": "View all",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.status": "Status",
  "common.minute": "min",
  "common.minutes": "min",
  "common.seconds": "s",
  "common.words": "words",
  "common.chapter": "Ch.",
  "common.now": "now",
  "common.minAgo": "min ago",
  "common.character": "char",

  "workspace.switchBook": "Switch book",
  "workspace.myBooks": "My books",
  "workspace.newBook": "New book…",
  "workspace.chapter": "Ch.",
  "workspace.runningOf": "running",
  "workspace.totalWords": "Total",
  "workspace.target": "Target",
  "workspace.quality": "Quality",

  "nav.studio": "Studio",
  "nav.runs": "Runs",
  "nav.agents": "Editorial Members",
  "nav.capabilities": "Capabilities",
  "nav.genres": "Genres",
  "nav.import": "Import",
  "nav.detect": "Detect",
  "nav.assistant": "Assistant",
  "nav.wiki": "Wiki",
  "nav.settings": "Settings",
  "nav.group.write": "Write",
  "nav.group.assets": "Assets",
  "nav.group.ops": "Operations",
  "nav.group.settings": "Settings",
  "nav.search": "Search chapters, characters, lore, commands…",
  "nav.brandTagline": "Local-first · AI co-writing studio",

  "runs.title": "Parallel Runs",
  "runs.subtitle": "Auto-continue multiple books in parallel · realtime progress · quality-gated rewrite",
  "runs.newRun": "New auto-run",
  "runs.empty.title": "No active runs",
  "runs.empty.desc": `Click "New auto-run" to let the ${EDITORIAL_STAFF_COUNT}-editor chain keep writing — it will rewrite until quality is met.`,
  "runs.status.running": "Writing",
  "runs.status.rewriting": "Rewriting",
  "runs.status.model_done": "Model done",
  "runs.status.writing": "Writing",
  "runs.status.repairing": "Repairing",
  "runs.status.accepted": "Accepted",
  "runs.status.batch-writing": "Batch writing",
  "runs.status.quality-batch-repairing": "Batch repair",
  "runs.status.needs-repair": "Needs repair",
  "runs.status.blocked": "Blocked",
  "runs.status.unknown": "Unknown",
  "runs.status.paused": "Paused",
  "runs.status.cancelled": "Cancelled",
  "runs.status.completed": "Done",
  "runs.status.failed": "Failed",
  "runs.status.queued": "Queued",
  "runs.fromTo": "From → To",
  "runs.targetWords": "Words / chapter",
  "runs.targetQuality": "Quality gate",
  "runs.maxRetries": "Max rewrites",
  "runs.elapsed": "Elapsed",
  "runs.eta": "ETA",
  "runs.adopted": "Adopted",
  "runs.tokens": "Tokens",
  "runs.retries": "Rewrites",
  "runs.currentAgent": "Current agent",
  "runs.recentEvents": "Recent events",
  "runs.pause": "Stop",
  "runs.resume": "Resume",
  "runs.cancel": "Cancel",
  "runs.viewBook": "Open book",

  "agents.title": "Editorial Members",
  "agents.subtitle": `Tune prompts, models and publishing duties for all ${EDITORIAL_STAFF_COUNT} editorial members`,
  "agents.tabs.prompts": "Prompts",
  "agents.tabs.workflow": "Workflow",
  "agents.tabs.connectivity": "Connectivity",
  "agents.editor.system": "System prompt",
  "agents.editor.user": "User template",
  "agents.editor.tools": "Tools / MCP",
  "agents.editor.model": "Model",
  "agents.editor.temperature": "Temperature",
  "agents.editor.maxTokens": "Max tokens",
  "agents.editor.save": "Save",
  "agents.editor.test": "Test run",
  "agents.editor.history": "History",
  "agents.editor.restore": "Restore",
  "agents.connectivity.test": "Test all",
  "agents.connectivity.testOne": "Ping",

  "wiki.title": "Local LLM Wiki",
  "wiki.subtitle": "Obsidian-style creative universe: chapters, characters, set-ups, constraints and agents as nodes",
  "wiki.search": "Search nodes, backlinks, tags…",
  "wiki.kinds.chapter": "Chapter",
  "wiki.kinds.character": "Character",
  "wiki.kinds.setpoint": "Premise · Outline · Hooks",
  "wiki.kinds.constraint": "Constraint",
  "wiki.kinds.agent": "Agent",
  "wiki.kinds.note": "Note",
  "wiki.feed": "Feed into…",
  "wiki.backlinks": "Backlinks",

  "settings.title": "Settings",
  "settings.tabs.llm": "LLM",
  "settings.tabs.workflow": "Workflow",
  "settings.tabs.books": "Books",
  "settings.tabs.appearance": "Appearance",
  "settings.tabs.about": "About",
  "settings.llm.providers": "Providers",
  "settings.llm.add": "Add endpoint",
  "settings.llm.test": "Test all",
  "settings.llm.routing": "Agent → model routing",
  "settings.books.create": "New book",
  "settings.books.archive": "Archive",
}

const dictionaries: Record<Locale, Dict> = { "zh-CN": zh, en }

type LocaleCtx = {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string) => string
}

const Ctx = React.createContext<LocaleCtx | null>(null)

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<Locale>("zh-CN")

  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem("scroll-studio-locale") as Locale | null
      if (saved === "zh-CN" || saved === "en") setLocaleState(saved)
    } catch { /* localStorage unavailable in private browsing */ }
  }, [])

  const setLocale = React.useCallback((l: Locale) => {
    setLocaleState(l)
    try {
      window.localStorage.setItem("scroll-studio-locale", l)
    } catch { /* localStorage unavailable in private browsing */ }
  }, [])

  const t = React.useCallback(
    (key: string) => {
      const d = dictionaries[locale]
      return d[key] ?? dictionaries["zh-CN"][key] ?? key
    },
    [locale],
  )

  const value = React.useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return React.createElement(Ctx.Provider, { value }, children)
}

export function useLocale() {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider")
  return ctx
}

export function useT() {
  return useLocale().t
}
