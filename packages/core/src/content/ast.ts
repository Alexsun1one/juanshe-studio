/**
 * Content AST —— 平台无关的结构化内容中间表示。
 *
 * 设计原则:
 * 内容先进入这套结构化 AST,再由各平台 Renderer 渲染成公众号 / 小红书 / 知乎 / X 的成品。
 * Renderer 是确定性代码,不是 Agent —— 同一份 AST 渲染到不同平台,排版差异由 Renderer 负责。
 */

export type Platform =
  | "wechat"
  | "xiaohongshu"
  | "zhihu"
  | "x"
  | "newsletter";

export interface HeadingBlock {
  readonly type: "heading";
  readonly level: 1 | 2 | 3;
  readonly text: string;
}

export interface ParagraphBlock {
  readonly type: "paragraph";
  readonly text: string;
  /** 需要强调的子串(加粗);Renderer 决定如何呈现。 */
  readonly emphasis?: readonly string[];
}

export interface QuoteBlock {
  readonly type: "quote";
  readonly text: string;
  readonly source?: string;
}

export interface ListBlock {
  readonly type: "list";
  readonly ordered: boolean;
  readonly items: readonly string[];
}

export interface DividerBlock {
  readonly type: "divider";
}

export interface CalloutBlock {
  readonly type: "callout";
  readonly tone: "info" | "warning" | "success" | "danger" | "brand";
  readonly text: string;
  readonly title?: string;
}

export interface CtaBlock {
  readonly type: "cta";
  readonly text: string;
  readonly intent: "comment" | "share" | "follow" | "subscribe" | "buy" | "save";
}

export interface ImageSlotBlock {
  readonly type: "image_slot";
  readonly purpose: "cover" | "inline" | "card" | "diagram";
  readonly prompt?: string;
  readonly caption?: string;
}

/**
 * 步骤卡:Step 01 / Step 02 ... 数字徽章 + 标题 + 段落。
 * markdown 语法:`::: step 1 标题\n内容...\n:::` 或更简洁的 `### Step 1: 标题`
 */
export interface StepBlock {
  readonly type: "step";
  readonly number: number;
  readonly title: string;
  readonly text: string;
}

/**
 * 重点段落卡:跟普通段不同的视觉(底色 + 边框 + 阴影)
 * markdown 语法:`:::highlight\n内容\n:::`
 */
export interface HighlightBlock {
  readonly type: "highlight";
  readonly text: string;
  readonly title?: string;
  readonly tone?: "brand" | "warm" | "cool" | "neutral";
}

/**
 * 引文小卡:quote + 来源 + 头像(可选)
 * markdown 语法:`> [!quote] 出处|头像url\n内容`
 */
export interface FigureQuoteBlock {
  readonly type: "figure_quote";
  readonly text: string;
  readonly source: string;
  readonly avatarUrl?: string;
}

/**
 * 表格:支持 markdown 标准 `| col | col |\n|---|---|\n| ... |`
 */
export interface TableBlock {
  readonly type: "table";
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** 列对齐 */
  readonly align?: readonly ("left" | "center" | "right")[];
}

/**
 * 装饰分割线:`---` 之外的浮夸版,`*** ✦ ***` 之类
 * markdown 语法:`* * *` 或 `~~~`
 */
export interface FancyDividerBlock {
  readonly type: "fancy_divider";
  readonly style: "ornate" | "dashed" | "double" | "wave";
}

export type ContentBlock =
  | HeadingBlock
  | ParagraphBlock
  | QuoteBlock
  | ListBlock
  | DividerBlock
  | CalloutBlock
  | CtaBlock
  | ImageSlotBlock
  | StepBlock
  | HighlightBlock
  | FigureQuoteBlock
  | TableBlock
  | FancyDividerBlock;

export interface ContentDocument {
  readonly title?: string;
  readonly subtitle?: string;
  readonly summary?: string;
  readonly blocks: readonly ContentBlock[];
  readonly metadata?: {
    readonly platform?: Platform;
    readonly tone?: string;
    readonly targetAudience?: string;
    readonly wordCount?: number;
  };
}

/** Renderer 统一输出:富文本 HTML(可直接粘进平台编辑器)+ 纯文本回退。 */
export interface RenderedContent {
  readonly platform: Platform;
  readonly html: string;
  readonly plainText: string;
}
