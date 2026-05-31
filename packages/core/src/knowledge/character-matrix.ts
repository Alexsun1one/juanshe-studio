/**
 * 角色矩阵解析器(knowledge/)—— 把运行库真相文件解析成结构化角色数据,喂前端"角色与设定"页。
 *
 * 解析两类源(纯函数,不读盘;读盘由 studio 端点做):
 *   - story/character_matrix.md:`## 名字` + `- **定位/标签/说话/性格/动机/当前/关系/已知/未知**: …`
 *   - story/roles/<组>/<名>.md:散文式 `## 小节` 分节(小传/弧线/关系网络/驱动…)
 */

export type CharacterKind =
  | "protagonist"
  | "deuteragonist"
  | "mentor"
  | "antagonist"
  | "supporting"
  | "mystery";

export interface CharacterRelation {
  /** 关系对象名。 */
  readonly target: string;
  /** 关系类型(合作者/母亲/宿敌/目标…)。 */
  readonly type: string;
  /** 附注(状态/章节,如 "信任升级 / Ch15")。 */
  readonly note?: string;
  readonly raw: string;
}

export interface CharacterMatrixEntry {
  readonly name: string;
  /** 定位原文(主角/盟友/反派…)。 */
  readonly role: string;
  /** 归一化定位,供前端着色/筛选。 */
  readonly roleKind: CharacterKind;
  readonly tags: readonly string[];
  readonly contrast?: string;
  readonly voice?: string;
  readonly personality?: string;
  readonly motivation?: string;
  readonly current?: string;
  readonly relations: readonly CharacterRelation[];
  readonly known: readonly string[];
  readonly unknown: readonly string[];
}

const FIELD_LABELS: Record<string, string> = {
  定位: "role",
  标签: "tags",
  反差: "contrast",
  说话: "voice",
  性格: "personality",
  动机: "motivation",
  当前: "current",
  关系: "relations",
  已知: "known",
  未知: "unknown",
};

/** 把"定位"原文归一化成可着色/筛选的种类。 */
export function classifyRole(role: string): CharacterKind {
  const r = role || "";
  if (/双男主|双女主/.test(r)) return "deuteragonist"; // 先判,避免"双男主"里的"男主"误命中主角
  if (/主角|男主/.test(r)) return "protagonist";
  if (/女主|盟友|搭档|伙伴/.test(r)) return "deuteragonist";
  if (/导师|师父|师傅|向导/.test(r)) return "mentor";
  if (/反派|反一|宿敌|对手|敌人|boss/i.test(r)) return "antagonist";
  if (/未明|谜|神秘|未知/.test(r)) return "mystery";
  return "supporting";
}

function splitList(value: string): string[] {
  return value
    .split(/[、，,；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRelations(value: string): CharacterRelation[] {
  return value
    .split(/[|｜]/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((raw) => {
      const m = raw.match(/^(.+?)[（(]([^）)]*)[）)]\s*$/);
      if (!m) return { target: raw, type: "", raw };
      const target = (m[1] ?? "").trim();
      const parts = (m[2] ?? "")
        .split(/[/／]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const note = parts.slice(1).join(" / ");
      return { target, type: parts[0] ?? "", note: note || undefined, raw };
    });
}

/** 解析 character_matrix.md 为结构化角色条目数组。 */
export function parseCharacterMatrix(md: string): CharacterMatrixEntry[] {
  if (!md || !md.trim()) return [];
  const lines = md.split(/\r?\n/);
  const entries: CharacterMatrixEntry[] = [];
  let cur: {
    name: string;
    role: string;
    roleKind: CharacterKind;
    tags: string[];
    contrast?: string;
    voice?: string;
    personality?: string;
    motivation?: string;
    current?: string;
    relations: CharacterRelation[];
    known: string[];
    unknown: string[];
  } | null = null;
  // 仅收录"真·角色块":至少有一个可识别字段(定位/标签/动机/关系…)。
  // 这样可避免散文版 character_matrix.md(`### 名字` + `## 核心标签/反差细节…` 分节)
  // 把分节小标题误当成角色,污染图谱节点与计数。
  const hasContent = (c: NonNullable<typeof cur>) =>
    Boolean(
      c.role ||
        c.tags.length ||
        c.contrast ||
        c.voice ||
        c.personality ||
        c.motivation ||
        c.current ||
        c.relations.length ||
        c.known.length ||
        c.unknown.length,
    );
  const flush = () => {
    if (cur && hasContent(cur)) entries.push(cur);
  };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      flush();
      cur = {
        name: (h[1] ?? "").trim(),
        role: "",
        roleKind: "supporting",
        tags: [],
        relations: [],
        known: [],
        unknown: [],
      };
      continue;
    }
    if (!cur) continue;
    const f = line.match(/^\s*[-*]\s*\*\*(.+?)\*\*\s*[:：]\s*(.*)$/);
    if (!f) continue;
    const prop = FIELD_LABELS[(f[1] ?? "").trim()];
    const value = (f[2] ?? "").trim();
    if (!prop) continue;
    switch (prop) {
      case "tags":
        cur.tags = splitList(value);
        break;
      case "relations":
        cur.relations = parseRelations(value);
        break;
      case "known":
        cur.known = splitList(value);
        break;
      case "unknown":
        cur.unknown = splitList(value);
        break;
      case "role":
        cur.role = value;
        cur.roleKind = classifyRole(value);
        break;
      default:
        (cur as Record<string, unknown>)[prop] = value;
    }
  }
  flush();
  return entries;
}

export interface RoleFileSection {
  readonly title: string;
  readonly body: string;
}

/** 解析单个角色档案文件(roles/<组>/<名>.md)的 `## 小节` 分节。 */
export function parseRoleFile(md: string): RoleFileSection[] {
  if (!md || !md.trim()) return [];
  const lines = md.split(/\r?\n/);
  const sections: RoleFileSection[] = [];
  let title = "";
  let body: string[] = [];
  const flush = () => {
    if (title) sections.push({ title, body: body.join("\n").trim() });
  };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      flush();
      title = (h[1] ?? "").trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}
