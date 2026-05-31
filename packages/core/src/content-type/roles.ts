/**
 * 角色目录(Role Catalog)—— 第4层:编辑部角色 id → 元信息 + 实现状态。
 *
 * ContentTypeProfile.roles 引用这里的 id。诚实标注 implemented:
 *   - novel 角色:已由现有 packages/core/src/agents/* 实现(novelAgentModule 指向模块)。
 *   - 文章类编辑部角色(§5):多为蓝图,逐个实现后置 implemented=true。
 * 运行装配时:implemented=false 的角色会进入 assembleContentType().missingRoles,UI/调用方据此提示。
 */

export interface RoleMeta {
  readonly id: string;
  readonly label: { readonly zh: string; readonly en: string };
  /** 一句话职责。 */
  readonly responsibility: string;
  /** 是否已有可运行的 Agent 实现。 */
  readonly implemented: boolean;
  /** 若由现有小说 pipeline 实现,指向其模块(packages/core/src/agents/<module>.ts)。 */
  readonly novelAgentModule?: string;
  /** 若由编辑部文章流水线实现,指向其模块(packages/core/src/editorial/<module>.ts)。 */
  readonly editorialModule?: string;
}

export const ROLE_CATALOG: Record<string, RoleMeta> = {
  // —— 现有小说 pipeline 角色(已实现) ——
  architect: { id: "architect", label: { zh: "架构师", en: "Architect" }, responsibility: "搭建故事框架与世界观骨架。", implemented: true, novelAgentModule: "architect" },
  planner: { id: "planner", label: { zh: "规划师", en: "Planner" }, responsibility: "把欲望/阻碍/变化/钩子写成可执行章节备忘。", implemented: true, novelAgentModule: "planner" },
  writer: { id: "writer", label: { zh: "写手", en: "Writer" }, responsibility: "按备忘与上下文生成正文。", implemented: true, novelAgentModule: "writer" },
  reviser: { id: "reviser", label: { zh: "修稿师", en: "Reviser" }, responsibility: "按审稿问题修订正文。", implemented: true, novelAgentModule: "reviser" },
  polisher: { id: "polisher", label: { zh: "润色师", en: "Polisher" }, responsibility: "精修语言与节奏。", implemented: true, novelAgentModule: "polisher" },
  continuity: { id: "continuity", label: { zh: "连续性审校", en: "Continuity" }, responsibility: "检查连续性与角色知识边界。", implemented: true, novelAgentModule: "continuity" },
  "chapter-analyzer": { id: "chapter-analyzer", label: { zh: "章节分析官", en: "Chapter Analyzer" }, responsibility: "分析章节质量与问题。", implemented: true, novelAgentModule: "chapter-analyzer" },
  "style-analyzer": { id: "style-analyzer", label: { zh: "风格指纹官", en: "Style Analyzer" }, responsibility: "学习/校验风格指纹。", implemented: true, novelAgentModule: "style-analyzer" },
  "state-validator": { id: "state-validator", label: { zh: "状态校验员", en: "State Validator" }, responsibility: "校验真相文件与状态一致性。", implemented: true, novelAgentModule: "state-validator" },
  "quality-auditor": { id: "quality-auditor", label: { zh: "质量审核", en: "Quality Auditor" }, responsibility: "多维打分并给可执行修改建议。", implemented: true, novelAgentModule: "chapter-analyzer" },
  "prompt-governor": { id: "prompt-governor", label: { zh: "提示词治理官", en: "Prompt Governor" }, responsibility: "把失败日志、质量报告与人工备注压缩成短、硬、可审计的角色提示词补丁。", implemented: true },

  // —— 总编部(编辑部领导层,已实现) ——
  "editor-in-chief": { id: "editor-in-chief", label: { zh: "总编", en: "Editor-in-Chief" }, responsibility: "整章成稿后读全部专家信号,做通过-返工裁决 + 总编批语 + 下一程方向。", implemented: true, novelAgentModule: "editor-in-chief-prompts" },
  "managing-editor": { id: "managing-editor", label: { zh: "执行主编", en: "Managing Editor" }, responsibility: "编排工作流:决定下一步调哪个 Agent、追踪稿件状态、管理返工循环(由 pipeline runner 落地)。", implemented: true },

  // —— 编辑部(文章类)角色蓝图,见 §5,待实现 ——
  "topic-radar": { id: "topic-radar", label: { zh: "选题雷达", en: "Topic Radar" }, responsibility: "从定位/热点/需求发现选题。", implemented: false },
  "angle-editor": { id: "angle-editor", label: { zh: "角度编辑", en: "Angle Editor" }, responsibility: "把普通选题变成有传播力的角度。", implemented: false },
  researcher: { id: "researcher", label: { zh: "研究员", en: "Researcher" }, responsibility: "整理事实/案例/数据/引用,标注需核实项。", implemented: false },
  "fact-checker": { id: "fact-checker", label: { zh: "事实核查", en: "Fact Checker" }, responsibility: "核查高风险陈述,标注需引用句,不编造来源。", implemented: false },
  "outline-architect": { id: "outline-architect", label: { zh: "大纲编辑", en: "Outline Architect" }, responsibility: "按 brief+资料设计结构。", implemented: false },
  "draft-writer": { id: "draft-writer", label: { zh: "初稿写手", en: "Draft Writer" }, responsibility: "按 brief + 技能产出结构化初稿。", implemented: true, editorialModule: "editorial/article-pipeline" },
  "structural-editor": { id: "structural-editor", label: { zh: "结构编辑", en: "Structural Editor" }, responsibility: "查逻辑/删重复/强化首尾。", implemented: false },
  "style-rewriter": { id: "style-rewriter", label: { zh: "风格编辑", en: "Style Rewriter" }, responsibility: "按评审意见 + Style Skill 改写并去 AI 腔,事实不变。", implemented: true, editorialModule: "editorial/article-pipeline" },
  "prose-critic": { id: "prose-critic", label: { zh: "prose 评审", en: "Prose Critic" }, responsibility: "对抗式 prose 评审,按 critical/significant/minor 给可执行意见。", implemented: true, editorialModule: "editorial/article-pipeline" },
  "copy-editor": { id: "copy-editor", label: { zh: "文字编辑", en: "Copy Editor" }, responsibility: "改病句/重复/口水话,意思不变。", implemented: false },
  "hook-title-editor": { id: "hook-title-editor", label: { zh: "标题钩子编辑", en: "Hook & Title Editor" }, responsibility: "生成标题、优化首屏与前 3 段。", implemented: false },
  "platform-adapter": { id: "platform-adapter", label: { zh: "平台适配", en: "Platform Adapter" }, responsibility: "把内容重组适配到目标平台。", implemented: false },
  "layout-designer": { id: "layout-designer", label: { zh: "排版设计", en: "Layout Designer" }, responsibility: "产出平台可渲染的 layout spec。", implemented: false },
  "compliance-reviewer": { id: "compliance-reviewer", label: { zh: "合规审核", en: "Compliance Reviewer" }, responsibility: "查敏感/广告法/平台禁忌/AIGC 标识。", implemented: false },
};

export function getRole(id: string): RoleMeta | undefined {
  return ROLE_CATALOG[id];
}
