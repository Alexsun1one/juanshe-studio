/**
 * 公众号 5 模板注册表。
 *
 * 用法:
 *   import { getWechatTemplate, listWechatTemplates } from "../templates/index.js";
 *   const tpl = getWechatTemplate("business");  // 拿到模板对象
 *   renderWechat(doc, "business");               // 在 renderer 入口选模板
 *
 * 默认 "business"(B8 之前的默认观感最接近);未知 id 自动回退。
 */

import type { WechatTemplate } from "./types.js";
import { businessTemplate } from "./business.js";
import { knowledgeTemplate } from "./knowledge.js";
import { storyTemplate } from "./story.js";
import { literaryTemplate } from "./literary.js";
import { minimalTemplate } from "./minimal.js";

export type WechatTemplateId = "business" | "knowledge" | "story" | "literary" | "minimal";

const TEMPLATES: Record<WechatTemplateId, WechatTemplate> = {
  business: businessTemplate,
  knowledge: knowledgeTemplate,
  story: storyTemplate,
  literary: literaryTemplate,
  minimal: minimalTemplate,
};

export const DEFAULT_WECHAT_TEMPLATE: WechatTemplateId = "business";

export function getWechatTemplate(id?: string): WechatTemplate {
  if (id && id in TEMPLATES) return TEMPLATES[id as WechatTemplateId];
  return TEMPLATES[DEFAULT_WECHAT_TEMPLATE];
}

export function listWechatTemplates(): Array<{ id: WechatTemplateId; label: string; tagline: string }> {
  return (Object.keys(TEMPLATES) as WechatTemplateId[]).map((id) => ({
    id,
    label: TEMPLATES[id].label,
    tagline: TEMPLATES[id].tagline,
  }));
}

export type { WechatTemplate };
