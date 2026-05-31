/**
 * Agent 交接契约(显式协调层)—— 把原本散在 runner 顺序、server AGENT_ROSTER、agent 提示词里的
 * "谁产出什么、谁需要什么、交给谁"统一成**单一权威声明**,并提供运行时校验:
 * 下游 agent 启动前,检查上游该产出的产物是否到位,缺失即 fail-fast 带归因(而非默默产出垃圾)。
 *
 * 纯数据 + 纯函数。runner 在关键交接点软校验(缺失记警告/归因);严格模式可由调用方升级为阻断。
 */

export interface AgentContract {
  readonly id: string;
  readonly label: string;
  /** 启动前需要的上游产物 key。 */
  readonly requires: readonly string[];
  /** 本 agent 产出的产物 key。 */
  readonly produces: readonly string[];
  /** 正常情况下交接给谁。 */
  readonly handoffTo: readonly string[];
  /** 阻塞条件(产出不达标时不得交接)。 */
  readonly blocking?: string;
  /** 本 agent"检查什么 / 对照什么真相源"——防漂移的显式判据(单一权威声明)。 */
  readonly checks?: readonly string[];
  /** 检查不过时,把结果打回给谁重做(反馈环的回边)。 */
  readonly reworkBackTo?: readonly string[];
}

/** 长篇写作链的权威交接契约(单一权威声明,与后端 AGENT_ROSTER 对齐)。
 *  每条含:依赖(requires)→ 产出(produces)→ 交给谁(handoffTo)→ 检查什么对照什么(checks)→ 不过打回给谁(reworkBackTo)。
 *  这是一个带反馈环的循环工作流:审稿/校验/总编不过 → 打回写手/修稿 → 重写 → 再审,直到过关或到轮次上限。 */
export const AGENT_CONTRACTS: readonly AgentContract[] = [
  { id: "managing-editor", label: "执行主编(总指挥)", requires: [], produces: ["run_timeline", "rework_loop_state"], handoffTo: ["planner"],
    checks: ["编排谁先谁后、决定下一步调哪个 agent", "管理返工循环:把审稿/校验/总编的不过结果路由回写手/修稿", "判断何时停(到轮次上限或收益平台期)、何时升级人审"] },
  { id: "radar", label: "市场雷达", requires: [], produces: ["market_signals", "book_description", "positioning_notes"], handoffTo: ["architect", "planner"],
    checks: ["选题与平台定位是否对齐(对照 book 定位)"] },
  { id: "architect", label: "架构师", requires: [], produces: ["story_frame", "volume_map", "character_matrix", "pending_hooks"], handoffTo: ["foundation-reviewer"],
    checks: ["地基自洽:目标链递进、角色有可反复受压的欲望、伏笔可管理、truth files 互引一致"] },
  { id: "foundation-reviewer", label: "建书复审官", requires: ["story_frame", "volume_map", "character_matrix"], produces: ["foundation_review", "blocking_gaps"], handoffTo: ["planner"], blocking: "foundation_review 未通过则不得进入写章",
    checks: ["复审地基完整性/缺段/冲突,对照 story_frame + volume_map + character_matrix"], reworkBackTo: ["architect"] },
  { id: "planner", label: "规划师", requires: ["story_frame"], produces: ["chapter_intent", "context_package", "rule_stack"], handoffTo: ["writer"],
    checks: ["本章意图是否服务主线、钩子账本结清、3-5 章节奏,对照 volume_map + pending_hooks + current_state"] },
  { id: "writer", label: "写手", requires: ["chapter_intent", "context_package"], produces: ["chapter_draft"], handoffTo: ["auditor"], blocking: "chapter_draft 为空则不得交接审稿",
    checks: ["按 chapter_intent + context_package 写,守 story_frame 的性格锁/禁忌/3岁机制 + 嗓音指纹"] },
  { id: "auditor", label: "审稿官", requires: ["chapter_draft"], produces: ["audit_result", "score"], handoffTo: ["reviser"],
    checks: ["连续性 / 性格漂移(对照 character_matrix 性格底色 + 三问测试) / 视角一致 / 世界规则 / 伏笔超期 / 信息边界,对照 story_frame YAML + character_matrix + pending_hooks + current_state"], reworkBackTo: ["reviser", "writer"] },
  { id: "reviser", label: "修稿师", requires: ["chapter_draft", "audit_result"], produces: ["revised_chapter"], handoffTo: ["auditor"],
    checks: ["按 audit_result 逐条修,不得引入新矛盾(对照 audit_result + 真相文件)"] },
  { id: "length-normalizer", label: "字数治理官", requires: ["chapter_draft"], produces: ["normalized_chapter"], handoffTo: ["polisher"],
    checks: ["字数落在目标区间、不压崩、不截断"] },
  { id: "polisher", label: "文字润色师", requires: ["chapter_draft"], produces: ["polished_chapter"], handoffTo: ["auditor"],
    checks: ["去 AI 腔、节奏、文风,对照 style_profile 嗓音指纹 + style_guide"] },
  { id: "chapter-analyzer", label: "章节分析官", requires: ["chapter_draft"], produces: ["chapter_summary", "state_delta", "wiki_candidates"], handoffTo: ["state-validator"],
    checks: ["抽取本章事实、回写 chapter_summaries / current_state / wiki(滚动记忆,防越写越忘)"] },
  { id: "state-validator", label: "状态校验员", requires: ["state_delta"], produces: ["truth_validation"], handoffTo: ["style-governor"], blocking: "truth_validation 失败则阻断落库",
    checks: ["真相文件变更与既有设定是否一致,冲突即阻断落库,对照所有 truth files"], reworkBackTo: ["reviser"] },
  { id: "style-governor", label: "风格指纹官", requires: ["chapter_draft"], produces: ["style_fingerprint", "style_adherence"], handoffTo: ["quality-reporter"],
    checks: ["本章风格指纹贴合度,对照 story/style_profile.json"] },
  { id: "reader-critic", label: "读者评审官", requires: ["chapter_draft"], produces: ["reader_score"], handoffTo: ["quality-reporter"],
    checks: ["读者信号:钩子 / 沉浸 / 清晰 / 追读意愿"] },
  { id: "quality-reporter", label: "质量报告官", requires: ["audit_result"], produces: ["chapter_quality_report"], handoffTo: ["editor-in-chief", "prompt-governor"],
    checks: ["汇总各信号、计算 Gate、失败归因、主责 agent、下一步修法,对照 targetScore"], reworkBackTo: ["reviser"] },
  { id: "editor-in-chief", label: "总编(终审)", requires: ["chapter_quality_report", "audit_result", "reader_score", "style_fingerprint"], produces: ["editorial_verdict", "editorial_note", "next_direction"], handoffTo: ["human", "planner"], blocking: "verdict=rework 则不得进入下一章",
    checks: ["读全部专家信号做整体编辑裁决(通过/返工)+ 批语 + 下一程方向,对照 story_bible 整体成色与读者留存;挂 editorial/editor-in-chief skill"], reworkBackTo: ["reviser", "writer"] },
  { id: "prompt-governor", label: "提示词治理官", requires: ["chapter_quality_report"], produces: ["prompt_governance", "agent_profile_patch", "pitfall_digest"], handoffTo: ["planner", "writer", "auditor", "reviser", "polisher", "quality-reporter"],
    checks: ["把失败日志/质量报告/Wiki/human_notes 压缩为短、硬、可审计的提示词补丁", "只更新自动治理区块,不得覆盖用户手写提示词", "不得改 truth files、不得写正文、不得引入外部框架假设"] },
];

const BY_ID: Record<string, AgentContract> = Object.fromEntries(AGENT_CONTRACTS.map((c) => [c.id, c]));

export function getAgentContract(id: string): AgentContract | undefined {
  return BY_ID[id];
}

export function nextAgents(id: string): readonly string[] {
  return BY_ID[id]?.handoffTo ?? [];
}

export interface HandoffCheck {
  readonly ok: boolean;
  readonly agent: string;
  readonly missing: readonly string[];
  readonly reason: string;
}

function isPresent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * 校验某 agent 启动前,其 requires 的上游产物是否都到位(present & 非空)。
 * available:上游已产出的产物字典(key 对应 contract 的 produces/requires key)。
 */
export function validateHandoff(agentId: string, available: Record<string, unknown>): HandoffCheck {
  const contract = BY_ID[agentId];
  if (!contract) {
    return { ok: false, agent: agentId, missing: [], reason: `未知 agent: ${agentId}` };
  }
  const missing = contract.requires.filter((key) => !isPresent(available[key]));
  return {
    ok: missing.length === 0,
    agent: agentId,
    missing,
    reason: missing.length === 0
      ? `${contract.label} 上游产物齐备`
      : `${contract.label} 缺少上游产物:${missing.join(", ")}(归因:上游 ${upstreamProducersOf(missing).join(" / ") || "未知"} 未产出)`,
  };
}

/** 反查:哪些 agent 负责产出这些 key(用于缺失归因)。 */
export function upstreamProducersOf(keys: readonly string[]): string[] {
  const producers = new Set<string>();
  for (const c of AGENT_CONTRACTS) {
    if (c.produces.some((p) => keys.includes(p))) producers.add(c.id);
  }
  return [...producers];
}
