/**
 * 运行装配(第5层)—— 把 ContentTypeProfile 组装成"可驱动 Agent 的生产配置":
 *   内容类型 → 角色(roles)+ 挂载技能(skillPrompt 注入系统提示)+ 目标平台(Renderer)。
 *
 * 纯函数 + 文件读取,无 LLM 调用 —— 产出的 systemPrompt 即"准备发给模型的系统提示"。
 * 真正的生成(把 systemPrompt + brief 发给 chatCompletion)是最后一公里,由调用方接 LLM client 完成。
 */

import { getContentTypeProfile, type ContentTypeProfile } from "./profile.js";
import { getRole, type RoleMeta } from "./roles.js";
import { loadSkill } from "../skills/registry.js";
import type { Platform } from "../content/ast.js";

/** 把选中的 skills 拼成可注入 Agent 系统提示的指令块。 */
export async function mountSkills(
  skillsDir: string,
  skillIds: readonly string[],
): Promise<string> {
  const blocks: string[] = [];
  for (const id of skillIds) {
    const skill = await loadSkill(skillsDir, id);
    if (skill) {
      blocks.push(`<skill id="${skill.id}" title="${skill.title}">\n${skill.content}\n</skill>`);
    }
  }
  if (blocks.length === 0) return "";
  return [
    "# 已挂载技能(写作时严格遵循,冲突时以更具体的平台/风格技能为准)",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

export interface AssembledContentType {
  readonly profile: ContentTypeProfile;
  /** 解析后的角色元信息(过滤掉未知 id)。 */
  readonly roles: readonly RoleMeta[];
  /** 蓝图中尚未实现的角色 id(UI/调用方据此提示"暂用通用写手代跑")。 */
  readonly missingRoles: readonly string[];
  /** 挂载技能拼成的系统提示注入块。 */
  readonly skillPrompt: string;
  readonly platforms: readonly Platform[];
}

/** 把一个内容类型解析成运行就绪的装配包(角色 + 技能注入 + 平台)。 */
export async function assembleContentType(
  skillsDir: string,
  profileId: string,
): Promise<AssembledContentType | null> {
  const profile = getContentTypeProfile(profileId);
  if (!profile) return null;

  const roles: RoleMeta[] = [];
  const missingRoles: string[] = [];
  for (const id of profile.roles) {
    const role = getRole(id);
    if (role) {
      roles.push(role);
      if (!role.implemented) missingRoles.push(id);
    } else {
      missingRoles.push(id);
    }
  }

  const skillPrompt = await mountSkills(skillsDir, profile.skills);
  return { profile, roles, missingRoles, skillPrompt, platforms: profile.platforms };
}

/**
 * 平台富 Markdown 扩展提示。所有"文章/笔记类"内容类型(non-novel)都注入这一段,
 * 教模型用我们 AST + 渲染器支持的块,而不是只会 #/##/列表/引用。
 *
 * 关键纪律:**不要装饰每一段**。callout / step / highlight / 表格 / 头像引文 / fancy 分割
 * 是"信息密度爆点",一篇文章里最多 2–4 个,用错位置会显得做作。
 */
const RICH_MARKDOWN_PROMPT = [
  "# 排版语法(平台富 Markdown 扩展,渲染器原生支持)",
  "下面这些块是结构化的——它们在公众号 / 知乎 / 小红书的渲染产物里有专门视觉(底色块、徽章、卡片、引文头像等)。",
  "**克制使用**:每篇文章 callout / step / highlight / 表格 / 头像引文 / fancy 分割 加起来 2–4 个,**不要把每段都包成卡片**——那会让排版显得做作。每个块都要回答\"为什么这里非用块不可\";一般信息走普通段。",
  "",
  "## 行内强调",
  "- `**粗体**` / `*斜体*` / `` `行内代码` ``",
  "- `==高亮文字==` → 渲染为带底色的关键词(用在论点 / 数字 / 反差句,**一段最多 1 处**)",
  "",
  "## 重点段落卡(底色 + 边框,适合金句、核心观点)",
  "```",
  ":::highlight brand title:核心要点",
  "这是要突出的内容,一两句最佳。",
  ":::",
  "```",
  "tone 取 `brand` / `warm` / `cool` / `neutral`,`title:` 可选。",
  "",
  "## Callout 提示框(信息、提醒、风险、品牌呼喊)",
  "```",
  ":::callout warning title:别踩这个坑",
  "正文。",
  ":::",
  "```",
  "tone 取 `info` / `warning` / `success` / `danger` / `brand`,`title:` 可选。",
  "",
  "## 步骤卡(数字徽章 + 标题 + 段,适合 how-to / 分步骤拆解)",
  "```",
  ":::step 1 拆解问题",
  "第一步要做的事。",
  ":::",
  ":::step 2 验证假设",
  "第二步要做的事。",
  ":::",
  "```",
  "也可写成 `## Step 1: 拆解问题`(简写,等价)。Step 通常成组出现(2–6 个),不要孤零零一个。",
  "",
  "## 头像引文(被引者的脸 + 名字,适合书摘、采访、名言、读者反馈)",
  "```",
  "> 真正的写作是把读者拉进作者的世界。",
  "> source: 卡尔维诺 | https://example.com/avatar.jpg",
  "```",
  "最后一行格式严格为 `source: 名字 | 头像URL`(头像可省)。普通引用仍用 `> 文字` 即可。",
  "",
  "## 表格(对比、数据、参数清单)",
  "```",
  "| 维度 | 方案 A | 方案 B |",
  "|---|:---:|---:|",
  "| 速度 | 快 | 中 |",
  "| 成本 | 高 | 低 |",
  "```",
  "对齐用 `:---` / `:---:` / `---:`。",
  "",
  "## 装饰分割线(章节之间的视觉换气,比 `---` 更隆重)",
  "用 `* * *` 一行单独成段。普通分隔仍用 `---`。",
  "",
  "## 不要做",
  "- 不要把每段都包 `:::highlight`——读起来像 PPT。",
  "- 不要嵌套 fence(`:::` 里再开 `:::`),解析器不支持。",
  "- 不要用 emoji 当 callout 标题前缀(我们的渲染器已经给徽章了)。",
  "- 不要把 step 的 `text` 留空,标题已经在 args 里——内容写在 `:::step N 标题` 和 `:::` 之间。",
].join("\n");

const XIAOHONGSHU_OUTPUT_PROMPT = [
  "# 小红书输出纪律",
  "- plainText 是主产物:不要输出复杂 Markdown 卡片、表格、嵌套 `:::` 或公众号式引用框。",
  "- 结构按「标题 / 前 3 行 hook / 短段正文 / 可收藏清单 / 标签」组织。",
  "- 标题 12-22 字,前 3 行直接给痛点、结论或反差;不要背景铺垫。",
  "- 段落 1-3 行,列表不超过 6 条;emoji 总量 2-6 个,只做导航不做装饰噪音。",
  "- 末尾集中放 5-8 个标签,包含搜索词、场景词、账号定位词;不要夹在正文中间。",
  "- 不编造亲历、价格、数据或平台规则;没有来源就写成观察或判断。",
].join("\n");

const X_THREAD_OUTPUT_PROMPT = [
  "# X / Twitter Thread 输出纪律",
  "- 每条都要独立可读,第一条先给观点或反差,不要寒暄。",
  "- 短句、少形容词;每条只承载一个推进。",
  "- 多条时自然编号,结尾给问题、资源或行动,不要硬广。",
].join("\n");

function platformPrompt(platform: Platform | undefined): string {
  if (platform === "xiaohongshu") return XIAOHONGSHU_OUTPUT_PROMPT;
  if (platform === "x") return X_THREAD_OUTPUT_PROMPT;
  return "";
}

function shouldUseRichMarkdown(profile: ContentTypeProfile): boolean {
  if (profile.usesLegacyNovelPipeline || profile.platforms.length === 0) return false;
  const platform = profile.platforms[0];
  return platform !== "xiaohongshu" && platform !== "x";
}

/** 生成可直接发给模型的写作系统提示:角色定位 + 平台 + 字数 + 挂载技能 + 富 Markdown 扩展。 */
export function buildWritingSystemPrompt(input: {
  readonly profile: ContentTypeProfile;
  readonly skillPrompt: string;
  /** 账号画像/语气补充(可选)。 */
  readonly accountVoice?: string;
}): string {
  const { profile, skillPrompt, accountVoice } = input;
  const platform = profile.platforms[0];
  const parts: string[] = [];
  parts.push(
    `你是一名「${profile.label.zh}」内容创作编辑。任务:${profile.description}`,
  );
  if (platform) parts.push(`目标平台:${platform}。输出要贴合该平台的阅读与排版习惯。`);
  if (profile.lengthHint) {
    parts.push(`篇幅区间:约 ${profile.lengthHint.min}–${profile.lengthHint.max} 字。`);
  }
  if (accountVoice) parts.push(`账号语气/定位:${accountVoice}`);
  parts.push(
    "输出结构化、可被平台渲染器处理的 Markdown(标题用 #/##,引用用 >,列表用 -)。",
  );
  const platformSpecific = platformPrompt(platform);
  if (platformSpecific) parts.push("", platformSpecific);
  // 公众号/知乎/Newsletter:注入富 Markdown 扩展教学;短内容平台用更克制的 plain text 纪律。
  if (shouldUseRichMarkdown(profile)) {
    parts.push("", RICH_MARKDOWN_PROMPT);
  }
  if (skillPrompt) {
    parts.push(
      "",
      "# 风格融合(硬要求)",
      "下面挂载了多个风格 / 平台技能。它们是**参考与约束的集合,不是要照搬的单一声音**:",
      "- 综合所有技能 + 账号语气,产出**不可被读者识别为某一位作者 / 某一个技能腔调**的成品。",
      "- **禁止**把任一技能的标志性句式、口头禅、固定开头、招牌比喻当模板套用(例如不要让成品一眼看出是某种「卡兹克体」)。",
      "- 技能之间冲突时,以更具体的平台 / 账号要求为准;风格服务内容,不喧宾夺主。",
      "",
      skillPrompt,
    );
  }
  return parts.join("\n");
}
