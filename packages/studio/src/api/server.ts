// @ts-nocheck
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { StateManager, PipelineRunner, ConsolidatorAgent, MemoryDB, createLLMClient, createLogger, createInteractionToolsFromDeps, computeAnalytics, loadProjectConfig, loadProjectSession, processProjectInteractionRequest, resolveSessionActiveBook, listBookSessions, loadBookSession, appendManualSessionMessages, createAndPersistBookSession, renameBookSession, deleteBookSession, migrateBookSession, SessionAlreadyMigratedError, runAgentSession, buildAgentSystemPrompt, resolveServicePreset, resolveServiceProviderFamily, resolveServiceModelsBaseUrl, resolveServiceModel, loadSecrets, saveSecrets, listModelsForService, isApiKeyOptionalForEndpoint, getAllEndpoints, probeModelsFromUpstream, fetchWithProxy, chatCompletion, buildExportArtifact, GLOBAL_ENV_PATH, markdownToContentDocument, renderForPlatform, getContentTypeProfile, assembleContentType, buildWritingSystemPrompt, mountSkills, buildCriticSystemPrompt, buildReviserSystemPrompt, parseCritiqueReport, critiqueWantsRevision, critiquePasses, buildResearchQueries, buildResearchContext, emptyAccountStyle, evolveStyleProfile, buildAccountVoicePrompt, parseCharacterMatrix, parseRoleFile, parseEmotionalArcs, groupArcsByCharacter, tensionByChapter, parsePendingHooks, parseSubplotBoard, hooksByStartChapter, parseVolumeMap, parseChapterSummaries, appearanceCounts, parseStoryFrame, buildGovernanceRecommendation, analyzeStyle, EDITOR_IN_CHIEF_SYSTEM_PROMPT, buildEditorInChiefUserMessage, parseEditorialVerdict, listWechatTemplates, DEFAULT_WECHAT_TEMPLATE, analyzeAITells, aiToneScore, DEFAULT_AI_TONE_FLOOR, } from "@juanshe/core";
import { access, appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
// 卷舍写作引擎(@juanshe/engine)接线:Step 3 经验库 learnings(LLM-free 记录/检索)
import { RecordInput } from "@juanshe/engine";
import { recordChapterLearning, retrieveChapterLearnings, loadLearningLibrary, writeChapterViaEngine, runBookViaEngine, cleanChapterText } from "./engine-bridge.js";
import { fileURLToPath } from "node:url";
import { isSafeBookId } from "./safety.js";
import { ApiError } from "./errors.js";
import { buildStudioBookConfig } from "./book-create.js";
// Skill Registry 落点:repo 根 skills/(相对本文件 packages/studio/src/api/ 上溯 4 层)。
// 不存在时 assembleContentType 会优雅降级为「无技能」,不崩。
const SKILLS_DIR = fileURLToPath(new URL("../../../../skills", import.meta.url));
// 自带搜索:DeepSeek 等聊天模型不会替这条后端链路自动联网;这里调外部搜索 API 增料。
// 网关:优先配 JUANSHE_SEARCH_API_KEY,兼容 HARDWRITE_SEARCH_API_KEY/TAVILY_API_KEY;未配则返回空 → 文章照常生成,只是不联网增料。
async function runWebResearch(queries) {
    const key = process.env.JUANSHE_SEARCH_API_KEY || process.env.HARDWRITE_SEARCH_API_KEY || process.env.TAVILY_API_KEY;
    if (!key || !Array.isArray(queries) || queries.length === 0)
        return [];
    const provider = (process.env.JUANSHE_SEARCH_PROVIDER || process.env.HARDWRITE_SEARCH_PROVIDER || "tavily").toLowerCase();
    const findings = [];
    for (const q of queries.slice(0, 2)) {
        try {
            if (provider === "tavily") {
                const res = await fetchWithProxy("https://api.tavily.com/search", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ api_key: key, query: q, max_results: 4, search_depth: "basic" }),
                });
                if (!res.ok)
                    continue;
                const data = await res.json();
                for (const r of (data?.results ?? [])) {
                    findings.push({
                        title: String(r.title ?? ""),
                        snippet: String(r.content ?? "").replace(/\s+/g, " ").slice(0, 300),
                        url: String(r.url ?? ""),
                    });
                }
            }
        }
        catch { /* 单条检索失败不影响整体 */ }
    }
    const seen = new Set();
    return findings.filter((f) => f.url && !seen.has(f.url) && (seen.add(f.url), true)).slice(0, 8);
}
// 账号风格画像持久化(长期定义 + 自我进化):存于 <root>/.autow/account-styles/<id>.json(运行时数据)。
async function loadAccountStyle(root, id) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) return emptyAccountStyle(String(id));
    try {
        const raw = await readFile(join(root, ".autow", "account-styles", `${id}.json`), "utf-8");
        const p = JSON.parse(raw);
        return { ...emptyAccountStyle(String(id)), ...p, id: String(id) };
    }
    catch {
        return emptyAccountStyle(String(id));
    }
}
async function saveAccountStyle(root, id, profile) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) return;
    const dir = join(root, ".autow", "account-styles");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), JSON.stringify(profile, null, 2), "utf-8");
}
// -- Pipeline stage definitions per agent type --
const PIPELINE_STAGES = {
    writer: [
        "规划下一章意图", "组装章节运行时上下文", "准备章节输入",
        "撰写章节草稿", "审计草稿", "修复轮次", "文字层润色",
        "润色后复审", "落盘最终章节", "生成最终真相文件",
        "校验真相文件变更", "生成章节质量报告", "同步记忆索引",
        "更新章节索引与快照",
    ],
    architect: [
        "生成基础设定", "保存书籍配置", "写入基础设定文件",
        "初始化控制文档", "提取原作风格指纹", "创建初始快照",
    ],
    reviser: [
        "加载修订上下文", "修订章节", "落盘修订结果",
        "更新索引与快照",
    ],
    auditor: ["审计章节", "复审润色结果"],
};
const AGENT_LABELS = {
    "managing-editor": "执行主编", architect: "架构师", "foundation-reviewer": "建书复审官", writer: "写手", auditor: "审稿官",
    reviser: "修稿师", polisher: "润色师", "state-validator": "状态校验员",
    "style-governor": "风格指纹官", "quality-reporter": "质量报告官", "editor-in-chief": "总编",
    "reader-critic": "读者评审官", "chapter-analyzer": "章节分析官", "length-normalizer": "字数治理官",
    planner: "规划师", exporter: "导出官", "prompt-governor": "提示词治理官", radar: "市场雷达",
};
const PRIMARY_AGENT_FLOW_SIZE = 17;
const AGENT_ROSTER = [
    { id: "managing-editor", label: "执行主编", when: "贯穿全流程", ai: "确定性编排(pipeline runner)", entersOn: ["编排工作流", "决定下一步调哪个 Agent", "管理返工循环与人审节点"], produces: ["agent_handoffs", "rework_loop_state", "run_timeline"], handoffTo: "all agents" },
    { id: "radar", label: "市场雷达", when: "建书/定位/简介/轻任务", ai: "LLM", entersOn: ["扫描平台趋势", "生成网站书籍介绍"], produces: ["market_signals", "book_description", "positioning_notes"], handoffTo: "architect/planner" },
    { id: "architect", label: "架构师", when: "建书/重构世界观", ai: "LLM", entersOn: ["创建作品", "重建故事圣经"], produces: ["story_frame", "volume_map", "character_matrix", "pending_hooks"], handoffTo: "foundation-reviewer" },
    { id: "foundation-reviewer", label: "建书复审官", when: "建书后/长期设定变更后", ai: "LLM", entersOn: ["复审 story_frame", "复审 volume_map"], produces: ["foundation_review", "blocking_gaps"], handoffTo: "planner" },
    { id: "planner", label: "规划师", when: "写作前", ai: "LLM", entersOn: ["规划下一章意图", "组装章节运行时上下文"], produces: ["chapter_intent", "context_package", "rule_stack"], handoffTo: "writer" },
    { id: "writer", label: "写手", when: "正文生成", ai: "LLM", entersOn: ["准备章节输入", "撰写章节草稿"], produces: ["chapter_draft", "draft_truth_delta"], handoffTo: "auditor" },
    { id: "auditor", label: "审稿官", when: "草稿后与润色后", ai: "LLM + deterministic checks", entersOn: ["审计草稿", "润色后复审"], produces: ["audit_result", "issue_list", "score"], handoffTo: "reviser" },
    { id: "reviser", label: "修稿师", when: "审计不达标", ai: "LLM", entersOn: ["修复轮次"], produces: ["revised_chapter", "fixed_issues"], handoffTo: "auditor" },
    { id: "length-normalizer", label: "字数治理官", when: "字数偏离目标", ai: "LLM + counters", entersOn: ["修复轮次"], produces: ["length_telemetry", "normalized_chapter"], handoffTo: "polisher" },
    { id: "polisher", label: "文字润色师", when: "结构审计通过后", ai: "LLM", entersOn: ["文字层润色"], produces: ["polished_chapter"], handoffTo: "auditor" },
    { id: "chapter-analyzer", label: "章节分析官", when: "章节落库后", ai: "LLM", entersOn: ["抽取章节事实", "更新长期记忆"], produces: ["chapter_summary", "state_delta", "wiki_candidates"], handoffTo: "state-validator" },
    { id: "state-validator", label: "状态校验员", when: "真相文件落盘前", ai: "LLM + deterministic validators", entersOn: ["校验真相文件变更"], produces: ["truth_validation", "failure_attribution"], handoffTo: "style-governor" },
    { id: "style-governor", label: "风格指纹官", when: "建书/续写/每章报告", ai: "LLM + stylistic metrics", entersOn: ["提取原作风格指纹", "生成章节质量报告"], produces: ["style_fingerprint", "style_adherence"], handoffTo: "quality-reporter" },
    { id: "reader-critic", label: "读者评审官", when: "每章 Gate 前", ai: "deterministic reader signals + optional LLM", entersOn: ["生成章节质量报告", "质量 Gate"], produces: ["reader_score", "confusion_points", "read_on_intent"], handoffTo: "quality-reporter" },
    { id: "quality-reporter", label: "质量报告官", when: "每章结束", ai: "deterministic report", entersOn: ["生成章节质量报告", "更新章节索引与快照"], produces: ["chapter_quality_report.md", "chapter_quality_report.json"], handoffTo: "editor-in-chief" },
    { id: "editor-in-chief", label: "总编", when: "整章成稿后 / 质量 Gate", ai: "LLM + 确定性信号", entersOn: ["整章编辑裁决", "签发或返工", "给规划师下一程方向"], produces: ["editorial_verdict", "总编批语", "next_direction"], handoffTo: "planner/reviser/human" },
    { id: "prompt-governor", label: "提示词治理官", when: "每轮失败/复修/阶段性总结后", ai: "LLM + deterministic compression", entersOn: ["读取失败日志", "读取 Wiki 与质量报告", "压缩角色提示词"], produces: ["prompt_governance.md", "agentProfiles patch", "pitfall_digest"], handoffTo: "all agents" },
];
const AGENT_TASK_FLOWS = {
    "create-book": {
        label: "新建书主链路",
        description: "开书先定位市场与平台承诺，再建故事地基、复审长期风险，最后落风格和质量资产。",
        agents: ["radar", "architect", "foundation-reviewer", "style-governor", "quality-reporter", "prompt-governor"],
    },
    "continue-writing": {
        label: "续写章节主链路",
        description: "续写以章节生产为主，规划、写作、审稿、修稿、字数治理、润色、复审、落库、校验、读者 Gate 与报告闭环。",
        agents: ["planner", "writer", "auditor", "reviser", "length-normalizer", "polisher", "auditor", "chapter-analyzer", "state-validator", "style-governor", "reader-critic", "quality-reporter", "prompt-governor"],
        allowRepeats: ["auditor"],
    },
    "book-ai-edit": {
        label: "本书 AI 改写链路",
        description: "AI 改写先理解修改意图，再修订、复审、校验状态与质量，最后把经验沉淀到提示词治理。",
        agents: ["planner", "reviser", "auditor", "state-validator", "quality-reporter", "prompt-governor"],
    },
    "selection-polish": {
        label: "选中文本润色链路",
        description: "局部润色只启用语言层、审稿和质量记录，不误触完整章节生产。",
        agents: ["polisher", "auditor", "quality-reporter"],
    },
    "quality-repair": {
        label: "低分复修链路",
        description: "低分章节从质量报告定位问题，进入修稿、字数治理、润色、复审和再次报告。",
        agents: ["quality-reporter", "reviser", "length-normalizer", "polisher", "auditor", "reader-critic", "quality-reporter", "prompt-governor"],
        allowRepeats: ["quality-reporter"],
    },
    "state-repair": {
        label: "状态自愈链路",
        description: "状态异常时只跑章节分析、真相校验和质量记录，避免误生成新正文。",
        agents: ["chapter-analyzer", "state-validator", "quality-reporter", "prompt-governor"],
    },
    "prompt-governance": {
        label: "提示词治理链路",
        description: "失败经验和质量报告沉淀时，只启用提示词治理与报告角色。",
        agents: ["prompt-governor", "quality-reporter"],
    },
};
const AGENT_FLOW = AGENT_ROSTER;
const AGENT_IDS = new Set(AGENT_ROSTER.map((agent) => agent.id));
const FRONTEND_AGENT_ALIASES = {
    "market-radar": "radar",
    "setup-auditor": "foundation-reviewer",
    editor: "auditor",
    "state-verifier": "state-validator",
    "style-fingerprint": "style-governor",
    "quality-report": "quality-reporter",
    "word-steward": "length-normalizer",
    "prompt-steward": "prompt-governor",
};
function resolveBackendAgentId(id) {
    const raw = String(id || "").replace(/^book-/, "");
    return FRONTEND_AGENT_ALIASES[raw] || raw;
}
const WORKFLOW_STAGE_DEFS = [
    { id: "prepare", label: "准备阶段", bookStatus: "初始化准备", chapterStatus: "草稿", agents: ["managing-editor", "radar", "architect", "foundation-reviewer"] },
    { id: "generate", label: "生成阶段", bookStatus: "生成进行中", chapterStatus: "生成中", agents: ["planner", "writer"] },
    { id: "review", label: "审稿阶段", bookStatus: "审稿中", chapterStatus: "AI审稿", agents: ["auditor", "reviser"] },
    { id: "revise", label: "修订阶段", bookStatus: "修订中", chapterStatus: "AI润色", agents: ["length-normalizer", "polisher", "chapter-analyzer"] },
    { id: "archive", label: "落库阶段", bookStatus: "入库完成", chapterStatus: "质量检查", agents: ["state-validator", "style-governor"] },
    { id: "publish", label: "发布阶段", bookStatus: "发布/导出", chapterStatus: "上线/已发布", agents: ["reader-critic", "quality-reporter", "editor-in-chief", "prompt-governor"] },
];
const WORKFLOW_STAGE_BY_ID = new Map(WORKFLOW_STAGE_DEFS.map((stage) => [stage.id, stage]));
const WORKFLOW_STAGE_BY_AGENT = new Map(WORKFLOW_STAGE_DEFS.flatMap((stage) => stage.agents.map((agentId) => [agentId, stage])));
const WORKFLOW_AGENT_TASK = new Map(AGENT_ROSTER.map((agent) => [agent.id, agent.when || "待命"]));
const CHAPTER_STATUS_TO_WORKFLOW_STAGE = new Map([
    ["draft", "prepare"],
    ["queued", "generate"],
    ["writing", "generate"],
    ["generating", "generate"],
    ["generated", "review"],
    ["audit-failed", "review"],
    ["needs-repair", "review"],
    ["ready-for-review", "review"],
    ["approved", "publish"],
    ["published", "publish"],
    ["state-degraded", "archive"],
    ["草稿", "prepare"],
    ["生成中", "generate"],
    ["AI审稿", "review"],
    ["待审人审", "review"],
    ["AI润色", "revise"],
    ["质量检查", "archive"],
    ["上线/已发布", "publish"],
]);
const WORKFLOW_EVENT_TO_STAGE = [
    [/book:creating|book:created|foundation|radar|architect/i, "prepare"],
    [/write:start|write:queued|batch:start|draft:start|llm:progress/i, "generate"],
    [/audit|needs-repair|blocked-quality-gate/i, "review"],
    [/repair|revise|polish/i, "revise"],
    [/state|validator|style|quality-gate/i, "archive"],
    [/complete|approve|publish|export/i, "publish"],
];
function workflowRuntimeFile(root, bookId) {
    return join(root, ".hardwrite", "workflow-state", `${bookId}.json`);
}
function promptInjectionFile(root, bookId) {
    return join(root, ".hardwrite", "prompt-injections", `${bookId}.json`);
}
async function readWorkflowRuntimeState(root, bookId) {
    if (!isSafeBookId(bookId))
        return {};
    try {
        return JSON.parse(await readFile(workflowRuntimeFile(root, bookId), "utf-8"));
    }
    catch {
        return {};
    }
}
async function writeWorkflowRuntimeState(root, bookId, patch = {}) {
    const previous = await readWorkflowRuntimeState(root, bookId);
    const next = {
        ...previous,
        ...patch,
        chapterOverrides: {
            ...(previous.chapterOverrides || {}),
            ...(patch.chapterOverrides || {}),
        },
        updatedAt: new Date().toISOString(),
    };
    const file = workflowRuntimeFile(root, bookId);
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(next, null, 2)); // 原子写:崩溃/磁盘满不截断
    return next;
}
async function readPromptInjections(root, bookId) {
    if (!isSafeBookId(bookId))
        return [];
    try {
        const parsed = JSON.parse(await readFile(promptInjectionFile(root, bookId), "utf-8"));
        return Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
async function writePromptInjections(root, bookId, items) {
    const file = promptInjectionFile(root, bookId);
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify({ bookId, items, updatedAt: new Date().toISOString() }, null, 2)); // 原子写
    return items;
}
function makePromptInjectionId() {
    return `pinj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function normalizePromptInjectionScope(scope) {
    const raw = String(scope || "").trim().toLowerCase();
    return ["book", "global", "chapter", "selection", "agent"].includes(raw) ? raw : "book";
}
function normalizePromptInjectionStatus(status) {
    const raw = String(status || "").trim().toLowerCase();
    return ["active", "paused", "expired"].includes(raw) ? raw : "active";
}
function limitPromptInjectionText(text) {
    return String(text || "").replace(/\0/g, "").trim().slice(0, 8000);
}
function normalizePromptInjectionExpiresAt(input) {
    if (!input)
        return "";
    const timestamp = new Date(input).getTime();
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}
function publicPromptInjection(item) {
    return {
        id: item.id,
        bookId: item.bookId,
        scope: item.scope,
        status: item.status,
        title: item.title || "",
        text: item.text || item.instruction || "",
        priority: Number(item.priority || 50),
        agent: item.agent || item.agentId || item.target?.agent || "",
        chapterNumber: Number(item.chapterNumber || item.target?.chapterNumber || 0) || undefined,
        target: item.target || {},
        expiresAt: item.expiresAt || "",
        reason: item.reason || "",
        createdAt: item.createdAt || "",
        updatedAt: item.updatedAt || "",
    };
}
function promptInjectionIsActive(item, now = Date.now()) {
    if (normalizePromptInjectionStatus(item.status) !== "active")
        return false;
    if (item.expiresAt) {
        const expiresAt = new Date(item.expiresAt).getTime();
        if (Number.isFinite(expiresAt) && expiresAt <= now)
            return false;
    }
    return Boolean(limitPromptInjectionText(item.text || item.instruction));
}
function promptInjectionAppliesToContext(item, context = {}) {
    if (!promptInjectionIsActive(item))
        return false;
    const target = item.target || {};
    const itemChapter = Number(item.chapterNumber || target.chapterNumber || 0) || 0;
    const contextChapter = Number(context.chapterNumber || 0) || 0;
    if (contextChapter && itemChapter && itemChapter !== contextChapter)
        return false;
    const itemAgent = String(item.agent || item.agentId || target.agent || target.agentId || "").trim();
    const contextAgent = String(context.agent || context.agentId || "").trim();
    if (contextAgent && itemAgent && itemAgent !== contextAgent)
        return false;
    return true;
}
async function activePromptInjections(root, bookId, context = {}) {
    const items = await readPromptInjections(root, bookId);
    return items
        .map(publicPromptInjection)
        .filter((item) => promptInjectionAppliesToContext(item, context))
        .sort((a, b) => Number(b.priority || 50) - Number(a.priority || 50) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}
function describePromptInjectionTarget(item) {
    const parts = [];
    if (item.chapterNumber)
        parts.push(`chapter=${item.chapterNumber}`);
    if (item.agent)
        parts.push(`agent=${item.agent}`);
    if (item.target?.startText || item.target?.endText)
        parts.push(`range=${[item.target.startText, item.target.endText].filter(Boolean).join(" -> ").slice(0, 160)}`);
    if (item.target?.quote)
        parts.push(`quote=${String(item.target.quote).slice(0, 160)}`);
    return parts.join("; ") || "whole book";
}
function renderPromptInjectionBlock(items) {
    if (!items.length)
        return "";
    return [
        "## 运行时临时提示词注入（最高优先级）",
        "这些指令来自 Studio 的临时注入层。只在目标范围内生效；必须保护既有正文、真相文件、时间线、人物状态和用户资产。",
        ...items.map((item, index) => [
            `### 注入 ${index + 1}: ${item.title || item.id}`,
            `- scope: ${item.scope}`,
            `- target: ${describePromptInjectionTarget(item)}`,
            `- priority: ${Number(item.priority || 50)}`,
            item.expiresAt ? `- expiresAt: ${item.expiresAt}` : "",
            limitPromptInjectionText(item.text),
        ].filter(Boolean).join("\n")),
    ].join("\n\n");
}
async function composeRuntimePromptInstruction(root, bookId, context = {}, instruction = "") {
    const injections = await activePromptInjections(root, bookId, context);
    const block = renderPromptInjectionBlock(injections);
    const base = limitPromptInjectionText(instruction);
    return block ? `${block}\n\n## 本次用户指令\n${base || "按当前工作流继续推进。"}` : base;
}
function normalizeWorkflowStage(input, fallback = "prepare") {
    const raw = String(input || "").trim();
    if (!raw)
        return WORKFLOW_STAGE_BY_ID.get(fallback) || WORKFLOW_STAGE_DEFS[0];
    const normalized = raw.toLowerCase();
    return WORKFLOW_STAGE_DEFS.find((stage) => stage.id === normalized || stage.label === raw || stage.bookStatus === raw || stage.chapterStatus === raw)
        || WORKFLOW_STAGE_BY_ID.get(fallback)
        || WORKFLOW_STAGE_DEFS[0];
}
function workflowStageForEvent(event) {
    const raw = String(event || "");
    const match = WORKFLOW_EVENT_TO_STAGE.find(([pattern]) => pattern.test(raw));
    return match ? WORKFLOW_STAGE_BY_ID.get(match[1]) : null;
}
function workflowAgentLabel(agentId) {
    return AGENT_LABELS[agentId] || AGENT_ROSTER.find((agent) => agent.id === agentId)?.label || agentId || "系统";
}
function workflowAgentStatus(agentId, stage, activeAgent, activeRunStatus, completedAgentIds, errorAgentIds) {
    if (errorAgentIds.has(agentId))
        return "错误";
    if (agentId === activeAgent && ["queued", "running", "repairing"].includes(String(activeRunStatus || "")))
        return "运行中";
    if (completedAgentIds.has(agentId))
        return "已完成";
    const stageIndex = WORKFLOW_STAGE_DEFS.findIndex((item) => item.id === stage.id);
    const agentStageIndex = WORKFLOW_STAGE_DEFS.findIndex((item) => item.agents.includes(agentId));
    if (agentStageIndex >= 0 && agentStageIndex < stageIndex)
        return "已完成";
    return "待命";
}
function workflowChapterDisplayStatus(rawStatus, stage) {
    if (!rawStatus)
        return stage.chapterStatus;
    if (CHAPTER_STATUS_TO_WORKFLOW_STAGE.has(String(rawStatus)))
        return normalizeWorkflowStage(CHAPTER_STATUS_TO_WORKFLOW_STAGE.get(String(rawStatus))).chapterStatus;
    return String(rawStatus);
}
function filterActivityForBook(entries, bookId, since) {
    const sinceTime = since ? new Date(since).getTime() : 0;
    return entries.filter((entry) => {
        const data = entry?.data || {};
        const matchesBook = !bookId || data.bookId === bookId || entry.bookId === bookId;
        if (!matchesBook)
            return false;
        if (!sinceTime)
            return true;
        const time = new Date(entry.timestamp || entry.time || 0).getTime();
        return Number.isFinite(time) && time > sinceTime;
    });
}
function agentEventFromActivity(entry) {
    const data = entry?.data || {};
    const roleId = data.agent || data.currentAgent || data.role || "";
    return {
        time: entry.timestamp || entry.time || "",
        role: data.agentLabel || workflowAgentLabel(roleId),
        roleId,
        type: data.stage || data.message || entry.summary || entry.event || "状态更新",
        content: data.text || data.output || data.detail || data.failureReason || data.error || entry.summary || "",
        event: entry.event || "activity",
        severity: entry.severity || "info",
        stage: data.stage || "",
        data,
    };
}
async function buildBookWorkflowStatus(root, state, bookId) {
    const [runtime, runs, chapters, activity, promptInjections] = await Promise.all([
        readWorkflowRuntimeState(root, bookId),
        loadTaskRuns(root).catch(() => []),
        state.loadChapterIndex(bookId).catch(() => []),
        readActivityEntries(root, 300).catch(() => []),
        activePromptInjections(root, bookId).catch(() => []),
    ]);
    const bookRuns = runs.filter((run) => run.bookId === bookId).map(enrichTaskRunForClient)
        .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    const activeRun = bookRuns.find((run) => ["queued", "running", "repairing"].includes(String(run.status || ""))) || null;
    const bookActivity = filterActivityForBook(activity, bookId);
    const latestActivity = bookActivity[0] || null;
    const latestChapter = [...(Array.isArray(chapters) ? chapters : [])].sort((a, b) => Number(b.chapterNumber ?? b.number ?? 0) - Number(a.chapterNumber ?? a.number ?? 0))[0] || null;
    const activeAgent = activeRun?.currentAgent || latestActivity?.data?.agent || runtime.currentAgent || "";
    const activeStage = activeAgent ? WORKFLOW_STAGE_BY_AGENT.get(activeAgent) : null;
    const eventStage = workflowStageForEvent(latestActivity?.event);
    const chapterStageId = CHAPTER_STATUS_TO_WORKFLOW_STAGE.get(String(latestChapter?.status || "")) || "";
    const stage = normalizeWorkflowStage(runtime.stage || runtime.targetStage || activeStage?.id || eventStage?.id || chapterStageId || "prepare");
    const completedAgentIds = new Set();
    const errorAgentIds = new Set();
    for (const run of bookRuns) {
        if (run.currentAgent && ["done", "needs-repair"].includes(String(run.status || "")))
            completedAgentIds.add(run.currentAgent);
        if (run.currentAgent && String(run.status || "") === "error")
            errorAgentIds.add(run.currentAgent);
        for (const event of run.events || []) {
            if (event.agent && String(event.kind || "").includes("error"))
                errorAgentIds.add(event.agent);
            else if (event.agent)
                completedAgentIds.add(event.agent);
        }
    }
    for (const entry of bookActivity) {
        const agentId = entry?.data?.agent;
        if (!agentId)
            continue;
        if (String(entry.event || "").includes("error"))
            errorAgentIds.add(agentId);
        if (/complete|done|approved|quality-gate:auto-heal/.test(String(entry.event || "")))
            completedAgentIds.add(agentId);
    }
    const stageIndex = WORKFLOW_STAGE_DEFS.findIndex((item) => item.id === stage.id);
    const stageAgents = stage.agents;
    const completedInStage = stageAgents.filter((agentId) => completedAgentIds.has(agentId)).length;
    const activeIndex = activeAgent && stageAgents.includes(activeAgent) ? stageAgents.indexOf(activeAgent) : -1;
    const stageProgress = Math.max(0, Math.min(1, stageAgents.length ? (Math.max(completedInStage, activeIndex + 0.5, 0) / stageAgents.length) : 0));
    const overallProgress = Math.max(0, Math.min(1, (stageIndex + stageProgress) / WORKFLOW_STAGE_DEFS.length));
    const agents = AGENT_ROSTER.map((agent) => {
        const agentStage = WORKFLOW_STAGE_BY_AGENT.get(agent.id);
        return {
            id: agent.id,
            role: workflowAgentLabel(agent.id),
            status: workflowAgentStatus(agent.id, stage, activeAgent, activeRun?.status, completedAgentIds, errorAgentIds),
            stage: agentStage?.label || "",
            task: WORKFLOW_AGENT_TASK.get(agent.id) || agent.when || "",
        };
    });
    const roleQueue = stageAgents.map((agentId) => agents.find((agent) => agent.id === agentId)).filter(Boolean);
    const current = agents.find((agent) => agent.id === activeAgent) || roleQueue.find((agent) => agent.status === "待命") || roleQueue[0] || null;
    return {
        bookId,
        stage: stage.label,
        stageId: stage.id,
        bookStatus: stage.bookStatus,
        stageProgress,
        overallProgress,
        currentRole: current?.role || "",
        currentAgent: current?.id || "",
        roleQueue,
        agents,
        chapters: (Array.isArray(chapters) ? chapters : []).map((chapter) => {
            const chapterNumber = Number(chapter.chapterNumber ?? chapter.number ?? 0);
            const override = runtime.chapterOverrides?.[chapterNumber];
            const chapterStage = normalizeWorkflowStage(CHAPTER_STATUS_TO_WORKFLOW_STAGE.get(String(override || chapter.status || "")) || stage.id);
            return {
                chapterNumber,
                title: chapter.title || `第 ${chapterNumber} 章`,
                status: workflowChapterDisplayStatus(override || chapter.status, chapterStage),
                rawStatus: override || chapter.status || "",
                wordCount: chapter.wordCount ?? chapter.chineseChars ?? 0,
                updatedAt: chapter.updatedAt || chapter.createdAt || "",
            };
        }),
        activeRun,
        promptInjections,
        recentEvents: bookActivity.slice(0, 20).map(agentEventFromActivity),
        updatedAt: runtime.updatedAt || activeRun?.updatedAt || latestActivity?.timestamp || new Date().toISOString(),
        source: ["task_runs", "chapter-index", "activity.log", runtime.updatedAt ? "workflow-runtime" : "", promptInjections.length ? "prompt-injections" : ""].filter(Boolean),
    };
}
async function buildChapterWorkflowStatus(root, state, bookId, chapterNumber) {
    const [bookStatus, runtime, activity, promptInjections] = await Promise.all([
        buildBookWorkflowStatus(root, state, bookId),
        readWorkflowRuntimeState(root, bookId),
        readActivityEntries(root, 300).catch(() => []),
        activePromptInjections(root, bookId, { chapterNumber }).catch(() => []),
    ]);
    const chapters = await state.loadChapterIndex(bookId).catch(() => []);
    const meta = (Array.isArray(chapters) ? chapters : []).find((chapter) => Number(chapter.chapterNumber ?? chapter.number ?? 0) === Number(chapterNumber)) || {};
    const override = runtime.chapterOverrides?.[chapterNumber];
    const stage = normalizeWorkflowStage(CHAPTER_STATUS_TO_WORKFLOW_STAGE.get(String(override || meta.status || "")) || bookStatus.stageId || "prepare");
    const roleQueue = stage.agents.map((agentId) => {
        const existing = bookStatus.agents.find((agent) => agent.id === agentId);
        return existing || { id: agentId, role: workflowAgentLabel(agentId), status: "待命", stage: stage.label, task: WORKFLOW_AGENT_TASK.get(agentId) || "" };
    });
    const chapterLogs = filterActivityForBook(activity, bookId)
        .filter((entry) => Number(entry?.data?.chapterNumber || entry?.data?.num || 0) === Number(chapterNumber) || !entry?.data?.chapterNumber)
        .slice(0, 40)
        .map(agentEventFromActivity);
    return {
        bookId,
        chapterNumber,
        chapter: meta.title || `第${chapterNumber}章`,
        status: workflowChapterDisplayStatus(override || meta.status, stage),
        rawStatus: override || meta.status || "",
        stage: stage.label,
        currentRole: roleQueue.find((agent) => agent.status === "运行中")?.role || roleQueue.find((agent) => agent.status === "待命")?.role || roleQueue[0]?.role || "",
        roleQueue,
        promptInjections,
        logs: chapterLogs,
        updatedAt: runtime.updatedAt || meta.updatedAt || meta.createdAt || bookStatus.updatedAt,
    };
}
if (AGENT_ROSTER.length !== PRIMARY_AGENT_FLOW_SIZE) {
    throw new Error(`Juanshe agent roster must contain ${PRIMARY_AGENT_FLOW_SIZE} agents; got ${AGENT_ROSTER.length}.`);
}
if (AGENT_IDS.size !== AGENT_ROSTER.length) {
    throw new Error("Juanshe agent roster contains duplicate agent ids.");
}
for (const [flowId, flow] of Object.entries(AGENT_TASK_FLOWS)) {
    const seen = new Set();
    const allowedRepeats = new Set(flow.allowRepeats || []);
    for (const agentId of flow.agents || []) {
        if (!AGENT_IDS.has(agentId)) {
            throw new Error(`Juanshe task flow "${flowId}" references unknown agent "${agentId}".`);
        }
        if (seen.has(agentId) && !allowedRepeats.has(agentId)) {
            throw new Error(`Juanshe task flow "${flowId}" repeats agent "${agentId}" without allowRepeats.`);
        }
        seen.add(agentId);
    }
}
const NOVEL_PLATFORM_PROFILES = [
    { id: "other", zh: "通用平台", en: "General", region: "global", language: "multi", briefZh: "兼顾清晰开篇、稳定更新、强钩子和可持续人物线。", briefEn: "Prioritize a clear opening, reliable serialization, strong hooks, and sustainable character arcs." },
    { id: "tomato", zh: "番茄小说", en: "Fanqie Novel", region: "cn", language: "zh", briefZh: "快节奏、强爽点、章末钩子密集，前三章必须快速给出主线矛盾和读者承诺。", briefEn: "Fast pacing, visible payoff, dense chapter-end hooks, and a clear central conflict within the first three chapters." },
    { id: "qidian", zh: "起点中文网", en: "Qidian", region: "cn", language: "zh", briefZh: "重体系、成长线、长期伏笔和世界观可扩展性，避免只靠短刺激推进。", briefEn: "System depth, progression, long-term foreshadowing, and expandable worldbuilding." },
    { id: "qidian_female", zh: "起点女生网", en: "Qidian Female", region: "cn", language: "zh", briefZh: "强化人物关系、情绪递进、事业/成长目标和连续冲突，保持网文节奏。", briefEn: "Emphasize relationships, emotional escalation, career/growth goals, and continuous conflict." },
    { id: "feilu", zh: "飞卢小说网", en: "Faloo", region: "cn", language: "zh", briefZh: "高概念开局、设定即卖点、短章强反馈，标题感和反转频率要高。", briefEn: "High-concept premise, premise-as-hook, fast feedback loops, title-like beats, and frequent twists." },
    { id: "zongheng", zh: "纵横中文网", en: "Zongheng", region: "cn", language: "zh", briefZh: "强调格局、人物群像、权谋/冒险推进和中长线叙事张力。", briefEn: "Large-scale stakes, ensemble casts, strategy/adventure movement, and medium-long narrative tension." },
    { id: "jinjiang", zh: "晋江文学城", en: "JJWXC", region: "cn", language: "zh", briefZh: "人物关系和情绪逻辑优先，明确人设差异、关系推进和细腻动机。", briefEn: "Character relationships and emotional logic first, with distinct personas and nuanced motivation." },
    { id: "hongxiu", zh: "红袖读书", en: "Hongxiu", region: "cn", language: "zh", briefZh: "情感线、身份张力和女性向爽点并重，章内要有可感知情绪变化。", briefEn: "Balance romance, identity tension, and female-oriented payoff with visible emotional turns." },
    { id: "yunqi", zh: "云起书院", en: "Yunqi", region: "cn", language: "zh", briefZh: "女性向成长、情感与事业线并行，保持轻快可追的章节节奏。", briefEn: "Female-oriented growth with romance and career lines in a readable serialized rhythm." },
    { id: "qq_reading", zh: "QQ 阅读", en: "QQ Reading", region: "cn", language: "zh", briefZh: "大众化题材表达、强可读性、清楚人设和稳定高潮分布。", briefEn: "Mass-market readability, clear character setup, and steady climax distribution." },
    { id: "zhangyue", zh: "掌阅", en: "iReader", region: "cn", language: "zh", briefZh: "商业类型明确，章节信息密度高，冲突和情绪回报要稳定。", briefEn: "Clear commercial genre, high information density, and stable conflict/emotional payoff." },
    { id: "ciweimao", zh: "刺猬猫", en: "Ciweimao", region: "cn", language: "zh", briefZh: "二次元语感、设定趣味、角色萌点和轻快吐槽，但保持主线目标明确。", briefEn: "ACG tone, playful premise, character charms, and light banter while preserving the main goal." },
    { id: "sfacg", zh: "SF 轻小说", en: "SFACG", region: "cn", language: "zh", briefZh: "轻小说结构、角色标签清晰、场景感强，适合奇幻、校园、恋爱和异世界。", briefEn: "Light-novel structure, clear character tags, vivid scenes, and fantasy/school/romance suitability." },
    { id: "17k", zh: "17K 小说网", en: "17K", region: "cn", language: "zh", briefZh: "类型化明确、主角目标直接、升级/事业/情感线连续推进。", briefEn: "Strong genre identity, direct protagonist goals, and continuous progression/career/romance lines." },
    { id: "webnovel", zh: "WebNovel 国际站", en: "WebNovel", region: "global", language: "en", briefZh: "英文连载爽点、系统/成长/浪漫幻想都要开局明确，章节末留强 cliffhanger。", briefEn: "English serialized payoff, clear system/progression/romance fantasy setup, and strong cliffhangers." },
    { id: "wattpad", zh: "Wattpad", en: "Wattpad", region: "global", language: "en", briefZh: "人物亲密感、强情绪钩子和易分享设定，章节要有社群讨论点。", briefEn: "Intimate character appeal, emotional hooks, shareable premises, and discussion-worthy chapter beats." },
    { id: "royalroad", zh: "Royal Road", en: "Royal Road", region: "global", language: "en", briefZh: "LitRPG/Progression 读者看重规则清晰、数值成长、硬逻辑和稳定更新。", briefEn: "LitRPG/progression readers expect clear rules, visible advancement, logic, and consistent updates." },
    { id: "scribblehub", zh: "Scribble Hub", en: "Scribble Hub", region: "global", language: "en", briefZh: "轻小说、奇幻、同人感和角色驱动强，标签承诺要兑现。", briefEn: "Light-novel/fantasy/fanfic-friendly, character-driven, and faithful to tag promises." },
    { id: "tapas", zh: "Tapas", en: "Tapas", region: "global", language: "en", briefZh: "短章、强视觉感、浪漫/奇幻/都市题材友好，开篇要快速建立关系张力。", briefEn: "Short episodes, visual storytelling, romance/fantasy/urban fit, and quick relationship tension." },
    { id: "radish", zh: "Radish", en: "Radish", region: "global", language: "en", briefZh: "付费连载感、强情绪转折、浪漫和悬念钩子密集。", briefEn: "Paid-serial pacing with strong emotional turns and dense romance/suspense hooks." },
    { id: "kindle_vella", zh: "Kindle Vella", en: "Kindle Vella", region: "global", language: "en", briefZh: "短集连载，每集一个推进点和一个明确钩子，语言更出版化。", briefEn: "Episodic serialization with one clean advance and one hook per episode in polished prose." },
    { id: "amazon_kdp", zh: "Amazon KDP", en: "Amazon KDP", region: "global", language: "en", briefZh: "更偏成书结构，重读者定位、类型封面承诺和完整卷内闭环。", briefEn: "Book-shaped structure, reader positioning, genre promise, and a complete volume arc." },
    { id: "kobo", zh: "Kobo", en: "Kobo", region: "global", language: "en", briefZh: "出版型长线阅读，类型定位清楚，章节节奏稳，不只靠短视频式刺激。", briefEn: "Retail long-read structure with clear genre positioning and steady chapter rhythm." },
    { id: "apple_books", zh: "Apple Books", en: "Apple Books", region: "global", language: "en", briefZh: "精品感和可读性并重，简介、开篇、章节标题要有统一质感。", briefEn: "Polished presentation and readability, with coherent blurb, opening, and chapter titles." },
    { id: "google_play_books", zh: "Google Play Books", en: "Google Play Books", region: "global", language: "en", briefZh: "全球零售表达，题材标签、简介和开篇承诺要直接。", briefEn: "Global retail clarity, direct genre tags, blurb promise, and opening commitment." },
    { id: "barnes_noble", zh: "Barnes & Noble", en: "Barnes & Noble", region: "global", language: "en", briefZh: "书店读者向，结构更完整，章节推进和人物弧线要清楚。", briefEn: "Bookstore-reader friendly, complete structure, clear chapter movement, and character arcs." },
    { id: "substack", zh: "Substack 连载", en: "Substack Serial", region: "global", language: "en", briefZh: "作者声音、订阅理由和每期回访动机很重要，可带轻量作者感。", briefEn: "Authorial voice, subscription reason, and return motivation matter; a light essay-like texture can work." },
    { id: "patreon", zh: "Patreon 连载", en: "Patreon Serial", region: "global", language: "en", briefZh: "粉丝向连续交付，章节奖励感、预告和角色互动资产要强。", briefEn: "Fan-supported serialization with reward value, teasers, and strong character interaction assets." },
    { id: "ao3", zh: "AO3", en: "AO3", region: "global", language: "en", briefZh: "标签承诺、角色关系和情绪满足优先，避免误导标签。", briefEn: "Tag promises, relationship dynamics, and emotional fulfillment first; avoid misleading tags." },
    { id: "fictionpress", zh: "FictionPress", en: "FictionPress", region: "global", language: "en", briefZh: "原创英文连载，重清楚叙事、角色弧线和读者评论可讨论点。", briefEn: "Original English serialization with clear narration, character arcs, and comment-worthy turns." },
    { id: "inkitt", zh: "Inkitt", en: "Inkitt", region: "global", language: "en", briefZh: "商业英文网文，题材承诺、情绪强度和早期留存要优先。", briefEn: "Commercial English web fiction with clear genre promise, emotional intensity, and early retention." },
    { id: "goodnovel", zh: "GoodNovel", en: "GoodNovel", region: "global", language: "en", briefZh: "强戏剧冲突、浪漫/狼人/豪门等类型爽点清楚，章节钩子直接。", briefEn: "High drama, clear romance/werewolf/billionaire payoffs, and direct chapter hooks." },
    { id: "dreame", zh: "Dreame", en: "Dreame", region: "global", language: "en", briefZh: "女性向商业连载，情感张力、身份误会和持续追读动力要强。", briefEn: "Female-oriented commercial serials with emotional tension, identity misunderstandings, and strong retention." },
    { id: "pocket_fm", zh: "Pocket FM", en: "Pocket FM", region: "global", language: "en", briefZh: "音频剧感强，场景转换清楚，对白驱动，章尾适合播客式悬念。", briefEn: "Audio-drama friendly: clear scene turns, dialogue drive, and podcast-like suspense endings." },
    { id: "webtoon", zh: "WEBTOON", en: "WEBTOON", region: "global", language: "en", briefZh: "视觉分镜和角色识别度优先，剧情要能拆成竖屏连载节拍。", briefEn: "Visual panelability and character recognizability, with vertical-scroll episode beats." },
    { id: "reddit_serials", zh: "Reddit Serials", en: "Reddit Serials", region: "global", language: "en", briefZh: "强开场、评论互动点和清晰更新节奏，语言要自然直接。", briefEn: "Strong openings, comment interaction points, clear update rhythm, and natural direct prose." },
];
function resolveNovelPlatformProfile(id, language) {
    const key = String(id || "other");
    const profile = NOVEL_PLATFORM_PROFILES.find((item) => item.id === key) ?? NOVEL_PLATFORM_PROFILES[0];
    const locale = language === "en" ? "en" : "zh";
    return { ...profile, label: locale === "en" ? profile.en : profile.zh, guidance: locale === "en" ? profile.briefEn : profile.briefZh };
}
function buildNovelPlatformPrompt(platform, language) {
    const p = resolveNovelPlatformProfile(platform, language);
    if (language === "en") {
        return [
            `Target platform: ${p.label}.`,
            `Platform strategy: ${p.guidance}`,
            "Creation requirements: match the platform's reader promise, chapter rhythm, opening hook, genre tags, and retention curve; keep a clear protagonist desire, first conflict, updateable long arc, and chapter-end read-on motive.",
            "Do not copy any specific author's expression; abstract only market rhythm, reader expectations, and structural conventions.",
        ].join("\n");
    }
    return [
        `目标平台：${p.label}。`,
        `平台策略：${p.guidance}`,
        "创作要求：开书时必须匹配该平台的读者承诺、章节节奏、开篇钩子、题材标签和追读曲线；明确主角欲望、第一冲突、可持续长线和章末追读理由。",
        "不得复刻特定作者表达，只抽象平台节奏、读者期待和结构规则。",
    ].join("\n");
}
function resolveAgentForStage(stage) {
    if (/基础设定|书籍配置|控制文档|初始快照/.test(stage))
        return "architect";
    if (/规划|组装/.test(stage))
        return "planner";
    if (/字数|长度|length|normaliz/i.test(stage))
        return "length-normalizer";
    if (/撰写|准备章节输入|落盘最终章节|生成最终真相/.test(stage))
        return "writer";
    if (/审计|复审/.test(stage))
        return "auditor";
    if (/修复|修订/.test(stage))
        return "reviser";
    if (/润色/.test(stage))
        return "polisher";
    if (/校验真相|状态/.test(stage))
        return "state-validator";
    if (/风格指纹/.test(stage))
        return "style-governor";
    if (/质量报告|同步记忆|快照|索引/.test(stage))
        return "quality-reporter";
    if (/读者|爽点|弃读|期待/.test(stage))
        return "reader-critic";
    return "writer";
}
function resolveLegacyStageEvent(stage) {
    if (/撰写|准备章节输入|规划|组装/.test(stage))
        return "write:start";
    if (/审计|复审/.test(stage))
        return "audit:start";
    if (/修复|修订/.test(stage))
        return "revise:start";
    if (/字数|长度|length|normaliz/i.test(stage))
        return "length-normalizer";
    if (/润色|风格指纹/.test(stage))
        return "style:start";
    return undefined;
}
const SAAS_SESSION_COOKIE = "hardwrite_saas_session";
const SAAS_STORE_VERSION = 1;
const PREMIUM_API_COSTS = [
    { method: "POST", pattern: /^\/api\/v1\/books\/create$/, credits: 10, reason: "创建作品与故事圣经" },
    { method: "POST", pattern: /^\/api\/v1\/books\/[^/]+\/write-next$/, credits: 8, reason: "生成下一章" },
    { method: "POST", pattern: /^\/api\/v1\/books\/[^/]+\/write-batch$/, credits: 8, reason: "批量章节工作流" },
    { method: "POST", pattern: /^\/api\/v1\/books\/[^/]+\/repair-state$/, credits: 2, reason: "修复章节状态链" },
    { method: "POST", pattern: /^\/api\/v1\/books\/[^/]+\/chapters\/[^/]+\/polish-selection$/, credits: 2, reason: "章节选区润色" },
    { method: "POST", pattern: /^\/api\/v1\/books\/[^/]+\/wiki\/nodes$/, credits: 1, reason: "写入 Wiki 长期记忆节点" },
    { method: "POST", pattern: /^\/api\/v1\/books\/[^/]+\/wiki\/style-preset$/, credits: 1, reason: "落库风格指纹" },
    { method: "POST", pattern: /^\/api\/v1\/agent$/, credits: 3, reason: "Agent API 调用" },
    { method: "POST", pattern: /^\/api\/v1\/atelier\/polish$/, credits: 2, reason: "一键润色" },
    { method: "POST", pattern: /^\/api\/v1\/style\/analyze$/, credits: 2, reason: "文风分析" },
    { method: "POST", pattern: /^\/api\/v1\/covers\/generate$/, credits: 5, reason: "封面生成" },
    { method: "POST", pattern: /^\/api\/v1\/radar\/scan$/, credits: 3, reason: "市场雷达扫描" },
];
function isSaasModeEnabled() {
    return process.env.HARDWRITE_SAAS_MODE === "1" || process.env.HARDWRITE_SAAS_MODE === "true";
}
function saasDataDir(root) {
    return process.env.HARDWRITE_SAAS_DATA_DIR || join(root, ".saas");
}
function saasStoreFile(root) {
    return join(saasDataDir(root), "saas.json");
}
function normalizeEmail(email) {
    return String(email ?? "").trim().toLowerCase();
}
function publicUser(user) {
    if (!user)
        return null;
    return {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        credits: Number(user.credits ?? 0),
        createdAt: user.createdAt,
    };
}
function hashPassword(password) {
    const salt = randomBytes(16).toString("hex");
    const iterations = 210000;
    const hash = pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("hex");
    return `pbkdf2$${iterations}$${salt}$${hash}`;
}
function verifyPassword(password, encoded) {
    const [scheme, iterText, salt, expectedHex] = String(encoded ?? "").split("$");
    if (scheme !== "pbkdf2" || !iterText || !salt || !expectedHex)
        return false;
    const actual = pbkdf2Sync(String(password), salt, Number(iterText), 32, "sha256");
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function parseCookies(header) {
    const out = {};
    for (const part of String(header ?? "").split(";")) {
        const index = part.indexOf("=");
        if (index === -1)
            continue;
        out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return out;
}
function setSaasCookie(c, sessionId, maxAge = 60 * 60 * 24 * 30) {
    const secure = process.env.HARDWRITE_COOKIE_SECURE === "1" ? "; Secure" : "";
    c.header("Set-Cookie", `${SAAS_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
function clearSaasCookie(c) {
    c.header("Set-Cookie", `${SAAS_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function encodeHeaderFilename(value) {
    return encodeURIComponent(value)
        .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/\*/g, "%2A");
}
function attachmentContentDisposition(fileName) {
    const extension = fileName.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? ".txt";
    const asciiFallback = /^[\x20-\x7E]+$/.test(fileName)
        ? fileName.replace(/["\\\r\n]/g, "_")
        : `export${extension}`;
    return `attachment; filename="${asciiFallback || "export.txt"}"; filename*=UTF-8''${encodeHeaderFilename(fileName)}`;
}
function tenantIdForEmail(email) {
    return `tenant_${createHash("sha256").update(email).digest("hex").slice(0, 18)}`;
}
function newId(prefix) {
    return `${prefix}_${randomBytes(12).toString("hex")}`;
}
async function loadSaasStore(root) {
    const dir = saasDataDir(root);
    const file = saasStoreFile(root);
    await mkdir(dir, { recursive: true });
    try {
        const parsed = JSON.parse(await readFile(file, "utf-8"));
        return {
            version: parsed.version ?? SAAS_STORE_VERSION,
            users: Array.isArray(parsed.users) ? parsed.users : [],
            sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
            ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
        };
    }
    catch {
        const fresh = { version: SAAS_STORE_VERSION, users: [], sessions: [], ledger: [] };
        await writeFile(file, JSON.stringify(fresh, null, 2), "utf-8");
        return fresh;
    }
}
async function saveSaasStore(root, store) {
    await mkdir(saasDataDir(root), { recursive: true });
    // 原子写:saas.json 含全部用户/会话/额度/账本,崩溃/磁盘满直写会整文件截断损坏。
    await atomicWriteFile(saasStoreFile(root), JSON.stringify(store, null, 2));
}
async function ensureTenantWorkspace(root, tenantId) {
    const tenantRoot = join(saasDataDir(root), "tenants", tenantId);
    await mkdir(join(tenantRoot, "books"), { recursive: true });
    try {
        await access(join(tenantRoot, "hardwrite.json"));
    }
    catch {
        const base = await loadRawConfig(root).catch(() => ({ name: "tenant-workspace" }));
        await writeFile(join(tenantRoot, "hardwrite.json"), JSON.stringify({
            ...base,
            name: tenantId,
            tenantId,
        }, null, 2), "utf-8");
    }
    return tenantRoot;
}
async function resolveSaasSession(root, c) {
    if (!isSaasModeEnabled())
        return null;
    const cookies = parseCookies(c.req.header("cookie"));
    const sid = cookies[SAAS_SESSION_COOKIE];
    if (!sid)
        return null;
    const store = await loadSaasStore(root);
    const now = Date.now();
    const session = store.sessions.find((item) => item.id === sid && Number(item.expiresAt ?? 0) > now);
    if (!session)
        return null;
    const user = store.users.find((item) => item.id === session.userId);
    return user ? { store, session, user } : null;
}
// ── 激活解锁(桌面 BYOK:本地优先,可选远程校验 / HMAC 签名 / 名单)──────────
// 解锁记录落在工作区 .autow/activation.json;不依赖 SaaS 账号体系。
// 校验优先级:远程 verify URL → 显式名单 → 内置校验和(可叠加 HMAC 密钥)→ DEV 直通。
const ACTIVATION_CODE_PREFIX = "JUAN";
const ACTIVATION_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32(去掉易混 I/L/O/U)
const ACTIVATION_BUILTIN_SALT = "juanshe.activation.v1";
function activationFile(root) {
    return join(root, ".autow", "activation.json");
}
function normalizeActivationCode(code) {
    return String(code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function maskActivationCode(normalized) {
    if (!normalized || normalized.length <= 4)
        return "••••";
    return `${ACTIVATION_CODE_PREFIX}-••••-••••-${normalized.slice(-4)}`;
}
function activationChecksum(payload, secret) {
    const mac = createHmac("sha256", secret || ACTIVATION_BUILTIN_SALT).update(payload).digest();
    let out = "";
    // 6 位 base32 = 30 bit 校验和(撞中率 ≈1/1e9):配合限流真实 IP,内置码不再可被暴力枚举。
    for (let i = 0; i < 6; i++)
        out += ACTIVATION_ALPHABET[mac[i] % 32];
    return out;
}
function hasBuiltinCodeShape(normalized) {
    // JUAN + payload 10 + checksum 6 = body 16 → normalize 后共 20 字符
    return normalized.startsWith(ACTIVATION_CODE_PREFIX)
        && normalized.length === ACTIVATION_CODE_PREFIX.length + 16;
}
function verifyBuiltinCode(normalized, secret) {
    if (!hasBuiltinCodeShape(normalized))
        return false;
    const body = normalized.slice(ACTIVATION_CODE_PREFIX.length); // 12 位
    const payload = body.slice(0, 10);
    const check = body.slice(10);
    return check === activationChecksum(ACTIVATION_CODE_PREFIX + payload, secret);
}
function mintActivationCode(payload10, secret) {
    const cleaned = String(payload10 ?? "")
        .toUpperCase()
        .split("")
        .filter((ch) => ACTIVATION_ALPHABET.includes(ch))
        .join("")
        .padEnd(10, "0")
        .slice(0, 10);
    const body = cleaned + activationChecksum(ACTIVATION_CODE_PREFIX + cleaned, secret); // payload10 + checksum6 = 16
    return `${ACTIVATION_CODE_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}
function randomActivationCode(secret) {
    const raw = randomBytes(10);
    let payload = "";
    for (let i = 0; i < 10; i++)
        payload += ACTIVATION_ALPHABET[raw[i] % 32];
    return mintActivationCode(payload, secret);
}
// ── 激活码等级(Normal/Pro/Ultra)——等级编进 payload 首位 + 次位 HMAC 守卫 ──
// 校验和已覆盖整 payload → 等级字符不可篡改;守卫位用于区分「分级新码」与「旧随机码」
// (旧码守卫几乎不会匹配 → 落回 normal),从而向后兼容,旧码一律 normal。
const ACTIVATION_TIER_CHAR = { normal: "0", pro: "2", ultra: "4" };
const ACTIVATION_TIER_BY_CHAR = { "2": "pro", "4": "ultra" };
function activationTierGuard(tierChar, secret) {
    const mac = createHmac("sha256", secret || ACTIVATION_BUILTIN_SALT).update("juanshe.tier|" + tierChar).digest();
    return ACTIVATION_ALPHABET[mac[0] % 32];
}
function activationTierFromPayload(payload, secret) {
    if (!payload || payload.length < 2)
        return "normal";
    const tc = payload[0];
    if (payload[1] !== activationTierGuard(tc, secret))
        return "normal";
    return ACTIVATION_TIER_BY_CHAR[tc] ?? "normal";
}
function activationTierFromCode(normalized, secret) {
    if (!hasBuiltinCodeShape(normalized))
        return "normal";
    return activationTierFromPayload(normalized.slice(ACTIVATION_CODE_PREFIX.length, ACTIVATION_CODE_PREFIX.length + 10), secret);
}
function tieredActivationCode(tier, secret) {
    const tc = ACTIVATION_TIER_CHAR[tier] ?? "0";
    const guard = activationTierGuard(tc, secret);
    const raw = randomBytes(8);
    let rand = "";
    for (let i = 0; i < 8; i++)
        rand += ACTIVATION_ALPHABET[raw[i] % 32];
    return mintActivationCode(tc + guard + rand, secret);
}
// ── 写作强度档位(轻中重)解析 + 按激活等级(②)限档 ──
// 未指定 mode → 返回 undefined(runner 默认 max = 既有行为,向后兼容,不影响现有调用)。
// 指定了 → 映射成 light/standard/max,并 cap 到 tier 允许的最高档(normal→light、pro→standard、ultra→max)。
const TIER_MAX_INTENSITY = { normal: "light", pro: "standard", ultra: "max" };
const INTENSITY_RANK = { light: 0, standard: 1, max: 2 };
const INTENSITY_ALIAS = { normal: "light", pro: "standard", ultra: "max", light: "light", standard: "standard", max: "max", "轻": "light", "中": "standard", "重": "max" };
function resolveWriteIntensity(requestedMode, tier) {
    const want = INTENSITY_ALIAS[String(requestedMode ?? "").toLowerCase().trim()];
    if (!want)
        return undefined; // 未指定/无法识别 → 不传,runner 走默认 max
    const cap = TIER_MAX_INTENSITY[String(tier ?? "normal").toLowerCase()] ?? "light";
    return INTENSITY_RANK[want] <= INTENSITY_RANK[cap] ? want : cap;
}
function activationCodesFromEnv() {
    return String(process.env.HARDWRITE_ACTIVATION_CODES ?? "")
        .split(/[,\s]+/)
        .map(normalizeActivationCode)
        .filter(Boolean);
}
// 配置了任一激活校验源(verify URL / HMAC secret / 名单)= 本机能校验升级码。
// 注意:这不再等于"必须有码才能进站"。
function activationConfigured() {
    return Boolean(process.env.HARDWRITE_ACTIVATION_VERIFY_URL)
        || Boolean(process.env.HARDWRITE_ACTIVATION_SECRET)
        || activationCodesFromEnv().length > 0;
}
// 2026-06-12 产品决策:免码可进站、可写书(普通会员=轻档),激活码只解锁 Pro/Ultra。
// 仅显式 HARDWRITE_ACTIVATION_REQUIRED=1 才整站硬卡(留给特殊分发场景),
// 配置密钥/校验源(activationConfigured)只代表"可校验升级码",不再触发硬卡。
function activationRequired() {
    return process.env.HARDWRITE_ACTIVATION_REQUIRED === "1";
}
// 普通会员(商业安装已配激活校验、但本机未解锁任何码)默认写作档位 = 轻;
// 纯自部署(未配置激活)不限档,维持开源既有行为(默认 max)。
function freeTierWriteMode(activation) {
    return activationConfigured() && !activation?.unlocked ? "light" : undefined;
}
async function loadActivation(root) {
    try {
        const parsed = JSON.parse(await readFile(activationFile(root), "utf-8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
// ── 简易内存限频(防激活码/登录暴力枚举;按 IP+用途分桶)──────────────────────
const __rateBuckets = new Map();
function rateLimited(key, limit = 10, windowMs = 60000) {
    const now = Date.now();
    const b = __rateBuckets.get(key);
    if (!b || now > b.resetAt) {
        __rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
        if (__rateBuckets.size > 5000) { // 防桶无限增长:顺手清过期
            for (const [k, v] of __rateBuckets) if (now > v.resetAt) __rateBuckets.delete(k);
        }
        return false;
    }
    b.count += 1;
    return b.count > limit;
}
function clientKey(c, scope) {
    // 默认(桌面单机绑 127.0.0.1、前面无反代):转发头由客户端任意伪造,绝不可信——只认连接真实远端地址。
    // 否则轮换 X-Forwarded-For 即可为每次尝试开新限流桶、把激活码暴破从"不可行"变成"几秒可破"。
    // 仅在显式声明"我在可信反代后"(HARDWRITE_TRUST_PROXY=1)时才采信转发头。
    let ip = "";
    if (process.env.HARDWRITE_TRUST_PROXY === "1") {
        ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "";
    }
    if (!ip) {
        try { ip = c.env?.incoming?.socket?.remoteAddress || c.env?.incoming?.connection?.remoteAddress || ""; }
        catch { /* 某些运行时无 incoming */ }
    }
    return `${scope}:${ip || "local"}`;
}
async function saveActivation(root, data) {
    await mkdir(join(root, ".autow"), { recursive: true });
    // 原子写:tmp + rename,防并发 activate/deactivate 或崩溃把 activation.json 写撕裂。
    const file = activationFile(root);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmp, file);
}
async function remoteVerifyActivation(url, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
        });
        // 默认拒绝:必须 res.ok + 响应是 JSON + 显式 ok===true 才放行,避免反代/captive portal 返 200 HTML 被误判为激活成功。
        const ctype = res.headers.get("content-type") || "";
        const json = ctype.includes("application/json") ? await res.json().catch(() => ({})) : {};
        if (!res.ok || json?.ok !== true) {
            return { ok: false, message: json?.message || json?.error?.message || `激活校验失败(${res.status})。` };
        }
        return { ok: true, plan: json?.plan ?? "remote", tier: json?.tier, expiresAt: json?.expiresAt ?? null, authorName: json?.authorName, remote: true };
    }
    catch {
        return { ok: false, message: "无法连接激活服务器,请检查网络后重试。" };
    }
    finally {
        clearTimeout(timer);
    }
}
async function validateActivationCode(code, deviceId) {
    const normalized = normalizeActivationCode(code);
    if (normalized.length < 6) {
        return { ok: false, message: "请输入有效的激活码。" };
    }
    const verifyUrl = process.env.HARDWRITE_ACTIVATION_VERIFY_URL;
    if (verifyUrl) {
        return remoteVerifyActivation(verifyUrl, { code: normalized, deviceId: deviceId ?? null, product: "juanshe" });
    }
    const allowList = activationCodesFromEnv();
    if (allowList.length > 0) {
        return allowList.includes(normalized)
            ? { ok: true, plan: "list", expiresAt: null }
            : { ok: false, message: "激活码无效或已停用。" };
    }
    const secret = process.env.HARDWRITE_ACTIVATION_SECRET || "";
    // fail-closed:只有配了私有 secret 才接受内置签名码。空 secret 时校验和会退化到随包发布的公开盐,
    // 任何人都能离线铸出"有效"码 → 付费墙形同虚设,所以此分支必须拒绝(不再有 plan:"offline")。
    if (secret && verifyBuiltinCode(normalized, secret)) {
        return { ok: true, plan: "signed", expiresAt: null };
    }
    // DEV 自测直通:必须显式开 DEV 且非生产,避免误配把付费墙整个打开。
    if (process.env.HARDWRITE_ACTIVATION_DEV === "1" && process.env.NODE_ENV !== "production") {
        return { ok: true, plan: "dev", expiresAt: null };
    }
    // 激活被要求、却没有任何可信校验源(verifyUrl/名单/非空 secret)→ 明确拒绝并提示发卡方配置,绝不静默放行。
    if (activationRequired() && !verifyUrl && allowList.length === 0 && !secret) {
        return { ok: false, message: "本机未配置可校验的激活方式(请发卡方设置 HARDWRITE_ACTIVATION_SECRET 或 VERIFY_URL / CODES)。" };
    }
    return { ok: false, message: "激活码无效,请检查后重试或联系发卡方。" };
}
function findPremiumCost(method, path) {
    return PREMIUM_API_COSTS.find((item) => item.method === method && item.pattern.test(path));
}
const TOOL_LABELS = {
    read: "读取文件", edit: "编辑文件", grep: "搜索", ls: "列目录",
};
function resolveToolLabel(tool, agent) {
    if (tool === "sub_agent" && agent)
        return AGENT_LABELS[agent] ?? agent;
    return TOOL_LABELS[tool] ?? tool;
}
function summarizeResult(result) {
    if (typeof result === "string")
        return result.slice(0, 200);
    if (result && typeof result === "object") {
        const r = result;
        if (typeof r.content === "string")
            return r.content.slice(0, 200);
        if (typeof r.text === "string")
            return r.text.slice(0, 200);
    }
    return String(result).slice(0, 200);
}
const NON_TEXT_MODEL_ID_PARTS = [
    "image",
    "embedding",
    "embed",
    "rerank",
    "tts",
    "speech",
    "audio",
    "moderation",
];
function isTextChatModelId(modelId) {
    const normalized = modelId.trim().toLowerCase();
    if (!normalized)
        return false;
    return !NON_TEXT_MODEL_ID_PARTS.some((part) => normalized.includes(part));
}
const GENERIC_OPENAI_COMPATIBLE_MODEL_IDS = [
    "gpt-4o-mini",
    "deepseek-chat",
    "deepseek-reasoner",
    "qwen-plus",
    "claude-3-5-sonnet-latest",
];
function fallbackModelIdsForEndpoint(endpointId) {
    return endpointId === "newapi" ? GENERIC_OPENAI_COMPATIBLE_MODEL_IDS : [];
}
function filterTextChatModels(models) {
    return models.filter((model) => isTextChatModelId(model.id));
}
function normalizeApiBookId(value, fieldName) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string") {
        throw new ApiError(400, "INVALID_BOOK_ID", `${fieldName} must be a string`);
    }
    const bookId = value.trim();
    if (!bookId) {
        throw new ApiError(400, "INVALID_BOOK_ID", `${fieldName} cannot be blank`);
    }
    if (!isSafeBookId(bookId)) {
        throw new ApiError(400, "INVALID_BOOK_ID", `Invalid ${fieldName}: "${bookId}"`);
    }
    return bookId;
}
function nonTextModelMessage(modelId) {
    return `模型 ${modelId} 不适合文本聊天/写作。请在模型选择器中改用文本模型，例如 gemini-2.5-flash、gemini-2.5-pro 或对应服务的 chat 模型。`;
}
function extractToolError(result) {
    if (typeof result === "string")
        return result.slice(0, 500);
    if (result && typeof result === "object") {
        const r = result;
        if (typeof r.content === "string")
            return r.content.slice(0, 500);
        if (r.content && Array.isArray(r.content)) {
            const textPart = r.content.find((c) => c.type === "text");
            if (textPart)
                return textPart.text?.slice(0, 500) ?? "";
        }
    }
    return String(result).slice(0, 500);
}
function isLikelyFailedToolResult(exec) {
    if (exec.status === "error")
        return true;
    const text = `${exec.error ?? ""}\n${exec.result ?? ""}`.toLowerCase();
    return /\bfailed\b|\berror\b|失败|异常|出错/.test(text);
}
function hasSuccessfulSubAgentExec(execs, agent) {
    return execs.some((exec) => exec.tool === "sub_agent"
        && exec.agent === agent
        && exec.status === "completed"
        && !isLikelyFailedToolResult(exec));
}
function isWriteNextInstruction(instruction) {
    const trimmed = instruction.trim();
    return /^(continue|继续|继续写|写下一章|write next|下一章|再来一章)$/i.test(trimmed)
        || /(继续写|写下一章|下一章|再来一章|write\s+next)/i.test(trimmed);
}
function looksLikeBookCreatedClaim(responseText) {
    return /(?:已|已经|成功).{0,12}(?:创建|建书|初始化|保存).{0,12}(?:作品|书|书籍|文件夹)?/.test(responseText)
        || /\b(?:created|initiali[sz]ed|saved)\b.{0,40}\b(?:book|project|novel)\b/i.test(responseText);
}
function validateAgentActionExecution(args) {
    const failedExec = args.collectedToolExecs.find(isLikelyFailedToolResult);
    if (failedExec) {
        return `${failedExec.label} 执行失败：${failedExec.error ?? failedExec.result ?? "未知错误"}`;
    }
    if (args.agentBookId
        && isWriteNextInstruction(args.instruction)
        && !hasSuccessfulSubAgentExec(args.collectedToolExecs, "writer")) {
        return "模型声称已完成下一章，但没有实际调用写作工具。请重试；如果仍失败，请检查模型是否支持工具调用。";
    }
    if (!args.agentBookId
        && looksLikeBookCreatedClaim(args.responseText)
        && !resolveCreatedBookIdFromToolExecs(args.collectedToolExecs)) {
        return "模型声称已创建作品，但没有实际调用建书工具，也没有生成作品文件。请补充书名/题材后重试，或换用支持工具调用的模型。";
    }
    return undefined;
}
const subscribers = new Set();
// ── 流式中断恢复:每本书「当前在写章节」的已累计正文快照(纯内存) ──────────────
// broadcast 出于体积刻意不把 llm:delta 持久化进 activity.log,SSE 重连也只回放状态快照
// 不回放 token → 刷新/断线后打字机从句中开始、半章正文对用户"消失"。这里挂一个常驻
// subscriber 随广播累计增量,GET /agents/live-draft 把快照种回前端(useLiveRun)。
const liveDraftByBook = new Map();
const LIVE_DRAFT_MAX_AGE_MS = 10 * 60 * 1000; // 超过 10 分钟没有新 token = 死流,重新累计
const LIVE_DRAFT_MAX_CHARS = 400_000; // 单 agent 累计上限(正常章节远小于此,防异常膨胀)
const LIVE_DRAFT_MAX_BOOKS = 8; // 只保留最近活跃的几本,防多书长跑撑爆内存
subscribers.add((event, data) => {
    try {
        const bookId = data?.bookId;
        if (!bookId || typeof bookId !== "string")
            return;
        if (event === "llm:delta") {
            const text = typeof data.text === "string" ? data.text : "";
            if (!text)
                return;
            const agent = String(data.agent || "model");
            const chapter = Number(data.chapter || data.chapterNumber || 0) || undefined;
            const now = Date.now();
            let entry = liveDraftByBook.get(bookId);
            if (!entry || now - entry.updatedAt > LIVE_DRAFT_MAX_AGE_MS) {
                entry = { chapter: undefined, byAgent: new Map(), lastAgent: "", updatedAt: now, completed: false };
                liveDraftByBook.set(bookId, entry);
            }
            if (chapter && entry.chapter && chapter !== entry.chapter) {
                // 换章 → 重新累计(与前端 useLiveRun 同语义)
                entry.byAgent = new Map();
                entry.completed = false;
            }
            if (chapter)
                entry.chapter = chapter;
            if (entry.completed) {
                // 上一条模型流已 done → 同 agent 再开流是新一轮(复修/重写),不能接在旧文后面
                entry.byAgent.delete(agent);
                entry.completed = false;
            }
            const prev = entry.byAgent.get(agent) ?? "";
            entry.byAgent.set(agent, (prev + text).slice(-LIVE_DRAFT_MAX_CHARS));
            entry.lastAgent = agent;
            entry.updatedAt = now;
            if (liveDraftByBook.size > LIVE_DRAFT_MAX_BOOKS) {
                const oldest = [...liveDraftByBook.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
                if (oldest && oldest[0] !== bookId)
                    liveDraftByBook.delete(oldest[0]);
            }
            return;
        }
        if (event === "llm:progress" && data?.status === "done") {
            const entry = liveDraftByBook.get(bookId);
            if (entry)
                entry.completed = true;
            return;
        }
        if (event === "write:complete" || event === "workflow:stopped") {
            // 章节已落库 / 工作流已停 → 快照失去恢复价值,立即释放
            liveDraftByBook.delete(bookId);
        }
    }
    catch {
        // 快照累计绝不允许影响广播主链路
    }
});
const bookCreateStatus = new Map();
const BOOK_CREATE_STALL_MS = Number(process.env.HARDWRITE_BOOK_CREATE_STALL_MS || 10 * 60 * 1000);
let activityLogRoot = null;
function numericTimestamp(value) {
    if (!value)
        return 0;
    if (typeof value === "number")
        return Number.isFinite(value) ? value : 0;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
}
function bookCreateActivityAt(status, run) {
    const candidates = [
        status?.lastEventAt,
        status?.progress?.lastEventAt,
        status?.startedAt,
        run?.heartbeatAt,
        run?.updatedAt,
        run?.createdAt,
    ].map(numericTimestamp).filter(Boolean);
    return candidates.length ? Math.max(...candidates) : 0;
}
function isLiveBookCreateStatus(status, run) {
    if (!status)
        return false;
    const rawStatus = String(status.status || "");
    const progressStatus = String(status.progress?.status || "");
    if (["created", "needs-foundation", "cancelled"].includes(rawStatus))
        return false;
    if (rawStatus !== "creating" && progressStatus !== "streaming")
        return false;
    const activityAt = bookCreateActivityAt(status, run);
    return activityAt > 0 && Date.now() - activityAt <= BOOK_CREATE_STALL_MS;
}
function latestCreateBookRunForBook(runs, bookId) {
    return [...runs]
        .filter((run) => run?.type === "create-book" && run.bookId === bookId)
        .sort((a, b) => numericTimestamp(b.updatedAt || b.heartbeatAt || b.createdAt) - numericTimestamp(a.updatedAt || a.heartbeatAt || a.createdAt))[0] ?? null;
}
function createRunNeedsFoundation(run) {
    return Array.isArray(run?.results) && run.results.some((result) => result?.fallback || result?.needsFoundation || result?.partialRecovered);
}
function updateBookCreateStatus(bookId, patch) {
    if (!bookId)
        return;
    const existing = bookCreateStatus.get(bookId) ?? {};
    if (!bookCreateStatus.has(bookId) && patch.allowCreate !== true)
        return;
    const { allowCreate, ...rest } = patch;
    bookCreateStatus.set(bookId, { ...existing, ...rest, bookId, lastEventAt: Date.now() });
}
function appendBookCreatePreview(bookId, text) {
    if (!bookId || !text)
        return;
    if (!bookCreateStatus.has(bookId))
        return;
    const existing = bookCreateStatus.get(bookId) ?? {};
    const preview = `${existing.preview ?? ""}${text}`.slice(-4000);
    bookCreateStatus.set(bookId, { ...existing, bookId, preview, lastEventAt: Date.now() });
}
// 内存缓存：service -> 模型列表 + 更新时间戳；避免每次 sidebar 挂载时都打真实 LLM /models
const modelListCache = new Map();
const WRITING_VAULT_DIR = "卷舍写作库";
const LEGACY_WRITING_VAULT_DIRS = ["长卷写作库", "墨脉写作库"];
const VAULT_SECTION_DIRS = [
    "00-首页",
    "10-市场机会",
    "20-作品档案",
    "30-参考素材",
    "40-风格样本",
    "50-长期记忆",
    "60-模板库",
    "70-封面图",
    "80-产品运维",
    "90-系统索引",
];
function vaultPath(root) {
    return join(root, WRITING_VAULT_DIR);
}
function sanitizeVaultName(value, fallback = "未命名") {
    const normalized = String(value ?? "")
        .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return (normalized || fallback).slice(0, 80);
}
function vaultStamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, "-");
}
function normalizeMarkdownText(value) {
    return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}
function decodeHtmlEntities(value) {
    const named = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
    };
    return String(value ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
        if (entity[0] === "#") {
            const hex = entity[1]?.toLowerCase() === "x";
            const raw = hex ? entity.slice(2) : entity.slice(1);
            const codePoint = Number.parseInt(raw, hex ? 16 : 10);
            return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
        }
        return named[entity] ?? match;
    });
}
function htmlToReadableText(html) {
    return decodeHtmlEntities(String(html ?? "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
        .replace(/<(h[1-6]|p|div|section|article|br|li|blockquote)\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")).trim();
}
function markdownLinkPath(relativePath) {
    return relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}
async function ensureWritingVault(root) {
    const vault = vaultPath(root);
    try {
        await access(vault);
    }
    catch {
        for (const legacyName of LEGACY_WRITING_VAULT_DIRS) {
            try {
                const legacyVault = join(root, legacyName);
                await access(legacyVault);
                await rename(legacyVault, vault);
                break;
            }
            catch {
                // 继续尝试下一个旧库名
            }
        }
    }
    await mkdir(vault, { recursive: true });
    await Promise.all(VAULT_SECTION_DIRS.map((dir) => mkdir(join(vault, dir), { recursive: true })));
    const home = join(vault, "00-首页", "卷舍.md");
    const legacyHomes = ["长卷写作台.md", "墨脉写作室.md"];
    try {
        await access(home);
    }
    catch {
        for (const legacyName of legacyHomes) {
            try {
                const legacyHome = join(vault, "00-首页", legacyName);
                await access(legacyHome);
                await rename(legacyHome, home);
                break;
            }
            catch {
                // 继续尝试下一个旧首页名
            }
        }
    }
    try {
        await access(home);
    }
    catch {
        await writeFile(home, [
            "# 卷舍",
            "",
            "这里是卷舍的本地写作记忆库。所有扫描、作品、参考素材、风格样本和长期记忆都以 Markdown 保存，Obsidian 可以直接打开这个文件夹。",
            "",
            "## 快速入口",
            "",
            "- [[60-模板库/开始写书路径|开始写书路径]]",
            "- [[10-市场机会/雷达扫描列表|雷达扫描列表]]",
            "- [[20-作品档案/作品列表|作品列表]]",
            "- [[30-参考素材/素材列表|参考素材列表]]",
            "- [[40-风格样本/风格样本列表|风格样本列表]]",
            "- [[50-长期记忆/写作记忆|长期写作记忆]]",
            "- [[60-模板库/高质量写作角色协议|高质量写作角色协议]]",
            "- [[60-模板库/写作工程约束清单|写作工程约束清单]]",
            "- [[60-模板库/一键指令库|一键指令库]]",
            "- [[60-模板库/章节质量评分卡|章节质量评分卡]]",
            "- [[60-模板库/模板列表|写作模板库]]",
            "- [[70-封面图/封面列表|封面图]]",
            "- [[80-产品运维/产品架构地图|产品架构地图]]",
            "- [[80-产品运维/启动与故障排查|启动与故障排查]]",
            "- [[90-系统索引/存储地图|存储地图]]",
            "",
            "## 开始写书",
            "",
            "1. 先打开 [[60-模板库/开始写书路径|开始写书路径]]，用 10 分钟把题材承诺、主角欲望、第一冲突和前三章钩子钉住。",
            "2. 再用 [[60-模板库/人物弧光卡|人物弧光卡]] 建立主要角色的欲望、弱点、误信和信息边界。",
            "3. 每章开写前复制 [[60-模板库/章节执行备忘|章节执行备忘]]，只写一个主动作、一条情绪压强、一个可验证变化。",
            "4. 章节完成后用 [[60-模板库/写作工程约束清单|写作工程约束清单]] 做质量门禁，再交给润色和审稿流程。",
            "",
        ].join("\n"), "utf-8");
    }
    try {
        const homeContent = await readFile(home, "utf-8");
        const normalizedHome = homeContent.replace(/墨脉写作室|长卷写作台/g, "卷舍").replace(/墨脉写作库|长卷写作库/g, "卷舍写作库");
        if (normalizedHome !== homeContent)
            await writeFile(home, normalizedHome, "utf-8");
    }
    catch {
        // Home page is optional during first-run recovery.
    }
    const defaults = [
        ["10-市场机会/雷达扫描列表.md", "# 雷达扫描列表\n\n"],
        ["20-作品档案/作品列表.md", "# 作品列表\n\n"],
        ["30-参考素材/素材列表.md", "# 参考素材列表\n\n"],
        ["40-风格样本/风格样本列表.md", "# 风格样本列表\n\n"],
        ["50-长期记忆/写作记忆.md", "# 长期写作记忆\n\n## 写作偏好\n\n## 角色与世界观长期设定\n\n## 禁忌与注意事项\n\n"],
        ["60-模板库/模板列表.md", "# 模板列表\n\n"],
        ["70-封面图/封面列表.md", "# 封面列表\n\n"],
        ["80-产品运维/产品架构地图.md", "# 产品架构地图\n\n卷舍是本地长篇创作操作系统：想法 -> 作品骨架 -> 章节计划 -> 正文写作 -> 审稿评分 -> 润色修订 -> 记忆沉淀 -> 继续写。\n\n"],
        ["80-产品运维/启动与故障排查.md", "# 启动与故障排查\n\n- Studio 地址：`http://localhost:4567`\n- 如果 `/api/v1/agent` 返回 `No instruction provided`，说明接口通了，只是请求体没有写作指令。\n- 如果返回 `SESSION_ID_REQUIRED`，说明服务端未加载自动建会话修复，需要重启 Studio。\n\n"],
        ["90-系统索引/存储地图.md", "# 存储地图\n\n- `10-市场机会`：市场扫描、机会点、题材建议。\n- `20-作品档案`：本地书籍和章节索引。\n- `30-参考素材`：URL、粘贴文本、资料摘录。\n- `40-风格样本`：用于学习语气、节奏、句法的样本。\n- `50-长期记忆`：写作偏好、角色设定、规则与禁忌。\n- `60-模板库`：开始写书路径、角色协议、章节约束、人物、风格、润色和发布前检查模板。\n- `70-封面图`：本地生成或导入的作品封面。\n- `80-产品运维`：产品架构、启动方式、故障排查和健康检查。\n"],
    ];
    for (const [relativePath, content] of defaults) {
        const fullPath = join(vault, relativePath);
        try {
            await access(fullPath);
        }
        catch {
            await writeFile(fullPath, content, "utf-8");
        }
    }
    return vault;
}
async function writeVaultFile(root, relativePath, content) {
    const vault = await ensureWritingVault(root);
    const fullPath = join(vault, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    return { fullPath, relativePath };
}
async function listVaultMarkdown(root, section) {
    const vault = await ensureWritingVault(root);
    const base = join(vault, section);
    async function walk(current, prefix = "") {
        let entries = [];
        try {
            entries = await readdir(current, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const files = [];
        for (const entry of entries) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                files.push(...await walk(full, rel));
            }
            else if (entry.isFile() && entry.name.endsWith(".md")) {
                const relativePath = `${section}/${rel}`;
                files.push({
                    name: entry.name.replace(/\.md$/, ""),
                    relativePath,
                    path: join(vault, relativePath),
                });
            }
        }
        return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN"));
    }
    return walk(base);
}
async function readOptionalText(path) {
    try {
        return await readFile(path, "utf-8");
    }
    catch {
        return "";
    }
}
async function appendVaultIndexEntry(root, indexRelativePath, targetRelativePath, label, meta = "") {
    const vault = await ensureWritingVault(root);
    const fullPath = join(vault, indexRelativePath);
    const existing = await readOptionalText(fullPath);
    const line = `- [[${targetRelativePath.replace(/\.md$/, "")}|${label}]]${meta ? ` - ${meta}` : ""}`;
    if (existing.includes(line)) {
        return;
    }
    const content = existing.trimEnd() + (existing.trim() ? "\n" : "") + line + "\n";
    await writeFile(fullPath, content, "utf-8");
}
function radarMarkdown(result) {
    const recommendations = Array.isArray(result?.recommendations) ? result.recommendations : [];
    const sourceHealth = Array.isArray(result?.sourceHealth) ? result.sourceHealth : [];
    const guidance = result?.modelGuidance ?? {};
    const guidanceNotes = Array.isArray(guidance?.notes) ? guidance.notes : [];
    const recommendedSetup = Array.isArray(guidance?.recommendedSetup) ? guidance.recommendedSetup : [];
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    const generatedAt = result?.timestamp ?? new Date().toISOString();
    const lines = [
        "# 雷达扫描",
        "",
        `- 生成时间：${generatedAt}`,
        `- 建议数量：${recommendations.length}`,
        `- 检索模式：${guidance?.searchMode ?? "unknown"}`,
        `- 当前模型：${guidance?.currentService ?? guidance?.currentProvider ?? "unknown"} / ${guidance?.currentModel ?? "unknown"}`,
        "",
    ];
    if (sourceHealth.length > 0) {
        lines.push("## 信源健康", "");
        for (const source of sourceHealth) {
            lines.push(`- ${source.platform ?? source.name ?? "信源"}：${source.count ?? 0} 条 / ${source.sourceType ?? "unknown"} / ${source.ok ? "ok" : "needs-check"}${source.warning ? ` / ${source.warning}` : ""}${source.sourceUrl ? ` / ${source.sourceUrl}` : ""}`);
        }
        lines.push("");
    }
    if (guidanceNotes.length > 0 || recommendedSetup.length > 0) {
        lines.push("## 模型与检索提示", "");
        for (const note of guidanceNotes)
            lines.push(`- ${note}`);
        for (const setup of recommendedSetup)
            lines.push(`- 建议：${setup}`);
        lines.push("");
    }
    if (warnings.length > 0) {
        lines.push("## 本次警告", "");
        for (const warning of warnings)
            lines.push(`- ${warning}`);
        lines.push("");
    }
    if (result?.marketSummary) {
        lines.push("## 市场概述", "", String(result.marketSummary), "");
    }
    for (const [index, rec] of recommendations.entries()) {
        lines.push(`## ${index + 1}. ${rec.title ?? rec.concept ?? rec.genre ?? "机会点"}`, "");
        if (rec.platform)
            lines.push(`- 平台：${rec.platform}`);
        if (rec.genre)
            lines.push(`- 类型：${rec.genre}`);
        if (rec.concept)
            lines.push(`- 概念：${rec.concept}`);
        if (typeof rec.confidence === "number")
            lines.push(`- 置信度：${rec.confidence}`);
        if (rec.targetAudience)
            lines.push(`- 读者：${rec.targetAudience}`);
        if (rec.marketSignal)
            lines.push(`- 市场信号：${rec.marketSignal}`);
        if (rec.readerPromise)
            lines.push(`- 读者承诺：${rec.readerPromise}`);
        if (rec.openingHook)
            lines.push(`- 开篇钩子：${rec.openingHook}`);
        if (rec.firstVolumeLoop)
            lines.push(`- 首卷循环：${rec.firstVolumeLoop}`);
        if (rec.rationale)
            lines.push(`- 判断：${rec.rationale}`);
        if (rec.reasoning)
            lines.push(`- 判断：${rec.reasoning}`);
        if (rec.differentiation)
            lines.push(`- 差异化：${rec.differentiation}`);
        if (Array.isArray(rec.benchmarkTitles) && rec.benchmarkTitles.length > 0) {
            lines.push("", "### 对标标题");
            for (const title of rec.benchmarkTitles)
                lines.push(`- ${title}`);
        }
        if (Array.isArray(rec.hooks) && rec.hooks.length > 0) {
            lines.push("", "### 钩子");
            for (const hook of rec.hooks)
                lines.push(`- ${hook}`);
        }
        if (Array.isArray(rec.risks) && rec.risks.length > 0) {
            lines.push("", "### 风险");
            for (const risk of rec.risks)
                lines.push(`- ${risk}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
async function persistRadarArtifacts(root, result) {
    await mkdir(join(root, ".hardwrite"), { recursive: true });
    await writeFile(join(root, ".hardwrite", "radar-latest.json"), JSON.stringify(result, null, 2), "utf-8");
    const label = `雷达扫描-${vaultStamp(new Date(result?.timestamp ?? Date.now()))}`;
    const relativePath = `10-市场机会/${label}.md`;
    await writeVaultFile(root, relativePath, radarMarkdown(result));
    await appendVaultIndexEntry(root, "10-市场机会/雷达扫描列表.md", relativePath, label, result?.timestamp ?? "");
    return relativePath;
}
async function importVaultText(root, input) {
    const type = input?.type === "style" ? "style" : "reference";
    const title = sanitizeVaultName(input?.title, type === "style" ? "风格样本" : "参考素材");
    const text = normalizeMarkdownText(input?.text);
    if (!text) {
        throw new ApiError(400, "EMPTY_CONTENT", "导入内容不能为空");
    }
    const dir = type === "style" ? "40-风格样本" : "30-参考素材";
    const relativePath = `${dir}/${vaultStamp()}-${title}.md`;
    const content = [
        `# ${title}`,
        "",
        `- 类型：${type === "style" ? "风格样本" : "参考素材"}`,
        input?.sourceUrl ? `- 来源：${input.sourceUrl}` : "",
        `- 导入时间：${new Date().toISOString()}`,
        "",
        "## 摘录",
        "",
        text,
        "",
        "## 可学习特征",
        "",
        "- 叙述视角：",
        "- 节奏：",
        "- 句式：",
        "- 情绪温度：",
        "- 可借鉴但不复刻的写法：",
        "",
    ].filter(Boolean).join("\n");
    await writeVaultFile(root, relativePath, content);
    await appendVaultIndexEntry(root, type === "style" ? "40-风格样本/风格样本列表.md" : "30-参考素材/素材列表.md", relativePath, title, input?.sourceUrl ?? "");
    return { relativePath, title, type };
}
function styleProfileMarkdown(profile, input) {
    const title = sanitizeVaultName(input?.title || input?.sourceName || profile?.sourceName || "风格分析");
    const text = normalizeMarkdownText(input?.text);
    const sentenceRange = profile?.paragraphLengthRange
        ? `${profile.paragraphLengthRange.min ?? "-"}-${profile.paragraphLengthRange.max ?? "-"}`
        : "-";
    const list = (value) => Array.isArray(value) && value.length
        ? value.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n")
        : "- 暂无显著模式，建议追加更长样本后复测。";
    return [
        `# ${title}`,
        "",
        "- 类型：风格分析结果",
        `- 来源：${input?.sourceName || profile?.sourceName || "未命名样本"}`,
        `- 样本字数：${text.length}`,
        `- 分析时间：${profile?.analyzedAt || new Date().toISOString()}`,
        "",
        "## 风格指纹摘要",
        "",
        `- 平均句长：${profile?.avgSentenceLength ?? "-"} 字`,
        `- 句长波动：${profile?.sentenceLengthStdDev ?? "-"}`,
        `- 平均段落长度：${profile?.avgParagraphLength ?? "-"} 字`,
        `- 段落长度范围：${sentenceRange}`,
        `- 词汇多样性：${profile?.vocabularyDiversity ?? "-"}`,
        "",
        "## 高频模式",
        "",
        list(profile?.topPatterns),
        "",
        "## 修辞特征",
        "",
        list(profile?.rhetoricalFeatures),
        "",
        "## 给后续 Agent 的使用方式",
        "",
        "- 只抽象学习句式节奏、段落呼吸、叙述视角、情绪推进和对白密度。",
        "- 不复制原文表达、专有角色、独特设定或可识别桥段。",
        "- 写作时优先作为风格约束，而不是剧情素材。",
        "",
        "## 原始样本",
        "",
        text,
        "",
        "## 原始分析 JSON",
        "",
        "```json",
        JSON.stringify(profile ?? {}, null, 2),
        "```",
        "",
    ].join("\n");
}
async function persistStyleAnalysis(root, profile, input) {
    const title = sanitizeVaultName(input?.title || input?.sourceName || profile?.sourceName || "风格分析");
    const relativePath = `40-风格样本/${vaultStamp()}-${title}.md`;
    const content = styleProfileMarkdown(profile, { ...input, title });
    await writeVaultFile(root, relativePath, content);
    await appendVaultIndexEntry(root, "40-风格样本/风格样本列表.md", relativePath, title, profile?.analyzedAt ?? "");
    await mkdir(join(root, ".hardwrite", "style-analyses"), { recursive: true });
    await writeFile(join(root, ".hardwrite", "style-analyses", `${vaultStamp()}-${title}.json`), JSON.stringify({ profile, relativePath, sourceName: input?.sourceName, textLength: String(input?.text ?? "").length }, null, 2), "utf-8");
    return { relativePath, title };
}
async function buildBooksIndex(root, state) {
    const bookIds = await state.listBooks();
    const rows = [];
    for (const id of bookIds) {
        const book = await loadStudioBookListSummary(state, id).catch(() => ({ id, title: id }));
        const title = sanitizeVaultName(book?.title ?? id, id);
        const relativePath = `20-作品档案/${title}.md`;
        const content = [
            `# ${title}`,
            "",
            `- 作品 ID：${id}`,
            book?.language ? `- 语言：${book.language}` : "",
            book?.genre ? `- 类型：${book.genre}` : "",
            book?.chapterCount !== undefined ? `- 章节数：${book.chapterCount}` : "",
            book?.updatedAt ? `- 更新时间：${book.updatedAt}` : "",
            "",
            "## 写作状态",
            "",
            "- 当前目标：",
            "- 下一章重点：",
            "- 风格注意：",
            "",
            "## 关联素材",
            "",
            "- [[30-参考素材/素材列表|参考素材列表]]",
            "- [[40-风格样本/风格样本列表|风格样本列表]]",
            "- [[50-长期记忆/写作记忆|长期写作记忆]]",
            "",
        ].filter(Boolean).join("\n");
        await writeVaultFile(root, relativePath, content);
        rows.push({ id, title, relativePath });
    }
    const listContent = [
        "# 作品列表",
        "",
        ...rows.map((book) => `- [[${book.relativePath.replace(/\.md$/, "")}|${book.title}]] - ${book.id}`),
        "",
    ].join("\n");
    await writeVaultFile(root, "20-作品档案/作品列表.md", listContent);
    return rows;
}
const CREATOR_TEMPLATES = [
    {
        id: "start-writing-path",
        title: "开始写书路径",
        relativePath: "60-模板库/开始写书路径.md",
        description: "从空白到可写正文的最短开书流程。",
        body: [
            "# 开始写书路径",
            "",
            "这页是从空白到可写正文的最短路径。目标不是把设定铺满，而是尽快得到一个能稳定产出章节的写作系统。",
            "",
            "## 10 分钟锁定",
            "",
            "- 题材承诺：读者点开这本书，最想持续获得什么体验？爽、痛、甜、惊、燃、悬疑、陪伴感，只选 1-2 个主承诺。",
            "- 主角欲望：主角现在最想拿到什么？如果拿不到，具体会失去什么？",
            "- 第一冲突：谁阻止主角？阻止的理由是否合理，是否能站在对方利益上成立？",
            "- 世界规则：只写会强迫角色做选择的规则，不写百科。",
            "- 前三章钩子：第一章给行动，第二章给代价，第三章给不可回头的选择。",
            "",
            "## 开写口令",
            "",
            "请按卷舍的高质量写作角色协议，先建立作品骨架、主要角色卡、前三章章节计划，再开始写第 1 章。要求：不编造我没给的前情；每章只保留一个主动作、一条情绪主压强、一个可验证变化；正文要有场景阻力、对白锋面和具体意象，避免报告腔。",
            "",
        ],
    },
    {
        id: "quality-role-protocol",
        title: "高质量写作角色协议",
        relativePath: "60-模板库/高质量写作角色协议.md",
        description: "约束架构师、规划师、写作者、润色师和审稿者，让输出稳定、靠谱、有趣、生动。",
        body: [
            "# 高质量写作角色协议",
            "",
            "这份协议用于约束写作台里的几个核心角色：架构师、规划师、写作者、润色师、审稿者。",
            "",
            "## 共同底线",
            "",
            "- 不伪造：不编造来源素材、前情事件、伏笔 ID、角色已知信息、市场事实或引用。",
            "- 不降智：不能为了推进剧情让角色突然愚蠢、圣母、失忆或无铺垫妥协。",
            "- 不漂移：不为一句漂亮话牺牲世界规则、类型承诺、人物弧线和章节目标。",
            "- 不汇报：正文优先写场景、动作、阻力和对白，不用总结腔替代人物交锋。",
            "- 不堆料：每章只抓一个主动作、一条情绪主压强、一个可验证变化。",
            "",
            "## 架构师",
            "",
            "- 核心设定必须回答“谁想要什么、代价是什么、冲突从哪里持续产生”。",
            "- 世界观不是百科，只保留会逼迫角色做选择的规则。",
            "- 主要角色必须有可爱弱点、见不得人的欲望、旧伤和误信。",
            "- 输出必须让规划师能拆任务、写作者能写活人、审稿者能查错误。",
            "",
            "## 规划师",
            "",
            "- 每章只保留 1 个主动作、1 条情绪主压强、1 个可验证变化。",
            "- 反转必须有前置线索和具体代价，不能靠“突然发现”“原来如此”硬转。",
            "- 同场多角色冲突必须写出不同角色的信息边界和利益算盘。",
            "- 章尾必须留下下一章的行动钩子或情绪缺口。",
            "",
            "## 写作者",
            "",
            "- 写之前先在内部完成任务理解、场景路线、连续性检查和风险点，不把思考过程外露。",
            "- 每个重要动作都由“过往经历 + 当前利益 + 性格底色 + 信息边界”驱动。",
            "- 对话要有牙：每轮对白携带欲望、遮掩、压力、地位变化或误导。",
            "- 具体胜过形容词：用一个动作、一件物品、一处感官细节承载情绪。",
            "",
            "## 润色师与审稿者",
            "",
            "- 润色只改语言、节奏、对白锋面和意象，不擅自新增重大事实和新剧情。",
            "- 审稿优先检查连续性、角色动机、信息边界、节奏断档、章尾钩子和 AI 腔。",
            "- 每个问题必须给出问题位置、伤害阅读的原因和最小修复建议。",
            "",
        ],
    },
    {
        id: "writing-engineering-checklist",
        title: "写作工程约束清单",
        relativePath: "60-模板库/写作工程约束清单.md",
        description: "每章写作前后使用的质量门禁，防止跑题、断档、降智和 AI 腔。",
        body: [
            "# 写作工程约束清单",
            "",
            "这份清单用于每章写作前、写作后和润色前。它的目标是让产出稳定、靠谱、有趣、生动，而不是只靠一次提示词赌运气。",
            "",
            "## 写作前",
            "",
            "- 本章主动作是什么？能不能用一句话说清楚。",
            "- 本章情绪主压强是什么？只选最主要的一条。",
            "- 本章可验证变化是什么？状态、关系、信息、资源、位置、承诺、敌意，至少变一项。",
            "- 本章出现的角色分别知道什么、不知道什么、误判什么。",
            "",
            "## 写作中",
            "",
            "- 每个场景都要有阻力：人阻、事阻、环境阻、内心阻至少一个。",
            "- 每段对话都要有目的：索取、试探、遮掩、威胁、安抚、诱导、反击至少一个。",
            "- 每个关键情绪都用动作或物件落地，不只写“他很痛苦”“她很震惊”。",
            "- 每个解释性段落都要问：能否改成角色行动、对白或现场发现。",
            "",
            "## 写作后",
            "",
            "- 连续性：有没有违反前情、时间线、角色已知信息和世界规则。",
            "- 人物：角色行为是否由过往经历、当前利益、性格底色和信息边界共同驱动。",
            "- 节奏：是否有连续 500 字没有新压力、新信息、新选择或新关系变化。",
            "- 口感：是否有报告腔、翻译腔、万能连接词、空洞形容词和机械反问。",
            "- 钩子：章尾是否留下具体行动期待或情绪缺口。",
            "",
        ],
    },
    {
        id: "one-shot-command-library",
        title: "一键指令库",
        relativePath: "60-模板库/一键指令库.md",
        description: "可直接复制到 Studio Chat 的开书、写章、审稿、润色指令。",
        body: [
            "# 一键指令库",
            "",
            "## 从零开书",
            "",
            "```text",
            "我要开始一本新书。请先按《高质量写作角色协议》工作，不要直接写正文。请依次输出：一句话卖点、读者情绪承诺、主角欲望/恐惧/旧伤/误信、核心冲突与反对者合理性、世界规则、前三章计划。",
            "```",
            "",
            "## 写下一章",
            "",
            "```text",
            "请写下一章。写前先内部检查上一章事实、角色当前状态、信息边界和未回收钩子；正文不要外露分析。章节目标：一个主动作、一条情绪主压强、一个可验证变化。",
            "```",
            "",
            "## 审稿修复",
            "",
            "```text",
            "请按《章节质量评分卡》审稿。先给 100 分制评分，再列出最多 5 个高价值问题。每个问题必须包含：位置、伤害阅读的原因、最小修复建议。",
            "```",
            "",
        ],
    },
    {
        id: "chapter-quality-scorecard",
        title: "章节质量评分卡",
        relativePath: "60-模板库/章节质量评分卡.md",
        description: "100 分制章节质量门禁，低于 80 分先修。",
        body: [
            "# 章节质量评分卡",
            "",
            "- 20 分：主动作清楚。",
            "- 15 分：情绪压强有效。",
            "- 15 分：可验证变化明确。",
            "- 15 分：角色动机成立。",
            "- 10 分：场景有阻力。",
            "- 10 分：对白有锋面。",
            "- 10 分：语言有口感。",
            "- 5 分：章尾有钩子。",
            "",
            "## 一票否决",
            "",
            "- 角色知道了他不该知道的信息。",
            "- 为推进剧情强行降智、强行圣母、强行误会。",
            "- 新设定凭空出现，只为解决当前卡点。",
            "- 章节结束后没有任何状态变化。",
            "",
        ],
    },
    {
        id: "character-voice-fingerprint",
        title: "角色声音指纹表",
        relativePath: "60-模板库/角色声音指纹表.md",
        description: "固定角色语气、说谎方式、发怒方式和动作习惯。",
        body: [
            "# 角色声音指纹表",
            "",
            "| 角色 | 句长 | 用词偏好 | 说谎方式 | 发怒方式 | 示弱方式 | 口头禁区 | 典型动作 |",
            "|------|------|----------|----------|----------|----------|----------|----------|",
            "|      |      |          |          |          |          |          |          |",
            "",
        ],
    },
    {
        id: "opening-triad",
        title: "黄金前三章",
        relativePath: "60-模板库/黄金前三章.md",
        description: "用于开书前锁定题材承诺、主角欲望、第一冲突和前三章钩子。",
        body: [
            "# 黄金前三章",
            "",
            "## 读者承诺",
            "",
            "- 题材/爽点：",
            "- 一句话卖点：",
            "- 读者最想持续追问的问题：",
            "",
            "## 第一章",
            "",
            "- 第一屏画面：",
            "- 主角当下欲望：",
            "- 阻碍：",
            "- 章尾钩子：",
            "",
            "## 第二章",
            "",
            "- 承接上一章的行动：",
            "- 新信息或新代价：",
            "- 反转/误会/选择：",
            "- 章尾钩子：",
            "",
            "## 第三章",
            "",
            "- 世界规则第一次压到主角身上：",
            "- 主角做出的主动选择：",
            "- 长线矛盾露面方式：",
            "- 三章后读者应该记住的承诺：",
            "",
        ],
    },
    {
        id: "character-card",
        title: "人物弧光卡",
        relativePath: "60-模板库/人物弧光卡.md",
        description: "记录角色欲望、误信、弱点、关系张力和不可违背的连续性。",
        body: [
            "# 人物弧光卡",
            "",
            "- 姓名：",
            "- 外在目标：",
            "- 内在缺口：",
            "- 当前误信：",
            "- 最害怕失去的东西：",
            "- 说话节奏/口头习惯：",
            "- 不允许突然知道的信息：",
            "",
            "## 关系张力",
            "",
            "- 与主角：",
            "- 与反派/阻碍者：",
            "- 与秘密：",
            "",
            "## 弧光节点",
            "",
            "- 初始状态：",
            "- 第一次动摇：",
            "- 付出代价：",
            "- 新选择：",
            "",
        ],
    },
    {
        id: "chapter-memo",
        title: "章节执行备忘",
        relativePath: "60-模板库/章节执行备忘.md",
        description: "每章写作前的工程约束，防止跑题、断档和报告腔。",
        body: [
            "# 章节执行备忘",
            "",
            "- 章节编号：",
            "- 本章 POV：",
            "- 本章主行动：",
            "- 本章辅助行动：",
            "- 必须承接的上一章事实：",
            "- 必须避免的误写：",
            "- 章尾钩子：",
            "",
            "## 场景链",
            "",
            "1. 欲望：",
            "2. 阻碍：",
            "3. 变化：",
            "4. 新问题：",
            "",
            "## 风格约束",
            "",
            "- 句子密度：",
            "- 情绪温度：",
            "- 叙事距离：",
            "- 禁止出现的词/腔调：",
            "",
        ],
    },
    {
        id: "style-capture",
        title: "风格抽取卡",
        relativePath: "60-模板库/风格抽取卡.md",
        description: "从参考作品中提炼可学习的技法，而不是复制原文。",
        body: [
            "# 风格抽取卡",
            "",
            "- 来源：",
            "- 适用场景：",
            "",
            "## 可学习特征",
            "",
            "- 叙述视角：",
            "- 信息释放：",
            "- 对话节奏：",
            "- 动作描写密度：",
            "- 情绪推进方式：",
            "",
            "## 不可复制边界",
            "",
            "- 不复刻的人名/设定/句子：",
            "- 只借鉴的技法：",
            "",
        ],
    },
    {
        id: "revision-brief",
        title: "润色标注单",
        relativePath: "60-模板库/润色标注单.md",
        description: "要求 AI 输出修改前后、理由和风险，适合逐段精修。",
        body: [
            "# 润色标注单",
            "",
            "## 输入片段",
            "",
            "",
            "## 润色目标",
            "",
            "- 更强画面：",
            "- 更准动机：",
            "- 更自然对白：",
            "- 保留原意：是",
            "",
            "## 输出要求",
            "",
            "- 给出润色后正文。",
            "- 列出每处关键修改：原句 / 新句 / 原因。",
            "- 标明是否改变事实、视角或角色知识。",
            "- 不要把分析写进正文。",
            "",
        ],
    },
    {
        id: "release-check",
        title: "发布前审稿清单",
        relativePath: "60-模板库/发布前审稿清单.md",
        description: "面向连载发布的章节质量门禁。",
        body: [
            "# 发布前审稿清单",
            "",
            "- [ ] 本章主行动清楚。",
            "- [ ] 角色动机没有突然跳变。",
            "- [ ] 事实连续性与前文一致。",
            "- [ ] 没有报告腔、提纲腔、AI 自述。",
            "- [ ] 风格样本只借鉴技法，没有复刻表达。",
            "- [ ] 章尾留下明确下一步期待。",
            "",
        ],
    },
];
async function ensureVaultTemplates(root) {
    await ensureWritingVault(root);
    for (const template of CREATOR_TEMPLATES) {
        const vault = vaultPath(root);
        const fullPath = join(vault, template.relativePath);
        try {
            await access(fullPath);
        }
        catch {
            await writeVaultFile(root, template.relativePath, template.body.join("\n"));
        }
    }
    const index = [
        "# 模板列表",
        "",
        ...CREATOR_TEMPLATES.map((template) => `- [[${template.relativePath.replace(/\.md$/, "")}|${template.title}]] - ${template.description}`),
        "",
    ].join("\n");
    await writeVaultFile(root, "60-模板库/模板列表.md", index);
}
function normalizeModelList(models) {
    return models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
        ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    }));
}
const XIAOMI_MIMO_SERVICE_ID = "custom:小米 MiMo";
const XIAOMI_MIMO_TEXT_MODELS = [
    { id: "mimo-v2.5-pro", name: "mimo-v2.5-pro" },
    { id: "mimo-v2.5", name: "mimo-v2.5" },
    { id: "mimo-v2-pro", name: "mimo-v2-pro" },
    { id: "mimo-v2-omni", name: "mimo-v2-omni" },
];
function isXiaomiMimoService(service, baseUrl) {
    return service === XIAOMI_MIMO_SERVICE_ID || String(baseUrl ?? "").includes("xiaomimimo.com");
}
function mergeModelLists(models, fallbackModels) {
    const merged = new Map();
    for (const model of [...models, ...fallbackModels]) {
        if (!model?.id)
            continue;
        if (!merged.has(model.id)) {
            merged.set(model.id, {
                id: model.id,
                name: model.name ?? model.id,
                ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
                ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
            });
        }
    }
    return [...merged.values()];
}
function pickModel(models, preferredIds, fallback) {
    for (const preferred of preferredIds) {
        const exact = models.find((model) => model.id === preferred);
        if (exact)
            return exact.id;
    }
    for (const preferred of preferredIds) {
        const partial = models.find((model) => model.id.toLowerCase().includes(preferred.toLowerCase()));
        if (partial)
            return partial.id;
    }
    return fallback;
}
function buildCreatorModelStrategy(project, models, existingOverrides = {}) {
    const currentModel = project.llm.model;
    const proModel = pickModel(models, ["mimo-v2.5-pro", "mimo-v2-pro", "deepseek-v4-pro", "deepseek-reasoner", currentModel], currentModel);
    const fastModel = pickModel(models, ["mimo-v2.5", "mimo-v2-omni", "deepseek-v4-flash", "deepseek-chat", proModel], proModel);
    const overrides = {
        ...existingOverrides,
        architect: { model: proModel, stream: true },
        "foundation-reviewer": { model: proModel, stream: true },
        planner: { model: proModel, stream: true },
        writer: { model: proModel, stream: true },
        reviser: { model: proModel, stream: true },
        polisher: { model: proModel, stream: true },
        auditor: { model: proModel, stream: true },
        "reader-critic": { model: proModel, stream: true },
        "chapter-analyzer": { model: proModel, stream: true },
        "length-normalizer": { model: proModel, stream: true },
        "state-validator": { model: proModel, stream: true },
        "fanfic-canon-importer": { model: proModel, stream: true },
        radar: { model: fastModel, stream: true },
    };
    const stages = [
        { key: "architect", label: "建书/世界观", model: overrides.architect.model, reason: "长设定和事实约束需要更强推理与长上下文。" },
        { key: "planner", label: "章节规划", model: overrides.planner.model, reason: "章节 memo 需要把欲望、阻碍、变化和钩子整理成可执行约束。" },
        { key: "writer", label: "正文写作", model: overrides.writer.model, reason: "使用当前主写作服务的强模型，负责长篇正文稳定输出。" },
        { key: "reviser", label: "润色修订", model: overrides.reviser.model, reason: "修订阶段重视克制、连续性和逐处解释。" },
        { key: "polisher", label: "语言抛光", model: overrides.polisher.model, reason: "抛光阶段要保留原意，同时提升节奏、画面和对白自然度。" },
        { key: "auditor", label: "审稿门禁", model: overrides.auditor.model, reason: "审稿需要稳定发现逻辑、动机和事实问题。" },
        { key: "reader-critic", label: "读者视角", model: overrides["reader-critic"].model, reason: "从读者留存、困惑、期待和爽点角度给出独立分数。" },
        { key: "radar", label: "市场雷达/轻任务", model: overrides.radar.model, reason: fastModel === proModel ? "当前可用模型不足，沿用主模型。" : "轻量扫描优先用更快模型，减少等待。" },
    ];
    return {
        currentModel,
        provider: project.llm.provider,
        service: project.llm.service ?? project.llm.provider,
        baseUrl: project.llm.baseUrl,
        stream: project.llm.stream,
        temperature: project.llm.temperature,
        models,
        stages,
        overrides,
    };
}
const AGENT_PROFILE_DEFS = [
    { id: "architect", label: "架构师", mission: "建书档案、故事圣经、卷纲、规则和伏笔", defaultTemperature: 0.72, defaultPromptPatch: "按长篇连载工程建书，不写概念海报。先定平台读者承诺、主角欲望、长期外压、阶段小目标、可连续 200 章的升级曲线，再落到 story_frame、volume_map、character_matrix、pending_hooks 这些 truth files。参考 GOAT 式自上而下拆解：book spec -> act/volume -> chapter -> scene，但以卷舍 truth files 作为唯一运行源。", defaultHardConstraints: "不得只给题材标签；不得把主角写成万能概念；不得漏掉第一卷 3-5 个可验收小目标；不得让世界规则、角色欲望、反派压力互相独立。所有新事实必须能落到明确 truth file。", defaultOutputFormat: "输出：读者承诺 / 类型卖点 / 主角欲望与代价 / 世界铁律 / 第一卷目标链 / 角色状态种子 / 伏笔池 / 平台节奏 / truth files 写入清单。" },
    { id: "foundation-reviewer", label: "建书复审官", mission: "复审故事圣经的完整性、可执行性和缺段风险", defaultTemperature: 0.35, defaultPromptPatch: "像出版总编和连续性工程师一起审。检查这套基础设定能不能支撑长篇：目标链是否递进，角色是否有可反复受压的欲望，伏笔是否可管理，truth files 是否互相引用一致。复审重点不是漂亮，而是能否让后续 planner/writer 不靠临时编。", defaultHardConstraints: "不得放行空泛世界观；不得接受“以后再补”的关键动机；不得让 story_frame、volume_map、character_matrix、pending_hooks 之间冲突；不得忽略平台定位和黄金开篇。", defaultOutputFormat: "输出：通过/不通过、阻断项、冲突 truth file、缺失字段、必须补写区块、放行后的风险备注。" },
    { id: "style-governor", label: "风格指纹官", mission: "提取模仿样本的叙事指纹，并约束续写口感", defaultTemperature: 0.45, defaultPromptPatch: "抽取的是可迁移技法，不是作者句子。把样本拆成镜头距离、句段呼吸、对白压力、感官密度、信息释放速度、章尾钩子类型、平台口味，并写成 writer 可执行的风格约束。", defaultHardConstraints: "不得复刻专名、原句、独创比喻和标志性表达；不得只写“更有画面感”；不得把风格凌驾于 truth files 和本章任务之上。", defaultOutputFormat: "输出：风格指纹 / 禁用写法 / 可复用技法 / 句段节奏 / 对白样式 / 与本书平台定位的适配说明。" },
    { id: "planner", label: "规划师", mission: "拆解下一章目标、上下文、冲突推进和工程约束", defaultTemperature: 0.55, defaultPromptPatch: "先读 runtime context、chapter_memo、LLM Wiki、human_notes、最近质量报告和 truth files，再规划本章。每章只抓 1 个主动作、1 条情绪压力、1 个可验证变化；把 GOAT 的 scene spec 思路落成场景拍点：人物、地点、时间、事件、冲突、价值变化、结果。", defaultHardConstraints: "不得跳过低分/状态降级章节；不得让新规划覆盖已发生事实；不得开新坑逃避旧 hook；不得写成愿望清单。所有 advance/resolve 的 hook 必须能在正文中被定位。", defaultOutputFormat: "输出：当前任务 / 读者等待 / 场景拍点表 / 必须兑现或暂压的 hook / 人物选择三问 / 章尾变化 / 不要做 / 长上下文裁剪依据。" },
    { id: "writer", label: "写手", mission: "生成正文或基础设定草稿，保证可读、有戏、不断流", defaultTemperature: 0.82, defaultPromptPatch: "把 planner memo 当合同，把 truth files 当事实，把 LLM Wiki 当长期教训。首稿按 90+ 写：每个场景都有想要、阻碍、选择、后果；用动作和细节表现情绪，不用报告腔解释。手机阅读优先，段落有呼吸，开头给压力，结尾给下一章非读不可的变化。", defaultHardConstraints: "只输出可发布正文；不得输出分析、评分、清单或提示词术语；不得跳章、改事实、偷换 POV、复述前文灌水；不得把其他 Agent 的报告混入正文；上下文没有的事实只能绕开，不能编成定论。", defaultOutputFormat: "输出完整章节正文。标题可保留；正文自然分段；不附解释、不附自评、不附 JSON；若接口要求结构化，正文必须在 body/content/revised 字段里完整出现。" },
    { id: "auditor", label: "审稿官", mission: "审事实、连续性、节奏、AI味和缺口", defaultTemperature: 0.3, defaultPromptPatch: "以连续性审稿 + 网文编辑 + 挑剔读者三重视角审。先查 truth files/运行上下文是否被破坏，再看章节目标是否完成、人物选择是否有动机、冲突是否推进、钩子是否兑现、AI 腔是否露出。问题必须能指向可改位置。", defaultHardConstraints: "不得只写“整体不错”；不得用审美偏好代替阻断项；不得放过状态链断档、hook 账不落地、字数灌水、角色降智和平台承诺偏移。", defaultOutputFormat: "输出：总判定 / 分项分数 / critical 阻断项 / 位置化问题 / 主责 Agent / 给 reviser 的具体改写任务 / 是否允许继续。" },
    { id: "reader-critic", label: "读者评审官", mission: "以真实读者视角评估爽点、困惑、期待、弃读风险和追更欲", defaultTemperature: 0.38, defaultPromptPatch: "只站在目标平台读者这一边。判断第一屏想不想滑下去、中段有没有拖、章尾有没有下一章期待、情绪回报是否足够。说人话，不替作者辩护，不讲工程术语。", defaultHardConstraints: "不得审成设定报告；不得忽略开头 800 字和最后 300 字；不得用“可以更好”这种空话；不得把困惑点包装成悬念。", defaultOutputFormat: "输出：追更欲 0-100 / 第一屏钩子 / 中段掉速点 / 困惑点 / 最强读者期待 / 弃读风险 / 优先修复建议。" },
    { id: "reviser", label: "修稿师", mission: "按审稿意见修复硬伤，不擅自换书", defaultTemperature: 0.55, defaultPromptPatch: "复修不是润色。先按质量报告定位低项：若连续卡分，改场景结构和因果链；若字数偏离，压缩或有效扩写；若读者钩子弱，重做章尾变化；若状态冲突，先服从 truth files。目标是一次尽量到 90+，不是多轮小修。", defaultHardConstraints: "必须输出完整修订正文并落库；不得只给建议；不得回到旧版本；不得新增破坏 truth files 的事实；不得为了好看牺牲连续性；不得把审稿意见写进正文。", defaultOutputFormat: "输出完整修订后章节正文；结构化接口中 body/revised/content 必须是完整正文，并可附 changes/reasons 但不能替代正文。" },
    { id: "polisher", label: "润色师", mission: "语言层润色、画面强化、去AI味", defaultTemperature: 0.68, defaultPromptPatch: "只做语言、节奏、细节和对白自然度。删模板句、万能心理解释、重复形容词、过度总结；补可见动作、物件、气味、停顿和潜台词。保持剧情事实和人物立场不变。", defaultHardConstraints: "不得新增关键事实；不得改变人物选择；不得扩写成新剧情；不得把短促压力句全改成长解释；不得抹平角色口吻差异。", defaultOutputFormat: "输出润色后正文或指定片段；必要时附少量修改理由，但正文必须可直接替换。" },
    { id: "chapter-analyzer", label: "章节分析官", mission: "抽取章节状态、人物变化、伏笔和风险", defaultTemperature: 0.35, defaultPromptPatch: "每章后把正文转成可被下一章检索的长期记忆。抽取人物位置、已知信息、关系变化、资源变化、伏笔新增/推进/兑现、世界规则变化、未解决风险，并同步到 truth files/LLM Wiki 需要的结构。", defaultHardConstraints: "不得遗漏会影响下一章的事实；不得把猜测写成已发生；不得只写剧情摘要；不得让 memory.db 与 markdown truth files 表意冲突。", defaultOutputFormat: "输出：章节摘要 / 人物状态表 / 事实变化 / hook 账变化 / 关系与情绪变化 / 下一章风险 / 建议写入的 Wiki 节点。" },
    { id: "length-normalizer", label: "字数治理官", mission: "按目标字数扩写或压缩，保留剧情功能", defaultTemperature: 0.55, defaultPromptPatch: "按目标字数 90%-108% 校准。扩写只能补有效阻力、动作反应、对白承压、场景代价；压缩优先删重复解释、同义情绪、无功能过渡、空镜头。篇幅服务章节功能，不服务字数本身。", defaultHardConstraints: "不得灌水；不得删关键因果、角色转变、hook 兑现和章尾变化；不得把正文压成摘要；不得改变 truth files 已定事实。", defaultOutputFormat: "输出校准后正文，并附：原字数、现字数、处理模式、主要保留/删除/补强点。" },
    { id: "state-validator", label: "状态校验员", mission: "校验真相文件、角色状态机和世界规则", defaultTemperature: 0.25, defaultPromptPatch: "你是 truth files 守门员。把章节正文、chapter_summaries、current_state、character_matrix、pending_hooks、runtime state、LLM Wiki 互相校验。只要状态链不可信，必须暂停或自愈，不能让错误滚到下一章。", defaultHardConstraints: "不得用猜测覆盖真实文件；不得放行状态降级章节；不得为了继续写而忽略冲突；不得把 Wiki 教训当作正文事实，Wiki 只能约束写法。", defaultOutputFormat: "输出：通过/不通过 / 冲突文件 / 冲突事实 / 影响章节 / 自愈建议 / 是否允许续写 / 需更新的 truth files。" },
    { id: "quality-reporter", label: "质量报告官", mission: "生成每章质量报告、失败归因和下一步建议", defaultTemperature: 0.35, defaultPromptPatch: "质量报告要能驱动自动化。评分之外必须给低项、阻断项、失败归因、主责 Agent、下一轮修法和是否允许继续。低于目标分时，报告要让 reviser 知道该换结构、补场景、压字数还是修状态。", defaultHardConstraints: "不得只输出分数；不得假通过；不得把模型失败和文本质量混为一谈；不得缺失失败处理；不得在未达标时让流程继续写下一章。", defaultOutputFormat: "输出：total、metrics、gate、blockers、failureReason、ownerAgent、repairStrategy、nextAction、allowContinue。" },
    { id: "prompt-governor", label: "提示词治理官", mission: "整理失败日志、踩坑清单、Wiki 和质量报告，定期压缩成更先进的角色提示词", defaultTemperature: 0.22, defaultPromptPatch: "你不是另一个写作角色，而是 Prompt Writer + Prompt Reviewer 的治理入口。Prompt Writer 阶段基于失败日志、质量报告、Wiki、human_notes 生成短补丁；Prompt Reviewer 阶段只审这些补丁是否缺字段、互相冲突、过长、缺失败处理、破坏 truth files 或覆盖用户手写内容。只有通过审计的自动治理区块才能写入 agentProfiles。", defaultHardConstraints: "不得无限追加；不得改 truth files 正文事实；不得覆盖用户手写提示词；不得把同一问题写进多个角色造成职责冲突；不得引入 LangChain/外部框架假设；每条补丁必须短、硬、可执行、可审计。", defaultOutputFormat: "输出 JSON：pitfalls[]、wikiLessons[]、promptWriterDraft{agent:{promptPatch,hardConstraints,outputFormat}}、promptReview{pass,issues[],fixedFields[]}、promptPatches{agent:{promptPatch,hardConstraints,outputFormat}}、summaryMarkdown。" },
    { id: "radar", label: "市场雷达", mission: "扫描题材机会、趋势信号和拥挤风险", defaultTemperature: 0.45, defaultPromptPatch: "市场建议必须落到平台、读者承诺、题材差异、开篇钩子和可持续章节机制。不要只列热词，要说明为什么读者会追、第一章怎么承诺、第三章给什么短目标、第一卷靠什么循环。", defaultHardConstraints: "不得把未经验证的平台规律当绝对结论；不得给空泛选题；不得建议与现有 truth files 冲突的卖点；不得只追短刺激而毁长线。", defaultOutputFormat: "输出：平台观察 / 读者承诺 / 题材机会 / 拥挤风险 / 开篇钩子 / 第一卷循环 / 差异化执行清单。" },
    { id: "editor-in-chief", label: "总编", mission: "整章成稿后的编辑裁决：读全部专家信号做整体判断，签发或返工，给规划师下一程方向", defaultTemperature: 0.3, defaultPromptPatch: EDITOR_IN_CHIEF_SYSTEM_PROMPT, defaultHardConstraints: "分数够 ≠ 能签发：读者只是“基本愿意继续”、追读/钩子单项偏低、开头平开、蓄势过久，即使过机器门槛也应返工；人味指数低于红线必返工。", defaultOutputFormat: "输出：签发/返工裁决 + 编辑分 + 总编批语 + 返工派工(reworkTargets) + 下一程方向(nextDirection)。具体 JSON schema 见上方提示词内置说明。" },
    { id: "managing-editor", label: "执行主编", mission: "贯穿全流程的确定性编排：决定下一步调哪个 Agent、管理返工循环与人审节点", defaultTemperature: 0, deterministic: true, defaultPromptPatch: "（执行主编是确定性编排器 / pipeline runner，不是 LLM 写作角色，没有可配置的系统提示词。它按流水线状态机决定下一步调谁、何时返工、何时交人审。此处仅登记职责，不参与提示词配置。）", defaultHardConstraints: "—", defaultOutputFormat: "agent_handoffs / rework_loop_state / run_timeline（确定性产出，非 LLM 生成）。" },
];
function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(min, Math.min(max, n));
}
function limitText(value, max = 5000) {
    return String(value ?? "").replace(/\r\n/g, "\n").slice(0, max);
}
async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
function archiveTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
async function archivePathIfExists(source, archiveRoot, label) {
    if (!await pathExists(source))
        return null;
    await mkdir(archiveRoot, { recursive: true });
    const target = join(archiveRoot, `${label}-${archiveTimestamp()}`);
    await rename(source, target);
    return target;
}
async function historyScopeStartedAtForBook(state, bookId) {
    const book = await state.loadBookConfig(bookId).catch(() => null);
    return book?.historyScopeStartedAt || book?.contentResetAt || book?.createdAt || "";
}
function repairRunScore(run) {
    const results = Array.isArray(run?.results) ? run.results : [];
    const latest = results.length ? results[results.length - 1] : null;
    const n = Number(latest?.scoreAfter ?? latest?.score ?? run?.scoreAfter ?? 0);
    return Number.isFinite(n) ? n : 0;
}
function repairRunPassed(run, targetScore = 80) {
    const results = Array.isArray(run?.results) ? run.results : [];
    const latest = results.length ? results[results.length - 1] : null;
    return Boolean(latest?.pass || run?.pass) && repairRunScore(run) >= targetScore;
}
function repairHistoryForChapter(runs, bookId, chapterNumber, currentRunId = "", limitOrOptions = 8) {
    const options = typeof limitOrOptions === "object" && limitOrOptions ? limitOrOptions : { limit: limitOrOptions };
    const limit = Number(options.limit || 8) || 8;
    const createdAfterMs = options.createdAfter ? new Date(options.createdAfter).getTime() : 0;
    return (Array.isArray(runs) ? runs : [])
        .filter((run) => run && run.id !== currentRunId && run.type === "chapter-quality-repair" && String(run.bookId || "") === String(bookId || ""))
        .filter((run) => {
        if (!Number.isFinite(createdAfterMs) || createdAfterMs <= 0)
            return true;
        const runMs = new Date(run.createdAt || run.updatedAt || 0).getTime();
        return Number.isFinite(runMs) && runMs >= createdAfterMs;
    })
        .filter((run) => {
        const result = Array.isArray(run.results) ? run.results[0] : null;
        return Number(run.chapterNumber ?? result?.chapterNumber ?? 0) === Number(chapterNumber);
    })
        .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
        .slice(0, limit);
}
// 综合分加权(与 buildChapterQualityPayload 的 rawTotal 公式同源)。权重越高、缺口越大 = 对综合分拖累越大。
// 字数(length)不再当"质量维度"加权——达标是平台约束、不是优点;字数偏离由 repairLengthInstruction/lengthMode 单独治理。
const RAW_TOTAL_WEIGHTS = { continuity: 0.28, rhythm: 0.20, reader: 0.20, style: 0.18, readability: 0.14 };
const METRIC_LABELS = { continuity: "连续性/状态链", rhythm: "节奏", length: "篇幅字数", style: "文笔风格", reader: "读者追更欲", readability: "可读性" };
// 定向修复核心:按"(目标分−当前分)×权重"算每个维度对综合分的拖累,只返回拖累最大的 top N(值得改的)。
function weightedRepairTargets(metrics = {}, targetScore = 80, topN = 2) {
    return Object.keys(RAW_TOTAL_WEIGHTS)
        .map((key) => {
            const value = Number(metrics[key] ?? 100);
            const gap = Math.max(0, targetScore - value);
            return { key, label: METRIC_LABELS[key] || key, value, weight: RAW_TOTAL_WEIGHTS[key], drag: Number((gap * RAW_TOTAL_WEIGHTS[key]).toFixed(2)) };
        })
        .filter((m) => m.drag > 0)
        .sort((a, b) => b.drag - a.drag)
        .slice(0, topN);
}
function buildRepairLoopProfile(history, qualityPayload, targetScore, text = "") {
    const q = qualityPayload?.quality ?? qualityPayload ?? {};
    const metrics = q.metrics ?? {};
    const stats = q.stats ?? {};
    const targetChars = Number(stats.targetWordCount || 3000) || 3000;
    const currentChars = Number(stats.chineseChars || countWritingChars(text) || 0) || countWritingChars(text);
    const failedHistory = (Array.isArray(history) ? history : []).filter((run) => !repairRunPassed(run, targetScore));
    const scores = failedHistory.map(repairRunScore).filter((score) => score > 0);
    const recentScores = scores.slice(0, 5);
    const bestScore = scores.length ? Math.max(...scores) : 0;
    const plateau = recentScores.length >= 3 && Math.max(...recentScores) - Math.min(...recentScores) <= 3 && bestScore < targetScore;
    const lowMetrics = Object.entries(metrics)
        .filter(([, value]) => Number(value) < 90)
        .map(([key, value]) => ({ key, value: Number(value) || 0 }))
        .sort((a, b) => a.value - b.value)
        .slice(0, 6);
    const lengthMode = currentChars > targetChars * 1.12 ? "compress" : (currentChars < targetChars * 0.9 ? "expand" : "hold");
    const priorFailures = failedHistory
        .map((run) => limitText(run.failureReason || run.error || run.currentStage || "", 220))
        .filter(Boolean)
        .slice(0, 4);
    return {
        attempts: failedHistory.length,
        recentScores,
        bestScore,
        plateau,
        targetScore,
        targetChars,
        currentChars,
        lengthMode,
        lowMetrics,
        weightedTargets: weightedRepairTargets(metrics, targetScore, 2),
        priorFailures,
    };
}
function repairLengthInstruction(profile) {
    const min = Math.round(Number(profile?.targetChars || 3000) * 0.9);
    const max = Math.round(Number(profile?.targetChars || 3000) * 1.08);
    if (profile?.lengthMode === "compress")
        return `本章当前 ${profile.currentChars} 中文字，已经超出目标。必须压缩到 ${min}-${max} 中文字：删重复解释、空泛心理、拖沓过渡和无效对白，不要继续扩写。`;
    if (profile?.lengthMode === "expand")
        return `本章当前 ${profile.currentChars} 中文字，低于目标。必须扩写到 ${min}-${max} 中文字：补场景阻力、动作反应、对白承压和钩子回扣，不要灌水。`;
    return `本章当前 ${profile?.currentChars ?? "--"} 中文字，篇幅基本可用。维持在 ${min}-${max} 中文字，重点修节奏、沉浸感、可读性和读者追更欲。`;
}
function repairStrategyInstruction(profile) {
    const targets = profile?.weightedTargets || [];
    const lengthMode = profile?.lengthMode === "compress"
        ? "篇幅过长:先压缩超出部分(删重复解释/拖沓过渡),不要扩写"
        : (profile?.lengthMode === "expand" ? "篇幅不足:补有效场景(动作/对白/阻力),不要灌水" : "篇幅可用,不要为改而改变篇幅");
    const plateau = profile?.plateau
        ? "已连续卡在相近分数:对下列维度要换打法(重排该处场景拍点/因果/段落顺序),别再做同义替换。"
        : "";
    if (!targets.length) {
        return `各维度接近达标,只做最小必要的句段微调,其余原文逐段照抄。${lengthMode}。${plateau}`;
    }
    const symptom = {
        continuity: "和前文/设定/人物状态打架的那句、或没结的状态账(伤/债/人情/承诺/暴露)",
        rhythm: "该爆没爆、该喘没喘、拖沓或平开的那一段",
        reader: "章末钩子软、主角选择没代价、读者不想点下一章的那几处",
        style: "句子绕/没画面/花活堆砌、或风格跑偏的那几句",
        readability: "段落组织乱、模板词、读着卡壳的那几处",
    };
    const focus = targets.map((m) => `「${m.label}」(当前 ${m.value} 分,拖累约 ${m.drag};病灶通常在:${symptom[m.key] || "对应维度的具体句段"})`).join("；");
    return [
        `本章综合分主要被这些维度拖累(已按 权重×缺口 排序):${focus}。`,
        `【定向修复·铁律】不要盯着"把维度分数顶上去",要在正文里**定位**上面点到的那几处具体病灶句段,把它们改写到"读者读着不出戏、动机成立、钩子有劲、状态账结清";`,
        `其余已达标的段落/句子必须原文逐段照抄、一字不改。严禁整章推倒重写`,
        `——那会破坏已经写好的部分、score 上下乱跳、还更慢。输出仍是完整正文(未改动处照抄即可)。`,
        `${lengthMode}。${plateau}`,
    ].join("");
}
function repairNextSuggestion(profile, targetScore) {
    if (profile?.lengthMode === "compress")
        return `继续复修会进入“压缩重排”模式：把正文压到目标字数 90%-108%，删除重复解释，再补节奏、沉浸感和读者钩子，目标 ${targetScore}+。`;
    if (profile?.lengthMode === "expand")
        return `继续复修会进入“有效扩写”模式：补真实场景阻力、动作反应和对白承压，避免水字数，目标 ${targetScore}+。`;
    if (profile?.plateau)
        return `继续复修会进入“平台期换打法”模式：不再小修小补，改为重排场景拍点、因果链和追更钩子，目标 ${targetScore}+。`;
    return `继续复修会按本轮低项重写：优先处理 ${((profile?.lowMetrics || []).map((m) => m.key).join("、") || "节奏、沉浸感、可读性和读者追更欲")}，目标 ${targetScore}+。`;
}
function repairCircuitBreakerDecision(history, targetScore) {
    // 取样窗口必须 ≥ 最大文本阈值(14),否则文本类熔断永远凑不够次数 = 死代码。
    const recent = (Array.isArray(history) ? history : []).filter((run) => !repairRunPassed(run, targetScore)).slice(0, 16);
    if (recent.length < 4)
        return { blocked: false };
    const scores = recent.map(repairRunScore).filter((score) => score > 0);
    const failedRuns = recent.filter((run) => run.status === "needs-repair" || run.status === "error" || run.error || run.failureReason || (repairRunScore(run) > 0 && repairRunScore(run) < targetScore));
    const authFailures = failedRuns.filter((run) => /401|未授权|鉴权|api\s*key|API Key|额度|permission|unauthorized/i.test(`${run.error || ""} ${run.failureReason || ""} ${run.currentStage || ""}`));
    // 把 watchdog 看门狗超时文案("低分复修模型等待超过 X 秒,已自动释放锁")也算进超时类,否则会被误归为"文本写不好"。
    const timeouts = failedRuns.filter((run) => /timeout|timed out|超时|heartbeat|等待超过|自动释放锁|心跳/i.test(`${run.error || ""} ${run.failureReason || ""} ${run.currentStage || ""}`));
    const infrastructureFailures = failedRuns.filter((run) => /Backend task lost|service restart|服务重启|lost in-memory owner|释放锁|端口|network|连接中断/i.test(`${run.error || ""} ${run.failureReason || ""} ${run.currentStage || ""}`));
    const textFailedRuns = failedRuns.filter((run) => !authFailures.includes(run) && !timeouts.includes(run) && !infrastructureFailures.includes(run));
    const bestScore = scores.length ? Math.max(...scores) : 0;
    const latestScore = scores[0] || 0;
    const plateau = scores.length >= 4 && Math.max(...scores.slice(0, 4)) - Math.min(...scores.slice(0, 4)) <= 2 && bestScore < targetScore;
    if (authFailures.length >= 2) {
        return {
            blocked: true,
            transient: true, // 基础设施失败(Key/额度),不是"这本书文本写不好";直播/批量可退避重试,UI 应提示修 Key 而非"质量不行"
            category: "infrastructure",
            reason: "模型鉴权连续失败",
            message: "同一章已经连续出现模型鉴权/API Key/额度失败。已暂停复修，不再烧 token；这是凭证/额度问题、与本书质量无关——请在 Agent 配置里修好 Key 或换可用模型后重试（直播模式会自动退避重试）。",
            bestScore,
            latestScore,
            attempts: recent.length,
        };
    }
    if (timeouts.length >= 3) {
        return {
            blocked: true,
            transient: true, // 模型超时是基础设施抖动,不是文本质量差;不应被永久 block,退避后可继续
            category: "infrastructure",
            reason: "模型超时连续失败",
            message: "同一章已经多次模型超时。已暂停复修避免撞墙；这是网络/模型速度问题、与本书质量无关——可换更快模型、降低单章字数后重试（直播模式会自动退避重试）。",
            bestScore,
            latestScore,
            attempts: recent.length,
        };
    }
    if ((textFailedRuns.length >= 10 && plateau && bestScore < targetScore - 2) || textFailedRuns.length >= 14) {
        return {
            blocked: true,
            reason: plateau ? "复修分数平台期" : "文本复修失败次数过多",
            message: `同一章已有 ${textFailedRuns.length} 次文本复修没有达标，最好分 ${bestScore || "--"}，仍未到 ${targetScore}+。系统已停止盲目小修；下一步应触发策略重置、换模型或人工处理阻断项。`,
            bestScore,
            latestScore,
            attempts: textFailedRuns.length,
        };
    }
    return { blocked: false, bestScore, latestScore, attempts: recent.length, textAttempts: textFailedRuns.length, ignoredInfrastructureFailures: infrastructureFailures.length };
}
export function qualityHasCriticalBlocker(qualityPayload) {
    const q = qualityPayload?.quality ?? qualityPayload ?? {};
    const blockers = q.gate?.blockers ?? [];
    const reasons = q.reasons ?? [];
    const stats = q.stats ?? {};
    // Path B:只认"硬伤"critical(死亡/矛盾等确定性硬伤),软 critical 不再当硬阻断——否则一条 LLM 软 critical
    // 会让自动复修链 pass=false 永远 continue 空转复修(与门禁脱节)。hardCriticals 缺失(旧 payload)才回退总数。
    return Number(stats.hardCriticals ?? stats.criticals ?? 0) > 0
        || blockers.some((item) => /critical-audit|state-degraded|状态/i.test(String(item)))
        || reasons.some((item) => /硬伤|状态不可信|状态链/i.test(String(item)));
}
function adaptiveRepairRoundPlan(profile, qualityPayload, targetScore, requestedMaxRounds, envMaxRounds, adaptiveEnabled = true) {
    const q = qualityPayload?.quality ?? qualityPayload ?? {};
    const score = Number(q.total || 0);
    const gap = Math.max(0, targetScore - score);
    const critical = qualityHasCriticalBlocker(q);
    const lowKeys = (profile?.lowMetrics || []).map((item) => item.key);
    const hasReaderRisk = lowKeys.some((key) => /reader|hook|immersion|rhythm|clarity/i.test(String(key)));
    const hasLengthRisk = profile?.lengthMode === "compress" || profile?.lengthMode === "expand";
    const hardCap = Math.max(1, Math.min(3, Number(envMaxRounds || 1)));
    const requestCap = Math.max(1, Math.min(hardCap, Number(requestedMaxRounds || hardCap)));
    if (!adaptiveEnabled) {
        return {
            maxRounds: requestCap,
            mode: "manual-cap",
            reason: `已关闭自适应，按请求上限 ${requestCap} 轮执行。`,
        };
    }
    let maxRounds = 1;
    let mode = "single-strong-rewrite";
    let reason = "默认先做一次完整强修，避免无脑多轮重写。";
    if (profile?.plateau || Number(profile?.attempts || 0) >= 8) {
        mode = "strategy-reset-once";
        reason = "检测到复修平台期或历史尝试过多，只允许一次换打法强修，未过则停下整理阻断项。";
    }
    else if (gap <= 2 && !critical) {
        maxRounds = 2;
        mode = "near-pass-polish";
        reason = "离 90+ 很近且无 critical，允许一次强修后再做一次小范围收口。";
    }
    else if (gap <= 5) {
        maxRounds = 2;
        mode = critical ? "critical-surgery" : "targeted-rewrite";
        reason = critical
            ? "分数接近但存在 critical，允许先修状态/硬伤，再视收益做一次收口。"
            : "中低风险低分，允许一次结构修复和一次定向补强。";
    }
    else if (gap <= 10 && (critical || hasReaderRisk || hasLengthRisk)) {
        maxRounds = 2;
        mode = critical ? "critical-surgery" : (hasLengthRisk ? "length-rhythm-rebuild" : "reader-hook-rebuild");
        reason = "低项集中且可能可修，允许两轮：先重构关键问题，再复审决定是否收口。";
    }
    else {
        mode = "deep-rewrite-once";
        reason = "差距较大，先做一次深度重写；如果仍低分，不自动连烧，转为策略治理。";
    }
    maxRounds = Math.max(1, Math.min(requestCap, maxRounds));
    return { maxRounds, mode, reason, gap, critical, hasReaderRisk, hasLengthRisk };
}
function adaptiveRepairInstruction(plan, autoRound, maxAutoRounds) {
    const modeText = {
        "manual-cap": "按手动轮次上限执行，但每轮仍必须复审真实评分。",
        "single-strong-rewrite": "一次强修：把最低项直接写进正文，不要把关键问题留到下一轮。",
        "strategy-reset-once": "平台期换打法：禁止句子级微调，必须重排场景拍点、因果链和章尾期待。",
        "near-pass-polish": "近线收口：优先处理剩余低项和阻断项，不要大改已经有效的段落。",
        "critical-surgery": "硬伤手术：先修状态链、事实连续性、人物动机和 critical，再补读者钩子。",
        "targeted-rewrite": "定向重写：围绕最低 2-3 个指标重排段落节奏，不做泛泛润色。",
        "length-rhythm-rebuild": "篇幅节奏重建：先把字数拉回 90%-108%，再处理节奏和沉浸感。",
        "reader-hook-rebuild": "读者钩子重建：补阻碍、选择、代价、章尾期待，提升追更欲。",
        "deep-rewrite-once": "深度重写：差距较大，必须一次性改结构、动机、节奏和可读性。",
    }[plan?.mode] || "自适应复修：按当前低项决定修法。";
    return `自适应复修计划：第 ${autoRound}/${maxAutoRounds} 轮，模式 ${plan?.mode || "adaptive"}。${plan?.reason || ""} ${modeText}`;
}
function adaptiveRepairContinuationDecision({ qualityBefore, qualityAfter, targetScore, autoRound, maxAutoRounds, repairProfileAfter }) {
    const before = Number(qualityBefore?.quality?.total ?? qualityBefore?.total ?? 0);
    const after = Number(qualityAfter?.quality?.total ?? qualityAfter?.total ?? 0);
    // "已达标"必须同时满足:门禁过 + 分够 + 没有未清的 critical 硬伤。
    // 否则会出现"综合分够了就停、但仍留着 critical(如 hook 账没结/禁句/字数)→ 最终被判 audit-failed"的早停 bug。
    const pass = qualityAfter?.quality?.gate?.pass === true && Number.isFinite(after) && after >= targetScore && !qualityHasCriticalBlocker(qualityAfter);
    if (pass)
        return { continue: false, reason: "已达标", gain: after - before, gap: 0 };
    if (autoRound >= maxAutoRounds)
        return { continue: false, reason: `已到自适应轮次上限 ${maxAutoRounds}，停止自动复修。`, gain: after - before, gap: Math.max(0, targetScore - after) };
    if (!before || !after)
        return { continue: false, reason: "复审分数缺失，停止自动复修，避免盲修。", gain: 0, gap: targetScore };
    const gain = after - before;
    const gap = Math.max(0, targetScore - after);
    const critical = qualityHasCriticalBlocker(qualityAfter);
    // 硬伤优先:只要还有未清的 critical(硬伤),就不能因"平台期/微降/低收益"提前退出——critical 留着=必然 needs-repair。
    // 仍受 maxAutoRounds 上限约束(上面已检查),不会死循环;仅当本轮明显恶化(gain<-3)才放弃,以免越改越差。
    if (critical && Number.isFinite(gain) && gain >= -3)
        return { continue: true, reason: `仍有未清 critical 硬伤(本轮 ${gain >= 0 ? "+" : ""}${gain} 分),再做一次定向硬伤手术,优先清除 critical。`, gain, gap, mode: "critical-surgery" };
    if (repairProfileAfter?.plateau)
        return { continue: false, reason: "检测到平台期，停止自动复修并交给提示词治理。", gain, gap };
    if (gain < 0)
        return { continue: false, reason: `本轮分数下降 ${Math.abs(gain)} 分，停止自动复修。`, gain, gap };
    if (gain < (autoRound <= 1 ? 2 : 1))
        return { continue: false, reason: `本轮收益只有 ${gain} 分，不再继续堆草稿。`, gain, gap };
    if (gap <= 2)
        return { continue: true, reason: `距离目标只差 ${gap} 分，进入收口补强。`, gain, gap, mode: "near-pass-polish" };
    if (gap <= 5 && gain >= 2)
        return { continue: true, reason: `已提升 ${gain} 分，仍差 ${gap} 分，允许一次定向补强。`, gain, gap, mode: critical ? "critical-surgery" : "targeted-rewrite" };
    if (critical && gap <= 8 && gain >= 4)
        return { continue: true, reason: `critical 仍在但本轮提升 ${gain} 分，允许一次硬伤手术。`, gain, gap, mode: "critical-surgery" };
    return { continue: false, reason: `仍差 ${gap} 分且收益不足以支撑下一轮，停止自动复修。`, gain, gap };
}
function qualityLessonsFromResults(results, targetScore) {
    const repaired = (Array.isArray(results) ? results : []).filter((item) => item && item.skipped === false);
    if (!repaired.length)
        return "";
    const lines = repaired.slice(-12).map((item) => {
        const before = item.scoreBefore ?? "--";
        const after = item.scoreAfter ?? "--";
        return `- 第 ${item.chapterNumber} 章复修 ${before} -> ${after}：后续新章先把字数控制在目标 90%-108%，再检查节奏、沉浸感、可读性、清晰度和读者追更欲，写完即按 ${targetScore}+ 标准自检，不要等低分后再补救。`;
    });
    return [
        `## 自动质量流水线经验 ${new Date().toISOString()}`,
        "",
        `目标分：${targetScore}+。以下章节已经过复修，后续写作必须先吸取这些失败原因，首稿争取直接达到 90+：`,
        ...lines,
        "",
        "后续写作硬要求：",
        "- 每章先给明确场景目标、人物动作反应、情绪锚点和结尾追更钩子。",
        "- 避免为了补字数堆解释；如果字数超标，优先删重复说明和拖沓过渡。",
        "- 审稿前先自查 rhythm、readability、immersion、clarity；任一低于 90 时先修正文再交质量报告。",
        "",
    ].join("\n");
}
const PROMPT_GOVERNANCE_START = "<!-- AUTO_PROMPT_GOVERNANCE:START -->";
const PROMPT_GOVERNANCE_END = "<!-- AUTO_PROMPT_GOVERNANCE:END -->";
const PROMPT_GOVERNANCE_AGENTS = [
    "architect", "foundation-reviewer", "style-governor", "planner", "writer", "auditor",
    "reader-critic", "reviser", "polisher", "chapter-analyzer", "length-normalizer",
    "state-validator", "quality-reporter", "prompt-governor", "radar",
];
const PROMPT_FIELD_LIMITS = {
    promptPatch: 2600,
    hardConstraints: 1400,
    outputFormat: 900,
};
function uniqueLines(lines, limit = 14) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(lines) ? lines : []) {
        const line = limitText(raw, 260).trim().replace(/\s+/g, " ");
        if (!line || seen.has(line))
            continue;
        seen.add(line);
        out.push(line);
        if (out.length >= limit)
            break;
    }
    return out;
}
function governanceBlock(text) {
    const body = limitText(text, 2600).trim();
    if (!body)
        return "";
    return `${PROMPT_GOVERNANCE_START}\n${body}\n${PROMPT_GOVERNANCE_END}`;
}
function replaceGovernanceBlock(existing, text) {
    const manual = String(existing ?? "").replace(new RegExp(`${PROMPT_GOVERNANCE_START}[\\s\\S]*?${PROMPT_GOVERNANCE_END}`, "g"), "").trim();
    const block = governanceBlock(text);
    return [limitText(manual, 5200), block].filter(Boolean).join("\n\n").slice(0, 8000);
}
function qualityGovernanceLines(qualitySummary) {
    const chapters = Array.isArray(qualitySummary?.chapters) ? qualitySummary.chapters : [];
    return chapters
        .filter((item) => Number(item.quality?.total || 0) < 90 || item.quality?.gate?.pass === false)
        .sort((a, b) => Number(a.quality?.total || 0) - Number(b.quality?.total || 0))
        .slice(0, 12)
        .map((item) => {
        const q = item.quality || {};
        const lows = Object.entries(q.metrics || {})
            .filter(([, value]) => Number(value) < 90)
            .sort((a, b) => Number(a[1]) - Number(b[1]))
            .slice(0, 4)
            .map(([key, value]) => `${key}:${value}`)
            .join("、");
        const reasons = (q.reasons || []).slice(0, 2).join("；");
        return `第 ${item.chapterNumber} 章 ${q.total ?? "--"} 分，低项 ${lows || "未识别"}；${reasons || "需要复核节奏、沉浸感和追更钩子"}`;
    });
}
function runGovernanceLines(runs, bookId) {
    return (Array.isArray(runs) ? runs : [])
        .filter((run) => !bookId || String(run.bookId || "") === String(bookId))
        .filter((run) => run.status === "error" || run.status === "needs-repair" || run.failureReason || run.error)
        .slice(0, 24)
        .map((run) => {
        const direct = Number(run?.chapterNumber ?? run?.results?.[0]?.chapterNumber ?? run?.currentChapter ?? 0);
        const match = String(run?.currentStage || "").match(/第\s*(\d+)\s*章/);
        const chapter = Number.isInteger(direct) && direct > 0 ? direct : (match ? Number(match[1]) : 0);
        const score = run.results?.[0]?.scoreAfter ?? run.results?.[0]?.score ?? "";
        return `${run.type || "run"}${chapter ? ` 第 ${chapter} 章` : ""}${score !== "" ? ` ${score} 分` : ""}：${run.failureReason || run.error || run.currentStage || "未达标"}`;
    });
}
function activityGovernanceLines(entries, bookId) {
    return (Array.isArray(entries) ? entries : [])
        .filter((entry) => !bookId || !entry.data?.bookId || String(entry.data.bookId) === String(bookId))
        .filter((entry) => entry.severity === "error" || entry.failureReason || /needs-repair|error|失败|未达标/i.test(`${entry.event} ${entry.summary}`))
        .slice(0, 18)
        .map((entry) => `${entry.displayTime || entry.timestamp || ""} ${entry.summary || entry.event}${entry.suggestion ? `；建议：${entry.suggestion}` : ""}`);
}
function promptPatchFromLessons(agent, lines, targetScore = 80) {
    const bullets = uniqueLines(lines, 10).map((line) => `- ${line}`).join("\n") || "- 暂无新增失败样本；继续遵守基础角色职责。";
    const common = `## 自动复盘精华\n目标：后续章节首稿争取 ${targetScore}+，不要等低分后再补救。\n这些经验来自失败日志、质量报告、LLM Wiki、human_notes 和 task runs。它们约束写法与流程，不直接改写 truth files 事实。\n${bullets}`;
    const map = {
        planner: `${common}\n规划时把失败样本转成下一章的场景规格：人物/地点/事件/冲突/价值变化/结果。先查低分和状态降级，再决定能不能写下一章。`,
        writer: `${common}\n写正文前先默检：场景目标、动作反应、情绪锚点、有效阻力、章末变化、truth files 连续性和字数 90%-108%。正文里不要出现提示词、报告、清单。`,
        auditor: `${common}\n审稿时把这些坑转成可定位阻断项；发现同类问题必须给 reviser 明确改写任务，包含位置、原因、修法和是否暂停。`,
        reviser: `${common}\n复修先判断是压缩、有效扩写、结构重排还是状态修复。连续失败时禁止句子级小修，必须重组因果链、场景顺序和读者钩子。`,
        polisher: `${common}\n润色优先删模板腔、重复解释、万能心理和无功能过渡；只补动作、物件、感官、停顿和潜台词，不改事实。`,
        "state-validator": `${common}\n把失败样本当成状态链风险清单。正文、chapter_summaries、current_state、character_matrix、pending_hooks、Wiki 互相冲突时先暂停或自愈。`,
        "quality-reporter": `${common}\n报告必须写清失败归因、低项、阻断项、主责 Agent、下一轮修法和是否允许继续；未达标不得放行。`,
        "prompt-governor": `${common}\n内部按 Prompt Writer -> Prompt Reviewer 两阶段工作：先生成短补丁，再审字段完整、职责冲突、长度、失败处理和 truth files 安全，最后只更新自动治理区块。`,
    };
    return map[agent] || common;
}
function governanceHardConstraints(agent) {
    const map = {
        writer: "必须读取自动复盘精华；不得重复已记录失败写法；不得跳章、改事实、灌水或把报告混进正文；truth files 和 runtime context 优先于灵感。",
        reviser: "必须输出完整正文；不得只给建议；连续复修平台期必须换结构打法；修复后仍要满足 truth files、字数和读者追更钩子。",
        auditor: "必须把低分原因转成可执行阻断项；不得用空泛赞美放行；必须标注主责 Agent 和失败处理。",
        "quality-reporter": "未达目标分必须保留复修任务并写明下一步；不得假通过；不得把模型鉴权失败伪装成文本质量失败。",
        "prompt-governor": "必须压缩、去重、保留精华；不得无限追加；不得覆盖用户手写提示词；不得新增与 truth files 冲突或引入外部框架假设的补丁。",
    };
    return map[agent] || "必须读取自动复盘精华，并避免重复最近失败原因。";
}
function governanceOutputFormat(agent) {
    if (agent === "prompt-governor")
        return "输出 JSON：pitfalls[]、wikiLessons[]、promptWriterDraft{agent:{promptPatch,hardConstraints,outputFormat}}、promptReview{pass,issues[],fixedFields[]}、promptPatches{agent:{promptPatch,hardConstraints,outputFormat}}、summaryMarkdown。";
    if (agent === "quality-reporter")
        return "输出：总分、分项、阻断项、失败归因、下一轮修法、是否允许继续。";
    if (agent === "auditor")
        return "输出：是否通过、阻断项、具体问题、修稿任务、风险等级。";
    if (agent === "reviser")
        return "输出完整修订正文；如果协议要求 JSON，则 revised/body 必须是完整正文。";
    if (agent === "writer")
        return "只输出章节正文，不输出计划、评分、解释或元注释。";
    return "输出必须结构化、可落库、可被下一角色直接执行。";
}
function normalizePromptPatchEntry(agent, patch, fallbackLines, targetScore) {
    const base = patch && typeof patch === "object" ? patch : {};
    const fallback = {
        promptPatch: promptPatchFromLessons(agent, fallbackLines, targetScore),
        hardConstraints: governanceHardConstraints(agent),
        outputFormat: governanceOutputFormat(agent),
    };
    const fixed = {};
    for (const field of ["promptPatch", "hardConstraints", "outputFormat"]) {
        const raw = String(base[field] ?? "").trim() || fallback[field];
        fixed[field] = limitText(raw, PROMPT_FIELD_LIMITS[field]).trim();
    }
    return fixed;
}
function hasNegatedPromptPrefix(text, index) {
    const prefix = String(text || "").slice(Math.max(0, index - 24), index).replace(/\s+/g, " ").trim();
    return /(不|不得|不要|禁止|不能|不可|不直接|不允许|严禁|避免|无需|拒绝|保留|只替换|never|must not|do not|don't|avoid).{0,16}$/i.test(prefix);
}
function hasPositivePromptIntent(text, patterns) {
    const normalized = String(text || "").replace(/\s+/g, " ");
    return patterns.some((pattern) => {
        const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
        const re = new RegExp(pattern.source, flags);
        let match;
        while ((match = re.exec(normalized))) {
            if (!hasNegatedPromptPrefix(normalized, match.index))
                return true;
            if (!match[0])
                re.lastIndex += 1;
        }
        return false;
    });
}
const PROMPT_ROLE_CONFLICTS = {
    writer: [{ field: "promptPatch", patterns: [/负责审稿|进行审稿|给(章节|正文|文本|内容|作品).{0,12}评分|打分|产出质量报告|执行复修|复修正文|改写其他章节/i], message: "writer 补丁疑似承担审稿/复修职责，需保持只写当前章节正文。" }],
    auditor: [{ field: "promptPatch", patterns: [/改写正文|重写正文|续写正文|生成正文/i], message: "auditor 补丁疑似直接改正文，需保持只评分、定位问题和给修复指令。" }],
    reviser: [{ field: "outputFormat", patterns: [/只给建议|仅给建议|只指出问题|不输出正文/i], message: "reviser 补丁疑似只给建议，复修必须交付完整修订正文。" }],
    polisher: [{ field: "promptPatch", patterns: [/新增剧情|改变事实|改设定|改伏笔/i], message: "polisher 补丁疑似改变事实，润色只能改语言和节奏。" }],
    "state-validator": [{ field: "promptPatch", patterns: [/新增剧情|编造事实|改正文/i], message: "state-validator 补丁疑似生成剧情，状态校验只能验证并写回状态差异。" }],
    "quality-reporter": [{ field: "promptPatch", patterns: [/改写正文|续写正文|生成正文/i], message: "quality-reporter 补丁疑似写正文，质量报告只能汇总分数、问题和下一步动作。" }],
    "prompt-governor": [{ field: "promptPatch", patterns: [/写正文|生成章节|改写正文|修改\s*truth files|改写\s*truth files/i], message: "prompt-governor 补丁疑似越权写正文或改 truth files，只能治理提示词。" }],
};
function reviewPromptGovernanceDigest(digest, targetScore = 80) {
    const source = digest?.promptWriterDraft || digest?.promptPatches || {};
    const fallbackLines = [...(digest?.pitfalls || []), ...(digest?.wikiLessons || [])];
    const fixedPatches = {};
    const issues = [];
    const fixedFields = [];
    for (const agent of PROMPT_GOVERNANCE_AGENTS) {
        const raw = source?.[agent] || {};
        const fixed = normalizePromptPatchEntry(agent, raw, fallbackLines, targetScore);
        for (const field of ["promptPatch", "hardConstraints", "outputFormat"]) {
            const value = String(raw?.[field] ?? "").trim();
            if (!value) {
                issues.push({ agent, field, severity: "fixed", message: "缺字段，已由 Prompt Reviewer 用确定性模板补齐。" });
                fixedFields.push(`${agent}.${field}`);
            }
            if (value.length > PROMPT_FIELD_LIMITS[field]) {
                issues.push({ agent, field, severity: "fixed", message: `字段过长，已压缩到 ${PROMPT_FIELD_LIMITS[field]} 字以内。` });
                fixedFields.push(`${agent}.${field}`);
            }
        }
        const joined = `${fixed.promptPatch}\n${fixed.hardConstraints}\n${fixed.outputFormat}`;
        if (hasPositivePromptIntent(joined, [/覆盖用户手写/i, /删除用户/i, /重置用户/i])) {
            issues.push({ agent, field: "hardConstraints", severity: "critical", message: "补丁疑似要求覆盖用户手写提示词，禁止应用。" });
        }
        if (hasPositivePromptIntent(joined, [/改\s*truth files/i, /改写\s*truth files/i, /修改\s*truth files/i, /覆盖\s*truth files/i, /重置\s*truth files/i, /忽略\s*truth/i, /跳过\s*truth/i])) {
            issues.push({ agent, field: "hardConstraints", severity: "critical", message: "补丁疑似破坏 truth files 优先级，禁止应用。" });
        }
        for (const rule of PROMPT_ROLE_CONFLICTS[agent] || []) {
            if (hasPositivePromptIntent(joined, rule.patterns)) {
                issues.push({ agent, field: rule.field, severity: "fixed", message: `${rule.message} 已追加职责边界。` });
                fixed.hardConstraints = limitText(`${fixed.hardConstraints}\n${rule.message}`, PROMPT_FIELD_LIMITS.hardConstraints).trim();
                fixedFields.push(`${agent}.hardConstraints`);
            }
        }
        if (hasPositivePromptIntent(joined, [/全部历史|所有章节|全量上下文|完整长上下文|把所有内容都带上/i])) {
            issues.push({ agent, field: "promptPatch", severity: "fixed", message: "补丁疑似要求全量上下文，已追加长上下文预算约束。" });
            fixed.promptPatch = limitText(`${fixed.promptPatch}\n长篇上下文只读取当前章节所需事实、最近摘要、活跃伏笔、角色状态、Wiki 精华和质量失败摘要。`, PROMPT_FIELD_LIMITS.promptPatch).trim();
            fixedFields.push(`${agent}.promptPatch`);
        }
        if (hasPositivePromptIntent(joined, [/LangChain/i, /CrewAI/i, /AutoGen/i])) {
            issues.push({ agent, field: "promptPatch", severity: "fixed", message: "补丁引入外部编排框架假设，已追加卷舍原生管线约束。" });
            fixed.promptPatch = limitText(`${fixed.promptPatch}\n本系统使用卷舍 PipelineRunner/StateManager/truth files，不假设 LangChain、CrewAI 或 AutoGen。`, PROMPT_FIELD_LIMITS.promptPatch).trim();
            fixedFields.push(`${agent}.promptPatch`);
        }
        if (["auditor", "reviser", "quality-reporter", "prompt-governor"].includes(agent) && !/失败|未达标|阻断|Gate|修复|review|Reviewer/i.test(joined)) {
            issues.push({ agent, field: "promptPatch", severity: "fixed", message: "缺失败处理，已追加失败闭环要求。" });
            fixed.promptPatch = limitText(`${fixed.promptPatch}\n必须说明失败时谁接手、如何复修、何时暂停、何时允许继续。`, PROMPT_FIELD_LIMITS.promptPatch).trim();
            fixedFields.push(`${agent}.promptPatch`);
        }
        fixedPatches[agent] = fixed;
    }
    const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
    return {
        pass: criticalCount === 0,
        issues,
        fixedFields: uniqueLines(fixedFields, 60),
        promptPatches: fixedPatches,
        checkedAgents: PROMPT_GOVERNANCE_AGENTS,
    };
}
async function buildPromptGovernanceDigest(root, state, bookId = "", targetScore = 80) {
    const runs = await loadTaskRuns(root).catch(() => []);
    const activities = await readActivityEntries(root, 220).catch(() => []);
    const quality = bookId ? await buildBookQualitySummary(state, bookId).catch(() => null) : null;
    const wiki = bookId ? await buildBookWiki(state, root, bookId).catch(() => null) : null;
    const runLines = runGovernanceLines(runs, bookId);
    const activityLines = activityGovernanceLines(activities, bookId);
    const qualityLines = qualityGovernanceLines(quality);
    const wikiLessons = uniqueLines((wiki?.nodes || [])
        .filter((node) => /notes|rules|style|memory|plot|focus|hooks|wiki/i.test(`${node.type} ${node.group}`))
        .map((node) => `${node.group || node.type} / ${node.title}：${markdownExcerpt(node.body || "", 180)}`), 10);
    const pitfalls = uniqueLines([...qualityLines, ...runLines, ...activityLines], 16);
    const promptWriterDraft = Object.fromEntries(PROMPT_GOVERNANCE_AGENTS.map((agent) => [agent, {
            promptPatch: promptPatchFromLessons(agent, [...pitfalls, ...wikiLessons], targetScore),
            hardConstraints: governanceHardConstraints(agent),
            outputFormat: governanceOutputFormat(agent),
    }]));
    const reviewBase = { bookId, targetScore, pitfalls, wikiLessons, promptWriterDraft, promptPatches: promptWriterDraft };
    const promptReview = reviewPromptGovernanceDigest(reviewBase, targetScore);
    const promptPatches = promptReview.promptPatches || Object.fromEntries(PROMPT_GOVERNANCE_AGENTS.map((agent) => [agent, normalizePromptPatchEntry(agent, promptWriterDraft[agent], [...pitfalls, ...wikiLessons], targetScore)]));
    const summaryMarkdown = [
        `# 提示词治理复盘 ${new Date().toISOString()}`,
        "",
        bookId ? `- 作品：${bookId}` : "- 作品：全局",
        `- 目标分：${targetScore}+`,
        `- 低分章节：${quality?.summary?.lowCount ?? 0}`,
        "",
        "## 踩坑清单",
        ...(pitfalls.length ? pitfalls.map((line) => `- ${line}`) : ["- 暂无可归纳失败样本。"]),
        "",
        "## Wiki / 长期记忆精华",
        ...(wikiLessons.length ? wikiLessons.map((line) => `- ${line}`) : ["- 暂无新增 Wiki 精华。"]),
        "",
        "## 更新策略",
        "- 只替换每个 Agent 提示词中的 AUTO_PROMPT_GOVERNANCE 区块。",
        "- 用户手写的提示词、硬约束和输出格式会保留。",
        "- 每次治理都会压缩、去重、保留最近高价值失败原因。",
        "",
        "## Prompt Reviewer 审计",
        `- 结论：${promptReview.pass ? "通过" : "存在 critical 阻断，禁止自动应用"}`,
        `- 已检查角色：${promptReview.checkedAgents.join("、")}`,
        `- 自动补齐/压缩字段：${promptReview.fixedFields.length || 0}`,
        ...(promptReview.issues.length ? promptReview.issues.slice(0, 12).map((issue) => `- ${issue.agent}.${issue.field}：${issue.message}`) : ["- 未发现字段缺失、职责冲突、过长或失败处理缺口。"]),
        "",
    ].join("\n");
    return { bookId, targetScore, pitfalls, wikiLessons, promptWriterDraft, promptReview, promptPatches, summaryMarkdown, qualitySummary: quality?.summary ?? null, generatedAt: new Date().toISOString() };
}
async function applyPromptGovernanceDigest(root, state, bookId, digest, targetScore = 80, warnings = []) {
    const reviewBase = {
        ...digest,
        promptWriterDraft: digest?.promptWriterDraft || digest?.promptPatches || {},
        promptPatches: digest?.promptWriterDraft || digest?.promptPatches || {},
    };
    const promptReview = reviewPromptGovernanceDigest(reviewBase, targetScore);
    if (promptReview.pass === false) {
        throw new Error(`Prompt Reviewer blocked governance apply: ${promptReview.issues?.filter((issue) => issue.severity === "critical").map((issue) => `${issue.agent}.${issue.field} ${issue.message}`).join("; ") || "critical issue"}`);
    }
    const reviewedPatches = promptReview.promptPatches || Object.fromEntries(PROMPT_GOVERNANCE_AGENTS.map((agent) => [agent, normalizePromptPatchEntry(agent, reviewBase.promptWriterDraft[agent], [...(digest?.pitfalls || []), ...(digest?.wikiLessons || [])], targetScore)]));
    const raw = await loadRawConfig(root);
    const fallbackModel = raw.llm?.model || raw.llm?.defaultModel || "";
    const fallbackService = raw.llm?.service || raw.llm?.provider || "";
    const profiles = normalizeAgentProfiles(raw.agentProfiles ?? {}, raw.modelOverrides ?? {}, fallbackModel, fallbackService);
    for (const [agent, patch] of Object.entries(reviewedPatches || {})) {
        if (!profiles[agent] || !patch || typeof patch !== "object")
            continue;
        profiles[agent] = {
            ...profiles[agent],
            promptPatch: replaceGovernanceBlock(profiles[agent].promptPatch, patch.promptPatch || ""),
            hardConstraints: replaceGovernanceBlock(profiles[agent].hardConstraints, patch.hardConstraints || ""),
            outputFormat: replaceGovernanceBlock(profiles[agent].outputFormat, patch.outputFormat || ""),
        };
    }
    raw.agentProfiles = profiles;
    raw.modelOverrides = mergeAgentProfilesIntoOverrides(raw, profiles);
    await saveRawConfig(root, raw);
    let filename = "";
    if (bookId) {
        const dir = join(state.bookDir(bookId), "story", "wiki", "prompt-governance");
        await mkdir(dir, { recursive: true });
        filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-prompt-governance.md`;
        await writeFile(join(dir, filename), digest.summaryMarkdown || "", "utf-8");
        const notesPath = join(state.bookDir(bookId), "story", "human_notes.md");
        await mkdir(dirname(notesPath), { recursive: true });
        await appendFile(notesPath, `\n\n## 提示词治理已更新 ${new Date().toISOString()}\n- 已根据质量报告、失败日志和 Wiki 压缩 Agent 提示词自动治理区块。\n- 详情见 story/wiki/prompt-governance/${filename}\n`, "utf-8");
    }
    await appendActivityLog(root, "prompt-governance:applied", { bookId, targetScore, warnings, promptReview, agents: Object.keys(reviewedPatches || {}) });
    return { profiles, filename };
}
function normalizeAgentService(value, fallback = "") {
    const service = limitText(value ?? "", 120).trim();
    if (!service)
        return fallback;
    return /[\x00-\x1f<>/\\]/.test(service) ? fallback : service;
}
async function hydrateAgentOverrideRuntimeConfig(root, config) {
    const secrets = await loadSecrets(root).catch(() => ({ services: {} }));
    const services = normalizeServiceConfig(config.llm?.services);
    const profiles = config.agentProfiles ?? {};
    const next = { ...(config.modelOverrides ?? {}) };
    for (const [agent, rawOverride] of Object.entries(next)) {
        const profile = profiles?.[agent] ?? {};
        const override = typeof rawOverride === "string" ? { model: rawOverride } : { ...(rawOverride ?? {}) };
        const serviceId = normalizeAgentService(override.service ?? profile.service, config.llm?.service ?? "");
        if (!serviceId) {
            next[agent] = override;
            continue;
        }
        const serviceEntry = services.find((entry) => serviceConfigKey(entry) === serviceId);
        const baseService = isCustomServiceId(serviceId) ? "custom" : serviceId;
        const preset = resolveServicePreset(baseService);
        const apiKey = secrets.services?.[serviceId]?.apiKey ?? (serviceId === config.llm?.service ? config.llm?.apiKey : undefined);
        next[agent] = {
            ...override,
            service: baseService,
            serviceName: serviceId,
            provider: override.provider ?? (isCustomServiceId(serviceId) ? "openai" : resolveServiceProviderFamily(baseService)) ?? config.llm?.provider ?? "openai",
            baseUrl: override.baseUrl ?? serviceEntry?.baseUrl ?? preset?.baseUrl ?? (serviceId === config.llm?.service ? config.llm?.baseUrl : undefined),
            apiFormat: override.apiFormat ?? serviceEntry?.apiFormat ?? config.llm?.apiFormat ?? "chat",
            stream: override.stream ?? serviceEntry?.stream ?? config.llm?.stream ?? true,
            temperature: override.temperature ?? profile.temperature ?? serviceEntry?.temperature ?? config.llm?.temperature ?? 0.7,
            ...(apiKey ? { apiKey } : {}),
        };
    }
    config.modelOverrides = next;
    return config;
}
function resolveAgentRuntimeLLMConfig(config, agents, fallbackTemperature = 0.7) {
    const overrides = config.modelOverrides ?? {};
    const profiles = config.agentProfiles ?? {};
    for (const agent of agents) {
        const override = overrides?.[agent];
        const profile = profiles?.[agent] ?? {};
        if (override && typeof override === "object" && override.model) {
            return {
                ...config.llm,
                ...override,
                model: override.model,
                temperature: override.temperature ?? profile.temperature ?? fallbackTemperature,
                stream: override.stream ?? profile.stream ?? false,
            };
        }
        if (typeof override === "string" && override) {
            return {
                ...config.llm,
                model: override,
                temperature: profile.temperature ?? fallbackTemperature,
                stream: profile.stream ?? false,
            };
        }
        if (profile?.model) {
            const serviceId = normalizeAgentService(profile.service, config.llm?.service ?? "");
            return {
                ...config.llm,
                service: isCustomServiceId(serviceId) ? "custom" : serviceId,
                serviceName: serviceId,
                model: profile.model,
                temperature: profile.temperature ?? fallbackTemperature,
                stream: profile.stream ?? false,
            };
        }
    }
    return {
        ...config.llm,
        model: config.llm?.model || config.llm?.defaultModel,
        temperature: fallbackTemperature,
        stream: false,
    };
}
function normalizeAgentProfiles(rawProfiles = {}, rawOverrides = {}, fallbackModel = "", fallbackService = "") {
    const profiles = {};
    const textOrDefault = (value, fallback = "") => {
        const text = typeof value === "string" ? value : "";
        return limitText(text.trim() ? text : fallback, 8000);
    };
    for (const def of AGENT_PROFILE_DEFS) {
        const raw = rawProfiles?.[def.id] ?? {};
        const override = rawOverrides?.[def.id] ?? {};
        const overrideModel = typeof override === "string" ? override : override?.model;
        const overrideService = typeof override === "object" ? override?.service : undefined;
        const overrideStream = typeof override === "object" ? override?.stream : undefined;
        profiles[def.id] = {
            service: normalizeAgentService(raw.service ?? overrideService, fallbackService),
            model: limitText(raw.model ?? overrideModel ?? fallbackModel, 200),
            temperature: clampNumber(raw.temperature, def.defaultTemperature, 0, 1.5),
            stream: raw.stream ?? overrideStream ?? true,
            promptPatch: textOrDefault(raw.promptPatch, def.defaultPromptPatch ?? ""),
            hardConstraints: textOrDefault(raw.hardConstraints, def.defaultHardConstraints ?? ""),
            outputFormat: textOrDefault(raw.outputFormat, def.defaultOutputFormat ?? ""),
        };
    }
    return profiles;
}
function mergeAgentProfilesIntoOverrides(raw, profiles) {
    const next = { ...(raw.modelOverrides ?? {}) };
    for (const [agent, profile] of Object.entries(profiles ?? {})) {
        const previous = next[agent];
        const base = typeof previous === "object" && previous !== null ? previous : {};
        if (profile.model) {
            next[agent] = {
                ...base,
                ...(profile.service ? { service: profile.service } : {}),
                model: profile.model,
                stream: profile.stream !== false,
                temperature: clampNumber(profile.temperature, 0.7, 0, 1.5),
            };
        }
    }
    return next;
}
function extractJsonObject(text) {
    const raw = String(text ?? "").trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    const candidate = fenced ?? raw;
    // 1) 快路径:首{到末}整段 parse(干净 JSON / 带围栏时命中)。
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
        try {
            return JSON.parse(candidate.slice(start, end + 1));
        }
        catch {
            /* 落到平衡扫描兜底(推理模型场景) */
        }
    }
    // 2) 兜底:推理模型(如 mimo)会输出大段思考 + 复述 schema 模板(含 `|` 的非法 JSON),
    //    真正答案 JSON 通常在最后。字符串感知地扫描所有平衡 {…} 候选,返回最后一个能 parse 的。
    const found = [];
    let depth = 0, objStart = -1, inStr = false, esc = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inStr) {
            if (esc)
                esc = false;
            else if (ch === "\\")
                esc = true;
            else if (ch === '"')
                inStr = false;
            continue;
        }
        if (ch === '"')
            inStr = true;
        else if (ch === "{") {
            if (depth === 0)
                objStart = i;
            depth++;
        }
        else if (ch === "}") {
            if (depth > 0) {
                depth--;
                if (depth === 0 && objStart !== -1) {
                    found.push(raw.slice(objStart, i + 1));
                    objStart = -1;
                }
            }
        }
    }
    for (let i = found.length - 1; i >= 0; i--) {
        try {
            return JSON.parse(found[i]);
        }
        catch {
            /* 试下一个候选 */
        }
    }
    return null;
}
function decodeJsonStringLiteral(value) {
    const raw = String(value ?? "");
    return raw
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}
function extractStructuredChapterText(text) {
    const raw = String(text ?? "").trim();
    if (!raw)
        return { text: "", structured: false };
    const parsed = extractJsonObject(raw);
    const fields = ["revised", "body", "content", "chapter", "text", "fullText", "draft", "manuscript"];
    if (parsed && typeof parsed === "object") {
        for (const field of fields) {
            if (typeof parsed[field] === "string" && parsed[field].trim()) {
                return { text: normalizeMarkdownText(parsed[field]), structured: true, field, parsed };
            }
        }
    }
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    const candidate = fenced ?? raw;
    for (const field of fields) {
        const marker = new RegExp(`"${field}"\\s*:\\s*"`, "i");
        const match = marker.exec(candidate);
        if (!match)
            continue;
        const start = match.index + match[0].length;
        const nextField = candidate.slice(start).search(/"\s*,\s*"(?:changes|warnings|reason|score|metrics|body|content|chapter|text|fullText|draft|manuscript)"\s*:/i);
        let encoded = nextField >= 0 ? candidate.slice(start, start + nextField) : candidate.slice(start);
        encoded = encoded.replace(/"\s*[,}\]]*\s*$/s, "");
        const decoded = decodeJsonStringLiteral(encoded);
        if (countWritingChars(decoded) >= 80) {
            return { text: normalizeMarkdownText(decoded), structured: true, field, recovered: true };
        }
    }
    const looksStructured = /^\s*\{/.test(candidate) || /"(?:revised|body|content|chapter|text)"\s*:/.test(candidate);
    const cleaned = normalizeMarkdownText(candidate
        .replace(/```(?:markdown|md|json)?/gi, "")
        .replace(/^\s*(修复后(?:的)?完整章节正文|完整章节正文|正文)\s*[:：]\s*/i, ""));
    return { text: cleaned, structured: looksStructured };
}
function assertCleanChapterText(text, source = "模型返回") {
    const cleaned = normalizeMarkdownText(text);
    if (!cleaned)
        throw new ApiError(422, "CHAPTER_TEXT_EMPTY", `${source}为空，已阻止落库。`);
    if (/^\s*\{[\s\S]{0,240}"(?:revised|body|content|chapter|text)"\s*:/.test(cleaned) || /\\n\\n/.test(cleaned.slice(0, 1200))) {
        throw new ApiError(422, "CHAPTER_TEXT_JSON_WRAPPER", `${source}仍包含 JSON 外壳或转义换行，已阻止覆盖正文。`);
    }
    return cleaned;
}
function heuristicPolishText(text) {
    let revised = normalizeMarkdownText(text);
    const changes = [];
    const replacements = [
        [/非常非常/g, "格外", "压缩重复副词，让语气更利落。"],
        [/然后他/g, "他随即", "减少流水账连接词，强化动作推进。"],
        [/她感觉/g, "她察觉", "把抽象感觉换成更有感知方向的动词。"],
        [/突然之间/g, "忽然", "缩短节奏，让转折更干净。"],
        [/有一种/g, "像是", "减少空泛判断，保留可描写的感受。"],
    ];
    for (const [pattern, replacement, reason] of replacements) {
        if (pattern.test(revised)) {
            const before = revised.match(pattern)?.[0] ?? "";
            revised = revised.replace(pattern, replacement);
            changes.push({ before, after: replacement, reason });
        }
    }
    revised = revised.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!changes.length && revised.length > 0) {
        changes.push({
            before: "原段落",
            after: "保留原意，建议人工选择更明确的润色目标",
            reason: "没有发现高置信度的机械问题，避免为了改而改。",
        });
    }
    return { revised, changes, engine: "local-heuristic" };
}
function countZhChars(value) {
    return (String(value ?? "").match(/[\u4e00-\u9fff]/g) || []).length;
}
function countPattern(value, patterns) {
    const text = String(value ?? "");
    return patterns.reduce((sum, pattern) => sum + (text.match(pattern) || []).length, 0);
}
function scoreBand(score) {
    if (score >= 92)
        return "优秀";
    if (score >= 84)
        return "稳";
    if (score >= 72)
        return "可用";
    if (score >= 60)
        return "需增强";
    return "需重修";
}
function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
}
function computeReaderSignals(content, report, stats) {
    const text = normalizeMarkdownText(content);
    const zh = Number(stats.chineseChars || countZhChars(text));
    const paragraphCount = Number(stats.paragraphs || 0);
    const sentenceCount = Number(stats.sentences || 0);
    const dialogueCount = Number(stats.dialogueCount || 0);
    const aiMarkers = Number(stats.aiMarkers || 0);
    const questionHooks = countPattern(text, [/？/g, /\?/g, /为什么/g, /怎么会/g, /到底/g, /谁/g, /哪里/g]);
    const sensoryAnchors = countPattern(text, [/光|风|雨|冷|热|声|味|疼|汗|血|铁|尘|玻璃|灯|影/g]);
    const emotionTurns = countPattern(text, [/愣|笑|怒|怕|慌|怔|沉默|咬牙|皱眉|心里|眼神|呼吸/g]);
    const plotSignals = countPattern(text, [/但|却|然而|突然|忽然|只是|直到|原来|没想到|下一秒/g]);
    const reportRisk = countPattern(report, [/困惑|不清|缺少|不足|平淡|拖沓|重复|AI味|动机/g]);
    const dialogueRatio = zh > 0 ? dialogueCount / Math.max(1, sentenceCount) : 0;
    const perThousand = Math.max(1, zh / 1000);
    const sensoryDensity = sensoryAnchors / perThousand;
    const emotionDensity = emotionTurns / perThousand;
    const hookScore = clampScore(66 + Math.min(18, questionHooks * 2) + Math.min(10, plotSignals) - Math.min(14, reportRisk * 2));
    const immersionScore = clampScore(68 + Math.min(16, sensoryDensity * 0.9) + Math.min(10, emotionDensity * 1.4) + Math.min(4, plotSignals / 5) - Math.min(16, aiMarkers * 1.2));
    const clarityScore = clampScore(88 - Math.min(20, Math.max(0, (stats.avgSentence || 0) - 58) / 2) - Math.min(16, reportRisk * 2) + (paragraphCount >= 6 ? 4 : 0));
    const readOnScore = clampScore(Math.round(hookScore * 0.38 + immersionScore * 0.32 + clarityScore * 0.3 + Math.min(6, dialogueRatio * 16)));
    const risks = [];
    if (hookScore < 78)
        risks.push("追更钩子偏弱：章节结尾或中段缺少足够明确的期待差。");
    if (immersionScore < 78)
        risks.push("沉浸感不足：可感知细节、动作反应或人物情绪锚点偏少。");
    if (clarityScore < 78)
        risks.push("理解成本偏高：句长、信息密度或因果交代可能让读者卡顿。");
    if (aiMarkers > 8)
        risks.push("读者可能感到模板化：高频 AI 腔标记偏多。");
    return {
        total: readOnScore,
        metrics: {
            hook: hookScore,
            immersion: immersionScore,
            clarity: clarityScore,
            readOn: readOnScore,
        },
        stats: {
            questionHooks,
            sensoryAnchors,
            emotionTurns,
            plotSignals,
            dialogueRatio: Number(dialogueRatio.toFixed(2)),
            sensoryDensity: Number(sensoryDensity.toFixed(1)),
            emotionDensity: Number(emotionDensity.toFixed(1)),
        },
        risks,
        verdict: readOnScore >= 90 ? "愿意追更" : readOnScore >= 82 ? "基本愿意继续" : readOnScore >= 72 ? "可读但容易分心" : "有弃读风险",
        source: "chapter+report+reader-signals",
    };
}
// 嗓音贴合度:对比"本章实测画像"与"本书嗓音指纹(style_profile.json)"的可计算特征,返回 0..1。
// 两边都用同一个 analyzeStyle 算法,保证可比。无指纹时返回 null(质量分退回旧算法)。
function computeVoiceAdherence(chapterProfile, bookProfile) {
    if (!chapterProfile || !bookProfile)
        return null;
    const close = (a, b, tol) => {
        const x = Number(a), y = Number(b);
        if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0)
            return 1;
        const rel = Math.abs(x - y) / Math.abs(y);
        return Math.max(0, 1 - rel / tol);
    };
    // 只用与"嗓音"强相关、且不随排版/章长抖动的特征;容差放宽以接受同一本书内的自然波动,只抓真漂移。
    // (avgParagraphLength 随 .md 换行结构波动,噪声大,故不计入。)
    const parts = [
        close(chapterProfile.avgSentenceLength, bookProfile.avgSentenceLength, 0.8),
        close(chapterProfile.sentenceLengthStdDev, bookProfile.sentenceLengthStdDev, 0.9),
        close(chapterProfile.vocabularyDiversity, bookProfile.vocabularyDiversity, 0.7),
    ];
    return parts.reduce((a, b) => a + b, 0) / parts.length;
}
export function computeChapterQualityScore(args) {
    const content = normalizeMarkdownText(args.content);
    const report = normalizeMarkdownText(args.report);
    const chineseChars = countZhChars(content);
    const paragraphs = content.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
    const sentences = content.split(/[。！？!?；;]+/).map((item) => item.trim()).filter(Boolean);
    const avgSentence = sentences.length ? chineseChars / sentences.length : 0;
    const shortParagraphs = paragraphs.filter((item) => countZhChars(item) > 0 && countZhChars(item) < 35).length;
    const dialogueCount = countPattern(content, [/“[^”]{1,120}”/g, /"[^"]{1,120}"/g]);
    const aiMarkers = countPattern(content, [/仿佛/g, /不禁/g, /忽然/g, /猛地/g, /竟然/g, /一种/g, /内心深处/g, /说不清/g, /命运/g]);
    const plotSignals = countPattern(content, [/但|却|然而|突然|忽然|只是|直到|原来|没想到|下一秒/g]);
    const sensoryAnchors = countPattern(content, [/光|风|雨|冷|热|声|味|疼|汗|血|铁|尘|玻璃|灯|影/g]);
    const emotionTurns = countPattern(content, [/愣|笑|怒|怕|慌|怔|沉默|咬牙|皱眉|心里|眼神|呼吸/g]);
    const warnings = Array.isArray(args.auditIssues) ? args.auditIssues : [];
    const criticalIssues = warnings.filter((item) => auditIssueSeverity(item) === "critical");
    // Path B:硬伤 critical 才 ×16 重罚 + 门禁 + 封顶;LLM 软 critical 按 warning×5 轻推(详见 isHardContinuityCritical)。
    const hardCriticals = criticalIssues.filter(isHardContinuityCritical).length;
    const softCriticals = criticalIssues.length - hardCriticals;
    const criticals = criticalIssues.length; // 总数,仅用于展示
    const warningCount = warnings.filter((item) => auditIssueSeverity(item) === "warning").length;
    const target = Number(args.targetWordCount || 3000);
    const ratio = target > 0 ? chineseChars / target : 1;
    // 长度分:过短照常扣(防缩水/水字数);超长大幅宽容(按用户要求"字数可以多一些,不要那么严格"),
    // 超长最多只扣 18 分,保证一篇内容完整但偏长的章节不会被长度拖垮总分。
    const lengthScore = ratio >= 1
        ? clampScore(100 - Math.min(18, (ratio - 1) * 20))
        : clampScore(100 - Math.min(45, (1 - ratio) * 80));
    const continuityScore = clampScore(96 - hardCriticals * 16 - (softCriticals + warningCount) * 5 - (args.status === "state-degraded" ? 18 : 0));
    const shortParagraphRatio = paragraphs.length ? shortParagraphs / paragraphs.length : 0;
    const shortParagraphPenalty = Math.min(10, Math.max(0, shortParagraphRatio - 0.32) * 36);
    const rhythmScore = clampScore(78 + Math.min(10, plotSignals / 2) + Math.min(6, sensoryAnchors / 9) + Math.min(6, emotionTurns / 3) + Math.min(5, dialogueCount * 1.5) - shortParagraphPenalty - (avgSentence > 65 ? 8 : 0) - (avgSentence < 14 ? 5 : 0));
    const aiCleanliness = 86 - Math.min(22, aiMarkers * 2) + (report.includes("风格") || report.includes("指纹") ? 4 : 0);
    // 有本书嗓音指纹时:60% 去AI味 + 40% 嗓音贴合度(像不像这本书自己);无指纹时退回旧算法(纯去AI味)。
    const voiceAdherence = typeof args.voiceAdherence === "number" ? args.voiceAdherence : null;
    const styleScore = clampScore(voiceAdherence !== null
        ? aiCleanliness * 0.6 + voiceAdherence * 100 * 0.4
        : aiCleanliness);
    const readabilityShortPenalty = Math.min(10, Math.max(0, shortParagraphRatio - 0.45) * 28);
    const readabilityScore = clampScore(82 + Math.min(6, paragraphs.length / 8) + Math.min(4, sensoryAnchors / 20) - Math.min(18, Math.max(0, aiMarkers - 3) * 2) - readabilityShortPenalty - (avgSentence > 72 ? 4 : 0));
    const reportPenalty = report ? 0 : 6;
    const reader = computeReaderSignals(content, report, {
        chineseChars,
        paragraphs: paragraphs.length,
        sentences: sentences.length,
        avgSentence,
        dialogueCount,
        aiMarkers,
    });
    // AI 味"人味指数"(0–100,高=越像人写,低=AI 痕迹重)。
    // 单一事实源:core 的 aiToneScore(analyzeAITells 6 类结构检测 + 关键词标记密度)。
    // 同一函数也用于 polisher 自动追加去 AI 味、总编签发硬门禁,三处口径一致。
    // 直接落到指标层(UI 第 5 维展示),不进入 rawTotal 加权(避免与 styleScore 重复计入)。
    let aiTone = 100;
    try {
        aiTone = aiToneScore(content, "zh");
    } catch {
        aiTone = clampScore(86 - Math.min(28, aiMarkers * 2));
    }
    // 字数不再当"质量维度"加权:达标是约束、不是优点。只在明显偏离区间时作为约束扣分,不奖励"凑够字数"。
    const lengthPenalty = lengthScore >= 85 ? 0 : Math.min(16, Math.round((85 - lengthScore) * 0.28));
    const rawTotal = clampScore(continuityScore * 0.28 + rhythmScore * 0.20 + reader.total * 0.20 + styleScore * 0.18 + readabilityScore * 0.14 - reportPenalty - lengthPenalty);
    const blockers = [];
    if (args.status === "state-degraded")
        blockers.push("state-degraded");
    if (hardCriticals)
        blockers.push("critical-audit");
    if (!report)
        blockers.push("missing-quality-report");
    const tooShortThreshold = target < 1000 ? Math.max(200, target * 0.45) : Math.max(800, target * 0.45);
    if (chineseChars < tooShortThreshold)
        blockers.push("too-short");
    // 封顶只对"硬伤"成立(状态链断档 / critical 审稿问题)。
    // 旧逻辑"质量报告这个中间产物没生成 → 全章封顶 88"是机械误伤(报告是流程产物、不是正文质量),
    // 已移除:缺报告仍由 blocker(missing-quality-report)拦门禁并触发重生,但不再焊死分数(这正是"修半天卡88"的机械成因之一)。
    const gatedTotal = args.status === "state-degraded"
        ? Math.min(rawTotal, 74)
        : hardCriticals
            ? Math.min(rawTotal, 84)
            : rawTotal;
    const total = clampScore(gatedTotal);
    const reasons = [];
    if (args.status === "state-degraded")
        reasons.push("状态链降级：上一章事实、伏笔或人物状态未可靠结算。");
    if (hardCriticals)
        reasons.push(`${hardCriticals} 条硬伤(死亡/血缘/身份/时间线/设定矛盾)必须优先修。`);
    if (softCriticals + warningCount)
        reasons.push(`${softCriticals + warningCount} 条疑似问题会影响连续性或阅读信任,建议核查。`);
    if (lengthScore < 80)
        reasons.push(`字数与目标 ${target} 偏差较大，当前约 ${chineseChars} 中文字。`);
    if (aiMarkers > 6)
        reasons.push(`疑似 AI 腔/模板词偏多：检测到 ${aiMarkers} 处高频标记。`);
    if (rhythmScore < 85)
        reasons.push(`节奏偏弱：短段落/句长/对白密度让阅读推进不足，当前 ${rhythmScore}。`);
    if (readabilityScore < 85)
        reasons.push(`可读性不足：段落组织或模板词影响顺滑度，当前 ${readabilityScore}。`);
    if (reader.metrics.immersion < 85)
        reasons.push(`沉浸感不足：场景、感官和人物即时反应需要更具体，当前 ${reader.metrics.immersion}。`);
    if (reader.total < 90)
        reasons.push(`读者追更欲未到 90：当前 ${reader.total}，需要更强的阻碍、选择和章尾期待。`);
    if (!report)
        reasons.push("未找到本章质量报告，当前分数来自正文和章节索引静态检测。");
    for (const risk of reader.risks.slice(0, 3))
        reasons.push(`读者视角：${risk}`);
    // 门禁阈值:默认 85(=用户在偏好设置看到/批量写作请求的值),可被 args.gateTarget 覆盖。
    // 不再硬编码 90——否则"显示门禁/质量计算"会无视用户配置,与批量写作实际用的阈值不一致。
    const gateTarget = Number(args.gateTarget) > 0 ? Number(args.gateTarget) : 80;
    if (total < gateTarget && blockers.length === 0)
        blockers.push("quality-below-target");
    return {
        total,
        band: scoreBand(total),
        metrics: {
            length: lengthScore,
            continuity: continuityScore,
            rhythm: rhythmScore,
            style: styleScore,
            readability: readabilityScore,
            reader: reader.total,
            hook: reader.metrics.hook,
            immersion: reader.metrics.immersion,
            clarity: reader.metrics.clarity,
            aiTone, // 0–100,高=人味重,低=AI 痕迹重
        },
        stats: {
            chineseChars,
            paragraphs: paragraphs.length,
            shortParagraphs,
            shortParagraphRatio: Number(shortParagraphRatio.toFixed(2)),
            sentences: sentences.length,
            avgSentence: Number(avgSentence.toFixed(1)),
            dialogueCount,
            aiMarkers,
            plotSignals,
            sensoryAnchors,
            emotionTurns,
            criticals,
            hardCriticals,
            softCriticals,
            warnings: warningCount,
            targetWordCount: target,
        },
        reader,
        reasons: reasons.slice(0, 8),
        source: report ? "chapter+report+index" : "chapter+index",
        gate: {
            target: gateTarget,
            pass: total >= gateTarget && blockers.length === 0,
            blockers,
            rule: `${gateTarget}+ 需要：状态可信、无 critical、质量报告存在、字数接近目标、节奏/风格/可读性同时达标。`,
        },
    };
}
// ── 建书上传资料"摘要化"(防止把几十万字原文整段塞进架构师 LLM 导致溢出/超时)──
const REFERENCE_SUMMARY_SYSTEM = `你是 AI 编辑部的"建书资料整理员"。用户上传了参考资料(大纲/世界观/人物设定/章节草稿/设定集等)。把它们提炼成一份**给架构师起稿用的紧凑摘要**(目标 800–1500 字),覆盖:世界观/时代/地点核心、主角与关键人物(动机/关系)、主线冲突与目标、已确定的设定与规则、风格基调、卷/章节规划要点。只输出摘要正文,不要寒暄、不要"以下是摘要"之类的话。忠于原文,绝不编造原文没有的设定。`;
const REFERENCE_INLINE_LIMIT = 6000;   // ≤ 此体量直接内联给架构师,不必摘要
const REFERENCE_CHUNK = 24000;         // 单次摘要调用的最大字符(防上下文溢出)
async function summarizeReferenceMaterial(client, model, files) {
    const combined = files.map((f) => `# ${f.name}\n${String(f.content || "").trim()}`).join("\n\n");
    if (combined.length <= REFERENCE_CHUNK) {
        const r = await chatCompletion(client, model, [
            { role: "system", content: REFERENCE_SUMMARY_SYSTEM },
            { role: "user", content: combined },
        ], { temperature: 0.3, maxTokens: 2200 });
        return String(r.content || "").trim();
    }
    // map-reduce:超长资料分段提要点,再合并去重,任何体量都不会撑爆上下文
    const chunks = [];
    for (let i = 0; i < combined.length; i += REFERENCE_CHUNK)
        chunks.push(combined.slice(i, i + REFERENCE_CHUNK));
    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
        const r = await chatCompletion(client, model, [
            { role: "system", content: `${REFERENCE_SUMMARY_SYSTEM}\n(这是同一批资料的第 ${i + 1}/${chunks.length} 段,先就这段提要点。)` },
            { role: "user", content: chunks[i] },
        ], { temperature: 0.3, maxTokens: 1200 });
        partials.push(String(r.content || "").trim());
    }
    const r = await chatCompletion(client, model, [
        { role: "system", content: `${REFERENCE_SUMMARY_SYSTEM}\n(下面是同一批资料分段提炼的要点,合并、去重、整理成一份连贯摘要。)` },
        { role: "user", content: partials.filter(Boolean).join("\n\n---\n\n") },
    ], { temperature: 0.3, maxTokens: 2200 });
    return String(r.content || "").trim();
}
/** 决定上传参考资料怎么进架构师 brief:小则内联,大则 LLM 摘要;摘要失败兜底硬截断,绝不把全文塞进架构师。 */
async function buildReferenceDigest(client, model, files) {
    const valid = (Array.isArray(files) ? files : [])
        .filter((f) => f && typeof f.content === "string" && f.content.trim())
        .map((f) => ({ name: (String(f.name || "参考文件").trim() || "参考文件"), content: String(f.content) }));
    if (!valid.length)
        return "";
    const total = valid.reduce((s, f) => s + f.content.length, 0);
    if (total <= REFERENCE_INLINE_LIMIT) {
        return valid.map((f) => `## 参考资料:${f.name}\n${f.content.trim()}`).join("\n\n---\n\n");
    }
    try {
        const digest = await summarizeReferenceMaterial(client, model, valid);
        if (digest)
            return `## 用户上传参考资料摘要(编辑部整理自 ${valid.length} 个文件、约 ${Math.round(total / 1000)}k 字)\n${digest}`;
    }
    catch {
        /* 摘要失败 → 落到下面的硬截断兜底 */
    }
    const truncated = valid.map((f) => `## 参考:${f.name}\n${f.content.trim().slice(0, 3000)}`).join("\n\n---\n\n").slice(0, REFERENCE_INLINE_LIMIT);
    return `## 用户上传参考资料(节选,完整版已存入作品 reference/)\n${truncated}`;
}
function auditIssueSeverity(issue) {
    if (issue && typeof issue === "object") {
        const severity = String(issue.severity ?? "").trim().toLowerCase();
        if (severity === "critical" || severity === "error" || severity === "致命" || severity === "严重")
            return "critical";
        if (severity === "warning" || severity === "warn" || severity === "警告")
            return "warning";
        return "info";
    }
    const text = String(issue ?? "").trim();
    const bracket = text.match(/^\s*\[([^\]]+)\]/);
    const head = String(bracket?.[1] ?? "").trim().toLowerCase();
    if (head === "critical" || head === "error")
        return "critical";
    if (head === "warning" || head === "warn")
        return "warning";
    if (/^(?:critical|error|严重|致命)\s*[:：]/i.test(text))
        return "critical";
    if (/^(?:warning|warn|警告)\s*[:：]/i.test(text))
        return "warning";
    return "info";
}
// ── Path B · critical 分级 ──────────────────────────────────────────────
// 只有"确定性硬伤"才配 ×16 重罚 + critical 门禁 + 84 封顶;LLM 自评的"软 critical"(措辞泛、主观)按 warning×5 轻推。
// 既不放过真矛盾(连续性=头号诉求),又不让一条 LLM 主观 critical 把好章焊死在 84 分(就是"修 5 轮卡 82/84"的机械成因)。
// 硬伤特征:死亡/复活、血缘身世、真实身份、时间线断裂、能力凭空、伏笔超期烂尾、设定/世界观/canon 硬冲突、前后矛盾、逻辑硬伤。
// 硬伤特征(确定性连续性/事实错误)。死亡/矛盾用宽同义词族——审稿官实际会写"牺牲/殒命/相悖/对不上",不是只写标签词。
const HARD_CONTINUITY_PATTERNS = /死(亡|了|去|于)|身亡|丧命|遇害|遇难|牺牲|殒命|阵亡|身故|罹难|断气|咽气|复活|还魂|死而复生|起死回生|血缘|身世|亲生|生父|生母|亲爹|亲娘|血亲|真实身份|真名|本名|真身|冒名|顶替|时间线|时序|时间.{0,5}(矛盾|对不上|错位|不符|颠倒)|日期.{0,5}(对不上|不符|矛盾)|前后.{0,3}(时间|日期)|凭空|无中生有|突然(会|能|拥有|掌握|具备|多了)|能力.{0,6}(矛盾|凭空|无来由|前文|没提)|武功.{0,4}(凭空|矛盾)|招式.{0,4}(凭空|没提)|伏笔.{0,8}(超期|逾期|烂尾|未回收|没回收|未交代|没下文|遗漏|断线|消失)|设定.{0,4}(矛盾|冲突|硬伤|相悖|不符)|世界观.{0,4}(矛盾|冲突|相悖)|规则.{0,4}(矛盾|相悖)|canon|前后(矛盾|不符|不一致)|自相矛盾|逻辑(硬伤|断裂|不通|矛盾)|相悖|对不上|说不通|retcon|dead|died|killed|resurrect|revive|timeline|contradict|inconsisten|plot ?hole/i;
// 明确的"主观写作 craft 点评"(节奏/文笔/沉浸/对话自然度…)——被审稿官误标 critical 是"卡84"的常见成因,降为软。
const SOFT_CRAFT_PATTERNS = /节奏|拖沓|拖|平淡|张力|文笔|用词|遣词|词汇|描写|画面|沉浸|代入|套话|金句|升华|抒情|啰嗦|冗长|冗余|爽点|段落|篇幅|短段|碎句|对白.{0,4}(生硬|平|多|密)|对话.{0,4}(生硬|不自然|平|啰嗦)|台词.{0,4}(生硬|平)|情绪.{0,4}(不足|薄|悬浮|铺垫)|感官.{0,4}(不足|偏少)|缺乏.{0,5}(张力|细节|代入|画面)|不够.{0,5}(生动|具体|鲜活|紧凑)|ai\s?味|ai\s?腔|风格.{0,4}(漂移|偏|不符)/i;
function auditIssueText(issue) {
    if (!issue || typeof issue !== "object")
        return String(issue ?? "");
    // message 可能是 {zh,en}/字符串/数组/嵌套对象;把所有能取到的文本都拍平,避免漏判(尤其只有 en 的硬伤)。
    const flat = (v) => {
        if (v == null) return "";
        if (typeof v === "string") return v;
        if (Array.isArray(v)) return v.map(flat).join(" ");
        if (typeof v === "object") return Object.values(v).map(flat).join(" ");
        return String(v);
    };
    return [issue.category, issue.message, issue.title, issue.detail, issue.suggestion].map(flat).join(" ");
}
/**
 * 该 critical 是否按"确定性硬伤"处理(×16 + 门禁 + 封顶)。混合判定 + 偏保守:
 * 命中硬伤词 → 硬;否则若是明确的写作 craft 点评 → 软;**含糊一律按硬**。
 * 一致性是头号诉求——宁可让疑似矛盾留硬桶(绝不放过),只把"明显主观 craft"降软。这样审稿官不认识的措辞默认硬,杜绝假阴性放过真矛盾。
 */
export function isHardContinuityCritical(issue) {
    const text = auditIssueText(issue);
    if (HARD_CONTINUITY_PATTERNS.test(text))
        return true;
    if (SOFT_CRAFT_PATTERNS.test(text))
        return false;
    return true; // 含糊默认硬,保护连续性
}
function structuredQualityScore(report) {
    const candidates = [
        report?.auditResult?.overallScore,
        report?.failureAttribution?.score,
        report?.quality?.total,
        report?.score,
    ].map((value) => Number(value)).filter((value) => Number.isFinite(value));
    return candidates.length ? Math.max(...candidates) : undefined;
}
function structuredQualityPassed(report) {
    return report?.auditResult?.passed === true
        || report?.failureAttribution?.passed === true
        || report?.quality?.gate?.pass === true
        || report?.passed === true;
}
function applyStructuredQualityOverride(quality, structuredReport, status, targetScore = 80) {
    const score = structuredQualityScore(structuredReport);
    const issues = [
        ...(Array.isArray(structuredReport?.auditResult?.issues) ? structuredReport.auditResult.issues : []),
        ...(Array.isArray(structuredReport?.issues) ? structuredReport.issues : []),
    ];
    const hasCritical = issues.some((issue) => auditIssueSeverity(issue) === "critical");
    if (!structuredQualityPassed(structuredReport)
        || !Number.isFinite(score)
        || score < targetScore
        || hasCritical
        || status === "state-degraded") {
        return quality;
    }
    const total = Math.max(Number(quality?.total || 0), score);
    return {
        ...quality,
        total,
        band: scoreBand(total),
        source: `${quality?.source || "chapter"}+structured-report`,
        stats: {
            ...(quality?.stats || {}),
            criticals: 0,
        },
        reasons: [
            `结构化质量报告已通过：复审 ${score} 分，Gate 放行；静态读者信号仅作提示。`,
            ...(quality?.reasons || []).filter((reason) => !/critical|未到\s*90|未找到本章质量报告|不足|偏弱|阻断|gate/i.test(String(reason))).slice(0, 2),
        ],
        gate: {
            ...(quality?.gate || {}),
            target: targetScore,
            pass: true,
            blockers: [],
            rule: "正式结构化质量报告已通过，且无 explicit critical；实时 Gate 以该报告为准。",
        },
    };
}
function renderRevisionHtml(original, revised, changes) {
    const escape = (value) => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const items = changes.map((change) => `<li><b>${escape(change.before)}</b> -> <b>${escape(change.after)}</b><span>${escape(change.reason)}</span></li>`).join("");
    return `<section><h3>润色后</h3><pre>${escape(revised)}</pre></section><section><h3>修改说明</h3><ul>${items}</ul></section><details><summary>原文</summary><pre>${escape(original)}</pre></details>`;
}
function renderSelectionPolishHtml(original, revised, changes, warnings = []) {
    const escape = (value) => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const items = changes.slice(0, 10).map((change) => `<li><b>${escape(change.before)}</b> -> <b>${escape(change.after)}</b><span>${escape(change.reason)}</span></li>`).join("");
    const warningItems = warnings.length
        ? `<section><h3>风险提示</h3><ul>${warnings.map((warning) => `<li>${escape(warning)}</li>`).join("")}</ul></section>`
        : "";
    return `<section><h3>润色后</h3><pre>${escape(revised)}</pre></section><section><h3>修改说明</h3><ul>${items}</ul></section>${warningItems}<details><summary>原选区</summary><pre>${escape(original)}</pre></details>`;
}
function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function countWritingChars(text) {
    const normalized = String(text ?? "").replace(/\s+/g, "");
    const cjk = normalized.match(/[\u3400-\u9fff]/g)?.length ?? 0;
    const words = String(text ?? "").match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g)?.length ?? 0;
    return cjk + words;
}
async function walkFiles(base, predicate = () => true) {
    async function walk(current) {
        let entries = [];
        try {
            entries = await readdir(current, { withFileTypes: true });
        }
        catch {
            return [];
        }
        const files = [];
        for (const entry of entries) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                files.push(...await walk(full));
            }
            else if (entry.isFile() && predicate(full)) {
                files.push(full);
            }
        }
        return files;
    }
    return walk(base);
}
async function readActivityEntries(root, limit = 200) {
    const paths = [join(root, ".hardwrite", "activity.log"), join(root, "hardwrite.log")];
    const entries = [];
    for (const logPath of paths) {
        const raw = await readOptionalText(logPath);
        if (!raw.trim())
            continue;
        for (const line of raw.trim().split(/\r?\n/)) {
            try {
                const entry = JSON.parse(line);
                if (entry?.event && !isHighVolumeDeltaEvent(entry.event)) {
                    entries.push(entry);
                }
            }
            catch {
                entries.push({ timestamp: null, event: "log", data: { message: line } });
            }
        }
    }
    return entries
        .sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")))
        .slice(0, limit)
        .map(enrichActivityEntry);
}
function isHighVolumeDeltaEvent(event) {
    return typeof event === "string" && (event === "llm:delta" || event.endsWith(":delta"));
}
function formatBeijingDateTime(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime()))
        return "";
    try {
        return new Intl.DateTimeFormat("zh-CN", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        }).format(date).replace(/\//g, "-");
    }
    catch {
        return date.toISOString();
    }
}
function failureInfoForActivity(event, data = {}) {
    const raw = String(data.error || data.failureReason || data.message || "");
    const lower = raw.toLowerCase();
    const total = Number(data.total || 0);
    const index = Number(data.index || data.chapterNumber || 0);
    const batchImpact = total && index
        ? `自动工作流停在第 ${index}/${total} 章，已完成并落库的章节不会被删除。`
        : "当前任务已停止，已写入本地保险柜或正式章节的内容会保留。";
    if (/lost in-memory owner|service restart|backend restart|服务重启|旧任务已失去执行进程/i.test(raw)) {
        return {
            reason: "服务重启中断了旧任务的内存执行进程：旧锁已释放，系统会先刷新已落库章节和恢复草稿，再从断点继续。",
            impact: total && index
                ? `自动工作流停在第 ${index}/${total} 个步骤；已经落库的章节、质量报告和保险柜草稿都会保留。`
                : "已写入本地的章节和恢复草稿不会丢；需要重新接管的是后台执行进程，不是正文内容。",
            suggestion: "无需反复手动确认；工作台会自动执行“检查并继续”。如果连续重启，请等当前代码改动/服务重启结束后再启动大批量生成。",
        };
    }
    if (/state-degraded|repair state|rewrite that chapter|状态降级|状态不可信/i.test(raw)) {
        const chapter = raw.match(/chapter\s+(\d+)/i)?.[1] || data.chapterNumber || data.chapter || "";
        return {
            reason: `${chapter ? `第 ${chapter} 章` : "最新章节"}状态不可信：章节正文已经生成，但状态卡、伏笔池、人物位置或质量复审没有可靠结算，系统为避免后续章节越写越歪而暂停。`,
            impact: total && index
                ? `自动工作流停在第 ${index}/${total} 章前；已落库章节和恢复草稿仍在本地，不会丢。`
                : "这不是正文丢失，而是状态链路需要先自愈；继续写之前必须先修复上一章状态。",
            suggestion: "直接点“检查并继续”或重新启动生成；后端会先执行状态自愈，成功后再自动进入下一章。如果自愈仍失败，再考虑重写该章。",
        };
    }
    if (/timed?\s*out|timeout|request timed out|aborted/i.test(raw)) {
        if (/heartbeat|active write job/i.test(raw)) {
            return {
                reason: "后端任务心跳超时：前端长时间没有收到阶段推进或模型流，旧任务锁已被守护进程释放。",
                impact: "系统会先读取已落库章节和恢复草稿，再允许继续，避免一边盲等一边重复开新任务。",
                suggestion: "点“检查并继续”即可重新接管；如果频繁出现，建议把一次生成章数降到 1-2 章，并检查模型服务延迟。",
            };
        }
        return {
            reason: "模型请求超时：本轮写作输出较长，或模型服务响应太慢，服务端在等待完整结果时超过了保护时间。",
            impact: batchImpact,
            suggestion: "先到 Agent 配置测试当前服务是否能 ping 通，再点“刷新/检查并继续”。低分复修已给模型更长保护时间；如果仍频繁超时，优先切换到响应更快的已验证模型服务，或把一次生成章数降到 1-2 章。",
        };
    }
    if (/401|403|unauthorized|forbidden|api[_ -]?key|authentication|auth/i.test(raw)) {
        return {
            reason: "模型鉴权失败：API Key、额度、模型权限或网关鉴权没有通过。",
            impact: "本轮没有继续调用模型，避免继续消耗错误请求。",
            suggestion: "到“Agent 配置/模型策略”检查 Key、模型名、余额和代理配置，确认后重新启动该任务。",
        };
    }
    if (/missing required sections|required sections|section/i.test(raw)) {
        return {
            reason: "结构化输出不完整：智能体没有按约定输出必需区块，系统拒绝把不完整设定落库。",
            impact: "作品档案或章节资产未完整生成，避免后续章节基于残缺上下文继续漂移。",
            suggestion: "降低本轮目标复杂度后重试；如果连续出现，请在 Agent 配置里强化输出格式约束。",
        };
    }
    if (/network|fetch|econn|socket|connection|dns/i.test(raw)) {
        return {
            reason: "网络或模型网关连接异常：服务端没有稳定拿到模型响应。",
            impact: batchImpact,
            suggestion: "检查本机网络、代理、模型服务地址；然后用较小章节数继续，避免重复生成太多内容。",
        };
    }
    if (/quality-repair|低分|复修|评分|未达标|target|score/i.test(`${event} ${raw}`)) {
        return {
            reason: raw ? `低分复修未达标：${raw}` : "低分复修未达标：评分仍低于目标。",
            impact: "章节已保留在当前版本和修订备份中，不会跳过这一章继续写下一章。",
            suggestion: "继续复修会读取同章历史失败和当前质量报告，自动判断压缩、扩写或平台期换打法；不要再盲目重复上一轮提示词。",
        };
    }
    if (!raw) {
        return {
            reason: "任务失败但底层没有返回明确错误文本。",
            impact: batchImpact,
            suggestion: "查看原始数据和服务器终端日志；然后点“检查并继续”让系统读取最新 run 状态。",
        };
    }
    return {
        reason: `任务失败：${raw}`,
        impact: batchImpact,
        suggestion: "先刷新工作台确认哪些章节已落库；再从失败章节继续，避免重复写同一章。",
    };
}
function summarizeActivity(event, data = {}) {
    const label = data.agentLabel || data.agent || "系统";
    if (event === "agent:stage")
        return `${label}：${data.stage || "阶段推进"}`;
    if (event === "llm:progress")
        return `模型流：${data.status || "streaming"} · ${Number(data.chineseChars || 0).toLocaleString()} 中文字 / ${Number(data.totalChars || 0).toLocaleString()} 字符`;
    if (event === "book:creating")
        return `开始创建作品：${data.title || data.bookId || "未命名"}`;
    if (event === "book:created")
        return `作品档案已创建：${data.book?.title || data.title || data.bookId || "未命名"}`;
    if (event === "write:start")
        return `写作任务开始：${data.bookId || "当前作品"}${data.runId ? ` · run ${data.runId}` : ""}`;
    if (event === "write:complete")
        return `章节完成：第 ${data.chapterNumber || "?"} 章《${data.title || "未命名"}》 · ${Number(data.wordCount || 0).toLocaleString()} 字`;
    if (event === "write:needs-repair")
        return `章节未过质量 Gate：第 ${data.chapterNumber || "?"} 章《${data.title || "未命名"}》 · ${data.scoreAfter ?? "--"} 分，已暂停并等待复修`;
    if (event === "batch:start")
        return `批量写作启动：${data.total || 0} 章${data.wordCount ? ` · 每章约 ${data.wordCount} 字` : ""}`;
    if (event === "batch:chapter:start")
        return `开始生成第 ${data.index || "?"}/${data.total || "?"} 章`;
    if (String(event).includes("error")) {
        const info = failureInfoForActivity(event, data);
        return info.reason;
    }
    if (event === "tool:update")
        return data.message || data.stage || "工具状态更新";
    return data.stage || data.message || event || "日志";
}
function enrichActivityEntry(entry) {
    const data = entry?.data || {};
    const event = entry?.event || "log";
    const failed = String(event).includes("error") || data.error || data.failureReason;
    const info = failed ? failureInfoForActivity(event, data) : null;
    const beijingTime = entry.beijingTime || formatBeijingDateTime(entry.timestamp || Date.now());
    return {
        ...entry,
        beijingTime,
        timeZone: "Asia/Shanghai",
        displayTime: `北京时间 ${beijingTime}`,
        summary: entry.summary || summarizeActivity(event, data),
        severity: entry.severity || (failed ? "error" : String(event).includes("warn") ? "warn" : "info"),
        failureReason: entry.failureReason || info?.reason || data.failureReason || "",
        impact: entry.impact || info?.impact || "",
        suggestion: entry.suggestion || info?.suggestion || "",
    };
}
async function recoverLatestDraftFromActivityLog(root, bookId) {
    const raw = await readOptionalText(join(root, ".hardwrite", "activity.log"));
    if (!raw.trim())
        return "";
    const entries = raw.trim().split(/\r?\n/).map((line, index) => {
        try {
            return { index, ...JSON.parse(line) };
        }
        catch {
            return null;
        }
    }).filter(Boolean);
    let startIndex = -1;
    for (const entry of entries) {
        if (entry?.data?.bookId === bookId && entry.event === "agent:stage" && String(entry.data.stage ?? "").includes("撰写章节草稿")) {
            startIndex = entry.index;
        }
    }
    if (startIndex < 0)
        return "";
    let text = "";
    for (const entry of entries) {
        if (entry.index <= startIndex || entry?.data?.bookId !== bookId)
            continue;
        if (entry.event === "llm:delta") {
            text += entry.data.text ?? "";
            continue;
        }
        if (entry.event === "llm:progress" && entry.data?.status === "done") {
            break;
        }
    }
    if (text.trim().length < 200)
        return "";
    return [
        "# 未入库草稿（从中断流式日志恢复）",
        "",
        "> 这份内容来自上一次写作流。流程在审稿/落盘前中断，所以它不是正式章节，但应该作为可查看、可复制、可接管的资产保留。",
        "",
        text.trim(),
    ].join("\n");
}
async function loadWritingStats(root, state) {
    const bookIds = await state.listBooks().catch(() => []);
    let chapterCount = 0;
    let bookWordCount = 0;
    let todayWordCount = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const bookId of bookIds) {
        const chapters = await state.loadChapterIndex(bookId).catch(() => []);
        chapterCount += Array.isArray(chapters) ? chapters.length : 0;
        for (const chapter of Array.isArray(chapters) ? chapters : []) {
            const count = Number(chapter.wordCount ?? chapter.chineseChars ?? 0);
            bookWordCount += Number.isFinite(count) ? count : 0;
            if (String(chapter.updatedAt ?? chapter.createdAt ?? "").startsWith(today)) {
                todayWordCount += Number.isFinite(count) ? count : 0;
            }
        }
    }
    const vault = await ensureWritingVault(root);
    const markdownFiles = await walkFiles(vault, (path) => path.endsWith(".md"));
    const assetFiles = await walkFiles(vault, () => true);
    let vaultWordCount = 0;
    let todayAssetCount = 0;
    for (const file of markdownFiles) {
        const [raw, fileStat] = await Promise.all([
            readOptionalText(file),
            stat(file).catch(() => null),
        ]);
        vaultWordCount += countWritingChars(raw);
        if (fileStat?.mtime?.toISOString().startsWith(today)) {
            todayAssetCount += 1;
        }
    }
    return {
        books: bookIds.length,
        chapters: chapterCount,
        bookWords: bookWordCount,
        vaultWords: vaultWordCount,
        totalWords: bookWordCount + vaultWordCount,
        todayWords: todayWordCount,
        files: assetFiles.length,
        markdownFiles: markdownFiles.length,
        todayAssetCount,
        goal: 15000,
        progress: Math.min(1, todayWordCount / 15000),
    };
}
async function resolveChapterFile(state, bookId, num) {
    if (!isSafeBookId(bookId) || !Number.isInteger(num) || num <= 0) {
        throw new ApiError(400, "INVALID_CHAPTER", "Invalid book or chapter");
    }
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    let files = [];
    try {
        files = await readdir(chaptersDir);
    }
    catch {
        throw new ApiError(404, "CHAPTER_NOT_FOUND", "Chapter not found");
    }
    const paddedNum = String(num).padStart(4, "0");
    const filename = files.find((file) => file.startsWith(paddedNum) && file.endsWith(".md"));
    if (!filename) {
        throw new ApiError(404, "CHAPTER_NOT_FOUND", "Chapter not found");
    }
    return {
        bookDir,
        chaptersDir,
        filename,
        fullPath: join(chaptersDir, filename),
    };
}
async function readChapterQualityReport(state, bookId, chapterNumber) {
    const reportDir = join(state.bookDir(bookId), "reports");
    const padded = String(chapterNumber).padStart(4, "0");
    try {
        const names = (await readdir(reportDir)).filter((name) => name.endsWith("_quality_report.md")).sort();
        const exact = names.find((name) => name.startsWith(`chapter_${padded}`))
            || names.find((name) => name.startsWith(`chapter-${padded}`))
            || names.find((name) => name.startsWith(padded))
            || names.find((name) => name.includes(`chapter_${padded}`))
            || names.find((name) => name.includes(`chapter-${padded}`));
        return exact ? await readFile(join(reportDir, exact), "utf-8") : "";
    }
    catch {
        return "";
    }
}
async function readChapterQualityReportJson(state, bookId, chapterNumber) {
    const reportDir = join(state.bookDir(bookId), "reports");
    const padded = String(chapterNumber).padStart(4, "0");
    try {
        const names = (await readdir(reportDir)).filter((name) => name.endsWith("_quality_report.json")).sort();
        const exact = names.find((name) => name.startsWith(`chapter_${padded}`))
            || names.find((name) => name.startsWith(`chapter-${padded}`))
            || names.find((name) => name.startsWith(padded))
            || names.find((name) => name.includes(`chapter_${padded}`))
            || names.find((name) => name.includes(`chapter-${padded}`));
        if (!exact)
            return null;
        return JSON.parse(await readFile(join(reportDir, exact), "utf-8"));
    }
    catch {
        return null;
    }
}
async function buildChapterQualityPayload(state, bookId, chapterNumber, contentOverride, options = {}) {
    const book = await state.loadBookConfig(bookId);
    const index = await state.loadChapterIndex(bookId).catch(() => []);
    const meta = index.find((item) => Number(item.number || item.chapterNumber) === Number(chapterNumber)) || {};
    const chapter = await resolveChapterFile(state, bookId, chapterNumber);
    const content = typeof contentOverride === "string" ? contentOverride : await readFile(chapter.fullPath, "utf-8");
    // 嗓音指纹贴合度:载入本书 style_profile.json,对本章正文跑同一个 analyzeStyle 后比对(同算法可比)。
    let voiceAdherence = null;
    try {
        const profileRaw = await readFile(join(state.bookDir(bookId), "story", "style_profile.json"), "utf-8").catch(() => "");
        if (profileRaw)
            voiceAdherence = computeVoiceAdherence(analyzeStyle(content), JSON.parse(profileRaw));
    }
    catch {
        /* 无指纹或解析失败:styleScore 退回旧算法 */
    }
    const [report, structuredReport] = await Promise.all([
        readChapterQualityReport(state, bookId, chapterNumber),
        readChapterQualityReportJson(state, bookId, chapterNumber),
    ]);
    const targetOverride = Number(options.targetWordCount);
    const targetWordCount = Number.isFinite(targetOverride) && targetOverride > 0
        ? targetOverride
        : Number(book.chapterWordCount || book.targetChapterWords || book.wordCount || 3000);
    const gateOverride = Number(options.gateTarget ?? options.targetScore);
    const gateTarget = Number.isFinite(gateOverride) && gateOverride > 0 ? gateOverride : 80;
    let quality = computeChapterQualityScore({
        content,
        report,
        status: meta.status,
        auditIssues: meta.auditIssues,
        targetWordCount,
        gateTarget,
        voiceAdherence,
    });
    quality = applyStructuredQualityOverride(quality, structuredReport, meta.status, gateTarget);
    // 质量→提示词治理:按分数自动给出"是否建议触发治理复盘"的建议(纯计算,不触发 LLM、不改提示词;
    // 真正应用补丁仍走 prompt-governance 的 Prompt Reviewer 门控)。
    const qScore = Number(quality?.total);
    const governanceRecommendation = buildGovernanceRecommendation({
        score: Number.isFinite(qScore) ? qScore : null,
        passThreshold: Number(quality?.gate?.target) || 80,
    });
    return { bookId, chapterNumber, filename: chapter.filename, title: meta.title || `第 ${chapterNumber} 章`, status: meta.status || "unknown", quality, governanceRecommendation, report, auditIssues: meta.auditIssues || [] };
}
async function buildBookQualitySummary(state, bookId) {
    const chapters = await state.loadChapterIndex(bookId).catch(() => []);
    const sorted = [...chapters].sort((a, b) => Number(a.chapterNumber ?? a.number ?? 0) - Number(b.chapterNumber ?? b.number ?? 0));
    const payloads = [];
    for (const meta of sorted) {
        const chapterNumber = Number(meta.chapterNumber ?? meta.number ?? 0);
        if (!Number.isInteger(chapterNumber) || chapterNumber <= 0)
            continue;
        try {
            payloads.push(await buildChapterQualityPayload(state, bookId, chapterNumber));
        }
        catch (error) {
            payloads.push({
                bookId,
                chapterNumber,
                title: meta.title || `第 ${chapterNumber} 章`,
                status: meta.status || "missing",
                quality: {
                    total: 0,
                    band: "需重修",
                    metrics: {},
                    stats: {},
                    reasons: [`章节文件读取失败：${error instanceof Error ? error.message : String(error)}`],
                    source: "missing",
                    gate: { target: 85, pass: false, blockers: ["chapter-missing"], rule: "章节文件必须可读才能进入质量链路。" },
                },
                report: "",
                auditIssues: meta.auditIssues || [],
            });
        }
    }
    const scores = payloads.map((item) => Number(item.quality?.total || 0));
    const low = payloads.filter((item) => Number(item.quality?.gate?.target ?? 85) > Number(item.quality?.total || 0) || item.quality?.gate?.pass === false);
    return {
        bookId,
        chapters: payloads,
        summary: {
            total: payloads.length,
            passed90: payloads.length - low.length,
            lowCount: low.length,
            average: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
            lowest: payloads.reduce((min, item) => !min || Number(item.quality?.total || 0) < Number(min.quality?.total || 0) ? item : min, null),
            target: 85,
        },
    };
}
async function writeStudioChapterQualityReport(state, bookId, chapterNumber, payload, note = "") {
    const reportDir = join(state.bookDir(bookId), "reports");
    await mkdir(reportDir, { recursive: true });
    const padded = String(chapterNumber).padStart(4, "0");
    const q = payload?.quality || {};
    const stats = q.stats || {};
    const metrics = q.metrics || {};
    const reader = q.reader || {};
    const readerMetrics = reader.metrics || {};
    const lines = [
        `# 第 ${chapterNumber} 章质量报告`,
        "",
        `- 生成时间：${new Date().toISOString()}`,
        `- 总分：${q.total ?? 0}`,
        `- 评级：${q.band || "未评级"}`,
        `- 是否达标：${q.gate?.pass ? "是" : "否"}`,
        `- 目标：${q.gate?.target || 90} 分以上`,
        note ? `- 备注：${note}` : "",
        "",
        "## 分项",
        `- 字数匹配：${metrics.length ?? "--"}`,
        `- 连续性：${metrics.continuity ?? "--"}`,
        `- 节奏：${metrics.rhythm ?? "--"}`,
        `- 风格：${metrics.style ?? "--"}`,
        `- 可读性：${metrics.readability ?? "--"}`,
        `- 读者追更欲：${metrics.reader ?? "--"}`,
        `- 爽点/钩子：${metrics.hook ?? "--"}`,
        `- 沉浸感：${metrics.immersion ?? "--"}`,
        `- 清晰度：${metrics.clarity ?? "--"}`,
        "",
        "## 读者视角",
        `- 读者总评：${reader.total ?? "--"} · ${reader.verdict || "未评估"}`,
        `- 追更欲：${readerMetrics.readOn ?? "--"}`,
        `- 钩子：${readerMetrics.hook ?? "--"}`,
        `- 沉浸：${readerMetrics.immersion ?? "--"}`,
        `- 理解清晰：${readerMetrics.clarity ?? "--"}`,
        ...(reader.risks?.length ? reader.risks.map((risk) => `- 风险：${risk}`) : ["- 风险：暂无明显读者侧风险。"]),
        "",
        "## 统计",
        `- 中文字：${stats.chineseChars ?? 0}`,
        `- 段落：${stats.paragraphs ?? 0}`,
        `- 句子：${stats.sentences ?? 0}`,
        `- 对白：${stats.dialogueCount ?? 0}`,
        `- AI 标记：${stats.aiMarkers ?? 0}`,
        "",
        "## 风险与修复建议",
        ...(q.reasons?.length ? q.reasons.map((reason) => `- ${reason}`) : ["- 当前没有明显风险。"]),
        "",
        "## Gate",
        `- 阻断项：${(q.gate?.blockers || []).join(", ") || "无"}`,
        `- 规则：${q.gate?.rule || "90+ 为发布级目标。"}`,
        "",
    ].filter((line) => line !== "").join("\n");
    const filename = `${padded}_quality_report.md`;
    await writeFile(join(reportDir, filename), lines, "utf-8");
    return { filename, relativePath: `reports/${filename}` };
}
async function buildBookManuscript(state, root, bookId) {
    if (!isSafeBookId(bookId)) {
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    }
    await ensureOpeningPublishingAssets(state, root, bookId, { rebuildIndex: false }).catch(() => null);
    const book = await state.loadBookConfig(bookId);
    const index = [...(await state.loadChapterIndex(bookId).catch(() => []))]
        .sort((a, b) => Number(a.chapterNumber ?? a.number ?? 0) - Number(b.chapterNumber ?? b.number ?? 0));
    const chapters = [];
    for (const meta of index) {
        const chapterNumber = Number(meta.chapterNumber ?? meta.number);
        if (!Number.isInteger(chapterNumber) || chapterNumber <= 0)
            continue;
        try {
            const file = await resolveChapterFile(state, bookId, chapterNumber);
            const content = await readFile(file.fullPath, "utf-8");
            chapters.push({
                ...meta,
                chapterNumber,
                title: meta.title || `第${chapterNumber}章`,
                filename: file.filename,
                content,
                wordCount: meta.wordCount ?? countWritingChars(content),
            });
        }
        catch {
            chapters.push({
                ...meta,
                chapterNumber,
                title: meta.title || `第${chapterNumber}章`,
                filename: "",
                content: "",
                missing: true,
                wordCount: meta.wordCount ?? 0,
            });
        }
    }
    const recovered = await recoverLatestDraftFromActivityLog(root, bookId);
    const volumeMap = await readVolumeMapForBook(state, bookId).catch(() => "");
    const volumes = parseVolumePlan(volumeMap, book, chapters);
    const language = String(book.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    const volumeLabel = (volume) => language === "en" ? `Volume ${volume.order}: ${volume.title}` : `第${chineseNumber(volume.order)}卷：${volume.title}`;
    const grouped = [];
    for (const chapter of chapters) {
        const volume = volumeForChapter(volumes, chapter.chapterNumber) || volumes[0];
        let group = grouped.find((item) => item.order === volume.order);
        if (!group) {
            group = { ...volume, chapters: [] };
            grouped.push(group);
        }
        group.chapters.push(chapter);
    }
    const tocLines = grouped.length
        ? grouped.flatMap((volume) => [
            volumeLabel(volume),
            ...volume.chapters.map((chapter) => `第${chapter.chapterNumber}章 ${chapter.title || "未命名"}`),
            "",
        ]).filter((line, index, array) => line || array[index + 1])
        : volumes.slice(0, 1).map((volume) => volumeLabel(volume));
    const tocText = [
        book.title || bookId,
        "",
        "目录",
        "",
        ...tocLines,
        ...(!chapters.length && recovered ? ["未入库草稿（待确认）"] : []),
    ].join("\n");
    const bodyParts = [];
    let lastVolumeOrder = null;
    for (const chapter of chapters) {
        const volume = volumeForChapter(volumes, chapter.chapterNumber) || volumes[0];
        if (volume && volume.order !== lastVolumeOrder) {
            bodyParts.push(volumeLabel(volume));
            lastVolumeOrder = volume.order;
        }
        bodyParts.push([
            `第${chapter.chapterNumber}章 ${chapter.title || "未命名"}`,
            "",
            chapter.content || "（章节文件缺失）",
        ].join("\n"));
    }
    if (!chapters.length && recovered) {
        bodyParts.push(["未入库草稿（待确认）", "", recovered].join("\n"));
    }
    const fullText = [
        `《${book.title || bookId}》`,
        "",
        "目录",
        "",
        ...tocLines,
        ...(!chapters.length && recovered ? ["未入库草稿（待确认）"] : []),
        "",
        "正文",
        "",
        bodyParts.join("\n\n"),
    ].join("\n").trimEnd() + "\n";
    const coverPath = await findBookCoverPath(state, bookId);
    const description = parseBookDescriptionMarkdown(await readOptionalText(join(state.bookDir(bookId), "story", "book_description.md")).catch(() => "")) || null;
    return {
        book: { ...book, id: bookId, coverUrl: coverPath ? `/api/v1/books/${encodeURIComponent(bookId)}/cover` : "", firstVolumeTitle: volumes[0]?.title || "", volumes, description, oneLine: description?.oneLine || "", shortIntro: description?.shortIntro || "", fullIntro: description?.fullIntro || "", tags: description?.tags || [] },
        volumes: volumes.map((volume) => ({ ...volume, chapterCount: chapters.filter((chapter) => {
                const assigned = volumeForChapter(volumes, chapter.chapterNumber);
                return assigned?.order === volume.order;
            }).length })),
        chapters,
        tocText,
        fullText,
        volumeMap,
        recoveredDraft: recovered,
        stats: {
            chapters: chapters.length,
            words: chapters.reduce((sum, chapter) => sum + Number(chapter.wordCount || 0), 0),
            hasRecoveredDraft: Boolean(recovered),
        },
    };
}
function bilingual(value, fallback = "") {
    const text = String(value ?? fallback ?? "").trim();
    return { zh: text, en: text };
}
function toEpochMs(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
    const time = new Date(value || 0).getTime();
    return Number.isFinite(time) ? time : 0;
}
function chapterTargetWords(book = {}, quality = null) {
    const candidates = [
        book.chapterWordCount,
        book.targetChapterWords,
        book.wordCount,
        quality?.quality?.stats?.targetWordCount,
        quality?.quality?.stats?.targetWords,
    ];
    for (const value of candidates) {
        const num = Number(value);
        if (Number.isFinite(num) && num > 0)
            return Math.round(num);
    }
    return 3000;
}
function v0ChapterSummary(bookId, meta = {}, qualityPayload = null) {
    const chapterNumber = Number(meta.chapterNumber ?? meta.number ?? 0) || 0;
    const quality = qualityPayload?.quality ?? meta.quality ?? null;
    const stats = quality?.stats || {};
    const wordCount = Number(meta.wordCount ?? meta.words ?? stats.chineseChars ?? stats.words ?? 0) || 0;
    return {
        ...meta,
        id: `${bookId}:${chapterNumber}`,
        bookId,
        chapterNum: chapterNumber,
        chapterNumber,
        number: chapterNumber,
        title: meta.title || `第 ${chapterNumber} 章`,
        status: meta.status || (quality?.gate?.pass ? "approved" : "draft"),
        currentWords: wordCount,
        wordCount,
        words: wordCount,
        quality,
        qualityReport: qualityPayload,
        updatedAt: meta.updatedAt || meta.createdAt || "",
        updatedAtMs: toEpochMs(meta.updatedAt || meta.createdAt),
    };
}
function v0ReviewIssue(raw, chapterNumber, index = 0) {
    const text = typeof raw === "string"
        ? raw
        : String(raw?.message || raw?.reason || raw?.title || raw?.text || raw?.blocker || raw?.detail || JSON.stringify(raw || ""));
    const lower = text.toLowerCase();
    const severity = /严重|阻断|失败|高|critical|block|fail/.test(lower)
        ? "high"
        : /风险|建议|warning|中/.test(lower)
            ? "medium"
            : "low";
    const category = /逻辑|因果|logic/.test(lower)
        ? "logic"
        : /一致|设定|连续|consisten|canon|truth/.test(lower)
            ? "consistency"
            : /风格|文风|style/.test(lower)
                ? "style"
                : /节奏|pacing|拖沓|推进/.test(lower)
                    ? "pacing"
                    : /事实|fact|时间|地点|人物/.test(lower)
                        ? "fact"
                        : "style";
    const excerpt = typeof raw === "object" ? (raw.excerpt || raw.quote || raw.before || raw.location || "") : "";
    const suggestion = typeof raw === "object" ? (raw.suggestion || raw.after || raw.fix || "") : "";
    return {
        id: `ch${chapterNumber}-issue-${index + 1}`,
        severity,
        category,
        excerpt: bilingual(excerpt),
        message: bilingual(text || "未命名审稿问题"),
        suggestion: suggestion ? bilingual(suggestion) : undefined,
    };
}
function reviewIssuesFromQuality(payload, chapterNumber) {
    const quality = payload?.quality || {};
    const items = [
        ...(Array.isArray(payload?.auditIssues) ? payload.auditIssues : []),
        ...(Array.isArray(quality.reasons) ? quality.reasons : []),
        ...(Array.isArray(quality.reader?.risks) ? quality.reader.risks : []),
        ...(Array.isArray(quality.gate?.blockers) ? quality.gate.blockers : []),
    ].filter(Boolean);
    const seen = new Set();
    return items.map((item, index) => v0ReviewIssue(item, chapterNumber, index)).filter((issue) => {
        const key = `${issue.category}:${issue.message.zh}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
// —— 每章交接(handoff)透明面板 ——
// 把"每个 agent 为本章做了什么 + 它的意见/产出信号 + 它读了什么(有界注入) + 是否回写传给下一章"
// 合并成一份可读载荷,并落盘 story/handoffs/chN.md(人类一眼可读的单页交接)。
// 数据全部取自既有真相源,不臆造:质量报告(审稿/读者/Gate/指标)+ 总编缓存 + runtime/chapter-N.trace.json(读取台账)
// + chapter_summaries/current_state(回写佐证)。无追踪时给出诚实空态。
const TRUTH_SOURCE_LABELS = [
    [/story_frame/, "故事框架(硬约束)"],
    [/character_matrix|\/roles(\/|$)/, "角色矩阵"],
    [/volume_map/, "卷纲"],
    [/current_state/, "当前状态"],
    [/current_focus/, "当前焦点"],
    [/pending_hooks|hook_debt/, "伏笔账本"],
    [/author_intent/, "作者意图"],
    [/story_bible/, "故事圣经"],
    [/world_setting/, "世界设定"],
    [/style_profile|style_guide/, "风格指纹"],
    [/memory\.db|chapter_memo/, "记忆库"],
    [/chapter_summaries/, "章节摘要(滚动记忆)"],
    [/audit_drift/, "漂移审计"],
];
function labelTruthSource(p) {
    const s = String(p || "");
    for (const [re, label] of TRUTH_SOURCE_LABELS)
        if (re.test(s))
            return label;
    return "";
}
async function readChapterTraceFiles(state, bookId, chapterNumber) {
    const pad = String(chapterNumber).padStart(4, "0");
    const runtimeDir = join(state.bookDir(bookId), "story", "runtime");
    let trace = null, context = null, capturedAt = "";
    try {
        const tracePath = join(runtimeDir, `chapter-${pad}.trace.json`);
        trace = JSON.parse(await readFile(tracePath, "utf-8"));
        capturedAt = (await stat(tracePath)).mtime.toISOString();
    }
    catch { /* 无追踪 */ }
    try {
        context = JSON.parse(await readFile(join(runtimeDir, `chapter-${pad}.context.json`), "utf-8"));
    }
    catch { /* 无上下文快照 */ }
    return { trace, context, capturedAt };
}
async function buildChapterHandoff(state, root, bookId, num) {
    const payload = await buildChapterQualityPayload(state, bookId, num).catch(() => ({}));
    const q = payload.quality || {};
    const m = q.metrics || {};
    const stats = q.stats || {};
    const reader = q.reader || null;
    const gate = q.gate || {};
    const issues = reviewIssuesFromQuality(payload, num);
    const sev = (i) => String(i.severity || "").toLowerCase();
    const criticals = issues.filter((i) => sev(i) === "critical").length;
    const warnings = issues.filter((i) => sev(i) === "warning" || sev(i) === "warn").length;
    const wordCount = Number(stats.chineseChars) || 0;
    const hasStateConflict = Array.isArray(gate.blockers) && gate.blockers.some((b) => /state|状态|真相|conflict/i.test(String(b)));
    // 总编裁决缓存
    let editorial = null;
    try {
        editorial = JSON.parse(await readFile(join(state.bookDir(bookId), "story", "editorial", `ch${num}.json`), "utf-8"));
    }
    catch { /* 未签批 */ }
    // 修稿师是否动过(有无修订)
    const revision = await latestChapterRevisionText(root, bookId, num).catch(() => null);
    // 读取台账(有界注入证据)
    const { trace, context, capturedAt } = await readChapterTraceFiles(state, bookId, num);
    const selected = Array.isArray(trace?.selectedSources) ? trace.selectedSources : [];
    const plannerInputs = Array.isArray(trace?.plannerInputs) ? trace.plannerInputs : [];
    const recentSummaries = [...new Set(selected
        .map((s) => { const mm = String(s).match(/chapter_summaries\.md#(\d+)/); return mm ? Number(mm[1]) : null; })
        .filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
    const hookIds = [...new Set(selected
        .map((s) => { const mm = String(s).match(/(?:hook_debt|pending_hooks\.md)#(H?\d+)/i); return mm ? mm[1] : null; })
        .filter(Boolean))];
    const truthSources = [...new Set([...plannerInputs, ...selected].map(labelTruthSource).filter(Boolean))];
    const ctxSources = (Array.isArray(context?.selectedContext) ? context.selectedContext : []).slice(0, 12).map((it) => ({
        source: String(it?.source || ""),
        reason: String(it?.reason || ""),
        preview: String(it?.excerpt || "").replace(/\s+/g, " ").trim().slice(0, 90),
    }));
    let totalChapters = 0;
    try { totalChapters = (await state.loadChapterIndex(bookId)).length; }
    catch { /* 无索引 */ }
    // 追踪是否早于当前正文(本章后经人工/重写改动)
    let stale = false;
    if (capturedAt) {
        try {
            const ch = await resolveChapterFile(state, bookId, num);
            stale = (await stat(ch.fullPath)).mtime.getTime() > new Date(capturedAt).getTime() + 60000;
        }
        catch { /* 无正文 */ }
    }
    // 回写佐证(章节分析官是否把本章事实传下去)
    let summaryWritten = false, currentStateUpdatedAt = "";
    try {
        const sumText = await readFile(join(state.bookDir(bookId), "story", "chapter_summaries.md"), "utf-8");
        const title = String(payload.title || "");
        summaryWritten = new RegExp(`(^|\\n)[#>*\\-\\s\\[]*0*${num}[\\s.、)\\]|/]`).test(sumText) || (title.length > 1 && sumText.includes(title));
    }
    catch { /* 无摘要 */ }
    try { currentStateUpdatedAt = (await stat(join(state.bookDir(bookId), "story", "current_state.md"))).mtime.toISOString(); }
    catch { /* 无状态 */ }
    const fixed = (v) => Number.isFinite(Number(v)) ? Math.round(Number(v)) : null;
    // agent 账本(续写主链顺序 + 各自真实信号)
    const ledger = [
        { id: "planner", did: "拆解本章意图、上下文包、规则栈(对照卷纲+伏笔+当前状态)", signal: trace ? `读取 ${truthSources.length} 类真相源` : "—", tone: "info" },
        { id: "writer", did: "按意图写草稿,守性格锁/禁忌/3岁机制 + 嗓音指纹", signal: wordCount ? `${wordCount.toLocaleString()} 字草稿` : "已产出草稿", tone: "info" },
        { id: "auditor", did: "查连续性/性格漂移/视角/世界规则/伏笔超期/信息边界", signal: criticals ? `${criticals} 项 critical · ${warnings} 项 warning` : warnings ? `${warnings} 项 warning` : "无阻断问题", tone: criticals ? "risk" : warnings ? "warn" : "ok" },
        { id: "reviser", did: "按审稿意见逐条修,不引入新矛盾", signal: revision ? "已按意见修订" : (criticals || warnings) ? "待修订" : "无需返工", tone: revision ? "info" : criticals ? "warn" : "ok" },
        { id: "length-normalizer", did: "字数落目标区间,不压崩/截断", signal: fixed(m.length) != null ? `字数分 ${fixed(m.length)}` : "—", tone: "info" },
        { id: "polisher", did: "去 AI 腔、节奏,对照风格指纹 + 风格指南", signal: Number.isFinite(Number(stats.aiMarkers)) ? `AI腔标记 ${stats.aiMarkers}${fixed(m.style) != null ? ` · 文笔 ${fixed(m.style)}` : ""}` : fixed(m.style) != null ? `文笔 ${fixed(m.style)}` : "—", tone: "info" },
        { id: "chapter-analyzer", did: "抽取本章事实,回写摘要/当前状态/记忆库(滚动记忆)", signal: summaryWritten ? "已回写摘要+状态" : "未见回写", tone: summaryWritten ? "ok" : "warn" },
        { id: "state-validator", did: "真相变更与既有设定一致性,冲突即阻断落库", signal: hasStateConflict ? "检出状态冲突" : "一致", tone: hasStateConflict ? "risk" : "ok" },
        { id: "style-governor", did: "风格指纹贴合度(对照 style_profile.json)", signal: fixed(m.style) != null ? `风格贴合 ${fixed(m.style)}` : "—", tone: "info" },
        { id: "reader-critic", did: "读者信号:钩子/沉浸/清晰/追读意愿", signal: reader ? (`${reader.verdict || ""}${fixed(reader.total) != null ? ` · ${fixed(reader.total)}` : ""}`.trim() || "—") : "—", tone: "info" },
        { id: "quality-reporter", did: "汇总信号、算 Gate、失败归因、下一步修法", signal: fixed(q.total) != null ? `总分 ${fixed(q.total)} · Gate ${gate.pass ? "通过" : "未过"}` : "—", tone: gate.pass ? "ok" : fixed(q.total) != null ? "risk" : "info" },
        { id: "editor-in-chief", did: "读全部专家信号做整体裁决 + 批语 + 下一程方向", signal: editorial ? `${editorial.verdict === "pass" ? "签发" : "返工"}${fixed(editorial.editorialScore) != null ? ` · 编辑分 ${fixed(editorial.editorialScore)}` : ""}` : "未签批", tone: editorial ? (editorial.verdict === "pass" ? "ok" : "risk") : "info" },
    ].map((row) => ({ ...row, role: workflowAgentLabel(row.id) }));
    const handoff = {
        bookId, chapterNumber: num,
        title: payload.title || `第 ${num} 章`,
        generatedAt: new Date().toISOString(),
        agents: ledger,
        reads: {
            captured: Boolean(trace),
            capturedAt,
            stale,
            truthSources,
            recentSummaries,
            hookCount: hookIds.length,
            totalChapters,
            sources: ctxSources,
            boundedNote: trace
                ? `本章注入为有界集合:${truthSources.join("、") || "若干真相源"}${recentSummaries.length ? ` + 最近 ${recentSummaries.length} 章摘要(${recentSummaries.map((n) => `#${n}`).join(" ")})` : ""}${hookIds.length ? ` + ${hookIds.length} 条伏笔` : ""} + 记忆库检索。全书已 ${totalChapters} 章,但摘要按"最近窗口"注入,不随总章数线性膨胀。`
                : "本章暂无管线读取追踪(可能为人工撰写,或追踪在重置前已清理)。",
        },
        writeback: {
            summaryWritten,
            currentStateUpdatedAt,
            note: "章节分析官把本章事实回写 chapter_summaries / current_state / 记忆库;下一章 planner、writer 读取的是更新后的版本——形成'写完即沉淀、下一章即读到'的传递闭环。",
        },
        opinions: {
            audit: issues.slice(0, 8).map((i) => ({ severity: i.severity, category: i.category, message: i.message?.zh || i.message?.en || "" })),
            reader: reader ? { verdict: reader.verdict || "", total: fixed(reader.total), metrics: reader.metrics || {} } : null,
            editorial: editorial ? { verdict: editorial.verdict, editorialScore: editorial.editorialScore ?? null, rationale: editorial.rationale || "", reworkTargets: Array.isArray(editorial.reworkTargets) ? editorial.reworkTargets : [], nextDirection: editorial.nextDirection || "" } : null,
        },
        quality: {
            total: fixed(q.total),
            band: q.band || "",
            gate: { target: gate.target ?? null, pass: Boolean(gate.pass), blockers: Array.isArray(gate.blockers) ? gate.blockers : [] },
            metrics: m,
        },
    };
    await writeChapterHandoffMarkdown(state, bookId, handoff).catch(() => { });
    return handoff;
}
function handoffToneMark(t) { return t === "ok" ? "✓" : t === "warn" ? "△" : t === "risk" ? "✗" : "·"; }
async function writeChapterHandoffMarkdown(state, bookId, h) {
    const lines = [];
    lines.push(`# 第 ${h.chapterNumber} 章 · 交接记录《${h.title}》`);
    lines.push("");
    lines.push(`> 自动汇总:每个 agent 做了什么 + 意见/产出信号 + 读了什么(有界注入)+ 是否回写传给下一章。生成于 ${h.generatedAt}。`);
    lines.push("");
    lines.push("## 一、本章流水线(谁做了什么 · 产出信号)");
    lines.push("");
    lines.push("| 状态 | 角色 | 职责 | 本章信号 |");
    lines.push("|---|---|---|---|");
    for (const a of h.agents)
        lines.push(`| ${handoffToneMark(a.tone)} | ${a.role} | ${a.did} | ${a.signal} |`);
    lines.push("");
    lines.push("## 二、读了什么(上下文注入 · 有界证据)");
    lines.push("");
    lines.push(`- ${h.reads.boundedNote}`);
    if (h.reads.stale)
        lines.push("- ⚠ 追踪早于当前正文:本章在追踪之后经人工/重写改动,下方台账反映的是上一次管线生成时的注入。");
    if (h.reads.sources.length) {
        lines.push("");
        lines.push("| 来源 | 为什么读 | 摘录 |");
        lines.push("|---|---|---|");
        for (const s of h.reads.sources)
            lines.push(`| ${s.source} | ${s.reason} | ${s.preview} |`);
    }
    lines.push("");
    lines.push("## 三、写回了什么(是否传给下一章)");
    lines.push("");
    lines.push(`- 本章摘要回写:${h.writeback.summaryWritten ? "已写入 chapter_summaries" : "未见写入(若刚写完或重置后属正常)"}`);
    lines.push(`- 当前状态更新时间:${h.writeback.currentStateUpdatedAt || "—"}`);
    lines.push(`- ${h.writeback.note}`);
    lines.push("");
    lines.push("## 四、专家意见");
    lines.push("");
    if (h.opinions.audit.length) {
        lines.push("**审稿问题**");
        for (const i of h.opinions.audit)
            lines.push(`- [${i.severity}] ${i.category ? i.category + ":" : ""}${i.message}`);
        lines.push("");
    }
    if (h.opinions.reader)
        lines.push(`**读者评审**:${h.opinions.reader.verdict || "—"}${h.opinions.reader.total != null ? ` · ${h.opinions.reader.total}` : ""}`);
    if (h.opinions.editorial) {
        lines.push("");
        lines.push(`**总编裁决**:${h.opinions.editorial.verdict === "pass" ? "签发" : "返工"}${h.opinions.editorial.editorialScore != null ? ` · 编辑分 ${h.opinions.editorial.editorialScore}` : ""}`);
        if (h.opinions.editorial.rationale)
            lines.push(`> ${h.opinions.editorial.rationale}`);
        for (const t of h.opinions.editorial.reworkTargets)
            lines.push(`- 派工 ${t.agent}:${t.what}`);
        if (h.opinions.editorial.nextDirection)
            lines.push(`- 下一程方向:${h.opinions.editorial.nextDirection}`);
    }
    lines.push("");
    const dir = join(state.bookDir(bookId), "story", "handoffs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `ch${h.chapterNumber}.md`), lines.join("\n"), "utf-8");
}
function normalizeV0RoleStatus(status) {
    const raw = String(status || "").toLowerCase();
    if (/done|complete|已完成|完成|通过/.test(raw))
        return "done";
    if (/running|运行|处理中|生成中/.test(raw))
        return "running";
    if (/skip|error|错误|失败|跳过/.test(raw))
        return "skipped";
    return "queued";
}
function taskFlowForRun(run) {
    const type = String(run?.type || "");
    if (type === "chapter-quality-repair" || type === "quality-batch-repair")
        return "quality-repair";
    if (type === "book-ai-edit" || type === "rewrite")
        return "book-ai-edit";
    if (type === "selection-polish")
        return "selection-polish";
    if (type === "state-repair")
        return "state-repair";
    return "continue-writing";
}
function v0RoleQueueFromStatus(chapterStatus, runs = [], chapterNumber = 0) {
    const activeRuns = [...runs]
        .filter((run) => ["queued", "running", "repairing", "needs-repair"].includes(String(run.status || "")))
        .filter((run) => !chapterNumber || Number(run.currentChapter || run.chapterNumber || run.results?.[0]?.chapterNumber || 0) === chapterNumber || run.type === "write-batch")
        .sort((a, b) => toEpochMs(b.updatedAt || b.createdAt) - toEpochMs(a.updatedAt || a.createdAt));
    const activeRun = activeRuns[0] || null;
    const flowId = taskFlowForRun(activeRun);
    const flowAgents = AGENT_TASK_FLOWS[flowId]?.agents || [];
    const sourceQueue = flowAgents.length
        ? flowAgents.map((agentId) => ({ id: agentId, role: workflowAgentLabel(agentId), status: "待命", task: WORKFLOW_AGENT_TASK.get(agentId) || "" }))
        : (chapterStatus?.roleQueue || []);
    const activeAgent = activeRun?.currentAgent || (chapterStatus?.roleQueue || []).find((item) => normalizeV0RoleStatus(item.status) === "running")?.id || "";
    const activeIndex = sourceQueue.findIndex((item) => (item.id || item.agentId) === activeAgent);
    return sourceQueue.map((item, index) => {
        const agentId = item.id || item.agentId || item.agent || "";
        const completedByOrder = activeIndex > 0 && index < activeIndex;
        const runningByOrder = activeIndex >= 0 && index === activeIndex && ["queued", "running", "repairing"].includes(String(activeRun?.status || ""));
        const status = runningByOrder ? "running" : completedByOrder ? "done" : normalizeV0RoleStatus(item.status);
        const outputText = item.output?.zh || item.task || item.stage || item.role || workflowAgentLabel(agentId);
        return {
            agentId,
            status,
            startedAt: runningByOrder ? toEpochMs(activeRun?.updatedAt || activeRun?.createdAt) || undefined : undefined,
            durationMs: item.durationMs,
            output: bilingual(outputText),
        };
    });
}
function extractRevisionBody(markdown) {
    const text = String(markdown || "").replace(/\r\n/g, "\n");
    const match = text.match(/\n##\s*(?:修复后|改写后|润色后|增强后)[^\n]*\n+([\s\S]*?)(?=\n##\s+|$)/);
    return (match?.[1] || "").trim();
}
// 从修订快照 .md 里抽某个段落(原文摘录 / 修复后 / 修改说明…),并剥掉前导的"# 第N章 ..."标题行
function extractRevisionSection(markdown, headers) {
    const text = String(markdown || "").replace(/\r\n/g, "\n");
    const pat = new RegExp(`\\n##\\s*(?:${headers.join("|")})[^\\n]*\\n+([\\s\\S]*?)(?=\\n##\\s+|$)`);
    const body = (text.match(pat)?.[1] || "").trim();
    return body.replace(/^#\s+[^\n]*\n+/, "").trim();
}
// 解析一份修订快照:前(原文)/后(改后)/修改说明 + 类型/时间(从文件名)
function parseRevisionSnapshot(raw, filename) {
    const before = extractRevisionSection(raw, ["原文摘录", "原文", "修复前正文", "写手原稿", "草稿"]);
    const after = extractRevisionSection(raw, ["修复后", "改写后", "润色后", "增强后"]);
    const notes = extractRevisionSection(raw, ["修改说明", "改动说明", "变更说明"]);
    const m = String(filename).match(/^chapter-\d+-(.+?)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.md$/);
    const kindMap = { "quality-repair": "质量修复", "enhance": "扩写增强", "rewrite": "改写", "polish": "润色", "draft": "写手原稿" };
    const rawKind = m?.[1] || "revision";
    const timestamp = (m?.[2] || "").replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
    return { kind: rawKind, kindLabel: kindMap[rawKind] || rawKind, timestamp, before, after, notes, filename };
}
async function latestChapterRevisionText(root, bookId, chapterNumber) {
    const revisionsDir = join(root, ".hardwrite", "revisions", bookId);
    try {
        const entries = await readdir(revisionsDir, { withFileTypes: true });
        const prefix = `chapter-${String(chapterNumber).padStart(4, "0")}-`;
        const files = entries
            .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".md"))
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a));
        for (const filename of files) {
            const raw = await readFile(join(revisionsDir, filename), "utf-8").catch(() => "");
            const revised = extractRevisionBody(raw);
            if (revised)
                return { revised, filename };
        }
    }
    catch {
    }
    return null;
}
async function findBookCoverPath(state, bookId) {
    if (!isSafeBookId(bookId))
        return "";
    const bookDir = state.bookDir(bookId);
    for (const filename of ["cover.png", "cover.jpg", "cover.jpeg", "cover.webp", "cover.svg"]) {
        const candidate = join(bookDir, filename);
        try {
            const info = await stat(candidate);
            if (info.isFile())
                return candidate;
        }
        catch {
        }
    }
    return "";
}
function imageMimeType(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))
        return "image/jpeg";
    if (lower.endsWith(".webp"))
        return "image/webp";
    if (lower.endsWith(".svg"))
        return "image/svg+xml";
    return "image/png";
}
async function collectMarkdownFiles(base, maxFiles = 120, prefix = "") {
    let entries = [];
    try {
        entries = await readdir(base, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const files = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))) {
        if (files.length >= maxFiles)
            break;
        const fullPath = join(base, entry.name);
        const relativePath = prefix ? join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) {
            files.push(...await collectMarkdownFiles(fullPath, maxFiles - files.length, relativePath));
        }
        else if (entry.isFile() && entry.name.endsWith(".md")) {
            files.push({ path: fullPath, relativePath, name: entry.name.replace(/\.md$/, "") });
        }
    }
    return files.slice(0, maxFiles);
}
function markdownTitle(text, fallback) {
    const heading = String(text ?? "").match(/^#\s+(.+)$/m);
    return sanitizeVaultName(heading?.[1] || fallback, fallback);
}
function markdownExcerpt(text, size = 220) {
    return String(text ?? "").replace(/```[\s\S]*?```/g, " ").replace(/[#>*_\-[\]()`]/g, " ").replace(/\s+/g, " ").trim().slice(0, size);
}
function stripMarkdownMatter(text) {
    return String(text ?? "").replace(/^---\s*[\r\n][\s\S]*?[\r\n]---\s*/m, "").trim();
}
function inlineMarkdownHtml(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
        const safeLabel = escapeHtml(label);
        const rawHref = String(href || "").trim();
        if (/^https?:\/\//i.test(rawHref)) {
            return `<a href="${escapeHtml(rawHref)}" target="_blank" rel="noreferrer">${safeLabel}</a>`;
        }
        return `<span class="doc-ref">${safeLabel}</span>`;
    });
    html = html.replace(/\[\[([^\]]+)\]\]/g, (_match, label) => `<span class="doc-ref">${escapeHtml(label)}</span>`);
    return html;
}
function markdownOutline(text) {
    return stripMarkdownMatter(text).split(/\r?\n/)
        .map((line) => line.match(/^(#{1,4})\s+(.+)$/))
        .filter(Boolean)
        .slice(0, 24)
        .map((match) => ({ level: match[1].length, title: sanitizeVaultName(match[2], "未命名小节") }));
}
function markdownSummary(text, fallback = "") {
    const clean = stripMarkdownMatter(text)
        .replace(/```[\s\S]*?```/g, " ")
        .split(/\r?\n/)
        .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").trim())
        .filter((line) => line && !/^[-:|]+$/.test(line) && !/^\|/.test(line));
    return (clean.find((line) => line.length >= 12) || clean[0] || fallback || "").slice(0, 260);
}
function markdownHeadingSlug(title, index = 0) {
    const base = String(title || "section")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        || "section";
    return `${base}-${index + 1}`;
}
function renderMarkdownTable(rows) {
    const parsed = rows.map((row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => inlineMarkdownHtml(cell.trim())));
    if (!parsed.length)
        return "";
    const [, divider] = parsed;
    const hasDivider = divider?.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/<[^>]+>/g, "")));
    const head = parsed[0] || [];
    const body = hasDivider ? parsed.slice(2) : parsed.slice(1);
    return `<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function renderMarkdownHtml(markdown) {
    const lines = stripMarkdownMatter(markdown).replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let paragraph = [];
    let list = [];
    let ordered = false;
    let quote = [];
    let code = [];
    let inCode = false;
    let table = [];
    const flushParagraph = () => {
        if (paragraph.length) {
            html.push(`<p>${inlineMarkdownHtml(paragraph.join(" "))}</p>`);
            paragraph = [];
        }
    };
    const flushList = () => {
        if (list.length) {
            html.push(`<${ordered ? "ol" : "ul"}>${list.map((item) => `<li>${inlineMarkdownHtml(item)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
            list = [];
        }
    };
    const flushQuote = () => {
        if (quote.length) {
            html.push(`<blockquote>${quote.map((line) => `<p>${inlineMarkdownHtml(line)}</p>`).join("")}</blockquote>`);
            quote = [];
        }
    };
    const flushTable = () => {
        if (table.length) {
            html.push(renderMarkdownTable(table));
            table = [];
        }
    };
    let headingIndex = 0;
    for (const line of lines) {
        if (/^```/.test(line.trim())) {
            flushParagraph();
            flushList();
            flushQuote();
            flushTable();
            if (inCode) {
                html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
                code = [];
                inCode = false;
            }
            else {
                inCode = true;
            }
            continue;
        }
        if (inCode) {
            code.push(line);
            continue;
        }
        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            flushList();
            flushQuote();
            flushTable();
            const title = heading[2].trim();
            const slug = markdownHeadingSlug(title, headingIndex++);
            html.push(`<h${heading[1].length} id="${escapeHtml(slug)}">${inlineMarkdownHtml(title)}</h${heading[1].length}>`);
            continue;
        }
        if (/^\s*$/.test(line)) {
            flushParagraph();
            flushList();
            flushQuote();
            flushTable();
            continue;
        }
        if (/^\|.+\|$/.test(line.trim())) {
            flushParagraph();
            flushList();
            flushQuote();
            table.push(line);
            continue;
        }
        const listMatch = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/);
        if (listMatch) {
            flushParagraph();
            flushQuote();
            flushTable();
            const isOrdered = /^\s*\d+\.\s+/.test(line);
            if (list.length && ordered !== isOrdered)
                flushList();
            ordered = isOrdered;
            list.push(listMatch[1].trim());
            continue;
        }
        const quoteMatch = line.match(/^\s*>\s?(.+)$/);
        if (quoteMatch) {
            flushParagraph();
            flushList();
            flushTable();
            quote.push(quoteMatch[1].trim());
            continue;
        }
        flushList();
        flushQuote();
        flushTable();
        paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
    if (inCode)
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    return html.join("\n") || "<p>这份文档还没有正文。</p>";
}
function buildRenderedDocument(markdown, fallbackTitle, sourcePath, kind = "markdown") {
    const clean = stripMarkdownMatter(markdown);
    const title = markdownTitle(clean, fallbackTitle || "未命名文档");
    const outline = markdownOutline(clean).map((item, index) => ({ ...item, slug: markdownHeadingSlug(item.title, index) }));
    return {
        title,
        summary: markdownSummary(clean, fallbackTitle),
        html: renderMarkdownHtml(clean),
        outline,
        sourcePath,
        kind,
        chars: countWritingChars(clean),
        sectionCount: outline.length,
    };
}
function pushWikiNode(nodes, node) {
    if (!nodes.some((item) => item.id === node.id)) {
        nodes.push(node);
    }
}
function pushWikiEdge(edges, source, target, label) {
    if (!source || !target || source === target)
        return;
    const id = `${source}->${target}:${label || "关联"}`;
    if (!edges.some((item) => item.id === id)) {
        edges.push({ id, source, target, label: label || "关联" });
    }
}
const MEMORY_LAYER_DEFS = [
    {
        id: "semantic",
        title: "语义记忆",
        subtitle: "人物、世界观、设定事实",
        source: "story/roles + story/story_frame.md + story/wiki/world",
        use: "让后续 Agent 不忘角色身份、地点规则、时代常识和已确认设定。",
    },
    {
        id: "episodic",
        title: "经历记忆",
        subtitle: "章节、事件、失败归因",
        source: "chapters + story/agent_assets/timeline.jsonl + reports",
        use: "让系统知道这一章写到哪里、哪次失败为什么失败、下一轮应该接哪条剧情线。",
    },
    {
        id: "procedural",
        title: "流程记忆",
        subtitle: "工程约束、Agent 提示词、输出格式",
        source: "story/book_rules.md + agentProfiles + project config",
        use: "让写、审、改、润、复审始终按同一套质量门和格式交付。",
    },
    {
        id: "style",
        title: "风格指纹",
        subtitle: "节奏、句法、镜头、去 AI 味约束",
        source: "story/style_fingerprint.md + story/wiki/style",
        use: "把模仿目标抽象成可复用手法，不复制受保护表达，续写时保持口感稳定。",
    },
];
const STYLE_FINGERPRINT_PRESETS = [
    {
        id: "webnovel-hook-fast",
        title: "网文强钩子",
        lineage: "平台连载型",
        bestFor: "悬疑、都市异能、升级流、爽点驱动章节",
        rhythm: "短中句交替，每 700-1200 字抛一个新问题或反转。",
        pov: "贴近主角即时感受，少解释，多让冲突推动信息露出。",
        sentence: "动词优先，抽象判断后置，段尾保留未完成张力。",
        dialogue: "对白承担推进和试探，不让人物互相讲百科。",
        detail: "关键物件、时间、空间方位要具体，背景信息只在动作里泄露。",
        taboo: "禁止连续总结主题；禁止“他意识到/命运齿轮”等空泛 AI 句。",
    },
    {
        id: "scene-realism",
        title: "现实质感白描",
        lineage: "现实主义/年代叙事",
        bestFor: "年代文、群像、社会切片、生活流转折",
        rhythm: "段落呼吸更长，先给物和场，再让人物在压力里露出选择。",
        pov: "有限视角，尊重人物不知道的部分。",
        sentence: "朴素、准确、少形容词，用细节承担情绪。",
        dialogue: "留半句、留沉默，方言和口癖只点到为止。",
        detail: "用票据、天气、街巷、物价、单位制度建立可信时代。",
        taboo: "禁止把人物写成观点容器；禁止现代口吻穿帮。",
    },
    {
        id: "suspense-noir",
        title: "冷硬悬疑镜头",
        lineage: "侦探/黑色电影式",
        bestFor: "阴谋线、调查线、秘密暴露、危险场景",
        rhythm: "句子更硬，信息像证据一样一块块落下。",
        pov: "镜头贴近感官，读者和主角同步拼图。",
        sentence: "少修饰，多动作；段尾常落在异常细节上。",
        dialogue: "每句对白都有目的：遮掩、试探、误导或威胁。",
        detail: "气味、光线、金属、纸张、脚步声服务线索。",
        taboo: "禁止提前解释谜底；禁止无代价的巧合。",
    },
    {
        id: "sensory-literary",
        title: "感官文学化",
        lineage: "散文化小说",
        bestFor: "人物内伤、梦境、记忆回潮、关系裂缝",
        rhythm: "长短句制造潮汐，情绪通过意象回环。",
        pov: "内心贴身但不直白命名情绪。",
        sentence: "比喻必须来自角色经验，不使用通用漂亮句。",
        dialogue: "少说破，多错位；让沉默和动作成为对白的一部分。",
        detail: "重复意象要承担人物变化，而不是装饰。",
        taboo: "禁止堆叠形容词；禁止廉价金句化。",
    },
    {
        id: "wuxia-momentum",
        title: "江湖推进感",
        lineage: "武侠/奇情冒险",
        bestFor: "师徒、门派、旅途、恩怨、奇遇",
        rhythm: "快进慢停：动作快，落脚在人情和规矩。",
        pov: "以人物义气、身份、门规制造选择压力。",
        sentence: "干净有力，少现代网络词。",
        dialogue: "有分寸的江湖话，不堆古风词。",
        detail: "兵器、酒肆、山路、旧伤、信物都要和因果有关。",
        taboo: "禁止空喊热血；禁止无来源的绝世天赋。",
    },
    {
        id: "comic-dialogue",
        title: "对白喜剧",
        lineage: "轻喜剧/吐槽流",
        bestFor: "反差人设、搭档关系、日常推进、紧张后的释压",
        rhythm: "包袱短促，笑点后马上回到目标或危机。",
        pov: "角色有自洽脑回路，吐槽来自性格不是作者插嘴。",
        sentence: "快节奏短句和冷不丁的具体比喻。",
        dialogue: "互相误解、抢话、接错重点，但不能离开剧情。",
        detail: "用生活化动作破掉宏大叙述的僵硬。",
        taboo: "禁止段段抖机灵；禁止网络梗替代人物关系。",
    },
];
function buildMemoryLayers({ chapterIndex, nodes, edges }) {
    const countBy = (type) => nodes.filter((node) => node.type === type || node.group === type).length;
    const totals = {
        semantic: countBy("role") + countBy("world") + countBy("世界观") + countBy("人物"),
        episodic: chapterIndex.length + edges.filter((edge) => edge.label === "推进" || edge.label === "出场").length,
        procedural: countBy("rules") + countBy("bookRules") + countBy("工程约束"),
        style: countBy("style") + countBy("风格指纹"),
    };
    return MEMORY_LAYER_DEFS.map((layer) => ({
        ...layer,
        count: totals[layer.id] || 0,
        status: (totals[layer.id] || 0) > 0 ? "ready" : "empty",
    }));
}
function stylePresetMarkdown(preset) {
    return [
        `# 风格指纹：${preset.title}`,
        "",
        `- 指纹 ID：${preset.id}`,
        `- 类型来源：${preset.lineage}`,
        `- 适合场景：${preset.bestFor}`,
        "",
        "## 可执行风格参数",
        `- 节奏：${preset.rhythm}`,
        `- 视角：${preset.pov}`,
        `- 句法：${preset.sentence}`,
        `- 对白：${preset.dialogue}`,
        `- 细节：${preset.detail}`,
        "",
        "## 去 AI 味硬约束",
        `- ${preset.taboo}`,
        "- 不复制任何特定在世作者或受版权保护作品的独特表达，只抽取抽象叙事手法。",
    ].join("\n");
}
async function buildBookWiki(state, root, bookId) {
    if (!isSafeBookId(bookId)) {
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    }
    const book = await state.loadBookConfig(bookId);
    const bookDir = state.bookDir(bookId);
    const chapterIndex = [...(await state.loadChapterIndex(bookId).catch(() => []))]
        .sort((a, b) => Number(a.chapterNumber ?? a.number ?? 0) - Number(b.chapterNumber ?? b.number ?? 0));
    const nodes = [];
    const edges = [];
    const bookNodeId = `book:${bookId}`;
    const bookDocument = buildRenderedDocument([
        `# ${book.title || bookId}`,
        "",
        book.brief || book.genre || "这本书还没有完整简介。",
        "",
        `- 题材：${book.genre || "未设置"}`,
        `- 语言：${book.language || "zh"}`,
        `- 每章目标：${book.chapterWordCount || book.targetChapterWords || book.wordCount || 3000} 字`,
    ].join("\n"), book.title || bookId, "book.json", "book");
    pushWikiNode(nodes, {
        id: bookNodeId,
        type: "book",
        group: "作品",
        title: book.title || bookId,
        subtitle: book.genre || "长篇小说",
        size: 14,
        body: bookDocument.summary,
        path: "book.json",
        document: bookDocument,
    });
    const chapterContents = [];
    for (const meta of chapterIndex) {
        const chapterNumber = Number(meta.chapterNumber ?? meta.number);
        if (!Number.isInteger(chapterNumber) || chapterNumber <= 0)
            continue;
        let content = "";
        let filename = "";
        try {
            const file = await resolveChapterFile(state, bookId, chapterNumber);
            content = await readFile(file.fullPath, "utf-8");
            filename = file.filename;
        }
        catch {
            content = "";
        }
        const title = meta.title || `第${chapterNumber}章`;
        const id = `chapter:${chapterNumber}`;
        chapterContents.push({ id, title, content });
        pushWikiNode(nodes, {
            id,
            type: "chapter",
            group: "章节",
            title: `第${chapterNumber}章 ${title}`,
            subtitle: `${countWritingChars(content || "") || meta.wordCount || 0} 字`,
            size: 10,
            body: markdownExcerpt(content, 260),
            path: filename ? `chapters/${filename}` : "",
            document: buildRenderedDocument(content || `# 第${chapterNumber}章 ${title}\n\n章节文件暂时不可读。`, `第${chapterNumber}章 ${title}`, filename ? `chapters/${filename}` : "", "chapter"),
        });
        pushWikiEdge(edges, bookNodeId, id, "目录");
        if (chapterNumber > 1)
            pushWikiEdge(edges, `chapter:${chapterNumber - 1}`, id, "推进");
    }
    const readFirstStoryDoc = async (paths) => {
        for (const relativePath of paths) {
            const body = await readOptionalText(join(bookDir, relativePath));
            if (body.trim())
                return { body, relativePath };
        }
        return { body: "", relativePath: paths[0] };
    };
    const storyDocs = [
        ["world", "世界观", ["story/outline/story_frame.md", "story/story_frame.md"]],
        ["volume", "卷纲", ["story/outline/volume_map.md", "story/volume_map.md"]],
        ["description", "网站简介", ["story/book_description.md"]],
        ["characters", "角色矩阵", ["story/outline/character_matrix.md", "story/character_matrix.md"]],
        ["subplot", "支线看板", ["story/outline/subplot_board.md"]],
        ["rules", "工程约束", ["story/book_rules.md"]],
        ["hooks", "伏笔池", ["story/pending_hooks.md"]],
        ["style", "风格指纹", ["story/style_fingerprint.md"]],
        ["focus", "当前焦点", ["story/current_focus.md"]],
        ["notes", "后续意见", ["story/human_notes.md"]],
        ["canon", "原作/父级正典", ["story/parent_canon.md", "story/fanfic_canon.md"]],
        ["emotions", "情绪弧线", ["story/emotional_arcs.md"]],
        ["particles", "粒子账本", ["story/particle_ledger.md"]],
    ];
    for (const [type, label, candidates] of storyDocs) {
        const { body, relativePath } = await readFirstStoryDoc(candidates);
        if (!body.trim())
            continue;
        const document = buildRenderedDocument(body, label, relativePath, type);
        const id = `${type}:${label}`;
        pushWikiNode(nodes, {
            id,
            type,
            group: label,
            title: label,
            subtitle: relativePath,
            size: 9,
            body: document.summary || markdownExcerpt(body, 320),
            path: relativePath,
            document,
        });
        pushWikiEdge(edges, bookNodeId, id, "支撑");
    }
    const roleFiles = await collectMarkdownFiles(join(bookDir, "story", "roles"), 80);
    for (const file of roleFiles) {
        const body = await readOptionalText(file.path);
        const title = markdownTitle(body, file.name);
        const id = `role:${title}`;
        pushWikiNode(nodes, {
            id,
            type: "role",
            group: "人物",
            title,
            subtitle: file.relativePath,
            size: 11,
            body: markdownExcerpt(body, 260),
            path: `story/roles/${file.relativePath}`,
            document: buildRenderedDocument(body, title, `story/roles/${file.relativePath}`, "role"),
        });
        pushWikiEdge(edges, bookNodeId, id, "人物");
        for (const chapter of chapterContents) {
            if (title.length >= 2 && chapter.content.includes(title)) {
                pushWikiEdge(edges, id, chapter.id, "出场");
            }
        }
    }
    const wikiFiles = await collectMarkdownFiles(join(bookDir, "story", "wiki"), 120);
    for (const file of wikiFiles) {
        const body = await readOptionalText(file.path);
        const type = file.relativePath.split(/[\\/]/)[0] || "wiki";
        const title = markdownTitle(body, file.name);
        const id = `wiki:${type}:${title}`;
        const group = type === "plot" ? "剧情节点" : type === "relationship" ? "人物关系" : "LLM Wiki";
        pushWikiNode(nodes, {
            id,
            type,
            group,
            title,
            subtitle: file.relativePath,
            size: type === "plot" ? 12 : 9,
            body: markdownExcerpt(body, 360),
            path: `story/wiki/${file.relativePath}`,
            document: buildRenderedDocument(body, title, `story/wiki/${file.relativePath}`, type),
        });
        pushWikiEdge(edges, bookNodeId, id, type === "plot" ? "可插入剧情" : "Wiki");
        for (const chapter of chapterContents) {
            if (body.includes(chapter.title) || body.includes(`第${chapter.title}`)) {
                pushWikiEdge(edges, id, chapter.id, "指向章节");
            }
        }
    }
    for (const preset of STYLE_FINGERPRINT_PRESETS) {
        const id = `style-preset:${preset.id}`;
        pushWikiNode(nodes, {
            id,
            type: "style-preset",
            group: "风格指纹预设",
            title: preset.title,
            subtitle: `${preset.lineage} · ${preset.bestFor}`,
            size: 8,
            body: markdownExcerpt(stylePresetMarkdown(preset), 360),
            path: `builtin://style/${preset.id}`,
            document: buildRenderedDocument(stylePresetMarkdown(preset), preset.title, `builtin://style/${preset.id}`, "style-preset"),
        });
        pushWikiEdge(edges, bookNodeId, id, "可选风格");
    }
    const memoryLayers = buildMemoryLayers({ chapterIndex, nodes, edges });
    for (const layer of memoryLayers) {
        const id = `memory:${layer.id}`;
        pushWikiNode(nodes, {
            id,
            type: "memory",
            group: "长期记忆层",
            title: layer.title,
            subtitle: `${layer.subtitle} · ${layer.count} 条线索`,
            size: 9,
            body: `${layer.use}\n\n来源：${layer.source}`,
            path: layer.source,
            document: buildRenderedDocument(`# ${layer.title}\n\n${layer.use}\n\n- 来源：${layer.source}\n- 线索数量：${layer.count}`, layer.title, layer.source, "memory"),
        });
        pushWikiEdge(edges, bookNodeId, id, "长期记忆");
    }
    const relationshipEdges = edges.filter((edge) => edge.label === "出场" || edge.label === "人物" || edge.label === "可插入剧情");
    const wikiMarkdown = [
        `# ${book.title || bookId} LLM Wiki`,
        "",
        `- 作品：[[${book.title || bookId}]]`,
        `- 章节：${chapterIndex.length} 章`,
        `- 节点：${nodes.length} 个`,
        `- 关系：${edges.length} 条`,
        "",
        "## 目录",
        ...chapterIndex.map((chapter) => `- [[第${chapter.chapterNumber ?? chapter.number}章 ${chapter.title || "未命名"}]]`),
        "",
        "## 人物",
        ...nodes.filter((node) => node.type === "role").map((node) => `- [[${node.title}]]：${node.body}`),
        "",
        "## 长期记忆层",
        ...memoryLayers.map((layer) => `- [[${layer.title}]]：${layer.subtitle}；${layer.use}`),
        "",
        "## 风格指纹预设",
        ...STYLE_FINGERPRINT_PRESETS.map((preset) => `- [[${preset.title}]]：${preset.bestFor}；${preset.taboo}`),
        "",
        "## 可插入剧情节点",
        ...nodes.filter((node) => node.type === "plot").map((node) => `- [[${node.title}]]：${node.body}`),
    ].join("\n");
    const documents = nodes
        .filter((node) => node.document)
        .map((node) => ({
        id: node.id,
        title: node.title,
        path: node.path,
        kind: node.document.kind,
        chars: node.document.chars,
        sectionCount: node.document.sectionCount,
        summary: node.document.summary,
        outline: node.document.outline,
    }));
    return {
        book: { ...book, id: bookId },
        nodes,
        edges,
        relationshipEdges,
        memoryLayers,
        stylePresets: STYLE_FINGERPRINT_PRESETS,
        documents,
        wikiMarkdown,
        stats: {
            nodes: nodes.length,
            edges: edges.length,
            chapters: chapterIndex.length,
            roles: nodes.filter((node) => node.type === "role").length,
            plotNodes: nodes.filter((node) => node.type === "plot").length,
            documents: documents.length,
        },
        obsidianDir: join(bookDir, "story", "wiki"),
    };
}
function v0Text(zh, en = zh) {
    const primary = String(zh || en || "").trim();
    const secondary = String(en || primary).trim();
    return { zh: primary, en: secondary || primary };
}
function v0Slug(input, fallback = "item") {
    return String(input || fallback)
        .toLowerCase()
        .replace(/\.[a-z0-9]+$/i, "")
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64) || fallback;
}
function v0AssetType(name) {
    const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
    if (["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"].includes(ext))
        return "image";
    if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext))
        return "audio";
    if (["mp4", "mov", "webm", "mkv"].includes(ext))
        return "video";
    return "doc";
}
async function collectV0AssetFiles(base, maxFiles = 120, prefix = "") {
    let entries = [];
    try {
        entries = await readdir(base, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const result = [];
    for (const entry of entries) {
        if (result.length >= maxFiles)
            break;
        if (entry.name.startsWith("."))
            continue;
        const fullPath = join(base, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (["node_modules", ".git", "runs"].includes(entry.name))
                continue;
            result.push(...await collectV0AssetFiles(fullPath, maxFiles - result.length, relativePath));
            continue;
        }
        if (!/\.(md|json|txt|png|jpe?g|webp|gif|svg|avif|mp3|wav|m4a|aac|flac|ogg|mp4|mov|webm|mkv)$/i.test(entry.name))
            continue;
        try {
            const info = await stat(fullPath);
            result.push({ name: entry.name, relativePath, size: info.size, updatedAt: info.mtime.toISOString() });
        }
        catch {
            result.push({ name: entry.name, relativePath });
        }
    }
    return result.slice(0, maxFiles);
}
async function buildV0Assets(state, root, bookId) {
    if (!isSafeBookId(bookId))
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    const bookDir = state.bookDir(bookId);
    const files = await collectV0AssetFiles(join(bookDir, "story"));
    return files.map((file, index) => ({
        id: v0Slug(file.relativePath, `asset-${index + 1}`),
        name: v0Text(file.relativePath, file.relativePath),
        type: v0AssetType(file.name),
        ...(typeof file.size === "number" ? { size: file.size } : {}),
        ...(file.updatedAt ? { updatedAt: file.updatedAt } : {}),
    }));
}
function v0Faction(id, zh, en, color, descZh, descEn = descZh) {
    return { id, name: v0Text(zh, en), color, desc: v0Text(descZh, descEn) };
}
const V0_FACTIONS = [
    v0Faction("order", "作品主线", "Main Line", "var(--chart-1)", "主角、核心盟友和作品主叙事。"),
    v0Faction("black-tower", "知识/组织", "Knowledge", "var(--chart-3)", "设定、组织、学会与资料线。"),
    v0Faction("abyss", "对抗方", "Opposition", "var(--chart-4)", "反派、危机、阻力与悬念来源。"),
    v0Faction("free", "未归类", "Unclassified", "var(--muted-foreground)", "暂未归档的角色与关系。"),
];
function v0RoleNodeToCast(node, index) {
    const title = String(node?.title || `角色 ${index + 1}`).trim();
    const body = String(node?.body || node?.subtitle || "");
    const factionId = /反派|敌|深渊|危机|阻力/.test(body) ? "abyss" : /学会|组织|门派|机构/.test(body) ? "black-tower" : "order";
    return {
        id: v0Slug(title, `role-${index + 1}`),
        name: v0Text(title, title),
        role: v0Text(node?.subtitle || node?.group || "角色", node?.subtitle || node?.group || "Character"),
        arc: Math.max(0.18, Math.min(0.95, 0.95 - index * 0.07)),
        color: factionId === "abyss" ? "var(--chart-4)" : factionId === "black-tower" ? "var(--chart-3)" : "var(--chart-1)",
        importance: Math.max(1, Math.min(5, 5 - Math.floor(index / 2))),
        factionId,
        tagline: v0Text(markdownExcerpt(body, 80) || node?.path || "来自本地角色档案", markdownExcerpt(body, 80) || node?.path || "Local role profile"),
    };
}
async function buildV0Cast(state, root, bookId) {
    // 从 character_matrix(权威角色源,与故事图谱/关系图一致)派生角色卡,而非旧的 roles/ wiki 节点
    // ——后者在重置/改稿后易残留过期角色,导致角色卡与图谱/实体页不一致、点进去找不到实体。
    const data = await buildBookCharacters(state, root, bookId);
    if (!data.characters.length) {
        // 没建 character_matrix 的老书:退回 wiki role 节点,保持兼容不至于空白
        const wiki = await buildBookWiki(state, root, bookId);
        return wiki.nodes.filter((node) => node.type === "role").map(v0RoleNodeToCast);
    }
    const impByKind = { protagonist: 5, deuteragonist: 4, antagonist: 4, mentor: 3, mystery: 3, supporting: 2 };
    const factionByKind = (k) => (k === "antagonist" ? "abyss" : k === "mentor" ? "black-tower" : "order");
    return data.characters.map((c, index) => {
        const factionId = factionByKind(c.roleKind);
        const lastArc = Array.isArray(c.arc) && c.arc.length ? Number(c.arc[c.arc.length - 1].intensity) || 0 : 0;
        const arc = lastArc ? Math.max(0.1, Math.min(1, lastArc / 10)) : Math.max(0.18, Math.min(0.95, 0.9 - index * 0.06));
        const taglineSrc = (c.tags && c.tags.length ? c.tags.slice(0, 3).join(" · ") : (c.current || c.role || "角色"));
        const tagline = String(taglineSrc).slice(0, 80);
        return {
            id: v0Slug(c.name, `role-${index + 1}`),
            name: v0Text(c.name, c.name),
            role: v0Text(c.role || c.roleKind, c.role || c.roleKind),
            arc,
            color: factionId === "abyss" ? "var(--chart-4)" : factionId === "black-tower" ? "var(--chart-3)" : "var(--chart-1)",
            importance: impByKind[c.roleKind] ?? 2,
            factionId,
            tagline: v0Text(tagline, tagline),
        };
    });
}
async function buildV0World(state, root, bookId) {
    const wiki = await buildBookWiki(state, root, bookId);
    const count = (predicate) => wiki.nodes.filter(predicate).length;
    return [
        { id: "lore", title: v0Text("核心设定", "Core lore"), count: count((node) => ["world", "rules", "style", "book", "volume"].includes(node.type)) },
        { id: "events", title: v0Text("关键事件", "Key events"), count: count((node) => node.type === "chapter" || node.type === "plot") },
        { id: "rels", title: v0Text("角色关系", "Relations"), count: wiki.relationshipEdges.length },
        { id: "world", title: v0Text("世界观", "World"), count: count((node) => /世界|设定|wiki/i.test(String(node.group || node.type || ""))) },
    ];
}
async function buildV0Outline(state, bookId) {
    if (!isSafeBookId(bookId))
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    const book = await state.loadBookConfig(bookId);
    const chapters = [...(await state.loadChapterIndex(bookId).catch(() => []))]
        .sort((a, b) => Number(a.chapterNumber ?? a.number ?? 0) - Number(b.chapterNumber ?? b.number ?? 0));
    const target = Number(book.chapterWordCount || book.targetChapterWords || book.wordCount || 3000);
    const mapped = chapters.map((chapter, index) => {
        const num = Number(chapter.chapterNumber ?? chapter.number ?? index + 1);
        return {
            id: `c${num}`,
            num,
            title: v0Text(chapter.title || `第${num}章`, chapter.title || `Chapter ${num}`),
            beats: Array.isArray(chapter.beats) ? chapter.beats.length : Math.max(1, Math.round(Number(chapter.wordCount || 0) / 700) || 1),
            words: Number(chapter.wordCount || 0) || target,
            status: String(chapter.status || (Number(chapter.wordCount || 0) > 0 ? "done" : "draft")),
        };
    });
    if (!mapped.length) {
        mapped.push({
            id: "c1",
            num: 1,
            title: v0Text("第1章", "Chapter 1"),
            beats: 1,
            words: target,
            status: "draft",
        });
    }
    return [{
            actId: "a1",
            actTitle: v0Text(book.firstVolumeTitle || "第一卷", book.firstVolumeTitle || "Act I"),
            chapters: mapped,
        }];
}
async function buildV0PlotProgress(state, bookId) {
    const outline = await buildV0Outline(state, bookId);
    const chapters = outline.flatMap((act) => act.chapters);
    const total = Math.max(chapters.length, 1);
    const doneCount = chapters.filter((chapter) => /done|approved|publish|released|complete|完成|通过/.test(String(chapter.status))).length;
    const currentProgress = Math.max(0.05, Math.min(0.95, doneCount / total || 1 / total));
    const milestones = [
        { id: "p1", label: v0Text("开篇", "Opening"), progress: 0.05 },
        { id: "p2", label: v0Text("发展", "Rising"), progress: 0.25 },
        { id: "p3", label: v0Text("高潮", "Climax"), progress: 0.65 },
        { id: "p4", label: v0Text("结局", "Ending"), progress: 0.95 },
    ].map((milestone) => ({
        ...milestone,
        status: currentProgress >= milestone.progress + 0.05 ? "done" : Math.abs(currentProgress - milestone.progress) < 0.25 ? "current" : "todo",
    }));
    const current = [...milestones].reverse().find((item) => currentProgress >= item.progress - 0.12) ?? milestones[0];
    return {
        bookId,
        milestones,
        currentMilestoneId: current.id,
        tensionCurve: chapters.map((chapter, index) => ({
            chapter: chapter.num,
            tension: Math.max(0.2, Math.min(0.96, 0.28 + index / Math.max(total, 1) * 0.45 + Math.min(0.25, Number(chapter.words || 0) / 16000))),
        })),
    };
}
async function buildV0Memory(state, root, bookId, kind) {
    const wiki = await buildBookWiki(state, root, bookId);
    const chapterCount = Number(wiki.stats?.chapters || 1) || 1;
    const items = wiki.nodes
        .filter((node) => ["memory", "world", "rules", "focus", "notes", "plot", "role"].includes(node.type))
        .slice(0, 80)
        .map((node, index) => {
        const inferredKind = node.type === "world" || node.group === "世界观" ? "world" : node.type === "focus" || node.type === "notes" || node.type === "plot" ? "current" : "long";
        return {
            id: v0Slug(`${node.type}-${node.title}`, `m${index + 1}`),
            text: v0Text(node.title || node.body || `记忆 ${index + 1}`, markdownExcerpt(node.body || node.subtitle || node.title || "", 120) || node.title || `Memory ${index + 1}`),
            chapter: Math.max(1, Math.min(chapterCount, index + 1)),
            kind: inferredKind,
        };
    });
    return kind ? items.filter((item) => item.kind === kind) : items;
}
async function buildV0StyleFingerprint(state, root, bookId) {
    const wiki = await buildBookWiki(state, root, bookId);
    const stats = await state.loadChapterIndex(bookId).then((chapters) => computeAnalytics(bookId, chapters)).catch(() => null);
    const docs = Number(wiki.stats?.documents || 0);
    const chapters = Number(wiki.stats?.chapters || 0);
    const tokens = Number(stats?.tokenStats?.totalTokens || 0);
    const axes = [
        { axis: v0Text("节奏感", "Pace"), value: Math.min(0.95, 0.55 + Math.min(chapters, 20) / 60) },
        { axis: v0Text("情感浓度", "Emotion"), value: Math.min(0.95, 0.5 + wiki.nodes.filter((node) => /情绪|人物|关系/.test(String(node.group || node.type || ""))).length / 40) },
        { axis: v0Text("语言风格", "Diction"), value: Math.min(0.95, 0.5 + docs / 80) },
        { axis: v0Text("创新度", "Novelty"), value: Math.min(0.95, 0.48 + wiki.nodes.filter((node) => /plot|style|world/.test(String(node.type))).length / 50) },
        { axis: v0Text("画面感", "Imagery"), value: Math.min(0.95, 0.52 + Math.min(tokens, 120000) / 500000) },
    ];
    const matchScore = Math.max(0.45, Math.min(0.96, axes.reduce((sum, item) => sum + item.value, 0) / axes.length));
    return { bookId, axes, matchScore };
}
async function buildV0PublishChannels(state, bookId) {
    const book = await state.loadBookConfig(bookId);
    const chapters = await state.loadChapterIndex(bookId).catch(() => []);
    const maxChapter = chapters.reduce((max, chapter) => Math.max(max, Number(chapter.chapterNumber ?? chapter.number ?? 0) || 0), 0);
    const profile = resolveNovelPlatformProfile(book.platform || "other", book.language || "zh");
    const hasPublished = chapters.some((chapter) => /publish|released|approved|done|complete|完成|通过/.test(String(chapter.status || "")));
    const primaryStatus = hasPublished ? "released" : maxChapter > 0 ? "queue" : "draft";
    return [{
            id: String(profile.id || "other"),
            name: v0Text(profile.zh || profile.label, profile.en || profile.label),
            status: primaryStatus,
            chapter: maxChapter ? `Ch.${maxChapter}` : "Ch.0",
            lastSync: hasPublished ? "本地工作区已就绪" : "—",
        }];
}
async function buildV0RelationshipGraph(state, root, bookId, focusId = "") {
    const wiki = await buildBookWiki(state, root, bookId);
    // 关系类型 → 边种类 / 标签 / 章节号
    const relKind = (type) => {
        const t = String(type || "");
        if (/兄弟|姐妹|父|母|子女|亲人|血缘|家人|family/i.test(t)) return "family";
        if (/师父|师傅|导师|徒弟|mentor/i.test(t)) return "mentor";
        if (/下属|部下|从属|手下|subord/i.test(t)) return "subord";
        if (/敌|仇|对抗|宿敌|背叛|反目|威胁|猜忌|提防|追踪|rival|enemy/i.test(t)) return "rival";
        if (/盟|友|信任|守护|依赖|情感|锚定|爱|ally/i.test(t)) return "ally";
        return "neutral";
    };
    const shortType = (t) => { const s = String(t || "关联").trim(); return s.length > 18 ? s.slice(0, 18) + "…" : s; };
    const epOf = (note) => { const m = String(note || "").match(/\d+/); return m ? [Number(m[0])] : []; };
    const clamp01 = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
    const factionFor = (c) => {
        const s = `${c?.roleKind || ""} ${c?.group || ""} ${c?.role || ""}`;
        if (/antagonist|反派|敌|对手|追踪|mystery|谜|藏/i.test(s)) return "abyss";
        if (/mentor|导师|师父|师傅/i.test(s)) return "black-tower";
        return "order";
    };
    const importanceFor = (k) => ({ protagonist: 5, deuteragonist: 4, antagonist: 4, mystery: 3, mentor: 3, supporting: 2 }[k] || 3);
    const cleanName = (n) => String(n || "").replace(/^[（(]\s*新增\s*[)）]\s*/, "").trim() || String(n || "");
    const charToNode = (c, i) => {
        const fid = factionFor(c);
        const nm = cleanName(c.name);
        return {
            id: v0Slug(c.name, `role-${i + 1}`),
            name: v0Text(nm, nm),
            role: v0Text(c.role || c.roleKind || "角色", c.role || c.roleKind || "Character"),
            arc: clamp01(typeof c.arc === "number" ? c.arc : 0.9 - i * 0.08, 0.15, 0.95),
            color: fid === "abyss" ? "var(--chart-4)" : fid === "black-tower" ? "var(--chart-3)" : "var(--chart-1)",
            importance: importanceFor(c.roleKind),
            factionId: fid,
            tagline: v0Text((Array.isArray(c.tags) ? c.tags.slice(0, 2).join(" · ") : "") || c.current || c.motivation || "本地角色档案", "Local role profile"),
        };
    };
    let nodes = [];
    let edges = [];
    // 首选:用 character_matrix 同源构建节点 + 角色↔角色关系边,保证图谱自洽、有连线。
    try {
        const charData = await buildBookCharacters(state, root, bookId);
        const chars = Array.isArray(charData?.characters) ? charData.characters : [];
        if (chars.length) {
            nodes = chars.map(charToNode);
            const nameToId = new Map(chars.map((c, i) => [c.name, nodes[i].id]));
            const rows = charData?.relationMatrix?.rows || [];
            const seen = new Set();
            for (const row of rows) {
                const source = nameToId.get(row.from);
                if (!source)
                    continue;
                for (const cell of (row.cells || [])) {
                    const target = nameToId.get(cell.to);
                    if (!target || target === source)
                        continue;
                    const key = [source, target].sort().join("::");
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    edges.push({
                        source,
                        target,
                        kind: relKind(cell.type),
                        strength: 0.68,
                        label: v0Text(shortType(cell.type), shortType(cell.type)),
                        episodes: epOf(cell.note),
                    });
                }
            }
        }
    }
    catch {
        /* 退回 wiki 兜底 */
    }
    // 兜底:无 character_matrix 角色档案时,退回 wiki 角色节点 + 出场边(避免空图)。
    if (!nodes.length) {
        const cast = wiki.nodes.filter((node) => node.type === "role").map(v0RoleNodeToCast);
        nodes = cast.length ? cast : [{
                id: "book",
                name: v0Text(wiki.book?.title || bookId, wiki.book?.title || bookId),
                role: v0Text("作品核心", "Book core"),
                arc: 0.5,
                color: "var(--chart-1)",
                importance: 5,
                factionId: "order",
                tagline: v0Text(wiki.book?.brief || "本地作品档案", wiki.book?.brief || "Local book profile"),
            }];
        const titleToId = new Map(nodes.map((node) => [node.name.zh, node.id]));
        edges = wiki.relationshipEdges
            .map((edge) => {
            const sourceTitle = wiki.nodes.find((node) => node.id === edge.source)?.title || edge.source;
            const targetTitle = wiki.nodes.find((node) => node.id === edge.target)?.title || edge.target;
            const source = titleToId.get(sourceTitle);
            const target = titleToId.get(targetTitle);
            if (!source || !target || source === target)
                return null;
            return {
                source,
                target,
                kind: edge.label === "人物" || edge.label === "出场" ? "ally" : "neutral",
                strength: edge.label === "人物" ? 0.75 : 0.55,
                label: v0Text(edge.label || "关联", edge.label || "Relation"),
                episodes: [],
            };
        })
            .filter(Boolean);
    }
    return {
        bookId,
        focusId: focusId && nodes.some((node) => node.id === focusId) ? focusId : nodes[0]?.id || "book",
        factions: V0_FACTIONS,
        nodes,
        edges,
        version: Number(wiki.stats?.nodes || 0) + Number(wiki.stats?.edges || 0),
        updatedAt: new Date().toISOString(),
        uptoChapter: Number(wiki.stats?.chapters || 0),
    };
}
function storyGraphChapterBounds(character) {
    const chapters = (Array.isArray(character?.arc) ? character.arc : [])
        .map((point) => Number(point?.chapter))
        .filter((chapter) => Number.isFinite(chapter) && chapter > 0);
    return {
        firstChapter: chapters.length ? Math.min(...chapters) : 0,
        lastChapter: chapters.length ? Math.max(...chapters) : 0,
    };
}
function storyGraphSummaryForCharacter(character) {
    const profile = Array.isArray(character?.profileSections) && character.profileSections[0]?.body
        ? markdownExcerpt(character.profileSections[0].body, 120)
        : "";
    return String(character?.current || character?.motivation || profile || (Array.isArray(character?.tags) ? character.tags.slice(0, 3).join(" · ") : "") || character?.role || "角色档案").trim();
}
function storyGraphStateForCharacter(character) {
    return [
        character?.role ? { predicate: "identity", object: String(character.role) } : null,
        character?.current ? { predicate: "state", object: String(character.current) } : null,
        character?.motivation ? { predicate: "goal", object: String(character.motivation) } : null,
    ].filter(Boolean).slice(0, 8);
}
function storyGraphRelationPredicate(relation, sourceName, targetName) {
    const raw = String(relation?.type || relation?.raw || relation?.target || "");
    if (relation?.type)
        return String(relation.type).trim();
    const targetIndex = raw.indexOf(targetName);
    const window = targetIndex >= 0
        ? raw.slice(Math.max(0, targetIndex), Math.min(raw.length, targetIndex + targetName.length + 42))
        : raw;
    const paren = window.match(/[（(]([^）)]+)[）)]/);
    const hint = String(paren?.[1] || window)
        .replace(sourceName, "")
        .replace(targetName, "")
        .replace(/[。；;，,、]/g, " ")
        .trim();
    if (/上级|服从|指挥/.test(hint))
        return "上级";
    if (/下属|手下|部下/.test(hint))
        return "下属";
    if (/追捕|追杀|猎人|目标/.test(hint))
        return "追捕";
    if (/敌对|对抗|威胁|必须清除/.test(hint))
        return "敌对";
    if (/线索|关联|信息源|知情/.test(hint))
        return "线索关联";
    if (/盟友|同伴|信任|锚点/.test(hint))
        return "盟友";
    return hint.slice(0, 18) || "关系";
}
function storyGraphEdgesFromCharacters(characters) {
    const names = characters.map((character) => String(character?.name || "").trim()).filter(Boolean);
    const edges = [];
    const seen = new Set();
    for (const character of characters) {
        const source = String(character?.name || "").trim();
        if (!source)
            continue;
        for (const relation of (Array.isArray(character?.relations) ? character.relations : [])) {
            const raw = String(relation?.target || relation?.raw || "");
            for (const target of names) {
                if (!target || target === source || !raw.includes(target))
                    continue;
                const predicate = storyGraphRelationPredicate(relation, source, target);
                const key = `${source}|${predicate}|${target}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                edges.push({ source, target, predicate, sinceChapter: storyGraphChapterBounds(character).firstChapter });
            }
        }
    }
    return edges;
}
function storyGraphPayloadFromCharacters(bookId, characterData) {
    const characters = Array.isArray(characterData?.characters) ? characterData.characters : [];
    const edges = storyGraphEdgesFromCharacters(characters);
    const degreeByName = new Map();
    for (const edge of edges) {
        degreeByName.set(edge.source, (degreeByName.get(edge.source) || 0) + 1);
        degreeByName.set(edge.target, (degreeByName.get(edge.target) || 0) + 1);
    }
    const nodes = characters.map((character) => {
        const name = String(character?.name || "").trim();
        const bounds = storyGraphChapterBounds(character);
        return {
            id: name,
            name,
            type: "person",
            summary: storyGraphSummaryForCharacter(character),
            aliases: Array.isArray(character?.tags) ? character.tags.slice(0, 4).map((tag) => String(tag).trim()).filter(Boolean) : [],
            firstChapter: bounds.firstChapter,
            lastChapter: bounds.lastChapter,
            degree: degreeByName.get(name) || 0,
            state: storyGraphStateForCharacter(character),
        };
    });
    return {
        bookId,
        stats: { entities: nodes.length, relations: edges.length, activeRelations: edges.length },
        nodes,
        edges,
        fallback: nodes.length > 0 ? "character_matrix" : undefined,
        source: characterData?.source || "story/character_matrix.md",
    };
}
async function buildStoryGraphFallback(state, root, bookId) {
    const characterData = await buildBookCharacters(state, root, bookId);
    return storyGraphPayloadFromCharacters(bookId, characterData);
}
function storyGraphEntityPayloadFromFallback(bookId, graph, name) {
    const decodedName = String(name || "").trim();
    const node = (graph.nodes || []).find((item) => item.name === decodedName || item.id === decodedName);
    if (!node)
        return null;
    const outgoing = (graph.edges || []).filter((edge) => edge.source === node.id || edge.source === node.name);
    const incoming = (graph.edges || []).filter((edge) => edge.target === node.id || edge.target === node.name);
    const nodeById = new Map((graph.nodes || []).map((item) => [item.id, item]));
    const nodeByName = new Map((graph.nodes || []).map((item) => [item.name, item]));
    const resolveNode = (id) => nodeById.get(id) || nodeByName.get(id) || { id, name: id, type: "other", summary: "" };
    const relations = [
        ...outgoing.map((edge) => ({
            predicate: edge.predicate,
            subject: node.name,
            object: resolveNode(edge.target).name,
            objectIsEntity: true,
            sinceChapter: edge.sinceChapter,
            incoming: false,
        })),
        ...incoming.map((edge) => ({
            predicate: edge.predicate,
            subject: resolveNode(edge.source).name,
            object: node.name,
            objectIsEntity: true,
            sinceChapter: edge.sinceChapter,
            incoming: true,
        })),
    ];
    const neighborMap = new Map();
    for (const edge of [...outgoing, ...incoming]) {
        const otherId = edge.source === node.id || edge.source === node.name ? edge.target : edge.source;
        const other = resolveNode(otherId);
        if (other.id !== node.id)
            neighborMap.set(other.id, { id: other.id, name: other.name, type: other.type, summary: other.summary });
    }
    return {
        bookId,
        entity: { id: node.id, name: node.name, type: node.type, summary: node.summary, aliases: (node.aliases || []).join(", "), firstChapter: node.firstChapter, lastChapter: node.lastChapter },
        state: (node.state || []).map((item) => ({ predicate: item.predicate, object: item.object, sinceChapter: node.firstChapter || 0 })),
        relations,
        neighbors: [...neighborMap.values()],
        fallback: graph.fallback || "character_matrix",
        source: graph.source,
    };
}
// 角色与设定:解析真相文件出**真**结构化角色数据(替代 buildV0Cast 的 wiki 启发式)。
// 源:story/character_matrix.md(定位/标签/说话/性格/动机/当前/关系/已知/未知)
//   + story/roles/<组>/<名>.md(散文分节) + story/emotional_arcs.md(每章强度→弧光)。
async function buildBookCharacters(state, root, bookId) {
    if (!isSafeBookId(bookId))
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    const bookDir = state.bookDir(bookId);
    const matrixMd = (await readOptionalText(join(bookDir, "story", "character_matrix.md")).catch(() => ""))
        || (await readOptionalText(join(bookDir, "story", "outline", "character_matrix.md")).catch(() => ""));
    const entries = parseCharacterMatrix(matrixMd);
    // 角色档案文件 → 按名字归组(主要角色/次要角色)+ 分节
    const roleFiles = await collectMarkdownFiles(join(bookDir, "story", "roles"), 160);
    const roleByName = new Map();
    for (const rf of roleFiles) {
        const text = await readOptionalText(rf.path).catch(() => "");
        const seg = String(rf.relativePath).split(/[\\/]/);
        const group = seg.length > 1 ? seg[0] : "";
        roleByName.set(rf.name, { group, sections: parseRoleFile(text) });
    }
    const arcsByChar = groupArcsByCharacter(parseEmotionalArcs(await readOptionalText(join(bookDir, "story", "emotional_arcs.md")).catch(() => "")));
    const summaries = parseChapterSummaries(await readOptionalText(join(bookDir, "story", "chapter_summaries.md")).catch(() => ""));
    const appearByName = appearanceCounts(summaries); // 真·按"出场人物"列统计的出场章数
    const characters = entries.map((e) => {
        const rf = roleByName.get(e.name);
        const arcs = arcsByChar[e.name] || [];
        return {
            name: e.name,
            role: e.role,
            roleKind: e.roleKind,
            group: rf?.group || "",
            tags: e.tags,
            contrast: e.contrast || "",
            voice: e.voice || "",
            personality: e.personality || "",
            motivation: e.motivation || "",
            current: e.current || "",
            relations: e.relations,
            known: e.known,
            unknown: e.unknown,
            profileSections: rf?.sections || [],
            arc: arcs.map((p) => ({ chapter: p.chapter, intensity: p.intensity, emotion: p.emotion, direction: p.direction })),
            // 出场次数:按 chapter_summaries"出场人物"列真·统计的出场章数(数值化好感/体力等仍需后续计算或补存)。
            appearances: { count: appearByName[e.name] ?? 0, source: "chapter_summaries 出场人物列统计" },
        };
    });
    const by = (kind) => characters.filter((c) => c.roleKind === kind).length;
    const names = characters.map((c) => c.name);
    const nameSet = new Set(names);
    const relationRows = characters.map((c) => ({
        from: c.name,
        cells: c.relations
            .filter((r) => nameSet.has(r.target))
            .map((r) => ({ to: r.target, type: r.type, note: r.note || "" })),
    }));
    return {
        bookId,
        source: "story/character_matrix.md + story/roles + story/emotional_arcs.md",
        summary: {
            total: characters.length,
            protagonists: by("protagonist"),
            deuteragonists: by("deuteragonist"),
            mentors: by("mentor"),
            antagonists: by("antagonist"),
            supporting: by("supporting"),
            mystery: by("mystery"),
        },
        characters,
        relationMatrix: { names, rows: relationRows },
        notes: matrixMd.trim() ? [] : ["character_matrix.md 为空或缺失,该书角色尚未由架构师建档"],
    };
}
// 情感弧 / 张力:解析 emotional_arcs.md(真·强度1-10)→ 每角色弧光 + 每章张力峰值。
async function buildBookArcs(state, root, bookId) {
    if (!isSafeBookId(bookId))
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    const bookDir = state.bookDir(bookId);
    const points = parseEmotionalArcs(await readOptionalText(join(bookDir, "story", "emotional_arcs.md")).catch(() => ""));
    return {
        bookId,
        source: "story/emotional_arcs.md",
        points,
        byCharacter: groupArcsByCharacter(points),
        tensionByChapter: tensionByChapter(points),
        notes: points.length ? ["张力/弧光仅覆盖已登记情感弧的章节(已写章)"] : ["emotional_arcs.md 为空,暂无弧光数据"],
    };
}
// 大纲与规划:章索引 + chapter_summaries(真摘要/出场)+ volume_map(卷)+ pending_hooks/subplot_board(主副线)+ emotional_arcs(张力)。
async function buildBookOutlineFull(state, root, bookId) {
    if (!isSafeBookId(bookId))
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    const bookDir = state.bookDir(bookId);
    const book = await state.loadBookConfig(bookId).catch(() => null);
    if (!book)
        throw new ApiError(404, "BOOK_NOT_FOUND", "book not found");
    const read = (rel) => readOptionalText(join(bookDir, "story", rel)).catch(() => "");
    const index = [...(await state.loadChapterIndex(bookId).catch(() => []))]
        .sort((a, b) => Number(a.chapterNumber ?? a.number ?? 0) - Number(b.chapterNumber ?? b.number ?? 0));
    const volumes = parseVolumeMap((await read("outline/volume_map.md")) || (await read("volume_map.md")));
    const hooks = parsePendingHooks(await read("pending_hooks.md"));
    const hookCounts = hooksByStartChapter(hooks);
    const subplots = parseSubplotBoard(await read("subplot_board.md"));
    const summaries = parseChapterSummaries(await read("chapter_summaries.md"));
    const summaryByNum = new Map(summaries.filter((s) => s.chapter != null).map((s) => [s.chapter, s]));
    const tension = tensionByChapter(parseEmotionalArcs(await read("emotional_arcs.md")));
    const tensionByNum = new Map(tension.map((t) => [t.chapter, t.tension]));
    const isDone = (st) => /done|approved|publish|released|complete|完成|通过|ready/.test(String(st || ""));
    const chapters = index.map((ch, i) => {
        const num = Number(ch.chapterNumber ?? ch.number ?? i + 1);
        const sum = summaryByNum.get(num);
        return {
            num,
            title: ch.title || sum?.title || `第${num}章`,
            status: String(ch.status || (Number(ch.wordCount || 0) > 0 ? "done" : "draft")),
            words: Number(ch.wordCount || 0) || 0,
            summary: sum?.keyEvents || "",
            characters: sum?.characters || [],
            mood: sum?.mood || "",
            chapterType: sum?.type || "",
            hooksOpened: hookCounts[num] ?? 0,
            tension: tensionByNum.get(num) ?? null,
        };
    });
    const totalCh = chapters.length || 1;
    const doneCount = chapters.filter((c) => isDone(c.status)).length;
    const totalWords = chapters.reduce((s, c) => s + c.words, 0);
    const progress = doneCount / totalCh;
    const mainThreads = hooks.filter((h) => /主线/.test(h.type)).map((h) => ({
        id: h.id, kind: "main", name: h.note || h.type || h.id, startChapter: h.startChapter,
        status: h.status, lastProgress: h.lastProgress, expectedPayoff: h.expectedPayoff,
    }));
    const sideThreads = subplots.map((s) => ({
        id: s.id, kind: "side", name: s.name, startChapter: s.startChapter,
        status: s.status, lastProgress: s.lastProgress, characters: s.characters,
    }));
    // Save the Cat 五拍:确定性方法论投影(非编造数据)——按总章数落点、按完成进度标状态。
    const beats = [
        { id: "setup", name: "开场/建置", lo: 0, hi: 0.10 },
        { id: "catalyst", name: "激励事件", lo: 0.10, hi: 0.25 },
        { id: "fun", name: "娱乐/对抗", lo: 0.25, hi: 0.50 },
        { id: "badguys", name: "坏蛋逼近", lo: 0.50, hi: 0.75 },
        { id: "finale", name: "终局之战", lo: 0.75, hi: 1.0 },
    ].map((b) => ({
        id: b.id, name: b.name,
        chapterStart: Math.round(b.lo * totalCh) + 1,
        chapterEnd: Math.max(Math.round(b.hi * totalCh), 1),
        status: progress >= b.hi ? "done" : progress >= b.lo ? "current" : "todo",
    }));
    return {
        bookId,
        source: "chapter index + chapter_summaries + volume_map + pending_hooks + subplot_board + emotional_arcs",
        overview: {
            totalVolumes: volumes.length || null,
            plannedChapters: chapters.length,
            doneChapters: doneCount,
            totalWords,
            progress: Number(progress.toFixed(3)),
        },
        volumes,
        chapters,
        threads: { main: mainThreads, side: sideThreads },
        beats: { framework: "save-the-cat", items: beats },
        notes: [
            volumes.length ? "" : "volume_map.md 未解析出卷结构",
            "卷→章映射未在真相文件中结构化存储(该存没存):volume_map 散文未写明每卷章节范围,前端分卷看板需补每章 volume 字段或在卷纲写明范围。",
        ].filter(Boolean),
    };
}
// 伏笔与支线:解析 pending_hooks.md + subplot_board.md → 结构化伏笔池 + 埋设/回收时间线 + 计数。
async function buildBookHooks(state, root, bookId) {
    if (!isSafeBookId(bookId))
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    const bookDir = state.bookDir(bookId);
    const read = (rel) => readOptionalText(join(bookDir, "story", rel)).catch(() => "");
    const hooks = parsePendingHooks(await read("pending_hooks.md"));
    const subplots = parseSubplotBoard(await read("subplot_board.md"));
    const isResolved = (st) => /payoff|回收|done|resolved|clear|已回收/i.test(String(st || ""));
    const firstNum = (s) => {
        const m = String(s || "").match(/(\d+)/);
        return m ? Number(m[1]) : null;
    };
    const timeline = hooks.map((h) => ({
        id: h.id,
        type: h.type,
        status: h.status,
        startChapter: h.startChapter,
        expectedPayoff: h.expectedPayoff,
        expectedChapter: firstNum(h.expectedPayoff),
        lastProgress: h.lastProgress,
        resolved: isResolved(h.status),
    }));
    return {
        bookId,
        source: "story/pending_hooks.md + story/subplot_board.md",
        counts: {
            total: hooks.length,
            resolved: hooks.filter((h) => isResolved(h.status)).length,
            unresolved: hooks.filter((h) => !isResolved(h.status)).length,
            subplots: subplots.length,
        },
        hooks,
        subplots,
        timeline,
        notes: hooks.length ? [] : ["pending_hooks.md 为空,暂无伏笔数据"],
    };
}
// 记忆长卷:章节时间线 + 角色出场泳道 + 伏笔埋收 + 记忆锚(供"记忆长卷"页)。复用既有解析器装配。
async function buildBookMemoryScroll(state, root, bookId) {
    if (!isSafeBookId(bookId))
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    const bookDir = state.bookDir(bookId);
    const book = await state.loadBookConfig(bookId).catch(() => null);
    if (!book)
        throw new ApiError(404, "BOOK_NOT_FOUND", "book not found");
    const read = (rel) => readOptionalText(join(bookDir, "story", rel)).catch(() => "");
    const index = [...(await state.loadChapterIndex(bookId).catch(() => []))]
        .sort((a, b) => Number(a.chapterNumber ?? a.number ?? 0) - Number(b.chapterNumber ?? b.number ?? 0));
    const summaries = parseChapterSummaries(await read("chapter_summaries.md"));
    const summaryByNum = new Map(summaries.filter((s) => s.chapter != null).map((s) => [s.chapter, s]));
    const volumes = parseVolumeMap((await read("outline/volume_map.md")) || (await read("volume_map.md")));
    const hooks = parsePendingHooks(await read("pending_hooks.md"));
    const tByNum = new Map(tensionByChapter(parseEmotionalArcs(await read("emotional_arcs.md"))).map((t) => [t.chapter, t.tension]));
    const isResolved = (st) => /payoff|回收|done|resolved|clear|已回收/i.test(String(st || ""));
    const chapters = index.map((ch, i) => {
        const num = Number(ch.chapterNumber ?? ch.number ?? i + 1);
        const sum = summaryByNum.get(num);
        return { num, title: ch.title || sum?.title || `第${num}章`, status: String(ch.status || ""), words: Number(ch.wordCount || 0) || 0, keyEvents: sum?.keyEvents || "", mood: sum?.mood || "", tension: tByNum.get(num) ?? null };
    });
    const presence = {};
    let peak = { chapter: null, count: 0 };
    for (const s of summaries) {
        if (s.chapter == null) continue;
        if (s.characters.length > peak.count) peak = { chapter: s.chapter, count: s.characters.length };
        for (const name of s.characters) (presence[name] ??= []).push(s.chapter);
    }
    const characterPresence = Object.entries(presence)
        .map(([name, chs]) => ({ name, chapters: chs, appearances: chs.length }))
        .sort((a, b) => b.appearances - a.appearances);
    return {
        bookId,
        source: "chapter index + chapter_summaries + volume_map + pending_hooks + emotional_arcs",
        overview: {
            chapters: chapters.length,
            volumes: volumes.length || null,
            totalWords: chapters.reduce((s, c) => s + c.words, 0),
            hooks: { total: hooks.length, unresolved: hooks.filter((h) => !isResolved(h.status)).length },
            peakCast: peak,
        },
        volumes,
        chapters,
        characterPresence,
        hookTimeline: hooks.map((h) => ({ id: h.id, type: h.type, setChapter: h.startChapter, status: h.status, resolved: isResolved(h.status), lastProgress: h.lastProgress })),
        memoryAnchors: summaries.filter((s) => s.chapter != null && s.keyEvents).map((s) => ({ chapter: s.chapter, label: s.title || `第${s.chapter}章`, detail: s.keyEvents.slice(0, 200) })),
        notes: ["主角体力/能力曲线、读者热度未在真相文件中存储(该存没存),需后续计算或接发布数据"],
    };
}
// 知识统计条:各类知识实体计数(供"知识与资产"页顶部统计)。角色/伏笔精确计数 + wiki 节点类型计数。
async function buildBookKnowledgeOverview(state, root, bookId) {
    if (!isSafeBookId(bookId))
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    const bookDir = state.bookDir(bookId);
    const read = (rel) => readOptionalText(join(bookDir, "story", rel)).catch(() => "");
    const chars = parseCharacterMatrix((await read("character_matrix.md")) || (await read("outline/character_matrix.md")));
    const hooks = parsePendingHooks(await read("pending_hooks.md"));
    const subplots = parseSubplotBoard(await read("subplot_board.md"));
    const isResolved = (st) => /payoff|回收|done|resolved|clear|已回收/i.test(String(st || ""));
    const byKind = {};
    for (const c of chars) byKind[c.roleKind] = (byKind[c.roleKind] ?? 0) + 1;
    let wikiCounts = null;
    try {
        const wiki = await buildBookWiki(state, root, bookId);
        const nc = (t) => wiki.nodes.filter((n) => n.type === t).length;
        wikiCounts = { world: nc("world") + nc("rules"), memory: nc("memory"), focus: nc("focus"), style: nc("style"), nodes: wiki.nodes.length, edges: (wiki.relationshipEdges || []).length };
    }
    catch { wikiCounts = null; }
    return {
        bookId,
        source: "character_matrix + pending_hooks + subplot_board + wiki",
        characters: { total: chars.length, byKind },
        hooks: { total: hooks.length, unresolved: hooks.filter((h) => !isResolved(h.status)).length, resolved: hooks.filter((h) => isResolved(h.status)).length },
        subplots: subplots.length,
        world: wikiCounts?.world ?? null,
        memory: wikiCounts?.memory ?? null,
        focus: wikiCounts?.focus ?? null,
        style: wikiCounts?.style ?? null,
        graph: wikiCounts ? { nodes: wikiCounts.nodes, edges: wikiCounts.edges } : null,
    };
}
// 世界观:解析 story_frame.md → 世界铁律 + 主题/冲突/底色/终局分节;关键物来自 pending_hooks。
// 势力未在真相文件 itemized(该存没存),返回空 + 诚实 note。供"角色与设定"页设定库与知识页世界观。
async function buildBookWorld(state, root, bookId) {
    if (!isSafeBookId(bookId))
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    const bookDir = state.bookDir(bookId);
    const read = (rel) => readOptionalText(join(bookDir, "story", rel)).catch(() => "");
    const frame = parseStoryFrame((await read("outline/story_frame.md")) || (await read("story_frame.md")) || (await read("story_bible.md")));
    const hooks = parsePendingHooks(await read("pending_hooks.md"));
    const sectionByKw = (kw) => {
        const s = frame.sections.find((x) => x.title.includes(kw));
        return s ? { title: s.title, body: s.body } : null;
    };
    return {
        bookId,
        source: "story/outline/story_frame.md + story/pending_hooks.md",
        worldRules: frame.worldRules,
        worldview: {
            theme: sectionByKw("主题"),
            conflict: sectionByKw("冲突"),
            setting: sectionByKw("世界观") || sectionByKw("底色"),
            ending: sectionByKw("终局"),
        },
        sections: frame.sections,
        keyItems: hooks.map((h) => ({ id: h.id, label: h.note || h.type || h.id, type: h.type, chapter: h.startChapter, status: h.status })),
        factions: [],
        notes: [
            frame.worldRules.length ? "" : "story_frame 未解析出世界铁律",
            "势力/组织未在真相文件中 itemized(该存没存):需后续补 factions truth file 或从 wiki 提取。",
            "关键物来自 pending_hooks(伏笔常即关键物件/谜团)。",
        ].filter(Boolean),
    };
}
async function buildV0MarketOpportunities(root) {
    const vault = await listVaultMarkdown(root, "10-市场机会").catch(() => []);
    const vaultItems = vault.slice(0, 12).map((item, index) => ({
        id: v0Slug(item.title || item.path || `vault-${index + 1}`, `vault-${index + 1}`),
        title: v0Text(item.title || item.path || `市场机会 ${index + 1}`, item.title || item.path || `Market ${index + 1}`),
        score: Math.max(60, 92 - index * 3),
        trend: index % 3 === 2 ? "flat" : "up",
        change: index % 3 === 2 ? "+4%" : `+${18 - index}%`,
    }));
    if (vaultItems.length)
        return vaultItems;
    return NOVEL_PLATFORM_PROFILES
        .filter((profile) => profile.id !== "other")
        .slice(0, 12)
        .map((profile, index) => ({
        id: profile.id,
        title: v0Text(profile.zh, profile.en),
        score: Math.max(62, 90 - index * 2),
        trend: profile.region === "global" ? "flat" : "up",
        change: profile.region === "global" ? "+6%" : `+${22 - index}%`,
    }));
}
async function saveBookWikiNode(state, bookId, input) {
    if (!isSafeBookId(bookId)) {
        throw new ApiError(400, "INVALID_BOOK", "Invalid book id");
    }
    const type = sanitizeVaultName(input?.type || "plot", "plot").toLowerCase();
    const safeType = ["plot", "relationship", "world", "role", "note", "style", "memory"].includes(type) ? type : "note";
    const title = sanitizeVaultName(input?.title, "未命名剧情节点");
    const body = normalizeMarkdownText(input?.body || input?.content || "");
    if (!body) {
        throw new ApiError(400, "EMPTY_NODE", "Wiki node body is required");
    }
    const bookDir = state.bookDir(bookId);
    const wikiDir = join(bookDir, "story", "wiki", safeType);
    await mkdir(wikiDir, { recursive: true });
    const filename = `${vaultStamp()}-${title}.md`;
    const relativePath = join("story", "wiki", safeType, filename);
    const fullPath = join(bookDir, relativePath);
    const chapterHint = sanitizeVaultName(input?.chapter || "待编排", "待编排");
    const markdown = [
        `# ${title}`,
        "",
        `- 类型：${safeType}`,
        `- 目标章节：${chapterHint}`,
        `- 创建时间：${new Date().toISOString()}`,
        "",
        "## 节点内容",
        body,
        "",
        "## Agent 使用约束",
        "- 后续规划师必须判断该节点是否适合插入当前章或下一章。",
        "- 写手只能在不破坏已成事实、人物状态机和伏笔池的前提下使用。",
        "- 审稿官需要检查该节点是否造成重复正文、突兀转折或 AI 味解释。",
    ].join("\n");
    await writeFile(fullPath, markdown + "\n", "utf-8");
    const focusPath = join(bookDir, "story", "current_focus.md");
    await mkdir(dirname(focusPath), { recursive: true });
    await appendFile(focusPath, [
        "",
        `## 用户插入节点：${title}`,
        `- 类型：${safeType}`,
        `- 目标章节：${chapterHint}`,
        `- 文件：${relativePath}`,
        "",
        body,
        "",
    ].join("\n"), "utf-8");
    return { ok: true, type: safeType, title, relativePath };
}
function buildCoverSvg(input) {
    const title = sanitizeVaultName(input?.title, "未命名");
    const subtitle = sanitizeVaultName(input?.subtitle, input?.genre ?? "长篇小说");
    const genre = sanitizeVaultName(input?.genre, "原创");
    const seed = [...`${title}${genre}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const hue = seed % 360;
    const hue2 = (hue + 148) % 360;
    const city = /科幻|机甲|赛博|星际|末世/i.test(`${title}${genre}`);
    const mountain = /仙侠|玄幻|古风|历史|权谋/i.test(`${title}${genre}`);
    const mood = city ? "霓虹长街" : mountain ? "远山孤城" : "长卷微光";
    const motif = city
        ? `<g opacity=".58">${Array.from({ length: 9 }, (_, i) => `<rect x="${85 + i * 44}" y="${380 - (i % 4) * 42}" width="24" height="${180 + (i % 3) * 36}" rx="4" fill="hsla(${hue2},55%,72%,.55)"/>`).join("")}</g>`
        : `<path d="M54 492 C170 312 240 340 318 226 C406 352 516 310 666 486 L666 720 L54 720 Z" fill="hsla(${hue2},42%,70%,.46)"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1080" viewBox="0 0 720 1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="hsl(${hue},42%,18%)"/>
      <stop offset=".55" stop-color="hsl(${hue2},38%,24%)"/>
      <stop offset="1" stop-color="#15110c"/>
    </linearGradient>
    <radialGradient id="sun" cx="62%" cy="20%" r="42%">
      <stop stop-color="rgba(255,232,190,.9)"/>
      <stop offset=".18" stop-color="rgba(217,170,94,.55)"/>
      <stop offset="1" stop-color="rgba(217,170,94,0)"/>
    </radialGradient>
    <filter id="shadow"><feDropShadow dx="0" dy="20" stdDeviation="18" flood-color="#000" flood-opacity=".42"/></filter>
  </defs>
  <rect width="720" height="1080" fill="url(#bg)"/>
  <rect x="34" y="34" width="652" height="1012" rx="34" fill="rgba(255,248,238,.06)" stroke="rgba(255,236,204,.32)" stroke-width="2"/>
  <circle cx="494" cy="178" r="148" fill="url(#sun)"/>
  ${motif}
  <path d="M70 704 C180 650 262 688 352 640 C466 580 564 626 656 568" fill="none" stroke="rgba(255,238,205,.38)" stroke-width="3"/>
  <g filter="url(#shadow)">
    <text x="360" y="246" text-anchor="middle" fill="#fff8ea" font-size="72" font-family="PingFang SC,Noto Sans SC,Source Han Sans SC,sans-serif" font-weight="800">${escapeHtml(title)}</text>
    <text x="360" y="318" text-anchor="middle" fill="rgba(255,248,234,.78)" font-size="28" font-family="PingFang SC,Noto Sans SC,Source Han Sans SC,sans-serif">${escapeHtml(subtitle)}</text>
  </g>
  <text x="80" y="920" fill="rgba(255,248,234,.72)" font-size="24" font-family="PingFang SC,Noto Sans SC,Source Han Sans SC,sans-serif">${escapeHtml(genre)} / ${mood}</text>
  <text x="80" y="960" fill="rgba(255,248,234,.48)" font-size="18" font-family="PingFang SC,Noto Sans SC,Source Han Sans SC,sans-serif">卷舍生成封面</text>
</svg>`;
}
async function saveGeneratedCover(root, input) {
    const title = sanitizeVaultName(input?.title, "未命名封面");
    const label = `封面-${vaultStamp()}-${title}`;
    const svgPath = `70-封面图/${label}.svg`;
    const notePath = `70-封面图/${label}.md`;
    const svg = buildCoverSvg(input);
    const vault = await ensureWritingVault(root);
    const fullSvg = join(vault, svgPath);
    await mkdir(dirname(fullSvg), { recursive: true });
    await writeFile(fullSvg, svg, "utf-8");
    await writeVaultFile(root, notePath, [
        `# ${title}`,
        "",
        `- 题材：${input?.genre ?? ""}`,
        `- 副标题：${input?.subtitle ?? ""}`,
        `- 生成时间：${new Date().toISOString()}`,
        `- 文件：[[${svgPath.replace(/\.svg$/, "")}]]`,
        "",
        `![${title}](${encodeURI(`${label}.svg`)})`,
        "",
        "## 封面提示词",
        "",
        input?.prompt ?? "",
        "",
    ].join("\n"));
    await appendVaultIndexEntry(root, "70-封面图/封面列表.md", notePath, title, input?.genre ?? "");
    await appendActivityLog(root, "cover:generated", { title, svgPath, notePath });
    return { title, svgPath, notePath };
}
async function loadVaultSummary(root) {
    const vault = await ensureWritingVault(root);
    const [radar, books, references, styles, memory, templates, covers, ops] = await Promise.all([
        listVaultMarkdown(root, "10-市场机会"),
        listVaultMarkdown(root, "20-作品档案"),
        listVaultMarkdown(root, "30-参考素材"),
        listVaultMarkdown(root, "40-风格样本"),
        listVaultMarkdown(root, "50-长期记忆"),
        listVaultMarkdown(root, "60-模板库"),
        listVaultMarkdown(root, "70-封面图"),
        listVaultMarkdown(root, "80-产品运维"),
    ]);
    return {
        name: "卷舍",
        vaultPath: vault,
        openHint: `在 Obsidian 中打开文件夹：${vault}`,
        sections: { radar, books, references, styles, memory, templates, covers, ops },
    };
}
async function resolveVaultMarkdownDocument(root, rawPath) {
    const decoded = decodeURIComponent(rawPath || "");
    if (!decoded || decoded.includes("..") || isAbsolute(decoded) || !decoded.endsWith(".md")) {
        throw new ApiError(400, "INVALID_VAULT_PATH", "Invalid vault path");
    }
    const vault = await ensureWritingVault(root);
    const fullPath = join(vault, decoded);
    if (relative(vault, fullPath).startsWith("..")) {
        throw new ApiError(400, "INVALID_VAULT_PATH", "Invalid vault path");
    }
    const raw = await readFile(fullPath, "utf-8");
    const fallbackTitle = decoded.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "未命名文档";
    return {
        relativePath: decoded,
        fullPath,
        raw,
        document: buildRenderedDocument(raw, fallbackTitle, decoded, "vault"),
    };
}
async function readFlexibleBody(c) {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
        return await c.req.json().catch(() => ({}));
    }
    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
        return await c.req.parseBody();
    }
    return {};
}
function scrubActivityData(data) {
    if (data === undefined || data === null)
        return data;
    if (typeof data !== "object")
        return data;
    const json = JSON.parse(JSON.stringify(data, (key, value) => {
        const lower = key.toLowerCase();
        if (/^(api[_-]?key|secret|token|password|authorization)$/i.test(lower)
            || lower.endsWith("apikey")
            || lower.endsWith("secret")
            || lower.endsWith("token")) {
            return "[redacted]";
        }
        if (typeof value === "string" && value.length > 800) {
            return `${value.slice(0, 800)}...`;
        }
        return value;
    }));
    return json;
}
async function appendActivityLog(root, event, data = {}) {
    try {
        await mkdir(join(root, ".hardwrite"), { recursive: true });
        const base = {
            timestamp: new Date().toISOString(),
            event,
            data: scrubActivityData(data),
        };
        const enriched = enrichActivityEntry(base);
        const entry = {
            ...base,
            beijingTime: enriched.beijingTime,
            timeZone: "Asia/Shanghai",
            summary: enriched.summary,
            severity: enriched.severity,
            failureReason: enriched.failureReason,
            impact: enriched.impact,
            suggestion: enriched.suggestion,
        };
        await appendFile(join(root, ".hardwrite", "activity.log"), `${JSON.stringify(entry)}\n`, "utf-8");
    }
    catch {
        // Logging must never break writing.
    }
}
function bookAssetDir(root, bookId) {
    return join(root, "books", bookId, "story", "agent_assets");
}
async function appendBookAgentEvent(root, bookId, event, data = {}) {
    if (!bookId || !isSafeBookId(bookId))
        return;
    try {
        const dir = bookAssetDir(root, bookId);
        await mkdir(dir, { recursive: true });
        const base = {
            timestamp: new Date().toISOString(),
            event,
            data: scrubActivityData(data),
        };
        const enriched = enrichActivityEntry(base);
        const entry = {
            ...base,
            beijingTime: enriched.beijingTime,
            timeZone: "Asia/Shanghai",
            summary: enriched.summary,
            severity: enriched.severity,
            failureReason: enriched.failureReason,
            impact: enriched.impact,
            suggestion: enriched.suggestion,
        };
        await appendFile(join(dir, "timeline.jsonl"), `${JSON.stringify(entry)}\n`, "utf-8");
        await writeFile(join(dir, "last_status.json"), JSON.stringify(entry, null, 2), "utf-8");
    }
    catch {
        // Agent assets are a safety net; never block generation.
    }
}
async function appendBookAgentDelta(root, bookId, agent, text) {
    if (!bookId || !isSafeBookId(bookId) || !text)
        return;
    try {
        const dir = join(bookAssetDir(root, bookId), "streams");
        await mkdir(dir, { recursive: true });
        const safeAgent = String(agent || "model").replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
        await appendFile(join(dir, `${safeAgent}.md`), text, "utf-8");
        await appendFile(join(dir, "latest.md"), text, "utf-8");
    }
    catch {
        // Streaming persistence is best-effort and must not slow the model path.
    }
}
async function readAgentAssetVault(root, bookId) {
    const dir = bookAssetDir(root, bookId);
    const readMaybe = async (relativePath) => {
        try {
            return await readFile(join(dir, relativePath), "utf-8");
        }
        catch {
            return "";
        }
    };
    let streams = "";
    try {
        const streamDir = join(dir, "streams");
        const names = (await readdir(streamDir)).filter((name) => name.endsWith(".md")).sort();
        const files = await Promise.all(names.map(async (name) => `## ${name.replace(/\.md$/, "")}\n\n${await readFile(join(streamDir, name), "utf-8")}`));
        streams = files.join("\n\n---\n\n");
    }
    catch {
        streams = "";
    }
    return {
        timeline: await readMaybe("timeline.jsonl"),
        lastStatus: await readMaybe("last_status.json"),
        streams,
    };
}
function broadcast(event, data) {
    if (activityLogRoot && !isHighVolumeDeltaEvent(event)) {
        void appendActivityLog(activityLogRoot, event, data);
    }
    for (const handler of subscribers) {
        handler(event, data);
    }
}
function taskRunsFile(root) {
    return join(root, ".hardwrite", "task_runs.json");
}
const SERVER_INSTANCE_ID = `studio-${process.pid}-${Date.now().toString(36)}`;
const SERVER_STARTED_AT = new Date().toISOString();
const taskRunMutationQueues = new Map();
function isPersistedRunActiveStatus(status) {
    return !["done", "error", "needs-repair", "cancelled"].includes(String(status || ""));
}
function isImmutableTaskRunStatus(status) {
    return ["done", "completed", "error", "cancelled"].includes(String(status || "").toLowerCase());
}
function enqueueTaskRunMutation(root, mutate) {
    const key = taskRunsFile(root);
    const previous = taskRunMutationQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => null).then(mutate);
    const cleanup = next.catch(() => null).finally(() => {
        if (taskRunMutationQueues.get(key) === cleanup)
            taskRunMutationQueues.delete(key);
    });
    taskRunMutationQueues.set(key, cleanup);
    return next;
}
function parseTaskRunsPayload(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        const start = raw.indexOf("{");
        if (start < 0)
            return null;
        for (let end = raw.lastIndexOf("}"); end > start; end = raw.lastIndexOf("}", end - 1)) {
            try {
                const parsed = JSON.parse(raw.slice(start, end + 1));
                if (Array.isArray(parsed?.runs))
                    return { ...parsed, recoveredFromTrailingJunk: true };
            }
            catch {
                // Keep walking backwards until the first valid JSON object is found.
            }
        }
        return null;
    }
}
async function loadTaskRuns(root) {
    const file = taskRunsFile(root);
    await mkdir(dirname(file), { recursive: true });
    try {
        const parsed = parseTaskRunsPayload(await readFile(file, "utf-8"));
        if (Array.isArray(parsed?.runs)) {
            if (parsed.recoveredFromTrailingJunk)
                await saveTaskRuns(root, parsed.runs);
            return parsed.runs;
        }
        return [];
    }
    catch {
        return [];
    }
}
// 原子写帮手:先写 tmp 再 rename(同盘 rename 原子),中途崩溃/磁盘满不会把目标文件截断成半截。
// 用于章节正文等"不可再生"产出,避免部署重启/OOM/Ctrl-C 把用户写好的稿子写坏。
async function atomicWriteFile(targetPath, data) {
    const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data, "utf-8");
    await replaceFileByRename(tmp, targetPath);
}
async function saveTaskRuns(root, runs) {
    const file = taskRunsFile(root);
    await mkdir(dirname(file), { recursive: true });
    const compact = [...runs].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 160);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), runs: compact }, null, 2), "utf-8");
    await replaceFileByRename(tmp, file);
    return compact;
}
async function replaceFileByRename(tmp, targetPath) {
    try {
        await rename(tmp, targetPath);
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (process.platform !== "win32" || !["EEXIST", "EPERM", "EBUSY"].includes(code)) {
            throw error;
        }
        await rm(targetPath, { force: true });
        await rename(tmp, targetPath);
    }
}
// 启动自愈:新进程没有任何在途运行,但磁盘上可能残留上次进程被杀时的 running/queued run。
// 这些"僵尸 run"会卡住下次写作(prepareWriteSlot 把它当成"正在运行的新鲜任务")。开机一律
// 把它们标记为 error 并释放,避免每次重启都要手动清 task_runs.json。
async function reconcileStaleTaskRuns(root) {
    try {
        const runs = await loadTaskRuns(root);
        const STALE = new Set(["running", "queued"]);
        const now = new Date().toISOString();
        let changed = 0;
        const next = runs.map((run) => {
            if (!STALE.has(String(run.status)))
                return run;
            changed += 1;
            return {
                ...run,
                status: "error",
                error: `${run.error ? `${run.error} ` : ""}[后端重启，该运行已中断并自动清理]`,
                currentStage: "已中断（后端重启自愈）",
                updatedAt: now,
                heartbeatAt: now,
            };
        });
        if (changed > 0) {
            await saveTaskRuns(root, next);
            console.log(`[startup] 自愈：清理 ${changed} 个因重启残留的 running/queued run（标记 error，释放写作槽）`);
        }
    }
    catch (e) {
        console.warn(`[startup] stale run 自愈跳过：${e instanceof Error ? e.message : String(e)}`);
    }
}
async function createTaskRun(root, input) {
    return enqueueTaskRunMutation(root, async () => {
        const now = new Date().toISOString();
        const run = {
            id: newId("run"),
            bookId: input.bookId,
            type: input.type,
            status: input.status || "queued",
            wordCount: input.wordCount,
            total: input.total || 1,
            chapterNumber: input.chapterNumber,
            operationKey: input.operationKey,
            completed: 0,
            currentAgent: input.currentAgent || "planner",
            currentStage: input.currentStage || "进入队列",
            ownerInstanceId: SERVER_INSTANCE_ID,
            ownerProcessId: process.pid,
            ownerStartedAt: SERVER_STARTED_AT,
            createdAt: now,
            updatedAt: now,
            heartbeatAt: now,
            events: [{ time: now, kind: "run:created", stage: input.currentStage || "进入队列" }],
            results: [],
        };
        const runs = await loadTaskRuns(root);
        runs.unshift(run);
        await saveTaskRuns(root, runs);
        return run;
    });
}
async function updateTaskRun(root, runId, patch = {}, event) {
    if (!runId)
        return null;
    return enqueueTaskRunMutation(root, async () => {
        const now = new Date().toISOString();
        const runs = await loadTaskRuns(root);
        const index = runs.findIndex((run) => run.id === runId);
        if (index < 0)
            return null;
        const prev = runs[index];
        if (isImmutableTaskRunStatus(prev.status)) {
            const events = event ? [{ time: now, ...event }, ...(prev.events || [])].slice(0, 40) : (prev.events || []).slice(0, 40);
            const nextRun = { ...prev, events };
            runs[index] = nextRun;
            await saveTaskRuns(root, runs);
            return nextRun;
        }
        // 防护:一个迟到的 "llm:progress" 自动心跳不得把已进入终态(error/cancelled/needs-repair/done)
        // 的 run 复活成 running/model_done —— 那正是 run 出错后写作锁迟迟不释放(卡 model_done)的根因。
        // 只丢弃这种自动进度状态;显式状态流转(如续写 resume:needs-repair→running)仍照常生效。
        if (event && String(event.kind || "") === "llm:progress" && patch.status &&
            ["error", "cancelled", "needs-repair", "done", "completed"].includes(String(prev.status || ""))) {
            const { status: _droppedProgressStatus, ...patchWithoutStatus } = patch;
            patch = patchWithoutStatus;
        }
        const events = event ? [{ time: now, ...event }, ...(prev.events || [])].slice(0, 40) : (prev.events || []).slice(0, 40);
        const nextStatus = patch.status ?? prev.status;
        const ownerPatch = isPersistedRunActiveStatus(nextStatus)
            ? { ownerInstanceId: SERVER_INSTANCE_ID, ownerProcessId: process.pid, ownerStartedAt: SERVER_STARTED_AT }
            : {};
        const nextRun = { ...prev, ...patch, ...ownerPatch, events, updatedAt: now, heartbeatAt: patch.heartbeatAt || now };
        const eventFailed = event && (String(event.kind || "").includes("error") || event.error || event.failureReason);
        if (isPersistedRunActiveStatus(nextRun.status) &&
            !eventFailed &&
            !patch.error &&
            !patch.failureReason) {
            nextRun.error = undefined;
            nextRun.failureReason = undefined;
            nextRun.impact = undefined;
            nextRun.suggestion = undefined;
        }
        if (["done", "completed"].includes(String(nextRun.status || "").toLowerCase())) {
            nextRun.error = undefined;
            nextRun.failureReason = undefined;
            nextRun.impact = undefined;
            nextRun.suggestion = undefined;
        }
        runs[index] = nextRun;
        await saveTaskRuns(root, runs);
        return nextRun;
    });
}
function enrichTaskRunForClient(run) {
    if (!run)
        return run;
    const latestResult = Array.isArray(run.results) ? run.results[0] : null;
    const repairMissedTarget = run.type === "chapter-quality-repair" && run.status === "done" && latestResult?.pass === false;
    const restartOwnerLost = /lost in-memory owner|服务重启|已失去执行进程/i.test(`${run.error || ""} ${run.failureReason || ""} ${run.currentStage || ""}`);
    const visibleStatus = repairMissedTarget ? "needs-repair" : run.status;
    const visibleStage = repairMissedTarget
        ? `第 ${latestResult?.chapterNumber ?? "?"} 章低分修复未达标，等待复修`
        : restartOwnerLost && /等待|停止/.test(String(run.currentStage || ""))
            ? "服务重启中断旧任务，旧锁已释放，工作台会自动检查并继续"
            : /已停止等待/.test(String(run.currentStage || ""))
                ? String(run.currentStage || "").replace("已停止等待", "已释放锁并允许继续")
        : run.currentStage;
    const failed = run.status === "error" || run.error || run.failureReason;
    const stageMatch = String(run.currentStage || "").match(/第\s*(\d+)\s*\/\s*(\d+)/);
    const currentIndex = failed && stageMatch ? Number(stageMatch[1]) : (run.currentIndex || (stageMatch ? Number(stageMatch[1]) : undefined));
    const total = run.total || (stageMatch ? Number(stageMatch[2]) : undefined);
    const info = failed ? failureInfoForActivity("run:error", { error: run.error || run.failureReason, index: currentIndex, total }) : null;
    const events = Array.isArray(run.events)
        ? run.events.map((event) => {
            const eventFailed = String(event.kind || "").includes("error") || event.error || event.failureReason;
            const eventInfo = eventFailed ? failureInfoForActivity(event.kind || "run:event", { ...event, index: currentIndex, total }) : null;
            const eventRestartOwnerLost = /lost in-memory owner|服务重启|已失去执行进程/i.test(`${event.error || ""} ${event.failureReason || ""} ${event.stage || ""}`);
            const eventStage = eventRestartOwnerLost && /等待|停止/.test(String(event.stage || ""))
                ? "服务重启中断旧任务，旧锁已释放，工作台会自动检查并继续"
                : /已停止等待/.test(String(event.stage || ""))
                    ? String(event.stage || "").replace("已停止等待", "已释放锁并允许继续")
                : event.stage;
            return {
                ...event,
                stage: eventStage,
                beijingTime: event.beijingTime || formatBeijingDateTime(event.time || event.timestamp || run.updatedAt),
                failureReason: eventInfo?.reason || event.failureReason,
                impact: eventInfo?.impact || event.impact,
                suggestion: eventInfo?.suggestion || event.suggestion,
            };
        })
        : [];
    return {
        ...run,
        status: visibleStatus,
        currentStage: visibleStage,
        createdBeijingTime: formatBeijingDateTime(run.createdAt),
        updatedBeijingTime: formatBeijingDateTime(run.updatedAt),
        heartbeatBeijingTime: formatBeijingDateTime(run.heartbeatAt),
        failureReason: repairMissedTarget ? `修复后评分 ${latestResult?.scoreAfter ?? "--"}，仍未达到 ${latestResult?.targetScore ?? 80}}+ 或仍存在阻断项。` : (info?.reason || run.failureReason || ""),
        impact: info?.impact || run.impact || "",
        suggestion: repairMissedTarget ? "继续点击修复到90+，系统会携带上一轮质量报告和阻断项再次分配修稿。" : (info?.suggestion || run.suggestion || ""),
        events,
    };
}
function boundedQueryInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
function taskRunListRank(run) {
    const status = String(run?.status || "").toLowerCase();
    if (["queued", "running", "repairing"].includes(status))
        return 0;
    if (["needs-repair", "paused", "error"].includes(status))
        return 1;
    return 2;
}
function taskRunListTime(run) {
    const time = Date.parse(run?.heartbeatAt || run?.updatedAt || run?.createdAt || run?.startedAt || "");
    return Number.isFinite(time) ? time : 0;
}
function sortTaskRunsForWorkbench(runs) {
    return [...runs].sort((a, b) => taskRunListRank(a) - taskRunListRank(b) || taskRunListTime(b) - taskRunListTime(a));
}
function enrichTaskRunListItem(run, eventLimit) {
    const item = enrichTaskRunForClient(run);
    if (!item || typeof item !== "object" || !Array.isArray(item.events))
        return item;
    return {
        ...item,
        events: item.events.slice(0, eventLimit),
    };
}
function deriveBookIdFromTitle(title) {
    return title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30);
}
function resolveArchitectBookIdFromArgs(args) {
    if (!args || args.agent !== "architect" || args.revise === true)
        return null;
    if (typeof args.bookId === "string" && args.bookId.trim())
        return args.bookId.trim();
    if (typeof args.title === "string" && args.title.trim()) {
        return deriveBookIdFromTitle(args.title) || null;
    }
    return null;
}
function resolveCreatedBookIdFromToolExecs(execs) {
    for (let i = execs.length - 1; i >= 0; i -= 1) {
        const exec = execs[i];
        if (exec.tool !== "sub_agent" || exec.agent !== "architect" || exec.status !== "completed")
            continue;
        const details = exec.details;
        if (details?.kind === "book_created" && typeof details.bookId === "string" && details.bookId.trim()) {
            return details.bookId.trim();
        }
        const fromArgs = resolveArchitectBookIdFromArgs(exec.args);
        if (fromArgs)
            return fromArgs;
    }
    return null;
}
function sectionFromMarkdown(markdown, title) {
    const text = String(markdown || "").replace(/\r\n/g, "\n");
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s+|$)`));
    return match ? match[1].trim() : "";
}
function listFromMarkdownSection(markdown, title) {
    return sectionFromMarkdown(markdown, title)
        .split("\n")
        .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
        .filter(Boolean);
}
function parseBookDescriptionMarkdown(markdown) {
    const text = String(markdown || "");
    if (!text.trim())
        return null;
    return {
        oneLine: sectionFromMarkdown(text, "一句话钩子"),
        shortIntro: sectionFromMarkdown(text, "短简介"),
        fullIntro: sectionFromMarkdown(text, "正式简介"),
        sellingPoints: listFromMarkdownSection(text, "卖点"),
        tags: sectionFromMarkdown(text, "标签").split(/[\/,，、\n]+/).map((item) => item.trim()).filter(Boolean),
        platformNotes: sectionFromMarkdown(text, "平台投放提示"),
        markdown: text,
    };
}
function normalizeDescriptionPayload(value = {}) {
    const sellingPoints = Array.isArray(value.sellingPoints) ? value.sellingPoints : String(value.sellingPoints || "").split(/[,\n，、]+/);
    const tags = Array.isArray(value.tags) ? value.tags : String(value.tags || "").split(/[,\n，、/]+/);
    return {
        oneLine: limitText(value.oneLine || "", 300).trim(),
        shortIntro: limitText(value.shortIntro || "", 900).trim(),
        fullIntro: limitText(value.fullIntro || value.description || "", 2400).trim(),
        sellingPoints: sellingPoints.map((item) => limitText(item, 120).trim()).filter(Boolean).slice(0, 10),
        tags: tags.map((item) => limitText(item, 40).trim()).filter(Boolean).slice(0, 16),
        platformNotes: limitText(value.platformNotes || "", 900).trim(),
    };
}
function formatBookDescriptionMarkdown(book, bookId, payload, engine = "manual") {
    const language = String(book.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    const platform = resolveNovelPlatformProfile(book.platform, language);
    const data = normalizeDescriptionPayload(payload);
    return [
        "# 网站书籍介绍",
        "",
        `- 书名：${book.title || bookId}`,
        `- 平台：${platform.label}`,
        `- 语言：${language}`,
        `- 更新时间：${new Date().toISOString()}`,
        `- 来源：${engine}`,
        "",
        "## 一句话钩子",
        "",
        data.oneLine || (language === "en" ? `${book.title || bookId}: one choice opens the first storm.` : `《${book.title || bookId}》：一个无法回头的选择，把平静生活推向第一场风暴。`),
        "",
        "## 短简介",
        "",
        data.shortIntro || (language === "en" ? `A serial story about desire, pressure, and escalating consequences.` : `主角从看似平静的开局被推入持续升级的冲突，欲望、秘密和代价层层压上来。`),
        "",
        "## 正式简介",
        "",
        data.fullIntro || (language === "en" ? `The story begins with a clean hook and keeps tightening the pressure around its protagonist. Every answer creates a sharper problem, and every choice leaves a visible consequence.` : `平静只是表面，真正的风暴从第一个无法回头的选择开始。主角被迫面对欲望、秘密和不断逼近的危机，在试探与反击中看清身边的人，也看清自己必须承担的代价。每解决一个问题，都会牵出更大的局面；每一次选择，都会留下下一章必须继续追下去的后果。`),
        "",
        "## 卖点",
        "",
        data.sellingPoints.length ? data.sellingPoints.map((item) => `- ${item}`).join("\n") : (language === "en" ? "- strong opening hook\n- steady escalation\n- choices with consequences" : "- 开局钩子明确\n- 冲突持续升级\n- 人物选择有代价\n- 适合连续追读"),
        "",
        "## 标签",
        "",
        data.tags.join(" / ") || (book.genre || (language === "en" ? "serial novel" : "长篇小说")),
        "",
        "## 平台投放提示",
        "",
        data.platformNotes || (language === "en" ? "Keep the first conflict and genre promise visible on the book detail page." : "简介用于小说网站作品详情页；保持第一冲突、类型承诺和可追读性清楚可见。"),
        "",
    ].join("\n");
}
function fallbackBookDescriptionPayload(book, bookId, volumeTitle = "") {
    const language = String(book.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    const title = book.title || bookId;
    const genre = book.genre || (language === "en" ? "serial novel" : "长篇小说");
    const brief = limitText(book.brief || book.description || "", 420).trim();
    if (language === "en") {
        return {
            oneLine: `${title}: the first ${volumeTitle || "storm"} changes everything.`,
            shortIntro: brief || `${title} is a ${genre} built around pressure, secrets, and escalating choices.`,
            fullIntro: `${brief || `${title} begins with a focused premise and a protagonist forced into a conflict that keeps widening.`} The opening volume ${volumeTitle ? `, ${volumeTitle}, ` : ""}turns desire into pressure, pressure into action, and action into consequences readers can follow chapter by chapter.`,
            sellingPoints: ["clear premise hook", "serial escalation", "consequences that carry forward"],
            tags: [genre],
            platformNotes: "Prepared automatically at book creation and editable in the manuscript shelf.",
        };
    }
    return {
        oneLine: `《${title}》：${volumeTitle ? `从「${volumeTitle}」开始，` : ""}一个无法回头的选择，把主角推向更大的风暴。`,
        shortIntro: brief || `这是一本${genre}。主角从看似平静的开局被推入持续升级的冲突，秘密、选择和代价一层层压上来。`,
        fullIntro: `${brief || `平静只是表面，真正的风暴从第一个无法回头的选择开始。主角被迫面对欲望、秘密和不断逼近的危机。`} ${volumeTitle ? `第一卷「${volumeTitle}」会把个人处境、外部压力和更大的局面扣在一起。` : "第一卷会把个人处境、外部压力和更大的局面扣在一起。"}每解决一个问题，都会牵出新的危机；每一次选择，都会留下下一章必须继续追下去的后果。`,
        sellingPoints: ["开局钩子明确", "冲突持续升级", "人物选择有代价", "适合连续追读"],
        tags: [genre],
        platformNotes: "开书时自动生成，可在发布书稿页的书籍列表下方继续编辑保存。",
    };
}
function fallbackDescriptionBookShell(bookId) {
    return {
        id: bookId,
        title: bookId,
        platform: "other",
        genre: "长篇小说",
        language: "zh",
        status: "missing",
        targetChapters: 0,
        chapterWordCount: 3000,
    };
}
function isMissingBookConfigError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return message.includes("ENOENT") || message.includes("no such file or directory");
}
function chineseNumber(value) {
    const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return String(value);
    if (n <= 10)
        return n === 10 ? "十" : digits[n];
    if (n < 20)
        return `十${digits[n - 10]}`;
    if (n < 100) {
        const ten = Math.floor(n / 10);
        const one = n % 10;
        return `${digits[ten]}十${one ? digits[one] : ""}`;
    }
    return String(n);
}
function parseChineseNumberToken(value) {
    const text = String(value || "").trim();
    if (/^\d+$/.test(text))
        return Number(text);
    const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    if (map[text])
        return map[text];
    if (text.startsWith("十"))
        return 10 + (map[text.slice(1)] || 0);
    const ten = text.match(/^([一二两三四五六七八九])十([一二三四五六七八九])?$/);
    if (ten)
        return (map[ten[1]] || 0) * 10 + (map[ten[2]] || 0);
    return 0;
}
function cleanTitlePhrase(value, fallback) {
    const text = String(value || "")
        .replace(/^[#\s-]+/, "")
        .replace(/^第\s*[一二三四五六七八九十百千\d]+\s*[卷章]\s*[：:.\-、]?\s*/, "")
        .replace(/[《》"“”]/g, "")
        .replace(/\s+/g, "")
        .trim();
    if (!text || /默认|未命名|待定|占位|卷名|章节名/.test(text))
        return fallback;
    return text.slice(0, 18);
}
function deriveOpeningVolumeTitle(book, chapters = []) {
    const language = String(book.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    const firstChapter = cleanTitlePhrase(chapters[0]?.title || "", "");
    if (firstChapter && firstChapter.length >= 2) {
        return language === "en" ? `Opening Faultline` : `${firstChapter.length > 8 ? firstChapter.slice(0, 8) : firstChapter}之始`;
    }
    if (language === "en")
        return "Opening Faultline";
    const title = String(book.title || "").replace(/[《》]/g, "");
    const hero = title.match(/[\u4e00-\u9fa5]{2,4}$/)?.[0] || "";
    if (hero && hero !== title)
        return `${hero}的第一局`;
    const briefHead = cleanTitlePhrase(String(book.brief || "").split(/[，。；,.]/)[0] || "", "");
    if (briefHead && briefHead.length >= 2)
        return `${briefHead.slice(0, 8)}之始`;
    return "第一场风暴";
}
function defaultVolumePlanMarkdown(book, bookId, chapters = []) {
    const language = String(book.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    const total = Math.max(Number(book.targetChapters || 80) || 80, chapters.length || 1);
    const firstSpan = Math.max(10, Math.min(30, Math.ceil(total / 4)));
    // 卷边界必须是"约 30 章一卷"的真实阶梯,绝不能让第三卷吃到 total(否则长书会出现「第 61-2000 章」单卷,
    // 记忆归并官永不触发压缩、长程记忆丢失)。短书(≤3 卷跨度)三卷覆盖到底;长书只播种前三卷,余下由作者按卷追加。
    const v2End = Math.min(total, firstSpan * 2);
    const v3End = Math.min(total, firstSpan * 3);
    const hasMoreVolumes = total > v3End;
    const firstTitle = deriveOpeningVolumeTitle(book, chapters);
    const secondTitle = language === "en" ? "The Wider Storm" : "更大的风暴";
    const thirdTitle = language === "en" ? "Cost of the Choice" : "选择的代价";
    const firstChapters = Array.from({ length: Math.min(8, firstSpan) }, (_, i) => {
        const n = i + 1;
        const existing = cleanTitlePhrase(chapters.find((chapter) => Number(chapter.chapterNumber ?? chapter.number) === n)?.title || "", "");
        const title = existing || (language === "en" ? `Chapter ${n} Signal` : ["第一道裂缝", "不得不做的选择", "旧账浮出水面", "逼近的代价", "反击的开端", "暗处的手", "交换条件", "章尾反转"][i] || `第${n}个推进点`);
        return `- 第 ${n} 章：${title}`;
    }).join("\n");
    if (language === "en") {
        return [
            "# Volume Map",
            "",
            `## Volume 1: ${firstTitle}`,
            "",
            `- Range: Chapters 1-${firstSpan}`,
            "- Core promise: turn the premise into visible pressure, choices, and consequences.",
            "- Chapter naming policy: every chapter title must name a concrete event, object, conflict, or reversal. Never use Default, Untitled, or only Chapter X.",
            "- Opening chapter title candidates:",
            firstChapters,
            "",
            `## Volume 2: ${secondTitle}`,
            "",
            `- Range: Chapters ${firstSpan + 1}-${v2End}`,
            "- Core promise: widen the external pressure and force the protagonist to pay for earlier choices.",
            "",
            `## Volume 3: ${thirdTitle}`,
            "",
            `- Range: Chapters ${v2End + 1}-${v3End}`,
            "- Core promise: convert accumulated secrets and debts into an irreversible turn.",
            "",
            ...(hasMoreVolumes
                ? ["> This is a seed ladder of ~30-chapter volumes. As the book grows, append more volumes (`## Volume N` + `- Range: Chapters X-Y`). The consolidator compresses each completed volume into volume_summaries.md, so ranges must stay continuous and ~30 chapters each.", ""]
                : []),
        ].join("\n");
    }
    return [
        "# 卷纲地图",
        "",
        `## 第一卷：${firstTitle}`,
        "",
        `- 范围：第 1-${firstSpan} 章`,
        "- 核心承诺：把开书设定落成可见压力、人物选择和连续后果。",
        "- 章节命名策略：每章标题必须指向具体事件、物件、冲突或反转；禁止“默认”“未命名”或只有“第 X 章”。",
        "- 起始章节名候选：",
        firstChapters,
        "",
        `## 第二卷：${secondTitle}`,
        "",
        `- 范围：第 ${firstSpan + 1}-${v2End} 章`,
        "- 核心承诺：扩大外部压力，让主角为前一卷选择付出更清晰的代价。",
        "",
        `## 第三卷：${thirdTitle}`,
        "",
        `- 范围：第 ${v2End + 1}-${v3End} 章`,
        "- 核心承诺：把累积秘密、旧账和人物关系推向不可逆转的转折。",
        "",
        ...(hasMoreVolumes
            ? ["> 这是约 30 章一卷的播种阶梯。随着写作推进，由架构师/作者向下追加卷（`## 第 N 卷` + `- 范围：第 X-Y 章`）。记忆归并官按卷边界把已完成卷压成 volume_summaries.md，所以范围必须连续、约 30 章一卷，切勿写成跨越全书的单卷。", ""]
            : []),
    ].join("\n");
}
function looksLikeDefaultVolumeMap(markdown) {
    const text = String(markdown || "").trim();
    if (!text)
        return true;
    if (/第一卷\s*[：:]\s*默认/.test(text) || /Volume\s*1\s*:\s*Default/i.test(text))
        return true;
    if (/默认|未命名|待定/.test(text) && text.length < 600)
        return true;
    return !/(第\s*[一二三四五六七八九十百千\d]+\s*卷|Volume\s*\d+)/i.test(text);
}
function parseVolumePlan(markdown, book, chapters = []) {
    const fallbackTitle = deriveOpeningVolumeTitle(book, chapters);
    const text = String(markdown || "").replace(/\r\n/g, "\n");
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const volumes = [];
    let current = null;
    const push = (volume) => {
        if (!volume)
            return;
        volume.title = cleanTitlePhrase(volume.title, fallbackTitle);
        volumes.push(volume);
    };
    for (const line of lines) {
        const heading = line.match(/^#{1,4}\s*(?:(第\s*([一二三四五六七八九十百千\d]+)\s*卷|Volume\s*(\d+))\s*[：:.\-、]?\s*)?(.+?)\s*$/i);
        if (heading && heading[1]) {
            push(current);
            const order = Number(heading[3] || heading[2]) || volumes.length + 1;
            current = { order, title: heading[4] || fallbackTitle, startChapter: 0, endChapter: 0, summary: "" };
            continue;
        }
        if (!current)
            continue;
        const range = line.match(/第?\s*(\d+)\s*[-—~至到]\s*(\d+)\s*章?|Chapters?\s*(\d+)\s*[-—~]\s*(\d+)/i);
        if (range) {
            current.startChapter = Number(range[1] || range[3]) || current.startChapter;
            current.endChapter = Number(range[2] || range[4]) || current.endChapter;
        }
        if (/核心|promise|目标|主线/i.test(line)) {
            current.summary = cleanTitlePhrase(line.replace(/^\s*[-*]\s*/, "").replace(/^核心[^：:]*[：:]\s*/i, ""), current.summary || "");
        }
    }
    push(current);
    if (!volumes.length) {
        const inline = [...text.matchAll(/第\s*([一二两三四五六七八九十百千\d]+)\s*卷\s*[“"「《]?([^”"」》，,。；;：:\\n]{2,24})[”"」》]?/g)]
            .map((match) => ({ order: parseChineseNumberToken(match[1]) || 0, title: cleanTitlePhrase(match[2], ""), index: match.index || 0 }))
            .filter((item) => item.order > 0 && item.title && !/全书|主题|情绪|钩子|OKR|卷尾/.test(item.title))
            .sort((a, b) => a.order - b.order || a.index - b.index);
        if (inline.length) {
            const deduped = [];
            for (const item of inline) {
                if (!deduped.some((entry) => entry.order === item.order))
                    deduped.push(item);
            }
            const total = Math.max(Number(book.targetChapters || 0) || 0, chapters.length || 0, deduped.length * 30);
            const span = Math.max(30, Math.ceil(total / deduped.length));
            for (const item of deduped) {
                volumes.push({ order: item.order, title: item.title, startChapter: (item.order - 1) * span + 1, endChapter: item.order === deduped.length ? total : item.order * span, summary: "" });
            }
        }
        else {
            volumes.push({ order: 1, title: fallbackTitle, startChapter: 1, endChapter: Math.max(30, chapters.length || 1), summary: "" });
        }
    }
    let cursor = 1;
    for (const volume of volumes.sort((a, b) => a.order - b.order)) {
        if (!volume.startChapter)
            volume.startChapter = cursor;
        if (!volume.endChapter || volume.endChapter < volume.startChapter)
            volume.endChapter = volume.startChapter + 29;
        cursor = volume.endChapter + 1;
    }
    return volumes;
}
function volumeForChapter(volumes, chapterNumber) {
    return volumes.find((volume) => chapterNumber >= volume.startChapter && chapterNumber <= volume.endChapter) || volumes[volumes.length - 1] || volumes[0];
}
async function readVolumeMapForBook(state, bookId) {
    const bookDir = state.bookDir(bookId);
    const canonical = await readOptionalText(join(bookDir, "story", "outline", "volume_map.md"));
    if (canonical.trim() && !looksLikeDefaultVolumeMap(canonical))
        return canonical;
    const legacy = await readOptionalText(join(bookDir, "story", "volume_map.md"));
    return legacy.trim() ? legacy : canonical;
}
async function ensureOpeningPublishingAssets(state, root, bookId, options = {}) {
    const book = await state.loadBookConfig(bookId);
    const chapters = await state.loadChapterIndex(bookId).catch(() => []);
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const outlineDir = join(storyDir, "outline");
    await mkdir(outlineDir, { recursive: true });
    const existingVolumeMap = await readVolumeMapForBook(state, bookId);
    let volumeMap = existingVolumeMap;
    if (looksLikeDefaultVolumeMap(existingVolumeMap)) {
        volumeMap = defaultVolumePlanMarkdown(book, bookId, chapters);
        await writeFile(join(outlineDir, "volume_map.md"), volumeMap, "utf-8");
        const legacy = await readOptionalText(join(storyDir, "volume_map.md"));
        if (looksLikeDefaultVolumeMap(legacy))
            await writeFile(join(storyDir, "volume_map.md"), volumeMap, "utf-8");
    }
    const volumes = parseVolumePlan(volumeMap, book, chapters);
    const descriptionPath = join(storyDir, "book_description.md");
    const existingDescription = await readOptionalText(descriptionPath);
    let description = parseBookDescriptionMarkdown(existingDescription);
    if (!description?.fullIntro) {
        const markdown = formatBookDescriptionMarkdown(book, bookId, fallbackBookDescriptionPayload(book, bookId, volumes[0]?.title || ""), "auto-opening-assets");
        await mkdir(storyDir, { recursive: true });
        await writeFile(descriptionPath, markdown, "utf-8");
        description = parseBookDescriptionMarkdown(markdown);
    }
    if (options.rebuildIndex !== false)
        await buildBooksIndex(root, state).catch(() => null);
    return { volumes, description };
}
function createFallbackStoryFrameMarkdown(book, bookId, sourceError = "") {
    const language = String(book.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    const title = book.title || bookId;
    const genre = book.genre || (language === "en" ? "serial novel" : "长篇小说");
    const brief = limitText(book.brief || book.description || "", 900).trim();
    if (language === "en") {
        return [
            "# Story Frame",
            "",
            "## Reader Promise",
            "",
            `${title} is a ${genre} about a protagonist pushed from a focused opening conflict into a widening serial storm. ${brief || "The first volume must make the desire, pressure, and cost visible in concrete scenes."}`,
            "",
            "## Core Conflict",
            "",
            "- External pressure: the world forces a visible choice before the protagonist is ready.",
            "- Internal pressure: the protagonist wants control, recognition, safety, or truth, but every gain creates a cost.",
            "- Serial engine: each chapter should close one local problem while opening the next sharper question.",
            "",
            "## World Rules",
            "",
            "- New facts must be written into truth files before later chapters rely on them.",
            "- Character decisions must leave consequences in later chapters.",
            "- Chapter endings should preserve reader curiosity without fake cliffhangers.",
            "",
            "## Current Task",
            "",
            "This file was created by the local book-creation fallback after the architect model call failed or timed out. It is not safe for chapter planning. Rebuild the foundation with the architect/foundation reviewer before writing chapters.",
            sourceError ? `\n> Original failure: ${sourceError}` : "",
            "",
        ].join("\n");
    }
    return [
        "# 故事框架",
        "",
        "## 读者承诺",
        "",
        `《${title}》是一本${genre}。${brief || "开局必须把主角的欲望、外部压力和第一场不可回头的选择落到具体场景里。"} 后续章节要持续做到：解决一个局部问题，同时抛出更锋利的下一个问题。`,
        "",
        "## 核心冲突",
        "",
        "- 外部压力：世界或环境逼主角在准备不足时做出选择。",
        "- 内部压力：主角想要控制、署名、安全、真相或翻身，但每次获得都会带来代价。",
        "- 连载引擎：每章必须有明确事件、清楚阻碍、可见变化和章尾追读点。",
        "",
        "## 世界铁律",
        "",
        "- 新事实必须先写入 truth files，后续章节才能引用。",
        "- 人物选择必须留下后果，不能下一章自动清零。",
        "- 章节结尾要制造真实期待，不能靠假悬念或空喊口号。",
        "",
        "## 当前任务",
        "",
        "本文件由本地建书兜底在架构师模型超时/失败后创建。它不是最终精修版故事圣经，也不能作为章节规划地基。必须先由架构师/建书复审官重建并确认故事框架、卷纲、角色矩阵后，才允许写第一章。",
        sourceError ? `\n> 原始失败：${sourceError}` : "",
        "",
    ].join("\n");
}
function createFallbackCharacterMatrixMarkdown(book, bookId) {
    const language = String(book.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    const title = book.title || bookId;
    if (language === "en") {
        return [
            "# Character Matrix",
            "",
            "## Protagonist",
            "",
            "- Name: to be confirmed by the architect.",
            `- Story function: carry the central promise of ${title}.`,
            "- Desire: must be specific before chapter 1 is drafted.",
            "- Cost: each win should make the next choice harder.",
            "",
            "## Required Before Long Runs",
            "",
            "- Add antagonist, ally, pressure figure, and emotional anchor cards.",
            "- Convert every recurring character into a dedicated role file under story/roles/.",
            "",
        ].join("\n");
    }
    return [
        "# 角色矩阵",
        "",
        "## 主角",
        "",
        "- 姓名：待架构师补全。",
        `- 故事功能：承载《${title}》的核心读者承诺。`,
        "- 欲望：第一章开写前必须具体化。",
        "- 代价：每一次胜利都要让下一次选择更难。",
        "",
        "## 长线写作前必须补齐",
        "",
        "- 反派/对手、盟友、压力人物、情感锚点。",
        "- 反复出现的角色要拆成 story/roles/ 下的独立角色卡。",
        "",
    ].join("\n");
}
function createFallbackHooksMarkdown(book, bookId) {
    const language = String(book.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
    if (language === "en") {
        return [
            "# Pending Hooks",
            "",
            "| hook_id | start | type | status | expected payoff | notes |",
            "| --- | --- | --- | --- | --- | --- |",
            "| H001-opening-choice | 0 | premise | open | The first irreversible choice must echo in volume 1. | Created by book fallback. |",
            "| H002-hidden-cost | 0 | consequence | open | A first win should reveal a cost, debt, or watcher. | Created by book fallback. |",
            "",
        ].join("\n");
    }
    return [
        "# 伏笔池",
        "",
        "| hook_id | 起始章节 | 类型 | 状态 | 预期回收 | 备注 |",
        "| --- | --- | --- | --- | --- | --- |",
        "| H001-opening-choice | 0 | premise | open | 第一场不可回头的选择必须在第一卷反复产生后果。 | 建书兜底创建。 |",
        "| H002-hidden-cost | 0 | consequence | open | 第一次胜利后暴露代价、债务、观察者或更大阻碍。 | 建书兜底创建。 |",
        "",
    ].join("\n");
}
function extractCreateBookStreamSection(markdown, sectionName) {
    const text = String(markdown || "").replace(/\r\n/g, "\n");
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`===\\s*:?\\s*SECTION\\s+${escaped}\\s*(?:===)?\\s*([\\s\\S]*?)(?=\\n===\\s*:?\\s*SECTION\\s+|$)`, "i"));
    return match ? match[1].replace(/^===\s*/m, "").trim() : "";
}
async function recoverBookCreationLocally(state, root, bookId, bookConfig, runId, sourceError = "") {
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const outlineDir = join(storyDir, "outline");
    const chaptersDir = join(bookDir, "chapters");
    const recoveryDir = join(storyDir, "recovery");
    await mkdir(outlineDir, { recursive: true });
    await mkdir(chaptersDir, { recursive: true });
    await mkdir(recoveryDir, { recursive: true });
    const now = new Date().toISOString();
    const book = {
        ...bookConfig,
        id: bookId,
        status: "needs-foundation",
        brief: typeof bookConfig.brief === "string" ? bookConfig.brief : "",
        description: typeof bookConfig.description === "string" ? bookConfig.description : "",
        createdAt: bookConfig.createdAt || now,
        updatedAt: now,
        creationFallback: {
            reason: sourceError ? limitText(sourceError, 500) : "architect model call did not finish",
            runId,
            createdAt: now,
            safeForWriting: false,
        },
    };
    const partialArchitect = await readOptionalText(join(storyDir, "agent_assets", "streams", "architect.md")).catch(() => "");
    if (partialArchitect.trim()) {
        await writeFile(join(recoveryDir, `architect-partial-${runId || "latest"}.md`), partialArchitect.trimEnd() + "\n", "utf-8");
    }
    await state.saveBookConfig(bookId, book);
    await state.ensureControlDocuments(bookId, book.brief || book.description || "");
    const storyFrame = createFallbackStoryFrameMarkdown(book, bookId, sourceError);
    const volumeMap = defaultVolumePlanMarkdown(book, bookId, []);
    await writeFile(join(outlineDir, "story_frame.md"), storyFrame, "utf-8");
    await writeFile(join(outlineDir, "volume_map.md"), volumeMap, "utf-8");
    await writeFile(join(storyDir, "volume_map.md"), volumeMap, "utf-8");
    await writeFile(join(storyDir, "character_matrix.md"), createFallbackCharacterMatrixMarkdown(book, bookId), "utf-8");
    await writeFile(join(storyDir, "pending_hooks.md"), createFallbackHooksMarkdown(book, bookId), "utf-8");
    await writeFile(join(storyDir, "story_bible.md"), [
        "# 故事圣经",
        "",
        "> 本书由建书兜底创建。权威拆分文件：",
        "> - outline/story_frame.md",
        "> - outline/volume_map.md",
        "> - character_matrix.md",
        "> - pending_hooks.md",
        "",
        "后续必须运行架构师/建书复审官补强。本地兜底档案只能用于恢复和编辑，不能直接进入章节规划或写作。",
        "",
    ].join("\n"), "utf-8");
    await writeFile(join(chaptersDir, "index.json"), "[]\n", "utf-8").catch(() => undefined);
    await ensureOpeningPublishingAssets(state, root, bookId, { rebuildIndex: false }).catch(() => null);
    await buildBooksIndex(root, state).catch(() => null);
    await appendActivityLog(root, "book:create-fallback", {
        bookId,
        runId,
        agent: "guardian",
        agentLabel: "守护进程",
        stage: "建书模型失败后本地兜底建档",
        error: sourceError,
    }).catch(() => undefined);
    void appendBookAgentEvent(root, bookId, "book:create-fallback", {
        bookId,
        runId,
        agent: "guardian",
        agentLabel: "守护进程",
        stage: "建书模型失败后本地兜底建档",
        error: sourceError,
    });
    const summary = await loadStudioBookListSummary(state, bookId).catch(() => ({ ...book, id: bookId }));
    return { book, summary, partialRecovered: Boolean(partialArchitect.trim()) };
}
function looksLikeUnsafeFoundationText(text) {
    return /本地建书兜底|book-creation fallback|待架构师补全|不是最终精修版故事圣经|不能作为章节规划地基|not safe for chapter planning/i.test(String(text || ""));
}
async function inspectBookFoundationForWriting(state, bookId) {
    const book = await state.loadBookConfig(bookId);
    const bookDir = state.bookDir(bookId);
    const storyFrame = await readOptionalText(join(bookDir, "story", "outline", "story_frame.md")).catch(() => "");
    const storyBible = await readOptionalText(join(bookDir, "story", "story_bible.md")).catch(() => "");
    const characterMatrix = await readOptionalText(join(bookDir, "story", "character_matrix.md")).catch(() => "");
    const volumeMap = await readOptionalText(join(bookDir, "story", "outline", "volume_map.md")).catch(() => "");
    const unsafeFallback = book?.creationFallback?.safeForWriting !== true && (book?.creationFallback || looksLikeUnsafeFoundationText(storyFrame) || looksLikeUnsafeFoundationText(storyBible) || looksLikeUnsafeFoundationText(characterMatrix));
    const missingFoundation = !storyFrame.trim() || !volumeMap.trim() || !characterMatrix.trim();
    if (!unsafeFallback && !missingFoundation) {
        // 质量闸：若建书复审官判过且未达标（且未人工放行 safeForWriting），阻止写章，避免在弱地基上批量产出
        if (book?.foundationQuality && book.foundationQuality.pass === false && book?.creationFallback?.safeForWriting !== true) {
            const weak = (book.foundationQuality.weakDims || []).join("、");
            return {
                ok: false,
                book: { id: bookId, title: book?.title || bookId, status: book?.status || "" },
                status: "foundation-quality-blocked",
                error: "作品地基质量未达标（建书复审官判分低于闸值），已阻止写章。",
                failureReason: `地基质量分 ${book.foundationQuality.score ?? "—"}${weak ? `，最拖分维度：${weak}` : ""}`,
                suggestion: "点『重新验收地基』让建书复审官定向补强最拖分的维度，或手动改设定后重试；确属人工确认可在 book.json 将 creationFallback.safeForWriting 设为 true。",
            };
        }
        return { ok: true, book };
    }
    const reasons = [];
    if (book?.creationFallback)
        reasons.push("开书模型曾失败，当前作品由本地兜底建档");
    if (looksLikeUnsafeFoundationText(storyFrame) || looksLikeUnsafeFoundationText(storyBible))
        reasons.push("故事框架/故事圣经仍是兜底占位");
    if (looksLikeUnsafeFoundationText(characterMatrix))
        reasons.push("角色矩阵仍未由架构师补全");
    if (missingFoundation)
        reasons.push("truth files 不完整");
    return {
        ok: false,
        book: { id: bookId, title: book?.title || bookId, status: book?.status || "" },
        status: "foundation-blocked",
        error: "作品地基未通过，已阻止写章，避免开书提示词和正文继续漂移。",
        failureReason: reasons.join("；") || "作品地基未确认",
        suggestion: "先重建/确认故事框架、卷纲、角色矩阵和网站简介，再开始写作。若这是人工确认过的地基，可在 book.json 将 creationFallback.safeForWriting 显式设为 true。",
    };
}
function scoreFoundationModule(id, label, text, options = {}) {
    const raw = String(text || "");
    const content = raw.trim();
    const minChars = Number(options.minChars || 700);
    const required = options.required !== false;
    const blockers = [];
    if (!content) {
        return {
            id,
            label,
            score: 0,
            status: required ? "fail" : "empty",
            chars: 0,
            blockers: required ? ["未生成"] : [],
            suggestion: required ? `补全${label}，否则不能稳定开书。` : `可按需要补充${label}。`,
        };
    }
    if (looksLikeUnsafeFoundationText(content))
        blockers.push("仍是本地兜底或占位文本");
    if (/TODO|待补|占位|示例|fallback|兜底|未确认|后续补全/i.test(content))
        blockers.push("存在待补/占位标记");
    if (required && content.length < Math.max(240, minChars * 0.35))
        blockers.push("内容过短");
    let score = 18;
    score += Math.min(34, Math.round((content.length / minChars) * 34));
    if (/^#{1,4}\s+\S+/m.test(content))
        score += 10;
    if (/目标|欲望|冲突|代价|规则|伏笔|读者|节奏|风格|角色|主角|卷|章|开局|爽点|阻断项|风险|承诺/.test(content))
        score += 20;
    if (/(第\s*[一二三四五六七八九十\d]+|[0-9]{1,3}\.|- )/.test(content))
        score += 8;
    if (/必须|禁止|不得|需要|检查|验收|失败|恢复|Gate|评分/i.test(content))
        score += 6;
    if (blockers.length)
        score -= 28;
    score = clampScore(score);
    const status = blockers.length || (required && score < 70) ? "fail" : score >= 85 ? "pass" : "warn";
    return {
        id,
        label,
        score,
        status,
        chars: content.length,
        blockers,
        suggestion: status === "pass" ? `${label}可用于写作链路。` : `${label}需要补足具体事实、约束和失败处理，避免后续章节漂移。`,
    };
}
function extractProtagonistName(characterMatrix = "", book = {}) {
    const text = String(characterMatrix || "");
    const direct = text.match(/(?:主角|主人公|核心人物|protagonist)\s*[:：]\s*([^\n，,；;（(]+)/i);
    if (direct?.[1])
        return direct[1].trim().replace(/^《|》$/g, "").slice(0, 18);
    const heading = text.match(/^#{1,3}\s*([^\n#：:]{2,18})/m);
    if (heading?.[1] && !/角色|矩阵|人物|Character/i.test(heading[1]))
        return heading[1].trim();
    return book.protagonist || book.mainCharacter || "";
}
function deriveTargetReader(book = {}, description = null) {
    const blob = [book.title, book.genre, book.platform, book.brief, description?.tags?.join(" "), description?.platformNotes].filter(Boolean).join(" ");
    if (/女频|女生|言情|甜宠|女主/.test(blob))
        return "女生（以女主受众为主的作品）";
    if (/男频|男生|玄幻|都市|历史|系统|升级|男主/.test(blob))
        return "男生（以男主受众为主的作品）";
    return "通用读者（上架时按平台一级分类再确认男/女频）";
}
function derivePlatformCategories(book = {}, description = null) {
    const tags = Array.isArray(description?.tags) ? description.tags : [];
    const source = [book.title, book.genre, book.platform, book.brief, tags.join(" ")].filter(Boolean).join(" ");
    const primary = /都市/.test(source) ? "都市" : /悬疑|推理/.test(source) ? "悬疑" : /历史|年代|90|九十/.test(source) ? "历史/年代" : /科幻|末世|异能|脑控|神经|AI|大模型/.test(source) ? "科幻/异能" : /玄幻|修仙/.test(source) ? "玄幻" : "通用";
    const secondary = /年代|90|九十/.test(source) ? "年代" : /异能/.test(source) ? "异能" : /穿越|重生/.test(source) ? "穿越/重生" : /脑洞|系统|无敌/.test(source) ? "脑洞" : "长篇连载";
    return { primary, secondary };
}
function buildPlatformSubmissionMarkdown(book, bookId, bookDescription = "", characterMatrix = "") {
    const description = parseBookDescriptionMarkdown(bookDescription) || {};
    const tags = Array.from(new Set([
        ...(description.tags || []),
        ...(String(book.genre || "").split(/[\/,，、\s]+/).filter(Boolean)),
    ])).filter(Boolean).slice(0, 14);
    const categories = derivePlatformCategories(book, description);
    const protagonist = extractProtagonistName(characterMatrix, book);
    const title = book.title || bookId;
    const intro500 = limitText(description.fullIntro || description.shortIntro || description.oneLine || book.description || book.brief || "", 500).trim();
    const status = book.completed || book.status === "finished" ? "已完结" : "连载中";
    return [
        "# 平台上架资料",
        "",
        "## 可直接复制字段",
        "",
        `- 作品名称：${title}`,
        `- 目标读者：${deriveTargetReader(book, description)}`,
        `- 一级分类：${categories.primary}`,
        `- 二级分类：${categories.secondary}`,
        `- 作品标签：${tags.length ? tags.join("、") : "待补充"}`,
        `- 主角名：${protagonist || "待确认"}`,
        `- 作品状态：${status}`,
        "",
        "## 作品简介（500字内）",
        "",
        intro500 || "请先生成或编辑网站书籍介绍。",
        "",
        "## 一句话卖点",
        "",
        description.oneLine || "请先补充一句话钩子。",
        "",
        "## 卖点标签",
        "",
        (description.sellingPoints || []).map((item) => `- ${item}`).join("\n") || "- 待补充",
        "",
        "## 复制提示",
        "",
        "- 番茄等小说平台正文通常不需要 Markdown 标题语法，正文请用纯文本复制；书籍资料字段可按本页逐项粘贴。",
        "- 如果平台限制标签数量，优先保留题材、情绪、金手指、时代/世界观、读者承诺相关标签。",
        "",
    ].join("\n");
}
function foundationTitle(book, bookId) {
    return book?.title || bookId;
}
function buildRepairCharacterMatrixMarkdown(book, bookId, storyFrame = "", bookDescription = "") {
    const title = foundationTitle(book, bookId);
    const protagonist = extractProtagonistName(storyFrame + "\n" + bookDescription, book) || "主角";
    const genre = book.genre || "长篇小说";
    return [
        "# 角色矩阵",
        "",
        `## 主角：${protagonist}`,
        "",
        `- 故事功能：承载《${title}》的核心读者承诺，把“${genre}”从概念落到每章可见行动。`,
        "- 外显目标：在第一卷里解决一个具体、可验收、会持续升级的问题。",
        "- 内在欲望：想把命运重新握回手里，但每一次掌控都会暴露新的债务、秘密或代价。",
        "- 核心弱点：容易把短期胜利误认为局面已经安全，导致下一层压力提前到来。",
        "- 可反复受压点：亲密关系、身份可信度、资源短缺、外界误判、旧账回收。",
        "- 章节写法：每次出场必须有选择、有动作、有后果，不能只做设定讲解员。",
        "",
        "## 对手/压力人物",
        "",
        "- 功能：不断把主角的优势转化成风险，让主角无法靠同一招重复通关。",
        "- 外显目标：抢占资源、信息、名声或通道，并制造公开压力。",
        "- 写法约束：对手也要有合理收益，不写成单纯送经验的工具人。",
        "- 阶段推进：第一卷先给局部阻碍，第二卷扩大到制度/组织/区域层面的压力。",
        "",
        "## 盟友/协作者",
        "",
        "- 功能：提供情报、情绪反差和行动配合，同时带来额外牵挂。",
        "- 关系张力：信任不是白给的，要通过一次次小事建立，也会因隐瞒产生裂缝。",
        "- 写法约束：盟友不能替主角解决核心难题，只能打开选择空间。",
        "",
        "## 情感锚点",
        "",
        "- 功能：提醒读者主角为什么必须赢，以及赢了以后要付出的私人代价。",
        "- 场景要求：用饭桌、街口、电话、旧物、身体疲惫等具体生活细节落地。",
        "- 风险：如果情感锚点长期不出场，主角动机会变空，章节追读会下降。",
        "",
        "## 长线状态字段",
        "",
        "- 每章更新：主角掌握的信息、欠下的人情/债务、暴露的能力、关系温度、未回收伏笔。",
        "- 禁止：角色受伤、承诺、误会、债务在下一章自动清零。",
        "- 质量 Gate：若新章节无法说明角色本章选择带来的后果，必须回到审稿/修稿环节。",
        "",
    ].join("\n");
}
function buildRepairBookRulesMarkdown(book, bookId) {
    const title = foundationTitle(book, bookId);
    return [
        "# 工程规则",
        "",
        `## 《${title}》写作硬约束`,
        "",
        "- truth files 是唯一事实源。新增设定、角色状态、伏笔和世界规则必须先落文件，再进入后续章节。",
        "- 每章必须包含：当前目标、具体阻碍、行动选择、局面变化、章尾追读点。",
        "- 不允许靠总结、解释、口号推进剧情；关键信息必须落到场景、动作、对白或可验证物件。",
        "- 不允许复述上一章来冒充进展；回顾只能服务当前冲突。",
        "- 低于目标分时先修复本章，不写下一章；连续低分时暂停批量写作，更新提示词和地基文件。",
        "- 角色状态不能自动清零：伤、债、人情、误会、承诺、暴露风险都要在 chapter_summaries/current_state 里追踪。",
        "- 平台简介、标签和读者承诺必须与正文实际卖点一致，不能写成另一本书。",
        "",
        "## 复修策略",
        "",
        "- 先修硬伤：事实冲突、角色断档、阻断项、篇幅失衡。",
        "- 再修读感：节奏、对白、画面、爽点/悬念兑现。",
        "- 最后润色：减少 AI 腔、抽象词和泛泛解释。",
        "- 一次强修只处理当前章最影响评分的 2-4 个阻断项，避免反复大改造成漂移。",
        "",
    ].join("\n");
}
function buildRepairHooksMarkdown(book, bookId) {
    const title = foundationTitle(book, bookId);
    return [
        "# 伏笔池",
        "",
        "| hook_id | 起始章节 | 类型 | 状态 | 预期回收 | 备注 |",
        "| --- | --- | --- | --- | --- | --- |",
        `| H001-core-promise | 0 | 主承诺 | open | 第一卷末必须验证《${title}》的核心卖点不是噱头，而能改变主角处境。 | 建书地基修复补齐。 |`,
        "| H002-first-cost | 1 | 代价 | open | 主角第一次解决问题后暴露新的债务、风险或观察者。 | 用于防止无代价爽点。 |",
        "| H003-relationship-crack | 1 | 人物关系 | open | 关键盟友因隐瞒/误判产生裂缝，后续用行动修复。 | 维持情感张力。 |",
        "| H004-public-pressure | 2 | 外部压力 | open | 对手把局部冲突推到更公开的场合，逼主角无法低调处理。 | 支撑第一卷升级。 |",
        "| H005-volume-turn | 8 | 卷末转折 | open | 第一卷结尾改变主角身份、资源或规则理解，打开第二卷。 | 避免长篇断档。 |",
        "",
    ].join("\n");
}
function shouldRepairFoundationModule(module) {
    return module?.status === "fail" || module?.score < 78 || (module?.status === "empty");
}
async function autoRepairFoundation(state, root, bookId, assessment) {
    const book = await state.loadBookConfig(bookId);
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const outlineDir = join(storyDir, "outline");
    await mkdir(storyDir, { recursive: true });
    await mkdir(outlineDir, { recursive: true });
    const moduleById = new Map((assessment?.modules || []).map((item) => [item.id, item]));
    const [storyFrame, volumeMap, characterMatrix, bookDescription] = await Promise.all([
        readOptionalText(join(outlineDir, "story_frame.md")).catch(() => ""),
        readOptionalText(join(outlineDir, "volume_map.md")).catch(() => ""),
        readOptionalText(join(storyDir, "character_matrix.md")).catch(() => ""),
        readOptionalText(join(storyDir, "book_description.md")).catch(() => ""),
    ]);
    const repaired = [];
    if (shouldRepairFoundationModule(moduleById.get("storyFrame")) || looksLikeUnsafeFoundationText(storyFrame)) {
        const patched = [
            createFallbackStoryFrameMarkdown({ ...book, creationFallback: undefined }, bookId, "").replace(/## 当前任务[\s\S]*$/m, ""),
            "## 长篇推进约束",
            "",
            "- 第一卷必须让主角目标、外部压力、私人代价同时成立。",
            "- 每 3-5 章回收一个局部问题，同时打开更大问题。",
            "- 所有新角色、伏笔、状态变化必须写回角色矩阵、伏笔池或章节摘要。",
            "",
        ].join("\n");
        await writeFile(join(outlineDir, "story_frame.md"), patched, "utf-8");
        repaired.push("故事框架");
    }
    if (shouldRepairFoundationModule(moduleById.get("volumeMap")) || !volumeMap.trim()) {
        const patched = defaultVolumePlanMarkdown(book, bookId, []);
        await writeFile(join(outlineDir, "volume_map.md"), patched, "utf-8");
        await writeFile(join(storyDir, "volume_map.md"), patched, "utf-8").catch(() => undefined);
        repaired.push("分卷推进");
    }
    if (shouldRepairFoundationModule(moduleById.get("characterMatrix")) || looksLikeUnsafeFoundationText(characterMatrix)) {
        await writeFile(join(storyDir, "character_matrix.md"), buildRepairCharacterMatrixMarkdown(book, bookId, storyFrame, bookDescription), "utf-8");
        repaired.push("角色矩阵");
    }
    if (shouldRepairFoundationModule(moduleById.get("bookRules"))) {
        await writeFile(join(storyDir, "book_rules.md"), buildRepairBookRulesMarkdown(book, bookId), "utf-8");
        repaired.push("工程规则");
    }
    if (shouldRepairFoundationModule(moduleById.get("hooks"))) {
        await writeFile(join(storyDir, "pending_hooks.md"), buildRepairHooksMarkdown(book, bookId), "utf-8");
        repaired.push("伏笔池");
    }
    if (shouldRepairFoundationModule(moduleById.get("bookDescription")) || !parseBookDescriptionMarkdown(bookDescription)?.fullIntro) {
        await ensureOpeningPublishingAssets(state, root, bookId, { rebuildIndex: false }).catch(() => null);
        repaired.push("网站书籍介绍");
    }
    await buildBooksIndex(root, state).catch(() => null);
    return repaired;
}
async function buildFoundationAssessment(state, bookId) {
    const book = await state.loadBookConfig(bookId);
    const bookDir = state.bookDir(bookId);
    const readStory = (relativePath) => readOptionalText(join(bookDir, "story", relativePath)).catch(() => "");
    const [storyFrame, volumeMap, characterMatrix, styleGuide, bookRules, pendingHooks, bookDescription] = await Promise.all([
        readStory("outline/story_frame.md"),
        readStory("outline/volume_map.md"),
        readStory("character_matrix.md"),
        readStory("style_guide.md"),
        readStory("book_rules.md"),
        readStory("pending_hooks.md"),
        readStory("book_description.md"),
    ]);
    const modules = [
        scoreFoundationModule("storyFrame", "故事框架/故事圣经", storyFrame, { required: true, minChars: 1200 }),
        scoreFoundationModule("volumeMap", "分卷与推进路线", volumeMap, { required: true, minChars: 900 }),
        scoreFoundationModule("characterMatrix", "角色矩阵", characterMatrix, { required: true, minChars: 900 }),
        scoreFoundationModule("styleGuide", "风格指纹", styleGuide, { required: false, minChars: 520 }),
        scoreFoundationModule("bookRules", "工程规则", bookRules, { required: false, minChars: 420 }),
        scoreFoundationModule("hooks", "伏笔池", pendingHooks, { required: false, minChars: 420 }),
        scoreFoundationModule("bookDescription", "网站书籍介绍", bookDescription, { required: true, minChars: 450 }),
    ];
    const required = modules.filter((item) => ["storyFrame", "volumeMap", "characterMatrix", "bookDescription"].includes(item.id));
    const score = clampScore(required.reduce((sum, item) => sum + item.score, 0) / Math.max(1, required.length));
    const blockers = modules.flatMap((item) => item.status === "fail" ? item.blockers.map((blocker) => `${item.label}：${blocker}`) : []);
    const ready = score >= 85 && required.every((item) => item.status !== "fail") && blockers.length === 0;
    const platformSubmission = buildPlatformSubmissionMarkdown(book, bookId, bookDescription, characterMatrix);
    const report = [
        "# 开书地基验收",
        "",
        `- 作品：${book.title || bookId}`,
        `- 总分：${score}`,
        `- 状态：${ready ? "可以写书" : "暂缓写书"}`,
        `- 更新时间：${new Date().toISOString()}`,
        "",
        "## 模块评分",
        "",
        ...modules.map((item) => `- ${item.label}：${item.score} 分 · ${item.status} · ${item.chars.toLocaleString()} 字${item.blockers.length ? ` · ${item.blockers.join("；")}` : ""}`),
        "",
        "## 阻断项",
        "",
        blockers.length ? blockers.map((item) => `- ${item}`).join("\n") : "- 无。可以进入写章链路。",
        "",
        "## 下一步",
        "",
        ready ? "地基通过：可以开始写章；后续每章质量低于目标分时再进入自适应复修。" : "先编辑失败模块，点击“重新验收地基”，通过后再写下一章。",
        "",
    ].join("\n");
    return { ready, score, modules, blockers, report, platformSubmission };
}
// ── 地基质量闸：让"建书复审官"真正跑一次 LLM 质量评审（不是数字数），并支持只补最拖分维度的定向补强 ──
const FOUNDATION_QUALITY_FLOOR = 80;
const FOUNDATION_QUALITY_DIMENSIONS = [
    { key: "differentiation", label: "差异化卖点", weight: 0.16, files: ["outline/story_frame.md", "story_bible.md"], critical: true },
    { key: "motivation", label: "人物动机闭环", weight: 0.16, files: ["character_matrix.md"], critical: true },
    { key: "goldenFinger", label: "金手指机制与代价", weight: 0.12, files: ["book_rules.md", "outline/story_frame.md"], critical: false },
    { key: "hooks", label: "伏笔承重", weight: 0.12, files: ["pending_hooks.md"], critical: false },
    { key: "serializability", label: "可连载性", weight: 0.16, files: ["outline/volume_map.md"], critical: true },
    { key: "openingHook", label: "黄金开篇", weight: 0.12, files: ["current_focus.md", "outline/story_frame.md"], critical: false },
    { key: "consistency", label: "设定一致性", weight: 0.08, files: ["character_matrix.md", "pending_hooks.md"], critical: false },
    { key: "platformFit", label: "平台读者契合", weight: 0.08, files: ["book_description.md"], critical: false },
];
function clampDimScore(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}
function foundationFilePathForRel(bookDir, rel) {
    return rel.startsWith("outline/")
        ? join(bookDir, "story", "outline", rel.slice("outline/".length))
        : join(bookDir, "story", rel);
}
async function runFoundationQualityReview(state, bookId, options = {}) {
    const targetScore = Number(options.targetScore) || FOUNDATION_QUALITY_FLOOR;
    const bookDir = state.bookDir(bookId);
    const book = await state.loadBookConfig(bookId).catch(() => ({}));
    const readStory = (rel) => readOptionalText(join(bookDir, "story", rel)).catch(() => "");
    const [storyFrame, volumeMap, characterMatrix, pendingHooks, bookRules, currentFocus, bookDescription, storyBible] = await Promise.all([
        readStory("outline/story_frame.md"), readStory("outline/volume_map.md"), readStory("character_matrix.md"),
        readStory("pending_hooks.md"), readStory("book_rules.md"), readStory("current_focus.md"),
        readStory("book_description.md"), readStory("story_bible.md"),
    ]);
    const corpus = [storyFrame, volumeMap, characterMatrix, pendingHooks, bookRules, currentFocus, bookDescription, storyBible].join("").trim();
    if (corpus.length < 200)
        return null; // 地基内容过少，没有可判的实质，交回结构闸
    let llm, client, model;
    try {
        const loadConfig = options.loadConfig;
        if (typeof loadConfig !== "function")
            return null;
        const currentConfig = await loadConfig();
        llm = resolveAgentRuntimeLLMConfig(currentConfig, ["foundation-reviewer", "auditor", "quality-reporter", "architect"], 0.3);
        llm.stream = false;
        model = String(llm.model || currentConfig.llm.model || currentConfig.llm.defaultModel || "");
        client = createLLMClient(llm);
    }
    catch {
        return null; // 模型不可用 → 返回 null，绝不因评审失败硬卡住地基
    }
    const dimList = FOUNDATION_QUALITY_DIMENSIONS.map((d) => `- ${d.key}（${d.label}）`).join("\n");
    const sys = [
        "你是长篇连载小说的建书复审官，兼出版总编和连续性工程师。",
        "只判这套开书地基（故事框架/卷纲/角色矩阵/伏笔池/金手指规则/黄金开篇/平台简介）能不能支撑一本能追读的长篇，不是判它漂不漂亮。",
        "判断重点：卖点是否清晰且有差异化；角色是否有可反复受压的真实欲望和三层动机；金手指是否有机制、代价、成长边界；伏笔前台后台是否能承重；目标链是否递进、能不能写满目标章数不崩；黄金开篇是否抓人；truth files 是否互相不冲突；是否契合平台读者。",
        "严格但务实：不放行空泛世界观、不接受'以后再补'的关键动机、不接受没有代价的金手指、不接受互相冲突的设定。但只要地基足以让写手不靠临时编就能开写，就该放行。",
        "只输出 JSON，不要 Markdown，不要解释过程。",
    ].join("\n");
    const user = [
        `目标分（达标线）：${targetScore}`,
        `作品：${book.title || bookId}｜题材/平台：${book.genre || ""} / ${book.platform || ""}｜目标章数：${book.targetChapters || ""}`,
        "请对以下每个维度打 0-100 分，并各给一句具体问题与一句具体改法：",
        dimList,
        "",
        'JSON 结构：{"dimensions":{"<key>":{"score":0-100,"issue":"一句具体问题","fix":"一句具体改法"},...},"blockers":["致命阻断项"],"strengths":["亮点"],"verdict":"pass"|"block","summary":"两三句总评"}',
        "blockers 只列致命的（空泛世界观、关键动机缺失、金手指无代价、设定硬冲突、无法连载）；没有就给空数组。",
        "",
        "【故事框架 story_frame】", (storyFrame || "(空)").slice(0, 4000),
        "【卷纲 volume_map】", (volumeMap || "(空)").slice(0, 3000),
        "【角色矩阵 character_matrix】", (characterMatrix || "(空)").slice(0, 4000),
        "【伏笔池 pending_hooks】", (pendingHooks || "(空)").slice(0, 2000),
        "【金手指/工程规则 book_rules】", (bookRules || "(空)").slice(0, 2000),
        "【黄金开篇 current_focus】", (currentFocus || "(空)").slice(0, 1500),
        "【平台简介 book_description】", (bookDescription || "(空)").slice(0, 1500),
    ].join("\n");
    let parsed = null;
    try {
        const response = await chatCompletion(client, model, [{ role: "system", content: sys }, { role: "user", content: user }], { temperature: llm.temperature ?? 0.3, maxTokens: 2400 });
        parsed = extractJsonObject(response?.content || "");
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || !parsed.dimensions)
        return null;
    const dims = {};
    let weightedSum = 0, weightTotal = 0;
    for (const d of FOUNDATION_QUALITY_DIMENSIONS) {
        const raw = (parsed.dimensions && parsed.dimensions[d.key]) || {};
        const score = clampDimScore(raw.score);
        dims[d.key] = { label: d.label, score, issue: String(raw.issue || "").slice(0, 200), fix: String(raw.fix || "").slice(0, 200), weight: d.weight, critical: !!d.critical };
        weightedSum += score * d.weight;
        weightTotal += d.weight;
    }
    const score = clampScore(weightTotal ? weightedSum / weightTotal : 0);
    const blockers = Array.isArray(parsed.blockers) ? parsed.blockers.map(String).filter(Boolean).slice(0, 8) : [];
    const strengths = Array.isArray(parsed.strengths) ? parsed.strengths.map(String).filter(Boolean).slice(0, 6) : [];
    const weakDims = FOUNDATION_QUALITY_DIMENSIONS
        .map((d) => ({ key: d.key, label: d.label, score: dims[d.key].score, drag: Math.max(0, targetScore - dims[d.key].score) * d.weight, critical: !!d.critical }))
        .filter((x) => x.score < targetScore)
        .sort((a, b) => b.drag - a.drag);
    const criticalFail = FOUNDATION_QUALITY_DIMENSIONS.some((d) => d.critical && dims[d.key].score < 60);
    const verdictBlock = String(parsed.verdict || "").toLowerCase() === "block";
    const pass = score >= targetScore && blockers.length === 0 && !criticalFail && !verdictBlock;
    return { score, targetScore, dimensions: dims, blockers, strengths, weakDims, pass, summary: String(parsed.summary || "").slice(0, 600) };
}
async function autoRepairFoundationQuality(state, root, bookId, qualityReview, options = {}) {
    if (!qualityReview || !Array.isArray(qualityReview.weakDims) || !qualityReview.weakDims.length)
        return [];
    const targetScore = Number(options.targetScore) || FOUNDATION_QUALITY_FLOOR;
    const topN = Math.max(1, Math.min(2, Number(options.topN) || 2));
    const targets = qualityReview.weakDims.slice(0, topN);
    const bookDir = state.bookDir(bookId);
    const book = await state.loadBookConfig(bookId).catch(() => ({}));
    let llm, client, model;
    try {
        const loadConfig = options.loadConfig;
        if (typeof loadConfig !== "function")
            return [];
        const currentConfig = await loadConfig();
        llm = resolveAgentRuntimeLLMConfig(currentConfig, ["architect", "foundation-reviewer", "reviser", "writer"], 0.5);
        llm.stream = false;
        model = String(llm.model || currentConfig.llm.model || currentConfig.llm.defaultModel || "");
        client = createLLMClient(llm);
    }
    catch {
        return [];
    }
    const dimDefByKey = new Map(FOUNDATION_QUALITY_DIMENSIONS.map((d) => [d.key, d]));
    const fileGroups = new Map();
    for (const t of targets) {
        const def = dimDefByKey.get(t.key);
        const rel = (def && def.files || [])[0];
        if (!rel)
            continue;
        if (!fileGroups.has(rel))
            fileGroups.set(rel, []);
        fileGroups.get(rel).push({ ...t, def });
    }
    const repaired = [];
    for (const [rel, group] of fileGroups) {
        const path = foundationFilePathForRel(bookDir, rel);
        const original = await readOptionalText(path).catch(() => "");
        if (!original.trim())
            continue;
        const dimLines = group.map((g) => `- ${g.label}（当前 ${g.score} 分，目标 ${targetScore}）：问题=${qualityReview.dimensions?.[g.key]?.issue || ""}；改法=${qualityReview.dimensions?.[g.key]?.fix || ""}`).join("\n");
        const sys = [
            "你是长篇小说建书复审官的定向补强手。只针对点名的维度提升这份地基文件，其余已达标的内容必须原样保留、格式不变。",
            "【定向修复铁律】只改与下列维度相关的部分；不要推倒重写整份文件；不要改文件的标题结构、表格列、角色名、卷数范围等既定事实；只让被点名的维度变扎实（更具体、有代价、有差异化、能承重）。",
            "输出 JSON：{\"content\":\"补强后的完整文件全文(markdown,保持原格式)\",\"changes\":[\"一句话说明改了什么\"]}。content 必须是完整文件，不是片段，不要省略未改动部分。",
        ].join("\n");
        const user = [
            `作品：${book.title || bookId}｜题材/平台：${book.genre || ""}/${book.platform || ""}`,
            `文件：${rel}`,
            "需要补强的维度：",
            dimLines,
            "",
            "【当前文件全文】",
            original.slice(0, 8000),
        ].join("\n");
        try {
            const response = await chatCompletion(client, model, [{ role: "system", content: sys }, { role: "user", content: user }], { temperature: llm.temperature ?? 0.5, maxTokens: 4200 });
            const parsed = extractJsonObject(response?.content || "");
            const content = parsed && typeof parsed.content === "string" ? parsed.content.trim() : "";
            if (content && content.length >= Math.min(original.length * 0.6, 300) && !looksLikeUnsafeFoundationText(content)) {
                const out = content.endsWith("\n") ? content : content + "\n";
                await writeFile(path, out, "utf-8");
                if (rel === "outline/volume_map.md")
                    await writeFile(join(bookDir, "story", "volume_map.md"), out, "utf-8").catch(() => undefined);
                repaired.push(...group.map((g) => `质量·${g.label}`));
            }
        }
        catch { /* 单文件补强失败不影响其余 */ }
    }
    return repaired;
}
async function persistFoundationQuality(state, bookId, payload) {
    try {
        const book = await state.loadBookConfig(bookId);
        const fq = {
            score: payload.quality?.score ?? null,
            structuralScore: payload.structural?.score ?? null,
            pass: payload.quality ? payload.quality.pass : null,
            ready: !!payload.ready,
            weakDims: (payload.quality?.weakDims || []).map((d) => d.label),
            blockers: payload.quality?.blockers || [],
            dimensions: payload.quality?.dimensions || null,
            summary: payload.quality?.summary || "",
            reviewedAt: new Date().toISOString(),
        };
        await state.saveBookConfig(bookId, { ...book, foundationQuality: fq, updatedAt: new Date().toISOString() });
    }
    catch { /* 持久化失败不致命 */ }
}
async function enforceFoundationQualityGate(state, root, bookId, options = {}) {
    const autoRepair = options.autoRepair !== false;
    const withQuality = options.withQuality !== false;
    const book0 = await state.loadBookConfig(bookId).catch(() => ({}));
    const targetScore = Number(options.targetScore) || Number(book0?.targetScore) || Number(book0?.writing?.targetScore) || FOUNDATION_QUALITY_FLOOR;
    const maxRounds = Math.max(0, Math.min(2, options.maxRounds ?? 1));
    let structural = await buildFoundationAssessment(state, bookId);
    const repaired = [];
    if (!structural.ready && autoRepair) {
        const did = await autoRepairFoundation(state, root, bookId, structural).catch(() => []);
        repaired.push(...did);
        structural = await buildFoundationAssessment(state, bookId);
    }
    const loadConfig = options.loadConfig;
    let quality = withQuality ? await runFoundationQualityReview(state, bookId, { targetScore, loadConfig }).catch(() => null) : null;
    let round = 0;
    while (quality && !quality.pass && autoRepair && round < maxRounds) {
        const fixed = await autoRepairFoundationQuality(state, root, bookId, quality, { targetScore, loadConfig }).catch(() => []);
        if (!fixed.length)
            break;
        repaired.push(...fixed);
        const re = await runFoundationQualityReview(state, bookId, { targetScore }).catch(() => null);
        if (!re)
            break;
        quality = re;
        round++;
    }
    const qualityPass = quality ? quality.pass : true; // 模型不可用 → 不因质量硬卡，交回结构闸
    const ready = structural.ready && qualityPass;
    await persistFoundationQuality(state, bookId, { structural, quality, ready });
    return { ready, structural, quality, repaired, repairRounds: round, targetScore, structuralScore: structural.score, qualityScore: quality?.score ?? null, blockers: [...(structural.blockers || []), ...((quality && quality.blockers) || [])] };
}
function buildFoundationGateReport(assessment, quality, ready, repaired) {
    const lines = [assessment?.report || ""];
    if (quality) {
        lines.push("", "## 建书复审官·质量评审", "", `- 质量总分：${quality.score} / 达标线 ${quality.targetScore}`, `- 结论：${quality.pass ? "质量达标" : "质量未达标，需补强"}`, "", "### 维度评分", "");
        for (const d of FOUNDATION_QUALITY_DIMENSIONS) {
            const dim = quality.dimensions?.[d.key];
            if (!dim)
                continue;
            lines.push(`- ${dim.label}：${dim.score} 分${dim.score < quality.targetScore && dim.issue ? ` · ${dim.issue}` : ""}`);
        }
        if (quality.blockers?.length)
            lines.push("", "### 质量阻断项", "", ...quality.blockers.map((b) => `- ${b}`));
        if (quality.weakDims?.length && !quality.pass)
            lines.push("", "### 最拖分维度（定向补强目标）", "", ...quality.weakDims.slice(0, 3).map((d) => `- ${d.label}（${d.score} 分）：${quality.dimensions?.[d.key]?.fix || ""}`));
        if (quality.summary)
            lines.push("", `> 总评：${quality.summary}`);
    }
    else {
        lines.push("", "> 质量评审未运行（模型不可用或地基内容过少），当前仅做结构完整性校验。");
    }
    if (repaired?.length)
        lines.push("", "### 本次自动补强", "", ...[...new Set(repaired)].map((r) => `- ${r}`));
    return lines.join("\n");
}
async function loadStudioBookListSummary(state, bookId) {
    const book = await state.loadBookConfig(bookId);
    const nextChapter = await state.getNextChapterNumber(bookId);
    const coverPath = await findBookCoverPath(state, bookId);
    const chapters = await state.loadChapterIndex(bookId).catch(() => []);
    const totalWords = chapters.reduce((sum, chapter) => sum + (Number(chapter.wordCount) || Number(chapter.words) || 0), 0);
    const currentChapter = Math.max(nextChapter - 1, chapters.length);
    const volumeMap = await readVolumeMapForBook(state, bookId).catch(() => "");
    const volumes = parseVolumePlan(volumeMap, book, chapters);
    const description = parseBookDescriptionMarkdown(await readOptionalText(join(state.bookDir(bookId), "story", "book_description.md")).catch(() => ""));
    return { ...book, chaptersWritten: currentChapter, currentChapter, chapterCount: Math.max(chapters.length, currentChapter), totalWords, wordCount: totalWords, currentWords: totalWords, coverUrl: coverPath ? `/api/v1/books/${encodeURIComponent(bookId)}/cover` : "", firstVolumeTitle: volumes[0]?.title || "", volumeCount: volumes.length, volumes, description, oneLine: description?.oneLine || "", shortIntro: description?.shortIntro || "", fullIntro: description?.fullIntro || "", tags: description?.tags || [] };
}
function isCustomServiceId(serviceId) {
    return serviceId === "custom" || serviceId.startsWith("custom:");
}
function serviceConfigKey(entry) {
    return entry.service === "custom" ? `custom:${entry.name ?? "Custom"}` : entry.service;
}
function normalizeServiceEntry(serviceId, value) {
    if (serviceId.startsWith("custom:")) {
        return {
            service: "custom",
            name: decodeURIComponent(serviceId.slice("custom:".length)),
            ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
            ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
            ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
            ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
            ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
        };
    }
    if (serviceId === "custom") {
        return {
            service: "custom",
            ...(typeof value.name === "string" && value.name.length > 0 ? { name: value.name } : {}),
            ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
            ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
            ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
            ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
            ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
        };
    }
    return {
        service: serviceId,
        ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
        ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
        ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
        ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
        ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
}
function normalizeConfigSource(value) {
    return value === "studio" ? "studio" : "env";
}
function normalizeServiceConfig(raw) {
    if (Array.isArray(raw)) {
        return raw
            .filter((entry) => Boolean(entry) && typeof entry === "object")
            .map((entry) => ({
            service: typeof entry.service === "string" && entry.service.length > 0 ? entry.service : "custom",
            ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
            ...(typeof entry.baseUrl === "string" && entry.baseUrl.length > 0 ? { baseUrl: entry.baseUrl } : {}),
            ...(typeof entry.temperature === "number" ? { temperature: entry.temperature } : {}),
            ...(entry.apiFormat === "chat" || entry.apiFormat === "responses" ? { apiFormat: entry.apiFormat } : {}),
            ...(typeof entry.stream === "boolean" ? { stream: entry.stream } : {}),
        }));
    }
    if (raw && typeof raw === "object") {
        return Object.entries(raw)
            .filter(([, value]) => value && typeof value === "object")
            .map(([serviceId, value]) => normalizeServiceEntry(serviceId, value));
    }
    return [];
}
function mergeServiceConfig(existing, updates) {
    const merged = new Map(existing.map((entry) => [serviceConfigKey(entry), entry]));
    for (const update of updates) {
        merged.set(serviceConfigKey(update), update);
    }
    return [...merged.values()];
}
async function loadRawConfig(root) {
    const configPath = join(root, "hardwrite.json");
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
}
async function saveRawConfig(root, config) {
    // 原子写:hardwrite.json 写撕裂会让几乎所有端点读配置失败而 500(项目被砖)。
    await atomicWriteFile(join(root, "hardwrite.json"), JSON.stringify(config, null, 2));
}
async function readEnvConfigSummary(path) {
    try {
        const raw = await readFile(path, "utf-8");
        const values = new Map();
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#"))
                continue;
            const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!match)
                continue;
            const [, key, value] = match;
            values.set(key, value.trim());
        }
        const provider = values.get("HARDWRITE_LLM_PROVIDER") ?? null;
        const baseUrl = values.get("HARDWRITE_LLM_BASE_URL") ?? null;
        const model = values.get("HARDWRITE_LLM_MODEL") ?? null;
        const apiKey = values.get("HARDWRITE_LLM_API_KEY") ?? "";
        const detected = Boolean(provider || baseUrl || model || apiKey);
        return {
            detected,
            provider,
            baseUrl,
            model,
            hasApiKey: apiKey.length > 0,
        };
    }
    catch {
        return {
            detected: false,
            provider: null,
            baseUrl: null,
            model: null,
            hasApiKey: false,
        };
    }
}
async function readEnvConfigStatus(root) {
    const project = await readEnvConfigSummary(join(root, ".env"));
    const global = await readEnvConfigSummary(GLOBAL_ENV_PATH);
    return {
        project,
        global,
        effectiveSource: project.detected ? "project" : global.detected ? "global" : null,
        runtimeUsesEnv: false,
    };
}
async function resolveConfiguredServiceBaseUrl(root, serviceId, inlineBaseUrl) {
    if (inlineBaseUrl?.trim())
        return inlineBaseUrl.trim();
    if (!isCustomServiceId(serviceId)) {
        return resolveServicePreset(serviceId)?.baseUrl;
    }
    try {
        const config = await loadRawConfig(root);
        const services = normalizeServiceConfig(config.llm?.services);
        const matched = services.find((entry) => serviceConfigKey(entry) === serviceId);
        return matched?.baseUrl;
    }
    catch {
        return undefined;
    }
}
async function resolveConfiguredServiceEntry(root, serviceId) {
    try {
        const config = await loadRawConfig(root);
        const services = normalizeServiceConfig(config.llm?.services);
        return services.find((entry) => serviceConfigKey(entry) === serviceId);
    }
    catch {
        return undefined;
    }
}
function buildProbePlans(preferredApiFormat, preferredStream) {
    const candidates = [];
    const seen = new Set();
    const push = (apiFormat, stream) => {
        const key = `${apiFormat}:${stream ? "1" : "0"}`;
        if (seen.has(key))
            return;
        seen.add(key);
        candidates.push({ apiFormat, stream });
    };
    if (preferredApiFormat) {
        push(preferredApiFormat, preferredStream ?? false);
        push(preferredApiFormat, !(preferredStream ?? false));
    }
    const alternate = preferredApiFormat === "responses" ? "chat" : "responses";
    push(alternate, false);
    push(alternate, true);
    push("chat", false);
    push("chat", true);
    push("responses", false);
    push("responses", true);
    return candidates;
}
function buildModelCandidates(args) {
    const seen = new Set();
    const candidates = [];
    const push = (value) => {
        if (!value || value.trim().length === 0)
            return;
        const id = value.trim();
        if (seen.has(id))
            return;
        seen.add(id);
        candidates.push(id);
    };
    push(args.preferredModel);
    push(args.configModel);
    push(args.envModel ?? undefined);
    for (const model of args.discoveredModels)
        push(model.id);
    if (args.includeGenericFallbacks === false)
        return candidates;
    push("gpt-5.4");
    push("gpt-4o");
    push("claude-sonnet-4-6");
    push("MiniMax-M2.7");
    push("kimi-k2.5");
    return candidates;
}
function formatServiceProbeError(args) {
    const rawDetail = args.error
        .replace(/\n\s*\(baseUrl:[\s\S]*?\)$/m, "")
        .trim();
    const upstreamDetail = rawDetail.includes("上游详情：")
        ? rawDetail
        : "";
    const context = [
        `服务商：${args.label ?? args.service}`,
        `测试模型：${args.model ?? "未确定"}`,
        `协议：${args.apiFormat === "responses" ? "Responses" : "Chat / Completions"}${typeof args.stream === "boolean" ? `，${args.stream ? "流式" : "非流式"}` : ""}`,
        `Base URL：${args.baseUrl}`,
    ].join("\n");
    if (args.service === "google") {
        return [
            "Google Gemini 测试连接失败。",
            context,
            "",
            "请优先检查：",
            "1. API Key 是否来自 Google AI Studio 的 Gemini API key，而不是 OAuth、Vertex AI 或其它 Google 服务凭据。",
            "2. 该 key 所属项目是否已启用 Gemini API，并且没有被限制到其它 API、来源或服务。",
            "3. 当前地区/账号是否允许访问 Gemini API。",
            "4. 如果 key 曾经泄露，请在 AI Studio 重新生成后再保存。",
            upstreamDetail ? `\n上游返回：${upstreamDetail}` : "",
        ].filter(Boolean).join("\n");
    }
    if (args.service === "moonshot" || args.service === "kimiCodingPlan" || args.service === "kimicode") {
        return [
            `${args.label ?? args.service} 测试连接失败。`,
            context,
            "",
            "请优先检查模型是否可用，以及 kimi-k2.x 这类模型是否需要 temperature=1。",
            rawDetail ? `\n上游返回：${rawDetail}` : "",
        ].filter(Boolean).join("\n");
    }
    return [
        `${args.label ?? args.service} 测试连接失败。`,
        context,
        "",
        "请检查 API Key、模型可用性、账号额度，以及协议类型是否匹配该服务商。",
        rawDetail ? `\n上游返回：${rawDetail}` : "",
    ].filter(Boolean).join("\n");
}
async function fetchModelsFromServiceBaseUrl(serviceId, baseUrl, apiKey, proxyUrl) {
    const endpoint = isCustomServiceId(serviceId)
        ? undefined
        : getAllEndpoints().find((ep) => ep.id === serviceId);
    const modelsBaseUrl = isCustomServiceId(serviceId)
        ? baseUrl
        : endpoint?.modelsBaseUrl ?? (endpoint ? baseUrl : resolveServiceModelsBaseUrl(serviceId) ?? baseUrl);
    const modelsUrl = modelsBaseUrl.replace(/\/$/, "") + "/models";
    try {
        const res = await fetchWithProxy(modelsUrl, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10_000),
        }, proxyUrl);
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            return {
                models: [],
                error: `服务商返回 ${res.status}: ${body.slice(0, 200)}`,
                authFailed: res.status === 401 || res.status === 403,
            };
        }
        const json = await res.json();
        return {
            models: (json.data ?? []).map((m) => ({ id: m.id, name: m.id })),
        };
    }
    catch (error) {
        return {
            models: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
async function probeServiceCapabilities(args) {
    const rawConfig = await loadRawConfig(args.root).catch(() => ({}));
    const llm = rawConfig.llm ?? {};
    const envConfig = await readEnvConfigStatus(args.root);
    const envModel = envConfig.effectiveSource === "project"
        ? envConfig.project.model
        : envConfig.effectiveSource === "global"
            ? envConfig.global.model
            : null;
    const baseService = isCustomServiceId(args.service) ? "custom" : args.service;
    const modelsResponse = await fetchModelsFromServiceBaseUrl(baseService, args.baseUrl, args.apiKey, args.proxyUrl);
    if (modelsResponse.authFailed) {
        return {
            ok: false,
            models: [],
            error: modelsResponse.error ?? "API Key 无效或无权访问模型列表。",
        };
    }
    const discoveredModels = modelsResponse.models;
    // For bank services, probe with the service's own check model first — not the global default.
    const endpoint = getAllEndpoints().find((ep) => ep.id === baseService);
    const preset = resolveServicePreset(baseService);
    const serviceFirstModel = endpoint?.checkModel
        ?? preset?.knownModels?.[0]
        ?? endpoint?.models.find((model) => model.enabled !== false)?.id;
    const useDynamicLocalModels = baseService === "ollama";
    const preferredProbeModel = (useDynamicLocalModels || discoveredModels.length > 0)
        ? discoveredModels[0]?.id ?? serviceFirstModel
        : serviceFirstModel;
    const useEndpointCheckModel = !useDynamicLocalModels && discoveredModels.length === 0 && !isCustomServiceId(args.service) && Boolean(endpoint?.checkModel);
    const configService = typeof llm.service === "string" ? llm.service : undefined;
    const configModel = !useEndpointCheckModel && configService === args.service
        ? typeof llm.defaultModel === "string"
            ? llm.defaultModel
            : typeof llm.model === "string"
                ? llm.model
                : undefined
        : undefined;
    const useCustomFallbacks = isCustomServiceId(args.service);
    const modelCandidates = buildModelCandidates({
        preferredModel: args.preferredModel ?? preferredProbeModel,
        configModel,
        envModel: useCustomFallbacks ? envModel : undefined,
        discoveredModels: useEndpointCheckModel ? [] : discoveredModels,
        includeGenericFallbacks: useCustomFallbacks,
    });
    if (modelCandidates.length === 0) {
        return {
            ok: false,
            models: [],
            error: "无法自动确定模型，请先填写可用模型或提供支持 /models 的服务端点。",
        };
    }
    let lastError = modelsResponse.error ?? "自动探测失败";
    for (const model of modelCandidates) {
        for (const plan of buildProbePlans(args.preferredApiFormat, args.preferredStream)) {
            const client = createLLMClient({
                provider: resolveServiceProviderFamily(baseService) ?? "openai",
                service: baseService,
                configSource: "studio",
                baseUrl: args.baseUrl,
                apiKey: args.apiKey.trim(),
                model,
                temperature: 0.7,
                maxTokens: 2048,
                thinkingBudget: 0,
                proxyUrl: args.proxyUrl,
                apiFormat: plan.apiFormat,
                stream: plan.stream,
            });
            try {
                await chatCompletion(client, model, [{ role: "user", content: "ping" }], { maxTokens: 2048 });
                const models = discoveredModels.length > 0
                    ? discoveredModels
                    : endpoint?.models
                        .filter((m) => m.enabled !== false)
                        .filter((m) => isTextChatModelId(m.id))
                        .map((m) => ({ id: m.id, name: m.id }))
                        ?? preset?.knownModels?.map((id) => ({ id, name: id }))
                        ?? [{ id: model, name: model }];
                return {
                    ok: true,
                    models,
                    selectedModel: model,
                    apiFormat: plan.apiFormat,
                    stream: plan.stream,
                    baseUrl: args.baseUrl,
                    modelsSource: discoveredModels.length > 0 ? "api" : "fallback",
                };
            }
            catch (error) {
                lastError = formatServiceProbeError({
                    service: baseService,
                    label: endpoint?.label ?? preset?.label,
                    baseUrl: args.baseUrl,
                    model,
                    apiFormat: plan.apiFormat,
                    stream: plan.stream,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    return {
        ok: false,
        models: discoveredModels,
        error: lastError,
    };
}
function sanitizeConnectivityError(error) {
    let text = error instanceof Error ? error.message : String(error ?? "");
    text = text
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
        .replace(/(?:sk|ak|api[_-]?key)[-_A-Za-z0-9]{12,}/gi, "[redacted-key]")
        .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g, "[redacted-token]");
    return text.slice(0, 900);
}
function connectivitySuggestion(error) {
    const text = String(error || "").toLowerCase();
    if (/api key|unauthorized|401|鉴权|认证|invalid key|forbidden|403|permission|权限/.test(text)) {
        return "Key、额度或模型权限没有通过；在服务配置里粘贴对应服务商 Key 后再检测。";
    }
    if (/supported api model names|unsupported|unknown model|model .*not|model_not_found|404|模型名|does not exist|passed/.test(text)) {
        return "服务商与模型名不匹配；请把该 Agent 切到这个服务商真正支持的文本模型。";
    }
    if (/timeout|timed out|aborted|超时/.test(text)) {
        return "模型响应超时；可能是网关慢、模型排队或代理不稳定，建议换快模型或检查网络。";
    }
    if (/fetch failed|enotfound|econnrefused|network|dns|base url|invalid url|连接/.test(text)) {
        return "Base URL、代理或网络连接异常；先检查服务地址是否能访问。";
    }
    return "请检查服务商、Base URL、模型名、API Key 是否属于同一家模型服务。";
}
function publicConnectivityTarget(target) {
    return {
        id: target.id,
        agent: target.agent,
        label: target.label,
        mission: target.mission,
        service: target.serviceId,
        serviceLabel: target.serviceLabel,
        model: target.model,
        baseUrl: target.baseUrl,
    };
}
// --- Server factory ---
export function createStudioServer(initialConfig, root) {
    activityLogRoot = root;
    const app = new Hono();
    const state = new StateManager(root);
    const activeWriteJobs = new Map();
    const activeStateRepairJobs = new Map();
    const progressPersistAt = new Map();
    const ACTIVE_WRITE_STALE_MS = 10 * 60 * 1000;
    const REPAIR_LLM_TIMEOUT_MS = Number(process.env.HARDWRITE_REPAIR_LLM_TIMEOUT_MS || process.env.HARDWRITE_LONG_LLM_TIMEOUT_MS || 10 * 60 * 1000);
    const REPAIR_ADAPTIVE_ENABLED = process.env.HARDWRITE_REPAIR_ADAPTIVE !== "0";
    const REPAIR_MAX_AUTO_ROUNDS = Math.max(1, Math.min(3, Number(process.env.HARDWRITE_REPAIR_MAX_AUTO_ROUNDS || 3)));
    const REPAIR_MAX_TOKENS_CAP = Math.max(3200, Math.min(12000, Number(process.env.HARDWRITE_REPAIR_MAX_TOKENS || 7600)));
    const REPAIR_TOKEN_MULTIPLIER = Math.max(1.05, Math.min(2.2, Number(process.env.HARDWRITE_REPAIR_TOKEN_MULTIPLIER || 1.6)));
    const REPAIR_STREAM_ENABLED = process.env.HARDWRITE_REPAIR_STREAM === "1";
    const ACTIVE_REPAIR_STALE_MS = Math.max(2.5 * 60 * 1000, REPAIR_LLM_TIMEOUT_MS + 60 * 1000);
    const REPAIR_WATCHDOG_MS = REPAIR_LLM_TIMEOUT_MS + 30 * 1000;
    const RUN_HEARTBEAT_INTERVAL_MS = 15 * 1000;
    const PROGRESS_PERSIST_INTERVAL_MS = 2500;
    let cachedConfig = initialConfig;
    function activeWriteRunId(bookId) {
        const entry = activeWriteJobs.get(bookId);
        return typeof entry === "string" ? entry : entry?.runId;
    }
    function isServerRunActive(run) {
        return !!run && !["done", "error", "needs-repair", "cancelled"].includes(String(run.status || ""));
    }
    function runHeartbeatAgeMs(run) {
        const timestamp = Date.parse(run?.heartbeatAt || run?.updatedAt || run?.createdAt || "");
        return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
    }
    function runHasLocalOwner(run) {
        return Boolean(run?.bookId) && activeWriteRunId(run.bookId) === run.id;
    }
    function runLostProcessOwner(run) {
        if (!run?.bookId || !isServerRunActive(run) || runHasLocalOwner(run))
            return false;
        const heartbeatAge = runHeartbeatAgeMs(run);
        if (heartbeatAge <= RUN_HEARTBEAT_INTERVAL_MS * 3)
            return false;
        const ownedByThisProcess = Number(run.ownerProcessId) === process.pid || run.ownerInstanceId === SERVER_INSTANCE_ID;
        if (ownedByThisProcess)
            return false;
        if (run.ownerInstanceId && run.ownerInstanceId !== SERVER_INSTANCE_ID)
            return true;
        if (run.ownerProcessId && Number(run.ownerProcessId) !== process.pid)
            return true;
        if (!run.ownerInstanceId)
            return true;
        return false;
    }
    function isVisibleTaskRunStatus(status) {
        return ["queued", "running", "model_done", "needs-repair"].includes(String(status || ""));
    }
    function isDaemonActiveTaskRunStatus(status) {
        return ["queued", "running", "model_done"].includes(String(status || ""));
    }
    async function bookExists(bookId) {
        if (!bookId || !isSafeBookId(bookId))
            return false;
        try {
            await access(state.bookDir(bookId));
            return true;
        }
        catch {
            return false;
        }
    }
    async function bookConfigExists(bookId) {
        if (!bookId || !isSafeBookId(bookId))
            return false;
        try {
            await access(join(state.bookDir(bookId), "book.json"));
            return true;
        }
        catch {
            return false;
        }
    }
    async function taskRunIsCancelled(runId) {
        if (!runId)
            return false;
        const runs = await loadTaskRuns(root).catch(() => []);
        return runs.some((run) => run.id === runId && run.status === "cancelled");
    }
    async function broadcastStoppedIfCancelled(runId, bookId, reason = "用户已停止本书工作流") {
        if (!(await taskRunIsCancelled(runId)))
            return false;
        if (bookId) {
            activeWriteJobs.delete(bookId);
            activeStateRepairJobs.delete(bookId);
            broadcast("workflow:stopped", { bookId, runId, agent: "guardian", agentLabel: "守护进程", stage: reason });
        }
        return true;
    }
    function abortReasonError(reason) {
        return reason instanceof Error ? reason : new Error(String(reason || "用户已停止本书工作流"));
    }
    function abortJobController(job, reason) {
        const controller = job && typeof job === "object" ? job.abortController : undefined;
        if (!controller || controller.signal?.aborted)
            return false;
        controller.abort(abortReasonError(reason));
        return true;
    }
    function abortBookJobControllers(bookId, reason) {
        let aborted = 0;
        if (abortJobController(activeWriteJobs.get(bookId), reason))
            aborted++;
        if (abortJobController(activeStateRepairJobs.get(bookId), reason))
            aborted++;
        return aborted;
    }
    function bindAbortSignal(sourceSignal, targetController, reason = "上游请求已取消") {
        if (!sourceSignal || typeof sourceSignal.addEventListener !== "function")
            return () => { };
        const abort = () => {
            if (!targetController.signal.aborted)
                targetController.abort(abortReasonError(reason));
        };
        if (sourceSignal.aborted) {
            abort();
            return () => { };
        }
        sourceSignal.addEventListener("abort", abort, { once: true });
        return () => sourceSignal.removeEventListener("abort", abort);
    }
    async function cancelBookRuns(bookId, reason = "用户手动停止本书工作流") {
        if (!bookId || !isSafeBookId(bookId))
            return { cancelled: 0, releasedLocks: 0, abortedRequests: 0 };
        const hadWriteLock = activeWriteJobs.has(bookId);
        const hadRepairLock = activeStateRepairJobs.has(bookId);
        const abortedRequests = abortBookJobControllers(bookId, reason);
        activeWriteJobs.delete(bookId);
        activeStateRepairJobs.delete(bookId);
        try {
            const { rm } = await import("node:fs/promises");
            await rm(join(state.bookDir(bookId), ".write.lock"), { force: true });
        }
        catch {
            // Lock cleanup is best-effort; task table cancellation is authoritative.
        }
        const result = await enqueueTaskRunMutation(root, async () => {
            const runs = await loadTaskRuns(root);
            let cancelled = 0;
            const now = new Date().toISOString();
            for (const run of runs) {
                if (run.bookId !== bookId || !isVisibleTaskRunStatus(run.status))
                    continue;
                run.status = "cancelled";
                run.error = reason;
                run.failureReason = reason;
                run.currentAgent = "guardian";
                run.currentStage = reason;
                run.completedAt = now;
                run.updatedAt = now;
                run.heartbeatAt = now;
                run.events = [{ time: now, kind: "workflow:stopped", stage: reason, agent: "guardian" }, ...(run.events || [])].slice(0, 40);
                cancelled++;
            }
            if (cancelled)
                await saveTaskRuns(root, runs);
            return { cancelled };
        });
        const payload = { bookId, cancelled: result.cancelled, releasedLocks: Number(hadWriteLock) + Number(hadRepairLock), abortedRequests, agent: "guardian", agentLabel: "守护进程", stage: reason };
        if (await bookExists(bookId))
            void appendBookAgentEvent(root, bookId, "workflow:stopped", payload);
        broadcast("workflow:stopped", payload);
        return payload;
    }
    function startTaskHeartbeat(runId, agent, stage, extra = {}) {
        if (!runId)
            return () => { };
        const tick = () => {
            void updateTaskRun(root, runId, {
                status: "running",
                currentAgent: agent,
                currentStage: stage,
                heartbeatAgent: agent,
                heartbeatStage: stage,
                ...extra,
            }, { kind: "run:heartbeat", stage, agent }).catch(() => null);
        };
        tick();
        const timer = setInterval(tick, RUN_HEARTBEAT_INTERVAL_MS);
        timer.unref?.();
        return () => clearInterval(timer);
    }
    async function bookPlatformExternalContext(bookId) {
        const book = await state.loadBookConfig(bookId).catch(() => null);
        if (!book)
            return undefined;
        const language = book.language === "en" ? "en" : "zh";
        const explicit = typeof book.platformGuidance === "string" && book.platformGuidance.trim()
            ? book.platformGuidance.trim()
            : buildNovelPlatformPrompt(book.platform, language);
        if (!explicit)
            return undefined;
        return language === "en"
            ? `## Persistent Platform Strategy\n${explicit}\n\nUse this strategy for every chapter, repair pass, polish pass, quality report, and continuity decision.`
            : `## 平台策略长期约束\n${explicit}\n\n每一章写作、复修、润色、质量报告和连续性决策都必须读取并遵守该策略。`;
    }
    function mergeExternalContext(...parts) {
        return parts.map((part) => String(part || "").trim()).filter(Boolean).join("\n\n---\n\n");
    }
    // 嗓音指纹注入:把本书 style_profile.json 的可计算嗓音特征,作为"必须贴合的固定腔调"注入写作 run 的
    // externalContext——写手按它写,审稿/改稿读到同一靶子,长期保持风格一致(风格指纹 stage 2)。
    async function voiceFingerprintBlock(bookId) {
        try {
            const raw = await readFile(join(state.bookDir(bookId), "story", "style_profile.json"), "utf-8").catch(() => "");
            if (!raw)
                return "";
            const p = JSON.parse(raw);
            if (!p || typeof p.avgSentenceLength !== "number")
                return "";
            return [
                "## 本书嗓音指纹(写作/改稿/评审都要贴合,保持长期一致;偏离即风格漂移,需向它靠拢)",
                `- 句子:平均约 ${Math.round(p.avgSentenceLength)} 字,长短交错(句长波动约 ${Math.round(p.sentenceLengthStdDev || 0)}),保持这种节奏,多用利落短句、少长难句。`,
                `- 段落:短段呼吸感(平均约 ${Math.round(p.avgParagraphLength || 0)} 字一段),手机可读。`,
                Array.isArray(p.rhetoricalFeatures) && p.rhetoricalFeatures.length ? `- 手法画像:${p.rhetoricalFeatures.join("、")}。` : "",
                "- 情绪用动作/五感/身体外化,避免“他感到…”式直白标签;克制不煽情。",
            ].filter(Boolean).join("\n");
        }
        catch {
            return "";
        }
    }
    // 叙事 craft 技能注入:把 skills/genre/story(场景-后续/show-don't-tell/契诃夫之枪)+ skills/style/prose-humanize
    // (去 AI 叙事腔)挂进写作 run 的 externalContext,让写手按真 craft skill 写。缓存一次(skill 文件不随书变)。
    let _narrativeCraftCache = null;
    async function narrativeCraftBlock() {
        if (_narrativeCraftCache != null)
            return _narrativeCraftCache;
        try {
            const mounted = await mountSkills(SKILLS_DIR, ["genre/story", "style/prose-humanize"]);
            _narrativeCraftCache = mounted ? `## 叙事 craft 技能(写手按此写,审稿/改稿按此查)\n${mounted}` : "";
        }
        catch {
            _narrativeCraftCache = "";
        }
        return _narrativeCraftCache;
    }
    function longOutputSafetyContext({ wordCount, chapters = 1, targetScore = 80, mode = "write" } = {}) {
        const targetChars = Number(wordCount || 0);
        const chapterCount = Number(chapters || 1);
        const needsGuard = targetChars >= 2800 || chapterCount > 1 || mode !== "write";
        if (!needsGuard)
            return "";
        return [
            "## 长输出稳定策略",
            `- 本轮模式：${mode}；目标分：${targetScore}+；单章目标字数：${targetChars || "按书籍默认"}；批量章数：${chapterCount}。`,
            "- 为避免本地长输出超时，每次模型调用只输出当前阶段必须交付的内容；禁止附带思考过程、长解释、重复摘要或无关建议。",
            "- 写正文/复修正文时，优先交付完整本章正文和必要结构化字段；truth files、质量报告、提示词治理只写增量精华。",
            "- 如果上下文过长，优先保留：当前章节目标、最近三章事实、人物状态、硬约束、质量阻断项；压缩远期设定和已经稳定的背景。",
            "- 复修不得多轮小修小补；第一轮就按 90+ 发布级重排因果、拍点、场景阻力和段落节奏，避免重复烧 token。",
        ].join("\n");
    }
    function taskRunChapterNumber(run) {
        const raw = run?.chapterNumber ?? run?.results?.[0]?.chapterNumber ?? run?.currentChapter;
        const direct = Number(raw);
        if (Number.isInteger(direct) && direct > 0)
            return direct;
        const match = String(run?.currentStage || "").match(/第\s*(\d+)\s*章/);
        return match ? Number(match[1]) : 0;
    }
    function activeSameRepairRun(runs, bookId, chapterNumber) {
        return runs.find((run) => run.bookId === bookId &&
            run.type === "chapter-quality-repair" &&
            taskRunChapterNumber(run) === chapterNumber &&
            isServerRunActive(run) &&
            !runLostProcessOwner(run) &&
            runHeartbeatAgeMs(run) <= ACTIVE_REPAIR_STALE_MS);
    }
    async function findActiveBookRun(bookId) {
        const taskRuns = await loadTaskRuns(root);
        const activeRunFromTable = taskRuns
            .filter((run) => run.bookId === bookId && isServerRunActive(run))
            .sort((left, right) => Date.parse(right.heartbeatAt || right.updatedAt || right.createdAt || "") - Date.parse(left.heartbeatAt || left.updatedAt || left.createdAt || ""))[0];
        const existingRunId = activeWriteRunId(bookId) || activeRunFromTable?.id;
        const existingRun = existingRunId ? taskRuns.find((run) => run.id === existingRunId) : activeRunFromTable;
        if (!existingRun || !isServerRunActive(existingRun))
            return null;
        const staleLimit = existingRun.type === "chapter-quality-repair" ? ACTIVE_REPAIR_STALE_MS : ACTIVE_WRITE_STALE_MS;
        if (runLostProcessOwner(existingRun) || runHeartbeatAgeMs(existingRun) > staleLimit)
            return null;
        return existingRun;
    }
    function shouldPersistProgress(key, status) {
        const done = status === "done" || status === "error";
        const now = Date.now();
        const last = progressPersistAt.get(key) || 0;
        if (done || now - last >= PROGRESS_PERSIST_INTERVAL_MS) {
            progressPersistAt.set(key, now);
            return true;
        }
        return false;
    }
    async function prepareWriteSlot(bookId, options = {}) {
        const taskRuns = await loadTaskRuns(root);
        const activeRunFromTable = taskRuns
            .filter((run) => run.bookId === bookId && isServerRunActive(run))
            .sort((left, right) => Date.parse(right.heartbeatAt || right.updatedAt || right.createdAt || "") - Date.parse(left.heartbeatAt || left.updatedAt || left.createdAt || ""))[0];
        const existingRunId = activeWriteRunId(bookId) || activeRunFromTable?.id;
        if (!existingRunId)
            return null;
        const existingRun = taskRuns.find((run) => run.id === existingRunId);
        const existingStaleLimit = existingRun?.type === "chapter-quality-repair" ? ACTIVE_REPAIR_STALE_MS : ACTIVE_WRITE_STALE_MS;
        const lostOwner = runLostProcessOwner(existingRun);
        const stale = lostOwner || !existingRun || !isServerRunActive(existingRun) || runHeartbeatAgeMs(existingRun) > existingStaleLimit;
        if (!stale) {
            activeWriteJobs.set(bookId, { runId: existingRunId, startedAt: Date.now() });
            return {
                error: options.forceTakeover
                    ? "这本书已有新鲜写作任务正在运行。系统已重新绑定当前任务，不会用强制接管中断它；如果页面长时间无响应，请点“检查并继续”。"
                    : "这本书已有写作任务正在运行。为避免重复消耗 token，系统不会并行启动第二个任务；如果页面长时间无响应，请点“检查并继续”。",
                status: "already-writing",
                runId: existingRunId,
                heartbeatAgeMs: runHeartbeatAgeMs(existingRun),
            };
        }
        activeWriteJobs.delete(bookId);
        const staleError = lostOwner ? "Backend task lost in-memory owner after restart." : "Backend active write job heartbeat timed out.";
        const failure = failureInfoForActivity("watchdog:stale", { error: staleError, total: existingRun?.total, index: existingRun?.currentIndex });
        if (existingRun && isServerRunActive(existingRun)) {
            void updateTaskRun(root, existingRunId, {
                status: "error",
                error: staleError,
                failureReason: failure.reason,
                impact: failure.impact,
                suggestion: failure.suggestion,
                currentAgent: "guardian",
                currentStage: lostOwner ? "服务重启中断旧任务，已释放锁并允许自动续跑" : "后端心跳超时，已释放写作锁",
            }, { kind: "watchdog:stale", stage: lostOwner ? "服务重启中断旧任务，已释放锁并允许自动续跑" : "后端心跳超时，已释放写作锁", agent: "guardian", error: staleError, failureReason: failure.reason });
        }
        const payload = { bookId, runId: existingRunId, agent: "guardian", agentLabel: "守护进程", stage: lostOwner ? "服务重启中断旧任务，已释放锁并自动恢复" : "后端心跳超时，释放旧任务锁并允许继续", failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion };
        void appendBookAgentEvent(root, bookId, "watchdog:stale", payload);
        broadcast("watchdog:stale", payload);
        return null;
    }
    async function releaseStaleTaskRunsFromTable() {
        const runs = await loadTaskRuns(root);
        let changed = false;
        for (const run of runs) {
            if (["done", "completed"].includes(String(run.status || "").toLowerCase()) &&
                (run.error || run.failureReason || run.impact || run.suggestion)) {
                run.error = undefined;
                run.failureReason = undefined;
                run.impact = undefined;
                run.suggestion = undefined;
                run.updatedAt = new Date().toISOString();
                changed = true;
            }
            const createStatus = run.type === "create-book" && run.bookId ? bookCreateStatus.get(run.bookId) : null;
            const createStillLive = isLiveBookCreateStatus(createStatus, run);
            if (run.type === "create-book" &&
                run.bookId &&
                ["error", "cancelled"].includes(String(run.status || ""))) {
                const materializedBook = await state.loadBookConfig(run.bookId).catch(() => null);
                const materializedStatus = String(materializedBook?.status || "").toLowerCase();
                if (materializedBook &&
                    (materializedStatus === "outlining" ||
                        materializedStatus === "needs-foundation" ||
                        createRunNeedsFoundation(run))) {
                    const now = new Date().toISOString();
                    run.status = "error";
                    run.error = run.error || "Book foundation is incomplete.";
                    run.failureReason = run.failureReason || "建书只恢复到草稿/大纲阶段，尚未通过作品地基验收。";
                    run.impact = run.impact || "不会把未完成作品显示成创建完成，也不会自动进入写章。";
                    run.suggestion = run.suggestion || "请先补齐/验收大纲、人物、主线和开篇资产，通过后再启动写章。";
                    run.currentAgent = "foundation-reviewer";
                    run.currentStage = "建书未完成，已保存可恢复草稿";
                    run.updatedAt = now;
                    run.heartbeatAt = now;
                    run.completedAt = run.completedAt || now;
                    run.events = [{ time: now, kind: "book:needs-foundation", stage: run.currentStage, agent: "foundation-reviewer", error: run.error, failureReason: run.failureReason }, ...(run.events || [])].slice(0, 40);
                    changed = true;
                    continue;
                }
                if (!materializedBook && !(await bookConfigExists(run.bookId)))
                    continue;
                const now = new Date().toISOString();
                run.status = "done";
                run.error = undefined;
                run.failureReason = undefined;
                run.impact = undefined;
                run.suggestion = undefined;
                run.currentAgent = run.currentAgent || "architect";
                run.currentStage = run.currentStage && !/中断|释放锁|删除|stale|未完成|可恢复|失败|错误/i.test(run.currentStage)
                    ? run.currentStage
                    : "作品档案已创建";
                run.updatedAt = now;
                run.heartbeatAt = now;
                run.completedAt = run.completedAt || now;
                run.events = [{ time: now, kind: "book:create:materialized", stage: run.currentStage, agent: run.currentAgent }, ...(run.events || [])].slice(0, 40);
                changed = true;
                continue;
            }
            if (run.bookId && isVisibleTaskRunStatus(run.status) && !(await bookExists(run.bookId))) {
                if (run.type === "create-book" && createStillLive) {
                    continue;
                }
                const now = new Date().toISOString();
                run.status = "cancelled";
                run.error = "Book directory no longer exists.";
                run.failureReason = "作品已删除，残留任务已自动清理。";
                run.impact = "不会再显示为运行中，也不会继续占用写作锁。";
                run.suggestion = "重新开书后会使用新的任务锁和 run_id。";
                run.currentAgent = "guardian";
                run.currentStage = "作品已删除，残留任务已自动清理";
                run.updatedAt = now;
                run.heartbeatAt = now;
                run.completedAt = now;
                run.events = [{ time: now, kind: "workflow:stopped", stage: run.currentStage, agent: "guardian", error: run.error, failureReason: run.failureReason }, ...(run.events || [])].slice(0, 40);
                activeWriteJobs.delete(run.bookId);
                activeStateRepairJobs.delete(run.bookId);
                changed = true;
                continue;
            }
            const heartbeatAge = runHeartbeatAgeMs(run);
            const missingInMemoryOwner = runLostProcessOwner(run);
            const staleLimit = run.type === "chapter-quality-repair" ? ACTIVE_REPAIR_STALE_MS : ACTIVE_WRITE_STALE_MS;
            if (run.type === "create-book" && createStillLive) {
                continue;
            }
            if (!isServerRunActive(run) || (!missingInMemoryOwner && heartbeatAge <= staleLimit))
                continue;
            const staleError = missingInMemoryOwner ? "Backend task lost in-memory owner after restart." : (run.type === "chapter-quality-repair" ? "Quality repair task heartbeat timed out." : "Backend task heartbeat timed out.");
            const failure = failureInfoForActivity("watchdog:stale", { error: staleError, total: run.total, index: run.currentIndex });
            const repairChapter = run.type === "chapter-quality-repair" ? taskRunChapterNumber(run) : 0;
            run.status = repairChapter ? "needs-repair" : "error";
            run.error = staleError;
            run.failureReason = failure.reason;
            run.impact = failure.impact;
            run.suggestion = failure.suggestion;
            run.currentAgent = "guardian";
            run.currentStage = repairChapter
                ? (missingInMemoryOwner
                    ? `服务重启中断第 ${repairChapter} 章复修，旧锁已释放，工作台会自动检查并继续复修`
                    : `第 ${repairChapter} 章复修心跳超时，已释放锁并允许继续复修`)
                : (missingInMemoryOwner ? "服务重启中断旧任务，已释放锁并允许自动续跑" : "后端任务心跳超时，已释放锁并允许自动续跑");
            if (repairChapter)
                run.results = [{ chapterNumber: repairChapter, pass: false, error: staleError }];
            run.updatedAt = new Date().toISOString();
            run.events = [{ time: run.updatedAt, kind: "watchdog:stale", stage: run.currentStage, agent: "guardian", error: run.error, failureReason: failure.reason }, ...(run.events || [])].slice(0, 40);
            if (run.bookId) {
                activeWriteJobs.delete(run.bookId);
                const payload = { bookId: run.bookId, runId: run.id, agent: "guardian", agentLabel: "守护进程", stage: missingInMemoryOwner ? "服务重启中断旧任务，已释放锁并自动恢复" : "后端任务心跳超时，释放旧任务锁并允许继续", failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion };
                void appendBookAgentEvent(root, run.bookId, "watchdog:stale", payload);
                broadcast("watchdog:stale", payload);
            }
            changed = true;
        }
        if (changed)
            await saveTaskRuns(root, runs);
        return changed;
    }
    const staleRunSweeper = setInterval(() => {
        void releaseStaleTaskRunsFromTable().catch(() => false);
    }, RUN_HEARTBEAT_INTERVAL_MS * 2);
    staleRunSweeper.unref?.();
    void releaseStaleTaskRunsFromTable().catch(() => false);
    function setWriteSlot(bookId, runId, extra = {}) {
        activeWriteJobs.set(bookId, { runId, startedAt: Date.now(), ...extra });
    }
    function releaseWriteSlot(bookId, runId) {
        if (activeWriteRunId(bookId) === runId)
            activeWriteJobs.delete(bookId);
    }
    function qualityGateActuallyPassed(quality, targetScore = 80) {
        const score = Number(quality?.total);
        if (!Number.isFinite(score) || score < targetScore)
            return false;
        // 尊重 run 请求的 targetScore:不再依赖烘焙在 90 的 gate.pass。
        // 硬阻断项(critical 审稿 / 状态不可信 / 缺质量报告 / 太短 / 缺章)仍然一票否决,质量底线不破;
        // 但 "quality-below-target" 只是"低于硬编码 90"的占位——分数既已达到请求阈值,就不算阻断。
        const blockers = Array.isArray(quality?.gate?.blockers) ? quality.gate.blockers : [];
        const hardBlockers = blockers.filter((b) => String(b) !== "quality-below-target");
        return hardBlockers.length === 0;
    }
    async function markChapterReadyIfQualityPassed(bookId, chapterNumber, qualityPayload, targetScore = 80, reason = "质量 Gate 已达标，自动恢复章节状态") {
        if (!Number.isInteger(chapterNumber) || chapterNumber <= 0)
            return false;
        if (!qualityGateActuallyPassed(qualityPayload?.quality, targetScore))
            return false;
        const chapters = await state.loadChapterIndex(bookId).catch(() => []);
        const current = chapters.find((entry) => Number(entry.chapterNumber ?? entry.number) === chapterNumber);
        if (!current)
            return false;
        if (current.status === "ready-for-review" && Array.isArray(current.auditIssues) && current.auditIssues.length === 0)
            return false;
        current.status = "ready-for-review";
        current.auditIssues = [];
        current.updatedAt = new Date().toISOString();
        // 章已复修达标:清掉"直播低分接受"残留标记。否则 belowTarget 会一直挂着,
        // 让 findExistingQualityGateBlocker 永远重查这章(即便它现在分数够了),
        // 是死锁/误拦的根源。达标即"诚实合格",这些字段必须一并清除。
        delete current.belowTarget;
        delete current.acceptedScore;
        await state.saveChapterIndex(bookId, chapters);
        const payload = { bookId, chapterNumber, agent: "quality-reporter", agentLabel: "质量报告官", stage: reason, scoreAfter: qualityPayload?.quality?.total };
        void appendBookAgentEvent(root, bookId, "quality-gate:auto-heal", payload);
        broadcast("quality-gate:auto-heal", payload);
        return true;
    }
    async function evaluateGeneratedChapterGate(bookId, result, targetScore = 80, options = {}) {
        const chapterNumber = Number(result?.chapterNumber || 0);
        const qualityOptions = {
            targetWordCount: options.targetWordCount,
            gateTarget: targetScore,
        };
        let qualityPayload = chapterNumber ? await buildChapterQualityPayload(state, bookId, chapterNumber, undefined, qualityOptions).catch(() => null) : null;
        if (chapterNumber && qualityPayload?.quality?.gate?.blockers?.includes?.("missing-quality-report")) {
            await writeStudioChapterQualityReport(state, bookId, chapterNumber, qualityPayload, "续写完成后自动补齐质量报告，供 Gate、交接单和复修链路使用。").catch(() => null);
            qualityPayload = await buildChapterQualityPayload(state, bookId, chapterNumber, undefined, qualityOptions).catch(() => qualityPayload);
        }
        const quality = qualityPayload?.quality ?? null;
        const score = Number.isFinite(Number(quality?.total)) ? Number(quality.total) : undefined;
        const gatePass = qualityGateActuallyPassed(quality, targetScore);
        const stateDegraded = result?.status === "state-degraded" || qualityPayload?.status === "state-degraded";
        const needsRepair = stateDegraded || !gatePass;
        if (!needsRepair && (result?.status === "audit-failed" || qualityPayload?.status === "audit-failed")) {
            await markChapterReadyIfQualityPassed(bookId, chapterNumber, qualityPayload, targetScore, `第 ${chapterNumber} 章质量 Gate 已达标，旧 audit-failed 状态已自动解锁`);
        }
        const failureReason = needsRepair
            ? `第 ${chapterNumber || "?"} 章未过质量 Gate：状态 ${result?.status || "unknown"}，评分 ${score ?? "--"}，目标 ${targetScore}+。`
            : "";
        const suggestion = needsRepair
            ? `先点击“修复到${targetScore}+”：系统会分配状态校验员、修稿师、润色师和质量报告官复修本章；达标前不会继续写下一章。`
            : "";
        return {
            qualityPayload,
            quality,
            score,
            gatePass,
            needsRepair,
            failureReason,
            suggestion,
            result: {
                chapterNumber,
                status: needsRepair ? result?.status : "ready-for-review",
                title: result?.title,
                wordCount: result?.wordCount,
                targetWordCount: quality?.stats?.targetWordCount,
                targetScore,
                scoreAfter: score,
                quality,
                pass: !needsRepair,
            },
        };
    }
    async function findExistingQualityGateBlocker(bookId, targetScore = 80, beforeChapter = Number.POSITIVE_INFINITY) {
        const index = await state.loadChapterIndex(bookId).catch(() => []);
        const chapters = [...index]
            .map((chapter) => ({
            chapterNumber: Number(chapter.chapterNumber ?? chapter.number ?? 0),
            title: chapter.title || "",
            status: chapter.status || "unknown",
            // 必须把 belowTarget 带进投影,否则下面"approved 但 belowTarget 重查"的判断永远读到 undefined、形同虚设。
            belowTarget: chapter.belowTarget === true,
        }))
            .filter((chapter) => Number.isInteger(chapter.chapterNumber) && chapter.chapterNumber > 0 && chapter.chapterNumber < beforeChapter)
            .sort((left, right) => left.chapterNumber - right.chapterNumber);
        for (const chapter of chapters) {
            // approved/ready 状态的章节已被人工确认通过，直接跳过质量检查——
            // 不跳过会导致旧 gate.pass=false 字段(按旧阈值存储)永远拦住续写。
            // approved/ready 跳过门禁——但"直播低分接受(belowTarget)"的伪 approved 必须重查,否则永久绕过门禁、质量滑坡。
            if (((chapter.status === "approved" || chapter.status === "ready") && chapter.belowTarget !== true) || chapter.status === "published") continue;
            const payload = await buildChapterQualityPayload(state, bookId, chapter.chapterNumber).catch((error) => ({
                bookId,
                chapterNumber: chapter.chapterNumber,
                title: chapter.title || `第 ${chapter.chapterNumber} 章`,
                status: chapter.status,
                quality: {
                    total: 0,
                    gate: {
                        target: targetScore,
                        pass: false,
                        blockers: ["chapter-quality-unreadable"],
                        rule: "续写前必须先确认既有章节质量状态。",
                    },
                    reasons: [`章节质量读取失败：${error instanceof Error ? error.message : String(error)}`],
                },
            }));
            const quality = payload?.quality ?? {};
            const score = Number(quality.total ?? 0);
            // gate.pass 是按写章时的阈值存的，阈值降低后历史 false 不该继续拦截。
            // 只要当前分数 >= 当前 targetScore 就视为通过，不依赖历史存储的 gate.pass。
            const pass = Number.isFinite(score) && score >= targetScore;
            if (!pass) {
                return {
                    ...chapter,
                    qualityPayload: payload,
                    score: Number.isFinite(score) ? score : 0,
                    blockers: quality.gate?.blockers || [],
                    reasons: quality.reasons || [],
                    metrics: quality.metrics || {},
                    nextChapter: chapters.length ? Math.max(...chapters.map((item) => item.chapterNumber)) + 1 : 1,
                };
            }
        }
        return null;
    }
    function qualityGateBlockedPayload(bookId, blocker, targetScore, workflow = "write-next") {
        const metrics = Object.entries(blocker.metrics || {})
            .filter(([, value]) => Number(value) < targetScore)
            .map(([key, value]) => `${key} ${value}`)
            .slice(0, 5);
        const detail = [
            `第 ${blocker.chapterNumber} 章实时 Gate ${blocker.score ?? "--"} 分，目标 ${targetScore}+。`,
            metrics.length ? `低分项：${metrics.join("、")}。` : "",
            blocker.blockers?.length ? `阻断项：${blocker.blockers.join("、")}。` : "",
        ].filter(Boolean).join(" ");
        return {
            error: `第 ${blocker.chapterNumber} 章还没过 ${targetScore}+，已阻止继续写第 ${blocker.nextChapter || "下一"} 章。`,
            status: "quality-gate-blocked",
            workflow,
            bookId,
            chapterNumber: blocker.chapterNumber,
            title: blocker.title,
            score: blocker.score,
            targetScore,
            nextChapter: blocker.nextChapter,
            metrics: blocker.metrics,
            blockers: blocker.blockers,
            reasons: blocker.reasons,
            failureReason: detail,
            suggestion: "先运行“连续复修到90+”或批量质量流水线；本章达标前，后端不会再启动续写，避免继续烧 token 和造成上下文断档。",
        };
    }
    async function runEmbeddedQualityRepair(origin, bookId, chapterNumber, targetScore, context = {}) {
        const res = await fetch(new URL(`/api/v1/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}/repair-low-score`, origin), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: context.abortSignal,
            body: JSON.stringify({
                apply: true,
                useLLM: true,
                embedded: true,
                targetScore,
                targetWordCount: context.targetWordCount,
                maxAutoRounds: context.maxAutoRounds,
                adaptiveRepair: context.adaptiveRepair,
                parentRunId: context.parentRunId,
                previousScoreAfter: context.previousScoreAfter,
                previousFailureReason: context.previousFailureReason,
                instruction: context.instruction || `自动质量门禁：本章未达到 ${targetScore}+，请在不改变既定事实和后续大纲的前提下修复到目标分；修好后才允许继续写下一章。`,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
            throw new ApiError(res.status || 502, "AUTO_QUALITY_REPAIR_FAILED", data.failureReason || data.error || "自动复修失败");
        }
        return data;
    }
    async function latestStateDegradedChapter(bookId) {
        const index = await state.loadChapterIndex(bookId);
        const latest = [...index].sort((left, right) => Number(right.number || right.chapterNumber || 0) - Number(left.number || left.chapterNumber || 0))[0];
        return latest?.status === "state-degraded" ? latest : null;
    }
    async function repairChapterStateIfNeeded(bookId, chapterNumber, run, reason = "按章质量修复前状态自愈") {
        const index = await state.loadChapterIndex(bookId);
        const meta = index.find((item) => Number(item.number || item.chapterNumber || 0) === Number(chapterNumber));
        if (meta?.status !== "state-degraded")
            return null;
        const existing = activeStateRepairJobs.get(bookId);
        if (existing)
            return existing;
        const abortController = new AbortController();
        const job = (async () => {
            const repairRunId = run?.id;
            const stage = `第 ${chapterNumber} 章状态不可信，正在按章自愈`;
            const payload = { bookId, runId: repairRunId, chapterNumber, agent: "state-validator", agentLabel: "状态自愈官", stage, reason };
            void appendBookAgentEvent(root, bookId, "state-repair:start", payload);
            if (repairRunId) {
                void updateTaskRun(root, repairRunId, { status: "running", currentAgent: "state-validator", currentStage: stage }, { kind: "state-repair:start", stage, agent: "state-validator" });
            }
            broadcast("agent:stage", payload);
            broadcast("state-repair:start", payload);
            try {
                const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForSSE: bookId, runIdForSSE: repairRunId, abortSignal: abortController.signal }));
                const result = await pipeline.repairChapterState(bookId, chapterNumber);
                const doneStage = `第 ${chapterNumber} 章状态自愈完成，进入低分修复`;
                const done = { bookId, runId: repairRunId, chapterNumber, agent: "state-validator", agentLabel: "状态自愈官", stage: doneStage, result };
                void appendBookAgentEvent(root, bookId, "state-repair:complete", done);
                if (repairRunId) {
                    void updateTaskRun(root, repairRunId, { status: "running", currentAgent: "reviser", currentStage: doneStage }, { kind: "state-repair:complete", stage: doneStage, agent: "state-validator" });
                }
                broadcast("state-repair:complete", done);
                return result;
            }
            catch (e) {
                const error = e instanceof Error ? e.message : String(e);
                const failure = failureInfoForActivity("state-repair:error", { error, chapterNumber });
                const failed = { bookId, runId: repairRunId, chapterNumber, agent: "state-validator", agentLabel: "状态自愈官", error, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion };
                void appendBookAgentEvent(root, bookId, "state-repair:error", failed);
                if (repairRunId) {
                    void updateTaskRun(root, repairRunId, { status: "error", error, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion, currentAgent: "state-validator", currentStage: `第 ${chapterNumber} 章状态自愈失败` }, { kind: "state-repair:error", stage: `第 ${chapterNumber} 章状态自愈失败`, agent: "state-validator", error, failureReason: failure.reason });
                }
                broadcast("state-repair:error", failed);
                throw e;
            }
            finally {
                activeStateRepairJobs.delete(bookId);
            }
        })();
        job.abortController = abortController;
        activeStateRepairJobs.set(bookId, job);
        return job;
    }
    async function repairLatestStateIfNeeded(bookId, run, reason = "写作前状态自愈") {
        const latest = await latestStateDegradedChapter(bookId);
        if (!latest)
            return null;
        const chapterNumber = Number(latest.number || latest.chapterNumber || 0);
        const existing = activeStateRepairJobs.get(bookId);
        if (existing)
            return existing;
        const abortController = new AbortController();
        const job = (async () => {
            const repairRunId = run?.id;
            const stage = `第 ${chapterNumber} 章状态不可信，正在自愈`;
            const payload = { bookId, runId: repairRunId, chapterNumber, agent: "state-validator", agentLabel: "状态自愈官", stage, reason };
            void appendBookAgentEvent(root, bookId, "state-repair:start", payload);
            if (repairRunId) {
                void updateTaskRun(root, repairRunId, { status: "running", currentAgent: "state-validator", currentStage: stage }, { kind: "state-repair:start", stage, agent: "state-validator" });
            }
            broadcast("agent:stage", payload);
            broadcast("state-repair:start", payload);
            try {
                const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForSSE: bookId, runIdForSSE: repairRunId, abortSignal: abortController.signal }));
                const result = await pipeline.repairChapterState(bookId, chapterNumber);
                const doneStage = `第 ${chapterNumber} 章状态自愈完成，继续写下一章`;
                const done = { bookId, runId: repairRunId, chapterNumber, agent: "state-validator", agentLabel: "状态自愈官", stage: doneStage, result };
                void appendBookAgentEvent(root, bookId, "state-repair:complete", done);
                if (repairRunId) {
                    void updateTaskRun(root, repairRunId, { status: "running", currentAgent: "planner", currentStage: doneStage }, { kind: "state-repair:complete", stage: doneStage, agent: "state-validator" });
                }
                broadcast("state-repair:complete", done);
                broadcast("agent:stage", { ...done, agent: "planner", agentLabel: "规划师", stage: "状态已修复，恢复章节规划" });
                return result;
            }
            catch (e) {
                const error = e instanceof Error ? e.message : String(e);
                const failure = failureInfoForActivity("state-repair:error", { error, chapterNumber });
                const failed = { bookId, runId: repairRunId, chapterNumber, agent: "state-validator", agentLabel: "状态自愈官", error, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion };
                void appendBookAgentEvent(root, bookId, "state-repair:error", failed);
                if (repairRunId) {
                    void updateTaskRun(root, repairRunId, { status: "error", error, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion, currentAgent: "state-validator", currentStage: `第 ${chapterNumber} 章状态自愈失败` }, { kind: "state-repair:error", stage: `第 ${chapterNumber} 章状态自愈失败`, agent: "state-validator", error, failureReason: failure.reason });
                }
                broadcast("state-repair:error", failed);
                throw e;
            }
            finally {
                activeStateRepairJobs.delete(bookId);
            }
        })();
        job.abortController = abortController;
        activeStateRepairJobs.set(bookId, job);
        return job;
    }
    app.use("/*", cors());
    // ── 激活强制门(后端强制,不再只靠前端 localStorage)──────────────────────
    // 仅在显式 HARDWRITE_ACTIVATION_REQUIRED=1 时生效(特殊分发场景的整站硬卡);
    // 常规商业包/自部署 = 免码直通进站写书(普通会员轻档),激活码只解锁 Pro/Ultra。
    // 放行 /auth/* 与 OPTIONS,其余未解锁一律 403。
    app.use("/*", async (c, next) => {
        if (c.req.method === "OPTIONS" || !activationRequired()) {
            await next();
            return;
        }
        const path = c.req.path;
        if (path.startsWith("/api/v1/auth/") || path === "/healthz") {
            await next();
            return;
        }
        const activation = await loadActivation(root).catch(() => null);
        const expired = activation?.expiresAt ? Date.parse(activation.expiresAt) < Date.now() : false;
        if (!activation?.unlocked || expired) {
            return c.json({ error: { code: "ACTIVATION_REQUIRED", message: "本产品需要激活码才能使用,请在登录页输入激活码解锁。" } }, 403);
        }
        await next();
    });
    app.get("/healthz", (c) => c.json({ ok: true, service: "juanshe-studio" }));
    app.use("/*", async (c, next) => {
        if (!isSaasModeEnabled() || c.req.method === "OPTIONS") {
            await next();
            return;
        }
        const path = c.req.path;
        const isPublic = path.startsWith("/api/v1/auth/") ||
            path === "/api/v1/auth/me";
        if (isPublic) {
            await next();
            return;
        }
        const auth = await resolveSaasSession(root, c);
        if (!auth) {
            return c.json({ error: { code: "AUTH_REQUIRED", message: "请先登录账号。" } }, 401);
        }
        c.set("saasUser", publicUser(auth.user));
        c.set("saasStore", auth.store);
        const premium = findPremiumCost(c.req.method, path);
        if (premium && Number(auth.user.credits ?? 0) < premium.credits) {
            return c.json({
                error: {
                    code: "PAYMENT_REQUIRED",
                    message: `余额不足：${premium.reason} 需要 ${premium.credits} 点，请充值后再试。`,
                },
                credits: Number(auth.user.credits ?? 0),
                requiredCredits: premium.credits,
            }, 402);
        }
        await next();
        if (premium && c.res.status >= 200 && c.res.status < 400) {
            const store = await loadSaasStore(root);
            const user = store.users.find((item) => item.id === auth.user.id);
            if (user) {
                user.credits = Math.max(0, Number(user.credits ?? 0) - premium.credits);
                store.ledger.push({
                    id: newId("ledger"),
                    userId: user.id,
                    type: "debit",
                    credits: -premium.credits,
                    reason: premium.reason,
                    path,
                    createdAt: new Date().toISOString(),
                });
                await saveSaasStore(root, store);
            }
        }
    });
    app.get("/api/v1/auth/me", async (c) => {
        if (!isSaasModeEnabled()) {
            return c.json({ saas: false, authenticated: true, user: null });
        }
        const auth = await resolveSaasSession(root, c);
        return c.json({ saas: true, authenticated: Boolean(auth), user: publicUser(auth?.user) });
    });
    app.post("/api/v1/auth/register", async (c) => {
        if (!isSaasModeEnabled()) {
            return c.json({ error: { code: "SAAS_DISABLED", message: "SaaS mode is not enabled." } }, 400);
        }
        const body = await c.req.json().catch(() => ({}));
        const email = normalizeEmail(body.email);
        const password = String(body.password ?? "");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return c.json({ error: { code: "INVALID_EMAIL", message: "请输入有效邮箱。" } }, 400);
        }
        if (password.length < 8) {
            return c.json({ error: { code: "WEAK_PASSWORD", message: "密码至少 8 位。" } }, 400);
        }
        const store = await loadSaasStore(root);
        if (store.users.some((user) => user.email === email)) {
            return c.json({ error: { code: "EMAIL_EXISTS", message: "该邮箱已经注册。" } }, 409);
        }
        const now = new Date().toISOString();
        const firstUser = store.users.length === 0;
        const tenantId = tenantIdForEmail(email);
        const user = {
            id: newId("user"),
            email,
            passwordHash: hashPassword(password),
            role: firstUser ? "admin" : "user",
            tenantId,
            credits: Number(process.env.HARDWRITE_SIGNUP_CREDITS ?? (firstUser ? 200 : 0)),
            createdAt: now,
        };
        store.users.push(user);
        store.ledger.push({
            id: newId("ledger"),
            userId: user.id,
            type: "credit",
            credits: user.credits,
            reason: firstUser ? "首个管理员初始额度" : "注册初始额度",
            createdAt: now,
        });
        const sid = newId("sess");
        store.sessions.push({ id: sid, userId: user.id, createdAt: now, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
        await ensureTenantWorkspace(root, tenantId);
        await saveSaasStore(root, store);
        setSaasCookie(c, sid);
        return c.json({ ok: true, user: publicUser(user) });
    });
    app.post("/api/v1/auth/login", async (c) => {
        if (rateLimited(clientKey(c, "login"), 10, 60000)) {
            return c.json({ error: { code: "RATE_LIMITED", message: "登录尝试过于频繁,请稍后再试。" } }, 429);
        }
        if (!isSaasModeEnabled()) {
            return c.json({ error: { code: "SAAS_DISABLED", message: "SaaS mode is not enabled." } }, 400);
        }
        const body = await c.req.json().catch(() => ({}));
        const email = normalizeEmail(body.email);
        const password = String(body.password ?? "");
        const store = await loadSaasStore(root);
        const user = store.users.find((item) => item.email === email);
        if (!user || !verifyPassword(password, user.passwordHash)) {
            return c.json({ error: { code: "INVALID_LOGIN", message: "邮箱或密码错误。" } }, 401);
        }
        const sid = newId("sess");
        const now = new Date().toISOString();
        store.sessions = store.sessions.filter((session) => Number(session.expiresAt ?? 0) > Date.now());
        store.sessions.push({ id: sid, userId: user.id, createdAt: now, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
        await saveSaasStore(root, store);
        setSaasCookie(c, sid);
        return c.json({ ok: true, user: publicUser(user) });
    });
    app.post("/api/v1/auth/logout", async (c) => {
        if (isSaasModeEnabled()) {
            const cookies = parseCookies(c.req.header("cookie"));
            const sid = cookies[SAAS_SESSION_COOKIE];
            if (sid) {
                const store = await loadSaasStore(root);
                store.sessions = store.sessions.filter((session) => session.id !== sid);
                await saveSaasStore(root, store);
            }
        }
        clearSaasCookie(c);
        return c.json({ ok: true });
    });
    // ── 激活解锁(桌面 BYOK)─────────────────────────────────────────
    app.get("/api/v1/auth/activation", async (c) => {
        const activation = await loadActivation(root);
        const expired = activation?.expiresAt ? Date.parse(activation.expiresAt) < Date.now() : false;
        return c.json({
            required: activationRequired(),
            configured: activationConfigured(),
            unlocked: Boolean(activation?.unlocked) && !expired,
            expired,
            authorName: activation?.authorName ?? null,
            plan: activation?.plan ?? null,
            codeMasked: activation?.codeMasked ?? null,
            activatedAt: activation?.activatedAt ?? null,
            expiresAt: activation?.expiresAt ?? null,
        });
    });
    app.post("/api/v1/auth/activate", async (c) => {
        if (rateLimited(clientKey(c, "activate"), 10, 60000)) {
            return c.json({ error: { code: "RATE_LIMITED", message: "尝试过于频繁,请稍后再试。" } }, 429);
        }
        const body = await c.req.json().catch(() => ({}));
        const rawCode = String(body.code ?? "");
        const authorName = String(body.authorName ?? "").trim().slice(0, 24);
        const deviceId = String(body.deviceId ?? "").slice(0, 128) || undefined;
        const email = normalizeEmail(body.email);
        const result = await validateActivationCode(rawCode, deviceId);
        if (!result.ok) {
            return c.json({ error: { code: "ACTIVATION_INVALID", message: result.message || "激活码无效。" } }, 403);
        }
        const normalized = normalizeActivationCode(rawCode);
        const now = new Date().toISOString();
        const prev = await loadActivation(root);
        const tier = result.tier ?? activationTierFromCode(normalized, process.env.HARDWRITE_ACTIVATION_SECRET || "");
        const activation = {
            unlocked: true,
            code: normalized,
            codeMasked: maskActivationCode(normalized),
            authorName: authorName || result.authorName || prev?.authorName || "",
            plan: result.plan ?? "offline",
            tier,
            email: email || prev?.email || "",
            deviceId: deviceId ?? prev?.deviceId ?? null,
            activatedAt: prev?.activatedAt ?? now,
            updatedAt: now,
            expiresAt: result.expiresAt ?? null,
        };
        await saveActivation(root, activation);
        return c.json({
            ok: true,
            activation: {
                unlocked: true,
                authorName: activation.authorName,
                plan: activation.plan,
                tier: activation.tier,
                email: activation.email,
                codeMasked: activation.codeMasked,
                activatedAt: activation.activatedAt,
                expiresAt: activation.expiresAt,
            },
        });
    });
    app.post("/api/v1/auth/deactivate", async (c) => {
        const prev = await loadActivation(root);
        await saveActivation(root, {
            unlocked: false,
            authorName: prev?.authorName ?? "",
            deactivatedAt: new Date().toISOString(),
        });
        return c.json({ ok: true });
    });
    // 更新"作者大大"显示名——独立于激活,让用户在设置里随时改,不必重新输激活码。
    // (前端「作者大大」设置项接这个端点;authorName 与激活记录同存 .autow/activation.json。)
    app.put("/api/v1/auth/author-name", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const authorName = String(body.authorName ?? "").trim().slice(0, 24);
        const prev = (await loadActivation(root)) ?? {};
        await saveActivation(root, { ...prev, authorName, updatedAt: new Date().toISOString() });
        return c.json({ ok: true, authorName });
    });
    // 仅在 DEV 模式下提供:本地铸码,方便自测 / 发卡方按同算法离线生成
    app.get("/api/v1/auth/activation/mint", async (c) => {
        // 铸码端点:必须显式开 DEV 且非生产——避免误配把"自助发码"暴露在卖品里。
        if (process.env.HARDWRITE_ACTIVATION_DEV !== "1" || process.env.NODE_ENV === "production") {
            return c.json({ error: { code: "FORBIDDEN", message: "Code minting is disabled." } }, 403);
        }
        const secret = process.env.HARDWRITE_ACTIVATION_SECRET || "";
        const count = Math.min(50, Math.max(1, Number(c.req.query("count") ?? 1) || 1));
        const codes = Array.from({ length: count }, () => randomActivationCode(secret));
        return c.json({ ok: true, plan: secret ? "signed" : "offline", codes });
    });
    // ── 写作引擎 · Step 3 经验库 learnings(@juanshe/engine 接线,LLM-free)──────────
    // GET 取回某「题材::平台」桶的经验 + 库现状;POST 记录一章产出(高分蒸馏手法/低分沉淀反模式)。
    // 加法式:不改现有写作流水线;后续可在 planning 处注入 retrieve 的 prompt 块。
    app.get("/api/v1/engine/learnings", async (c) => {
        const genreId = String(c.req.query("genre") ?? c.req.query("genreId") ?? "general");
        const platformId = String(c.req.query("platform") ?? c.req.query("platformId") ?? "novel");
        const k = Math.min(12, Math.max(1, Number(c.req.query("k") ?? 4) || 4));
        try {
            const [lib, retrieved] = await Promise.all([
                loadLearningLibrary(root),
                retrieveChapterLearnings(root, { genreId, platformId, k }),
            ]);
            const active = lib.learnings.filter((l) => l.status === "active");
            return c.json({
                ok: true,
                bucket: `${genreId}::${platformId}`,
                stats: {
                    total: lib.learnings.length,
                    active: active.length,
                    quarantined: lib.learnings.filter((l) => l.status === "quarantined").length,
                    retired: lib.learnings.filter((l) => l.status === "retired").length,
                    buckets: Object.keys(lib.index).length,
                    updatedAt: lib.updatedAt,
                },
                retrieved: retrieved.patterns.map((p) => ({
                    id: p.learning.id,
                    kind: p.learning.kind,
                    title: p.learning.title,
                    instruction: p.learning.instruction,
                    meanScore: p.learning.stats.meanScore,
                    timesObservedHigh: p.learning.stats.timesObservedHigh,
                    timesApplied: p.learning.stats.timesApplied,
                    reason: p.reason,
                    selectedBy: p.selectedBy,
                })),
                prompt: retrieved.prompt,
            });
        }
        catch (error) {
            console.error("[engine/learnings GET]", error);
            return c.json({ error: { code: "ENGINE_LEARNINGS_FAILED", message: "读取经验库失败。" } }, 500);
        }
    });
    app.post("/api/v1/engine/learnings/record", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const parsed = RecordInput.safeParse(body);
        if (!parsed.success) {
            return c.json({ error: { code: "INVALID_RECORD", message: "记录入参不合法(需 genreId/platformId/bookId/chapterNumber/chapterText/score)。", issues: parsed.error.issues.slice(0, 6) } }, 400);
        }
        try {
            const result = await recordChapterLearning(root, parsed.data);
            return c.json({
                ok: true,
                created: result.created.map((l) => ({ id: l.id, kind: l.kind, title: l.title, instruction: l.instruction })),
                updated: result.updated.map((l) => ({ id: l.id, kind: l.kind, title: l.title, meanScore: l.stats.meanScore })),
                rewarded: result.rewarded.map((l) => l.id),
            });
        }
        catch (error) {
            console.error("[engine/learnings record]", error);
            return c.json({ error: { code: "ENGINE_RECORD_FAILED", message: "记录经验失败。" } }, 500);
        }
    });
    // ── 写作引擎 · Step 4 单章原语(用引擎自有流水线 + BYOK 写一章;runBook 的并发单元)──
    // 加法式新端点,不触碰现有 core 写作流水线。用 studio 已解析的 BYOK 配置驱动引擎 makeHandlers。
    app.post("/api/v1/engine/write-chapter", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        let llmFields;
        try {
            const cfg = await loadCurrentProjectConfig();
            const llm = cfg?.llm ?? {};
            llmFields = {
                provider: llm.provider || llm.service || "openai",
                model: llm.model || llm.defaultModel || "",
                apiKey: llm.apiKey || "",
                baseUrl: llm.baseUrl || "",
            };
        }
        catch (e) {
            return c.json({ error: { code: "LLM_CONFIG_FAILED", message: "读取写作模型配置失败。" } }, 500);
        }
        if (!llmFields.apiKey) {
            return c.json({ error: { code: "LLM_NOT_CONFIGURED", message: "还没配置写作模型:请到「服务设置」填入你的 LLM API Key(BYOK)。" } }, 409);
        }
        const ac = new AbortController();
        // 客户端断开 + 总时长上限(4 分钟)都触发中断:整条流水线是多次强模型调用,挂死后不接中断会一直空烧 BYOK token。
        try { c.req.raw.signal?.addEventListener("abort", () => ac.abort(), { once: true }); }
        catch { /* 某些运行时无 raw.signal,忽略 */ }
        const killer = setTimeout(() => ac.abort(), 240_000);
        try {
            const result = await writeChapterViaEngine({
                llm: llmFields,
                bookId: String(body.bookId || "engine-probe"),
                chapterNumber: Math.max(1, Number(body.chapterNumber || 1) || 1),
                input: {
                    genreId: body.genreId || undefined,
                    platformId: body.platformId || undefined,
                    chapterTitle: body.chapterTitle || undefined,
                    chapterGoal: body.chapterGoal || undefined,
                    priorContext: body.priorContext || undefined,
                    bookBible: body.bookBible || undefined,
                    // 控成本:proof 默认 600 字、上限 1500
                    targetWordCount: Math.min(1500, Math.max(200, Number(body.targetWordCount || 600) || 600)),
                    lang: body.lang === "en" ? "en" : "zh",
                },
                passThreshold: Math.min(100, Math.max(0, Number(body.passThreshold ?? 85) || 85)),
                maxReviseRounds: Math.min(2, Math.max(0, Number(body.maxReviseRounds ?? 1))),
                signal: ac.signal,
                root, // 闭合学习环:写前检索经验注入 planner、写后记录本章
            });
            // 据真实结局判 ok:只有 completed 算成功;halted/aborted/error 让调用方(含 runBook)能区分,
            // 不把未完成/空稿当成功。HTTP 仍 200(请求本身已处理),结局在 body 的 ok/status/reason。
            const ok = result.status === "completed";
            return c.json({ ok, model: llmFields.model, provider: llmFields.provider, ...result });
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (/api key not set|not configured/i.test(msg)) {
                return c.json({ error: { code: "LLM_NOT_CONFIGURED", message: "还没配置写作模型(BYOK)。" } }, 409);
            }
            console.error("[engine/write-chapter]", error);
            return c.json({ error: { code: "ENGINE_WRITE_FAILED", message: `引擎写作失败:${msg.slice(0, 200)}` } }, 500);
        }
        finally {
            clearTimeout(killer);
        }
    });
    // 流式单章:逐字推写作 token(刷刷刷)+ 各阶段进度事件(像"本轮接棒"剧场),解决"全流水线干等无反馈"。
    app.post("/api/v1/engine/write-chapter/stream", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        let llmFields;
        try {
            const cfg = await loadCurrentProjectConfig();
            const llm = cfg?.llm ?? {};
            llmFields = { provider: llm.provider || llm.service || "openai", model: llm.model || llm.defaultModel || "", apiKey: llm.apiKey || "", baseUrl: llm.baseUrl || "" };
        }
        catch {
            return c.json({ error: { code: "LLM_CONFIG_FAILED", message: "读取写作模型配置失败。" } }, 500);
        }
        if (!llmFields.apiKey) {
            return c.json({ error: { code: "LLM_NOT_CONFIGURED", message: "还没配置写作模型(BYOK)。" } }, 409);
        }
        return streamSSE(c, async (stream) => {
            const ac = new AbortController();
            try { c.req.raw.signal?.addEventListener("abort", () => ac.abort(), { once: true }); } catch { /* 忽略 */ }
            try { stream.onAbort?.(() => ac.abort()); } catch { /* 某些运行时无 onAbort */ }
            const killer = setTimeout(() => ac.abort(), 240_000); // 4 分钟墙钟上限:provider 挂死/客户端断开后不再空烧 BYOK token
            const STAGE_LABEL = { planning: "规划", writing: "写作", reviewing: "审稿", revising: "修订", polishing: "润色", verifying: "复核", publishing: "签发" };
            // 立即推一条"开始/规划中",让前端马上有反馈(planning 是结构化调用,本身不流式,约 20-40s)
            await stream.writeSSE({ event: "stage", data: JSON.stringify({ stage: "planning", label: "规划", phase: "start" }) });
            try {
                const result = await writeChapterViaEngine({
                    llm: llmFields,
                    bookId: String(body.bookId || "engine-probe"),
                    chapterNumber: Math.max(1, Number(body.chapterNumber || 1) || 1),
                    input: {
                        genreId: body.genreId || undefined, platformId: body.platformId || undefined,
                        chapterTitle: body.chapterTitle || undefined, chapterGoal: body.chapterGoal || undefined,
                        priorContext: body.priorContext || undefined, bookBible: body.bookBible || undefined,
                        targetWordCount: Math.min(4000, Math.max(300, Number(body.targetWordCount || 1500) || 1500)),
                        lang: body.lang === "en" ? "en" : "zh",
                    },
                    passThreshold: Math.min(100, Math.max(0, Number(body.passThreshold ?? 85) || 85)),
                    maxReviseRounds: Math.min(2, Math.max(0, Number(body.maxReviseRounds ?? 1))),
                    signal: ac.signal,
                    root,
                    onStage: (stage) => { void stream.writeSSE({ event: "stage", data: JSON.stringify({ stage, label: STAGE_LABEL[stage] || stage }) }); },
                    onToken: (delta) => { void stream.writeSSE({ event: "token", data: JSON.stringify({ delta }) }); },
                });
                await stream.writeSSE({
                    event: "done",
                    data: JSON.stringify({ ok: result.status === "completed", status: result.status, reason: result.reason, score: result.score, words: (result.draft || "").length, draft: result.draft }),
                });
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                await stream.writeSSE({ event: "error", data: JSON.stringify({ code: /api key not set|not configured/i.test(msg) ? "LLM_NOT_CONFIGURED" : "ENGINE_WRITE_FAILED", message: msg.slice(0, 200) }) });
            }
            finally {
                clearTimeout(killer);
            }
        });
    });
    // ── 写作引擎 · Step 4 runBook 整本/多本编排(BYOK,加法式,不碰现有 core 写作)──────────
    // plan(架构师出大纲)→ 有界并发扇出写每章 → 轻量 reconcile。慢且烧 token(多次强模型调用),
    // 故默认小章数 + 30 分钟总超时 + 客户端断开即中断。返回逐章结果 + 状态。
    app.post("/api/v1/engine/run-book", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        let llmFields;
        try {
            const cfg = await loadCurrentProjectConfig();
            const llm = cfg?.llm ?? {};
            llmFields = {
                provider: llm.provider || llm.service || "openai",
                model: llm.model || llm.defaultModel || "",
                apiKey: llm.apiKey || "",
                baseUrl: llm.baseUrl || "",
            };
        }
        catch {
            return c.json({ error: { code: "LLM_CONFIG_FAILED", message: "读取写作模型配置失败。" } }, 500);
        }
        if (!llmFields.apiKey) {
            return c.json({ error: { code: "LLM_NOT_CONFIGURED", message: "还没配置写作模型:请到「服务设置」填入你的 LLM API Key(BYOK)。" } }, 409);
        }
        const ac = new AbortController();
        try { c.req.raw.signal?.addEventListener("abort", () => ac.abort(), { once: true }); }
        catch { /* 忽略 */ }
        const killer = setTimeout(() => ac.abort(), 30 * 60 * 1000); // 整本上限 30 分钟
        try {
            const outcome = await runBookViaEngine({
                llm: llmFields,
                brief: {
                    bookId: String(body.bookId || "engine-book"),
                    titleZh: String(body.title || body.titleZh || "未命名作品"),
                    genreId: body.genreId || undefined,
                    platformId: body.platformId || undefined,
                    premise: body.premise || undefined,
                    bookBible: body.bookBible || undefined,
                    // 控成本:默认 3 章、上限 30;单章默认 1500、上限 4000
                    targetChapters: Math.min(30, Math.max(1, Number(body.targetChapters || 3) || 3)),
                    chapterWordCount: Math.min(4000, Math.max(300, Number(body.chapterWordCount || 1500) || 1500)),
                    lang: body.lang === "en" ? "en" : "zh",
                },
                passThreshold: Math.min(100, Math.max(0, Number(body.passThreshold ?? 85) || 85)),
                maxReviseRounds: Math.min(2, Math.max(0, Number(body.maxReviseRounds ?? 1))),
                concurrency: Math.min(8, Math.max(1, Number(body.concurrency || 2) || 2)),
                signal: ac.signal,
                root, // 闭合学习环:整本各章共用回灌、写后逐章记录(经验跨书累积)
            });
            // 精简返回(逐章正文可能很大,默认只回元数据 + 字数;debug=1 才带正文)
            const withDrafts = body.includeDrafts === true || c.req.query("includeDrafts") === "1";
            return c.json({
                ok: outcome.status === "completed",
                bookId: outcome.bookId,
                status: outcome.status,
                reason: outcome.reason,
                reconcilePasses: outcome.reconcilePasses,
                findings: outcome.findings,
                chapters: outcome.results.map((r) => {
                    // 稳健取稿:halted/未到 publishing 时正文在 finalState.artifacts;cleanChapterText 剥引擎分节标记/补丁/内部状态,
                    // 取第一段干净散文(签发→润色→修订→初稿;revising 排在 writing 前,修订稿比初稿更接近成品)。
                    const a = (r.finalState?.artifacts ?? {});
                    const firstClean = (...cands) => { for (const c of cands) { const t = cleanChapterText(c); if (t) return t; } return ""; };
                    const text = firstClean(a.publishing?.chapter?.content, a.polishing?.draft, a.revising?.draft, a.writing?.draft, r.chapter?.content);
                    return {
                        chapterNumber: r.chapterNumber,
                        status: r.status,
                        reason: r.reason,
                        overall: r.overall ?? null,
                        words: text.length,
                        draft: withDrafts && text ? text : undefined,
                    };
                }),
            });
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (/api key not set|not configured/i.test(msg)) {
                return c.json({ error: { code: "LLM_NOT_CONFIGURED", message: "还没配置写作模型(BYOK)。" } }, 409);
            }
            console.error("[engine/run-book]", error);
            return c.json({ error: { code: "ENGINE_RUNBOOK_FAILED", message: `整本编排失败:${msg.slice(0, 200)}` } }, 500);
        }
        finally {
            clearTimeout(killer);
        }
    });
    app.get("/api/v1/billing/me", async (c) => {
        if (!isSaasModeEnabled()) {
            return c.json({ saas: false, credits: null, ledger: [] });
        }
        const auth = await resolveSaasSession(root, c);
        if (!auth) {
            return c.json({ error: { code: "AUTH_REQUIRED", message: "请先登录账号。" } }, 401);
        }
        return c.json({
            saas: true,
            user: publicUser(auth.user),
            ledger: auth.store.ledger.filter((item) => item.userId === auth.user.id).slice(-100).reverse(),
        });
    });
    app.post("/api/v1/billing/topup", async (c) => {
        if (!isSaasModeEnabled()) {
            return c.json({ error: { code: "SAAS_DISABLED", message: "SaaS mode is not enabled." } }, 400);
        }
        const auth = await resolveSaasSession(root, c);
        const adminKey = process.env.HARDWRITE_ADMIN_KEY;
        const headerKey = c.req.header("x-admin-key");
        const canAdmin = auth?.user?.role === "admin" || (adminKey && headerKey === adminKey);
        if (!canAdmin) {
            return c.json({ error: { code: "FORBIDDEN", message: "只有管理员可以充值。" } }, 403);
        }
        const body = await c.req.json().catch(() => ({}));
        const email = normalizeEmail(body.email);
        const credits = Math.max(1, Math.min(1000000, Number(body.credits) || 0));
        const store = await loadSaasStore(root);
        const user = store.users.find((item) => item.email === email);
        if (!user) {
            return c.json({ error: { code: "USER_NOT_FOUND", message: "用户不存在。" } }, 404);
        }
        user.credits = Number(user.credits ?? 0) + credits;
        store.ledger.push({
            id: newId("ledger"),
            userId: user.id,
            type: "credit",
            credits,
            reason: String(body.reason ?? "管理员充值").slice(0, 200),
            createdAt: new Date().toISOString(),
        });
        await saveSaasStore(root, store);
        return c.json({ ok: true, user: publicUser(user) });
    });
    // Structured error handler — ApiError returns typed JSON, others return 500
    app.onError((error, c) => {
        if (error instanceof ApiError) {
            return c.json({ error: { code: error.code, message: error.message } }, error.status);
        }
        const msg = error instanceof Error ? error.message : String(error);
        // 未配 LLM Key(BYOK)是可预期状态,不该报通用 500,要给清晰可执行提示
        if (/api key not set|API key.*not set|未设置.*key|llm.*not configured/i.test(msg)) {
            return c.json({ error: { code: "LLM_NOT_CONFIGURED", message: "还没配置写作模型:请到「服务设置」填入你的 LLM API Key(BYOK),保存后即可开始写作。" } }, 409);
        }
        // 其余未预期错误必须打栈,否则线上 500 无从排查(高频 ops 坑)
        console.error(`[onError] ${c.req.method} ${c.req.path} —`, error);
        return c.json({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error." } }, 500);
    });
    // BookId validation middleware — blocks path traversal on all book routes
    app.use("/api/v1/books/:id/*", async (c, next) => {
        const bookId = c.req.param("id");
        if (!isSafeBookId(bookId)) {
            throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
        }
        await next();
    });
    app.use("/api/v1/books/:id", async (c, next) => {
        const bookId = c.req.param("id");
        if (!isSafeBookId(bookId)) {
            throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
        }
        await next();
    });
    // Logger sink that broadcasts to SSE
    const sseSink = {
        write(entry) {
            broadcast("log", { level: entry.level, tag: entry.tag, message: entry.message });
        },
    };
    // Logger sink that prints to server terminal
    const consoleSink = {
        write(entry) {
            const prefix = `[${entry.tag}]`;
            if (entry.level === "warn")
                console.warn(prefix, entry.message);
            else if (entry.level === "error")
                console.error(prefix, entry.message);
            else
                console.log(prefix, entry.message);
        },
    };
    async function loadCurrentProjectConfig(options) {
        const freshConfig = await loadProjectConfig(root, { ...options, consumer: "studio" });
        const rawProjectConfig = await loadRawConfig(root).catch(() => ({}));
        freshConfig.agentProfiles = normalizeAgentProfiles(rawProjectConfig.agentProfiles ?? freshConfig.agentProfiles ?? {}, rawProjectConfig.modelOverrides ?? freshConfig.modelOverrides ?? {}, freshConfig.llm?.model || freshConfig.llm?.defaultModel || "", freshConfig.llm?.service || "");
        if (freshConfig?.llm?.service === "deepseek" && String(freshConfig.llm.baseUrl || "").replace(/\/+$/, "") === "https://api.deepseek.com") {
            freshConfig.llm.baseUrl = "https://api.deepseek.com/v1";
        }
        await hydrateAgentOverrideRuntimeConfig(root, freshConfig);
        cachedConfig = freshConfig;
        return freshConfig;
    }
    async function resolveModelConnectivityTarget(config, services, secrets, target) {
        const rawLlm = target.llm ?? {};
        const rawServiceId = rawLlm.serviceName || rawLlm.service || config.llm?.service || config.llm?.provider || "";
        let serviceId = normalizeAgentService(rawServiceId, config.llm?.service || config.llm?.provider || "");
        let serviceEntry = services.find((entry) => serviceConfigKey(entry) === serviceId);
        if (serviceId === "custom" && rawLlm.baseUrl) {
            const matchedCustom = services.find((entry) => entry.service === "custom" && entry.baseUrl === rawLlm.baseUrl);
            if (matchedCustom) {
                serviceId = serviceConfigKey(matchedCustom);
                serviceEntry = matchedCustom;
            }
        }
        const baseService = isCustomServiceId(serviceId) ? "custom" : serviceId;
        const preset = resolveServicePreset(baseService);
        const baseUrl = rawLlm.baseUrl || serviceEntry?.baseUrl || await resolveConfiguredServiceBaseUrl(root, serviceId) || preset?.baseUrl || "";
        const model = String(rawLlm.model || rawLlm.defaultModel || config.llm?.model || config.llm?.defaultModel || "").trim();
        const provider = rawLlm.provider || (isCustomServiceId(serviceId) ? "openai" : resolveServiceProviderFamily(baseService)) || config.llm?.provider || "openai";
        const apiKey = rawLlm.apiKey || secrets.services?.[serviceId]?.apiKey || (serviceId === config.llm?.service ? config.llm?.apiKey : "") || "";
        const serviceLabel = serviceEntry?.name || resolveServicePreset(baseService)?.label || target.serviceLabel || serviceId || baseService;
        const apiFormat = rawLlm.apiFormat || serviceEntry?.apiFormat || config.llm?.apiFormat || "chat";
        const stream = rawLlm.stream ?? serviceEntry?.stream ?? config.llm?.stream ?? false;
        const llm = {
            ...config.llm,
            ...rawLlm,
            service: baseService,
            serviceName: serviceId,
            provider,
            baseUrl,
            apiKey,
            model,
            apiFormat,
            stream,
            temperature: Number(rawLlm.temperature ?? target.temperature ?? 0),
            maxTokens: 64,
            thinkingBudget: 0,
        };
        return {
            ...target,
            serviceId,
            baseService,
            serviceLabel,
            baseUrl,
            model,
            provider,
            apiKey,
            apiFormat,
            stream,
            llm,
            probeKey: [serviceId, baseUrl, model, apiFormat, stream ? "stream" : "plain"].join("::"),
        };
    }
    async function probeResolvedModelTarget(target, signal) {
        const startedAt = Date.now();
        const base = publicConnectivityTarget(target);
        if (!target.model) {
            return { ...base, ok: false, latencyMs: 0, error: "未配置模型", suggestion: "先为这个 Agent 选择一个文本模型。" };
        }
        if (!isTextChatModelId(target.model)) {
            return { ...base, ok: false, latencyMs: 0, error: nonTextModelMessage(target.model), suggestion: "写作 Agent 必须使用文本聊天模型。" };
        }
        if (!target.baseUrl) {
            return { ...base, ok: false, latencyMs: 0, error: "未配置 Base URL", suggestion: "先在服务配置里选择或填写这个服务商的 Base URL。" };
        }
        const apiKeyOptional = isApiKeyOptionalForEndpoint({
            provider: target.provider || "openai",
            baseUrl: target.baseUrl,
        });
        if (!target.apiKey && !apiKeyOptional) {
            return { ...base, ok: false, latencyMs: 0, error: "API Key 不能为空", suggestion: "在服务与默认模型里粘贴当前服务商 Key，或确认该 Agent 没有选错服务商。" };
        }
        try {
            const client = createLLMClient(target.llm);
            await chatCompletion(client, target.model, [{ role: "user", content: "模型连通性检测：请只回复 OK。" }], {
                maxTokens: 8,
                temperature: 0,
                timeoutMs: 20_000,
                signal,
            });
            return {
                ...base,
                ok: true,
                latencyMs: Date.now() - startedAt,
                suggestion: "可用于真实写作链路。",
            };
        }
        catch (error) {
            const message = sanitizeConnectivityError(error);
            return {
                ...base,
                ok: false,
                latencyMs: Date.now() - startedAt,
                error: message,
                suggestion: connectivitySuggestion(message),
            };
        }
    }
    async function buildPipelineConfig(overrides) {
        const currentConfig = overrides?.currentConfig ?? await loadCurrentProjectConfig();
        const rawProjectConfig = await loadRawConfig(root).catch(() => ({}));
        let latestPipelineStage = "";
        const scopedSseSink = overrides?.sessionIdForSSE
            ? {
                write(entry) {
                    broadcast("log", {
                        sessionId: overrides.sessionIdForSSE,
                        level: entry.level,
                        tag: entry.tag,
                        message: entry.message,
                    });
                },
            }
            : sseSink;
        const taskRunStageSink = {
            write(entry) {
                if (!overrides?.runIdForSSE)
                    return;
                const message = String(entry.message ?? "");
                const match = message.match(/^阶段(?:\s*\d+[a-z]?)?[：:]\s*(.+)$/i);
                if (!match)
                    return;
                const stageText = match[1].trim();
                if (!stageText)
                    return;
                latestPipelineStage = stageText;
                const agent = resolveAgentForStage(stageText);
                const chapterMatch = stageText.match(/第\s*(\d+)\s*章/);
                const currentChapter = chapterMatch ? Number(chapterMatch[1]) : undefined;
                void updateTaskRun(root, overrides.runIdForSSE, {
                    status: "running",
                    currentAgent: agent,
                    currentStage: stageText,
                    ...(currentChapter ? { currentChapter } : {}),
                }, { kind: "agent:stage", stage: stageText, agent });
            },
        };
        const logger = createLogger({ tag: "studio", sinks: [scopedSseSink, taskRunStageSink, consoleSink] });
        return {
            client: overrides?.client ?? createLLMClient(currentConfig.llm),
            model: overrides?.model ?? currentConfig.llm.model,
            projectRoot: root,
            defaultLLMConfig: currentConfig.llm,
            foundationReviewRetries: currentConfig.foundation?.reviewRetries ?? 2,
            writingReviewRetries: currentConfig.writing?.reviewRetries ?? 3,
            writeIntensity: overrides?.writeIntensity, // 轻中重档位(undefined=max,向后兼容)
            modelOverrides: currentConfig.modelOverrides,
            agentProfiles: rawProjectConfig.agentProfiles ?? {},
            notifyChannels: currentConfig.notify,
            logger,
            onStreamProgress: (progress) => {
                const progressKey = overrides?.runIdForSSE || overrides?.bookIdForSSE || overrides?.sessionIdForSSE || "global";
                const persistProgress = shouldPersistProgress(progressKey, progress.status);
                if (overrides?.bookIdForSSE) {
                    updateBookCreateStatus(overrides.bookIdForSSE, {
                        status: "creating",
                        progress,
                    });
                    if (persistProgress) {
                        void appendBookAgentEvent(root, overrides.bookIdForSSE, "llm:progress", {
                            status: progress.status,
                            elapsedMs: progress.elapsedMs,
                            totalChars: progress.totalChars,
                            chineseChars: progress.chineseChars,
                        });
                    }
                }
                if (overrides?.runIdForSSE && persistProgress) {
                    void updateTaskRun(root, overrides.runIdForSSE, {
                        status: progress.status === "done" ? "model_done" : "running",
                        totalChars: progress.totalChars,
                        chineseChars: progress.chineseChars,
                        elapsedMs: progress.elapsedMs,
                    }, { kind: "llm:progress", stage: progress.status || "streaming", agent: "llm" });
                }
                broadcast("llm:progress", {
                    ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
                    ...(overrides?.bookIdForSSE ? { bookId: overrides.bookIdForSSE } : {}),
                    ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
                    status: progress.status,
                    elapsedMs: progress.elapsedMs,
                    totalChars: progress.totalChars,
                    chineseChars: progress.chineseChars,
                });
            },
            onTextDelta: (text, meta) => {
                const agent = typeof meta?.agent === "string" ? meta.agent : undefined;
                if (overrides?.bookIdForSSE) {
                    appendBookCreatePreview(overrides.bookIdForSSE, text);
                    void appendBookAgentDelta(root, overrides.bookIdForSSE, agent ?? "model", text);
                }
                broadcast("llm:delta", {
                    ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
                    ...(overrides?.bookIdForSSE ? { bookId: overrides.bookIdForSSE } : {}),
                    ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
                    ...(overrides?.chapterForSSE ? { chapter: overrides.chapterForSSE } : {}),
                    ...(agent ? { agent, agentLabel: AGENT_LABELS[agent] ?? agent } : {}),
                    ...(latestPipelineStage ? { stage: latestPipelineStage } : {}),
                    text,
                });
            },
            onPipelineStage: (stage) => {
                latestPipelineStage = stage.label;
                const agent = resolveAgentForStage(stage.label);
                const payload = {
                    ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
                    ...(overrides?.bookIdForSSE ? { bookId: overrides.bookIdForSSE } : {}),
                    ...(overrides?.runIdForSSE ? { runId: overrides.runIdForSSE } : {}),
                    stage: stage.label,
                    agent,
                    agentLabel: AGENT_LABELS[agent] ?? agent,
                    language: stage.language,
                    timestamp: stage.timestamp,
                };
                if (overrides?.runIdForSSE) {
                    void updateTaskRun(root, overrides.runIdForSSE, {
                        status: "running",
                        currentAgent: agent,
                        currentStage: stage.label,
                    }, { kind: "agent:stage", stage: stage.label, agent });
                }
                if (overrides?.bookIdForSSE) {
                    updateBookCreateStatus(overrides.bookIdForSSE, {
                        status: "creating",
                        stage: stage.label,
                        agent,
                        agentLabel: AGENT_LABELS[agent] ?? agent,
                    });
                    void appendBookAgentEvent(root, overrides.bookIdForSSE, "agent:stage", payload);
                }
                broadcast("agent:stage", payload);
                broadcast("tool:update", {
                    ...payload,
                    partialResult: {
                        stage: stage.label,
                        agent,
                        agentLabel: AGENT_LABELS[agent] ?? agent,
                    },
                });
                const legacyEvent = resolveLegacyStageEvent(stage.label);
                if (legacyEvent)
                    broadcast(legacyEvent, payload);
            },
            externalContext: overrides?.externalContext,
            abortSignal: overrides?.abortSignal,
        };
    }
    app.get("/api/v1/studio/ops", async (c) => {
        const requestedBookId = c.req.query("bookId") || "";
        const bookIds = await state.listBooks().catch(() => []);
        const books = (await Promise.all(bookIds.map(async (id) => {
            try {
                return await loadStudioBookListSummary(state, id);
            }
            catch {
                return null;
            }
        }))).filter(Boolean);
        const activeBookId = requestedBookId && bookIds.includes(requestedBookId)
            ? requestedBookId
            : (books.find((book) => book.status === "active")?.id || books[0]?.id || "");
        let activeBook = null;
        if (activeBookId) {
            const [config, chapters, nextChapter, quality] = await Promise.all([
                state.loadBookConfig(activeBookId).catch(() => ({})),
                state.loadChapterIndex(activeBookId).catch(() => []),
                state.getNextChapterNumber(activeBookId).catch(() => 1),
                buildBookQualitySummary(state, activeBookId).catch(() => null),
            ]);
            const summary = books.find((book) => book.id === activeBookId) || config;
            const qualityByChapter = new Map((quality?.chapters || []).map((item) => [String(item.chapterNumber), item]));
            const normalizedChapters = chapters.map((chapter) => {
                const number = Number(chapter.chapterNumber ?? chapter.number ?? 0);
                const payload = qualityByChapter.get(String(number));
                const score = Number(payload?.quality?.total || chapter.score || 0);
                const wordCount = Number(chapter.wordCount ?? chapter.words ?? payload?.quality?.stats?.chineseChars ?? 0);
                return {
                    ...chapter,
                    number,
                    chapterNumber: number,
                    title: chapter.title || `第 ${number} 章`,
                    wordCount,
                    status: score >= 90 ? "published" : (score > 0 ? "ready-for-review" : (chapter.status || "draft")),
                    score,
                    updatedAt: chapter.updatedAt || chapter.createdAt || config.updatedAt || "",
                    quality: payload?.quality || chapter.quality || null,
                };
            });
            const totalWords = normalizedChapters.reduce((sum, chapter) => sum + Number(chapter.wordCount || 0), 0);
            const qualitySummary = {
                ...(quality?.summary || {}),
                maxWords: normalizedChapters.reduce((max, chapter) => Math.max(max, Number(chapter.wordCount || 0)), 0),
            };
            const foundationScore = qualitySummary.average
                ? Math.max(62, Math.min(96, Math.round(Number(qualitySummary.average))))
                : (normalizedChapters.length ? 84 : 72);
            activeBook = {
                ...config,
                ...summary,
                id: activeBookId,
                title: summary?.title || config.title || activeBookId,
                chapters: normalizedChapters,
                chapterCount: normalizedChapters.length,
                chaptersWritten: Math.max(0, Number(nextChapter || normalizedChapters.length + 1) - 1),
                nextChapter,
                totalWords,
                qualitySummary,
                oneLine: summary?.oneLine || summary?.description?.oneLine || config.brief || "",
                foundation: { score: foundationScore },
            };
        }
        const runs = (await loadTaskRuns(root).catch(() => []))
            .filter((run) => !activeBookId || !run.bookId || run.bookId === activeBookId)
            .map(enrichTaskRunForClient)
            .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
        const activeRun = runs.find((run) => ["queued", "running", "repairing"].includes(run.status)) || null;
        const activity = (await readActivityEntries(root, 40).catch(() => [])).map((entry) => ({
            ...entry,
            type: entry.event || entry.type || entry.kind || "activity",
            time: entry.timestamp || entry.time || entry.createdAt || "",
            message: entry.data?.message || entry.data?.stage || entry.data?.error || entry.data?.detail || entry.message || entry.event || "",
        }));
        const vault = await loadVaultSummary(root).catch(() => ({ sections: {} }));
        const sectionLabels = {
            radar: "市场机会",
            books: "作品档案",
            references: "参考素材",
            styles: "风格样本",
            memory: "长期记忆",
            templates: "模板库",
            covers: "封面图",
            ops: "产品运维",
        };
        const assets = Object.entries(vault.sections || {}).flatMap(([section, items]) => (items || []).map((item) => ({
            ...item,
            section,
            sectionLabel: sectionLabels[section] || section,
            status: "done",
        }))).slice(0, 120);
        const flow = AGENT_FLOW.map((agent) => ({
            id: agent.id,
            label: agent.label || AGENT_LABELS[agent.id] || agent.id,
            handoffTo: agent.handoffTo,
            when: agent.when,
        }));
        const taskFlows = Object.fromEntries(Object.entries(AGENT_TASK_FLOWS).map(([id, taskFlow]) => [
            id,
            {
                id,
                label: taskFlow.label,
                description: taskFlow.description,
                agents: taskFlow.agents.map((agentId) => ({ id: agentId, label: AGENT_LABELS[agentId] || agentId })),
            },
        ]));
        const runtimeByAgent = new Map(flow.map((agent) => [agent.id, { ...agent, status: "idle", stage: agent.when || "待命" }]));
        for (const run of runs.slice(0, 12)) {
            const agentId = run.currentAgent || "planner";
            runtimeByAgent.set(agentId, {
                id: agentId,
                label: AGENT_LABELS[agentId] || agentId,
                status: run.status === "done" ? "done" : (run.status === "error" ? "error" : (["queued", "running", "repairing"].includes(run.status) ? "running" : "idle")),
                stage: run.currentStage || run.status || "待命",
                when: run.updatedAt || run.createdAt || "",
            });
        }
        const agentRuntime = Array.from(runtimeByAgent.values());
        const average = Number(activeBook?.qualitySummary?.average || 0);
        const workflowLanes = [
            { title: "故事地基", status: activeBook ? "done" : "idle", agents: ["架构师", "建书复审官"], progress: activeBook ? 100 : 20 },
            { title: "章节生产", status: activeRun ? "running" : "idle", agents: ["规划师", "写手", "字数治理官"], progress: activeRun ? 64 : (activeBook?.chapterCount ? 72 : 15) },
            { title: "质量 Gate", status: activeBook?.qualitySummary?.lowCount ? "warning" : (activeBook ? "done" : "idle"), agents: ["审稿官", "读者评审官", "修稿师"], progress: average || 84 },
            { title: "资产沉淀", status: assets.length ? "done" : "idle", agents: ["章节分析官", "状态校验员", "提示词治理官"], progress: Math.min(100, Math.max(20, assets.length)) },
        ];
        return c.json({
            books,
            activeBook,
            activeRun,
            runs: { recent: runs.slice(0, 20), total: runs.length },
            activity,
            assets,
            flow,
            taskFlows,
            agentRuntime,
            workflowLanes,
            statusTokens: [
                { id: activeRun ? "running" : "idle", label: activeRun ? "运行中" : "待命", meaning: activeRun?.currentStage || "当前没有后端任务占用写作队列", action: activeRun ? "观察流式输出或停止工作流" : "可以继续创作或编辑章节" },
                { id: average >= 85 ? "done" : "warning", label: average >= 85 ? "质量达标" : "质量待复审", meaning: activeBook ? `章节均分 ${average || "--"} / 85 Gate` : "尚未选择作品", action: "低分章节先修复，再继续续写" },
                { id: assets.length ? "done" : "idle", label: "资产索引", meaning: `${assets.length} 个写作库资产已索引`, action: "进入知识资产或发布中心复用" },
            ],
            stats: {
                books: books.length,
                chapters: activeBook?.chapterCount || 0,
                bookWords: activeBook?.totalWords || 0,
                assets: assets.length,
            },
            insights: {
                cards: [
                    { status: "done", title: "正式章节", value: String(activeBook?.chapterCount || 0), detail: "来自 chapters/index.json" },
                    { status: average >= 85 ? "done" : "warning", title: "质量均分", value: average ? String(average) : "--", detail: "85 Gate 自动复修参考" },
                    { status: activeRun ? "running" : "idle", title: "任务队列", value: activeRun ? "运行中" : "空闲", detail: activeRun?.currentStage || "可启动下一章" },
                    { status: assets.length ? "done" : "idle", title: "知识资产", value: String(assets.length), detail: "Obsidian 写作库索引" },
                ],
                radar: {
                    title: "市场雷达",
                    summary: "题材趋势、发布资料和运营资产集中在洞察中心。",
                    signals: assets.filter((item) => item.section === "radar").slice(0, 6),
                },
            },
            systemMetrics: {
                books: books.length,
                chapters: activeBook?.chapterCount || 0,
                runs: runs.length,
                assets: assets.length,
                activity: activity.length,
            },
        });
    });
    // --- Books ---
    app.get("/api/v1/books", async (c) => {
        const bookIds = await state.listBooks();
        const books = await Promise.all(bookIds.map(async (id) => {
            await ensureOpeningPublishingAssets(state, root, id, { rebuildIndex: false }).catch(() => null);
            return loadStudioBookListSummary(state, id);
        }));
        await buildBooksIndex(root, state).catch(() => null);
        return c.json({ books });
    });
    // 固定段路由，必须在 `/api/v1/books/:id` 之前注册，否则会被 :id 通配吃掉。
    // 一次性返回内存里所有当前/最近的建书状态，给前端批量打徽标用：轻量、只读、不改任何状态。
    app.get("/api/v1/books/create-states", async (c) => {
        const runs = await loadTaskRuns(root).catch(() => []);
        const states = [];
        for (const [bookId, status] of bookCreateStatus.entries()) {
            if (!status)
                continue;
            const run = latestCreateBookRunForBook(runs, bookId);
            states.push({
                bookId,
                status: status.status ?? null,
                stage: status.stage ?? null,
                agent: status.agent ?? null,
                agentLabel: status.agentLabel ?? null,
                startedAt: status.startedAt ?? null,
                lastEventAt: status.lastEventAt ?? null,
                live: isLiveBookCreateStatus(status, run),
            });
        }
        return c.json({ states });
    });
	    app.get("/api/v1/books/:id", async (c) => {
	        const id = c.req.param("id");
	        try {
	            const book = await state.loadBookConfig(id);
	            const chapters = await state.loadChapterIndex(id);
	            const nextChapter = await state.getNextChapterNumber(id);
	            const quality = await buildBookQualitySummary(state, id).catch(() => null);
	            const qualityByChapter = new Map((quality?.chapters || []).map((item) => [String(item.chapterNumber), item]));
	            const enrichedChapters = chapters.map((chapter) => {
	                const chapterNumber = Number(chapter.chapterNumber ?? chapter.number ?? 0);
	                const payload = qualityByChapter.get(String(chapterNumber));
	                return payload ? { ...chapter, quality: payload.quality, qualityReport: { ...payload, report: undefined } } : chapter;
	            });
	            return c.json({ book, chapters: enrichedChapters, nextChapter, qualitySummary: quality?.summary ?? null });
	        }
	        catch {
	            return c.json({ error: `Book "${id}" not found` }, 404);
	        }
	    });
	    app.get("/api/v1/books/:id/artifacts", async (c) => {
	        const id = c.req.param("id");
	        const bookDir = state.bookDir(id);
	        const readMaybe = async (relativePath) => {
	            try {
	                return await readFile(join(bookDir, relativePath), "utf-8");
	            }
	            catch {
	                return "";
	            }
	        };
	        const readRoleDir = async (relativeDir) => {
	            try {
	                const dir = join(bookDir, relativeDir);
	                const names = await readdir(dir);
	                const files = await Promise.all(names
	                    .filter((name) => name.endsWith(".md"))
	                    .map(async (name) => `## ${name.replace(/\\.md$/, "")}\n\n${await readFile(join(dir, name), "utf-8")}`));
	                return files.join("\n\n---\n\n");
	            }
	            catch {
	                return "";
	            }
	        };
	        const readRecoveryDraft = async () => {
	            try {
	                const dir = join(bookDir, "story", "recovery");
	                const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
	                if (names.length) {
	                    return await readFile(join(dir, names[names.length - 1]), "utf-8");
	                }
	            }
	            catch { /* no recovery draft yet */ }
	            return await recoverLatestDraftFromActivityLog(root, id);
	        };
	        try {
	            const book = await state.loadBookConfig(id);
	            const [storyFrame, volumeMap, characterMatrix, styleGuide, majorRoles, minorRoles, bookRules, pendingHooks, bookDescription, agentState, agentTimeline, recoveredDraft, agentVault] = await Promise.all([
	                readMaybe("story/outline/story_frame.md"),
	                readMaybe("story/outline/volume_map.md"),
	                readMaybe("story/character_matrix.md"),
	                readMaybe("story/style_guide.md"),
	                readRoleDir("story/roles/主要角色"),
	                readRoleDir("story/roles/次要角色"),
	                readMaybe("story/book_rules.md"),
	                readMaybe("story/pending_hooks.md"),
	                readMaybe("story/book_description.md"),
	                readMaybe("story/agent_state.json"),
	                readMaybe("story/agent_timeline.jsonl"),
	                readRecoveryDraft(),
	                readAgentAssetVault(root, id),
	            ]);
	            const foundationAssessment = await buildFoundationAssessment(state, id).catch(() => null);
	            let latestReport = "";
	            try {
	                const reportDir = join(bookDir, "reports");
	                const reports = (await readdir(reportDir)).filter((name) => name.endsWith("_quality_report.md")).sort();
	                if (reports.length) {
	                    latestReport = await readFile(join(reportDir, reports[reports.length - 1]), "utf-8");
	                }
	            }
	            catch { /* no reports yet */ }
	            return c.json({
	                book,
	                artifacts: {
	                    live: "",
	                    storyFrame,
	                    volumeMap,
	                    characterMatrix,
	                    styleGuide,
	                    outline: [storyFrame, volumeMap].filter(Boolean).join("\n\n---\n\n"),
	                    roles: [characterMatrix, majorRoles, minorRoles].filter(Boolean).join("\n\n---\n\n"),
	                    bookRules,
	                    hooks: pendingHooks,
	                    bookDescription,
	                    foundationAssessment: foundationAssessment?.report || "",
	                    platformSubmission: foundationAssessment?.platformSubmission || buildPlatformSubmissionMarkdown(book, id, bookDescription, characterMatrix),
	                    foundationReady: foundationAssessment?.ready ?? false,
	                    foundationScore: foundationAssessment?.score ?? 0,
	                    foundationModules: foundationAssessment?.modules ?? [],
	                    foundationQualityScore: book?.foundationQuality?.score ?? null,
	                    foundationQualityPass: book?.foundationQuality?.pass ?? null,
	                    foundationWeakDims: book?.foundationQuality?.weakDims ?? [],
	                    foundationQualitySummary: book?.foundationQuality?.summary ?? "",
	                    rules: [bookRules, pendingHooks].filter(Boolean).join("\n\n---\n\n"),
	                    report: [latestReport, agentState, agentTimeline].filter(Boolean).join("\n\n---\n\n"),
	                    stateTimeline: [agentState, agentTimeline, agentVault.timeline].filter(Boolean).join("\n\n---\n\n"),
	                    recoveredDraft,
	                    agentStreams: agentVault.streams,
	                    agentLastStatus: agentVault.lastStatus,
	                },
	            });
	        }
	        catch {
	            return c.json({ error: `Book "${id}" not found` }, 404);
	        }
	    });
    app.post("/api/v1/books/:id/foundation/validate", async (c) => {
        const id = c.req.param("id");
        try {
            const autoRepair = c.req.query("repair") !== "0";
            const withQuality = c.req.query("quality") !== "0";
            const gate = await enforceFoundationQualityGate(state, root, id, { autoRepair, withQuality, loadConfig: loadCurrentProjectConfig });
            const assessment = gate.structural;
            const quality = gate.quality;
            const report = buildFoundationGateReport(assessment, quality, gate.ready, gate.repaired);
            const richAssessment = { ...assessment, report };
            const qualityScore = gate.qualityScore;
            const weak = (quality?.weakDims || []).map((d) => `${d.label}(${d.score})`);
            const book = await state.loadBookConfig(id);
            if (gate.ready) {
                const updated = {
                    ...book,
                    status: book.status === "needs-foundation" ? "active" : book.status,
                    updatedAt: new Date().toISOString(),
                    creationFallback: {
                        ...(book.creationFallback || {}),
                        safeForWriting: true,
                        foundationValidatedAt: new Date().toISOString(),
                        foundationScore: assessment.score,
                        foundationQualityScore: qualityScore,
                    },
                };
                await state.saveBookConfig(id, updated);
                await appendBookAgentEvent(root, id, "foundation:validated", {
                    bookId: id,
                    agent: "foundation-reviewer",
                    agentLabel: "建书复审官",
                    stage: `地基通过：结构 ${assessment.score} · 质量 ${qualityScore ?? "—"} 分，可以写书`,
                    score: assessment.score,
                    qualityScore,
                    repaired: gate.repaired,
                });
                broadcast("foundation:validated", { bookId: id, score: assessment.score, qualityScore, ready: true, repaired: gate.repaired });
                return c.json({ ok: true, ready: true, score: assessment.score, qualityScore, repaired: gate.repaired, assessment: richAssessment, qualityReview: quality, book: updated });
            }
            // 未通过：若是质量未达标，把状态压回 needs-foundation 以拦截写章
            let updated = book;
            if (quality && !quality.pass && book.status && book.status !== "needs-foundation") {
                updated = { ...book, status: "needs-foundation", updatedAt: new Date().toISOString() };
                await state.saveBookConfig(id, updated);
            }
            await appendBookAgentEvent(root, id, "foundation:blocked", {
                bookId: id,
                agent: "foundation-reviewer",
                agentLabel: "建书复审官",
                stage: `地基未通过：结构 ${assessment.score} · 质量 ${qualityScore ?? "—"} 分`,
                score: assessment.score,
                qualityScore,
                repaired: gate.repaired,
                blockers: gate.blockers,
                weakDims: weak,
            });
            broadcast("foundation:blocked", { bookId: id, score: assessment.score, qualityScore, ready: false, repaired: gate.repaired, blockers: gate.blockers, weakDims: weak });
            return c.json({ ok: true, ready: false, score: assessment.score, qualityScore, repaired: gate.repaired, assessment: richAssessment, qualityReview: quality });
        }
        catch (error) {
            return c.json({ ok: false, error: String(error) }, 500);
        }
    });
    app.post("/api/v1/books/:id/description", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const readMaybe = async (base, relativePath) => {
            try {
                return await readFile(join(base, relativePath), "utf-8");
            }
            catch {
                return "";
            }
        };
        try {
            const book = await state.loadBookConfig(id);
            const bookDir = state.bookDir(id);
            const storyDir = join(bookDir, "story");
            const chapters = await state.loadChapterIndex(id).catch(() => []);
            const language = String(body.language || book.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
            const platform = String(body.platform || book.platform || "other");
            const platformContext = book.platformGuidance || buildNovelPlatformPrompt(platform, language);
            const [storyFrameA, storyFrameB, volumeMap, rolesA, rolesB, chapterSummaries, currentFocus, bookRules, pendingHooks, humanNotes] = await Promise.all([
                readMaybe(bookDir, "story/outline/story_frame.md"),
                readMaybe(bookDir, "story/story_frame.md"),
                readMaybe(bookDir, "story/outline/volume_map.md"),
                readMaybe(bookDir, "story/roles/主要角色.md"),
                readMaybe(bookDir, "story/character_matrix.md"),
                readMaybe(bookDir, "story/chapter_summaries.md"),
                readMaybe(bookDir, "story/current_focus.md"),
                readMaybe(bookDir, "story/book_rules.md"),
                readMaybe(bookDir, "story/pending_hooks.md"),
                readMaybe(bookDir, "story/human_notes.md"),
            ]);
            const chapterLine = chapters
                .slice(0, 12)
                .map((chapter) => `- 第 ${chapter.chapterNumber ?? chapter.number ?? "?"} 章：${chapter.title || "未命名"}（${chapter.wordCount || chapter.words || 0} 字）`)
                .join("\n");
            let result = null;
            let engine = "local-fallback";
            if (body.useLLM !== false) {
                try {
                    const currentConfig = await loadCurrentProjectConfig();
                    const llm = resolveAgentRuntimeLLMConfig(currentConfig, ["radar", "writer", "architect"], 0.62);
                    llm.stream = false;
                    const model = String(llm.model || currentConfig.llm.model || currentConfig.llm.defaultModel || "");
                    const client = createLLMClient(llm);
                    const response = await chatCompletion(client, model, [
                    {
                        role: "system",
                        content: language === "en"
                            ? [
                                "You write commercial web-novel book descriptions for novel platform book detail pages.",
                                "Return JSON only. Do not include markdown fences.",
                                "Avoid spoilers for mid/late twists. Sell the premise, protagonist desire, first conflict, genre promise, and serial readability.",
                                "The copy must be publish-ready, specific, and not generic marketing foam.",
                                "JSON shape: {\"oneLine\":\"\",\"shortIntro\":\"\",\"fullIntro\":\"\",\"sellingPoints\":[\"\"],\"tags\":[\"\"],\"platformNotes\":\"\"}.",
                            ].join("\n")
                            : [
                                "你是小说网站书籍详情页简介文案编辑。只输出 JSON，不要 Markdown 代码块。",
                                "目标：生成可直接粘贴到小说网站“书籍介绍/作品简介”的文案。",
                                "硬约束：不剧透中后期关键反转；不写空泛广告词；不要说“本书讲述了”这种套话；必须抓住主角欲望、第一冲突、类型承诺、爽点/情绪钩子和连载可追读性。",
                                "简介要像平台读者会点开的文案，不要像设定资料。中文简介自然、有张力、清晰。",
                                "JSON 结构：{\"oneLine\":\"一句话钩子\",\"shortIntro\":\"80-140字短简介\",\"fullIntro\":\"220-520字正式简介\",\"sellingPoints\":[\"卖点\"],\"tags\":[\"标签\"],\"platformNotes\":\"投放提示\"}。",
                            ].join("\n"),
                    },
                    {
                        role: "user",
                        content: [
                            `书名：${book.title || id}`,
                            `题材：${book.genre || ""}`,
                            `目标平台：${platform}`,
                            `语言：${language}`,
                            "",
                            "【平台要求】",
                            markdownExcerpt(platformContext, 1200),
                            "",
                            "【用户补充要求】",
                            String(body.instruction || "").slice(0, 1200),
                            "",
                            "【故事圣经/核心设定】",
                            markdownExcerpt([storyFrameA, storyFrameB].filter(Boolean).join("\n\n"), 2200),
                            "",
                            "【卷纲/长期结构】",
                            markdownExcerpt(volumeMap, 1400),
                            "",
                            "【角色/人物矩阵】",
                            markdownExcerpt([rolesA, rolesB].filter(Boolean).join("\n\n"), 1400),
                            "",
                            "【章节目录】",
                            chapterLine || "暂无正式章节",
                            "",
                            "【章节摘要】",
                            markdownExcerpt(chapterSummaries, 1800),
                            "",
                            "【当前焦点/规则/伏笔/人工备注】",
                            markdownExcerpt([currentFocus, bookRules, pendingHooks, humanNotes].filter(Boolean).join("\n\n---\n\n"), 1800),
                        ].join("\n"),
                    },
                    ], { temperature: 0.62, maxTokens: 2400 });
                    result = extractJsonObject(response.content);
                    engine = `${llm.serviceName || llm.service || llm.provider || "llm"} / ${model}`;
                }
                catch (error) {
                    engine = `local-fallback (${error instanceof Error ? error.message : String(error)})`;
                }
            }
            if (!result || typeof result !== "object") {
                const title = book.title || id;
                const genre = book.genre || (language === "en" ? "serial novel" : "长篇小说");
                const chapterHint = chapters.slice(0, 3).map((chapter) => chapter.title).filter(Boolean).join("、");
                result = {
                    oneLine: language === "en" ? `${title}: one choice opens a larger storm.` : `《${title}》：一个选择撕开平静生活，也把主角推向更大的风暴。`,
                    shortIntro: language === "en" ? `${title} is a ${genre} built around pressure, secrets, and escalating choices. The protagonist is pushed from an ordinary opening into a conflict where every answer creates a sharper problem.` : `这是一本${genre}。主角从看似平静的开局被推入持续升级的冲突，秘密、选择和代价一层层压上来；每解决一个问题，都会牵出更大的危机。`,
                    fullIntro: language === "en" ? `${title} begins with a clean hook and keeps tightening the pressure around its protagonist. Desire, danger, and hidden truths push the story forward, while each episode leaves a new question waiting. It is written for readers who want clear stakes, steady escalation, and characters whose choices matter.` : `平静只是表面，真正的风暴从第一个无法回头的选择开始。主角被迫面对欲望、秘密和不断逼近的危机，在一次次试探与反击中看清身边的人，也看清自己必须承担的代价。${chapterHint ? `从「${chapterHint}」开始，故事持续把个人命运、关系张力和更大的局面扣在一起。` : "故事会把个人命运、关系张力和更大的局面一步步扣在一起。"}如果你喜欢开局有钩子、冲突不断升级、人物选择会留下后果的长篇连载，这本书可以直接开追。`,
                    sellingPoints: language === "en" ? ["clean premise hook", "steady serial escalation", "choices with consequences"] : ["开局钩子明确", "冲突持续升级", "人物选择有代价", "适合连续追读"],
                    tags: [genre],
                    platformNotes: language === "en" ? "Fallback copy generated without full LLM parsing." : "本地兜底生成，建议再点一次让模型优化。",
                };
            }
            const oneLine = limitText(result.oneLine || "", 300).trim();
            const shortIntro = limitText(result.shortIntro || "", 800).trim();
            const fullIntro = limitText(result.fullIntro || "", 2200).trim();
            const sellingPoints = Array.isArray(result.sellingPoints) ? result.sellingPoints.map((item) => limitText(item, 120).trim()).filter(Boolean).slice(0, 8) : [];
            const tags = Array.isArray(result.tags) ? result.tags.map((item) => limitText(item, 40).trim()).filter(Boolean).slice(0, 12) : [];
            const platformNotes = limitText(result.platformNotes || "", 800).trim();
            const markdown = [
                "# 网站书籍介绍",
                "",
                `- 书名：${book.title || id}`,
                `- 平台：${resolveNovelPlatformProfile(platform, language).label}`,
                `- 语言：${language}`,
                `- 生成时间：${new Date().toISOString()}`,
                `- 模型链路：${engine}`,
                "",
                "## 一句话钩子",
                "",
                oneLine,
                "",
                "## 短简介",
                "",
                shortIntro,
                "",
                "## 正式简介",
                "",
                fullIntro,
                "",
                "## 卖点",
                "",
                sellingPoints.map((item) => `- ${item}`).join("\n") || "- 待补充",
                "",
                "## 标签",
                "",
                tags.join(" / ") || (book.genre || "长篇小说"),
                "",
                "## 平台投放提示",
                "",
                platformNotes,
                "",
            ].join("\n");
            await mkdir(storyDir, { recursive: true });
            await writeFile(join(storyDir, "book_description.md"), markdown, "utf-8");
            await appendActivityLog(root, "book:description", {
                bookId: id,
                agent: "radar",
                agentLabel: "市场雷达",
                stage: "生成网站书籍介绍",
                engine,
                summary: oneLine,
            });
            void appendBookAgentEvent(root, id, "book:description", {
                bookId: id,
                agent: "radar",
                agentLabel: "市场雷达",
                stage: "网站书籍介绍已生成",
                engine,
            });
            return c.json({ ok: true, bookId: id, engine, description: { oneLine, shortIntro, fullIntro, sellingPoints, tags, platformNotes, markdown } });
        }
        catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
    });
    app.get("/api/v1/books/:id/description", async (c) => {
        const id = c.req.param("id");
        try {
            await ensureOpeningPublishingAssets(state, root, id).catch(() => null);
            let missingBook = false;
            let book;
            try {
                book = await state.loadBookConfig(id);
            }
            catch (error) {
                if (!isMissingBookConfigError(error))
                    throw error;
                missingBook = true;
                book = fallbackDescriptionBookShell(id);
            }
            const markdown = missingBook ? "" : await readOptionalText(join(state.bookDir(id), "story", "book_description.md"));
            const description = parseBookDescriptionMarkdown(markdown) || normalizeDescriptionPayload(fallbackBookDescriptionPayload(book, id));
            return c.json({ ok: true, bookId: id, description, ...(missingBook ? { missingBook: true } : {}) });
        }
        catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
    });
    app.put("/api/v1/books/:id/description", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        try {
            const book = await state.loadBookConfig(id);
            const storyDir = join(state.bookDir(id), "story");
            await mkdir(storyDir, { recursive: true });
            const payload = normalizeDescriptionPayload(body.description || body);
            const markdown = String(body.markdown || "").trim()
                ? String(body.markdown).replace(/\r\n/g, "\n").trimEnd() + "\n"
                : formatBookDescriptionMarkdown(book, id, payload, "manual-edit");
            await writeFile(join(storyDir, "book_description.md"), markdown, "utf-8");
            const description = parseBookDescriptionMarkdown(markdown) || payload;
            const updatedBook = {
                ...book,
                brief: description.shortIntro || book.brief || "",
                description: description.fullIntro || book.description || "",
                updatedAt: new Date().toISOString(),
            };
            await state.saveBookConfig(id, updatedBook);
            await buildBooksIndex(root, state).catch(() => null);
            await appendActivityLog(root, "book:description-save", {
                bookId: id,
                agent: "human",
                agentLabel: "人工编辑",
                stage: "保存网站书籍介绍",
                summary: description.oneLine || description.shortIntro || "",
            });
            return c.json({ ok: true, bookId: id, description, book: await loadStudioBookListSummary(state, id) });
        }
        catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
    });
    // --- Genres ---
    app.get("/api/v1/genres", async (c) => {
        const { listAvailableGenres, readGenreProfile } = await import("@juanshe/core");
        const rawGenres = await listAvailableGenres(root);
        const genres = await Promise.all(rawGenres.map(async (g) => {
            try {
                const { profile } = await readGenreProfile(root, g.id);
                return { ...g, language: profile.language ?? "zh" };
            }
            catch {
                return { ...g, language: "zh" };
            }
        }));
        return c.json({ genres });
    });
    app.get("/api/v1/novel-platforms", async (c) => {
        const locale = c.req.query("locale") === "en" ? "en" : "zh";
        return c.json({
            platforms: NOVEL_PLATFORM_PROFILES.map((p) => ({
                id: p.id,
                label: locale === "en" ? p.en : p.zh,
                zh: p.zh,
                en: p.en,
                region: p.region,
                language: p.language,
                guidance: locale === "en" ? p.briefEn : p.briefZh,
            })),
        });
    });
    // --- Book Create ---
    app.post("/api/v1/books/create", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title) {
            return c.json({ error: "Title is required" }, 400);
        }
        body.title = title;
        const now = new Date().toISOString();
        const platformProfile = resolveNovelPlatformProfile(body.platform, body.language);
        const platformPrompt = buildNovelPlatformPrompt(body.platform, body.language);
        const openingAssetInstruction = [
            "【开书资产硬约束】",
            "建书时必须同时产出：非默认卷名、卷纲地图、章节命名策略、前 8-12 个章节名候选、小说网站书籍介绍素材。",
            "卷名必须贴合本书题材和第一阶段冲突，禁止“第一卷：默认 / 未命名 / 待定”。章节名必须指向具体事件、物件、冲突或反转，不能只有“第 X 章”。",
            "网站简介用于小说平台作品详情页：一句话钩子、短简介、正式简介、卖点、标签都要能直接保存编辑。",
        ].join("\n");
        const enrichedBrief = [body.brief, platformPrompt, openingAssetInstruction].filter(Boolean).join("\n\n");
        body.platformProfile = platformProfile;
        body.platformGuidance = platformPrompt;
        const bookConfig = {
            ...buildStudioBookConfig(body, now),
            brief: typeof body.brief === "string" ? body.brief.trim() : "",
            description: typeof body.description === "string" ? body.description.trim() : "",
        };
        const bookId = bookConfig.id;
        if (!bookId) {
            return c.json({ error: "Book title must contain letters, numbers, or Chinese characters" }, 400);
        }
        const bookDir = state.bookDir(bookId);
        if (await pathExists(bookDir)) {
            if (body.resumeExisting === true) {
                try {
                    await access(join(bookDir, "book.json"));
                    await access(join(bookDir, "story", "story_bible.md"));
                    return c.json({ error: `Book "${bookId}" already exists` }, 409);
                }
                catch {
                    // The target book is not fully initialized yet, so creation can continue.
                }
            }
            else {
                const archiveRoot = join(root, ".hardwrite", "archived-books");
                const archivedBookDir = await archivePathIfExists(bookDir, archiveRoot, bookId);
                const revisionsDir = join(root, ".hardwrite", "revisions", bookId);
                const archivedRevisionsDir = await archivePathIfExists(revisionsDir, join(root, ".hardwrite", "archived-revisions"), bookId);
                await appendActivityLog(root, "book:archived-existing-name", {
                    bookId,
                    title,
                    agent: "guardian",
                    agentLabel: "守护进程",
                    stage: "同名新书创建前已归档旧目录，避免旧章节/复修历史污染",
                    archivedBookDir,
                    archivedRevisionsDir,
                });
            }
        }
        const run = await createTaskRun(root, {
            bookId,
            type: "create-book",
            wordCount: Number(body.chapterWordCount) || undefined,
            currentAgent: "architect",
            currentStage: "进入建书队列",
        });
        broadcast("book:creating", { bookId, title: body.title, runId: run.id });
        updateBookCreateStatus(bookId, {
            allowCreate: true,
            status: "creating",
            runId: run.id,
            title: body.title,
            stage: "进入建书队列",
            agent: "architect",
            agentLabel: "架构师",
            startedAt: Date.now(),
            preview: "",
        });
        let pipeline;
        try {
            pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForSSE: bookId, runIdForSSE: run.id }));
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const failureReason = "模型配置不完整";
            updateBookCreateStatus(bookId, {
                allowCreate: true,
                status: "error",
                runId: run.id,
                title: body.title,
                stage: "创建失败",
                agent: "architect",
                agentLabel: "架构师",
                error: message,
                failureReason,
            });
            await updateTaskRun(root, run.id, {
                status: "error",
                completed: 0,
                currentAgent: "architect",
                currentStage: "创建失败",
                error: message,
                failureReason,
            }, { kind: "book:error", agent: "architect", stage: failureReason, error: message });
            broadcast("book:error", { bookId, runId: run.id, error: message, failureReason });
            return c.json({ error: { code: "LLM_CONFIG_ERROR", message } }, 400);
        }
        const tools = createInteractionToolsFromDeps(pipeline, state);
        const referenceFiles = Array.isArray(body.referenceFiles) ? body.referenceFiles : [];
        const referenceTotalChars = referenceFiles.reduce((s, f) => s + (f && typeof f.content === "string" ? f.content.length : 0), 0);
        (async () => {
            // 上传的参考资料先"摘要化"再起稿:大文件不整段塞进架构师 LLM(否则上下文溢出/超时 → 建书崩)。
            // 小文件直接内联,**不碰 LLM/不 loadConfig**(避免给常见小上传路径引入额外阻塞点)。
            let referenceDigest = "";
            if (referenceFiles.length && referenceTotalChars > 0) {
                if (referenceTotalChars <= REFERENCE_INLINE_LIMIT) {
                    referenceDigest = referenceFiles
                        .filter((f) => f && typeof f.content === "string" && f.content.trim())
                        .map((f) => `## 参考资料:${(String(f.name || "参考文件").trim() || "参考文件")}\n${String(f.content).trim()}`)
                        .join("\n\n---\n\n");
                }
                else {
                    updateBookCreateStatus(bookId, { stage: "整理上传的参考资料…", agent: "architect", agentLabel: "架构师" });
                    try {
                        const cfg = await loadCurrentProjectConfig();
                        referenceDigest = await buildReferenceDigest(createLLMClient(cfg.llm), cfg.llm.model, referenceFiles);
                    }
                    catch (e) {
                        void appendActivityLog(root, "book:reference-digest-warn", { bookId, agent: "architect", stage: "参考资料摘要失败,本轮仅用一段话设定起稿", error: e instanceof Error ? e.message : String(e) });
                        referenceDigest = "";
                    }
                }
            }
            const finalBrief = [body.brief, referenceDigest, platformPrompt, openingAssetInstruction].filter(Boolean).join("\n\n");
            return processProjectInteractionRequest({
                projectRoot: root,
                request: {
                    intent: "create_book",
                    title: body.title,
                    genre: body.genre,
                    language: body.language === "en" ? "en" : body.language === "zh" ? "zh" : undefined,
                    platform: body.platform,
                    platformProfile,
                    platformGuidance: platformPrompt,
                    chapterWordCount: body.chapterWordCount,
                    targetChapters: body.targetChapters,
                    worldPremise: finalBrief,
                    blurb: body.brief,
                    authorIntent: finalBrief,
                    currentFocus: finalBrief,
                },
                tools,
            });
        })().then(async (result) => {
            const createdBookId = result.details?.bookId ?? result.session.activeBookId ?? bookId;
            await ensureOpeningPublishingAssets(state, root, createdBookId).catch((error) => {
                void appendActivityLog(root, "book:opening-assets-warn", {
                    bookId: createdBookId,
                    agent: "architect",
                    agentLabel: "架构师",
                    stage: "开书资产自动补齐失败",
                    error: error instanceof Error ? error.message : String(error),
                });
            });
            const book = await loadStudioBookListSummary(state, createdBookId).catch(() => undefined);
            // 把用户上传的完整参考文件存进作品 reference/(架构师只拿到了摘要精华,完整版留档供后续 agent/wiki 取用)。
            if (referenceFiles.length) {
                try {
                    const refDir = join(state.bookDir(createdBookId), "reference");
                    await mkdir(refDir, { recursive: true });
                    for (const f of referenceFiles) {
                        if (!f || typeof f.content !== "string") continue;
                        const safe = String(f.name || "reference.md").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "reference.md";
                        await writeFile(join(refDir, safe), f.content, "utf-8");
                    }
                }
                catch (e) {
                    void appendActivityLog(root, "book:reference-save-warn", { bookId: createdBookId, agent: "architect", stage: "参考文件存档失败", error: e instanceof Error ? e.message : String(e) });
                }
            }
            // 地基质量闸：架构师建完后，让建书复审官真打分（不是数字数）。质量不达标→拦成 needs-foundation，不进入写章。
            try {
                const gate = await enforceFoundationQualityGate(state, root, createdBookId, { autoRepair: true, maxRounds: 1, loadConfig: loadCurrentProjectConfig });
                if (!gate.ready && gate.quality && !gate.quality.pass) {
                    const weak = (gate.quality.weakDims || []).map((d) => `${d.label}(${d.score})`).join("、");
                    const blockedStage = `地基质量未达标：结构 ${gate.structuralScore} · 质量 ${gate.qualityScore} 分`;
                    const blockedReason = `建书复审官判定地基质量不足${weak ? `（最拖分：${weak}）` : (gate.quality.blockers.length ? `（${gate.quality.blockers.join("；")}）` : "")}，已拦截，未进入写章。`;
                    updateBookCreateStatus(createdBookId, {
                        allowCreate: true,
                        status: "needs-foundation",
                        stage: blockedStage,
                        agent: "foundation-reviewer",
                        agentLabel: "建书复审官",
                        failureReason: blockedReason,
                        suggestion: "点『重新验收地基』让建书复审官定向补强最拖分的维度，或手动改设定后重试。",
                        ...(book ? { book } : {}),
                    });
                    await updateTaskRun(root, run.id, {
                        bookId: createdBookId,
                        status: "error",
                        completed: 0,
                        currentAgent: "foundation-reviewer",
                        currentStage: blockedStage,
                        failureReason: blockedReason,
                        suggestion: "点『重新验收地基』让建书复审官定向补强最拖分的维度，或手动改设定后重试。",
                        results: [{ type: "book", bookId: createdBookId, needsFoundation: true, qualityBlocked: true }],
                    }, { kind: "book:needs-foundation", agent: "foundation-reviewer", stage: blockedStage, failureReason: blockedReason });
                    broadcast("book:needs-foundation", { bookId: createdBookId, runId: run.id, ...(book ? { book } : {}), needsFoundation: true, qualityScore: gate.qualityScore, failureReason: blockedReason });
                    return;
                }
            }
            catch { /* 质量闸故障绝不破坏建书主流程，落回 created */ }
            updateBookCreateStatus(createdBookId, {
                allowCreate: true,
                status: "created",
                stage: "作品档案已创建",
                agent: "architect",
                agentLabel: "架构师",
                ...(book ? { book } : {}),
            });
            await updateTaskRun(root, run.id, {
                bookId: createdBookId,
                status: "done",
                completed: 1,
                currentAgent: "architect",
                currentStage: "作品档案已创建",
                results: [{ type: "book", bookId: createdBookId }],
            }, { kind: "book:created", agent: "architect", stage: "作品档案已创建" });
            broadcast("book:created", { bookId: createdBookId, runId: run.id, ...(book ? { book } : {}) });
        }, async (e) => {
            const error = e instanceof Error ? e.message : String(e);
            const failureReason = /missing required sections/i.test(error)
                ? "架构师输出缺少必需段落，系统会自动补段；若仍失败，请缩短输入后重试"
                : /api[_\s-]?key|401|403/i.test(error)
                    ? "模型凭证或服务鉴权失败"
                    : /timeout|aborted|network|fetch/i.test(error)
                        ? "模型服务网络或超时"
                        : "建书流程执行失败";
            try {
                const recovered = await recoverBookCreationLocally(state, root, bookId, bookConfig, run.id, error);
                const blockedStage = "建书未完成，已保存可恢复草稿";
                const blockedReason = `建书模型失败，已保存兜底草稿但不会进入写章：${failureReason}`;
                const blockedSuggestion = "请重试建书、换用更稳定的模型，或删除草稿后重新创建；地基通过前不会生成第一章。";
                await updateTaskRun(root, run.id, {
                    bookId,
                    status: "error",
                    completed: 0,
                    currentAgent: "foundation-reviewer",
                    currentStage: blockedStage,
                    error,
                    failureReason: blockedReason,
                    suggestion: blockedSuggestion,
                    results: [{ type: "book", bookId, fallback: true, needsFoundation: true, partialRecovered: recovered.partialRecovered }],
                }, { kind: "book:needs-foundation", agent: "foundation-reviewer", stage: blockedStage, error, failureReason: blockedReason });
                updateBookCreateStatus(bookId, {
                    allowCreate: true,
                    status: "needs-foundation",
                    stage: blockedStage,
                    agent: "foundation-reviewer",
                    agentLabel: "建书复审官",
                    warning: failureReason,
                    error,
                    failureReason: blockedReason,
                    suggestion: blockedSuggestion,
                    book: recovered.summary,
                });
                broadcast("book:needs-foundation", { bookId, runId: run.id, book: recovered.summary, fallback: true, needsFoundation: true, warning: failureReason, error, failureReason: blockedReason, suggestion: blockedSuggestion });
                return;
            }
            catch (fallbackError) {
                const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                const combined = `${error}\n本地兜底建档也失败：${fallbackMessage}`;
                updateBookCreateStatus(bookId, {
		                    allowCreate: true,
		                    status: "error",
		                    stage: "创建失败",
		                    error: combined,
		                    failureReason,
		                });
		                void updateTaskRun(root, run.id, {
		                    status: "error",
		                    error: combined,
		                    failureReason,
		                    currentAgent: "architect",
		                    currentStage: "创建失败",
		                }, { kind: "book:error", agent: "architect", stage: failureReason, error: combined });
		                broadcast("book:error", { bookId, runId: run.id, error: combined, failureReason });
		                return;
		            }
		        });
        return c.json({ status: "creating", bookId, runId: run.id, run });
    });
    app.get("/api/v1/books/:id/create-status", async (c) => {
        const id = c.req.param("id");
        let status = bookCreateStatus.get(id);
        if (!status) {
            const [runs, persistedBook] = await Promise.all([
                loadTaskRuns(root).catch(() => []),
                state.loadBookConfig(id).catch(() => null),
            ]);
            const run = latestCreateBookRunForBook(runs, id);
            if (!persistedBook && !run) {
                return c.json({ status: "missing" }, 404);
            }
            const bookStatus = String(persistedBook?.status || "").toLowerCase();
            const runStatus = String(run?.status || "").toLowerCase();
            const book = await loadStudioBookListSummary(state, id).catch(() => (persistedBook ? { ...persistedBook, id } : undefined));
            if (bookStatus === "outlining" || bookStatus === "needs-foundation" || createRunNeedsFoundation(run)) {
                status = {
                    status: "needs-foundation",
                    bookId: id,
                    runId: run?.id,
                    title: book?.title || persistedBook?.title || id,
                    stage: run?.currentStage || "建书状态已从磁盘恢复，地基待确认",
                    agent: run?.currentAgent || "foundation-reviewer",
                    agentLabel: "建书复审官",
                    recovered: true,
                    failureReason: run?.failureReason || "服务重启后已从持久化书籍文件恢复状态，但作品地基还没有通过验收。",
                    suggestion: run?.suggestion || "请先补齐/验收大纲、人物、主线和开篇资产，通过后再启动写章。",
                    ...(book ? { book } : {}),
                };
            }
            else if (book) {
                status = {
                    status: "created",
                    bookId: id,
                    runId: run?.id,
                    title: book.title || id,
                    stage: run?.currentStage || "作品档案已从磁盘恢复",
                    agent: run?.currentAgent || "architect",
                    agentLabel: "架构师",
                    recovered: true,
                    book,
                };
            }
            else {
                status = {
                    status: runStatus === "error" || runStatus === "cancelled" ? "error" : "stalled",
                    bookId: id,
                    runId: run?.id,
                    title: id,
                    stage: run?.currentStage || "建书任务记录已恢复，但作品文件未落库",
                    agent: run?.currentAgent || "guardian",
                    agentLabel: "守护进程",
                    recovered: true,
                    error: run?.error || "Create-book run exists but book.json is missing.",
                    failureReason: run?.failureReason || "服务重启后只能找到任务记录，找不到完整作品档案。",
                    suggestion: run?.suggestion || "请重新创建；系统不会把未落库作品当成可写作品。",
                };
            }
        }
        if (status.runId) {
            const run = (await loadTaskRuns(root).catch(() => [])).find((item) => item.id === status.runId);
            if (run && ["error", "cancelled"].includes(String(run.status || "")) && isLiveBookCreateStatus(status, run)) {
                return c.json({
                    ...status,
                    status: "creating",
                    stage: status.stage && !/中断|释放锁|stale/i.test(status.stage)
                        ? status.stage
                        : "建书任务仍在运行",
                    agent: status.agent === "guardian" ? "architect" : status.agent,
                    error: undefined,
                    failureReason: undefined,
                    impact: undefined,
                    suggestion: undefined,
                });
            }
            if (run && ["error", "cancelled"].includes(String(run.status || "")) && status.status !== "needs-foundation" && !createRunNeedsFoundation(run)) {
                return c.json({
                    ...status,
                    status: "error",
                    stage: run.currentStage || status.stage || "创建失败",
                    agent: run.currentAgent || status.agent || "guardian",
                    error: run.error || status.error || "Create-book run stopped before book.json was materialized.",
                    failureReason: run.failureReason || status.failureReason || "建书任务已经停止，地基文件尚未完整落库。",
                    impact: run.impact,
                    suggestion: run.suggestion || status.suggestion || "请重新创建；系统不会把半成品作品当成可写作品。",
                });
            }
        }
        if (status.status === "creating" && status.lastEventAt && Date.now() - status.lastEventAt > BOOK_CREATE_STALL_MS) {
            return c.json({
                ...status,
                status: "stalled",
                failureReason: `超过 ${Math.round(BOOK_CREATE_STALL_MS / 1000)} 秒没有新的模型流式输出或阶段事件`,
                suggestion: "通常是模型流中断、网络卡住或服务端任务被重启。请重试；系统不会把未完成地基当成可写作品。",
            });
        }
        return c.json(status);
    });
    // 取消一本正在建的书：找到该书最新的 create-book run，复用现有 run 取消路径把它标记 cancelled。
    // 绝不动 /api/v1/books/create 主路由的生成逻辑。
    app.post("/api/v1/books/:id/create-cancel", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        const runs = await loadTaskRuns(root).catch(() => []);
        const run = latestCreateBookRunForBook(runs, id);
        const createStatus = bookCreateStatus.get(id);
        const runStatus = String(run?.status || "").toLowerCase();
        const isTerminalRun = ["created", "error", "cancelled", "done"].includes(runStatus);
        const isCreating = String(createStatus?.status || "").toLowerCase() === "creating";
        // run 已是终态，或当前 create-status 非 creating → 没有进行中的建书任务。
        if (!run || isTerminalRun || !isCreating) {
            return c.json({ error: "该书当前没有进行中的建书任务" }, 409);
        }
        const reason = "用户取消建书";
        try {
            // 复用 workflow/stop 的取消路径：标记可见 run 为 cancelled、释放写锁、abort 可中止 job。
            await cancelBookRuns(id, reason);
            updateBookCreateStatus(id, {
                status: "cancelled",
                stage: "已取消建书",
                agent: "architect",
                agentLabel: "架构师",
                failureReason: reason,
            });
            broadcast("book:cancelled", { bookId: id, runId: run.id, agent: "architect", agentLabel: "架构师", stage: "已取消建书" });
            return c.json({ ok: true, status: "cancelled" });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Chapters ---
    app.get("/api/v1/books/:id/chapters", async (c) => {
        const id = c.req.param("id");
        try {
            if (!isSafeBookId(id))
                return c.json({ error: "Invalid book id" }, 400);
            if (!(await bookExists(id)))
                return c.json({ error: `Book "${id}" not found` }, 404);
            const [book, index, qualitySummary] = await Promise.all([
                state.loadBookConfig(id),
                state.loadChapterIndex(id),
                buildBookQualitySummary(state, id).catch(() => null),
            ]);
            const byChapter = new Map((qualitySummary?.chapters || []).map((item) => [Number(item.chapterNumber), item]));
            const safeIndex = Array.isArray(index) ? index : []; // 防 index.json 损坏成非数组直接抛 500
            let chapters = [...safeIndex]
                .sort((a, b) => Number(a.chapterNumber ?? a.number ?? 0) - Number(b.chapterNumber ?? b.number ?? 0))
                .map((meta) => v0ChapterSummary(id, meta, byChapter.get(Number(meta.chapterNumber ?? meta.number)) || null));
            // 兜底:index.json 缺失/截断/损坏(core 非原子写,崩溃可致)但磁盘有 NNNN_*.md → 从磁盘重建,避免整本"消失"。
            if (chapters.length === 0) {
                try {
                    const chaptersDir = join(state.bookDir(id), "chapters");
                    const files = (await readdir(chaptersDir)).filter((f) => /^\d{1,5}[_.].*\.md$/.test(f)).sort();
                    const rebuilt = [];
                    for (const f of files) {
                        const m = f.match(/^(\d{1,5})[_.]?(.*)\.md$/);
                        const num = m ? Number(m[1]) : 0;
                        if (!num) continue;
                        const text = await readFile(join(chaptersDir, f), "utf-8").catch(() => "");
                        if (!text.trim()) continue;
                        const title = (m[2] || "").trim() || `第 ${num} 章`;
                        rebuilt.push(v0ChapterSummary(id, { chapterNumber: num, title, wordCount: countWritingChars(text), status: "ready-for-review", rebuiltFromDisk: true }, byChapter.get(num) || null));
                    }
                    if (rebuilt.length) chapters = rebuilt.sort((a, b) => a.chapterNumber - b.chapterNumber);
                }
                catch { /* 兜底失败 → 保持空,与原行为一致 */ }
            }
            const nextChapter = chapters.length ? Math.max(...chapters.map((chapter) => Number(chapter.chapterNumber || 0))) + 1 : 1;
            return c.json({ bookId: id, book: { ...book, id }, chapters, nextChapter, qualitySummary });
        }
        catch (error) {
            if (error instanceof ApiError)
                return c.json({ error: error.message }, error.status);
            return c.json({ error: String(error) }, 500);
        }
    });
    app.get("/api/v1/books/:id/chapters/:num/manuscript", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            const chapter = await resolveChapterFile(state, id, num);
            const content = await readFile(chapter.fullPath, "utf-8");
            const index = await state.loadChapterIndex(id).catch(() => []);
            const meta = index.find((item) => Number(item.chapterNumber ?? item.number) === num) || {};
            const qualityReport = await buildChapterQualityPayload(state, id, num, content).catch(() => null);
            const words = countWritingChars(content);
            return c.json({
                bookId: id,
                chapterNum: num,
                chapterNumber: num,
                number: num,
                filename: chapter.filename,
                title: meta.title || qualityReport?.title || `第 ${num} 章`,
                content,
                manuscript: content,
                body: content,
                currentWords: words,
                wordCount: words,
                updatedAt: meta.updatedAt || meta.createdAt || "",
                updatedAtMs: toEpochMs(meta.updatedAt || meta.createdAt),
                quality: qualityReport?.quality ?? null,
                qualityReport,
            });
        }
        catch (error) {
            if (error instanceof ApiError)
                return c.json({ error: error.message }, error.status);
            return c.json({ error: "Chapter not found" }, 404);
        }
    });
    app.get("/api/v1/books/:id/chapters/:num/stats", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            const [book, chapter, runs] = await Promise.all([
                state.loadBookConfig(id),
                resolveChapterFile(state, id, num),
                loadTaskRuns(root).catch(() => []),
            ]);
            const content = await readFile(chapter.fullPath, "utf-8");
            const qualityReport = await buildChapterQualityPayload(state, id, num, content).catch(() => null);
            const currentWords = countWritingChars(content);
            const chapterTarget = chapterTargetWords(book, qualityReport);
            const relevantRuns = runs
                .filter((run) => String(run.bookId || "") === id)
                .filter((run) => Number(run.currentChapter || run.chapterNumber || run.results?.[0]?.chapterNumber || 0) === num || ["write-batch", "write-next"].includes(String(run.type || "")))
                .map(enrichTaskRunForClient)
                .sort((a, b) => toEpochMs(b.updatedAt || b.createdAt) - toEpochMs(a.updatedAt || a.createdAt));
            const activeRun = relevantRuns.find((run) => ["queued", "running", "repairing", "needs-repair"].includes(String(run.status || ""))) || relevantRuns[0] || null;
            const elapsedMs = activeRun ? Math.max(0, Date.now() - (toEpochMs(activeRun.startedAt || activeRun.createdAt) || Date.now())) : 0;
            const thisRunWords = Number(activeRun?.results?.find?.((item) => Number(item.chapterNumber) === num)?.wordCount || activeRun?.currentWords || currentWords || 0);
            return c.json({
                bookId: id,
                chapterNum: num,
                currentWords,
                todayMinutes: Math.floor(elapsedMs / 60000),
                todaySeconds: Math.floor((elapsedMs % 60000) / 1000),
                chapterTarget,
                thisRunWords,
                chapterPct: chapterTarget ? Math.max(0, Math.min(100, Math.round((currentWords / chapterTarget) * 100))) : 0,
            });
        }
        catch (error) {
            if (error instanceof ApiError)
                return c.json({ error: error.message }, error.status);
            return c.json({ error: "Chapter not found" }, 404);
        }
    });
    app.get("/api/v1/books/:id/chapters/:num/role-queue", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            if (!isSafeBookId(id))
                return c.json({ error: "Invalid book id" }, 400);
            if (!(await bookExists(id)))
                return c.json({ error: `Book "${id}" not found` }, 404);
            const [chapterStatus, runs] = await Promise.all([
                buildChapterWorkflowStatus(root, state, id, num),
                loadTaskRuns(root).catch(() => []),
            ]);
            return c.json(v0RoleQueueFromStatus(chapterStatus, runs.filter((run) => run.bookId === id).map(enrichTaskRunForClient), num));
        }
        catch (error) {
            if (error instanceof ApiError)
                return c.json({ error: error.message }, error.status);
            return c.json({ error: String(error) }, 500);
        }
    });
    app.get("/api/v1/books/:id/chapters/:num/review-issues", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            const payload = await buildChapterQualityPayload(state, id, num);
            return c.json(reviewIssuesFromQuality(payload, num));
        }
        catch (error) {
            if (error instanceof ApiError)
                return c.json({ error: error.message }, error.status);
            return c.json({ error: "Chapter not found" }, 404);
        }
    });
    app.get("/api/v1/books/:id/chapters/:num/rewrite-proposal", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        const style = String(c.req.query("style") || "tighten");
        try {
            const chapter = await resolveChapterFile(state, id, num);
            const original = await readFile(chapter.fullPath, "utf-8");
            const revision = await latestChapterRevisionText(root, id, num);
            const qualityReport = await buildChapterQualityPayload(state, id, num, original).catch(() => null);
            const styleScore = Number(qualityReport?.quality?.metrics?.style ?? qualityReport?.quality?.styleScore ?? qualityReport?.quality?.total ?? 85);
            const revised = revision?.revised || original;
            return c.json({
                bookId: id,
                chapterNum: num,
                chapterNumber: num,
                style,
                original: bilingual(original),
                revised: bilingual(revised),
                matchScore: Math.max(0, Math.min(1, styleScore > 1 ? styleScore / 100 : styleScore)),
                wordsDelta: countWritingChars(revised) - countWritingChars(original),
                source: revision?.filename || "current-manuscript",
            });
        }
        catch (error) {
            if (error instanceof ApiError)
                return c.json({ error: error.message }, error.status);
            return c.json({ error: "Chapter not found" }, 404);
        }
    });
    app.get("/api/v1/books/:id/chapters/:num", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            const chapter = await resolveChapterFile(state, id, num);
            const content = await readFile(chapter.fullPath, "utf-8");
            const qualityReport = await buildChapterQualityPayload(state, id, num, content).catch(() => null);
            return c.json({ chapterNumber: num, filename: chapter.filename, content, quality: qualityReport?.quality ?? null, qualityReport });
        }
        catch {
            return c.json({ error: "Chapter not found" }, 404);
        }
    });
    app.get("/api/v1/books/:id/chapters/:num/quality", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            const targetWordCount = Number(c.req.query("targetWordCount") ?? c.req.query("wordCount")) || undefined;
            const targetScore = Number(c.req.query("targetScore") ?? c.req.query("targetQuality")) || undefined;
            return c.json(await buildChapterQualityPayload(state, id, num, undefined, { targetWordCount, gateTarget: targetScore }));
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    // —— 总编(Editor-in-Chief)整章编辑裁决 ——
    // 读全部专家信号(机器质量分/门禁、连续性、读者评审、风格、字数、审稿问题、近几章趋势)→ LLM 出
    // 通过/返工 + 总编批语 + 下一程编辑方向。GET 读缓存(不触发 LLM);POST 重新生成(按需,落盘缓存)。
    const editorialReviewPath = (bookId, num) => join(state.bookDir(bookId), "story", "editorial", `ch${num}.json`);
    const readEditorialReviewCache = async (bookId, num) => {
        try { return JSON.parse(await readFile(editorialReviewPath(bookId, num), "utf-8")); }
        catch { return null; }
    };
    const gatherEditorialSignals = async (bookId, num) => {
        const payload = await buildChapterQualityPayload(state, bookId, num);
        const q = payload.quality || {};
        const m = q.metrics || {};
        const reader = q.reader || null;
        const trend = [];
        for (let n = Math.max(1, num - 5); n < num; n++) {
            try {
                const r = await readChapterQualityReportJson(state, bookId, n);
                const rq = r?.quality || r;
                if (rq) trend.push({ chapter: n, score: Number(rq.total) || null, readerVerdict: (rq.reader || {}).verdict || "" });
            } catch { /* 跳过缺失章 */ }
        }
        let excerpt = "";
        let wordCount = 0;
        try {
            const chapter = await resolveChapterFile(state, bookId, num);
            const content = await readFile(chapter.fullPath, "utf-8");
            wordCount = content.replace(/\s/g, "").length;
            excerpt = content.replace(/^#.*$/m, "").trim().slice(0, 600);
        } catch { /* 无正文 */ }
        const book = await state.loadBookConfig(bookId).catch(() => ({}));
        const auditIssues = (Array.isArray(payload.auditIssues) ? payload.auditIssues : []).map((it) => ({
            severity: it?.severity || "info",
            category: it?.category || "",
            message: typeof it?.message === "string" ? it.message : (it?.message?.zh || it?.message?.en || ""),
        }));
        const gatePass = Boolean(q.gate?.pass);
        const aiTone = Number.isFinite(Number(m.aiTone)) ? Number(m.aiTone) : null;
        return {
            gatePass,
            aiTone,
            payload,
            signals: {
                bookTitle: book.title || bookId,
                chapterNumber: num,
                chapterTitle: payload.title || `第 ${num} 章`,
                totalScore: Number.isFinite(Number(q.total)) ? Number(q.total) : null,
                gateTarget: Number(q.gate?.target) || 85,
                gatePass,
                metrics: { continuity: m.continuity ?? null, style: m.style ?? null, length: m.length ?? null, structure: m.structure ?? null },
                reader: reader ? { total: reader.total ?? null, verdict: reader.verdict || "", metrics: reader.metrics || {} } : null,
                auditIssues,
                wordCount,
                targetWordCount: Number(book.chapterWordCount || book.targetChapterWords || book.wordCount || 3000),
                recentTrend: trend,
                excerpt,
                aiTone,
                aiToneFloor: DEFAULT_AI_TONE_FLOOR,
            },
        };
    };
    // 复用:汇总信号 → 挂载总编 skill → LLM 裁决 → 落盘缓存。POST 端点与批量写作每章自动签发共用。
    const generateEditorialReviewFor = async (bookId, num) => {
        const { signals, gatePass, aiTone } = await gatherEditorialSignals(bookId, num);
        const config = await loadCurrentProjectConfig();
        const client = createLLMClient(config.llm);
        // 挂载总编 skill(skills/editorial/editor-in-chief.md):把签发标准/失败模式/信号权衡/派工逻辑注入系统提示词。
        const editorSkill = await mountSkills(SKILLS_DIR, ["editorial/editor-in-chief"]).catch(() => "");
        // 总编系统提示词:默认用内置常量;若用户在「编辑部成员中心」(/agents)改过并保存(raw.agentProfiles),
        // 用其覆盖版。任何读取失败或覆盖过短 → 安全回落内置常量,签发门禁逻辑不受影响。
        let editorBasePrompt = EDITOR_IN_CHIEF_SYSTEM_PROMPT;
        try {
            const eicProfile = (await loadRawConfig(root))?.agentProfiles?.["editor-in-chief"];
            const override = (eicProfile?.systemPrompt ?? eicProfile?.promptPatch ?? "").toString().trim();
            if (override.length > 120) editorBasePrompt = override;
        } catch { /* 读配置失败 → 回落内置提示词 */ }
        const systemPrompt = editorSkill
            ? `${editorBasePrompt}\n\n# 总编技能(签发标准与判断力)\n${editorSkill}`
            : editorBasePrompt;
        const response = await chatCompletion(client, config.llm.model, [
            { role: "system", content: systemPrompt },
            { role: "user", content: buildEditorInChiefUserMessage(signals) },
        ], { temperature: 0.4, maxTokens: 4000 }); // 给推理模型(如 mimo)留够"思考 + JSON 答案"的空间
        // AI 味签发硬门禁:人味低于红线 → parseEditorialVerdict 内强制 rework + 派 polisher 去 AI 味,
        // 即使 LLM 总编判 pass / 总分够也不放行(与 polisher 自动追加润色同阈值 DEFAULT_AI_TONE_FLOOR)。
        const verdict = parseEditorialVerdict(extractJsonObject(response.content), { gatePass, aiTone, aiToneFloor: DEFAULT_AI_TONE_FLOOR });
        if (!verdict)
            return null;
        const review = {
            ...verdict,
            chapterNumber: num,
            machineTotal: signals.totalScore,
            gateTarget: signals.gateTarget,
            gatePass,
            model: config.llm.model,
            skill: editorSkill ? "editorial/editor-in-chief" : null,
            generatedAt: new Date().toISOString(),
        };
        await mkdir(join(state.bookDir(bookId), "story", "editorial"), { recursive: true }).catch(() => { });
        await writeFile(editorialReviewPath(bookId, num), JSON.stringify(review, null, 2), "utf-8").catch(() => { });
        return review;
    };
    // 卷级记忆压缩(防长程漂移):把"已完成卷"的逐章摘要 LLM 压成 ≤500 字卷摘要 → volume_summaries.md,
    // 并把已归档卷的逐章明细移出 chapter_summaries.md(转 summaries_archive/)。批量写作收尾调用(无并发,无竞态)。
    const consolidateBookMemory = async (bookId, runId) => {
        const cfg = await loadCurrentProjectConfig();
        const consolidator = new ConsolidatorAgent({ client: createLLMClient(cfg.llm), model: cfg.llm.model, projectRoot: root });
        const result = await consolidator.consolidate(state.bookDir(bookId));
        if (result.archivedVolumes > 0) {
            const payload = { bookId, runId, agent: "consolidator", agentLabel: "记忆归并官", archivedVolumes: result.archivedVolumes, retainedChapters: result.retainedChapters, stage: `已把 ${result.archivedVolumes} 个完成卷压成卷级摘要(防长程漂移),保留最近 ${result.retainedChapters} 章逐章明细` };
            void appendBookAgentEvent(root, bookId, "memory:consolidated", payload);
            broadcast("memory:consolidated", payload);
        }
        return result;
    };
    app.get("/api/v1/books/:id/chapters/:num/editorial-review", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            const cached = await readEditorialReviewCache(id, num);
            return c.json({ bookId: id, chapterNumber: num, review: cached, cached: Boolean(cached) });
        }
        catch (error) {
            return c.json({ error: String(error) }, 500);
        }
    });
    app.post("/api/v1/books/:id/chapters/:num/editorial-review", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            const review = await generateEditorialReviewFor(id, num);
            if (!review)
                return c.json({ error: "总编未给出有效裁决(模型输出无法解析),请重试。" }, 502);
            return c.json({ bookId: id, chapterNumber: num, review, cached: false });
        }
        catch (error) {
            if (error instanceof ApiError)
                return c.json({ error: error.message }, error.status);
            return c.json({ error: String(error) }, 500);
        }
    });
    // —— 每章交接(handoff)透明面板 ——
    // 一次性返回:本章每个 agent 做了什么 + 产出信号(审稿/读者/Gate/总编)+ 读了什么(有界注入证据)
    // + 是否回写传给下一章。纯读不触发 LLM;同时落盘 story/handoffs/chN.md 作为人类可读单页交接。
    app.get("/api/v1/books/:id/chapters/:num/handoff", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            if (!isSafeBookId(id))
                return c.json({ error: "Invalid book id" }, 400);
            if (!(await bookExists(id)))
                return c.json({ error: `Book "${id}" not found` }, 404);
            return c.json(await buildChapterHandoff(state, root, id, num));
        }
        catch (error) {
            if (error instanceof ApiError)
                return c.json({ error: error.message }, error.status);
            return c.json({ error: String(error) }, 500);
        }
    });
    // —— 本章修订快照(diff 用)——
    // 每次质量修复/改写/润色都把"原文摘录 + 修复后 + 修改说明"存进 revisions/。
    // 这里解析出每一轮的 before/after,供前端做"红删/绿增"对比。
    app.get("/api/v1/books/:id/chapters/:num/revisions", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!Number.isInteger(num) || num <= 0)
            return c.json({ error: "Invalid chapter number" }, 400);
        const revisionsDir = join(root, ".hardwrite", "revisions", id);
        const prefix = `chapter-${String(num).padStart(4, "0")}-`;
        const passes = [];
        try {
            const entries = await readdir(revisionsDir, { withFileTypes: true });
            const files = entries
                .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".md"))
                .map((entry) => entry.name)
                .sort();
            for (const filename of files) {
                const raw = await readFile(join(revisionsDir, filename), "utf-8").catch(() => "");
                if (!raw)
                    continue;
                const snap = parseRevisionSnapshot(raw, filename);
                if (snap.before || snap.after)
                    passes.push(snap);
            }
        }
        catch {
            // 没有 revisions 目录 = 本章从未被修订过
        }
        // 写手原稿 → 定稿:原稿存在 story/recovery(每次写章自动落盘),定稿是当前章节文件。
        // 这给出最关键的"写手写了啥 vs 流水线改完"对比,放在最前面。
        try {
            const bookDir = state.bookDir(id);
            const padded = String(num).padStart(4, "0");
            const draftRaw = await readFile(join(bookDir, "story", "recovery", `chapter-${padded}.writer-draft.md`), "utf-8").catch(() => "");
            if (draftRaw) {
                const draftBody = draftRaw.replace(/^[\s\S]*?\n#\s+[^\n]*\n+/, "").trim();
                const chaptersDir = join(bookDir, "chapters");
                const chFiles = (await readdir(chaptersDir).catch(() => []))
                    .filter((f) => f.startsWith(`${padded}_`) && f.endsWith(".md"));
                let finalBody = "";
                if (chFiles[0]) {
                    const chRaw = await readFile(join(chaptersDir, chFiles[0]), "utf-8").catch(() => "");
                    finalBody = chRaw.replace(/^#\s+[^\n]*\n+/, "").trim();
                }
                if (draftBody && finalBody && draftBody !== finalBody) {
                    passes.unshift({ kind: "draft", kindLabel: "写手原稿 → 定稿", timestamp: "", before: draftBody, after: finalBody, notes: "", filename: "writer-draft" });
                }
            }
        }
        catch {
            // 没有原稿/定稿 = 无法做原稿对比,只用修订快照
        }
        return c.json({ bookId: id, chapterNumber: num, passes });
    });
    // —— 活的故事知识图谱(前后端互联)——
    // 暴露 memory.db 里增量构建、自纠错的实体+时序关系图,供前端交互式关系图 + 实体详情页消费。
    // SQLite 不可用(老 Node)时返回 unavailable:true 空图,前端可回退到旧的 relationship-graph。
    app.get("/api/v1/books/:id/story-graph", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        try {
            const db = new MemoryDB(state.bookDir(id));
            try {
                const entities = db.listEntities();
                const cards = entities.map((e) => db.getEntityCard(e.id));
                const nodes = entities.map((e, i) => ({
                    id: e.id,
                    name: e.name,
                    type: e.type,
                    summary: e.summary,
                    aliases: String(e.aliases || "").split(",").map((a) => a.trim()).filter(Boolean),
                    firstChapter: e.firstChapter,
                    lastChapter: e.lastChapter,
                    degree: cards[i]?.relations.length ?? 0,
                    state: (cards[i]?.state ?? []).slice(0, 8).map((s) => ({ predicate: s.predicate, object: s.object })),
                }));
                const edgeMap = new Map();
                for (const e of entities) {
                    for (const r of db.getRelationsTouching(e.id)) {
                        if (!r.objectIsEntity || r.subjectId !== e.id)
                            continue; // 只记出边,避免重复
                        const key = `${r.subjectId}|${r.predicate}|${r.object}`;
                        if (!edgeMap.has(key))
                            edgeMap.set(key, { source: r.subjectId, target: r.object, predicate: r.predicate, sinceChapter: r.validFromChapter });
                    }
                }
                if (nodes.length > 0) {
                    return c.json({ bookId: id, stats: db.graphStats(), nodes, edges: [...edgeMap.values()] });
                }
            }
            finally {
                db.close();
            }
            const fallback = await buildStoryGraphFallback(state, root, id);
            return c.json(fallback);
        }
        catch {
            const fallback = await buildStoryGraphFallback(state, root, id).catch(() => null);
            if (fallback?.nodes?.length)
                return c.json({ ...fallback, unavailable: true });
            return c.json({ bookId: id, stats: { entities: 0, relations: 0, activeRelations: 0 }, nodes: [], edges: [], unavailable: true });
        }
    });
    app.get("/api/v1/books/:id/story-graph/entity/:name", async (c) => {
        const id = c.req.param("id");
        const name = decodeURIComponent(c.req.param("name"));
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        try {
            const db = new MemoryDB(state.bookDir(id));
            try {
                const card = db.getEntityCard(name);
                if (!card) {
                    const fallback = await buildStoryGraphFallback(state, root, id).catch(() => null);
                    const payload = fallback ? storyGraphEntityPayloadFromFallback(id, fallback, name) : null;
                    if (payload)
                        return c.json(payload);
                    return c.json({ error: "Entity not found" }, 404);
                }
                const resolveName = (entId) => db.getEntity(entId)?.name || entId;
                return c.json({
                    bookId: id,
                    entity: card.entity,
                    state: card.state.map((s) => ({ predicate: s.predicate, object: s.object, sinceChapter: s.validFromChapter })),
                    relations: card.relations.map((r) => ({
                        predicate: r.predicate,
                        subject: resolveName(r.subjectId),
                        object: r.objectIsEntity ? resolveName(r.object) : r.object,
                        objectIsEntity: r.objectIsEntity,
                        sinceChapter: r.validFromChapter,
                        incoming: r.subjectId !== card.entity.id,
                    })),
                    neighbors: card.neighbors.map((n) => ({ id: n.id, name: n.name, type: n.type, summary: n.summary })),
                });
            }
            finally {
                db.close();
            }
        }
        catch (error) {
            const fallback = await buildStoryGraphFallback(state, root, id).catch(() => null);
            const payload = fallback ? storyGraphEntityPayloadFromFallback(id, fallback, name) : null;
            if (payload)
                return c.json({ ...payload, unavailable: true });
            return c.json({ error: String(error) }, 500);
        }
    });
    app.get("/api/v1/books/:id/quality", async (c) => {
        const id = c.req.param("id");
        try {
            return c.json(await buildBookQualitySummary(state, id));
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    app.get("/api/v1/books/:id/manuscript", async (c) => {
        const id = c.req.param("id");
        try {
            return c.json(await buildBookManuscript(state, root, id));
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    app.get("/api/v1/books/:id/cover", async (c) => {
        const id = c.req.param("id");
        try {
            const coverPath = await findBookCoverPath(state, id);
            if (!coverPath)
                return c.text("cover not found", 404);
            c.header("Content-Type", imageMimeType(coverPath));
            c.header("Cache-Control", "no-cache");
            return c.body(await readFile(coverPath));
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    app.get("/api/v1/books/:id/wiki", async (c) => {
        const id = c.req.param("id");
        try {
            return c.json(await buildBookWiki(state, root, id));
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    app.get("/api/v1/books/:id/knowledge", async (c) => {
        const id = c.req.param("id");
        try {
            const [wiki, memory, relationshipGraph, world, cast, styleFingerprint] = await Promise.all([
                buildBookWiki(state, root, id),
                buildV0Memory(state, root, id, ""),
                buildV0RelationshipGraph(state, root, id, c.req.query("focusId") || ""),
                buildV0World(state, root, id),
                buildV0Cast(state, root, id),
                buildV0StyleFingerprint(state, root, id),
            ]);
            return c.json({
                bookId: id,
                book: wiki.book,
                stats: wiki.stats,
                nodes: wiki.nodes,
                edges: wiki.edges,
                relationshipEdges: wiki.relationshipEdges,
                memoryLayers: wiki.memoryLayers,
                memories: Array.isArray(memory) ? memory : memory?.items ?? memory,
                relationshipGraph,
                world,
                cast,
                styleFingerprint,
                wikiMarkdown: wiki.wikiMarkdown,
                source: ["wiki", "memory", "relationship-graph", "world", "cast", "style-fingerprint"],
                generatedAt: new Date().toISOString(),
            });
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    const v0BookJson = async (c, builder) => {
        const id = c.req.param("id");
        try {
            return c.json(await builder(id, c));
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    };
    app.get("/api/v1/books/:id/assets", (c) => v0BookJson(c, (id) => buildV0Assets(state, root, id)));
    app.get("/api/v1/books/:id/cast", (c) => v0BookJson(c, (id) => buildV0Cast(state, root, id)));
    // 真结构化角色数据(解析真相文件,供新前端"角色与设定"页)
    app.get("/api/v1/books/:id/characters", (c) => v0BookJson(c, (id) => buildBookCharacters(state, root, id)));
    // 真结构化大纲/故事走向(供新前端"大纲与规划"页)+ 情感弧/张力
    app.get("/api/v1/books/:id/outline-full", (c) => v0BookJson(c, (id) => buildBookOutlineFull(state, root, id)));
    app.get("/api/v1/books/:id/arcs", (c) => v0BookJson(c, (id) => buildBookArcs(state, root, id)));
    // 伏笔池 + 埋设/回收时间线(供"知识与资产"伏笔视图)
    app.get("/api/v1/books/:id/hooks", (c) => v0BookJson(c, (id) => buildBookHooks(state, root, id)));
    // 记忆长卷(章节时间线 + 角色出场泳道 + 伏笔埋收 + 记忆锚)
    app.get("/api/v1/books/:id/memory-scroll", (c) => v0BookJson(c, (id) => buildBookMemoryScroll(state, root, id)));
    // 知识统计条(角色/伏笔/世界观/记忆/焦点/风格 计数)
    app.get("/api/v1/books/:id/knowledge-overview", (c) => v0BookJson(c, (id) => buildBookKnowledgeOverview(state, root, id)));
    // 世界观(世界铁律 + 主题/冲突/底色/终局 + 关键物),供角色页设定库 / 知识页世界观
    app.get("/api/v1/books/:id/world-full", (c) => v0BookJson(c, (id) => buildBookWorld(state, root, id)));
    app.get("/api/v1/books/:id/world", (c) => v0BookJson(c, (id) => buildV0World(state, root, id)));
    app.get("/api/v1/books/:id/outline", (c) => v0BookJson(c, (id) => buildV0Outline(state, id)));
    app.get("/api/v1/books/:id/plot-progress", (c) => v0BookJson(c, (id) => buildV0PlotProgress(state, id)));
    app.get("/api/v1/books/:id/memory", (c) => v0BookJson(c, (id, ctx) => buildV0Memory(state, root, id, ctx.req.query("kind") || "")));
    app.get("/api/v1/books/:id/style-fingerprint", (c) => v0BookJson(c, (id) => buildV0StyleFingerprint(state, root, id)));
    app.get("/api/v1/books/:id/publish-channels", (c) => v0BookJson(c, (id) => buildV0PublishChannels(state, id)));
    app.get("/api/v1/books/:id/relationship-graph", (c) => v0BookJson(c, (id, ctx) => buildV0RelationshipGraph(state, root, id, ctx.req.query("focusId") || "")));
    app.post("/api/v1/books/:id/wiki/nodes", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        try {
            const saved = await saveBookWikiNode(state, id, body);
            broadcast("book:wiki-node", { bookId: id, ...saved });
            return c.json(saved);
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    app.post("/api/v1/books/:id/wiki/style-preset", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const preset = STYLE_FINGERPRINT_PRESETS.find((item) => item.id === String(body.presetId || ""));
        if (!preset) {
            return c.json({ error: "Unknown style preset" }, 404);
        }
        try {
            const saved = await saveBookWikiNode(state, id, {
                title: preset.title,
                type: "style",
                chapter: "全书风格约束",
                body: stylePresetMarkdown(preset),
            });
            broadcast("book:style-preset", { bookId: id, presetId: preset.id, ...saved });
            return c.json({ ...saved, preset });
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    app.post("/api/v1/books/:id/notes", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const note = String(body.note ?? "").trim();
        const scope = String(body.scope ?? "全书").trim().slice(0, 80) || "全书";
        if (!isSafeBookId(id)) {
            return c.json({ error: "Invalid book id" }, 400);
        }
        if (!note) {
            return c.json({ error: "note is required" }, 400);
        }
        try {
            const storyDir = join(state.bookDir(id), "story");
            await mkdir(storyDir, { recursive: true });
            const entry = [
                `## ${new Date().toISOString()} · ${scope}`,
                "",
                note,
                "",
            ].join("\n");
            await appendFile(join(storyDir, "human_notes.md"), entry, "utf-8");
            await appendFile(join(storyDir, "current_focus.md"), [
                "",
                `## 人工后续意见 · ${scope}`,
                "",
                note,
                "",
            ].join("\n"), "utf-8");
            await appendActivityLog(root, "book:human-note", { bookId: id, scope, chars: note.length });
            return c.json({ ok: true, bookId: id, scope, chars: note.length });
        }
        catch (error) {
            return c.json({ error: String(error) }, 500);
        }
    });
    // --- Chapter Save ---
    app.put("/api/v1/books/:id/chapters/:num", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        const { content } = await c.req.json();
        try {
            const chapter = await resolveChapterFile(state, id, num);
            const safeContent = assertCleanChapterText(content, "章节保存内容");
            await atomicWriteFile(chapter.fullPath, safeContent);
            const chapters = await state.loadChapterIndex(id).catch(() => []);
            const current = chapters.find((entry) => Number(entry.chapterNumber ?? entry.number) === num);
            if (current) {
                current.wordCount = countWritingChars(safeContent);
                current.updatedAt = new Date().toISOString();
                await state.saveChapterIndex(id, chapters);
            }
            await buildBooksIndex(root, state).catch(() => null);
            const quality = await buildChapterQualityPayload(state, id, num, safeContent).catch(() => null);
            return c.json({ ok: true, chapterNumber: num, quality });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    app.post("/api/v1/books/:id/chapters/:num/enhance", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        const body = await c.req.json().catch(() => ({}));
        const apply = body.apply !== false;
        const instruction = String(body.instruction ?? "增强本章：补足画面、节奏、对白自然度、人物心理和去 AI 腔；不改事实、视角、时间线。").slice(0, 1200);
        try {
            const chapter = await resolveChapterFile(state, id, num);
            const latest = await readFile(chapter.fullPath, "utf-8");
            if (!normalizeMarkdownText(latest)) {
                return c.json({ error: "chapter is empty" }, 400);
            }
            const qualityBefore = await buildChapterQualityPayload(state, id, num, latest).catch(() => null);
            let revised = latest;
            let changes = [];
            let warnings = [];
            let engine = "local-heuristic";
            if (body.useLLM !== false) {
                try {
                    const currentConfig = await loadCurrentProjectConfig();
                    const client = createLLMClient(currentConfig.llm);
                    const response = await chatCompletion(client, currentConfig.llm.model, [
                        {
                            role: "system",
                            content: [
                                "你是长篇小说整章增强编辑。只输出 JSON，不要 Markdown。",
                                "硬约束：保留事实、视角、时间线、人物知识边界、章节标题和已发生事件；不要新增会改变后续大纲的重大剧情。",
                                "目标：增强画面、节奏、对白自然度、人物心理暗流、伏笔清晰度和去 AI 腔；允许补细节、调句序、删空泛句。",
                                "如果章节处于 state-degraded，只做语言和局部连贯增强，并在 warnings 说明状态链仍需自愈。",
                                "JSON 结构：{\"revised\":\"增强后的整章正文\",\"changes\":[{\"before\":\"问题/位置\",\"after\":\"处理方式\",\"reason\":\"原因\"}],\"warnings\":[\"风险或后续建议\"]}。",
                                "changes 最多 12 条，原因要具体；revised 必须是完整章节正文，不要只返回建议。",
                            ].join("\n"),
                        },
                        {
                            role: "user",
                            content: [
                                `增强指令：${instruction}`,
                                "",
                                "【当前章节质量】",
                                JSON.stringify(qualityBefore?.quality ?? {}, null, 2),
                                "",
                                "【当前章节全文】",
                                latest,
                            ].join("\n"),
                        },
                    ], { temperature: 0.48, maxTokens: Math.min(12000, Math.max(4096, latest.length * 2)) });
                    const parsed = extractJsonObject(response.content);
                    const structuredText = extractStructuredChapterText(response.content);
                    if (structuredText.structured && structuredText.text) {
                        revised = assertCleanChapterText(structuredText.text, "整章增强模型正文");
                        changes = Array.isArray(parsed?.changes) ? parsed.changes.slice(0, 12).map((change) => ({
                            before: String(change?.before ?? "").slice(0, 260),
                            after: String(change?.after ?? "").slice(0, 260),
                            reason: String(change?.reason ?? "增强章节表现").slice(0, 260),
                        })).filter((change) => change.before || change.after || change.reason) : [{ before: "模型结构化返回", after: `从 ${structuredText.field || "正文"} 字段抽取正文`, reason: "防止 JSON 外壳进入章节正文。" }];
                        warnings = Array.isArray(parsed?.warnings) ? parsed.warnings.map((warning) => String(warning).slice(0, 240)).slice(0, 8) : [];
                        engine = "llm";
                    }
                    else if (parsed && typeof parsed.revised === "string") {
                        revised = assertCleanChapterText(parsed.revised, "整章增强模型正文");
                        changes = Array.isArray(parsed.changes) ? parsed.changes.slice(0, 12).map((change) => ({
                            before: String(change?.before ?? "").slice(0, 260),
                            after: String(change?.after ?? "").slice(0, 260),
                            reason: String(change?.reason ?? "增强章节表现").slice(0, 260),
                        })).filter((change) => change.before || change.after || change.reason) : [];
                        warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map((warning) => String(warning).slice(0, 240)).slice(0, 8) : [];
                        engine = "llm";
                    }
                }
                catch (error) {
                    const local = heuristicPolishText(latest);
                    revised = local.revised;
                    changes = local.changes;
                    engine = "local-heuristic";
                    warnings = [`大模型整章增强失败，已使用本地保守增强：${error instanceof Error ? error.message : String(error)}`];
                }
            }
            else {
                const local = heuristicPolishText(latest);
                revised = local.revised;
                changes = local.changes;
            }
            if (!revised || countWritingChars(revised) < Math.max(50, countWritingChars(latest) * 0.35)) {
                return c.json({ error: "enhanced text is suspiciously short; not applied", warnings: ["模型返回内容过短，已阻止覆盖原章。"] }, 422);
            }
            if (apply) {
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                const backupDir = join(root, ".hardwrite", "revisions", id);
                await mkdir(backupDir, { recursive: true });
                await writeFile(join(backupDir, `chapter-${String(num).padStart(4, "0")}-enhance-${stamp}.md`), [
                    `# 章节 ${num} 一键增强记录`,
                    "",
                    `- 书籍：${id}`,
                    `- 文件：${chapter.filename}`,
                    `- 时间：${new Date().toISOString()}`,
                    `- 引擎：${engine}`,
                    "",
                    "## 增强指令",
                    "",
                    instruction,
                    "",
                    "## 原文",
                    "",
                    latest,
                    "",
                    "## 增强后",
                    "",
                    revised,
                    "",
                    "## 修改说明",
                    "",
                    changes.map((change) => `- ${change.before || "局部"} -> ${change.after || "增强"}：${change.reason || "改善表达"}`).join("\n"),
                    "",
                    "## 风险",
                    "",
                    warnings.map((warning) => `- ${warning}`).join("\n"),
                    "",
                ].join("\n"), "utf-8");
                await atomicWriteFile(chapter.fullPath, revised);
                const chapters = await state.loadChapterIndex(id).catch(() => []);
                const current = chapters.find((entry) => Number(entry.chapterNumber ?? entry.number) === num);
                if (current) {
                    current.wordCount = countWritingChars(revised);
                    current.updatedAt = new Date().toISOString();
                    await state.saveChapterIndex(id, chapters);
                }
            }
            const qualityAfter = await buildChapterQualityPayload(state, id, num, revised).catch(() => null);
            await appendActivityLog(root, "chapter:enhanced", {
                bookId: id,
                chapterNumber: num,
                filename: chapter.filename,
                engine,
                applied: apply,
                scoreBefore: qualityBefore?.quality?.total,
                scoreAfter: qualityAfter?.quality?.total,
            });
            broadcast("chapter:enhanced", {
                bookId: id,
                chapterNumber: num,
                engine,
                applied: apply,
                scoreBefore: qualityBefore?.quality?.total,
                scoreAfter: qualityAfter?.quality?.total,
            });
            return c.json({ ok: true, applied: apply, bookId: id, chapterNumber: num, filename: chapter.filename, revised, changes, warnings, engine, qualityBefore, qualityAfter });
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    app.post("/api/v1/books/:id/chapters/:num/repair-low-score", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        const body = await c.req.json().catch(() => ({}));
        const apply = body.apply !== false;
        const _repairBook = await state.loadBookConfig(id).catch(() => null);
        const _repairBookScore = Number(_repairBook?.targetScore || _repairBook?.writing?.targetScore) || 0;
        const targetScore = Math.max(70, Math.min(98, Number(body.targetScore) || _repairBookScore || 80));
        const requestedTargetWordCount = Number(body.targetWordCount ?? body.wordCount ?? body.targetWordsPerChapter) || undefined;
        const qualityOptions = { targetWordCount: requestedTargetWordCount, gateTarget: targetScore };
        const embedded = body.embedded === true;
        const autoRound = Math.max(1, Math.min(8, Number(body.autoRound) || 1));
        const requestedAutoRounds = Math.max(1, Math.min(REPAIR_MAX_AUTO_ROUNDS, Number(body.maxAutoRounds) || REPAIR_MAX_AUTO_ROUNDS));
        let maxAutoRounds = requestedAutoRounds;
        const taskRuns = apply ? await loadTaskRuns(root) : [];
        const historyScopeStartedAt = apply ? await historyScopeStartedAtForBook(state, id) : "";
        if (apply && !embedded) {
            const activeRepair = activeSameRepairRun(taskRuns, id, num);
            if (activeRepair) {
                return c.json({
                    error: `第 ${num} 章已经有复修任务在运行，已阻止重复点击，避免重复消耗 token。`,
                    status: "already-repairing",
                    bookId: id,
                    chapterNumber: num,
                    runId: activeRepair.id,
                    heartbeatAgeMs: runHeartbeatAgeMs(activeRepair),
                    suggestion: "请等待当前复修 run 完成；如果页面长时间没有流式输出，再点“检查并继续”。",
                }, 409);
            }
        }
        if (apply && body.ignoreRepairCircuitBreaker !== true) {
            const circuit = repairCircuitBreakerDecision(repairHistoryForChapter(taskRuns, id, num, "", { createdAfter: historyScopeStartedAt }), targetScore);
            if (circuit.blocked) {
                return c.json({
                    error: circuit.message,
                    status: "repair-circuit-open",
                    bookId: id,
                    chapterNumber: num,
                    targetScore,
                    attempts: circuit.attempts,
                    bestScore: circuit.bestScore,
                    latestScore: circuit.latestScore,
                    failureReason: circuit.reason,
                    suggestion: "先去 Agent 配置检查模型/Key，或人工打开章节看阻断项；确认要强行重试时，需要显式传 ignoreRepairCircuitBreaker=true。",
                }, 409);
            }
        }
        const blocked = apply && !embedded ? await prepareWriteSlot(id, { forceTakeover: false }) : null;
        if (blocked)
            return c.json({ ...blocked, bookId: id }, 409);
        const run = apply ? await createTaskRun(root, { bookId: id, type: "chapter-quality-repair", total: 1, chapterNumber: num, targetScore, targetWordCount: requestedTargetWordCount, operationKey: `quality-repair:${id}:${num}`, currentAgent: "state-validator", currentStage: `第 ${num} 章低分修复进入队列` }) : null;
        const abortController = new AbortController();
        const unbindRequestAbort = bindAbortSignal(c.req.raw?.signal, abortController, "客户端或上游工作流已取消本次复修请求");
        if (run && !embedded)
            setWriteSlot(id, run.id, { abortController });
        let repairWatchdog;
        const clearRepairWatchdog = () => {
            if (repairWatchdog) {
                clearTimeout(repairWatchdog);
                repairWatchdog = undefined;
            }
        };
        if (run && !embedded) {
            repairWatchdog = setTimeout(async () => {
                const latestRuns = await loadTaskRuns(root).catch(() => []);
                const latestRun = latestRuns.find((item) => item.id === run.id);
                if (!isServerRunActive(latestRun))
                    return;
                const message = `低分复修模型等待超过 ${Math.round(REPAIR_WATCHDOG_MS / 1000)} 秒，已自动释放锁。`;
                const failure = failureInfoForActivity("chapter:quality-repair:error", { error: message, chapterNumber: num });
                void updateTaskRun(root, run.id, {
                    status: "needs-repair",
                    error: message,
                    completed: 0,
                    currentAgent: "guardian",
                    currentStage: `第 ${num} 章复修超时，等待继续复修`,
                    results: [{ chapterNumber: num, pass: false, error: message }],
                    failureReason: failure.reason,
                    impact: failure.impact,
                    suggestion: "继续复修会重新分配修稿师；建议给修稿师选择响应更快的模型，或降低本章目标字数后再修。",
                }, { kind: "chapter:quality-repair:error", stage: `第 ${num} 章复修超时，等待继续复修`, agent: "guardian", error: message, failureReason: failure.reason });
                releaseWriteSlot(id, run.id);
                const payload = { bookId: id, runId: run.id, chapterNumber: num, agent: "guardian", agentLabel: "守护进程", error: message, failureReason: failure.reason, impact: failure.impact, suggestion: "点击继续复修到90+；本轮不会再卡住写作锁。" };
                broadcast("chapter:quality-repair:error", payload);
                void appendBookAgentEvent(root, id, "chapter:quality-repair:error", payload);
            }, REPAIR_WATCHDOG_MS);
            repairWatchdog.unref?.();
        }
        const emitQualityRepairStage = async (agent, agentLabel, stage, extra = {}) => {
            const payload = { bookId: id, runId: run?.id, chapterNumber: num, agent, agentLabel, stage, ...extra };
            broadcast("chapter:quality-repair:stage", payload);
            void appendBookAgentEvent(root, id, "chapter:quality-repair:stage", payload);
            if (run)
                await updateTaskRun(root, run.id, { status: "running", currentAgent: agent, currentStage: stage }, { kind: "chapter:quality-repair:stage", stage, agent, ...extra });
        };
        const emitRepairPrinter = (text, agent = "reviser") => {
            const chunk = String(text || "");
            if (!chunk)
                return;
            void appendBookAgentDelta(root, id, agent, chunk).catch(() => null);
            broadcast("llm:delta", { bookId: id, runId: run?.id, agent, agentLabel: AGENT_LABELS[agent] ?? agent, text: chunk });
        };
        const emitRepairProgress = (progress = {}) => {
            const payload = { bookId: id, runId: run?.id, status: progress.status || "streaming", elapsedMs: progress.elapsedMs, totalChars: progress.totalChars, chineseChars: progress.chineseChars };
            broadcast("llm:progress", payload);
            if (run)
                void updateTaskRun(root, run.id, { status: payload.status === "done" ? "model_done" : "running", totalChars: payload.totalChars, chineseChars: payload.chineseChars, elapsedMs: payload.elapsedMs }, { kind: "llm:progress", stage: payload.status, agent: "llm" }).catch(() => null);
            void appendBookAgentEvent(root, id, "llm:progress", payload).catch(() => null);
        };
        const assertRepairNotCancelled = async () => {
            if (abortController.signal.aborted) {
                throw new ApiError(499, "REQUEST_ABORTED", "本轮复修已被停止，模型请求已硬中断。");
            }
            const parentRunId = String(body.parentRunId || "");
            if ((run?.id && await taskRunIsCancelled(run.id)) || (parentRunId && await taskRunIsCancelled(parentRunId))) {
                abortController.abort(abortReasonError("本轮复修所属工作流已取消"));
                throw new ApiError(499, "REQUEST_ABORTED", "本轮复修所属工作流已取消，模型请求已硬中断。");
            }
        };
        try {
            await assertRepairNotCancelled();
            const chapter = await resolveChapterFile(state, id, num);
            let latest = await readFile(chapter.fullPath, "utf-8");
            if (!normalizeMarkdownText(latest)) {
                return c.json({ error: "chapter is empty" }, 400);
            }
            const started = { bookId: id, runId: run?.id, chapterNumber: num, agent: "state-validator", agentLabel: "状态校验员", stage: "低分修复开始：检查状态链和章节可信度" };
            broadcast("chapter:quality-repair:start", started);
            void appendBookAgentEvent(root, id, "chapter:quality-repair:start", started);
            if (run)
                await updateTaskRun(root, run.id, { status: "running", currentAgent: "state-validator", currentStage: "低分修复：检查状态链" }, { kind: "chapter:quality-repair:start", stage: "低分修复：检查状态链", agent: "state-validator" });
            const stateRepair = apply ? await repairChapterStateIfNeeded(id, num, run, "低分章节一键修复触发状态链自愈") : null;
            if (stateRepair) {
                latest = await readFile(chapter.fullPath, "utf-8").catch(() => latest);
            }
            await emitQualityRepairStage("auditor", "审稿官", "读取真实章节评分、阻断项和质量报告");
            let qualityBefore = await buildChapterQualityPayload(state, id, num, latest, qualityOptions).catch(() => null);
            if (apply)
                await writeStudioChapterQualityReport(state, id, num, qualityBefore, "一键修复前自动补齐质量报告，避免缺报告导致评分虚低。").catch(() => null);
            qualityBefore = await buildChapterQualityPayload(state, id, num, latest, qualityOptions).catch(() => qualityBefore);
            const repairHistory = repairHistoryForChapter(await loadTaskRuns(root).catch(() => []), id, num, run?.id, { createdAfter: historyScopeStartedAt });
            const repairProfile = buildRepairLoopProfile(repairHistory, qualityBefore, targetScore, latest);
            const adaptivePlan = adaptiveRepairRoundPlan(repairProfile, qualityBefore, targetScore, requestedAutoRounds, REPAIR_MAX_AUTO_ROUNDS, body.adaptiveRepair !== false && REPAIR_ADAPTIVE_ENABLED);
            maxAutoRounds = Math.max(autoRound, adaptivePlan.maxRounds);
            await emitQualityRepairStage("auditor", "审稿官", `修复前评分 ${qualityBefore?.quality?.total ?? "--"}，${adaptiveRepairInstruction(adaptivePlan, autoRound, maxAutoRounds)} ${repairStrategyInstruction(repairProfile)}`, { scoreBefore: qualityBefore?.quality?.total, blockers: qualityBefore?.quality?.gate?.blockers ?? [], repairProfile, adaptivePlan });
            let revised = latest;
            let changes = [];
            let warnings = [];
            let engine = "quality-noop";
            if (Number(qualityBefore?.quality?.total || 0) < targetScore || qualityBefore?.quality?.gate?.pass === false) {
                engine = "llm-quality-repair";
                if (body.useLLM === false) {
                    throw new ApiError(400, "LOW_SCORE_REPAIR_REQUIRES_LLM", "低分复修必须调用文本模型，本地启发式不会再伪装修复。请在模型配置里选择可用文本模型后重试。");
                }
                const followupInstruction = limitText(body.instruction ?? body.followup ?? "", 1800);
                const previousFailureReason = limitText(body.previousFailureReason ?? "", 900);
                const previousRunId = limitText(body.previousRunId ?? "", 120);
                const previousScoreAfter = Number(body.previousScoreAfter || 0) || undefined;
                if (body.useLLM !== false) {
                    try {
                        await emitQualityRepairStage("reviser", "修稿师", `按 ${targetScore}+ 目标自适应复修：${adaptiveRepairInstruction(adaptivePlan, autoRound, maxAutoRounds)} ${repairStrategyInstruction(repairProfile)}`, { scoreBefore: qualityBefore?.quality?.total, repairProfile, adaptivePlan });
                        const bookDir = state.bookDir(id);
                        const [storyFrame, currentFocus, bookRules, humanNotes, pendingHooks, platformContext] = await Promise.all([
                            readOptionalText(join(bookDir, "story", "story_frame.md")),
                            readOptionalText(join(bookDir, "story", "current_focus.md")),
                            readOptionalText(join(bookDir, "story", "book_rules.md")),
                            readOptionalText(join(bookDir, "story", "human_notes.md")),
                            readOptionalText(join(bookDir, "story", "pending_hooks.md")),
                            bookPlatformExternalContext(id),
                        ]);
                        const currentConfig = await loadCurrentProjectConfig();
                        const repairLlm = resolveAgentRuntimeLLMConfig(currentConfig, ["reviser", "quality-repair", "quality-reporter", "radar"], 0.55);
                        if (body.model)
                            repairLlm.model = String(body.model);
                        const repairStream = body.repairStream === true && REPAIR_STREAM_ENABLED && repairLlm.stream !== false;
                        repairLlm.stream = repairStream;
                        const repairModel = String(repairLlm.model || currentConfig.llm.model || currentConfig.llm.defaultModel || "");
                        const client = createLLMClient(repairLlm);
                        await emitQualityRepairStage("reviser", "修稿师", `模型链路：${repairLlm.serviceName || repairLlm.service || repairLlm.provider || "unknown"} / ${repairModel || "unknown"}${repairStream ? " · 流式打印" : " · 非流式返回"}`, { baseUrl: repairLlm.baseUrl ? String(repairLlm.baseUrl).replace(/\/+$/, "") : "", selectedModel: repairModel, stream: repairStream });
                        emitRepairPrinter(`\n\n【自适应复修第 ${autoRound}/${maxAutoRounds} 轮】${adaptiveRepairInstruction(adaptivePlan, autoRound, maxAutoRounds)}\n策略：${repairStrategyInstruction(repairProfile)}\n\n`);
                        const stopRepairHeartbeat = startTaskHeartbeat(run?.id, "reviser", `模型正在重写第 ${num} 章低分正文`, { chapterNumber: num });
                        let timeout;
                        await assertRepairNotCancelled();
                        const targetChars = Number(qualityBefore?.quality?.stats?.targetWordCount || 3000) || 3000;
                        const currentChars = Number(qualityBefore?.quality?.stats?.chineseChars || countWritingChars(latest)) || countWritingChars(latest);
                        const compactQuality = {
                            total: qualityBefore?.quality?.total,
                            metrics: qualityBefore?.quality?.metrics,
                            stats: qualityBefore?.quality?.stats,
                            reasons: qualityBefore?.quality?.reasons,
                            gate: qualityBefore?.quality?.gate,
                            reader: qualityBefore?.quality?.reader,
                            repairProfile,
                        };
                        const repairTokenBudget = Math.min(REPAIR_MAX_TOKENS_CAP, Math.max(3200, Math.ceil(targetChars * REPAIR_TOKEN_MULTIPLIER)));
                        const response = await Promise.race([
                            chatCompletion(client, repairModel, [
                            {
                                role: "system",
                                content: [
                                    "你是长篇小说低分章节修复总编，兼任状态交接官。只输出紧凑 JSON，不要 Markdown，不要解释过程。",
                                    "目标：把本章修到目标分发布级。【定向修复铁律】只改对综合分拖累最大的维度(见下方策略指令里点名的维度)对应的句段；其余已达标的段落必须原文逐段照抄、一字不改，严禁为了『全改一遍』而推倒重写好的部分（那会破坏已写好内容、分数乱跳、还更慢）。",
                                    "这是低分复修任务，不是点评任务。revised 字段必须是完整章节正文（改动处改、未改处照抄原文），不能只复述建议、不能只做同义替换。",
                                    "这是质量自适应复修：系统会根据复审分数决定是否允许下一轮。你不能假设还有下一轮，必须在本次 revised 里直接解决最低分指标。",
                                    "如果上一轮修复失败，必须显式吸收上一轮失败原因，优先修复阻断项；不要重复上一轮无效策略。",
                                    "系统会传入 repairProfile。若 plateau 为 true，说明已经连续卡在相近分数，禁止继续小修小补，必须重排场景拍点、因果链和段落节奏。",
                                    "若 repairProfile.lengthMode 是 compress，当前正文过长，严禁扩写，必须压缩重复解释和拖沓过渡；若为 expand，必须补有效场景而不是灌水。",
                                    "硬约束：不改已成事实、不跳过人物知识边界、不新增会破坏后续大纲的重大事件；如果需要补伏笔，只能用更清晰的句子或局部场景。",
                                    "重点：状态链、因果、人物动机、章节目标、节奏、对白自然度、去 AI 腔、字数接近目标。",
                                    "评分器硬指标：中文字数必须接近 targetWordCount 的 90%-108%；连续短段不要超过 2 个；增加可感知细节、动作反应、情绪锚点和场景阻力；不要留下旧 warning 指向的问题。",
                                    "【返回前必须自查并消除这些会被判 critical 的确定性硬伤，带着它们返回=本轮白做】：① 任何「不是…而是」句式、任何「——」破折号，一律改写掉（这是硬禁，不是偏好）；② 中文字数必须落在目标的 90%-108%，超了就删冗余解释/拖沓过渡/重复心理压回去（这是硬指标，reviser 最常犯的错就是只顾改维度却把篇幅越改越长）；③ 逐条对照下方【当前审稿问题】里标 [critical] 的每一项，必须在 revised 正文里真正解决，不能只在 changes 里解释。",
                                    "如果当前质量里 length、rhythm、immersion、readability、reader 任一低于 90，必须在正文里直接补足，不要只在 changes 里解释。",
                                    "JSON 结构：{\"revised\":\"完整修复后的章节正文\",\"changes\":[{\"before\":\"问题/位置\",\"after\":\"修复方式\",\"reason\":\"对应质量原因\"}],\"warnings\":[\"仍需人工注意的问题\"]}。",
                                    "revised 必须是完整章节正文，不要只给建议；changes 最多 16 条。",
                                ].join("\n"),
                            },
                            {
                                role: "user",
                                content: [
                                    `目标分：${targetScore}`,
                                    `目标中文字数：${targetChars}`,
                                    `当前中文字数：${currentChars}`,
                                    adaptiveRepairInstruction(adaptivePlan, autoRound, maxAutoRounds),
                                    repairLengthInstruction(repairProfile),
                                    repairStrategyInstruction(repairProfile),
                                    "",
                                    "【自适应复修计划】",
                                    JSON.stringify(adaptivePlan, null, 2),
                                    "",
                                    "【复修循环诊断】",
                                    JSON.stringify(repairProfile, null, 2),
                                    "",
                                    "【当前质量】",
                                    JSON.stringify(compactQuality, null, 2),
                                    "",
                                    "【当前审稿问题】",
                                    (qualityBefore?.auditIssues || []).join("\n") || "无",
                                    "",
                                    "【上一轮复修交接】",
                                    previousRunId ? `run_id：${previousRunId}` : "run_id：无",
                                    previousScoreAfter ? `上轮分数：${previousScoreAfter}` : "上轮分数：无",
                                    previousFailureReason || "上一轮失败原因：无",
                                    "",
                                    "【本轮后续指令】",
                                    followupInstruction || "继续上一轮低分复修：上一轮没有达标，不要重复原文或只给建议，必须按阻断项改写整章正文并落库。",
                                    "",
                                    "【故事圣经】",
                                    markdownExcerpt(storyFrame, 900),
                                    "",
                                    "【当前焦点】",
                                    markdownExcerpt(currentFocus, 700),
                                    "",
                                    "【工程约束】",
                                    markdownExcerpt([bookRules, platformContext].filter(Boolean).join("\n\n"), 900),
                                    "",
                                    "【后续意见】",
                                    markdownExcerpt(humanNotes, 500),
                                    "",
                                    "【伏笔池】",
                                    markdownExcerpt(pendingHooks, 500),
                                    "",
                                    "【章节全文】",
                                    latest,
                                ].join("\n"),
                            },
                            ], {
                                temperature: 0.38,
                                maxTokens: repairTokenBudget,
                                timeoutMs: REPAIR_LLM_TIMEOUT_MS,
                                signal: abortController.signal,
                                onStreamProgress: emitRepairProgress,
                                onTextDelta: (text) => emitRepairPrinter(text, "reviser"),
                            }),
                            new Promise((_, reject) => {
                                timeout = setTimeout(() => reject(new Error(`low-score repair LLM timed out after ${Math.round(REPAIR_LLM_TIMEOUT_MS / 1000)}s`)), REPAIR_LLM_TIMEOUT_MS);
                            }),
                        ]).finally(() => {
                            clearTimeout(timeout);
                            stopRepairHeartbeat();
                        });
                        const responseText = String(response.content || "");
                        let parsed = extractJsonObject(responseText);
                        const structuredText = extractStructuredChapterText(responseText);
                        if (!repairStream)
                            emitRepairPrinter(`\n\n【第 ${autoRound}/${maxAutoRounds} 轮模型返回】已收到完整修复稿，开始解析和质量复审。\n`);
                        const parsedRevision = parsed && typeof parsed === "object"
                            ? (parsed.revised ?? parsed.body ?? parsed.content ?? parsed.chapter ?? parsed.text ?? parsed.fullText)
                            : "";
                        if (structuredText.structured && structuredText.text) {
                            parsed = {
                                ...(parsed && typeof parsed === "object" ? parsed : {}),
                                revised: structuredText.text,
                                changes: Array.isArray(parsed?.changes) ? parsed.changes : [{ before: "模型返回了结构化文本", after: `已从 ${structuredText.field || "正文"} 字段抽取完整正文`, reason: structuredText.recovered ? "兼容被截断的 JSON 外壳，防止把字段名写入正文。" : "兼容不同厂商模型的结构化输出差异。" }],
                                warnings: Array.isArray(parsed?.warnings) ? parsed.warnings : [],
                            };
                        }
                        else if (!parsed || typeof parsedRevision !== "string") {
                            const rawResponse = structuredText.text;
                            if (structuredText.structured) {
                                throw new ApiError(422, "LOW_SCORE_REPAIR_BAD_JSON", `模型返回了结构化外壳但没有可抽取的完整正文，已阻止落库。返回预览：${responseText.slice(0, 240)}`);
                            }
                            if (countWritingChars(rawResponse) >= Math.max(800, countWritingChars(latest) * 0.75)) {
                                parsed = {
                                    revised: rawResponse,
                                    changes: [{ before: "模型未按 JSON 返回", after: "已将模型返回的完整正文作为修复稿解析", reason: "非流式模型有时会输出纯正文；内容通过长度安全检查后才允许进入后续质量 Gate。" }],
                                    warnings: ["模型未按 JSON 返回，系统已按完整正文兜底解析。"],
                                };
                            }
                            else {
                                throw new ApiError(422, "LOW_SCORE_REPAIR_BAD_JSON", `模型没有返回可解析的完整章节 JSON，未落库。返回预览：${responseText.slice(0, 240)}`);
                            }
                        }
                        else if (parsed.revised !== parsedRevision) {
                            parsed = {
                                ...parsed,
                                revised: parsedRevision,
                                changes: Array.isArray(parsed.changes) ? parsed.changes : [{ before: "模型使用了非 revised 字段", after: "已从 body/content/chapter/text 字段读取完整正文", reason: "兼容不同厂商模型的结构化输出差异。" }],
                            };
                        }
                        revised = assertCleanChapterText(parsed.revised, "复修模型正文");
                        if (normalizeMarkdownText(revised) === normalizeMarkdownText(latest)) {
                            throw new ApiError(422, "LOW_SCORE_REPAIR_NO_CHANGE", "模型返回内容与原文没有实质差异，未落库。请检查模型能力或降低单章字数后重试。");
                        }
                        changes = Array.isArray(parsed.changes) ? parsed.changes.slice(0, 16).map((change) => ({
                            before: String(change?.before ?? "").slice(0, 260),
                            after: String(change?.after ?? "").slice(0, 260),
                            reason: String(change?.reason ?? "修复低分原因").slice(0, 260),
                        })).filter((change) => change.before || change.after || change.reason) : [];
                        warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map((warning) => String(warning).slice(0, 260)).slice(0, 10) : [];
                        engine = "llm-quality-repair";
                        await emitQualityRepairStage("polisher", "润色师", "修稿师已返回完整正文，正在做长度和安全覆盖检查", { engine });
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        if (abortController.signal.aborted || /HARDWRITE_LLM_ABORTED|AbortError|aborted|cancelled/i.test(message)) {
                            throw new ApiError(499, "REQUEST_ABORTED", "本轮复修已被停止，模型请求已硬中断。");
                        }
                        await emitQualityRepairStage("reviser", "修稿师", "模型修复失败，已停止，未使用本地假修", { error: message });
                        if (error instanceof ApiError)
                            throw error;
                        throw new ApiError(502, "LOW_SCORE_REPAIR_LLM_FAILED", `低分复修需要模型产出完整正文，但模型调用失败：${message}`);
                    }
                }
            }
            if (!revised || countWritingChars(revised) < Math.max(80, countWritingChars(latest) * 0.35)) {
                throw new ApiError(422, "REPAIR_OUTPUT_TOO_SHORT", "模型返回内容过短，已阻止覆盖原章。");
            }
            await emitQualityRepairStage("state-validator", "状态校验员", "修复稿通过最低安全长度检查，准备备份并回写章节");
            const didApply = Boolean(apply && revised !== latest);
            if (apply && revised !== latest) {
	                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	                const backupDir = join(root, ".hardwrite", "revisions", id);
	                await mkdir(backupDir, { recursive: true });
	                const originalHash = createHash("sha256").update(latest).digest("hex").slice(0, 16);
	                const revisedHash = createHash("sha256").update(revised).digest("hex").slice(0, 16);
	                const originalExcerpt = latest.length > 2600 ? `${latest.slice(0, 1300)}\n\n...\n\n${latest.slice(-1300)}` : latest;
	                await writeFile(join(backupDir, `chapter-${String(num).padStart(4, "0")}-quality-repair-${stamp}.md`), [
	                    `# 第 ${num} 章低分修复记录`,
	                    "",
	                    `- 书籍：${id}`,
	                    `- 文件：${chapter.filename}`,
	                    `- 目标分：${targetScore}`,
	                    `- 引擎：${engine}`,
	                    `- 原文字数：${countWritingChars(latest)}`,
	                    `- 修复后字数：${countWritingChars(revised)}`,
	                    `- 原文 SHA：${originalHash}`,
	                    `- 修复后 SHA：${revisedHash}`,
	                    "",
	                    "## 修复前质量",
	                    "",
	                    JSON.stringify(qualityBefore?.quality ?? {}, null, 2),
	                    "",
	                    "## 原文摘录",
	                    "",
	                    originalExcerpt,
	                    "",
	                    "## 修复后",
	                    "",
	                    revised,
                    "",
                    "## 修改说明",
                    "",
                    changes.map((change) => `- ${change.before || "局部"} -> ${change.after || "修复"}：${change.reason || "改善质量"}`).join("\n"),
                    "",
                    "## 风险",
                    "",
                    warnings.map((warning) => `- ${warning}`).join("\n"),
                    "",
                ].join("\n"), "utf-8");
                await atomicWriteFile(chapter.fullPath, revised);
                const chapters = await state.loadChapterIndex(id).catch(() => []);
                const current = chapters.find((entry) => Number(entry.chapterNumber ?? entry.number) === num);
                if (current) {
                    current.wordCount = countWritingChars(revised);
                    current.updatedAt = new Date().toISOString();
                    current.auditIssues = [];
                    if (current.status === "state-degraded" && !warnings.some((warning) => /状态|state/i.test(warning)))
                        current.status = "repaired";
                    await state.saveChapterIndex(id, chapters);
                }
                await buildBooksIndex(root, state).catch(() => null);
            }
            await emitQualityRepairStage("quality-reporter", "质量报告官", "重新计算修复后评分并生成质量报告");
            emitRepairPrinter(`\n\n【质量报告官】第 ${autoRound}/${maxAutoRounds} 轮开始复审真实正文评分。\n`, "quality-reporter");
            let qualityAfter = await buildChapterQualityPayload(state, id, num, revised, qualityOptions).catch(() => null);
            qualityAfter = await buildChapterQualityPayload(state, id, num, revised, qualityOptions).catch(() => qualityAfter);
            if (apply) {
                await writeStudioChapterQualityReport(state, id, num, qualityAfter, Number(qualityAfter?.quality?.total || 0) >= targetScore ? "一键修复后达到发布级目标。" : "一键修复后仍未达标，请根据阻断项继续修复。").catch(() => null);
                qualityAfter = await buildChapterQualityPayload(state, id, num, revised, qualityOptions).catch(() => qualityAfter);
            }
            const beforeTotal = Number(qualityBefore?.quality?.total || 0);
            const afterTotal = Number(qualityAfter?.quality?.total || 0);
            if (apply && didApply && !qualityGateActuallyPassed(qualityAfter?.quality, targetScore) && afterTotal <= beforeTotal) {
                await atomicWriteFile(chapter.fullPath, latest);
                const chapters = await state.loadChapterIndex(id).catch(() => []);
                const current = chapters.find((entry) => Number(entry.chapterNumber ?? entry.number) === num);
                if (current) {
                    current.wordCount = countWritingChars(latest);
                    current.updatedAt = new Date().toISOString();
                    await state.saveChapterIndex(id, chapters);
                }
                qualityAfter = qualityBefore;
                revised = latest;
                warnings.push(`本轮复修未提分（${beforeTotal} -> ${afterTotal}），已回滚正式章节，避免低质版本覆盖。`);
                await emitQualityRepairStage("state-validator", "状态校验员", `本轮复修未提分，已回滚正式章节：${beforeTotal} → ${afterTotal}`, { scoreBefore: beforeTotal, scoreAfter: afterTotal });
            }
            if (apply && qualityGateActuallyPassed(qualityAfter?.quality, targetScore)) {
                const healed = await markChapterReadyIfQualityPassed(id, num, qualityAfter, targetScore, `第 ${num} 章低分复修已达 ${targetScore}+，章节状态自动解锁`);
                if (healed)
                    qualityAfter = await buildChapterQualityPayload(state, id, num, revised, qualityOptions).catch(() => qualityAfter);
            }
            const retryProfile = buildRepairLoopProfile([...(repairHistory || []), { results: [{ chapterNumber: num, scoreAfter: qualityAfter?.quality?.total }], failureReason: "同一次自动复修仍未达标" }], qualityAfter, targetScore, revised);
            const adaptiveContinuation = adaptiveRepairContinuationDecision({ qualityBefore, qualityAfter, targetScore, autoRound, maxAutoRounds, repairProfileAfter: retryProfile });
            if (!adaptiveContinuation.continue && qualityAfter?.quality?.gate?.pass !== true) {
                warnings.push(`自适应复修停止：${adaptiveContinuation.reason}`);
                await emitQualityRepairStage("quality-reporter", "质量报告官", `自适应复修停止：${qualityBefore?.quality?.total ?? "--"} → ${qualityAfter?.quality?.total ?? "--"}，${adaptiveContinuation.reason}`, { scoreBefore: qualityBefore?.quality?.total, scoreAfter: qualityAfter?.quality?.total, adaptiveContinuation });
            }
            if (apply && body.useLLM !== false && qualityAfter?.quality?.gate?.pass !== true && adaptiveContinuation.continue) {
                const retrySuggestion = `${adaptiveContinuation.reason} ${repairNextSuggestion(retryProfile, targetScore)}`.trim();
                await emitQualityRepairStage("reviser", "修稿师", `第 ${autoRound}/${maxAutoRounds} 轮复审未达标，自适应进入下一轮：${retrySuggestion}`, { scoreAfter: qualityAfter?.quality?.total, repairProfile: retryProfile, adaptiveContinuation });
                emitRepairPrinter(`\n\n【第 ${autoRound}/${maxAutoRounds} 轮未达标】当前 ${qualityAfter?.quality?.total ?? "--"} 分，自适应判断继续。\n下一轮策略：${retrySuggestion}\n`, "quality-reporter");
                await assertRepairNotCancelled();
                const retryRes = await fetch(new URL(`/api/v1/books/${encodeURIComponent(id)}/chapters/${num}/repair-low-score`, new URL(c.req.url).origin), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    signal: abortController.signal,
                    body: JSON.stringify({
                        apply: true,
                        useLLM: true,
                        embedded: true,
                        adaptiveRepair: body.adaptiveRepair !== false,
                        targetScore,
                        autoRound: autoRound + 1,
                        maxAutoRounds,
                        parentRunId: run?.id || body.parentRunId,
                        previousRunId: run?.id || body.previousRunId,
                        previousScoreAfter: qualityAfter?.quality?.total,
                        previousFailureReason: retrySuggestion,
                        instruction: `这是同一次自动复修的第 ${autoRound + 1}/${maxAutoRounds} 轮。上一轮仍未达到 ${targetScore}+：${retrySuggestion}。必须基于刚落库的新正文继续修，不要回到更早版本。`,
                    }),
                });
                const retry = await retryRes.json().catch(() => ({}));
                if (!retryRes.ok || retry.error) {
                    throw new ApiError(retryRes.status || 502, "LOW_SCORE_AUTO_REPAIR_FAILED", retry.failureReason || retry.error || "自动续修失败");
                }
                const merged = {
                    ...retry,
                    autoRounds: retry.autoRounds || (autoRound + 1),
                    parentRunId: run?.id || body.parentRunId,
                    scoreBefore: qualityBefore?.quality?.total,
                };
                if (run) {
                    await updateTaskRun(root, run.id, {
                        status: merged.pass ? "done" : "needs-repair",
                        completed: 1,
                        currentAgent: "quality-reporter",
                        currentStage: merged.pass ? `第 ${num} 章自动复修 ${merged.autoRounds} 轮后达标` : `第 ${num} 章自动复修 ${merged.autoRounds} 轮后仍未达标`,
                        results: [{ chapterNumber: num, pass: Boolean(merged.pass), scoreBefore: qualityBefore?.quality?.total, scoreAfter: merged.scoreAfter, autoRounds: merged.autoRounds }],
                        failureReason: merged.pass ? "" : (merged.failureReason || retrySuggestion),
                        suggestion: merged.pass ? "" : (merged.suggestion || retrySuggestion),
                    }, { kind: "chapter:quality-repair", stage: merged.pass ? `第 ${num} 章自动复修达标` : `第 ${num} 章自动复修未达标`, agent: "quality-reporter", scoreBefore: qualityBefore?.quality?.total, scoreAfter: merged.scoreAfter });
                }
                broadcast("chapter:quality-repair", { bookId: id, runId: run?.id, chapterNumber: num, targetScore, scoreBefore: qualityBefore?.quality?.total, scoreAfter: merged.scoreAfter, pass: Boolean(merged.pass), autoRounds: merged.autoRounds, engine: merged.engine || "llm-quality-repair" });
                return c.json(merged);
            }
            const event = {
                bookId: id,
                runId: run?.id,
                chapterNumber: num,
                engine,
                applied: didApply,
                targetScore,
                scoreBefore: qualityBefore?.quality?.total,
                scoreAfter: qualityAfter?.quality?.total,
                pass: qualityGateActuallyPassed(qualityAfter?.quality, targetScore),
                autoRounds: autoRound,
                adaptivePlan,
                adaptiveContinuation,
            };
            await appendActivityLog(root, "chapter:quality-repair", event);
            void appendBookAgentEvent(root, id, "chapter:quality-repair", event);
            const missMetrics = Object.entries(qualityAfter?.quality?.metrics || {})
                .filter(([, value]) => Number(value) < 90)
                .map(([key, value]) => `${key} ${value}`)
                .slice(0, 8);
            const missReasons = [
                ...(qualityAfter?.quality?.reasons || []),
                ...(qualityAfter?.quality?.reader?.risks || []),
            ].filter(Boolean).slice(0, 5).join("；");
            const failureReason = event.pass ? "" : `修复后评分 ${event.scoreAfter ?? "--"}，仍未达到 ${targetScore}+。低项：${missMetrics.join("、") || "未识别"}。${missReasons || "需要继续补足正文质量。"}`;
            const repairProfileAfter = buildRepairLoopProfile([...(repairHistory || []), { results: [event], failureReason }], qualityAfter, targetScore, revised);
            const suggestion = event.pass ? "" : repairNextSuggestion(repairProfileAfter, targetScore);
            emitRepairPrinter(`\n\n【复修结算】${event.pass ? "已达标" : "未达标"}：${event.scoreBefore ?? "--"} -> ${event.scoreAfter ?? "--"} 分，共 ${autoRound} 轮。\n${suggestion || "已达到 90+ 发布门槛。"}\n`, "quality-reporter");
            if (run)
                await updateTaskRun(root, run.id, { status: event.pass ? "done" : "needs-repair", completed: 1, currentAgent: "quality-reporter", currentStage: event.pass ? `第 ${num} 章低分修复完成` : `第 ${num} 章低分修复未达标，等待复修`, results: [event], failureReason, suggestion }, { kind: "chapter:quality-repair", stage: event.pass ? `第 ${num} 章低分修复完成` : `第 ${num} 章低分修复未达标`, agent: "quality-reporter", scoreBefore: event.scoreBefore, scoreAfter: event.scoreAfter });
            broadcast("chapter:quality-repair", event);
            return c.json({ ok: true, ...event, revised, changes, warnings, qualityBefore, qualityAfter, stateRepair, failureReason, suggestion, repairProfile: repairProfileAfter, adaptivePlan, adaptiveContinuation });
        }
        catch (error) {
            if (run && await broadcastStoppedIfCancelled(run.id, id)) {
                return c.json({ status: "cancelled", bookId: id, chapterNumber: num, runId: run.id }, 499);
            }
            const message = error instanceof Error ? error.message : String(error);
            const failure = failureInfoForActivity("chapter:quality-repair:error", { error: message, chapterNumber: num });
            const retryPayload = {
                bookId: id,
                runId: run?.id,
                chapterNumber: num,
                error: message,
                failureReason: failure.reason,
                impact: failure.impact,
                suggestion: failure.suggestion,
            };
            if (run)
                await updateTaskRun(root, run.id, { status: "needs-repair", error: message, completed: 0, currentAgent: "reviser", currentStage: `第 ${num} 章低分修复失败，等待继续复修`, results: [{ chapterNumber: num, pass: false, error: message }], failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion }, { kind: "chapter:quality-repair:error", stage: `第 ${num} 章低分修复失败，等待继续复修`, agent: "reviser", error: message, failureReason: failure.reason });
            broadcast("chapter:quality-repair:error", retryPayload);
            if (error instanceof ApiError) {
                return c.json({ error: error.message, ...retryPayload }, error.status);
            }
            return c.json({ error: message, ...retryPayload }, 500);
        }
        finally {
            clearRepairWatchdog();
            unbindRequestAbort();
            if (run && !embedded)
                releaseWriteSlot(id, run.id);
        }
    });
    app.post("/api/v1/books/:id/chapters/:num/polish-selection", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        const body = await c.req.json().catch(() => ({}));
        let start = Number(body.start);
        let end = Number(body.end);
        try {
            const chapter = await resolveChapterFile(state, id, num);
            const latest = await readFile(chapter.fullPath, "utf-8");
            const originalFromBody = typeof body.original === "string" ? body.original : "";
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > latest.length) {
                return c.json({ error: "invalid selection range" }, 400);
            }
            if (originalFromBody && latest.slice(start, end) !== originalFromBody) {
                const relocated = latest.indexOf(originalFromBody);
                if (relocated >= 0) {
                    start = relocated;
                    end = relocated + originalFromBody.length;
                }
                else {
                    return c.json({ error: "selection changed, please select again" }, 409);
                }
            }
            const selected = latest.slice(start, end);
            if (!selected.trim()) {
                return c.json({ error: "selection is empty" }, 400);
            }
            if (body.apply === true) {
                const revised = assertCleanChapterText(body.revised, "选区润色内容");
                if (!revised) {
                    return c.json({ error: "revised text is required" }, 400);
                }
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                const backupDir = join(root, ".hardwrite", "revisions", id);
                await mkdir(backupDir, { recursive: true });
                await writeFile(join(backupDir, `chapter-${String(num).padStart(4, "0")}-selection-${stamp}.md`), [
                    `# 章节 ${num} 选区润色记录`,
                    "",
                    `- 书籍：${id}`,
                    `- 文件：${chapter.filename}`,
                    `- 时间：${new Date().toISOString()}`,
                    `- 范围：${start}-${end}`,
                    "",
                    "## 原文",
                    "",
                    selected,
                    "",
                    "## 润色后",
                    "",
                    revised,
                    "",
                    "## 修改说明",
                    "",
                    Array.isArray(body.changes) ? body.changes.map((change) => `- ${change?.before ?? ""} -> ${change?.after ?? ""}：${change?.reason ?? ""}`).join("\n") : "",
                    "",
                ].join("\n"), "utf-8");
                const content = assertCleanChapterText(`${latest.slice(0, start)}${revised}${latest.slice(end)}`, "选区回写后的章节正文");
                await atomicWriteFile(chapter.fullPath, content);
                const chapters = await state.loadChapterIndex(id).catch(() => []);
                const current = chapters.find((entry) => Number(entry.chapterNumber) === num);
                if (current) {
                    current.wordCount = countWritingChars(content);
                    current.updatedAt = new Date().toISOString();
                    await state.saveChapterIndex(id, chapters);
                }
                await appendActivityLog(root, "chapter:selection-polished", {
                    bookId: id,
                    chapterNumber: num,
                    filename: chapter.filename,
                    charsBefore: selected.length,
                    charsAfter: revised.length,
                });
                return c.json({ ok: true, content, start, end, revised });
            }
            const beforeContext = latest.slice(Math.max(0, start - 1200), start);
            const afterContext = latest.slice(end, Math.min(latest.length, end + 1200));
            let polished = heuristicPolishText(selected);
            let warnings = [];
            if (body.useLLM !== false) {
                try {
                    const currentConfig = await loadCurrentProjectConfig();
                    const client = createLLMClient(currentConfig.llm);
                    const response = await chatCompletion(client, currentConfig.llm.model, [
                        {
                            role: "system",
                            content: [
                                "你是长篇小说选区润色编辑。只输出 JSON，不要 Markdown。",
                                "只改用户选中的文本，不新增剧情，不改变人物目的、事实、视角、时间线和上下文连续性。",
                                "如果原文有信息不足或逻辑风险，在 warnings 里指出；不要为了华丽而过度改写。",
                                "JSON 结构：{\"revised\":\"润色后的选区文本\",\"changes\":[{\"before\":\"原句/问题\",\"after\":\"改法\",\"reason\":\"原因\"}],\"warnings\":[\"可选风险\"]}。",
                                "changes 最多 10 条，原因要具体到节奏、画面、对白、动机、连续性、信息密度或去AI腔。",
                            ].join("\n"),
                        },
                        {
                            role: "user",
                            content: [
                                `润色目标：${String(body.instruction ?? "提升自然度、画面感和阅读节奏，保留原意。").slice(0, 800)}`,
                                "",
                                "【上文】",
                                beforeContext,
                                "",
                                "【需要润色的选区】",
                                selected,
                                "",
                                "【下文】",
                                afterContext,
                            ].join("\n"),
                        },
                    ], { temperature: 0.45, maxTokens: 4096 });
                    const parsed = extractJsonObject(response.content);
                    if (parsed && typeof parsed.revised === "string" && Array.isArray(parsed.changes)) {
                        polished = {
                            revised: normalizeMarkdownText(parsed.revised),
                            changes: parsed.changes.slice(0, 10).map((change) => ({
                                before: String(change?.before ?? "").slice(0, 260),
                                after: String(change?.after ?? "").slice(0, 260),
                                reason: String(change?.reason ?? "改善表达").slice(0, 260),
                            })),
                            engine: "llm",
                        };
                        warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map((warning) => String(warning).slice(0, 240)).slice(0, 5) : [];
                    }
                }
                catch (error) {
                    warnings = [`大模型润色暂不可用，已使用本地保守润色：${error instanceof Error ? error.message : String(error)}`];
                }
            }
            await appendActivityLog(root, "chapter:selection-polish-preview", {
                bookId: id,
                chapterNumber: num,
                filename: chapter.filename,
                chars: selected.length,
                engine: polished.engine ?? "local-heuristic",
            });
            return c.json({
                ok: true,
                bookId: id,
                chapterNumber: num,
                start,
                end,
                original: selected,
                revised: polished.revised,
                changes: polished.changes,
                warnings,
                html: renderSelectionPolishHtml(selected, polished.revised, polished.changes, warnings),
            });
        }
        catch (error) {
            if (error instanceof ApiError) {
                return c.json({ error: error.message }, error.status);
            }
            return c.json({ error: String(error) }, 500);
        }
    });
    // --- Truth files ---
    // Flat-file whitelist — the pre-Phase-5 story root files plus dev's legacy
    // editor targets (author_intent / current_focus / volume_outline).
    //
    // Phase 5 cleanup #3 moved the authoritative YAML frontmatter + outline prose
    // into story/outline/ and character sheets into story/roles/. `story_bible.md`
    // and `book_rules.md` now exist only as compat pointer shims — we still allow
    // reading them so legacy books keep rendering, but the server-side writer
    // (write_truth_file) no longer accepts them as edit targets.
    const TRUTH_FLAT_FILES = [
        "author_intent.md", "current_focus.md",
        "story_bible.md", "book_rules.md", "volume_outline.md", "current_state.md",
        "particle_ledger.md", "pending_hooks.md", "chapter_summaries.md",
        "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
        "style_guide.md", "book_description.md", "parent_canon.md", "fanfic_canon.md",
    ];
    // Authoritative Phase 5 paths — prose outline + role sheets live under
    // dedicated subdirectories of story/. The full path (relative to story/) is
    // matched literally here. `节奏原则.md` / `rhythm_principles.md` is optional
    // after Phase 5 consolidation (rhythm lives in volume_map's closing paragraph);
    // the entries stay whitelisted for legacy books and manual overrides.
    const TRUTH_OUTLINE_FILES = [
        "outline/story_frame.md",
        "outline/volume_map.md",
        "outline/节奏原则.md",
        "outline/rhythm_principles.md",
    ];
    // Pointer shims that the runtime no longer treats as authoritative. The
    // GET handler tags them with `legacy: true` so the UI can surface that the
    // edits won't land where the user expects.
    const LEGACY_SHIM_FILES = new Set(["story_bible.md", "book_rules.md"]);
    /**
     * Validate a requested truth-file path:
     *   1. Must be one of the declared flat files, an outline/* allow-listed
     *      entry, or a roles/**\/*.md file under 主要角色/ | 次要角色/.
     *   2. Must resolve to a path inside bookDir/story/ (no `..`, no absolute
     *      paths, no traversal via the tier-name segment).
     */
    function resolveTruthFilePath(bookDir, file) {
        // Reject absolute paths, traversal, null bytes outright.
        if (!file || file.includes("\0") || isAbsolute(file) || file.includes("..")) {
            return null;
        }
        // Phase hotfix 3: accept both Chinese and English locale role dirs so
        // English-layout books (roles/major, roles/minor) are reachable through
        // Studio. The runtime reader (utils/outline-paths.ts:75) already scans
        // both — Studio used to drop English books to read-only.
        const allowed = TRUTH_FLAT_FILES.includes(file)
            || TRUTH_OUTLINE_FILES.includes(file)
            || /^roles\/(主要角色|次要角色|major|minor)\/[^/]+\.md$/.test(file);
        if (!allowed)
            return null;
        const storyDir = resolve(bookDir, "story");
        const resolved = resolve(storyDir, file);
        const relativePath = relative(storyDir, resolved);
        if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
            return null;
        }
        return resolved;
    }
    async function fileExists(path) {
        try {
            await access(path);
            return true;
        }
        catch {
            return false;
        }
    }
    // Use `:file{.+}` wildcard so nested paths (outline/..., roles/.../...) match.
    app.get("/api/v1/books/:id/truth/:file{.+}", async (c) => {
        const file = c.req.param("file");
        const id = c.req.param("id");
        const bookDir = state.bookDir(id);
        const resolved = resolveTruthFilePath(bookDir, file);
        if (!resolved) {
            return c.json({ error: "Invalid truth file" }, 400);
        }
        // Phase 5: new-layout books keep the authoritative prose under outline/.
        // A legacy book may only have story_bible.md / book_rules.md on disk —
        // we still serve those for read-only display, but flag them so the UI
        // can warn users their edits won't reach the runtime.
        // Hotfix: only tag as legacy when the book actually HAS the new layout.
        // Pre-Phase-5 books use story_bible/book_rules as the authoritative source.
        const { isNewLayoutBook } = await import("@juanshe/core");
        const legacy = LEGACY_SHIM_FILES.has(file) && await isNewLayoutBook(bookDir);
        try {
            const content = await readFile(resolved, "utf-8");
            return c.json({ file, content, ...(legacy ? { legacy: true } : {}) });
        }
        catch {
            return c.json({ file, content: null, ...(legacy ? { legacy: true } : {}) });
        }
    });
    // --- Analytics ---
    app.get("/api/v1/books/:id/analytics", async (c) => {
        const id = c.req.param("id");
        try {
            const chapters = await state.loadChapterIndex(id);
            return c.json(computeAnalytics(id, chapters));
        }
        catch {
            return c.json({ error: `Book "${id}" not found` }, 404);
        }
    });
    app.get("/api/v1/insight/opportunities", async (c) => {
        try {
            return c.json(await buildV0MarketOpportunities(root));
        }
        catch (error) {
            return c.json({ error: String(error) }, 500);
        }
    });
    const agentFlowPayload = () => ({
        stages: PIPELINE_STAGES,
        labels: AGENT_LABELS,
        flow: AGENT_FLOW,
        taskFlows: AGENT_TASK_FLOWS,
        events: {
            stream: "/api/v1/events",
            tokenProgress: "llm:progress",
            pipelineStage: "agent:stage",
            toolLifecycle: ["tool:start", "tool:update", "tool:end"],
            legacyWorkbench: ["write:start", "audit:start", "revise:start", "style:start"],
        },
    });
    app.get("/api/v1/agent-flow", (c) => c.json(agentFlowPayload()));
    app.get("/api/v1/agents", (c) => c.json(agentFlowPayload()));
    app.get("/api/v1/agents/flow", (c) => c.json(agentFlowPayload()));
    app.get("/api/v1/agents/:id", async (c) => {
        const requestedId = c.req.param("id");
        const id = resolveBackendAgentId(requestedId);
        const agent = AGENT_ROSTER.find((item) => item.id === id);
        if (!agent)
            return c.json({ error: `Agent "${requestedId}" not found` }, 404);
        const profilePayload = await agentProfilesPayload().catch(() => null);
        const profile = profilePayload?.profiles?.[id] ?? null;
        const definition = profilePayload?.agents?.find?.((item) => item.id === id) ?? null;
        return c.json({
            ...agent,
            requestedId,
            definition,
            profile,
            models: profilePayload?.models ?? [],
            override: profilePayload?.overrides?.[id] ?? null,
            flow: AGENT_FLOW,
            taskFlow: AGENT_TASK_FLOWS[id] ?? [],
            events: agentFlowPayload().events,
        });
    });
    app.get("/api/v1/workflow-contract", (c) => c.json({
        stages: WORKFLOW_STAGE_DEFS.map((stage) => ({
            id: stage.id,
            label: stage.label,
            bookStatus: stage.bookStatus,
            chapterStatus: stage.chapterStatus,
            agents: stage.agents.map((agentId) => ({
                id: agentId,
                role: workflowAgentLabel(agentId),
                task: WORKFLOW_AGENT_TASK.get(agentId) || "",
            })),
        })),
        taskFlows: AGENT_TASK_FLOWS,
        agentStatuses: ["待命", "运行中", "已完成", "错误"],
        endpoints: {
            workflowStatus: "GET /api/v1/books/:id/workflow-status",
            workflowProgress: "POST /api/v1/books/:id/workflow/progress",
            chapters: "GET /api/v1/books/:id/chapters",
            chapterManuscript: "GET /api/v1/books/:id/chapters/:num/manuscript",
            chapterStats: "GET /api/v1/books/:id/chapters/:num/stats",
            chapterStatus: "GET /api/v1/books/:id/chapters/:num/status",
            chapterRoleQueue: "GET /api/v1/books/:id/chapters/:num/role-queue",
            chapterReviewIssues: "GET /api/v1/books/:id/chapters/:num/review-issues",
            chapterHandoff: "GET /api/v1/books/:id/chapters/:num/handoff",
            chapterRewriteProposal: "GET /api/v1/books/:id/chapters/:num/rewrite-proposal?style=tighten|lyric|dialog|sensory",
            chapterProceed: "POST /api/v1/books/:id/chapters/:num/proceed",
            agentEvents: "GET /api/v1/books/:id/agents/events?since=TIMESTAMP",
            agentEventsStream: "GET /api/v1/books/:id/agents/events/stream",
            promptInjections: "GET /api/v1/books/:id/prompt-injections",
            effectivePromptInjections: "GET /api/v1/books/:id/prompt-injections/effective?chapterNumber=&agent=",
            createPromptInjection: "POST /api/v1/books/:id/prompt-injections",
            updatePromptInjection: "PATCH /api/v1/books/:id/prompt-injections/:promptId",
            deletePromptInjection: "DELETE /api/v1/books/:id/prompt-injections/:promptId",
            generate: "POST /api/v1/ai/generate",
            writeBatch: "POST /api/v1/books/:id/write-batch",
            review: "POST /api/v1/books/:id/review",
        },
        eventTypes: ["workflow:stage-update", "chapter:status-update", "agentLog", "workflow:status", "prompt-injection:created", "prompt-injection:updated", "prompt-injection:deleted"],
        updatedAt: new Date().toISOString(),
    }));
    app.get("/api/v1/books/:id/workflow-status", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        return c.json(await buildBookWorkflowStatus(root, state, id));
    });
    app.post("/api/v1/books/:id/workflow/progress", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const body = await c.req.json().catch(() => ({}));
        const targetStage = normalizeWorkflowStage(body.targetStage || body.stage);
        const runtime = await writeWorkflowRuntimeState(root, id, {
            stage: targetStage.id,
            targetStage: targetStage.id,
            currentAgent: body.currentAgent || "",
            reason: typeof body.reason === "string" ? body.reason : "前端请求推进阶段",
        });
        const status = await buildBookWorkflowStatus(root, state, id);
        const payload = {
            bookId: id,
            stage: targetStage.label,
            stageId: targetStage.id,
            reason: runtime.reason,
            currentRole: status.currentRole,
            updatedAt: runtime.updatedAt,
        };
        broadcast("workflow:stage-update", payload);
        return c.json({ success: true, ok: true, status });
    });
    app.get("/api/v1/books/:id/chapters/:num/status", async (c) => {
        const id = c.req.param("id");
        const num = Number.parseInt(c.req.param("num"), 10);
        if (!isSafeBookId(id) || !Number.isInteger(num) || num <= 0)
            return c.json({ error: "Invalid book id or chapter number" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        return c.json(await buildChapterWorkflowStatus(root, state, id, num));
    });
    app.post("/api/v1/books/:id/chapters/:num/proceed", async (c) => {
        const id = c.req.param("id");
        const num = Number.parseInt(c.req.param("num"), 10);
        if (!isSafeBookId(id) || !Number.isInteger(num) || num <= 0)
            return c.json({ error: "Invalid book id or chapter number" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const body = await c.req.json().catch(() => ({}));
        const nextStage = normalizeWorkflowStage(body.nextStatus || body.nextStage || body.status || "review");
        const current = await readWorkflowRuntimeState(root, id);
        await writeWorkflowRuntimeState(root, id, {
            chapterOverrides: {
                ...(current.chapterOverrides || {}),
                [num]: nextStage.chapterStatus,
            },
            reason: typeof body.reason === "string" ? body.reason : `第 ${num} 章状态推进`,
        });
        const status = await buildChapterWorkflowStatus(root, state, id, num);
        broadcast("chapter:status-update", {
            bookId: id,
            chapterNumber: num,
            status: status.status,
            stage: status.stage,
            currentRole: status.currentRole,
        });
        return c.json({ success: true, ok: true, status });
    });
    app.get("/api/v1/books/:id/chapters/:num/stream", async (c) => {
        const id = c.req.param("id");
        const num = Number.parseInt(c.req.param("num"), 10);
        if (!isSafeBookId(id) || !Number.isInteger(num) || num <= 0)
            return c.json({ error: "Invalid book id or chapter number" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        return streamSSE(c, async (stream) => {
            const [chapterStatus, manuscript] = await Promise.all([
                buildChapterWorkflowStatus(root, state, id, num).catch(() => null),
                resolveChapterFile(state, id, num)
                    .then((chapter) => readFile(chapter.fullPath, "utf-8"))
                    .catch(() => ""),
            ]);
            await stream.writeSSE({
                event: "chapter:status",
                data: JSON.stringify({ bookId: id, chapterNumber: num, status: chapterStatus, manuscriptLength: countWritingChars(manuscript) }),
            });
            const handler = (event, data) => {
                if (data?.bookId !== id)
                    return;
                const chapterNumber = Number(data.chapterNumber || data.chapter || data.currentChapter || 0);
                if (chapterNumber && chapterNumber !== num)
                    return;
                stream.writeSSE({ event, data: JSON.stringify(agentEventFromActivity({ timestamp: new Date().toISOString(), event, data })) });
            };
            subscribers.add(handler);
            while (!stream.aborted) {
                await stream.sleep(15000);
                await stream.writeSSE({ event: "ping", data: JSON.stringify({ bookId: id, chapterNumber: num, time: new Date().toISOString() }) });
            }
            subscribers.delete(handler);
        });
    });
    app.get("/api/v1/books/:id/agents/events", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const since = c.req.query("since") || "";
        const entries = filterActivityForBook(await readActivityEntries(root, 400), id, since).map(agentEventFromActivity);
        return c.json(entries);
    });
    app.get("/api/v1/books/:id/agents/events/stream", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        return streamSSE(c, async (stream) => {
            const initial = await buildBookWorkflowStatus(root, state, id).catch(() => null);
            if (initial)
                await stream.writeSSE({ event: "workflow:status", data: JSON.stringify(initial) });
            const handler = (event, data) => {
                if (data?.bookId !== id)
                    return;
                stream.writeSSE({ event, data: JSON.stringify(agentEventFromActivity({ timestamp: new Date().toISOString(), event, data })) });
            };
            subscribers.add(handler);
            while (!stream.aborted) {
                await stream.sleep(15000);
                await stream.writeSSE({ event: "ping", data: JSON.stringify({ bookId: id, time: new Date().toISOString() }) });
            }
            subscribers.delete(handler);
        });
    });
    // 流式中断恢复:当前在写章节的「已累计正文」快照(见顶部 liveDraftByBook 常驻 subscriber)。
    // 前端 useLiveRun 在订阅建立 / 断线重连时 GET 一次,把半章正文种回打字机,不再从句中开始。
    app.get("/api/v1/books/:id/agents/live-draft", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const entry = liveDraftByBook.get(id);
        const text = entry?.lastAgent ? (entry.byAgent.get(entry.lastAgent) ?? "") : "";
        return c.json({
            bookId: id,
            chapter: entry?.chapter ?? null,
            agentId: entry?.lastAgent || null,
            text,
            textLength: text.length,
            updatedAt: entry ? new Date(entry.updatedAt).toISOString() : null,
            completed: entry?.completed ?? false,
        });
    });
    app.post("/api/v1/books/:id/review", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const body = await c.req.json().catch(() => ({}));
        const payload = {
            bookId: id,
            chapterNumber: Number(body.chapterNumber || body.num || 0) || undefined,
            agent: "auditor",
            agentLabel: "审稿官",
            stage: "人工审稿意见已接收",
            message: typeof body.message === "string" ? body.message : "",
            issues: Array.isArray(body.issues) ? body.issues : [],
            severity: body.severity || "info",
        };
        broadcast("review:submitted", payload);
        const status = payload.chapterNumber
            ? await buildChapterWorkflowStatus(root, state, id, payload.chapterNumber).catch(() => null)
            : await buildBookWorkflowStatus(root, state, id).catch(() => null);
        return c.json({ success: true, ok: true, status });
    });
    app.get("/api/v1/books/:id/prompt-injections", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const items = (await readPromptInjections(root, id)).map(publicPromptInjection);
        return c.json({ bookId: id, items, active: items.filter((item) => promptInjectionIsActive(item)) });
    });
    app.get("/api/v1/books/:id/prompt-injections/effective", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const chapterNumber = Number(c.req.query("chapterNumber") || c.req.query("chapter") || 0) || undefined;
        const agent = c.req.query("agent") || "";
        const items = await activePromptInjections(root, id, { chapterNumber, agent });
        return c.json({ bookId: id, chapterNumber, agent, items, promptBlock: renderPromptInjectionBlock(items) });
    });
    app.post("/api/v1/books/:id/prompt-injections", async (c) => {
        const id = c.req.param("id");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const body = await c.req.json().catch(() => ({}));
        const text = limitPromptInjectionText(body.text || body.instruction || body.prompt);
        if (!text)
            return c.json({ error: "Prompt injection text is required" }, 400);
        const now = new Date().toISOString();
        const expiresInMinutes = Number(body.expiresInMinutes || body.ttlMinutes || 0);
        const expiresAt = body.expiresAt
            ? normalizePromptInjectionExpiresAt(body.expiresAt)
            : expiresInMinutes > 0
                ? new Date(Date.now() + expiresInMinutes * 60_000).toISOString()
                : "";
        const target = {
            ...(body.target && typeof body.target === "object" ? body.target : {}),
            ...(body.chapterNumber || body.chapter ? { chapterNumber: Number(body.chapterNumber || body.chapter) } : {}),
            ...(body.agent || body.agentId ? { agent: String(body.agent || body.agentId) } : {}),
            ...(body.startText ? { startText: String(body.startText).slice(0, 500) } : {}),
            ...(body.endText ? { endText: String(body.endText).slice(0, 500) } : {}),
            ...(body.quote ? { quote: String(body.quote).slice(0, 800) } : {}),
        };
        const item = publicPromptInjection({
            id: makePromptInjectionId(),
            bookId: id,
            scope: normalizePromptInjectionScope(body.scope),
            status: normalizePromptInjectionStatus(body.status),
            title: String(body.title || body.name || "").trim().slice(0, 120),
            text,
            priority: Math.max(0, Math.min(1000, Number(body.priority) || 50)),
            agent: target.agent || "",
            chapterNumber: Number(target.chapterNumber || 0) || undefined,
            target,
            expiresAt,
            reason: String(body.reason || "").trim().slice(0, 500),
            createdAt: now,
            updatedAt: now,
        });
        const items = await readPromptInjections(root, id);
        await writePromptInjections(root, id, [item, ...items.map(publicPromptInjection)]);
        const payload = { bookId: id, item };
        broadcast("prompt-injection:created", payload);
        void appendBookAgentEvent(root, id, "prompt-injection:created", { ...payload, agent: item.agent || "prompt-governor", agentLabel: item.agent ? workflowAgentLabel(item.agent) : "提示词治理官", stage: "临时提示词已注入" });
        return c.json({ success: true, ok: true, item, status: await buildBookWorkflowStatus(root, state, id).catch(() => null) });
    });
    app.patch("/api/v1/books/:id/prompt-injections/:promptId", async (c) => {
        const id = c.req.param("id");
        const promptId = c.req.param("promptId");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const body = await c.req.json().catch(() => ({}));
        const items = (await readPromptInjections(root, id)).map(publicPromptInjection);
        const index = items.findIndex((item) => item.id === promptId);
        if (index < 0)
            return c.json({ error: "Prompt injection not found" }, 404);
        const previous = items[index];
        const next = publicPromptInjection({
            ...previous,
            ...(body.scope !== undefined ? { scope: normalizePromptInjectionScope(body.scope) } : {}),
            ...(body.status !== undefined ? { status: normalizePromptInjectionStatus(body.status) } : {}),
            ...(body.text !== undefined || body.instruction !== undefined || body.prompt !== undefined ? { text: limitPromptInjectionText(body.text || body.instruction || body.prompt) } : {}),
            ...(body.title !== undefined || body.name !== undefined ? { title: String(body.title || body.name || "").trim().slice(0, 120) } : {}),
            ...(body.priority !== undefined ? { priority: Math.max(0, Math.min(1000, Number(body.priority) || 50)) } : {}),
            ...(body.expiresAt !== undefined ? { expiresAt: normalizePromptInjectionExpiresAt(body.expiresAt) } : {}),
            ...(body.target && typeof body.target === "object" ? { target: body.target } : {}),
            updatedAt: new Date().toISOString(),
        });
        items[index] = next;
        await writePromptInjections(root, id, items);
        const payload = { bookId: id, item: next };
        broadcast("prompt-injection:updated", payload);
        void appendBookAgentEvent(root, id, "prompt-injection:updated", { ...payload, agent: next.agent || "prompt-governor", agentLabel: next.agent ? workflowAgentLabel(next.agent) : "提示词治理官", stage: "临时提示词已更新" });
        return c.json({ success: true, ok: true, item: next, status: await buildBookWorkflowStatus(root, state, id).catch(() => null) });
    });
    app.delete("/api/v1/books/:id/prompt-injections/:promptId", async (c) => {
        const id = c.req.param("id");
        const promptId = c.req.param("promptId");
        if (!isSafeBookId(id))
            return c.json({ error: "Invalid book id" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const items = (await readPromptInjections(root, id)).map(publicPromptInjection);
        const index = items.findIndex((item) => item.id === promptId);
        if (index < 0)
            return c.json({ error: "Prompt injection not found" }, 404);
        items[index] = publicPromptInjection({ ...items[index], status: "expired", updatedAt: new Date().toISOString() });
        await writePromptInjections(root, id, items);
        const payload = { bookId: id, item: items[index] };
        broadcast("prompt-injection:deleted", payload);
        void appendBookAgentEvent(root, id, "prompt-injection:deleted", { ...payload, agent: "prompt-governor", agentLabel: "提示词治理官", stage: "临时提示词已停用" });
        return c.json({ success: true, ok: true, item: items[index] });
    });
    app.post("/api/v1/ai/generate", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const id = String(body.bookId || body.id || "").trim();
        if (!isSafeBookId(id))
            return c.json({ error: "bookId is required for /api/v1/ai/generate" }, 400);
        if (!(await bookExists(id)))
            return c.json({ error: `Book "${id}" not found` }, 404);
        const origin = new URL(c.req.url).origin;
        const upstream = await fetch(`${origin}/api/v1/books/${encodeURIComponent(id)}/write-next`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const payload = await upstream.json().catch(async () => ({ error: await upstream.text().catch(() => "generate failed") }));
        return c.json(payload, upstream.status);
    });
    app.get("/api/v1/runs", async (c) => {
        await releaseStaleTaskRunsFromTable().catch(() => false);
        const bookId = c.req.query("bookId");
        const limit = boundedQueryInt(c.req.query("limit"), 80, 1, 200);
        const eventLimit = boundedQueryInt(c.req.query("recentEvents") ?? c.req.query("eventLimit"), 12, 0, 40);
        if (bookId && !(await bookExists(bookId)))
            return c.json({ runs: [] });
        const runs = await loadTaskRuns(root);
        const filtered = [];
        for (const run of runs) {
            if (bookId) {
                if (run.bookId === bookId)
                    filtered.push(run);
                continue;
            }
            if (run.bookId && !(await bookExists(run.bookId)))
                continue;
            filtered.push(run);
        }
        const visibleRuns = sortTaskRunsForWorkbench(filtered).slice(0, limit);
        return c.json({ runs: visibleRuns.map((run) => enrichTaskRunListItem(run, eventLimit)) });
    });
    app.get("/api/v1/runs/:runId", async (c) => {
        await releaseStaleTaskRunsFromTable().catch(() => false);
        const runId = c.req.param("runId");
        const run = (await loadTaskRuns(root)).find((item) => item.id === runId);
        if (!run)
            return c.json({ error: "Run not found", runId }, 404);
        return c.json({ run: enrichTaskRunForClient(run) });
    });
    app.get("/api/v1/books/:id/runs", async (c) => {
        await releaseStaleTaskRunsFromTable().catch(() => false);
        const id = c.req.param("id");
        const limit = boundedQueryInt(c.req.query("limit"), 80, 1, 200);
        const eventLimit = boundedQueryInt(c.req.query("recentEvents") ?? c.req.query("eventLimit"), 12, 0, 40);
        if (!(await bookExists(id)))
            return c.json({ bookId: id, runs: [] });
        const runs = (await loadTaskRuns(root)).filter((run) => run.bookId === id);
        const visibleRuns = sortTaskRunsForWorkbench(runs).slice(0, limit);
        return c.json({ bookId: id, runs: visibleRuns.map((run) => enrichTaskRunListItem(run, eventLimit)) });
    });
    app.post("/api/v1/books/:id/workflow/stop", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const reason = typeof body.reason === "string" && body.reason.trim()
            ? body.reason.trim()
            : "用户手动停止本书工作流";
        try {
            const result = await cancelBookRuns(id, reason);
            return c.json({ ok: true, ...result });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Actions ---
    app.post("/api/v1/books/:id/repair-state", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const latest = await latestStateDegradedChapter(id).catch(() => null);
        if (!latest) {
            return c.json({ ok: true, status: "clean", bookId: id, message: "最新章节状态可信，无需修复。" });
        }
        const blocked = await prepareWriteSlot(id, { forceTakeover: Boolean(body.forceTakeover) });
        if (blocked)
            return c.json({ ...blocked, bookId: id }, 409);
        const chapterNumber = Number(latest.number || latest.chapterNumber || 0);
        const run = await createTaskRun(root, { bookId: id, type: "state-repair", total: 1, currentAgent: "state-validator", currentStage: `第 ${chapterNumber} 章状态自愈进入队列` });
        const abortController = new AbortController();
        setWriteSlot(id, run.id, { abortController });
        const stopHeartbeat = startTaskHeartbeat(run.id, "state-validator", `第 ${chapterNumber} 章状态自愈运行中`, { chapterNumber });
        (async () => {
            try {
                const result = await repairLatestStateIfNeeded(id, run, "用户点击检查并继续触发状态自愈");
                await updateTaskRun(root, run.id, { status: "done", completed: 1, currentAgent: "state-validator", currentStage: `第 ${chapterNumber} 章状态自愈完成`, results: [{ chapterNumber, status: "repaired", result }] }, { kind: "state-repair:complete", stage: `第 ${chapterNumber} 章状态自愈完成`, agent: "state-validator" });
            }
            catch {
                // repairLatestStateIfNeeded has already written the specific failure reason.
            }
            finally {
                stopHeartbeat();
                releaseWriteSlot(id, run.id);
            }
        })();
        return c.json({ status: "repairing", bookId: id, runId: run.id, run, chapterNumber });
    });
    app.post("/api/v1/books/:id/write-next", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({ wordCount: undefined }));
        const origin = new URL(c.req.url).origin;
        const book = await state.loadBookConfig(id).catch(() => null);
        if (!book) {
            return c.json({ error: { code: "BOOK_NOT_FOUND", message: `Book not found: ${id}` }, bookId: id }, 404);
        }
        // 优先读请求体→书级配置→项目配置→默认 80(DeepSeek 等主流模型的合理基准)
        const bookTargetScore = Number(book?.targetScore || book?.writing?.targetScore) || 0;
        const targetScore = Math.max(70, Math.min(98, Number(body.targetScore) || bookTargetScore || 80));
        const requestedWordCount = Number(body.wordCount) || undefined;
        // 轻中重档位:读 body.mode + 当前激活等级(②)→ 限档(未指定 mode = 既有 max 行为)
        const _activationForMode = await loadActivation(root).catch(() => null);
        const writeIntensity = resolveWriteIntensity(body.mode || freeTierWriteMode(_activationForMode), _activationForMode?.tier);
        const autoRepair = body.autoRepair !== false;
        if (body.ignoreFoundationGate !== true) {
            const foundation = await inspectBookFoundationForWriting(state, id);
            if (!foundation.ok) {
                void appendBookAgentEvent(root, id, "write:blocked-foundation", { ...foundation, agent: "foundation-reviewer", agentLabel: "建书复审官", stage: foundation.failureReason });
                broadcast("write:blocked-foundation", { bookId: id, ...foundation });
                return c.json({ bookId: id, ...foundation }, 409);
            }
        }
        if (body.ignoreExistingQualityGate !== true) {
            const qualityBlocker = await findExistingQualityGateBlocker(id, targetScore);
            if (qualityBlocker) {
                const payload = qualityGateBlockedPayload(id, qualityBlocker, targetScore, "write-next");
                void appendBookAgentEvent(root, id, "write:blocked-quality-gate", { ...payload, agent: "quality-reporter", agentLabel: "质量报告官", stage: payload.failureReason });
                broadcast("write:blocked-quality-gate", payload);
                return c.json(payload, 409);
            }
        }
        const blocked = await prepareWriteSlot(id, { forceTakeover: Boolean(body.forceTakeover) });
        if (blocked)
            return c.json({ ...blocked, bookId: id }, 409);
        const run = await createTaskRun(root, { bookId: id, type: "write-next", wordCount: requestedWordCount, targetScore, targetQuality: targetScore, currentAgent: "planner", currentStage: "写作任务进入队列" });
        const abortController = new AbortController();
        setWriteSlot(id, run.id, { abortController });
        const stopHeartbeat = startTaskHeartbeat(run.id, "planner", "单章写作工作流运行中");
        void appendBookAgentEvent(root, id, "write:queued", { wordCount: requestedWordCount, targetScore, runId: run.id });
        broadcast("write:start", { bookId: id, runId: run.id });
        // Fire and forget — progress/completion/errors pushed via SSE
        let pipeline;
        try {
            const nextChapterNumber = await state.getNextChapterNumber(id).catch(() => undefined);
            const injectedInstruction = await composeRuntimePromptInstruction(root, id, { chapterNumber: nextChapterNumber, agent: "writer" }, body.instruction || "");
            const externalContext = mergeExternalContext(await bookPlatformExternalContext(id), injectedInstruction, await voiceFingerprintBlock(id), await narrativeCraftBlock(), longOutputSafetyContext({ wordCount: requestedWordCount, chapters: 1, targetScore, mode: "write-next" }));
            pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForSSE: id, runIdForSSE: run.id, chapterForSSE: nextChapterNumber, externalContext, abortSignal: abortController.signal, writeIntensity }));
        }
        catch (e) {
            stopHeartbeat();
            releaseWriteSlot(id, run.id);
            void updateTaskRun(root, run.id, { status: "error", error: e instanceof Error ? e.message : String(e) }, { kind: "write:error", stage: "启动失败", agent: "planner" });
            throw e;
        }
        (async () => {
            if (await taskRunIsCancelled(run.id))
                return { __cancelled: true };
            await repairLatestStateIfNeeded(id, run, "单章续写前自动修复状态链");
            if (await taskRunIsCancelled(run.id))
                return { __cancelled: true };
            const result = await pipeline.writeNextChapter(id, requestedWordCount);
            if (await taskRunIsCancelled(run.id))
                return { __cancelled: true };
            return result;
        })().then(async (result) => {
                if (result?.__cancelled || await broadcastStoppedIfCancelled(run.id, id))
                    return;
                let gate = await evaluateGeneratedChapterGate(id, result, targetScore, { targetWordCount: requestedWordCount });
                let finalResult = gate.result;
                if (gate.needsRepair && autoRepair && Number(result.chapterNumber || 0)) {
                    const startPayload = { bookId: id, runId: run.id, chapterNumber: result.chapterNumber, targetScore, scoreBefore: gate.score, agent: "reviser", agentLabel: "修稿师", stage: `质量 Gate 未过，自动复修到 ${targetScore}+ 后再结算` };
                    await appendBookAgentEvent(root, id, "write:auto-repair:start", startPayload);
                    await updateTaskRun(root, run.id, { status: "running", currentAgent: "reviser", currentStage: startPayload.stage, results: [finalResult] }, { kind: "write:auto-repair:start", stage: startPayload.stage, agent: "reviser", scoreBefore: gate.score });
                    broadcast("write:auto-repair:start", startPayload);
                    let repair = null;
                    try {
                        repair = await runEmbeddedQualityRepair(origin, id, Number(result.chapterNumber), targetScore, {
                            parentRunId: run.id,
                            abortSignal: abortController.signal,
                            previousScoreAfter: gate.score,
                            previousFailureReason: gate.failureReason,
                            targetWordCount: requestedWordCount,
                            instruction: `单章写作质量门禁：第 ${result.chapterNumber} 章写完后评分 ${gate.score ?? "--"}，必须修到 ${targetScore}+ 才能完成本轮。修复时保持既定事实、人物状态和下一章伏笔连续。`,
                        });
                    }
                    catch (error) {
                        if (await broadcastStoppedIfCancelled(run.id, id))
                            return;
                        const repairError = error instanceof Error ? error.message : String(error);
                        gate = await evaluateGeneratedChapterGate(id, { ...result, status: result.status }, targetScore, { targetWordCount: requestedWordCount });
                        finalResult = { ...gate.result, autoRepairError: repairError };
                        if (gate.needsRepair) {
                            gate.failureReason = `第 ${result.chapterNumber} 章未过质量 Gate，且自动复修失败：${repairError}`;
                            gate.suggestion = "章节正文已保留；请切换更稳定的修稿模型或点击继续复修，后端会从当前章节接续，不会重复写下一章。";
                        }
                    }
                    if (repair) {
                        gate = await evaluateGeneratedChapterGate(id, { ...result, status: result.status }, targetScore, { targetWordCount: requestedWordCount });
                        finalResult = { ...gate.result, autoRepaired: true, repairRunId: repair.runId };
                    }
                }
                const payload = { bookId: id, runId: run.id, ...finalResult, failureReason: gate.failureReason, suggestion: gate.suggestion };
                if (gate.needsRepair) {
                    await appendBookAgentEvent(root, id, "write:needs-repair", payload);
                    await updateTaskRun(root, run.id, { status: "needs-repair", completed: 1, currentAgent: "quality-reporter", currentStage: `第 ${result.chapterNumber} 章未过质量 Gate，等待复修`, results: [finalResult], failureReason: gate.failureReason, suggestion: gate.suggestion }, { kind: "write:needs-repair", stage: `第 ${result.chapterNumber} 章未过质量 Gate`, agent: "quality-reporter", scoreAfter: gate.score });
                    broadcast("write:needs-repair", payload);
                    return;
                }
                await appendBookAgentEvent(root, id, "write:complete", { runId: run.id, chapterNumber: result.chapterNumber, status: result.status, title: result.title, wordCount: result.wordCount, scoreAfter: gate.score, autoRepaired: finalResult.autoRepaired });
                await updateTaskRun(root, run.id, { status: "done", completed: 1, currentAgent: "quality-reporter", currentStage: "章节完成", results: [finalResult] }, { kind: "write:complete", stage: `第 ${result.chapterNumber} 章完成`, agent: "quality-reporter", scoreAfter: gate.score });
                broadcast("write:complete", { bookId: id, runId: run.id, chapterNumber: result.chapterNumber, status: result.status, title: result.title, wordCount: result.wordCount, scoreAfter: gate.score, autoRepaired: finalResult.autoRepaired });
        }).catch(async (e) => { // .then(onF).catch(onR):让 onFulfilled 自身抛错也落进归一处理,不再产生未处理拒绝
            if (await broadcastStoppedIfCancelled(run.id, id))
                return;
            const error = e instanceof Error ? e.message : String(e);
            const failure = failureInfoForActivity("write:error", { error });
            void appendBookAgentEvent(root, id, "write:error", { runId: run.id, error, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion });
            void updateTaskRun(root, run.id, { status: "error", error, failureReason: failure.reason, suggestion: failure.suggestion, currentStage: "写作失败" }, { kind: "write:error", stage: "写作失败", agent: "writer", error, failureReason: failure.reason });
            broadcast("write:error", { bookId: id, runId: run.id, error, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion });
        }).finally(() => {
            stopHeartbeat();
            releaseWriteSlot(id, run.id);
        });
        return c.json({ status: "writing", bookId: id, runId: run.id, run });
    });
    app.post("/api/v1/books/:id/write-batch", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({ wordCount: undefined, chapters: 1 }));
        const origin = new URL(c.req.url).origin;
        const book = await state.loadBookConfig(id).catch(() => null);
        if (!book) {
            return c.json({ error: { code: "BOOK_NOT_FOUND", message: `Book not found: ${id}` }, bookId: id }, 404);
        }
        if (body.ignoreFoundationGate !== true) {
            const foundation = await inspectBookFoundationForWriting(state, id);
            if (!foundation.ok) {
                void appendBookAgentEvent(root, id, "batch:blocked-foundation", { ...foundation, agent: "foundation-reviewer", agentLabel: "建书复审官", stage: foundation.failureReason });
                broadcast("batch:blocked-foundation", { bookId: id, ...foundation });
                return c.json({ bookId: id, ...foundation }, 409);
            }
        }
        const blocked = await prepareWriteSlot(id, { forceTakeover: Boolean(body.forceTakeover) });
        if (blocked)
            return c.json({ ...blocked, bookId: id }, 409);
        const fromChapter = body.fromChapter == null ? undefined : Math.max(1, Number(body.fromChapter) || 0) || undefined;
        const toChapter = body.toChapter == null ? undefined : Math.max(1, Number(body.toChapter) || 0) || undefined;
        const rangeTotal = fromChapter && toChapter && toChapter >= fromChapter ? (toChapter - fromChapter + 1) : 0;
        // 直播/无人值守模式:章数上限放宽到 1000、永不硬停(低分接受继续写)、不被旧章门禁拦截。
        const livestream = body.livestream === true || body.neverStop === true;
        const total = Math.max(1, Math.min(livestream ? 1000 : 100, rangeTotal || Number(body.chapters) || 1));
        const wordCount = Number(body.wordCount ?? body.targetWordsPerChapter) || undefined;
        const _batchBook = await state.loadBookConfig(id).catch(() => null);
        const _batchBookScore = Number(_batchBook?.targetScore || _batchBook?.writing?.targetScore) || 0;
        const targetScore = Math.max(70, Math.min(98, Number(body.targetScore ?? body.targetQuality) || _batchBookScore || 80));
        const maxRewritesPerChapter = Math.max(1, Math.min(REPAIR_MAX_AUTO_ROUNDS, Number(body.maxRewritesPerChapter ?? body.maxAutoRounds) || REPAIR_MAX_AUTO_ROUNDS));
        const autoRepair = body.autoRepair !== false;
        // 轻中重档位:连续写也读 body.mode + 激活等级 → 限档(与单章 write-next 一致;未指定 mode = 既有 max 行为)
        const _activationForBatch = await loadActivation(root).catch(() => null);
        const batchWriteIntensity = resolveWriteIntensity(body.mode || freeTierWriteMode(_activationForBatch), _activationForBatch?.tier);
        if (body.ignoreExistingQualityGate !== true && !livestream) {
            const qualityBlocker = await findExistingQualityGateBlocker(id, targetScore);
            if (qualityBlocker) {
                const payload = qualityGateBlockedPayload(id, qualityBlocker, targetScore, "write-batch");
                void appendBookAgentEvent(root, id, "write:blocked-quality-gate", { ...payload, agent: "quality-reporter", agentLabel: "质量报告官", stage: payload.failureReason });
                broadcast("write:blocked-quality-gate", payload);
                return c.json(payload, 409);
            }
        }
        const run = await createTaskRun(root, { bookId: id, type: "write-batch", wordCount, total, targetScore, targetQuality: targetScore, maxRewritesPerChapter, fromChapter, toChapter, autoRepair, currentAgent: "planner", currentStage: `批量写作进入队列：${total}章` });
        const abortController = new AbortController();
        setWriteSlot(id, run.id, { abortController });
        const stopHeartbeat = startTaskHeartbeat(run.id, "planner", `批量写作工作流运行中：${total}章`);
        void appendBookAgentEvent(root, id, "batch:start", { runId: run.id, total, fromChapter, toChapter, wordCount, targetScore, targetQuality: targetScore, maxRewritesPerChapter, autoRepair });
        broadcast("batch:start", { bookId: id, runId: run.id, total, fromChapter, toChapter, wordCount, targetScore, targetQuality: targetScore, maxRewritesPerChapter, autoRepair });
        (async () => {
            const results = [];
            let consecutiveErrors = 0; // 直播模式:连续瞬时错误计数,达上限才真放弃
            const platformContext = await bookPlatformExternalContext(id);
            for (let i = 0; i < total; i++) {
                try {
                    if (await taskRunIsCancelled(run.id)) {
                        await broadcastStoppedIfCancelled(run.id, id);
                        return;
                    }
                    void updateTaskRun(root, run.id, { status: "running", currentAgent: "state-validator", currentStage: `第 ${i + 1}/${total} 章写作前状态检查`, currentIndex: i + 1, completed: results.length }, { kind: "batch:preflight", stage: `第 ${i + 1}/${total} 章写作前状态检查`, agent: "state-validator" });
                    await repairLatestStateIfNeeded(id, run, `批量写作第 ${i + 1}/${total} 章前自动修复状态链`);
                    if (await taskRunIsCancelled(run.id)) {
                        await broadcastStoppedIfCancelled(run.id, id);
                        return;
                    }
                    const batchChapterNumber = await state.getNextChapterNumber(id);
                    void updateTaskRun(root, run.id, { status: "running", currentAgent: "planner", currentStage: `开始第 ${batchChapterNumber} 章（批次 ${i + 1}/${total}）`, currentChapter: batchChapterNumber, currentIndex: i + 1, completed: results.length }, { kind: "batch:chapter:start", stage: `开始第 ${batchChapterNumber} 章（批次 ${i + 1}/${total}）`, agent: "planner", chapterNumber: batchChapterNumber });
                    broadcast("batch:chapter:start", { bookId: id, runId: run.id, chapterNumber: batchChapterNumber, index: i + 1, total, wordCount });
                    broadcast("write:start", { bookId: id, runId: run.id, chapterNumber: batchChapterNumber, index: i + 1, total });
                    const injectedInstruction = await composeRuntimePromptInstruction(root, id, { chapterNumber: batchChapterNumber, agent: "writer" }, body.instruction || "");
                    const externalContext = mergeExternalContext(platformContext, injectedInstruction, await voiceFingerprintBlock(id), await narrativeCraftBlock(), longOutputSafetyContext({ wordCount, chapters: total, targetScore, mode: "write-batch" }));
                    const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForSSE: id, runIdForSSE: run.id, externalContext, abortSignal: abortController.signal, writeIntensity: batchWriteIntensity }));
                    const result = await pipeline.writeNextChapter(id, wordCount);
                    if (await taskRunIsCancelled(run.id)) {
                        await broadcastStoppedIfCancelled(run.id, id);
                        return;
                    }
                    let gate = await evaluateGeneratedChapterGate(id, result, targetScore, { targetWordCount: wordCount });
                    let finalResult = gate.result;
                    results.push(finalResult);
                    consecutiveErrors = 0; // 本章写出来了,API 正常,瞬时错误计数清零
                    if (gate.needsRepair && autoRepair && Number(result.chapterNumber || 0)) {
                        const startPayload = { bookId: id, runId: run.id, chapterNumber: result.chapterNumber, index: i + 1, total, targetScore, scoreBefore: gate.score, agent: "reviser", agentLabel: "修稿师", stage: `第 ${result.chapterNumber} 章未过 ${targetScore}+，自动复修后再写下一章` };
                        void appendBookAgentEvent(root, id, "batch:auto-repair:start", startPayload);
                        void updateTaskRun(root, run.id, { status: "running", completed: results.length - 1, currentAgent: "reviser", currentStage: startPayload.stage, results }, { kind: "batch:auto-repair:start", stage: startPayload.stage, agent: "reviser", scoreBefore: gate.score });
                        broadcast("batch:auto-repair:start", startPayload);
                        let repair = null;
                        try {
                            repair = await runEmbeddedQualityRepair(origin, id, Number(result.chapterNumber), targetScore, {
                                parentRunId: run.id,
                                abortSignal: abortController.signal,
                                previousScoreAfter: gate.score,
                                previousFailureReason: gate.failureReason,
                                targetWordCount: wordCount,
                                maxAutoRounds: maxRewritesPerChapter,
                                instruction: `批量写作质量门禁：第 ${result.chapterNumber} 章评分 ${gate.score ?? "--"}，必须修到 ${targetScore}+ 才允许继续第 ${i + 2}/${total} 章。修复后要保持前后章节事实、人物状态、伏笔和下一章衔接。`,
                            });
                        }
                        catch (error) {
                            if (await broadcastStoppedIfCancelled(run.id, id))
                                return;
                            const repairError = error instanceof Error ? error.message : String(error);
                            gate = await evaluateGeneratedChapterGate(id, { ...result, status: result.status }, targetScore, { targetWordCount: wordCount });
                            finalResult = { ...gate.result, autoRepairError: repairError };
                            if (gate.needsRepair) {
                                gate.failureReason = `第 ${result.chapterNumber} 章未过质量 Gate，且自动复修失败：${repairError}`;
                                gate.suggestion = "章节正文已保留；请切换更稳定的修稿模型或点击继续复修，批量写作会从当前章节后继续，不会重复生成已完成章节。";
                            }
                        }
                        if (repair) {
                            gate = await evaluateGeneratedChapterGate(id, { ...result, status: result.status }, targetScore, { targetWordCount: wordCount });
                            finalResult = { ...gate.result, autoRepaired: true, repairRunId: repair.runId };
                        }
                        results[results.length - 1] = finalResult;
                    }
                    if (gate.needsRepair) {
                        if (livestream) {
                            // 直播/无人值守:绝不停。接受当前最好版本(已落库)、继续下一章。
                            // 诚实标记 belowTarget(不是假装"人工 approved"):这些章会被 repair-quality-batch(按章号范围扫,不看状态)找到重修,
                            // UI 也能据 belowTarget 显示真相,而不是被当成已确认合格章静默滑坡。
                            try {
                                const _idx = await state.loadChapterIndex(id).catch(() => []);
                                const _list = Array.isArray(_idx) ? _idx : [];
                                const _cn = Number(result.chapterNumber || 0);
                                await state.saveChapterIndex(id, _list.map((ch) => (Number(ch.number ?? ch.chapterNumber) === _cn ? { ...ch, status: "approved", belowTarget: true, acceptedScore: gate.score ?? null, targetScore } : ch)));
                            }
                            catch { /* 标记失败不影响继续写 */ }
                            const acc = { bookId: id, runId: run.id, ...finalResult, index: i + 1, total, score: gate.score, targetScore, acceptedBelowTarget: true };
                            void appendBookAgentEvent(root, id, "write:accepted-below-target", { ...acc, agent: "quality-reporter", agentLabel: "质量报告官", stage: `第 ${result.chapterNumber} 章 ${gate.score ?? "--"} 分未达 ${targetScore}，直播模式已接受、继续下一章` });
                            void updateTaskRun(root, run.id, { status: i + 1 >= total ? "done" : "running", completed: results.length, currentAgent: "quality-reporter", currentStage: `第 ${result.chapterNumber} 章已接受(${gate.score ?? "--"}分)，继续下一章` }, { kind: "write:accepted-below-target", stage: `第 ${result.chapterNumber} 章已接受继续`, agent: "quality-reporter", scoreAfter: gate.score });
                            broadcast("write:accepted-below-target", acc);
                            continue; // 关键:不 return,继续写下一章
                        }
                        const payload = { bookId: id, runId: run.id, ...finalResult, index: i + 1, total, targetScore, failureReason: gate.failureReason, suggestion: gate.suggestion };
                        void appendBookAgentEvent(root, id, "write:needs-repair", payload);
                        void updateTaskRun(root, run.id, { status: "needs-repair", completed: results.length, currentAgent: "quality-reporter", currentStage: `第 ${result.chapterNumber} 章未过质量 Gate，暂停批量写作`, results, failureReason: gate.failureReason, suggestion: gate.suggestion }, { kind: "write:needs-repair", stage: `第 ${result.chapterNumber} 章未过质量 Gate，暂停批量写作`, agent: "quality-reporter", scoreAfter: gate.score });
                        broadcast("write:needs-repair", payload);
                        broadcast("batch:needs-repair", payload);
                        // 总编也对未过门禁的章给裁决(必为返工 + 派工 + 原因),best-effort,不阻塞。
                        if (Number(result.chapterNumber || 0)) {
                            void generateEditorialReviewFor(id, Number(result.chapterNumber)).then((rev) => {
                                if (!rev)
                                    return;
                                const vp = { bookId: id, runId: run.id, chapterNumber: result.chapterNumber, verdict: rev.verdict, editorialScore: rev.editorialScore, rationale: rev.rationale };
                                void appendBookAgentEvent(root, id, "editor-in-chief:verdict", vp);
                                broadcast("editor-in-chief:verdict", vp);
                            }).catch(() => { })
                                // 未过门禁的章也生成交接单页,便于复盘"卡在哪一关、谁该返工"。
                                .finally(() => { void buildChapterHandoff(state, root, id, Number(result.chapterNumber)).catch(() => { }); });
                        }
                        return;
                    }
                    void appendBookAgentEvent(root, id, "write:complete", { runId: run.id, chapterNumber: result.chapterNumber, status: result.status, title: result.title, wordCount: result.wordCount, scoreAfter: gate.score, autoRepaired: finalResult.autoRepaired, index: i + 1, total });
                    void updateTaskRun(root, run.id, { status: i + 1 >= total ? "done" : "running", completed: results.length, currentAgent: "quality-reporter", currentStage: `第 ${result.chapterNumber} 章完成`, results }, { kind: "write:complete", stage: `第 ${result.chapterNumber} 章完成`, agent: "quality-reporter", scoreAfter: gate.score });
                    broadcast("write:complete", { bookId: id, runId: run.id, chapterNumber: result.chapterNumber, status: result.status, title: result.title, wordCount: result.wordCount, scoreAfter: gate.score, autoRepaired: finalResult.autoRepaired, index: i + 1, total });
                    // 总编自动签发本章(挂 skill,best-effort,不阻塞批量写作;失败只记日志不影响继续写)。
                    if (Number(result.chapterNumber || 0)) {
                        void generateEditorialReviewFor(id, Number(result.chapterNumber)).then((rev) => {
                            if (!rev)
                                return;
                            const payload = { bookId: id, runId: run.id, chapterNumber: result.chapterNumber, verdict: rev.verdict, editorialScore: rev.editorialScore, rationale: rev.rationale };
                            void appendBookAgentEvent(root, id, "editor-in-chief:verdict", payload);
                            broadcast("editor-in-chief:verdict", payload);
                        }).catch(() => { })
                            // 总编裁决落盘后,再汇总本章交接(handoff)单页,确保含最新裁决。
                            .finally(() => { void buildChapterHandoff(state, root, id, Number(result.chapterNumber)).catch(() => { }); });
                    }
                }
                catch (e) {
                    if (await broadcastStoppedIfCancelled(run.id, id))
                        return;
                    const error = e instanceof Error ? e.message : String(e);
                    // 直播/无人值守:DeepSeek 超时/限流/网络抖动等瞬时错误 → 退避后重试本章,不终止整批。
                    // 连续 5 次仍失败才认定是真问题(key 失效/额度耗尽)放弃。
                    if (livestream && ++consecutiveErrors <= 5) {
                        const backoff = Math.min(30000, 4000 * consecutiveErrors);
                        void appendBookAgentEvent(root, id, "batch:transient-error", { runId: run.id, error, index: i + 1, total, retry: consecutiveErrors, agent: "guardian", agentLabel: "守护进程", stage: `第 ${i + 1} 章出错(${error.slice(0, 50)})，直播模式退避 ${Math.round(backoff / 1000)}s 重试 ${consecutiveErrors}/5` });
                        broadcast("batch:transient-error", { bookId: id, runId: run.id, error, index: i + 1, total, retry: consecutiveErrors });
                        void updateTaskRun(root, run.id, { status: "running", currentAgent: "guardian", currentStage: `第 ${i + 1} 章瞬时出错，退避重试 ${consecutiveErrors}/5`, completed: results.length }, { kind: "batch:transient-error", stage: `重试 ${consecutiveErrors}/5`, agent: "guardian", error });
                        await new Promise((r) => setTimeout(r, backoff));
                        i--; // 重试同一章位,不消耗章数预算
                        continue;
                    }
                    const failure = failureInfoForActivity("batch:error", { error, index: i + 1, total });
                    void appendBookAgentEvent(root, id, "batch:error", { runId: run.id, error, index: i + 1, total, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion });
                    void updateTaskRun(root, run.id, { status: "error", error, failureReason: failure.reason, suggestion: failure.suggestion, completed: results.length, currentStage: `第 ${i + 1}/${total} 章失败`, results }, { kind: "batch:error", stage: `第 ${i + 1}/${total} 章失败`, agent: "writer", error, failureReason: failure.reason });
                    broadcast("write:error", { bookId: id, runId: run.id, error, index: i + 1, total, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion });
                    broadcast("batch:error", { bookId: id, runId: run.id, error, index: i + 1, total, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion });
                    return;
                }
            }
            // —— 卷级记忆压缩(防长程漂移)——
            // 批量写完(无并发写章,无竞态)后做一次:把"已完成卷"的逐章摘要 LLM 压成 ≤500 字卷摘要 →
            // volume_summaries.md;再把已归档卷的逐章明细移出 chapter_summaries.md(转 summaries_archive/)。
            // 效果:每章注入恒定有界(最近卷逐章 + 历史卷压缩弧线 + 伏笔账 + 检索),既不臃肿、又不丢长程记忆。
            // best-effort:压缩失败(如模型 400/超时)不影响已落库章节,下次批量结束会再尝试。
            await consolidateBookMemory(id, run.id).catch(() => { });
            void appendBookAgentEvent(root, id, "batch:complete", { runId: run.id, total, results });
            void updateTaskRun(root, run.id, { status: "done", completed: total, currentAgent: "quality-reporter", currentStage: "自动工作流完成", results }, { kind: "batch:complete", stage: "自动工作流完成", agent: "quality-reporter" });
            broadcast("batch:complete", { bookId: id, runId: run.id, total, results });
        })().catch(async (e) => {
            if (await broadcastStoppedIfCancelled(run.id, id))
                return;
            const error = e instanceof Error ? e.message : String(e);
            const failure = failureInfoForActivity("batch:error", { error, total });
            void appendBookAgentEvent(root, id, "batch:error", { runId: run.id, error, total, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion });
            void updateTaskRun(root, run.id, { status: "error", error, failureReason: failure.reason, suggestion: failure.suggestion, currentStage: "批量写作队列异常" }, { kind: "batch:error", stage: "批量写作队列异常", agent: "planner", error, failureReason: failure.reason });
            broadcast("batch:error", { bookId: id, runId: run.id, error, total, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion });
        }).finally(() => {
            stopHeartbeat();
            releaseWriteSlot(id, run.id);
        });
        return c.json({ status: "batch-writing", bookId: id, runId: run.id, run: enrichTaskRunForClient(run), total, fromChapter, toChapter, wordCount, targetQuality: targetScore, maxRewritesPerChapter });
    });
    app.post("/api/v1/books/:id/repair-quality-batch", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const origin = new URL(c.req.url).origin;
        const _batchRepairBook = await state.loadBookConfig(id).catch(() => null);
        const _batchRepairScore = Number(_batchRepairBook?.targetScore || _batchRepairBook?.writing?.targetScore) || 0;
        const targetScore = Math.max(70, Math.min(98, Number(body.targetScore) || _batchRepairScore || 80));
        const limit = Math.max(1, Math.min(50, Number(body.limit) || 50));
        const fromChapter = Math.max(1, Number(body.fromChapter) || 1);
        const toChapter = Math.max(fromChapter, Number(body.toChapter) || Number.POSITIVE_INFINITY);
        const continueChapters = Math.max(0, Math.min(20, Number(body.continueChapters) || 0));
        const wordCount = Number(body.wordCount) || undefined;
        if (body.ignoreFoundationGate !== true) {
            const foundation = await inspectBookFoundationForWriting(state, id);
            if (!foundation.ok) {
                void appendBookAgentEvent(root, id, "quality-batch:blocked-foundation", { ...foundation, agent: "foundation-reviewer", agentLabel: "建书复审官", stage: foundation.failureReason });
                broadcast("quality-batch:blocked-foundation", { bookId: id, ...foundation });
                return c.json({ bookId: id, ...foundation }, 409);
            }
        }
        const blocked = await prepareWriteSlot(id, { forceTakeover: Boolean(body.forceTakeover) });
        if (blocked)
            return c.json({ ...blocked, bookId: id }, 409);
        const chapters = (await state.loadChapterIndex(id).catch(() => []))
            .map((chapter) => Number(chapter.chapterNumber || chapter.number || 0))
            .filter((num) => Number.isInteger(num) && num > 0)
            .filter((num) => num >= fromChapter && num <= toChapter)
            .sort((left, right) => left - right)
            .slice(0, limit);
        if (body.ignoreRepairCircuitBreaker !== true) {
            const taskRuns = await loadTaskRuns(root).catch(() => []);
            const historyScopeStartedAt = await historyScopeStartedAtForBook(state, id);
            for (const chapterNumber of chapters) {
                const before = await buildChapterQualityPayload(state, id, chapterNumber).catch(() => null);
                const beforeScore = Number(before?.quality?.total || 0);
                if (before?.quality?.gate?.pass === true && beforeScore >= targetScore)
                    continue;
                const circuit = repairCircuitBreakerDecision(repairHistoryForChapter(taskRuns, id, chapterNumber, "", { createdAfter: historyScopeStartedAt }), targetScore);
                if (circuit.blocked) {
                    return c.json({
                        error: `质量流水线已在第 ${chapterNumber} 章暂停：${circuit.message}`,
                        status: "repair-circuit-open",
                        workflow: "quality-batch-repair",
                        bookId: id,
                        chapterNumber,
                        targetScore,
                        attempts: circuit.attempts,
                        bestScore: circuit.bestScore,
                        latestScore: circuit.latestScore,
                        failureReason: circuit.reason,
                        suggestion: "不要继续批量撞墙。先换模型/修 Key/改提示词或人工处理该章；确认要强行重试时，需要显式传 ignoreRepairCircuitBreaker=true。",
                    }, 409);
                }
            }
        }
        const run = await createTaskRun(root, { bookId: id, type: "quality-batch-repair", total: chapters.length + continueChapters, targetScore, currentAgent: "auditor", currentStage: `质量流水线进入队列：复修 ${chapters.length} 章，续写 ${continueChapters} 章` });
        const abortController = new AbortController();
        setWriteSlot(id, run.id, { abortController });
        const stopHeartbeat = startTaskHeartbeat(run.id, "auditor", `质量流水线运行中：复修 ${chapters.length} 章，续写 ${continueChapters} 章，目标 ${targetScore}+`);
        broadcast("quality-batch:start", { bookId: id, runId: run.id, total: chapters.length + continueChapters, repairTotal: chapters.length, continueChapters, fromChapter, toChapter: Number.isFinite(toChapter) ? toChapter : undefined, targetScore });
        void appendBookAgentEvent(root, id, "quality-batch:start", { runId: run.id, total: chapters.length, continueChapters, fromChapter, toChapter: Number.isFinite(toChapter) ? toChapter : undefined, targetScore });
        (async () => {
            const results = [];
            let completed = 0;
            for (const chapterNumber of chapters) {
                if (await taskRunIsCancelled(run.id)) {
                    await broadcastStoppedIfCancelled(run.id, id);
                    return;
                }
                void updateTaskRun(root, run.id, { status: "running", completed, currentAgent: "auditor", currentStage: `复核第 ${chapterNumber} 章`, currentChapter: chapterNumber, results }, { kind: "quality-batch:check", stage: `复核第 ${chapterNumber} 章`, agent: "auditor" });
                broadcast("quality-batch:check", { bookId: id, runId: run.id, chapterNumber, completed, total: chapters.length + continueChapters, agent: "auditor", agentLabel: "审稿官", stage: `复核第 ${chapterNumber} 章质量 Gate` });
                const before = await buildChapterQualityPayload(state, id, chapterNumber).catch(() => null);
                const beforeScore = Number(before?.quality?.total || 0);
                if (before?.quality?.gate?.pass === true && beforeScore >= targetScore) {
                    await writeStudioChapterQualityReport(state, id, chapterNumber, before, "质量流水线复核：本章已达到目标分，跳过复修。").catch(() => null);
                    results.push({ chapterNumber, skipped: true, scoreBefore: beforeScore, scoreAfter: beforeScore, pass: true });
                    completed++;
                    broadcast("quality-batch:chapter-pass", { bookId: id, runId: run.id, chapterNumber, scoreAfter: beforeScore, completed, total: chapters.length + continueChapters, agent: "quality-reporter", agentLabel: "质量报告官", stage: `第 ${chapterNumber} 章已达标，继续下一章` });
                    continue;
                }
                broadcast("quality-batch:repair", { bookId: id, runId: run.id, chapterNumber, targetScore, scoreBefore: beforeScore, agent: "reviser", agentLabel: "修稿师", stage: `第 ${chapterNumber} 章低于 ${targetScore}+，开始批量复修` });
                let repair = null;
                try {
                    repair = await runEmbeddedQualityRepair(origin, id, chapterNumber, targetScore, {
                        parentRunId: run.id,
                        abortSignal: abortController.signal,
                        previousScoreAfter: beforeScore,
                        previousFailureReason: before?.quality?.reasons?.join("；") || "",
                        instruction: `批量质量复核：前序章节可能已被修订，请把第 ${chapterNumber} 章修到 ${targetScore}+，同时保持与前文修订后的事实、人物状态、伏笔和语气连续。`,
                    });
                }
                catch (error) {
                    if (await broadcastStoppedIfCancelled(run.id, id))
                        return;
                    const repairError = error instanceof Error ? error.message : String(error);
                    const afterFailure = await buildChapterQualityPayload(state, id, chapterNumber).catch(() => before);
                    const scoreAfterFailure = afterFailure?.quality?.total ?? beforeScore;
                    const failureReason = `第 ${chapterNumber} 章自动复修失败，流水线已停在本章等待可恢复复修：${repairError}`;
                    const item = { chapterNumber, skipped: false, repairRunId: "", scoreBefore: beforeScore, scoreAfter: scoreAfterFailure, pass: false, error: repairError };
                    results.push(item);
                    try {
                        const digest = await buildPromptGovernanceDigest(root, state, id, targetScore);
                        await applyPromptGovernanceDigest(root, state, id, digest, targetScore, [`质量流水线复修异常：${failureReason}`]);
                        const payload = { bookId: id, runId: run.id, agent: "prompt-governor", agentLabel: "提示词治理官", stage: "复修异常已压缩进角色提示词", detail: failureReason };
                        broadcast("prompt-governance:applied", payload);
                        void appendBookAgentEvent(root, id, "prompt-governance:applied", payload);
                    }
                    catch (governanceError) {
                        void appendActivityLog(root, "prompt-governance:error", { bookId: id, targetScore, error: governanceError instanceof Error ? governanceError.message : String(governanceError) });
                    }
                    await updateTaskRun(root, run.id, {
                        status: "needs-repair",
                        completed: results.length,
                        currentAgent: "quality-reporter",
                        currentStage: `第 ${chapterNumber} 章自动复修失败，等待继续复修`,
                        currentChapter: chapterNumber,
                        results,
                        failureReason,
                        suggestion: "模型没有产出可落库的完整正文。请检查模型连通性/输出长度，或直接点“连续复修并续写”重试；系统会从本章继续，不会跳过。",
                    }, { kind: "quality-batch:needs-repair", stage: `第 ${chapterNumber} 章自动复修失败`, agent: "quality-reporter", scoreAfter: scoreAfterFailure });
                    broadcast("quality-batch:needs-repair", { bookId: id, runId: run.id, ...item, targetScore, failureReason });
                    void appendBookAgentEvent(root, id, "quality-batch:needs-repair", { bookId: id, runId: run.id, ...item, targetScore, failureReason, agent: "quality-reporter", agentLabel: "质量报告官", stage: `第 ${chapterNumber} 章自动复修失败，等待继续复修` });
                    return;
                }
                if (await taskRunIsCancelled(run.id)) {
                    await broadcastStoppedIfCancelled(run.id, id);
                    return;
                }
                const after = await buildChapterQualityPayload(state, id, chapterNumber).catch(() => repair.qualityAfter || null);
                const item = {
                    chapterNumber,
                    skipped: false,
                    repairRunId: repair.runId,
                    scoreBefore: beforeScore,
                    scoreAfter: after?.quality?.total ?? repair.scoreAfter,
                    pass: after?.quality?.gate?.pass === true,
                    targetScore,
                    autoRounds: repair.autoRounds,
                    engine: repair.engine,
                    changes: Array.isArray(repair.changes) ? repair.changes.slice(0, 8) : [],
                    warnings: Array.isArray(repair.warnings) ? repair.warnings.slice(0, 6) : [],
                };
                results.push(item);
                if (!item.pass || Number(item.scoreAfter || 0) < targetScore) {
                    const failureReason = `第 ${chapterNumber} 章批量复修后仍未达到 ${targetScore}+：${item.scoreAfter ?? "--"} 分。`;
                    try {
                        const digest = await buildPromptGovernanceDigest(root, state, id, targetScore);
                        await applyPromptGovernanceDigest(root, state, id, digest, targetScore, [`质量流水线暂停：${failureReason}`]);
                        const payload = { bookId: id, runId: run.id, agent: "prompt-governor", agentLabel: "提示词治理官", stage: "复修失败经验已压缩进角色提示词", detail: failureReason };
                        broadcast("prompt-governance:applied", payload);
                        void appendBookAgentEvent(root, id, "prompt-governance:applied", payload);
                    }
                    catch (error) {
                        void appendActivityLog(root, "prompt-governance:error", { bookId: id, targetScore, error: error instanceof Error ? error.message : String(error) });
                    }
                    await updateTaskRun(root, run.id, { status: "needs-repair", completed: results.length, currentAgent: "quality-reporter", currentStage: `第 ${chapterNumber} 章仍未达标，质量流水线暂停`, currentChapter: chapterNumber, results, failureReason, suggestion: "该章已达到自动复修上限但仍未达标；请检查模型能力、章节目标字数或人工调整后再继续流水线。" }, { kind: "quality-batch:needs-repair", stage: `第 ${chapterNumber} 章仍未达标`, agent: "quality-reporter", scoreAfter: item.scoreAfter });
                    broadcast("quality-batch:needs-repair", { bookId: id, runId: run.id, ...item, targetScore, failureReason });
                    return;
                }
                completed++;
                broadcast("quality-batch:chapter-pass", { bookId: id, runId: run.id, ...item, completed, total: chapters.length + continueChapters, agent: "quality-reporter", agentLabel: "质量报告官", stage: `第 ${chapterNumber} 章复修达标，继续下一章` });
            }
            const lessons = qualityLessonsFromResults(results, targetScore);
            if (lessons) {
                const notesPath = join(state.bookDir(id), "story", "human_notes.md");
                await mkdir(dirname(notesPath), { recursive: true });
                const prev = await readOptionalText(notesPath);
                await writeFile(notesPath, [prev, lessons].filter(Boolean).join("\n\n"), "utf-8");
                broadcast("quality-batch:lessons", { bookId: id, runId: run.id, agent: "quality-reporter", agentLabel: "质量报告官", stage: "复修经验已写入后续创作备注", detail: `已吸收 ${results.filter((r) => !r.skipped).length} 章复修经验` });
            }
            if (results.some((r) => !r.skipped)) {
                try {
                    const digest = await buildPromptGovernanceDigest(root, state, id, targetScore);
                    await applyPromptGovernanceDigest(root, state, id, digest, targetScore, []);
                    const payload = { bookId: id, runId: run.id, agent: "prompt-governor", agentLabel: "提示词治理官", stage: "复修经验已压缩进角色提示词", detail: `已治理 ${Object.keys(digest.promptPatches || {}).length} 类角色提示词` };
                    broadcast("prompt-governance:applied", payload);
                    void appendBookAgentEvent(root, id, "prompt-governance:applied", payload);
                }
                catch (error) {
                    void appendActivityLog(root, "prompt-governance:error", { bookId: id, targetScore, error: error instanceof Error ? error.message : String(error) });
                }
            }
            if (continueChapters > 0 && body.ignoreExistingQualityGate !== true) {
                const remainingBlocker = await findExistingQualityGateBlocker(id, targetScore);
                if (remainingBlocker) {
                    const payload = qualityGateBlockedPayload(id, remainingBlocker, targetScore, "quality-batch-continue");
                    await updateTaskRun(root, run.id, { status: "needs-repair", completed, currentAgent: "quality-reporter", currentStage: `第 ${remainingBlocker.chapterNumber} 章仍未达标，已阻止续写`, currentChapter: remainingBlocker.chapterNumber, results, failureReason: payload.failureReason, suggestion: payload.suggestion }, { kind: "quality-batch:blocked-quality-gate", stage: `第 ${remainingBlocker.chapterNumber} 章未过质量 Gate，阻止续写`, agent: "quality-reporter", scoreAfter: remainingBlocker.score });
                    broadcast("quality-batch:blocked-quality-gate", payload);
                    void appendBookAgentEvent(root, id, "quality-batch:blocked-quality-gate", { ...payload, runId: run.id, agent: "quality-reporter", agentLabel: "质量报告官", stage: payload.failureReason });
                    return;
                }
            }
            if (continueChapters > 0) {
                const platformContext = await bookPlatformExternalContext(id);
                for (let i = 0; i < continueChapters; i++) {
                    if (await taskRunIsCancelled(run.id)) {
                        await broadcastStoppedIfCancelled(run.id, id);
                        return;
                    }
                    const index = i + 1;
                    const existingChapterNumbers = (await state.loadChapterIndex(id).catch(() => []))
                        .map((chapter) => Number(chapter.chapterNumber || chapter.number || 0))
                        .filter((num) => Number.isInteger(num) && num > 0);
                    const nextChapterNumber = existingChapterNumbers.length ? Math.max(...existingChapterNumbers) + 1 : 1;
                    void updateTaskRun(root, run.id, { status: "running", completed, currentAgent: "planner", currentStage: `复修完成，继续写第 ${nextChapterNumber} 章（后续第 ${index}/${continueChapters} 章）`, currentChapter: nextChapterNumber, currentIndex: index, results }, { kind: "quality-batch:write:start", stage: `继续写第 ${nextChapterNumber} 章（后续第 ${index}/${continueChapters} 章）`, agent: "planner" });
                    broadcast("quality-batch:write:start", { bookId: id, runId: run.id, chapterNumber: nextChapterNumber, index, total: continueChapters, completed, agent: "planner", agentLabel: "规划师", stage: `复修经验已吸收，开始写第 ${nextChapterNumber} 章（后续第 ${index}/${continueChapters} 章）` });
                    const injectedInstruction = await composeRuntimePromptInstruction(root, id, { chapterNumber: nextChapterNumber, agent: "writer" }, body.instruction || "");
                    const externalContext = mergeExternalContext(platformContext, injectedInstruction, await voiceFingerprintBlock(id), await narrativeCraftBlock(), longOutputSafetyContext({ wordCount, chapters: continueChapters, targetScore, mode: "quality-batch-continue" }));
                    const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForSSE: id, runIdForSSE: run.id, externalContext, abortSignal: abortController.signal }));
                    const result = await pipeline.writeNextChapter(id, wordCount);
                    if (await taskRunIsCancelled(run.id)) {
                        await broadcastStoppedIfCancelled(run.id, id);
                        return;
                    }
                    let gate = await evaluateGeneratedChapterGate(id, result, targetScore, { targetWordCount: wordCount });
                    let finalResult = gate.result;
                    if (gate.needsRepair && Number(result.chapterNumber || 0)) {
                        broadcast("quality-batch:write-repair", { bookId: id, runId: run.id, chapterNumber: result.chapterNumber, index, total: continueChapters, scoreBefore: gate.score, agent: "reviser", agentLabel: "修稿师", stage: `新写第 ${result.chapterNumber} 章未过 ${targetScore}+，自动复修后再继续` });
                        let repair = null;
                        try {
                            repair = await runEmbeddedQualityRepair(origin, id, Number(result.chapterNumber), targetScore, {
                                parentRunId: run.id,
                                abortSignal: abortController.signal,
                                previousScoreAfter: gate.score,
                                previousFailureReason: gate.failureReason,
                                targetWordCount: wordCount,
                                instruction: `质量流水线后续写作：第 ${result.chapterNumber} 章首稿评分 ${gate.score ?? "--"}，请吸收前面复修经验，修到 ${targetScore}+ 后才允许继续。`,
                            });
                        }
                        catch (error) {
                            if (await broadcastStoppedIfCancelled(run.id, id))
                                return;
                            const repairError = error instanceof Error ? error.message : String(error);
                            gate = await evaluateGeneratedChapterGate(id, { ...result, status: result.status }, targetScore, { targetWordCount: wordCount });
                            finalResult = { ...gate.result, autoRepairError: repairError };
                            if (gate.needsRepair) {
                                gate.failureReason = `后续第 ${result.chapterNumber} 章未过质量 Gate，且自动复修失败：${repairError}`;
                                gate.suggestion = "章节正文已保留；流水线会停在当前章节等待可恢复复修，不会继续烧 token 或跳过问题章节。";
                            }
                        }
                        if (repair) {
                            gate = await evaluateGeneratedChapterGate(id, { ...result, status: result.status }, targetScore, { targetWordCount: wordCount });
                            finalResult = { ...gate.result, autoRepaired: true, repairRunId: repair.runId };
                        }
                    }
                    results.push({ ...finalResult, generated: true });
                    completed++;
                    if (gate.needsRepair) {
                        const failureReason = `后续第 ${result.chapterNumber} 章自动复修后仍未达到 ${targetScore}+：${gate.score ?? "--"} 分。`;
                        await updateTaskRun(root, run.id, { status: "needs-repair", completed, currentAgent: "quality-reporter", currentStage: `后续第 ${result.chapterNumber} 章仍未达标，质量流水线暂停`, currentChapter: result.chapterNumber, results, failureReason, suggestion: gate.suggestion }, { kind: "quality-batch:needs-repair", stage: `后续第 ${result.chapterNumber} 章仍未达标`, agent: "quality-reporter", scoreAfter: gate.score });
                        broadcast("quality-batch:needs-repair", { bookId: id, runId: run.id, ...finalResult, targetScore, failureReason });
                        return;
                    }
                    broadcast("write:complete", { bookId: id, runId: run.id, chapterNumber: result.chapterNumber, status: result.status, title: result.title, wordCount: result.wordCount, scoreAfter: gate.score, autoRepaired: finalResult.autoRepaired, index, total: continueChapters });
                }
            }
            await updateTaskRun(root, run.id, { status: "done", completed, currentAgent: "quality-reporter", currentStage: `质量流水线完成：复修 ${chapters.length} 章，续写 ${continueChapters} 章`, results }, { kind: "quality-batch:complete", stage: "质量流水线完成", agent: "quality-reporter" });
            broadcast("quality-batch:complete", { bookId: id, runId: run.id, total: completed, repairTotal: chapters.length, continueChapters, targetScore, results });
        })().catch(async (e) => {
            if (await broadcastStoppedIfCancelled(run.id, id))
                return;
            const error = e instanceof Error ? e.message : String(e);
            const failure = failureInfoForActivity("quality-batch:error", { error, total: chapters.length });
            await updateTaskRun(root, run.id, { status: "error", error, failureReason: failure.reason, suggestion: failure.suggestion, currentStage: "批量质量复核失败" }, { kind: "quality-batch:error", stage: "批量质量复核失败", agent: "quality-reporter", error, failureReason: failure.reason });
            broadcast("quality-batch:error", { bookId: id, runId: run.id, error, failureReason: failure.reason, impact: failure.impact, suggestion: failure.suggestion });
        }).finally(() => {
            stopHeartbeat();
            releaseWriteSlot(id, run.id);
        });
        return c.json({ status: "quality-batch-repairing", bookId: id, runId: run.id, run, total: chapters.length + continueChapters, repairTotal: chapters.length, continueChapters, targetScore });
    });
    app.post("/api/v1/books/:id/draft", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({ wordCount: undefined, context: undefined }));
        broadcast("draft:start", { bookId: id });
        const pipeline = new PipelineRunner(await buildPipelineConfig());
        pipeline.writeDraft(id, body.context, body.wordCount).then((result) => {
            broadcast("draft:complete", { bookId: id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
        }, (e) => {
            broadcast("draft:error", { bookId: id, error: e instanceof Error ? e.message : String(e) });
        });
        return c.json({ status: "drafting", bookId: id });
    });
    app.post("/api/v1/books/:id/chapters/:num/approve", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        if (!Number.isInteger(num) || num <= 0) // 防 NaN/非法章号被静默当成功
            return c.json({ error: "Invalid chapter number" }, 400);
        try {
            const index = await state.loadChapterIndex(id);
            const list = Array.isArray(index) ? index : []; // 防 index.json 非数组(损坏)直接抛
            if (!list.some((ch) => ch.number === num)) // 不存在的章不要假成功
                return c.json({ error: `Chapter ${num} not found` }, 404);
            const updated = list.map((ch) => ch.number === num ? { ...ch, status: "approved" } : ch);
            await state.saveChapterIndex(id, updated);
            return c.json({ ok: true, chapterNumber: num, status: "approved" });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // 一键放行：把所有 score >= targetScore 的章节批量 approve，解除质量门禁阻塞。
    // 前端「续写被挡住」提示里可直接调这个，无需逐章手动操作。
    app.post("/api/v1/books/:id/chapters/approve-qualifying", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const bookCfg = await state.loadBookConfig(id).catch(() => null);
        const bookScore = Number(bookCfg?.targetScore || bookCfg?.writing?.targetScore) || 0;
        const threshold = Math.max(70, Math.min(98, Number(body.targetScore) || bookScore || 80));
        try {
            const index = await state.loadChapterIndex(id);
            const list = Array.isArray(index) ? index : [];
            const approved = [];
            const updated = await Promise.all(list.map(async (ch) => {
                if (ch.status === "approved") return ch;
                // 读该章质量分
                const payload = await buildChapterQualityPayload(state, id, ch.number ?? ch.chapterNumber).catch(() => null);
                const score = Number(payload?.quality?.total ?? 0);
                if (score >= threshold) {
                    approved.push({ chapterNumber: ch.number ?? ch.chapterNumber, score });
                    return { ...ch, status: "approved" };
                }
                return ch;
            }));
            await state.saveChapterIndex(id, updated);
            return c.json({ ok: true, threshold, approved, total: approved.length });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    app.post("/api/v1/books/:id/chapters/:num/reject", async (c) => {
        const id = c.req.param("id");
        const num = parseInt(c.req.param("num"), 10);
        try {
            const index = await state.loadChapterIndex(id);
            const target = index.find((ch) => ch.number === num);
            if (!target) {
                return c.json({ error: `Chapter ${num} not found` }, 404);
            }
            const rollbackTarget = num - 1;
            const discarded = await state.rollbackToChapter(id, rollbackTarget);
            return c.json({
                ok: true,
                chapterNumber: num,
                status: "rejected",
                rolledBackTo: rollbackTarget,
                discarded,
            });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- SSE ---
    app.get("/api/v1/events", (c) => {
        return streamSSE(c, async (stream) => {
            const handler = (event, data) => {
                stream.writeSSE({ event, data: JSON.stringify(data) });
            };
            subscribers.add(handler);
            await stream.writeSSE({ event: "ping", data: "" });
            // Keep alive
            const keepAlive = setInterval(() => {
                stream.writeSSE({ event: "ping", data: "" });
            }, 30000);
            stream.onAbort(() => {
                subscribers.delete(handler);
                clearInterval(keepAlive);
            });
            // Block until aborted
            await new Promise(() => { });
        });
    });
    // --- Model discovery ---
    app.get("/api/v1/services", async (c) => {
        const secrets = await loadSecrets(root);
        const endpoints = getAllEndpoints().filter((ep) => ep.id !== "custom");
        // Fast: only check connection status from secrets, no external API calls.
        const services = endpoints.map((ep) => ({
            service: ep.id,
            label: ep.label,
            group: ep.group,
            connected: Boolean(secrets.services[ep.id]?.apiKey),
        }));
        // Add custom services from hardwrite.json
        try {
            const config = await loadRawConfig(root);
            for (const svc of normalizeServiceConfig(config.llm?.services)) {
                if (svc.service === "custom") {
                    const secretKey = `custom:${svc.name}`;
                    services.push({
                        service: secretKey,
                        label: svc.name ?? "Custom",
                        group: undefined,
                        baseUrl: svc.baseUrl ?? "",
                        apiFormat: svc.apiFormat ?? "chat",
                        stream: svc.stream !== false,
                        connected: Boolean(secrets.services[secretKey]?.apiKey),
                    });
                }
            }
        }
        catch { /* no config file */ }
        return c.json({ services });
    });
    app.get("/api/v1/services/config", async (c) => {
        const config = await loadRawConfig(root);
        const llm = config.llm ?? {};
        const services = normalizeServiceConfig(llm.services);
        const envConfig = await readEnvConfigStatus(root);
        return c.json({
            services,
            service: typeof llm.service === "string" ? llm.service : null,
            defaultModel: llm.defaultModel ?? null,
            configSource: "studio",
            storedConfigSource: normalizeConfigSource(llm.configSource),
            envConfig,
        });
    });
    app.put("/api/v1/services/config", async (c) => {
        const body = await c.req.json();
        const config = await loadRawConfig(root);
        config.llm = config.llm ?? {};
        const llm = config.llm;
        if (body.services !== undefined) {
            const existingServices = normalizeServiceConfig(llm.services);
            const incomingServices = normalizeServiceConfig(body.services);
            llm.services = mergeServiceConfig(existingServices, incomingServices);
        }
        if (body.defaultModel !== undefined) {
            llm.defaultModel = body.defaultModel;
            if (typeof body.defaultModel === "string" && body.defaultModel.trim()) {
                llm.model = body.defaultModel.trim();
            }
        }
        if (body.configSource === "env") {
            return c.json({
                error: "Studio 运行时不支持切换到 env；env 只在 CLI/daemon/部署运行时作为覆盖层使用。",
            }, 400);
        }
        if (body.configSource !== undefined) {
            llm.configSource = normalizeConfigSource(body.configSource);
        }
        if (body.service !== undefined) {
            llm.service = body.service;
            const entry = normalizeServiceConfig(llm.services).find((serviceEntry) => serviceConfigKey(serviceEntry) === body.service);
            const resolvedBaseUrl = entry?.baseUrl ?? resolveServicePreset(body.service)?.baseUrl;
            if (resolvedBaseUrl) {
                llm.baseUrl = resolvedBaseUrl;
            }
            llm.provider = isCustomServiceId(body.service) ? "openai" : (resolveServiceProviderFamily(body.service) ?? llm.provider ?? "openai");
        }
        await saveRawConfig(root, config);
        return c.json({ ok: true });
    });
    app.post("/api/v1/services/:service/test", async (c) => {
        const service = c.req.param("service");
        const { apiKey, baseUrl, apiFormat, stream } = await c.req.json();
        const savedSecrets = await loadSecrets(root).catch(() => ({ services: {} }));
        const effectiveApiKey = apiKey?.trim() || savedSecrets.services?.[service]?.apiKey || "";
        const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service, baseUrl);
        if (!resolvedBaseUrl) {
            return c.json({ ok: false, error: `未知服务商: ${service}` }, 400);
        }
        const baseService = isCustomServiceId(service) ? "custom" : service;
        const apiKeyOptional = isApiKeyOptionalForEndpoint({
            provider: resolveServiceProviderFamily(baseService) ?? "openai",
            baseUrl: resolvedBaseUrl,
        });
        if (!effectiveApiKey && !apiKeyOptional) {
            return c.json({ ok: false, error: "API Key 不能为空" }, 400);
        }
        const rawConfig = await loadRawConfig(root).catch(() => ({}));
        const llm = rawConfig.llm ?? {};
        const probe = await probeServiceCapabilities({
            root,
            service,
            apiKey: effectiveApiKey,
            baseUrl: resolvedBaseUrl,
            preferredApiFormat: apiFormat,
            preferredStream: stream,
            proxyUrl: typeof llm.proxyUrl === "string" ? llm.proxyUrl : undefined,
        });
        // B12: 升级响应 shape 为 { probe, chat, ... }，同时保留老字段供 UI 过渡期兼容
        const probeStatus = {
            ok: probe.ok,
            models: probe.models?.length ?? 0,
            ...(probe.ok ? {} : { error: probe.error ?? "连接失败" }),
        };
        if (!probe.ok) {
            return c.json({
                ok: false,
                error: probe.error ?? "连接失败",
                probe: probeStatus,
                chat: null,
            }, 400);
        }
        return c.json({
            ok: true,
            modelCount: probe.models.length,
            models: probe.models,
            selectedModel: probe.selectedModel,
            detected: {
                apiFormat: probe.apiFormat,
                stream: probe.stream,
                baseUrl: probe.baseUrl,
                modelsSource: probe.modelsSource,
            },
            // B12 新字段：两步验证状态
            probe: probeStatus,
            chat: null, // probeServiceCapabilities 本身只做 probe，chat hello 在 Studio 的 follow-up 调用里单独触发
        });
    });
    app.put("/api/v1/services/:service/secret", async (c) => {
        const service = c.req.param("service");
        const { apiKey } = await c.req.json();
        const secrets = await loadSecrets(root);
        if (apiKey?.trim()) {
            secrets.services[service] = { apiKey: apiKey.trim() };
        }
        else {
            delete secrets.services[service];
        }
        await saveSecrets(root, secrets);
        return c.json({ ok: true });
    });
    app.get("/api/v1/services/:service/secret", async (c) => {
        // 安全:apiKey 一律 write-only,GET 绝不回明文(否则任意网页/同网机可跨域 GET 窃取 BYOK 密钥)。
        // 只回"是否已配置 + 末4位掩码",供前端做"已配置"指示与回填占位。写入仍走 PUT。
        const service = c.req.param("service");
        const secrets = await loadSecrets(root);
        const key = secrets.services[service]?.apiKey ?? "";
        return c.json({
            hasKey: Boolean(key),
            masked: key ? `••••${key.slice(-4)}` : "",
        });
    });
    app.get("/api/v1/services/models", async (c) => {
        const secrets = await loadSecrets(root);
        const endpoints = getAllEndpoints()
            .filter((ep) => ep.id !== "custom" && Boolean(secrets.services[ep.id]?.apiKey));
        const groups = endpoints.map((ep) => ({
            service: ep.id,
            label: ep.label,
            models: ep.models
                .filter((m) => m.enabled !== false)
                .filter((m) => isTextChatModelId(m.id))
                .map((m) => ({
                id: m.id,
                name: m.id,
                ...(typeof m.maxOutput === "number" ? { maxOutput: m.maxOutput } : {}),
                ...(m.contextWindowTokens > 0 ? { contextWindow: m.contextWindowTokens } : {}),
            })),
        }));
        return c.json({ groups });
    });
    app.get("/api/v1/services/models/custom", async (c) => {
        const secrets = await loadSecrets(root);
        let config = {};
        try {
            config = await loadRawConfig(root);
        }
        catch {
            // no config file
        }
        const customs = normalizeServiceConfig(config.llm?.services)
            .filter((s) => s.service === "custom")
            .map((s) => ({
            id: `custom:${s.name ?? "Custom"}`,
            baseUrl: s.baseUrl ?? "",
            label: s.name ?? "Custom",
        }))
            .filter((s) => s.baseUrl && Boolean(secrets.services[s.id]?.apiKey));
        const groups = await Promise.all(customs.map(async (s) => ({
            service: s.id,
            label: s.label,
            models: s.id === XIAOMI_MIMO_SERVICE_ID
                ? mergeModelLists(filterTextChatModels(await probeModelsFromUpstream(s.baseUrl, secrets.services[s.id].apiKey, 10_000).catch(() => [])), XIAOMI_MIMO_TEXT_MODELS)
                : filterTextChatModels(await probeModelsFromUpstream(s.baseUrl, secrets.services[s.id].apiKey, 10_000)),
        })));
        return c.json({ groups });
    });
    app.get("/api/v1/models", async (c) => {
        const secrets = await loadSecrets(root);
        const configured = normalizeServiceConfig((await loadRawConfig(root).catch(() => ({}))).llm?.services);
        const presetGroups = getAllEndpoints()
            .filter((ep) => ep.id !== "custom")
            .map((ep) => ({
            service: ep.id,
            label: ep.label,
            connected: Boolean(secrets.services?.[ep.id]?.apiKey),
            baseUrl: configured.find((item) => serviceConfigKey(item) === ep.id)?.baseUrl ?? ep.baseUrl ?? "",
            models: ep.models
                .filter((m) => m.enabled !== false)
                .filter((m) => isTextChatModelId(m.id))
                .map((m) => ({
                id: m.id,
                name: m.name ?? m.id,
                ...(typeof m.maxOutput === "number" ? { maxOutput: m.maxOutput } : {}),
                ...(m.contextWindowTokens > 0 ? { contextWindow: m.contextWindowTokens } : {}),
            })),
        }));
        const customGroups = configured
            .filter((service) => service.service === "custom")
            .map((service) => {
            const id = `custom:${service.name ?? "Custom"}`;
            return {
                service: id,
                label: service.name ?? "Custom",
                connected: Boolean(secrets.services?.[id]?.apiKey),
                baseUrl: service.baseUrl ?? "",
                models: [],
            };
        });
        return c.json({ groups: [...presetGroups, ...customGroups] });
    });
    const buildLLMProvidersPayload = async () => {
        const secrets = await loadSecrets(root);
        const raw = await loadRawConfig(root).catch(() => ({}));
        const llm = raw.llm ?? {};
        const configured = normalizeServiceConfig(llm.services);
        const activeService = typeof llm.service === "string" ? llm.service : typeof llm.provider === "string" ? llm.provider : "";
        const defaultModel = typeof llm.defaultModel === "string" ? llm.defaultModel : typeof llm.model === "string" ? llm.model : "";
        const providers = getAllEndpoints()
            .filter((ep) => ep.id !== "custom")
            .map((ep) => {
            const config = configured.find((item) => serviceConfigKey(item) === ep.id);
            const enabled = activeService === ep.id || activeService.startsWith(`${ep.id}:`);
            const builtinModelIds = ep.models
                .filter((m) => m.enabled !== false)
                .filter((m) => isTextChatModelId(m.id))
                .map((m) => m.id)
                .slice(0, 40);
            const modelIds = builtinModelIds.length > 0 ? builtinModelIds : fallbackModelIdsForEndpoint(ep.id);
            const configuredModel = typeof config?.model === "string" ? config.model : "";
            const selectedModel = enabled && defaultModel ? defaultModel : configuredModel || modelIds[0] || "";
            return {
                id: ep.id,
                name: ep.label,
                kind: resolveServiceProviderFamily(ep.id) ?? ep.id,
                baseUrl: config?.baseUrl ?? ep.baseUrl ?? "",
                hasKey: Boolean(secrets.services?.[ep.id]?.apiKey),
                enabled,
                selectedModel,
                models: modelIds
                    .concat(selectedModel ? [selectedModel] : [])
                    .filter((model, index, array) => model && array.indexOf(model) === index),
            };
        });
        for (const service of configured.filter((item) => item.service === "custom")) {
            const id = `custom:${service.name ?? "Custom"}`;
            const configuredModel = typeof service.model === "string" ? service.model : "";
            const selectedModel = activeService === id && defaultModel ? defaultModel : configuredModel;
            providers.push({
                id,
                name: service.name ?? "Custom",
                kind: "custom",
                baseUrl: service.baseUrl ?? "",
                hasKey: Boolean(secrets.services?.[id]?.apiKey),
                enabled: activeService === id,
                selectedModel,
                models: selectedModel ? [selectedModel] : [],
            });
        }
        return providers;
    };
    app.get("/api/v1/llm-providers", async (c) => {
        return c.json(await buildLLMProvidersPayload());
    });
    app.post("/api/v1/llm-providers", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return c.json({ error: "invalid body" }, 400);
        }
        const rawName = typeof body.name === "string" ? body.name.trim() : "";
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
        const model = typeof body.model === "string"
            ? body.model.trim()
            : Array.isArray(body.models) && typeof body.models[0] === "string"
                ? body.models[0].trim()
                : "";
        if (!rawName)
            return c.json({ error: "Provider name is required" }, 400);
        if (!baseUrl)
            return c.json({ error: "Base URL is required" }, 400);
        const safeName = rawName.replace(/^custom:/, "").trim().slice(0, 80);
        const id = isCustomServiceId(rawName) ? rawName : `custom:${safeName}`;
        const config = await loadRawConfig(root).catch(() => ({}));
        config.llm = config.llm ?? {};
        const llm = config.llm;
        const existing = normalizeServiceConfig(llm.services);
        if (existing.some((entry) => serviceConfigKey(entry) === id)) {
            return c.json({ error: `Provider "${safeName}" already exists` }, 409);
        }
        llm.services = mergeServiceConfig(existing, [
            normalizeServiceEntry(id, {
                baseUrl,
                ...(model ? { model } : {}),
                apiFormat: body.apiFormat === "responses" ? "responses" : "chat",
                stream: body.stream !== false,
            }),
        ]);
        if (model) {
            llm.defaultModel = model;
            llm.model = model;
        }
        if (body.enabled !== false) {
            llm.service = id;
            llm.provider = "openai";
            llm.baseUrl = baseUrl;
        }
        await saveRawConfig(root, config);
        if (typeof body.apiKey === "string" && body.apiKey.trim()) {
            const secrets = await loadSecrets(root);
            secrets.services[id] = { apiKey: body.apiKey.trim() };
            await saveSecrets(root, secrets);
        }
        const provider = (await buildLLMProvidersPayload()).find((item) => item.id === id);
        return c.json(provider ?? {
            id,
            name: safeName,
            kind: "custom",
            baseUrl,
            hasKey: Boolean(typeof body.apiKey === "string" && body.apiKey.trim()),
            enabled: body.enabled !== false,
            selectedModel: model,
            models: model ? [model] : [],
        }, 201);
    });
    app.post("/api/v1/llm-providers/:id/test", async (c) => {
        const service = c.req.param("id");
        const startedAt = Date.now();
        const body = await c.req.json().catch(() => ({}));
        const savedSecrets = await loadSecrets(root).catch(() => ({ services: {} }));
        const effectiveApiKey = typeof body?.apiKey === "string" && body.apiKey.trim()
            ? body.apiKey.trim()
            : savedSecrets.services?.[service]?.apiKey || "";
        const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service, typeof body?.baseUrl === "string" ? body.baseUrl : undefined);
        if (!resolvedBaseUrl) {
            return c.json({ ok: false, latencyMs: Date.now() - startedAt, error: `未知服务商: ${service}` }, 400);
        }
        const baseService = isCustomServiceId(service) ? "custom" : service;
        const apiKeyOptional = isApiKeyOptionalForEndpoint({
            provider: resolveServiceProviderFamily(baseService) ?? "openai",
            baseUrl: resolvedBaseUrl,
        });
        if (!effectiveApiKey && !apiKeyOptional) {
            return c.json({ ok: false, latencyMs: Date.now() - startedAt, error: "API Key 不能为空" }, 400);
        }
        const rawConfig = await loadRawConfig(root).catch(() => ({}));
        const probe = await probeServiceCapabilities({
            root,
            service,
            apiKey: effectiveApiKey,
            baseUrl: resolvedBaseUrl,
            preferredApiFormat: body?.apiFormat,
            preferredStream: body?.stream,
            proxyUrl: typeof rawConfig.llm?.proxyUrl === "string" ? rawConfig.llm.proxyUrl : undefined,
        });
        return c.json({
            ok: probe.ok,
            latencyMs: Date.now() - startedAt,
            error: probe.ok ? undefined : probe.error ?? "连接失败",
            modelCount: probe.models?.length ?? 0,
            models: probe.models ?? [],
            selectedModel: probe.selectedModel,
        }, probe.ok ? 200 : 400);
    });
    app.get("/api/v1/llm-providers/:id", async (c) => {
        const id = c.req.param("id");
        const provider = (await buildLLMProvidersPayload()).find((item) => item.id === id);
        if (!provider)
            return c.json({ error: "not found" }, 404);
        return c.json(provider);
    });
    app.patch("/api/v1/llm-providers/:id", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return c.json({ error: "invalid body" }, 400);
        }
        if (typeof body.apiKey === "string") {
            const secrets = await loadSecrets(root);
            if (body.apiKey.trim()) {
                secrets.services[id] = { apiKey: body.apiKey.trim() };
            }
            else {
                delete secrets.services[id];
            }
            await saveSecrets(root, secrets);
        }
        const config = await loadRawConfig(root);
        config.llm = config.llm ?? {};
        const llm = config.llm;
        const serviceUpdates: Record<string, unknown> = {};
        if (typeof body.baseUrl === "string")
            serviceUpdates.baseUrl = body.baseUrl.trim();
        if (typeof body.temperature === "number")
            serviceUpdates.temperature = body.temperature;
        if (body.apiFormat === "chat" || body.apiFormat === "responses")
            serviceUpdates.apiFormat = body.apiFormat;
        if (typeof body.stream === "boolean")
            serviceUpdates.stream = body.stream;
        const selectedModel = Array.isArray(body.models) && typeof body.models[0] === "string"
            ? body.models[0]
            : typeof body.model === "string"
                ? body.model
                : undefined;
        if (selectedModel) {
            serviceUpdates.model = selectedModel;
            llm.defaultModel = selectedModel;
            llm.model = selectedModel;
        }
        if (Object.keys(serviceUpdates).length) {
            llm.services = mergeServiceConfig(normalizeServiceConfig(llm.services), [normalizeServiceEntry(id, serviceUpdates)]);
        }
        if (body.enabled !== false) {
            llm.service = id;
            llm.provider = isCustomServiceId(id) ? "openai" : (resolveServiceProviderFamily(id) ?? llm.provider ?? "openai");
            const entry = normalizeServiceConfig(llm.services).find((serviceEntry) => serviceConfigKey(serviceEntry) === id);
            const resolvedBaseUrl = entry?.baseUrl ?? resolveServicePreset(id)?.baseUrl;
            if (resolvedBaseUrl)
                llm.baseUrl = resolvedBaseUrl;
            // provider 切换自愈:把指向"非新激活 service"的 per-agent 模型路由回收到全局,
            // 避免旧 provider 钉死的 per-agent 覆盖让写作流水线继续连已停用的模型(保留 temperature/提示词等非路由字段)。
            const stripAgentRouting = (obj) => {
                if (obj && typeof obj === "object")
                    for (const key of ["model", "service", "serviceName", "baseUrl", "provider", "apiFormat"])
                        delete obj[key];
            };
            // modelOverrides 的 schema 要求每条是 string 或含 model 的对象;剥离 model 后若空壳(只剩 temperature 等)
            // 必须整条删除,否则配置校验失败。agentProfiles 允许无 model(保留 promptPatch 等),只剥路由字段。
            const mo = config.modelOverrides;
            if (mo && typeof mo === "object") {
                for (const [agent, value] of Object.entries(mo)) {
                    const svc = value && typeof value === "object" ? value.service : undefined;
                    if (svc && normalizeAgentService(svc, id) !== id) {
                        stripAgentRouting(value);
                        if (!value || typeof value !== "object" || !value.model)
                            delete mo[agent];
                    }
                }
            }
            const ap = config.agentProfiles;
            if (ap && typeof ap === "object") {
                for (const value of Object.values(ap)) {
                    const svc = value && typeof value === "object" ? value.service : undefined;
                    if (svc && normalizeAgentService(svc, id) !== id)
                        stripAgentRouting(value);
                }
            }
        }
        else if (llm.service === id) {
            llm.service = "";
        }
        await saveRawConfig(root, config);
        const provider = (await buildLLMProvidersPayload()).find((item) => item.id === id);
        if (!provider)
            return c.json({ error: "not found" }, 404);
        return c.json(provider);
    });
    app.get("/api/v1/services/:service/models", async (c) => {
        const service = c.req.param("service");
        const refresh = c.req.query("refresh") === "1";
        const secrets = await loadSecrets(root);
        // 安全:API Key 改从请求头读,不再走 query string —— query 会进访问日志/浏览器历史/代理,等于把密钥写在 URL 上泄露。
        // 主路径仍是后端已存的密钥(secrets);仅"保存前先拉模型列表"这种临时密钥用 header 传。
        const apiKey = c.req.header("x-llm-api-key") || secrets.services[service]?.apiKey || "";
        const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service);
        const baseService = isCustomServiceId(service) ? "custom" : service;
        const apiKeyOptional = isApiKeyOptionalForEndpoint({
            provider: resolveServiceProviderFamily(baseService) ?? "openai",
            baseUrl: resolvedBaseUrl,
        });
        // No key = no models, except local/self-hosted endpoints such as Ollama.
        if (!apiKey && !apiKeyOptional)
            return c.json({ models: [] });
        // Cache by service + resolved baseUrl + apiKey fingerprint; valid for 10 min unless ?refresh=1
        const cacheKey = `${service}::${resolvedBaseUrl ?? ""}::${apiKey.slice(-8)}`;
        if (!refresh) {
            const cached = modelListCache.get(cacheKey);
            if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
                return c.json({ models: cached.models });
            }
        }
        // B13: 走 listModelsForService 走 live probe + bank 交叉，返回带元数据的 models
        const enriched = await listModelsForService(isCustomServiceId(service) ? "custom" : service, apiKey, isCustomServiceId(service) ? resolvedBaseUrl ?? undefined : undefined);
        let models = filterTextChatModels(enriched).map((m) => ({
            id: m.id,
            name: m.name,
            ...(m.maxOutput !== undefined ? { maxOutput: m.maxOutput } : {}),
            ...(m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
        }));
        if (service === XIAOMI_MIMO_SERVICE_ID) {
            models = mergeModelLists(models, XIAOMI_MIMO_TEXT_MODELS);
        }
        modelListCache.set(cacheKey, { models, at: Date.now() });
        return c.json({ models });
    });
    // --- Project info ---
    app.get("/api/v1/project", async (c) => {
        const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
        // Check if language was explicitly set in hardwrite.json (not just the schema default)
        const raw = JSON.parse(await readFile(join(root, "hardwrite.json"), "utf-8"));
        const languageExplicit = "language" in raw && raw.language !== "";
        return c.json({
            name: currentConfig.name,
            language: currentConfig.language,
            languageExplicit,
            model: currentConfig.llm.model,
            provider: currentConfig.llm.provider,
            baseUrl: currentConfig.llm.baseUrl,
            stream: currentConfig.llm.stream,
            temperature: currentConfig.llm.temperature,
        });
    });
    const projectPrefsPayload = async () => {
        const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
        const raw = await loadRawConfig(root).catch(() => ({}));
        return {
            project: {
                name: currentConfig.name,
                language: currentConfig.language,
                locale: String(currentConfig.language || raw.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh-CN",
                model: currentConfig.llm?.model,
                provider: currentConfig.llm?.provider,
                service: currentConfig.llm?.service,
                baseUrl: currentConfig.llm?.baseUrl,
                stream: currentConfig.llm?.stream,
                temperature: currentConfig.llm?.temperature,
            },
            defaultRun: {
                targetWordsPerChapter: Number(raw.chapterWordCount || raw.targetChapterWords || raw.wordCount || 3000),
                targetQuality: Number(raw.qualityGate?.targetScore || raw.targetQuality || 80),
                maxRewritesPerChapter: Number(raw.qualityGate?.maxRewritesPerChapter || raw.maxRewritesPerChapter || 2),
            },
            notify: {
                onChapterDone: raw.notify?.onChapterDone !== false,
                onRunFailed: raw.notify?.onRunFailed !== false,
                onLowQuality: raw.notify?.onLowQuality !== false,
            },
            theme: raw.studio?.theme || "system",
        };
    };
    app.get("/api/v1/project/prefs", async (c) => {
        return c.json(await projectPrefsPayload());
    });
    app.patch("/api/v1/project/prefs", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return c.json({ error: "invalid body" }, 400);
        }
        const raw = await loadRawConfig(root);
        const project = body.project && typeof body.project === "object" && !Array.isArray(body.project) ? body.project : {};
        const defaultRun = body.defaultRun && typeof body.defaultRun === "object" && !Array.isArray(body.defaultRun) ? body.defaultRun : body;
        const locale = typeof body.locale === "string" ? body.locale : typeof project.locale === "string" ? project.locale : "";
        if (locale) {
            raw.language = locale.toLowerCase().startsWith("en") ? "en" : "zh";
        }
        const targetWords = Number(defaultRun.targetWordsPerChapter ?? defaultRun.targetWords ?? defaultRun.wordCount);
        if (Number.isFinite(targetWords) && targetWords > 0) {
            raw.chapterWordCount = Math.round(targetWords);
        }
        const targetQuality = Number(defaultRun.targetQuality ?? defaultRun.targetScore);
        if (Number.isFinite(targetQuality) && targetQuality > 0) {
            raw.qualityGate = raw.qualityGate ?? {};
            raw.qualityGate.targetScore = Math.round(targetQuality);
        }
        const maxRewrites = Number(defaultRun.maxRewritesPerChapter ?? defaultRun.maxRewrites);
        if (Number.isFinite(maxRewrites) && maxRewrites >= 0) {
            raw.qualityGate = raw.qualityGate ?? {};
            raw.qualityGate.maxRewritesPerChapter = Math.round(maxRewrites);
        }
        if (body.notify && typeof body.notify === "object" && !Array.isArray(body.notify)) {
            raw.notify = { ...(raw.notify ?? {}), ...body.notify };
        }
        if (typeof body.theme === "string") {
            raw.studio = { ...(raw.studio ?? {}), theme: body.theme };
        }
        await saveRawConfig(root, raw);
        return c.json(await projectPrefsPayload());
    });
    app.get("/api/v1/settings", async (c) => {
        const [project, raw, secrets] = await Promise.all([
            loadCurrentProjectConfig({ requireApiKey: false }),
            loadRawConfig(root).catch(() => ({})),
            loadSecrets(root).catch(() => ({ services: {} })),
        ]);
        const llm = raw.llm ?? {};
        return c.json({
            project: {
                name: project.name,
                language: project.language,
                model: project.llm?.model,
                provider: project.llm?.provider,
                service: project.llm?.service,
                baseUrl: project.llm?.baseUrl,
                stream: project.llm?.stream,
                temperature: project.llm?.temperature,
            },
            llm: {
                service: typeof llm.service === "string" ? llm.service : null,
                defaultModel: llm.defaultModel ?? llm.model ?? null,
                services: normalizeServiceConfig(llm.services).map((service) => {
                    const id = serviceConfigKey(service);
                    return {
                        ...service,
                        hasKey: Boolean(secrets.services?.[id]?.apiKey),
                    };
                }),
            },
            studio: raw.studio ?? {},
        });
    });
    // --- Config editing ---
    app.put("/api/v1/project", async (c) => {
        const updates = await c.req.json();
        const configPath = join(root, "hardwrite.json");
        try {
            const raw = await readFile(configPath, "utf-8");
            const existing = JSON.parse(raw);
            // Merge LLM settings
            if (!existing.llm || typeof existing.llm !== "object") existing.llm = {}; // 防精简/损坏的 hardwrite.json 缺 llm 键时赋值崩 500
            if (updates.temperature !== undefined) {
                existing.llm.temperature = updates.temperature;
            }
            if (updates.stream !== undefined) {
                existing.llm.stream = updates.stream;
            }
            if (updates.language === "zh" || updates.language === "en") {
                existing.language = updates.language;
            }
            await atomicWriteFile(configPath, JSON.stringify(existing, null, 2)); // 原子写 hardwrite.json,防写撕裂砖掉项目
            return c.json({ ok: true });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Truth files browser ---
    app.get("/api/v1/books/:id/truth", async (c) => {
        const id = c.req.param("id");
        const bookDir = state.bookDir(id);
        const storyDir = join(bookDir, "story");
        async function listDir(subdir) {
            try {
                const entries = await readdir(join(storyDir, subdir));
                return entries.filter((f) => f.endsWith(".md") || f.endsWith(".json"));
            }
            catch {
                return [];
            }
        }
        // Hotfix: only tag shim files as legacy when the book has the new layout.
        const { isNewLayoutBook } = await import("@juanshe/core");
        const newLayout = await isNewLayoutBook(bookDir);
        async function describe(relPath) {
            try {
                const content = await readFile(join(storyDir, relPath), "utf-8");
                const isShim = LEGACY_SHIM_FILES.has(relPath) && newLayout;
                const entry = isShim
                    ? { name: relPath, size: content.length, preview: content.slice(0, 200), legacy: true }
                    : { name: relPath, size: content.length, preview: content.slice(0, 200) };
                return entry;
            }
            catch {
                return null;
            }
        }
        try {
            // Flat story/ files (legacy + runtime logs)
            const flatFiles = (await listDir(".")).filter((f) => !f.startsWith("outline") && !f.startsWith("roles"));
            // Phase 5 outline/ files
            const outlineFiles = (await listDir("outline")).map((f) => `outline/${f}`);
            // Phase 5 roles/主要角色 + roles/次要角色, plus Phase hotfix 3
            // English-locale equivalents so en-language books are visible.
            const majorRolesZh = (await listDir("roles/主要角色")).map((f) => `roles/主要角色/${f}`);
            const minorRolesZh = (await listDir("roles/次要角色")).map((f) => `roles/次要角色/${f}`);
            const majorRolesEn = (await listDir("roles/major")).map((f) => `roles/major/${f}`);
            const minorRolesEn = (await listDir("roles/minor")).map((f) => `roles/minor/${f}`);
            const all = [
                ...flatFiles,
                ...outlineFiles,
                ...majorRolesZh,
                ...minorRolesZh,
                ...majorRolesEn,
                ...minorRolesEn,
            ];
            const described = await Promise.all(all.map(describe));
            const result = described.filter((x) => x !== null);
            return c.json({ files: result });
        }
        catch {
            return c.json({ files: [] });
        }
    });
    // --- Daemon control ---
    let schedulerInstance = null;
    app.get("/api/v1/daemon", async (c) => {
        await releaseStaleTaskRunsFromTable().catch(() => false);
        const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false }).catch(() => null);
        const runs = await loadTaskRuns(root).catch(() => []);
        const activeRunRows = [];
        for (const run of runs) {
            if (!isDaemonActiveTaskRunStatus(run.status))
                continue;
            if (run.bookId && !(await bookExists(run.bookId)))
                continue;
            activeRunRows.push(run);
            if (activeRunRows.length >= 20)
                break;
        }
        const activeRuns = activeRunRows.map(enrichTaskRunForClient);
        const activeBookLocks = [];
        for (const [bookId, job] of activeWriteJobs.entries()) {
            if (!(await bookExists(bookId))) {
                activeWriteJobs.delete(bookId);
                continue;
            }
            activeBookLocks.push({
                bookId,
                runId: job.runId,
                startedAt: job.startedAt,
                startedBeijingTime: formatBeijingDateTime(new Date(job.startedAt).toISOString()),
            });
        }
        return c.json({
            running: schedulerInstance?.isRunning ?? false,
            maxConcurrentBooks: currentConfig?.daemon?.maxConcurrentBooks ?? 1,
            chaptersPerCycle: currentConfig?.daemon?.chaptersPerCycle ?? 1,
            maxChaptersPerDay: currentConfig?.daemon?.maxChaptersPerDay ?? 0,
            writeCron: currentConfig?.daemon?.schedule?.writeCron ?? "",
            activeBookLocks,
            activeRuns,
        });
    });
    app.post("/api/v1/daemon/start", async (c) => {
        if (schedulerInstance?.isRunning) {
            return c.json({ error: "Daemon already running" }, 400);
        }
        try {
            const { Scheduler } = await import("@juanshe/core");
            const currentConfig = await loadCurrentProjectConfig();
            const scheduler = new Scheduler({
                ...(await buildPipelineConfig()),
                radarCron: currentConfig.daemon.schedule.radarCron,
                writeCron: currentConfig.daemon.schedule.writeCron,
                maxConcurrentBooks: currentConfig.daemon.maxConcurrentBooks,
                chaptersPerCycle: currentConfig.daemon.chaptersPerCycle,
                retryDelayMs: currentConfig.daemon.retryDelayMs,
                cooldownAfterChapterMs: currentConfig.daemon.cooldownAfterChapterMs,
                maxChaptersPerDay: currentConfig.daemon.maxChaptersPerDay,
                onChapterComplete: (bookId, chapter, status) => {
                    broadcast("daemon:chapter", { bookId, chapter, status });
                },
                onError: (bookId, error) => {
                    broadcast("daemon:error", { bookId, error: error.message });
                },
            });
            schedulerInstance = scheduler;
            broadcast("daemon:started", {});
            void scheduler.start().catch((e) => {
                const error = e instanceof Error ? e : new Error(String(e));
                if (schedulerInstance === scheduler) {
                    scheduler.stop();
                    schedulerInstance = null;
                    broadcast("daemon:stopped", {});
                }
                broadcast("daemon:error", { bookId: "scheduler", error: error.message });
            });
            return c.json({ ok: true, running: true });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    app.post("/api/v1/daemon/stop", (c) => {
        if (!schedulerInstance?.isRunning) {
            return c.json({ error: "Daemon not running" }, 400);
        }
        schedulerInstance.stop();
        schedulerInstance = null;
        broadcast("daemon:stopped", {});
        return c.json({ ok: true, running: false });
    });
    // --- Logs ---
    app.get("/api/v1/logs", async (c) => {
        return c.json({ entries: await readActivityEntries(root, 200) });
    });
    // --- Agent chat ---
    app.get("/api/v1/interaction/session", async (c) => {
        const session = await loadProjectSession(root);
        const activeBookId = await resolveSessionActiveBook(root, session);
        return c.json({
            session: activeBookId && session.activeBookId !== activeBookId
                ? { ...session, activeBookId }
                : session,
            activeBookId,
        });
    });
    // -- Per-book session endpoints --
    app.get("/api/v1/sessions", async (c) => {
        const bookId = c.req.query("bookId");
        const sessions = await listBookSessions(root, bookId === undefined ? null : bookId === "null" ? null : bookId);
        return c.json({ sessions });
    });
    app.get("/api/v1/sessions/:sessionId", async (c) => {
        const sessionId = c.req.param("sessionId");
        if (!/^[0-9]+-[a-z0-9]+$/.test(sessionId)) // 同 POST:防 ../ 路径穿越读任意 .jsonl
            return c.json({ error: "Invalid session id" }, 400);
        const session = await loadBookSession(root, sessionId);
        if (!session)
            return c.json({ error: "Session not found" }, 404);
        return c.json({ session });
    });
    app.post("/api/v1/sessions", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const bookId = normalizeApiBookId(body.bookId, "bookId");
        const sessionId = body.sessionId;
        // sessionId 只允许 timestamp-random 格式；防止注入任意文件名
        const safeSessionId = sessionId && /^[0-9]+-[a-z0-9]+$/.test(sessionId) ? sessionId : undefined;
        const session = await createAndPersistBookSession(root, bookId, safeSessionId);
        return c.json({ session });
    });
    app.put("/api/v1/sessions/:sessionId", async (c) => {
        const sessionId = c.req.param("sessionId");
        if (!/^[0-9]+-[a-z0-9]+$/.test(sessionId)) // 防 ../ 路径穿越
            return c.json({ error: "Invalid session id" }, 400);
        const body = await c.req.json().catch(() => ({}));
        const title = body.title?.trim();
        if (!title) {
            throw new ApiError(400, "INVALID_SESSION_TITLE", "Session title is required");
        }
        const session = await renameBookSession(root, sessionId, title);
        if (!session) {
            return c.json({ error: "Session not found" }, 404);
        }
        return c.json({ session });
    });
    app.delete("/api/v1/sessions/:sessionId", async (c) => {
        const sessionId = c.req.param("sessionId");
        if (!/^[0-9]+-[a-z0-9]+$/.test(sessionId)) // 防 ../ 路径穿越删任意 .jsonl/.json
            return c.json({ error: "Invalid session id" }, 400);
        await deleteBookSession(root, sessionId);
        return c.json({ ok: true });
    });
    app.post("/api/v1/agent", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const { instruction, activeBookId, sessionId: reqSessionId, model: reqModel, service: reqService } = body;
        let sessionId = typeof reqSessionId === "string" ? reqSessionId.trim() : "";
        if (!instruction?.trim()) {
            return c.json({ error: "No instruction provided" }, 400);
        }
        if (!sessionId) {
            const bootSession = await createAndPersistBookSession(root, normalizeApiBookId(activeBookId, "activeBookId"));
            sessionId = bootSession.sessionId;
        }
        if (reqModel && !isTextChatModelId(reqModel)) {
            const message = nonTextModelMessage(reqModel);
            return c.json({ error: message, response: message }, 400);
        }
        broadcast("agent:start", { instruction, activeBookId, sessionId });
        try {
            // Load config + create LLM client (pipeline created after model resolution)
            const config = await loadCurrentProjectConfig({ requireApiKey: false });
            const client = createLLMClient(config.llm);
            let loadedBookSession = await loadBookSession(root, sessionId);
            if (!loadedBookSession) {
                // 传入的 sessionId 不存在(常见于前端从 interactionSession 拿到的占位/旧会话 id)→
                // 不硬报错,自动新建一个绑定当前作品的会话,让对话能继续(与上面 !sessionId 分支一致)。
                const staleSessionId = sessionId;
                const bootSession = await createAndPersistBookSession(root, normalizeApiBookId(activeBookId, "activeBookId"));
                sessionId = bootSession.sessionId;
                broadcast("agent:session-recreated", { previousSessionId: staleSessionId, sessionId, activeBookId });
                loadedBookSession = await loadBookSession(root, sessionId);
            }
            if (!loadedBookSession) {
                throw new ApiError(404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
            }
            let bookSession = loadedBookSession;
            const requestedActiveBookId = normalizeApiBookId(activeBookId, "activeBookId");
            const persistedBookId = normalizeApiBookId(bookSession.bookId, "session.bookId");
            if (requestedActiveBookId
                && persistedBookId
                && persistedBookId !== requestedActiveBookId) {
                throw new ApiError(409, "SESSION_BOOK_MISMATCH", `Session ${bookSession.sessionId} is bound to ${persistedBookId}, not ${requestedActiveBookId}`);
            }
            const agentBookId = requestedActiveBookId ?? persistedBookId;
            if (agentBookId) {
                try {
                    await state.loadBookConfig(agentBookId);
                }
                catch {
                    throw new ApiError(404, "BOOK_NOT_FOUND", `Book not found: ${agentBookId}`);
                }
            }
            const streamSessionId = loadedBookSession.sessionId;
            const titleBeforeRun = bookSession.title;
            let sessionTitleBroadcasted = false;
            const refreshBookSessionFromTranscript = async () => {
                const refreshed = await loadBookSession(root, bookSession.sessionId);
                if (refreshed) {
                    bookSession = refreshed;
                }
                if (!sessionTitleBroadcasted && titleBeforeRun === null && bookSession.title) {
                    broadcast("session:title", { sessionId: bookSession.sessionId, title: bookSession.title });
                    sessionTitleBroadcasted = true;
                }
            };
            // Resolve model — multi-service resolution
            let resolvedModel;
            let resolvedApiKey;
            if (reqService && reqModel) {
                // 1. Frontend explicitly selected a service+model — fail loudly if no key
                try {
                    const configuredEntry = await resolveConfiguredServiceEntry(root, reqService);
                    const resolved = await resolveServiceModel(reqService, reqModel, root, await resolveConfiguredServiceBaseUrl(root, reqService), configuredEntry?.apiFormat);
                    resolvedModel = resolved.model;
                    resolvedApiKey = resolved.apiKey;
                }
                catch (e) {
                    const msg = e?.message ?? String(e);
                    if (/API key/i.test(msg)) {
                        return c.json({
                            error: `请先为 ${reqService} 配置 API Key`,
                            response: `请先在模型配置中为 ${reqService} 填写 API Key，然后再试。`,
                        }, 400);
                    }
                    throw e;
                }
            }
            if (!resolvedModel) {
                // 2. Try defaultModel from new config format
                const rawConfig = config.llm;
                const defaultModel = rawConfig.defaultModel;
                const servicesArr = normalizeServiceConfig(rawConfig.services);
                const firstService = servicesArr[0];
                if (firstService?.service && defaultModel && isTextChatModelId(defaultModel)) {
                    try {
                        const resolved = await resolveServiceModel(serviceConfigKey(firstService), defaultModel, root, firstService.baseUrl, firstService.apiFormat);
                        resolvedModel = resolved.model;
                        resolvedApiKey = resolved.apiKey;
                    }
                    catch { /* fall through */ }
                }
            }
            if (!resolvedModel) {
                // 3. Try first connected service from secrets
                const secrets = await loadSecrets(root);
                for (const [svcName, svcData] of Object.entries(secrets.services)) {
                    if (svcData?.apiKey) {
                        try {
                            const models = await listModelsForService(svcName, svcData.apiKey);
                            const textModels = filterTextChatModels(models);
                            if (textModels.length > 0) {
                                const configuredEntry = await resolveConfiguredServiceEntry(root, svcName);
                                const resolved = await resolveServiceModel(svcName, textModels[0].id, root, await resolveConfiguredServiceBaseUrl(root, svcName), configuredEntry?.apiFormat);
                                resolvedModel = resolved.model;
                                resolvedApiKey = resolved.apiKey;
                                break;
                            }
                        }
                        catch { /* try next */ }
                    }
                }
            }
            if (!resolvedModel) {
                // 4. Legacy fallback: use createLLMClient
                resolvedModel = client._piModel
                    ? client._piModel
                    : { provider: config.llm.provider ?? "anthropic", modelId: config.llm.model };
                resolvedApiKey = client._apiKey;
            }
            const model = resolvedModel;
            const agentApiKey = resolvedApiKey;
            const configuredEntry = reqService ? await resolveConfiguredServiceEntry(root, reqService) : undefined;
            // Create pipeline with resolved model (so sub_agent tools use the frontend-selected model)
            // Don't spread config.llm — its baseUrl/provider belong to the old service.
            // Let createLLMClient resolve baseUrl from the service preset.
            const pipelineClient = (reqService && reqModel && resolvedModel)
                ? createLLMClient({
                    ...config.llm,
                    service: configuredEntry?.service ?? reqService,
                    model: reqModel,
                    apiKey: resolvedApiKey ?? "",
                    ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
                    ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
                    baseUrl: configuredEntry?.baseUrl ?? "",
                })
                : client;
            const pipeline = new PipelineRunner(await buildPipelineConfig({
                client: pipelineClient,
                model: reqModel ?? config.llm.model,
                currentConfig: config,
                sessionIdForSSE: bookSession.sessionId,
            }));
            if (agentBookId && isWriteNextInstruction(instruction)) {
                const activeRun = await findActiveBookRun(agentBookId);
                const activeRunLabel = activeRun ? `当前已有 ${activeRun.type || "写作"} 任务 ${activeRun.id || ""} 正在运行` : "";
                const message = activeRun
                    ? `《${agentBookId}》${activeRunLabel}。为了避免继续写作和本书 AI 对话并发写同一本书，聊天窗口不会再启动写作；请等当前流水线完成，或在工作台使用“检查并继续/继续写作”。`
                    : `为了避免本书 AI 对话绕过质量流水线并把写作流卡住，写作类指令请使用工作台的“继续写作”按钮；这个聊天窗口只负责讨论、诊断、修改设定和给出建议。`;
                broadcast("agent:error", {
                    instruction,
                    activeBookId: agentBookId,
                    sessionId: bookSession.sessionId,
                    error: message,
                    nonFatal: true,
                    code: activeRun ? "BOOK_WRITE_IN_PROGRESS" : "WRITE_FROM_CHAT_DISABLED",
                });
                return c.json({
                    response: message,
                    error: { code: activeRun ? "BOOK_WRITE_IN_PROGRESS" : "WRITE_FROM_CHAT_DISABLED", message },
                    session: { sessionId: bookSession.sessionId, activeBookId: agentBookId },
                    activeRun: activeRun ? {
                        id: activeRun.id,
                        type: activeRun.type,
                        status: activeRun.status,
                        currentAgent: activeRun.currentAgent,
                        currentStage: activeRun.currentStage,
                        heartbeatAgeMs: runHeartbeatAgeMs(activeRun),
                    } : undefined,
                }, activeRun ? 409 : 400);
            }
            const agentSessionPipeline = agentBookId ? Object.create(pipeline) : pipeline;
            if (agentBookId) {
                agentSessionPipeline.writeNextChapter = async () => {
                    const activeRun = await findActiveBookRun(agentBookId);
                    const activeRunText = activeRun ? `当前已有 ${activeRun.type || "写作"} 任务 ${activeRun.id || ""} 正在运行。` : "";
                    throw new Error(`${activeRunText}本书 AI 对话已禁止直接启动写作；请使用工作台“继续写作/连续复修并续写”，这样才能走任务锁、质量 Gate 和断点恢复。`);
                };
                agentSessionPipeline.reviseDraft = async (bookId, chapterNumber, mode) => {
                    const targetBookId = normalizeApiBookId(bookId, "bookId") ?? agentBookId;
                    const activeRun = await findActiveBookRun(targetBookId);
                    if (activeRun) {
                        throw new Error(`《${targetBookId}》当前已有 ${activeRun.type || "写作"} 任务 ${activeRun.id || ""} 正在运行。本书 AI 对话不会并发整章复修，避免覆盖流水线正文。`);
                    }
                    return pipeline.reviseDraft(bookId, chapterNumber, mode);
                };
            }
            // Run pi-agent session
            const collectedToolExecs = [];
            const effectiveInstruction = agentBookId
                ? await composeRuntimePromptInstruction(root, agentBookId, { agent: "assistant" }, instruction)
                : instruction;
            const result = await runAgentSession({
                model,
                apiKey: agentApiKey,
                pipeline: agentSessionPipeline,
                projectRoot: root,
                bookId: agentBookId,
                sessionId: bookSession.sessionId,
                language: config.language ?? "zh",
                // 改写护栏:本书有写作任务在跑时,拦住会直接动作品文件的工具(改设定/改名/局部改正文/裸文件写),
                // 避免和流水线并发撞车(覆盖正文或读到中间态)。抛错会被包装成给"猫"看的友好提示。
                mutationGuard: agentBookId
                    ? async (op) => {
                        const activeRun = await findActiveBookRun(agentBookId);
                        if (activeRun) {
                            throw new Error(`《${agentBookId}》当前有 ${activeRun.type || "写作"} 任务 ${activeRun.id || ""} 正在运行;为了不和流水线撞车（覆盖正文/设定），这会儿先不动「${op}」。等它写完，或先去工作台停掉那个任务，我再帮你改。`);
                        }
                    }
                    : undefined,
                onEvent: (event) => {
                    if (event.type === "message_update") {
                        const ame = event.assistantMessageEvent;
                        if (ame.type === "text_delta") {
                            broadcast("draft:delta", { sessionId: streamSessionId, text: ame.delta });
                        }
                        else if (ame.type === "thinking_delta") {
                            broadcast("thinking:delta", { sessionId: streamSessionId, text: ame.delta });
                        }
                        else if (ame.type === "thinking_start") {
                            broadcast("thinking:start", { sessionId: streamSessionId });
                        }
                        else if (ame.type === "thinking_end") {
                            broadcast("thinking:end", { sessionId: streamSessionId });
                        }
                    }
                    if (event.type === "tool_execution_start") {
                        const args = event.args;
                        const agent = event.toolName === "sub_agent" ? args?.agent : undefined;
                        const stages = agent ? (PIPELINE_STAGES[agent] ?? []) : [];
                        collectedToolExecs.push({
                            id: event.toolCallId,
                            tool: event.toolName,
                            agent,
                            label: resolveToolLabel(event.toolName, agent),
                            status: "running",
                            args,
                            stages: stages.length > 0
                                ? stages.map(l => ({ label: l, status: "pending" }))
                                : undefined,
                            startedAt: Date.now(),
                        });
                        if (!agentBookId && event.toolName === "sub_agent" && agent === "architect") {
                            const bookId = resolveArchitectBookIdFromArgs(args);
                            if (bookId) {
                                const title = typeof args?.title === "string" && args.title.trim()
                                    ? args.title.trim()
                                    : bookId;
                                bookCreateStatus.set(bookId, { status: "creating" });
                                broadcast("book:creating", { bookId, title, sessionId: streamSessionId });
                            }
                        }
                        broadcast("tool:start", {
                            sessionId: streamSessionId,
                            id: event.toolCallId,
                            tool: event.toolName,
                            args,
                            stages,
                        });
                    }
                    if (event.type === "tool_execution_update") {
                        broadcast("tool:update", {
                            sessionId: streamSessionId,
                            tool: event.toolName,
                            partialResult: event.partialResult,
                        });
                    }
                    if (event.type === "tool_execution_end") {
                        const exec = collectedToolExecs.find(t => t.id === event.toolCallId);
                        if (exec) {
                            exec.status = event.isError ? "error" : "completed";
                            exec.completedAt = Date.now();
                            exec.stages = exec.stages?.map(s => ({ ...s, status: "completed" }));
                            if (event.isError)
                                exec.error = extractToolError(event.result);
                            else
                                exec.result = summarizeResult(event.result);
                            exec.details = event.result?.details;
                            if (event.isError &&
                                !agentBookId &&
                                exec.tool === "sub_agent" &&
                                exec.agent === "architect") {
                                const bookId = resolveArchitectBookIdFromArgs(exec.args);
                                if (bookId) {
                                    const error = exec.error ?? "Book creation failed";
                                    bookCreateStatus.set(bookId, { status: "error", error });
                                    broadcast("book:error", { bookId, sessionId: streamSessionId, error });
                                }
                            }
                        }
                        broadcast("tool:end", {
                            sessionId: streamSessionId,
                            id: event.toolCallId,
                            tool: event.toolName,
                            result: event.result,
                            isError: event.isError,
                        });
                    }
                },
            }, effectiveInstruction);
            if (result.responseText) {
                const actionExecutionError = validateAgentActionExecution({
                    instruction,
                    agentBookId,
                    responseText: result.responseText,
                    collectedToolExecs,
                });
                if (actionExecutionError) {
                    return c.json({
                        error: { code: "AGENT_ACTION_NOT_EXECUTED", message: actionExecutionError },
                        response: actionExecutionError,
                    }, 502);
                }
            }
            let broadcastedCreatedBookId = null;
            const finalizeCreatedBook = async () => {
                if (agentBookId)
                    return null;
                const createdBookId = resolveCreatedBookIdFromToolExecs(collectedToolExecs);
                if (!createdBookId)
                    return null;
                if (broadcastedCreatedBookId === createdBookId)
                    return createdBookId;
                try {
                    const migratedSession = await migrateBookSession(root, bookSession.sessionId, createdBookId);
                    if (migratedSession) {
                        bookSession = migratedSession;
                    }
                }
                catch (e) {
                    if (!(e instanceof SessionAlreadyMigratedError)) {
                        throw e;
                    }
                }
                await ensureOpeningPublishingAssets(state, root, createdBookId).catch(() => null);
                const book = await loadStudioBookListSummary(state, createdBookId).catch(() => undefined);
                bookCreateStatus.delete(createdBookId);
                broadcast("book:created", {
                    bookId: createdBookId,
                    sessionId: bookSession.sessionId,
                    ...(book ? { book } : {}),
                });
                broadcastedCreatedBookId = createdBookId;
                return createdBookId;
            };
            if (!result.responseText) {
                if (result.errorMessage) {
                    if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
                        await finalizeCreatedBook();
                    }
                    return c.json({
                        error: { code: "AGENT_LLM_ERROR", message: result.errorMessage },
                        response: result.errorMessage,
                    }, 502);
                }
                try {
                    const fallbackClient = createLLMClient({
                        ...config.llm,
                        service: configuredEntry?.service ?? reqService ?? config.llm.service,
                        model: reqModel ?? config.llm.model,
                        apiKey: agentApiKey ?? config.llm.apiKey,
                        baseUrl: configuredEntry?.baseUrl ?? "",
                        ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
                        ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
                    });
                    const fallback = await chatCompletion(fallbackClient, reqModel ?? config.llm.model, [
                        { role: "system", content: buildAgentSystemPrompt(agentBookId, config.language ?? "zh") },
                        { role: "user", content: instruction },
                    ], { maxTokens: 256 });
                    if (fallback.content?.trim()) {
                        const actionExecutionError = validateAgentActionExecution({
                            instruction,
                            agentBookId,
                            responseText: fallback.content,
                            collectedToolExecs,
                        });
                        if (actionExecutionError) {
                            return c.json({
                                error: { code: "AGENT_ACTION_NOT_EXECUTED", message: actionExecutionError },
                                response: actionExecutionError,
                            }, 502);
                        }
                        await appendManualSessionMessages(root, bookSession.sessionId, [{
                                role: "assistant",
                                content: [{ type: "text", text: fallback.content }],
                                api: "anthropic-messages",
                                provider: configuredEntry?.service ?? reqService ?? config.llm.provider,
                                model: reqModel ?? config.llm.model,
                                usage: {
                                    input: 0,
                                    output: 0,
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    totalTokens: 0,
                                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                                },
                                stopReason: "stop",
                                timestamp: Date.now(),
                            }], instruction);
                        await refreshBookSessionFromTranscript();
                        const createdBookId = await finalizeCreatedBook();
                        return c.json({
                            response: fallback.content,
                            session: {
                                sessionId: bookSession.sessionId,
                                ...(createdBookId ? { activeBookId: createdBookId } : {}),
                            },
                        });
                    }
                }
                catch {
                    // fall through to probe-based diagnosis below
                }
                try {
                    const probeClient = createLLMClient({
                        ...config.llm,
                        service: configuredEntry?.service ?? reqService ?? config.llm.service,
                        model: reqModel ?? config.llm.model,
                        apiKey: agentApiKey ?? config.llm.apiKey,
                        baseUrl: configuredEntry?.baseUrl ?? "",
                        ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
                        ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
                    });
                    await chatCompletion(probeClient, reqModel ?? config.llm.model, [{ role: "user", content: "ping" }], { maxTokens: 5 });
                }
                catch (probeError) {
                    const probeMessage = probeError instanceof Error ? probeError.message : String(probeError);
                    if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
                        await finalizeCreatedBook();
                    }
                    return c.json({
                        error: { code: "AGENT_EMPTY_RESPONSE", message: probeMessage },
                        response: probeMessage,
                    }, 502);
                }
                const emptyMessage = "模型未返回文本内容。请检查协议类型（chat/responses）、流式开关或上游服务兼容性。";
                if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
                    await finalizeCreatedBook();
                }
                return c.json({
                    error: { code: "AGENT_EMPTY_RESPONSE", message: emptyMessage },
                    response: emptyMessage,
                }, 502);
            }
            await refreshBookSessionFromTranscript();
            await finalizeCreatedBook();
            broadcast("agent:complete", { instruction, activeBookId, sessionId: bookSession.sessionId });
            return c.json({
                response: result.responseText,
                session: {
                    sessionId: bookSession.sessionId,
                    ...(bookSession.bookId ? { activeBookId: bookSession.bookId } : {}),
                },
            });
        }
        catch (e) {
            if (e instanceof ApiError) {
                throw e;
            }
            if (e instanceof SessionAlreadyMigratedError) {
                const migratedMessage = e instanceof Error ? e.message : String(e);
                throw new ApiError(409, "SESSION_ALREADY_MIGRATED", migratedMessage);
            }
            const msg = e instanceof Error ? e.message : String(e);
            broadcast("agent:error", { instruction, activeBookId, sessionId, error: msg });
            // Agent busy — return 429 with user-friendly message
            if (/already processing|prompt.*queue/i.test(msg)) {
                return c.json({
                    error: { code: "AGENT_BUSY", message: "正在处理中，请等待当前操作完成" },
                    response: "正在处理中，请等待当前操作完成后再发送。",
                }, 429);
            }
            return c.json({ error: { code: "AGENT_ERROR", message: msg } }, 500);
        }
    });
    // --- Language setup ---
    app.post("/api/v1/project/language", async (c) => {
        const { language } = await c.req.json();
        const configPath = join(root, "hardwrite.json");
        try {
            const raw = await readFile(configPath, "utf-8");
            const existing = JSON.parse(raw);
            existing.language = language;
            const { writeFile: writeFileFs } = await import("node:fs/promises");
            await writeFileFs(configPath, JSON.stringify(existing, null, 2), "utf-8");
            return c.json({ ok: true, language });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Audit ---
    app.post("/api/v1/books/:id/audit/:chapter", async (c) => {
        const id = c.req.param("id");
        const chapterNum = parseInt(c.req.param("chapter"), 10);
        const bookDir = state.bookDir(id);
        broadcast("audit:start", { bookId: id, chapter: chapterNum });
        try {
            const book = await state.loadBookConfig(id);
            const chaptersDir = join(bookDir, "chapters");
            const files = await readdir(chaptersDir);
            const paddedNum = String(chapterNum).padStart(4, "0");
            const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
            if (!match)
                return c.json({ error: "Chapter not found" }, 404);
            const content = await readFile(join(chaptersDir, match), "utf-8");
            const currentConfig = await loadCurrentProjectConfig();
            const { ContinuityAuditor } = await import("@juanshe/core");
            const auditor = new ContinuityAuditor({
                client: createLLMClient(currentConfig.llm),
                model: currentConfig.llm.model,
                projectRoot: root,
                bookId: id,
            });
            const result = await auditor.auditChapter(bookDir, content, chapterNum, book.genre);
            broadcast("audit:complete", { bookId: id, chapter: chapterNum, passed: result.passed });
            return c.json(result);
        }
        catch (e) {
            broadcast("audit:error", { bookId: id, error: String(e) });
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Revise ---
    app.post("/api/v1/books/:id/revise/:chapter", async (c) => {
        const id = c.req.param("id");
        const chapterNum = parseInt(c.req.param("chapter"), 10);
        const bookDir = state.bookDir(id);
        const body = await c.req
            .json()
            .catch(() => ({ mode: "spot-fix", brief: undefined }));
        broadcast("revise:start", { bookId: id, chapter: chapterNum });
        try {
            const book = await state.loadBookConfig(id);
            const chaptersDir = join(bookDir, "chapters");
            const files = await readdir(chaptersDir);
            const paddedNum = String(chapterNum).padStart(4, "0");
            const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
            if (!match)
                return c.json({ error: "Chapter not found" }, 404);
            const pipeline = new PipelineRunner(await buildPipelineConfig({
                externalContext: body.brief,
            }));
            const normalizedMode = body.mode ?? "spot-fix";
            const result = await pipeline.reviseDraft(id, chapterNum, normalizedMode);
            broadcast("revise:complete", { bookId: id, chapter: chapterNum });
            return c.json(result);
        }
        catch (e) {
            broadcast("revise:error", { bookId: id, error: String(e) });
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Export ---
    app.get("/api/v1/books/:id/export", async (c) => {
        const id = c.req.param("id");
        // 白名单 format:与下方 export-save 同口径,防任意字符串流进 buildExportArtifact 的文件名后缀
        const ALLOWED_GET_EXPORT_FORMATS = new Set(["txt", "md", "markdown", "html", "epub"]);
        const rawFormat = String(c.req.query("format") ?? "txt");
        const format = ALLOWED_GET_EXPORT_FORMATS.has(rawFormat) ? rawFormat : "txt";
        const approvedOnly = c.req.query("approvedOnly") === "true";
        try {
            const artifact = await buildExportArtifact(state, id, {
                format: format,
                approvedOnly,
            });
            const responseBody = typeof artifact.payload === "string"
                ? artifact.payload
                : new Uint8Array(artifact.payload);
            return new Response(responseBody, {
                headers: {
                    "Content-Type": artifact.contentType,
                    "Content-Disposition": attachmentContentDisposition(artifact.fileName),
                },
            });
        }
        catch {
            return c.json({ error: "Export failed" }, 500);
        }
    });
    // --- Export to file (save to project dir) ---
    app.post("/api/v1/books/:id/export-save", async (c) => {
        const id = c.req.param("id");
        const { format, approvedOnly } = await c.req.json().catch(() => ({ format: "txt", approvedOnly: false }));
        // 白名单 format:防它走 ../ 把导出写到任意路径(下面 outputPath = join(bookDir, `${id}.${fmt}`))
        const ALLOWED_EXPORT_FORMATS = new Set(["txt", "md", "markdown", "html", "epub"]);
        const fmt = ALLOWED_EXPORT_FORMATS.has(String(format)) ? String(format) : "txt";
        try {
            const pipeline = new PipelineRunner(await buildPipelineConfig());
            const tools = createInteractionToolsFromDeps(pipeline, state);
            const bookDir = state.bookDir(id);
            const outputPath = join(bookDir, `${id}.${fmt === "epub" ? "epub" : fmt}`);
            const result = await processProjectInteractionRequest({
                projectRoot: root,
                request: {
                    intent: "export_book",
                    bookId: id,
                    format: fmt,
                    approvedOnly,
                    outputPath,
                },
                tools,
                activeBookId: id,
            });
            return c.json({
                ok: true,
                path: result.details?.outputPath ?? outputPath,
                format: fmt,
                chapters: result.details?.chaptersExported ?? 0,
            });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Genre detail + copy ---
    app.get("/api/v1/genres/:id", async (c) => {
        const genreId = c.req.param("id");
        if (/[/\\\0]/.test(genreId) || genreId.includes("..")) // 同 PUT/DELETE:防 ../ 路径穿越读任意 .md
            return c.json({ error: `Invalid genre ID: "${genreId}"` }, 400);
        try {
            const { readGenreProfile } = await import("@juanshe/core");
            const { profile, body } = await readGenreProfile(root, genreId);
            return c.json({ profile, body });
        }
        catch (e) {
            return c.json({ error: String(e) }, 404);
        }
    });
    app.post("/api/v1/genres/:id/copy", async (c) => {
        const genreId = c.req.param("id");
        if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
            throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
        }
        try {
            const { getBuiltinGenresDir } = await import("@juanshe/core");
            const { mkdir: mkdirFs, copyFile } = await import("node:fs/promises");
            const builtinDir = getBuiltinGenresDir();
            const projectGenresDir = join(root, "genres");
            await mkdirFs(projectGenresDir, { recursive: true });
            await copyFile(join(builtinDir, `${genreId}.md`), join(projectGenresDir, `${genreId}.md`));
            return c.json({ ok: true, path: `genres/${genreId}.md` });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Model overrides ---
    app.get("/api/v1/project/model-overrides", async (c) => {
        const raw = JSON.parse(await readFile(join(root, "hardwrite.json"), "utf-8"));
        return c.json({ overrides: raw.modelOverrides ?? {} });
    });
    app.put("/api/v1/project/model-overrides", async (c) => {
        const { overrides } = await c.req.json();
        const configPath = join(root, "hardwrite.json");
        const raw = JSON.parse(await readFile(configPath, "utf-8"));
        raw.modelOverrides = overrides;
        const { writeFile: writeFileFs } = await import("node:fs/promises");
        await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
        return c.json({ ok: true });
    });
    // --- Notify channels ---
    app.get("/api/v1/project/notify", async (c) => {
        const raw = JSON.parse(await readFile(join(root, "hardwrite.json"), "utf-8"));
        return c.json({ channels: raw.notify ?? [] });
    });
    app.put("/api/v1/project/notify", async (c) => {
        const { channels } = await c.req.json();
        const configPath = join(root, "hardwrite.json");
        const raw = JSON.parse(await readFile(configPath, "utf-8"));
        raw.notify = channels;
        const { writeFile: writeFileFs } = await import("node:fs/promises");
        await writeFileFs(configPath, JSON.stringify(raw, null, 2), "utf-8");
        return c.json({ ok: true });
    });
    // --- AIGC Detection ---
    app.post("/api/v1/books/:id/detect/:chapter", async (c) => {
        const id = c.req.param("id");
        const chapterNum = parseInt(c.req.param("chapter"), 10);
        const bookDir = state.bookDir(id);
        try {
            const chaptersDir = join(bookDir, "chapters");
            const files = await readdir(chaptersDir);
            const paddedNum = String(chapterNum).padStart(4, "0");
            const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
            if (!match)
                return c.json({ error: "Chapter not found" }, 404);
            const content = await readFile(join(chaptersDir, match), "utf-8");
            const { analyzeAITells } = await import("@juanshe/core");
            const result = analyzeAITells(content);
            return c.json({ chapterNumber: chapterNum, ...result });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Truth file edit ---
    app.put("/api/v1/books/:id/truth/:file{.+}", async (c) => {
        const id = c.req.param("id");
        const file = c.req.param("file");
        const bookDir = state.bookDir(id);
        const resolved = resolveTruthFilePath(bookDir, file);
        if (!resolved) {
            return c.json({ error: "Invalid truth file" }, 400);
        }
        // Legacy pointer shims are read-only in new-layout books: writing
        // story_bible.md or book_rules.md does nothing at runtime (the pipeline
        // reads outline/ instead). For pre-Phase-5 books these ARE authoritative.
        if (LEGACY_SHIM_FILES.has(file)) {
            const { isNewLayoutBook } = await import("@juanshe/core");
            if (await isNewLayoutBook(bookDir)) {
                return c.json({ error: "Legacy compat shim; edit outline/story_frame.md instead" }, 400);
            }
        }
        const { content } = await c.req.json();
        const { mkdir: mkdirFs } = await import("node:fs/promises");
        const { dirname: dirnameFs } = await import("node:path");
        await mkdirFs(dirnameFs(resolved), { recursive: true });
        // 原子写:真相文件(canon)是用户不可恢复的设定,崩溃/磁盘满直写会截断损坏。
        await atomicWriteFile(resolved, content ?? "");
        return c.json({ ok: true });
    });
    // =============================================
    // NEW ENDPOINTS — CLI parity
    // =============================================
    // --- Book Delete ---
    app.delete("/api/v1/books/:id", async (c) => {
        const id = c.req.param("id");
        const bookDir = state.bookDir(id);
        try {
            await cancelBookRuns(id, "作品删除：已取消该书全部未完成工作流并释放锁");
            const { rm } = await import("node:fs/promises");
            await rm(bookDir, { recursive: true, force: true });
            broadcast("book:deleted", { bookId: id });
            return c.json({ ok: true, bookId: id });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Book Update ---
    app.put("/api/v1/books/:id", async (c) => {
        const id = c.req.param("id");
        const updates = await c.req.json();
        try {
            const book = await state.loadBookConfig(id);
            const title = typeof updates.title === "string" ? updates.title.trim() : undefined;
            const genre = typeof updates.genre === "string" ? updates.genre.trim() : undefined;
            const platform = typeof updates.platform === "string" ? updates.platform.trim() : undefined;
            const updated = {
                ...book,
                ...(title ? { title } : {}),
                ...(genre !== undefined ? { genre } : {}),
                ...(platform !== undefined ? { platform } : {}),
                ...(typeof updates.brief === "string" ? { brief: updates.brief } : {}),
                ...(typeof updates.description === "string" ? { description: updates.description } : {}),
                ...(updates.chapterWordCount !== undefined ? { chapterWordCount: Number(updates.chapterWordCount) } : {}),
                ...(updates.targetChapters !== undefined ? { targetChapters: Number(updates.targetChapters) } : {}),
                ...(updates.status !== undefined ? { status: updates.status } : {}),
                ...(updates.language !== undefined ? { language: updates.language } : {}),
                updatedAt: new Date().toISOString(),
            };
            await state.saveBookConfig(id, updated);
            return c.json({ ok: true, book: updated });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Write Rewrite (specific chapter) ---
    app.post("/api/v1/books/:id/rewrite/:chapter", async (c) => {
        const id = c.req.param("id");
        const chapterNum = parseInt(c.req.param("chapter"), 10);
        const body = await c.req
            .json()
            .catch(() => ({}));
        const targetScore = Math.max(70, Math.min(98, Number(body.targetScore) || 90));
        // 数据安全:回滚丢弃第 N 章及之后内容之前,先确认前序章节(1..N-1)没被质量门禁挡住。
        // 否则会"先丢章、再被门禁拦住、无法重写",造成正文丢失(历史 bug)。
        if (body.ignoreExistingQualityGate !== true) {
            const qualityBlocker = await findExistingQualityGateBlocker(id, targetScore, chapterNum);
            if (qualityBlocker) {
                const payload = qualityGateBlockedPayload(id, qualityBlocker, targetScore, "rewrite");
                void appendBookAgentEvent(root, id, "rewrite:blocked-quality-gate", { ...payload, agent: "quality-reporter", agentLabel: "质量报告官", stage: payload.failureReason });
                broadcast("write:blocked-quality-gate", payload);
                return c.json(payload, 409);
            }
        }
        const blocked = await prepareWriteSlot(id, { forceTakeover: Boolean(body.forceTakeover) });
        if (blocked)
            return c.json({ ...blocked, bookId: id }, 409);
        const run = await createTaskRun(root, { bookId: id, type: "rewrite", total: 1, chapterNumber: chapterNum, currentAgent: "writer", currentStage: `第 ${chapterNum} 章重写进入队列` });
        const abortController = new AbortController();
        setWriteSlot(id, run.id, { abortController });
        const stopHeartbeat = startTaskHeartbeat(run.id, "writer", `第 ${chapterNum} 章重写中`, { chapterNumber: chapterNum });
        broadcast("rewrite:start", { bookId: id, runId: run.id, chapter: chapterNum });
        try {
            const rollbackTarget = chapterNum - 1;
            // rollbackToChapter 现已在删除前自动备份被丢弃章节到 backups/(core 层),失败也可找回。
            const discarded = await state.rollbackToChapter(id, rollbackTarget);
            const externalContext = mergeExternalContext(await bookPlatformExternalContext(id), body.brief || "", await voiceFingerprintBlock(id), await narrativeCraftBlock(), longOutputSafetyContext({ chapters: 1, targetScore, mode: "write-next" }));
            const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForSSE: id, runIdForSSE: run.id, chapterForSSE: chapterNum, externalContext, abortSignal: abortController.signal }));
            pipeline.writeNextChapter(id, body.wordCount).then(async (result) => {
                stopHeartbeat();
                releaseWriteSlot(id, run.id);
                await appendBookAgentEvent(root, id, "rewrite:complete", { runId: run.id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
                await updateTaskRun(root, run.id, { status: "done", completed: 1, currentAgent: "quality-reporter", currentStage: `第 ${result.chapterNumber} 章重写完成`, results: [result] }, { kind: "rewrite:complete", stage: `第 ${result.chapterNumber} 章重写完成`, agent: "quality-reporter" });
                broadcast("rewrite:complete", { bookId: id, runId: run.id, chapterNumber: result.chapterNumber, title: result.title, wordCount: result.wordCount });
            }, async (e) => {
                stopHeartbeat();
                releaseWriteSlot(id, run.id);
                const msg = e instanceof Error ? e.message : String(e);
                await updateTaskRun(root, run.id, { status: "error", error: msg, currentStage: "重写失败(原稿已备份到 backups/)" }, { kind: "rewrite:error", stage: "重写失败", agent: "writer" });
                broadcast("rewrite:error", { bookId: id, runId: run.id, error: msg });
            });
            return c.json({ status: "rewriting", bookId: id, runId: run.id, chapter: chapterNum, rolledBackTo: rollbackTarget, discarded });
        }
        catch (e) {
            stopHeartbeat();
            releaseWriteSlot(id, run.id);
            const msg = e instanceof Error ? e.message : String(e);
            void updateTaskRun(root, run.id, { status: "error", error: msg, currentStage: "重写启动失败" }, { kind: "rewrite:error", stage: "重写启动失败", agent: "writer" });
            broadcast("rewrite:error", { bookId: id, error: msg });
            return c.json({ error: msg }, 500);
        }
    });
    app.post("/api/v1/books/:id/resync/:chapter", async (c) => {
        const id = c.req.param("id");
        const chapterNum = parseInt(c.req.param("chapter"), 10);
        const body = await c.req
            .json()
            .catch(() => ({}));
        try {
            const pipeline = new PipelineRunner(await buildPipelineConfig({
                externalContext: body.brief,
            }));
            const result = await pipeline.resyncChapterArtifacts(id, chapterNum);
            return c.json(result);
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Detect All chapters ---
    app.post("/api/v1/books/:id/detect-all", async (c) => {
        const id = c.req.param("id");
        const bookDir = state.bookDir(id);
        try {
            const chaptersDir = join(bookDir, "chapters");
            const files = await readdir(chaptersDir);
            const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
            const { analyzeAITells } = await import("@juanshe/core");
            const results = await Promise.all(mdFiles.map(async (f) => {
                const num = parseInt(f.slice(0, 4), 10);
                const content = await readFile(join(chaptersDir, f), "utf-8");
                const result = analyzeAITells(content);
                return { chapterNumber: num, filename: f, ...result };
            }));
            return c.json({ bookId: id, results });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Detect Stats ---
    app.get("/api/v1/books/:id/detect/stats", async (c) => {
        const id = c.req.param("id");
        try {
            const { loadDetectionHistory, analyzeDetectionInsights } = await import("@juanshe/core");
            const bookDir = state.bookDir(id);
            const history = await loadDetectionHistory(bookDir);
            const insights = analyzeDetectionInsights(history);
            return c.json(insights);
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Genre Create ---
    app.post("/api/v1/genres/create", async (c) => {
        const body = await c.req.json();
        if (!body.id || !body.name) {
            return c.json({ error: "id and name are required" }, 400);
        }
        if (/[/\\\0]/.test(body.id) || body.id.includes("..")) {
            throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${body.id}"`);
        }
        const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
        const genresDir = join(root, "genres");
        await mkdirFs(genresDir, { recursive: true });
        const frontmatter = [
            "---",
            `name: ${body.name}`,
            `id: ${body.id}`,
            `language: ${body.language ?? "zh"}`,
            `chapterTypes: ${JSON.stringify(body.chapterTypes ?? [])}`,
            `fatigueWords: ${JSON.stringify(body.fatigueWords ?? [])}`,
            `numericalSystem: ${body.numericalSystem ?? false}`,
            `powerScaling: ${body.powerScaling ?? false}`,
            `eraResearch: ${body.eraResearch ?? false}`,
            `pacingRule: "${body.pacingRule ?? ""}"`,
            `satisfactionTypes: ${JSON.stringify(body.satisfactionTypes ?? [])}`,
            `auditDimensions: ${JSON.stringify(body.auditDimensions ?? [])}`,
            "---",
            "",
            body.body ?? "",
        ].join("\n");
        await writeFileFs(join(genresDir, `${body.id}.md`), frontmatter, "utf-8");
        return c.json({ ok: true, id: body.id });
    });
    // --- Genre Edit ---
    app.put("/api/v1/genres/:id", async (c) => {
        const genreId = c.req.param("id");
        if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
            throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
        }
        const body = await c.req.json();
        const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
        const genresDir = join(root, "genres");
        await mkdirFs(genresDir, { recursive: true });
        const p = body.profile;
        const frontmatter = [
            "---",
            `name: ${p.name ?? genreId}`,
            `id: ${p.id ?? genreId}`,
            `language: ${p.language ?? "zh"}`,
            `chapterTypes: ${JSON.stringify(p.chapterTypes ?? [])}`,
            `fatigueWords: ${JSON.stringify(p.fatigueWords ?? [])}`,
            `numericalSystem: ${p.numericalSystem ?? false}`,
            `powerScaling: ${p.powerScaling ?? false}`,
            `eraResearch: ${p.eraResearch ?? false}`,
            `pacingRule: "${p.pacingRule ?? ""}"`,
            `satisfactionTypes: ${JSON.stringify(p.satisfactionTypes ?? [])}`,
            `auditDimensions: ${JSON.stringify(p.auditDimensions ?? [])}`,
            "---",
            "",
            body.body ?? "",
        ].join("\n");
        await writeFileFs(join(genresDir, `${genreId}.md`), frontmatter, "utf-8");
        return c.json({ ok: true, id: genreId });
    });
    // --- Genre Delete (project-level only) ---
    app.delete("/api/v1/genres/:id", async (c) => {
        const genreId = c.req.param("id");
        if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
            throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
        }
        const filePath = join(root, "genres", `${genreId}.md`);
        try {
            const { rm } = await import("node:fs/promises");
            await rm(filePath);
            return c.json({ ok: true, id: genreId });
        }
        catch (e) {
            return c.json({ error: `Genre "${genreId}" not found in project` }, 404);
        }
    });
    // --- Style Analyze ---
    app.get("/api/v1/style/analyses", async (c) => {
        const files = await listVaultMarkdown(root, "40-风格样本");
        const analyses = [];
        for (const file of files.filter((item) => !item.relativePath.endsWith("风格样本列表.md"))) {
            const content = await readOptionalText(file.path);
            const meta = await stat(file.path).catch(() => null);
            analyses.push({
                title: file.name,
                relativePath: file.relativePath,
                updatedAt: meta?.mtime?.toISOString?.() ?? "",
                preview: content.replace(/^---[\s\S]*?---\s*/m, "").slice(0, 420),
            });
        }
        analyses.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        return c.json({ analyses: analyses.slice(0, 40) });
    });
    app.post("/api/v1/style/analyze", async (c) => {
        const { text, sourceName, save = true } = await c.req.json();
        if (!text?.trim())
            return c.json({ error: "text is required" }, 400);
        try {
            const { analyzeStyle } = await import("@juanshe/core");
            const profile = analyzeStyle(text, sourceName ?? "unknown");
            if (!save) {
                return c.json(profile);
            }
            const saved = await persistStyleAnalysis(root, profile, { text, sourceName });
            return c.json({ ...profile, saved });
        }
        catch (e) {
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Style Import to Book ---
    app.post("/api/v1/books/:id/style/import", async (c) => {
        const id = c.req.param("id");
        const { text, sourceName } = await c.req.json();
        if (!text?.trim())
            return c.json({ error: "text is required" }, 400);
        broadcast("style:start", { bookId: id });
        try {
            const pipeline = new PipelineRunner(await buildPipelineConfig());
            const result = await pipeline.generateStyleGuide(id, text, sourceName ?? "unknown");
            broadcast("style:complete", { bookId: id });
            return c.json({ ok: true, result });
        }
        catch (e) {
            broadcast("style:error", { bookId: id, error: String(e) });
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Import Chapters ---
    app.post("/api/v1/books/:id/import/chapters", async (c) => {
        const id = c.req.param("id");
        const { text, splitRegex } = await c.req.json();
        if (!text?.trim())
            return c.json({ error: "text is required" }, 400);
        broadcast("import:start", { bookId: id, type: "chapters" });
        try {
            const { splitChapters } = await import("@juanshe/core");
            const chapters = [...splitChapters(text, splitRegex)];
            const pipeline = new PipelineRunner(await buildPipelineConfig());
            const result = await pipeline.importChapters({ bookId: id, chapters });
            broadcast("import:complete", { bookId: id, type: "chapters", count: result.importedCount });
            return c.json(result);
        }
        catch (e) {
            broadcast("import:error", { bookId: id, error: String(e) });
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Import Canon ---
    app.post("/api/v1/books/:id/import/canon", async (c) => {
        const id = c.req.param("id");
        const { fromBookId } = await c.req.json();
        if (!fromBookId)
            return c.json({ error: "fromBookId is required" }, 400);
        broadcast("import:start", { bookId: id, type: "canon" });
        try {
            const pipeline = new PipelineRunner(await buildPipelineConfig());
            await pipeline.importCanon(id, fromBookId);
            broadcast("import:complete", { bookId: id, type: "canon" });
            return c.json({ ok: true });
        }
        catch (e) {
            broadcast("import:error", { bookId: id, error: String(e) });
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Fanfic Init ---
    app.post("/api/v1/fanfic/init", async (c) => {
        const body = await c.req.json();
        if (!body.title || !body.sourceText) {
            return c.json({ error: "title and sourceText are required" }, 400);
        }
        const now = new Date().toISOString();
        const bookId = body.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "-").replace(/-+/g, "-").slice(0, 30);
        const bookConfig = {
            id: bookId,
            title: body.title,
            platform: (body.platform ?? "other"),
            genre: (body.genre ?? "other"),
            status: "outlining",
            targetChapters: body.targetChapters ?? 100,
            chapterWordCount: body.chapterWordCount ?? 3000,
            fanficMode: (body.mode ?? "canon"),
            ...(body.language ? { language: body.language } : {}),
            createdAt: now,
            updatedAt: now,
        };
        broadcast("fanfic:start", { bookId, title: body.title });
        try {
            const pipeline = new PipelineRunner(await buildPipelineConfig());
            await pipeline.initFanficBook(bookConfig, body.sourceText, body.sourceName ?? "source", (body.mode ?? "canon"));
            broadcast("fanfic:complete", { bookId });
            return c.json({ ok: true, bookId });
        }
        catch (e) {
            broadcast("fanfic:error", { bookId, error: String(e) });
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Fanfic Show (read canon) ---
    app.get("/api/v1/books/:id/fanfic", async (c) => {
        const id = c.req.param("id");
        const bookDir = state.bookDir(id);
        try {
            const content = await readFile(join(bookDir, "story", "fanfic_canon.md"), "utf-8");
            return c.json({ bookId: id, content });
        }
        catch {
            return c.json({ bookId: id, content: null });
        }
    });
    // --- Fanfic Refresh ---
    app.post("/api/v1/books/:id/fanfic/refresh", async (c) => {
        const id = c.req.param("id");
        const { sourceText, sourceName } = await c.req.json();
        if (!sourceText?.trim())
            return c.json({ error: "sourceText is required" }, 400);
        broadcast("fanfic:refresh:start", { bookId: id });
        try {
            const book = await state.loadBookConfig(id);
            const pipeline = new PipelineRunner(await buildPipelineConfig());
            await pipeline.importFanficCanon(id, sourceText, sourceName ?? "source", (book.fanficMode ?? "canon"));
            broadcast("fanfic:refresh:complete", { bookId: id });
            return c.json({ ok: true });
        }
        catch (e) {
            broadcast("fanfic:refresh:error", { bookId: id, error: String(e) });
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Creator atelier ---
    async function loadCreatorStrategy() {
        const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
        const service = currentConfig.llm.service ?? currentConfig.llm.provider;
        const baseUrl = currentConfig.llm.baseUrl;
        let models = [];
        try {
            const secrets = await loadSecrets(root);
            const apiKey = secrets.services[service]?.apiKey || currentConfig.llm.apiKey || "";
            const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service, baseUrl);
            const listed = await listModelsForService(isCustomServiceId(service) ? "custom" : service, apiKey, isCustomServiceId(service) ? resolvedBaseUrl ?? undefined : undefined);
            models = normalizeModelList(filterTextChatModels(listed));
        }
        catch {
            models = [];
        }
        if (isXiaomiMimoService(service, baseUrl)) {
            models = mergeModelLists(models, XIAOMI_MIMO_TEXT_MODELS);
        }
        if (!models.some((model) => model.id === currentConfig.llm.model)) {
            models.unshift({ id: currentConfig.llm.model, name: currentConfig.llm.model });
        }
        const raw = await loadRawConfig(root);
        return buildCreatorModelStrategy(currentConfig, models, raw.modelOverrides ?? {});
    }
    const creatorWorkflow = [
        { label: "素材摄取", description: "导入 URL、小说片段和设定摘录，保存到本地 Markdown。" },
        { label: "风格学习", description: "只抽取叙述视角、节奏、句法和信息释放方式，不复制原文。" },
        { label: "章节规划", description: "把欲望、阻碍、变化和钩子写成可执行备忘。" },
        { label: "正文写作", description: "按事实库和章节备忘生成可发布正文。" },
        { label: "润色标注", description: "选段精修，输出修改前后与原因，必要时入库留痕。" },
        { label: "审稿归档", description: "检查连续性、角色知识边界、报告腔和章尾期待。" },
    ];
    app.get("/api/v1/stats", async (c) => {
        return c.json(await loadWritingStats(root, state));
    });
    app.get("/api/v1/activity", async (c) => {
        return c.json({ entries: await readActivityEntries(root, 200) });
    });
    app.get("/api/v1/atelier", async (c) => {
        await ensureVaultTemplates(root);
        await buildBooksIndex(root, state).catch(() => null);
        const [vault, strategy] = await Promise.all([
            loadVaultSummary(root),
            loadCreatorStrategy(),
        ]);
        const rawConfig = await loadRawConfig(root).catch(() => ({}));
        return c.json({
            project: {
                name: initialConfig.name,
                model: strategy.currentModel,
                provider: strategy.provider,
                service: strategy.service,
                baseUrl: strategy.baseUrl,
                stream: strategy.stream,
                temperature: strategy.temperature,
            },
            workflow: creatorWorkflow,
            strategy,
            agentProfiles: normalizeAgentProfiles(rawConfig.agentProfiles ?? {}, rawConfig.modelOverrides ?? strategy.overrides ?? {}, strategy.currentModel, strategy.service),
            templates: CREATOR_TEMPLATES.map(({ id, title, description, relativePath }) => ({ id, title, description, relativePath })),
            vault,
        });
    });
    app.get("/api/v1/atelier/templates", async (c) => {
        await ensureVaultTemplates(root);
        return c.json({ templates: CREATOR_TEMPLATES });
    });
    app.post("/api/v1/atelier/model-strategy/apply", async (c) => {
        const strategy = await loadCreatorStrategy();
        const raw = await loadRawConfig(root);
        raw.modelOverrides = strategy.overrides;
        await saveRawConfig(root, raw);
        return c.json({ ok: true, strategy });
    });
    const agentProfilesPayload = async () => {
        const strategy = await loadCreatorStrategy();
        const raw = await loadRawConfig(root);
        const profiles = normalizeAgentProfiles(raw.agentProfiles ?? {}, raw.modelOverrides ?? strategy.overrides ?? {}, strategy.currentModel, strategy.service);
        return {
            agents: AGENT_PROFILE_DEFS,
            models: strategy.models ?? [],
            profiles,
            overrides: raw.modelOverrides ?? {},
        };
    };
    const saveAgentProfilesPayload = async (body) => {
        const strategy = await loadCreatorStrategy();
        const raw = await loadRawConfig(root);
        const profiles = normalizeAgentProfiles(body?.profiles ?? {}, raw.modelOverrides ?? strategy.overrides ?? {}, strategy.currentModel, strategy.service);
        raw.agentProfiles = profiles;
        raw.modelOverrides = mergeAgentProfilesIntoOverrides(raw, profiles);
        await saveRawConfig(root, raw);
        return {
            ok: true,
            agents: AGENT_PROFILE_DEFS,
            models: strategy.models ?? [],
            profiles,
            overrides: raw.modelOverrides ?? {},
        };
    };
    app.get("/api/v1/agent-profiles", async (c) => c.json(await agentProfilesPayload()));
    app.post("/api/v1/agent-profiles", async (c) => c.json(await saveAgentProfilesPayload(await c.req.json().catch(() => ({})))));
    const modelRoutingPayload = async () => {
        const strategy = await loadCreatorStrategy();
        const raw = await loadRawConfig(root);
        const profiles = normalizeAgentProfiles(raw.agentProfiles ?? {}, raw.modelOverrides ?? strategy.overrides ?? {}, strategy.currentModel, strategy.service);
        return {
            provider: strategy.provider,
            service: strategy.service,
            baseUrl: strategy.baseUrl,
            currentModel: strategy.currentModel,
            stream: strategy.stream,
            temperature: strategy.temperature,
            models: strategy.models ?? [],
            overrides: raw.modelOverrides ?? strategy.overrides ?? {},
            profiles,
            routes: AGENT_PROFILE_DEFS.map((agent) => ({
                agentId: agent.id,
                label: agent.label,
                model: profiles?.[agent.id]?.model || strategy.currentModel,
                service: profiles?.[agent.id]?.service || strategy.service,
                temperature: profiles?.[agent.id]?.temperature ?? strategy.temperature,
            })),
            updatedAt: new Date().toISOString(),
        };
    };
    app.get("/api/v1/project/model-routing", async (c) => c.json(await modelRoutingPayload()));
    app.patch("/api/v1/project/model-routing", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        if (!body || typeof body !== "object" || Array.isArray(body))
            return c.json({ error: "invalid body" }, 400);
        const raw = await loadRawConfig(root);
        if (body.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)) {
            raw.modelOverrides = { ...(raw.modelOverrides ?? {}), ...body.overrides };
        }
        if (body.profiles && typeof body.profiles === "object" && !Array.isArray(body.profiles)) {
            const strategy = await loadCreatorStrategy();
            raw.agentProfiles = normalizeAgentProfiles(body.profiles, raw.modelOverrides ?? strategy.overrides ?? {}, strategy.currentModel, strategy.service);
            raw.modelOverrides = mergeAgentProfilesIntoOverrides(raw, raw.agentProfiles);
        }
        await saveRawConfig(root, raw);
        return c.json(await modelRoutingPayload());
    });
    const agentProfilePayloadForId = async (id) => {
        const payload = await agentProfilesPayload();
        const agent = payload.agents.find((item) => item.id === id);
        const profile = payload.profiles?.[id];
        if (!agent && !profile)
            return null;
        return {
            agents: agent ? [agent] : [],
            models: payload.models,
            profiles: profile ? { [id]: profile } : {},
            overrides: payload.overrides,
        };
    };
    const profilePatchFromStudio = (body) => {
        const source = body?.patch && typeof body.patch === "object" && !Array.isArray(body.patch) ? body.patch : body;
        if (!source || typeof source !== "object" || Array.isArray(source))
            return {};
        const patch: Record<string, unknown> = {};
        if (typeof source.service === "string")
            patch.service = source.service;
        if (typeof source.model === "string")
            patch.model = source.model;
        if (typeof source.temperature === "number")
            patch.temperature = source.temperature;
        if (typeof source.stream === "boolean")
            patch.stream = source.stream;
        if (typeof source.systemPrompt === "string")
            patch.promptPatch = source.systemPrompt;
        if (typeof source.promptPatch === "string")
            patch.promptPatch = source.promptPatch;
        if (typeof source.hardConstraints === "string")
            patch.hardConstraints = source.hardConstraints;
        if (typeof source.userTemplate === "string")
            patch.userTemplate = source.userTemplate;
        if (typeof source.outputSchema === "string")
            patch.outputFormat = source.outputSchema;
        if (typeof source.outputFormat === "string")
            patch.outputFormat = source.outputFormat;
        if (Array.isArray(source.tools))
            patch.tools = source.tools.filter((item) => typeof item === "string");
        if (typeof source.locked === "boolean")
            patch.locked = source.locked;
        return patch;
    };
    app.get("/api/v1/agent-profiles/:id", async (c) => {
        const payload = await agentProfilePayloadForId(c.req.param("id"));
        if (!payload)
            return c.json({ error: "not found" }, 404);
        return c.json(payload);
    });
    app.patch("/api/v1/agent-profiles/:id", async (c) => {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        if (body?.action === "restore") {
            return c.json({ error: "version restore is not available in the backend profile store" }, 400);
        }
        const payload = await agentProfilesPayload();
        if (!payload.agents.some((item) => item.id === id) && !payload.profiles?.[id]) {
            return c.json({ error: "not found" }, 404);
        }
        const nextProfiles = {
            ...payload.profiles,
            [id]: {
                ...(payload.profiles?.[id] ?? {}),
                ...profilePatchFromStudio(body),
            },
        };
        await saveAgentProfilesPayload({ profiles: nextProfiles });
        const nextPayload = await agentProfilePayloadForId(id);
        return c.json(nextPayload ?? { error: "not found" }, nextPayload ? 200 : 404);
    });
    app.get("/api/v1/atelier/agent-profiles", async (c) => {
        return c.json(await agentProfilesPayload());
    });
    app.post("/api/v1/atelier/agent-profiles", async (c) => {
        return c.json(await saveAgentProfilesPayload(await c.req.json().catch(() => ({}))));
    });
    app.post("/api/v1/atelier/model-connectivity", async (c) => {
        const startedAt = Date.now();
        const body = await c.req.json().catch(() => ({}));
        try {
            const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
            const serviceDraft = body?.serviceDraft && typeof body.serviceDraft === "object" ? body.serviceDraft : {};
            const draftService = normalizeAgentService(serviceDraft.service, currentConfig.llm?.service || currentConfig.llm?.provider || "");
            const draftModel = typeof serviceDraft.model === "string" ? serviceDraft.model.trim() : "";
            const draftBaseUrl = typeof serviceDraft.baseUrl === "string" ? serviceDraft.baseUrl.trim() : "";
            if (draftService) {
                currentConfig.llm = currentConfig.llm ?? {};
                currentConfig.llm.service = draftService;
                currentConfig.llm.provider = isCustomServiceId(draftService) ? "openai" : (resolveServiceProviderFamily(draftService) ?? currentConfig.llm.provider ?? "openai");
                const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, draftService, draftBaseUrl);
                if (resolvedBaseUrl)
                    currentConfig.llm.baseUrl = resolvedBaseUrl;
            }
            if (draftModel) {
                currentConfig.llm.model = draftModel;
                currentConfig.llm.defaultModel = draftModel;
            }
            if (body?.profiles && typeof body.profiles === "object") {
                const profiles = normalizeAgentProfiles(body.profiles, currentConfig.modelOverrides ?? {}, currentConfig.llm?.model || currentConfig.llm?.defaultModel || "", currentConfig.llm?.service || "");
                currentConfig.agentProfiles = profiles;
                currentConfig.modelOverrides = mergeAgentProfilesIntoOverrides(currentConfig, profiles);
                await hydrateAgentOverrideRuntimeConfig(root, currentConfig);
            }
            const secrets = await loadSecrets(root).catch(() => ({ services: {} }));
            if (draftService && typeof serviceDraft.apiKey === "string" && serviceDraft.apiKey.trim()) {
                secrets.services = secrets.services ?? {};
                secrets.services[draftService] = { apiKey: serviceDraft.apiKey.trim() };
                currentConfig.llm.apiKey = serviceDraft.apiKey.trim();
            }
            const services = normalizeServiceConfig(currentConfig.llm?.services);
            const defaultModel = currentConfig.llm?.model || currentConfig.llm?.defaultModel || "";
            const rawTargets = [
                {
                    id: "__default",
                    agent: "default",
                    label: "默认模型",
                    mission: "全局兜底与未单独配置的 Agent",
                    serviceLabel: currentConfig.llm?.service || currentConfig.llm?.provider || "",
                    llm: { ...currentConfig.llm, model: defaultModel },
                },
                ...AGENT_PROFILE_DEFS.map((def) => {
                    const profile = currentConfig.agentProfiles?.[def.id] ?? {};
                    return {
                        id: def.id,
                        agent: def.id,
                        label: def.label,
                        mission: def.mission || "",
                        llm: resolveAgentRuntimeLLMConfig(currentConfig, [def.id], profile.temperature ?? def.defaultTemperature ?? 0.7),
                        temperature: profile.temperature ?? def.defaultTemperature ?? 0.7,
                    };
                }),
            ];
            const resolvedTargets = await Promise.all(rawTargets.map((target) => resolveModelConnectivityTarget(currentConfig, services, secrets, target)));
            const uniqueTargets = new Map();
            for (const target of resolvedTargets) {
                if (!uniqueTargets.has(target.probeKey))
                    uniqueTargets.set(target.probeKey, target);
            }
            const unique = [...uniqueTargets.values()];
            const probeResults = new Map();
            let cursor = 0;
            const workers = Array.from({ length: Math.min(4, unique.length) }, async () => {
                while (cursor < unique.length) {
                    const index = cursor++;
                    const target = unique[index];
                    probeResults.set(target.probeKey, await probeResolvedModelTarget(target, c.req.raw?.signal));
                }
            });
            await Promise.all(workers);
            const results = resolvedTargets.map((target) => ({
                ...probeResults.get(target.probeKey),
                ...publicConnectivityTarget(target),
            }));
            const pass = results.filter((item) => item.ok).length;
            return c.json({
                ok: true,
                checkedAt: new Date().toISOString(),
                durationMs: Date.now() - startedAt,
                total: results.length,
                pass,
                fail: results.length - pass,
                results,
            });
        }
        catch (error) {
            return c.json({
                ok: false,
                error: sanitizeConnectivityError(error),
                suggestion: connectivitySuggestion(error),
            }, 500);
        }
    });
    app.get("/api/v1/atelier/prompt-governance", async (c) => {
        const bookId = limitText(c.req.query("bookId") || "", 160).trim();
        if (bookId && !isSafeBookId(bookId))
            return c.json({ error: "invalid bookId" }, 400);
        const targetScore = Math.max(70, Math.min(98, Number(c.req.query("targetScore")) || 90));
        const digest = await buildPromptGovernanceDigest(root, state, bookId, targetScore);
        const strategy = await loadCreatorStrategy();
        const raw = await loadRawConfig(root);
        const profiles = normalizeAgentProfiles(raw.agentProfiles ?? {}, raw.modelOverrides ?? strategy.overrides ?? {}, strategy.currentModel, strategy.service);
        return c.json({ ok: true, digest, agents: AGENT_PROFILE_DEFS, profiles });
    });
    app.post("/api/v1/atelier/prompt-governance", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const bookId = limitText(body?.bookId || "", 160).trim();
        if (bookId && !isSafeBookId(bookId))
            return c.json({ error: "invalid bookId" }, 400);
        const targetScore = Math.max(70, Math.min(98, Number(body?.targetScore) || 90));
        let digest = await buildPromptGovernanceDigest(root, state, bookId, targetScore);
        const warnings = [];
        if (body?.useLLM !== false) {
            try {
                const currentConfig = await loadCurrentProjectConfig();
                const llm = resolveAgentRuntimeLLMConfig(currentConfig, ["prompt-governor", "quality-reporter", "auditor"], 0.22);
                const client = createLLMClient(llm);
                const response = await chatCompletion(client, llm.model, [
                    {
                        role: "system",
                        content: "你是长篇小说系统的提示词治理官。内部必须按 Prompt Writer -> Prompt Reviewer 两阶段工作，但最终只输出 JSON。不要 Markdown。压缩、去重、保留可执行精华，不要覆盖用户手写提示词，不要破坏 truth files，不要引入外部编排框架假设。",
                    },
                    {
                        role: "user",
                        content: [
                            "请基于下面自动复盘，进一步压缩成更先进的角色提示词补丁。",
                            "JSON 结构：{pitfalls:string[],wikiLessons:string[],promptWriterDraft:{agent:{promptPatch:string,hardConstraints:string,outputFormat:string}},promptReview:{pass:boolean,issues:[],fixedFields:[]},promptPatches:{agent:{promptPatch:string,hardConstraints:string,outputFormat:string}},summaryMarkdown:string}",
                            "Prompt Writer：只产出短补丁，不写正文，不改 truth files。",
                            "Prompt Reviewer：只检查缺字段、职责冲突、过长、缺失败处理、破坏 truth files、覆盖用户手写内容；审不过就修补字段。",
                            "要求：每个字段短而硬，避免空话；重点修复卡住、低分、跳章、状态断档、模型鉴权、输出格式不完整和长上下文漂移。",
                            "",
                            JSON.stringify({
                                bookId,
                                targetScore,
                                pitfalls: digest.pitfalls,
                                wikiLessons: digest.wikiLessons,
                                promptWriterDraft: digest.promptWriterDraft,
                                promptReview: digest.promptReview,
                                promptPatches: digest.promptPatches,
                                summaryMarkdown: digest.summaryMarkdown,
                            }, null, 2),
                        ].join("\n"),
                    },
                ], { temperature: llm.temperature ?? 0.22 });
                const parsed = extractJsonObject(response.content);
                if (parsed && typeof parsed === "object" && (parsed.promptWriterDraft || parsed.promptPatches)) {
                    const promptWriterDraft = parsed.promptWriterDraft && typeof parsed.promptWriterDraft === "object"
                        ? { ...digest.promptWriterDraft, ...parsed.promptWriterDraft }
                        : { ...digest.promptWriterDraft, ...parsed.promptPatches };
                    const reviewBase = {
                        ...digest,
                        pitfalls: Array.isArray(parsed.pitfalls) ? uniqueLines(parsed.pitfalls, 18) : digest.pitfalls,
                        wikiLessons: Array.isArray(parsed.wikiLessons) ? uniqueLines(parsed.wikiLessons, 12) : digest.wikiLessons,
                        promptWriterDraft,
                        promptPatches: promptWriterDraft,
                    };
                    const promptReview = reviewPromptGovernanceDigest(reviewBase, targetScore);
                    const promptPatches = promptReview.promptPatches || Object.fromEntries(PROMPT_GOVERNANCE_AGENTS.map((agent) => [agent, normalizePromptPatchEntry(agent, promptWriterDraft[agent], [...reviewBase.pitfalls, ...reviewBase.wikiLessons], targetScore)]));
                    digest = {
                        ...digest,
                        pitfalls: reviewBase.pitfalls,
                        wikiLessons: reviewBase.wikiLessons,
                        promptWriterDraft,
                        promptReview,
                        promptPatches,
                        summaryMarkdown: limitText([
                            parsed.summaryMarkdown || digest.summaryMarkdown,
                            "",
                            "## Prompt Reviewer 审计",
                            `- 结论：${promptReview.pass ? "通过" : "存在 critical 阻断，禁止自动应用"}`,
                            `- 自动补齐/压缩字段：${promptReview.fixedFields.length || 0}`,
                            ...(promptReview.issues.length ? promptReview.issues.slice(0, 8).map((issue) => `- ${issue.agent}.${issue.field}：${issue.message}`) : ["- 未发现字段缺失、职责冲突、过长或失败处理缺口。"]),
                        ].join("\n"), 12000),
                        llmRefined: true,
                    };
                }
            }
            catch (error) {
                warnings.push(`模型精修不可用，已使用本地确定性治理：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        let profiles = null;
        if (body?.apply) {
            if (digest.promptReview && digest.promptReview.pass === false) {
                return c.json({ error: "Prompt Reviewer 发现 critical 阻断，未写入提示词。", digest, warnings }, 409);
            }
            ({ profiles } = await applyPromptGovernanceDigest(root, state, bookId, digest, targetScore, warnings));
        }
        return c.json({ ok: true, digest, warnings, applied: Boolean(body?.apply), profiles });
    });
    app.post("/api/v1/atelier/polish", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const original = normalizeMarkdownText(body?.text);
        if (!original) {
            return c.json({ error: "text is required" }, 400);
        }
        let polished = heuristicPolishText(original);
        if (body?.useLLM !== false) {
            try {
                const currentConfig = await loadCurrentProjectConfig();
                const client = createLLMClient(currentConfig.llm);
                const response = await chatCompletion(client, currentConfig.llm.model, [
                    {
                        role: "system",
                        content: [
                            "你是长篇小说精修编辑。只输出 JSON，不要 Markdown。",
                            "保留事实、视角和角色知识边界，不要新增剧情。",
                            "JSON 结构：{\"revised\":\"润色后正文\",\"changes\":[{\"before\":\"原句或问题\",\"after\":\"新句或处理\",\"reason\":\"修改原因\"}]}。",
                            "changes 最多 8 条，原因要具体到节奏、画面、动机、对白或连续性。",
                        ].join("\n"),
                    },
                    {
                        role: "user",
                        content: `请润色并标注修改原因：\n\n${original}`,
                    },
                ], { temperature: 0.55, maxTokens: 4096 });
                const parsed = extractJsonObject(response.content);
                if (parsed && typeof parsed.revised === "string" && Array.isArray(parsed.changes)) {
                    polished = {
                        revised: normalizeMarkdownText(parsed.revised),
                        changes: parsed.changes.slice(0, 8).map((change) => ({
                            before: String(change?.before ?? "").slice(0, 240),
                            after: String(change?.after ?? "").slice(0, 240),
                            reason: String(change?.reason ?? "改善表达").slice(0, 240),
                        })).filter((change) => change.before || change.after || change.reason),
                        engine: "deepseek",
                    };
                }
            }
            catch {
                // Local polishing stays available when the upstream model is busy or rate-limited.
            }
        }
        const html = renderRevisionHtml(original, polished.revised, polished.changes);
        let relativePath = null;
        if (body?.save === true) {
            const title = `润色记录-${vaultStamp()}`;
            relativePath = `30-参考素材/${title}.md`;
            await writeVaultFile(root, relativePath, [
                `# ${title}`,
                "",
                `- 引擎：${polished.engine}`,
                `- 时间：${new Date().toISOString()}`,
                "",
                "## 原文",
                "",
                original,
                "",
                "## 润色后",
                "",
                polished.revised,
                "",
                "## 修改原因",
                "",
                ...polished.changes.map((change) => `- ${change.before} -> ${change.after}：${change.reason}`),
                "",
            ].join("\n"));
            await appendVaultIndexEntry(root, "30-参考素材/素材列表.md", relativePath, title, polished.engine);
        }
        return c.json({ ok: true, original, revised: polished.revised, changes: polished.changes, engine: polished.engine, html, relativePath });
    });
    app.post("/api/v1/covers/generate", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const result = await saveGeneratedCover(root, body);
        return c.json({ ok: true, ...result });
    });
    // --- Obsidian writing vault ---
    app.get("/api/v1/vault", async (c) => {
        return c.json(await loadVaultSummary(root));
    });
    app.get("/api/v1/vault/document", async (c) => {
        try {
            const payload = await resolveVaultMarkdownDocument(root, c.req.query("path") ?? "");
            return c.json({
                ok: true,
                relativePath: payload.relativePath,
                document: payload.document,
            });
        }
        catch (error) {
            const status = error instanceof ApiError ? error.status : 500;
            return c.json({ error: error instanceof Error ? error.message : "Failed to render document" }, status);
        }
    });
    app.post("/api/v1/vault/init", async (c) => {
        await ensureWritingVault(root);
        const latest = await readOptionalText(join(root, ".hardwrite", "radar-latest.json"));
        if (latest.trim()) {
            try {
                await persistRadarArtifacts(root, JSON.parse(latest));
            }
            catch {
                // Ignore a damaged cache; the JSON cache remains available for manual inspection.
            }
        }
        return c.json(await loadVaultSummary(root));
    });
    app.get("/api/v1/vault/file", async (c) => {
        const rawPath = c.req.query("path") ?? "";
        const decoded = decodeURIComponent(rawPath);
        if (!decoded || decoded.includes("..") || isAbsolute(decoded) || !decoded.endsWith(".md")) {
            return c.text("Invalid vault path", 400);
        }
        const vault = await ensureWritingVault(root);
        const fullPath = join(vault, decoded);
        if (relative(vault, fullPath).startsWith("..")) {
            return c.text("Invalid vault path", 400);
        }
        return c.text(await readFile(fullPath, "utf-8"), 200, { "Content-Type": "text/markdown; charset=utf-8" });
    });
    app.get("/api/v1/vault/asset", async (c) => {
        const rawPath = c.req.query("path") ?? "";
        const decoded = decodeURIComponent(rawPath);
        if (!decoded || decoded.includes("..") || isAbsolute(decoded) || !/\.(svg|png|jpg|jpeg|webp)$/i.test(decoded)) {
            return c.text("Invalid vault asset path", 400);
        }
        const vault = await ensureWritingVault(root);
        const fullPath = join(vault, decoded);
        if (relative(vault, fullPath).startsWith("..")) {
            return c.text("Invalid vault asset path", 400);
        }
        const ext = decoded.split(".").pop()?.toLowerCase();
        const type = ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        return c.body(await readFile(fullPath), 200, { "Content-Type": type });
    });
    app.post("/api/v1/vault/import-text", async (c) => {
        const body = await readFlexibleBody(c);
        const result = await importVaultText(root, body);
        return c.json({ ok: true, ...result });
    });
    app.post("/api/v1/vault/import-url", async (c) => {
        const body = await readFlexibleBody(c);
        const url = String(body?.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) {
            return c.json({ error: "url must be http(s)" }, 400);
        }
        const response = await fetchWithProxy(url);
        if (!response.ok) {
            return c.json({ error: `fetch failed: ${response.status}` }, 502);
        }
        const html = await response.text();
        const titleFromHtml = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
        const title = String(body?.title ?? "").trim() || decodeHtmlEntities(titleFromHtml ?? url);
        const result = await importVaultText(root, {
            title,
            type: body?.type,
            sourceUrl: url,
            text: htmlToReadableText(html),
        });
        return c.json({ ok: true, ...result });
    });
    app.post("/api/v1/vault/sync-books", async (c) => {
        const books = await buildBooksIndex(root, state);
        return c.json({ ok: true, books });
    });
    // --- Radar Scan ---
    app.get("/api/v1/radar/latest", async (c) => {
        try {
            const raw = await readFile(join(root, ".hardwrite", "radar-latest.json"), "utf-8");
            return c.json({ result: JSON.parse(raw) });
        }
        catch {
            return c.json({ result: null });
        }
    });
    app.post("/api/v1/radar/scan", async (c) => {
        broadcast("radar:start", {});
        try {
            const pipeline = new PipelineRunner(await buildPipelineConfig());
            const result = await pipeline.runRadar();
            await persistRadarArtifacts(root, result);
            broadcast("radar:complete", { result });
            return c.json(result);
        }
        catch (e) {
            broadcast("radar:error", { error: String(e) });
            return c.json({ error: String(e) }, 500);
        }
    });
    // --- Doctor (environment health check) ---
    type DoctorChecks = {
        hardwriteJson: boolean;
        projectEnv: boolean;
        globalEnv: boolean;
        booksDir: boolean;
        llmConnected: boolean;
        bookCount: number;
        llmProbeCached?: boolean;
        llmProbeStale?: boolean;
        llmProbeAgeMs?: number;
        llmProbeStatus?: "fresh" | "cached" | "stale-timeout" | "failed" | "error";
    };
    type DoctorLlmProbeCache = {
        key: string;
        ok: boolean;
        checkedAt: number;
    };
    let doctorLlmProbeCache: DoctorLlmProbeCache | null = null;
    const doctorLlmSuccessTtlMs = () => Math.max(5000, Math.min(300000, Number(process.env.HARDWRITE_DOCTOR_LLM_SUCCESS_TTL_MS || 120000)));
    const doctorLlmTimeoutGraceMs = () => Math.max(0, Math.min(900000, Number(process.env.HARDWRITE_DOCTOR_LLM_TIMEOUT_GRACE_MS || 600000)));
    const doctorProbeKey = (config: Awaited<ReturnType<typeof loadCurrentProjectConfig>>) => [
        config.llm.service ?? config.llm.provider ?? "",
        config.llm.baseUrl ?? "",
        config.llm.apiFormat ?? "",
        config.llm.stream ? "stream" : "no-stream",
        config.llm.model ?? "",
        config.llm.proxyUrl ?? "",
        config.llm.apiKey ? "key" : "no-key",
    ].join("|");
    const readDoctorChecks = async () => {
        const { existsSync } = await import("node:fs");
        const { GLOBAL_ENV_PATH } = await import("@juanshe/core");
        const checks: DoctorChecks = {
            hardwriteJson: existsSync(join(root, "hardwrite.json")),
            projectEnv: existsSync(join(root, ".env")),
            globalEnv: existsSync(GLOBAL_ENV_PATH),
            booksDir: existsSync(join(root, "books")),
            llmConnected: false,
            bookCount: 0,
        };
        try {
            const books = await state.listBooks();
            checks.bookCount = books.length;
        }
        catch { /* ignore */ }
        try {
            const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
            const service = currentConfig.llm.service ?? currentConfig.llm.provider;
            const cacheKey = doctorProbeKey(currentConfig);
            const now = Date.now();
            const cachedAgeMs = doctorLlmProbeCache?.key === cacheKey ? now - doctorLlmProbeCache.checkedAt : Number.POSITIVE_INFINITY;
            if (doctorLlmProbeCache?.ok && cachedAgeMs <= doctorLlmSuccessTtlMs()) {
                checks.llmConnected = true;
                checks.llmProbeCached = true;
                checks.llmProbeAgeMs = Math.max(0, cachedAgeMs);
                checks.llmProbeStatus = "cached";
                return checks;
            }
            const doctorLlmTimeoutMs = Math.max(2500, Math.min(30000, Number(process.env.HARDWRITE_DOCTOR_LLM_TIMEOUT_MS || 15000)));
            const probe = await Promise.race([
                probeServiceCapabilities({
                    root,
                    service,
                    apiKey: currentConfig.llm.apiKey,
                    baseUrl: currentConfig.llm.baseUrl,
                    preferredApiFormat: currentConfig.llm.apiFormat,
                    preferredStream: currentConfig.llm.stream,
                    preferredModel: currentConfig.llm.model,
                    proxyUrl: currentConfig.llm.proxyUrl,
                }),
                new Promise<{ ok: false; timedOut: true }>((resolve) => {
                    setTimeout(() => resolve({ ok: false, timedOut: true }), doctorLlmTimeoutMs);
                }),
            ]);
            if (probe.ok) {
                doctorLlmProbeCache = { key: cacheKey, ok: true, checkedAt: Date.now() };
                checks.llmConnected = true;
                checks.llmProbeCached = false;
                checks.llmProbeAgeMs = 0;
                checks.llmProbeStatus = "fresh";
            }
            else if ("timedOut" in probe && probe.timedOut && doctorLlmProbeCache?.ok && doctorLlmProbeCache.key === cacheKey && cachedAgeMs <= doctorLlmTimeoutGraceMs()) {
                checks.llmConnected = true;
                checks.llmProbeCached = true;
                checks.llmProbeStale = true;
                checks.llmProbeAgeMs = Math.max(0, cachedAgeMs);
                checks.llmProbeStatus = "stale-timeout";
            }
            else {
                checks.llmConnected = false;
                checks.llmProbeCached = false;
                checks.llmProbeStatus = "failed";
            }
        }
        catch {
            checks.llmProbeStatus = "error";
        }
        return checks;
    };
    app.get("/api/v1/doctor", async (c) => c.json(await readDoctorChecks()));
    app.get("/api/v1/system/health", async (c) => c.json(await readDoctorChecks()));
    // 内容类型「真生成」:内容类型 → 装配(角色蓝图 + 挂载技能进系统提示)→ buildWritingSystemPrompt
    // → chatCompletion(走 core LLM 抽象,模型/密钥由项目配置提供)→ 去外层围栏 → core 渲染成平台成品。
    // 小说请走长篇写作流水线,本端点只服务编辑部文章类(公众号/小红书/知乎/X)。
    app.post("/api/v1/content-type/:id/write", async (c) => {
        const id = String(c.req.param("id") || "").trim();
        const body = await c.req.json().catch(() => ({}));
        const brief = limitText(String(body?.brief ?? body?.topic ?? ""), 8000).trim();
        const bodyAccountVoice = body?.accountVoice ? limitText(String(body.accountVoice), 2000).trim() : "";
        const profile = getContentTypeProfile(id);
        if (!profile) {
            return c.json({ error: { code: "UNKNOWN_CONTENT_TYPE", message: `未知内容类型: ${id}` } }, 404);
        }
        if (profile.usesLegacyNovelPipeline) {
            return c.json({ error: { code: "USE_NOVEL_PIPELINE", message: "小说请走长篇写作流水线,本端点只用于文章类内容。" } }, 400);
        }
        if (!brief) {
            return c.json({ error: { code: "EMPTY_INPUT", message: "brief(选题/要求)必填" } }, 400);
        }
        const assembled = await assembleContentType(SKILLS_DIR, id);
        if (!assembled) {
            return c.json({ error: { code: "UNKNOWN_CONTENT_TYPE", message: `内容类型装配失败: ${id}` } }, 404);
        }
        // 账号风格画像(长期定义 + 自我进化):把历史沉淀的风格/规避规则注入 accountVoice。
        const styleProfile = await loadAccountStyle(root, id);
        const accountVoice = [buildAccountVoicePrompt(styleProfile), bodyAccountVoice].filter(Boolean).join("\n") || undefined;
        const systemPrompt = buildWritingSystemPrompt({
            profile: assembled.profile,
            skillPrompt: assembled.skillPrompt,
            accountVoice,
        });
        const userPrompt = [
            `请围绕以下选题/要求,创作一篇可直接发布的「${profile.label.zh}」成品:`,
            "",
            brief,
            "",
            "硬性要求:",
            "- 直接输出正文 Markdown,不要任何解释、开场白或「以下是…」之类的话。",
            "- 标题用 #,小标题用 ##,引用用 >,列表用 -;不要用代码块包裹整篇。",
            profile.lengthHint ? `- 篇幅约 ${profile.lengthHint.min}–${profile.lengthHint.max} 字。` : "",
        ].filter(Boolean).join("\n");

        let currentConfig;
        try {
            currentConfig = await loadCurrentProjectConfig();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "未配置可用的 LLM 服务/密钥";
            return c.json({ error: { code: "LLM_CONFIG_ERROR", message } }, 400);
        }
        const model = String(body?.model || currentConfig.llm.model || "").trim();
        if (!model) {
            return c.json({ error: { code: "LLM_CONFIG_ERROR", message: "未配置写作模型,请先在设置里选择模型。" } }, 400);
        }
        const temperature = Number.isFinite(Number(body?.temperature))
            ? Number(body.temperature)
            : (currentConfig.llm.temperature ?? 0.7);
        const maxTokens = Math.max(Number(body?.maxTokens) || 0, Number(currentConfig.llm.maxTokens) || 0, 4096);

        const revise = body?.revise !== false; // 默认走「生成→评审→修订」循环;传 revise:false 只生成
        const stripOuterFence = (text) => {
            const t = String(text || "").trim();
            const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
            return (m ? m[1] : t).trim();
        };
        const usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        const addUsage = (u) => {
            if (!u) return;
            usageTotals.promptTokens += Number(u.promptTokens) || 0;
            usageTotals.completionTokens += Number(u.completionTokens) || 0;
            usageTotals.totalTokens += Number(u.totalTokens) || 0;
        };
        const client = createLLMClient(currentConfig.llm);
        const warnings = [];

        // 自带搜索(可选):配了 JUANSHE_SEARCH_API_KEY 才联网检索增料,注入初稿提示词;未配则跳过。
        let researchFindings = [];
        if (body?.research !== false) {
            researchFindings = await runWebResearch(buildResearchQueries(brief)).catch(() => []);
            if (researchFindings.length)
                warnings.push(`已检索 ${researchFindings.length} 条参考资料用于增料`);
        }
        const researchContext = buildResearchContext(researchFindings);
        const draftUserPrompt = researchContext ? `${researchContext}\n\n---\n\n${userPrompt}` : userPrompt;

        // 第一段:初稿写手(draft-writer)
        let draft;
        try {
            const draftRes = await chatCompletion(client, model, [
                { role: "system", content: systemPrompt },
                { role: "user", content: draftUserPrompt },
            ], { temperature, maxTokens });
            addUsage(draftRes.usage);
            draft = stripOuterFence(draftRes.content);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isAuth = /api key|unauthor|401|forbidden|403/i.test(message);
            return c.json({ error: { code: isAuth ? "LLM_CONFIG_ERROR" : "GENERATION_FAILED", message } }, isAuth ? 400 : 502);
        }
        if (!draft) {
            return c.json({ error: { code: "EMPTY_OUTPUT", message: "模型未返回正文" } }, 502);
        }

        // 第二段起:多轮「评审(prose-critic)→ 修订(style-rewriter)→ 复评分」,低于阈值再修一轮,
        // 直到达标 / 用尽轮次 / 超时预算。评审-修订尽力而为,失败保留当前稿。
        let markdown = draft;
        let critique = null;            // 最近一次评审报告
        let revised = false;
        let reviseRounds = 0;
        const critiqueHistory = [];
        if (revise) {
            const maxRounds = Math.max(1, Math.min(Number(body?.maxReviseRounds) || 2, 4));
            const passScore = Number(body?.passScore) || 85;
            const reviseDeadline = Date.now() + (Number(process.env.HARDWRITE_ARTICLE_BUDGET_MS) || 300000); // 默认 5min 封顶
            let current = draft;
            const reviserSkillPrompt = await mountSkills(SKILLS_DIR, ["style/prose-humanize"]);
            try {
                for (let round = 0; round < maxRounds; round++) {
                    if (Date.now() > reviseDeadline) {
                        warnings.push("已达文章时间预算,提前结束评审-修订循环,取当前稿");
                        break;
                    }
                    const critRes = await chatCompletion(client, model, [
                        { role: "system", content: buildCriticSystemPrompt(profile) },
                        { role: "user", content: `稿件如下,请评审:\n\n${current}` },
                    ], { temperature: 0.2, maxTokens: 2048 });
                    addUsage(critRes.usage);
                    const report = parseCritiqueReport(critRes.content);
                    critique = report;
                    critiqueHistory.push({ round: round + 1, score: report.score, issues: report.issues.length, overall: report.overall });
                    if (critiquePasses(report, passScore))
                        break; // 达标,停
                    const issuesText = report.issues
                        .map((it, idx) => `${idx + 1}. [${it.severity}] ${it.where || "(未定位)"}:${it.problem} → ${it.fix}`)
                        .join("\n");
                    const revRes = await chatCompletion(client, model, [
                        { role: "system", content: buildReviserSystemPrompt({ profile, skillPrompt: reviserSkillPrompt }) },
                        { role: "user", content: `原稿:\n\n${current}\n\n评审意见(按严重度优先处理):\n${issuesText}\n\n请输出修订后的完整正文 Markdown。` },
                    ], { temperature, maxTokens });
                    addUsage(revRes.usage);
                    const revisedMd = stripOuterFence(revRes.content);
                    if (!revisedMd)
                        break; // 修订没出稿,停
                    current = revisedMd;
                    markdown = revisedMd;
                    revised = true;
                    reviseRounds = round + 1;
                }
            }
            catch (error) {
                warnings.push(`评审/修订未完成,已返回当前稿:${error instanceof Error ? error.message : String(error)}`);
            }
        }

        // 自我进化:用本次最终评审更新账号风格画像(反复命中的问题沉淀成"规避规则",喂下次写作)。
        if (critique) {
            const evolved = evolveStyleProfile(styleProfile, critique);
            if (evolved.version !== styleProfile.version) {
                await saveAccountStyle(root, id, evolved).catch(() => {});
            }
        }

        const platform = assembled.platforms[0];
        let rendered = null;
        if (platform) {
            try {
                rendered = renderForPlatform(platform, markdownToContentDocument(markdown));
            }
            catch { rendered = null; }
        }
        // 持久化:把成品入库,供前台"已生成成品"列表复用——编辑部产出要留存,不能只做一次性预览。
        let savedDraftId = null;
        try {
            const draftsDir = join(root, "content-drafts", id);
            await mkdir(draftsDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            const titleMatch = markdown.match(/^#\s+(.+)$/m);
            const title = String((titleMatch ? titleMatch[1] : brief)).slice(0, 80).trim();
            savedDraftId = `${id}__${ts}`;
            const draftMeta = {
                id: savedDraftId,
                contentType: id,
                platformLabel: profile.label?.zh || id,
                title,
                brief: brief.slice(0, 200),
                finalScore: critique?.score ?? null,
                revised,
                chars: markdown.length,
                createdAt: new Date().toISOString(),
            };
            await writeFile(join(draftsDir, `${ts}.md`), `<!--meta ${JSON.stringify(draftMeta)} -->\n${markdown}`, "utf-8");
        }
        catch {
            /* 落盘失败不阻断返回 */
        }
        return c.json({
            contentType: id,
            platform: platform ?? null,
            markdown,
            savedDraftId,
            draftMarkdown: revised ? draft : undefined,
            critique,
            critiqueHistory,
            revised,
            reviseRounds,
            finalScore: critique?.score ?? null,
            researchUsed: researchFindings.length > 0,
            researchFindings,
            accountStyleRulesApplied: styleProfile.learnedRules.length,
            rendered,
            missingRoles: assembled.missingRoles,
            usedSkills: assembled.profile.skills,
            warnings,
            model,
            usage: usageTotals,
        });
    });
    // 已生成成品库:列出 content-drafts/ 下所有多平台成品(供前台"已生成成品"复用)。
    app.get("/api/v1/content-drafts", async (c) => {
        const draftsRoot = join(root, "content-drafts");
        const out = [];
        try {
            const types = await readdir(draftsRoot, { withFileTypes: true }).catch(() => []);
            for (const t of types) {
                if (!t.isDirectory())
                    continue;
                const files = await readdir(join(draftsRoot, t.name)).catch(() => []);
                for (const f of files.filter((x) => x.endsWith(".md"))) {
                    const raw = await readFile(join(draftsRoot, t.name, f), "utf-8").catch(() => "");
                    if (!raw)
                        continue;
                    const m = raw.match(/^<!--meta ([\s\S]+?) -->/);
                    let meta = {};
                    try {
                        meta = m ? JSON.parse(m[1]) : {};
                    }
                    catch {
                        meta = {};
                    }
                    const bodyText = raw.replace(/^<!--meta [\s\S]+? -->\n?/, "");
                    out.push({
                        id: meta.id || `${t.name}__${f.replace(/\.md$/, "")}`,
                        contentType: meta.contentType || t.name,
                        platformLabel: meta.platformLabel || t.name,
                        title: meta.title || (bodyText.match(/^#\s+(.+)$/m)?.[1] ?? "(无标题)"),
                        brief: meta.brief || "",
                        finalScore: meta.finalScore ?? null,
                        revised: meta.revised ?? false,
                        chars: meta.chars ?? bodyText.length,
                        createdAt: meta.createdAt || "",
                        excerpt: bodyText.replace(/[#>*`>\-]/g, "").replace(/\s+/g, " ").slice(0, 140).trim(),
                        markdown: bodyText,
                    });
                }
            }
        }
        catch {
            /* 目录不存在=还没生成过,返回空 */
        }
        out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        return c.json({ drafts: out, total: out.length });
    });
    // 删除一篇多平台成品:id 形如 "<contentType>__<timestamp>" → content-drafts/<type>/<ts>.md。
    app.delete("/api/v1/content-drafts/:id", async (c) => {
        const rawId = String(c.req.param("id") || "");
        const sep = rawId.indexOf("__");
        if (sep <= 0)
            return c.json({ error: "invalid draft id" }, 400);
        const contentType = rawId.slice(0, sep);
        const ts = rawId.slice(sep + 2);
        // 安全:类型只允许字母/下划线;时间戳禁止路径字符与穿越。
        if (!/^[a-z_]+$/.test(contentType) || !/^[\w:.\-]+$/.test(ts) || ts.includes("..") || ts.includes("/")) {
            return c.json({ error: "invalid draft id" }, 400);
        }
        const draftsRoot = join(root, "content-drafts");
        const filePath = join(draftsRoot, contentType, `${ts}.md`);
        if (!filePath.startsWith(draftsRoot)) {
            return c.json({ error: "invalid path" }, 400);
        }
        try {
            const { rm } = await import("node:fs/promises");
            await rm(filePath);
            return c.json({ ok: true, id: rawId });
        }
        catch {
            return c.json({ error: "draft not found" }, 404);
        }
    });
    // 查看账号风格画像(长期定义 + 自我进化沉淀的规避规则)
    app.get("/api/v1/content-type/:id/style", async (c) => {
        const id = String(c.req.param("id") || "").trim();
        if (!getContentTypeProfile(id)) {
            return c.json({ error: { code: "UNKNOWN_CONTENT_TYPE", message: `未知内容类型: ${id}` } }, 404);
        }
        const styleProfile = await loadAccountStyle(root, id);
        return c.json({ contentType: id, style: styleProfile, voicePrompt: buildAccountVoicePrompt(styleProfile) });
    });
    // 多平台渲染统一入口:Markdown → Content AST → 平台成品(公众号/小红书/知乎/X)。
    // 渲染逻辑全部来自 core(单一来源)。真实章节由前端先取正文再传入 markdown。
    app.post("/api/v1/render", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const platform = String(body?.platform ?? "wechat");
        const markdown = String(body?.markdown ?? "");
        // B9 模板系统:wechat 平台可指定 template id(business/knowledge/story/literary/minimal)
        // 其他平台 template 参数被忽略(它们没有模板系统)。
        const templateId = body?.template ? String(body.template) : undefined;
        const validPlatforms = ["wechat", "xiaohongshu", "zhihu", "x", "newsletter"];
        if (!validPlatforms.includes(platform)) {
            return c.json({ error: { code: "BAD_PLATFORM", message: `unsupported platform: ${platform}` } }, 400);
        }
        if (!markdown.trim()) {
            return c.json({ error: { code: "EMPTY_INPUT", message: "markdown is required" } }, 400);
        }
        const doc = markdownToContentDocument(markdown);
        const rendered = renderForPlatform(platform, doc, templateId ? { templateId } : undefined);
        return c.json(rendered);
    });
    // B9 列出可用 wechat 模板,UI 下拉用
    app.get("/api/v1/render/templates", (c) => {
        return c.json({ wechat: listWechatTemplates(), default: DEFAULT_WECHAT_TEMPLATE });
    });
    return app;
}
// --- Standalone runner ---
export async function startStudioServer(root, port = 4567) {
    const config = await loadProjectConfig(root, { consumer: "studio", requireApiKey: false });
    const app = createStudioServer(config, root);
    // 接受请求前先清掉因上次重启残留的僵尸 run,确保写作槽干净,不再卡 409 stale-slot。
    await reconcileStaleTaskRuns(root);
    // 进程级兜底:任一"发后不理"后台任务的漏网 Promise 拒绝(write-next/create/批处理 IIFE、
    // 满屏 void appendBookAgentEvent/updateTaskRun 等)在 Node 15+ 默认会终止进程,从而把
    // "某个后台小错"放大成"整服务 502"。这里只记日志、绝不退出;handler 内的错误仍由 app.onError 正常处理。
    if (!globalThis.__juansheGuardsInstalled) {
        globalThis.__juansheGuardsInstalled = true;
        process.on("unhandledRejection", (reason) => { console.error("[unhandledRejection]", reason); });
        process.on("uncaughtException", (err) => { console.error("[uncaughtException]", err); });
    }
    // 默认只绑 127.0.0.1(桌面/单机产品不暴露局域网,防 BYOK 密钥被同网他人直连窃取);
    // 需跨机访问时显式设 HARDWRITE_BIND_HOST=0.0.0.0。
    const hostname = process.env.HARDWRITE_BIND_HOST || "127.0.0.1";
    console.log(`卷舍 Studio 后端已启动:http://${hostname}:${port}`);
    serve({ fetch: app.fetch, port, hostname });
}
