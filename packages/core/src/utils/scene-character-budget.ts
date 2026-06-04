// 确定性场景/人物预算检查。
//
// 数据来源是 observer(Phase 2a)产出的**结构化观察**,不是从正文用启发式猜 ——
// observer 已经由 LLM 把"哪几个场景、每个场景在场哪些角色"识别成结构化条目,
// 在这上面数场景数/有戏人物数是可靠的、确定性的。
//
// 上限来自 memo 的「不要做」(planner 现在会把"本章 ≤N 场景、≤N 有戏人物"写进去)。
// 这是对"prompt 约束 + LLM 审稿"主防线的**确定性兜底**:catch 写手没遵守上限的情况。

export interface SceneCharacterBudgetResult {
  readonly sceneCount: number;
  readonly characterCount: number;
  readonly sceneCap: number | null;
  readonly characterCap: number | null;
  readonly scenes: string[];
  readonly characters: string[];
  readonly violations: string[];
}

/** 从 memo 文本(尤其「不要做」)解析 "场景 ≤ N" / "≤N 场景" / "人物 ≤ N" 这类上限。 */
export function parseBudgetCapsFromMemo(memoText: string): {
  sceneCap: number | null;
  characterCap: number | null;
} {
  const text = String(memoText || "");
  const grab = (...kinds: string[]): number | null => {
    for (const kind of kinds) {
      // "场景 ≤ 3" / "场景≤3" / "场景不超过3"
      const a = text.match(new RegExp(`${kind}\\s*(?:数)?\\s*(?:[≤<]=?|不超过|不多于|最多)\\s*(\\d{1,2})`));
      if (a) {
        const n = Number(a[1]);
        if (Number.isInteger(n) && n > 0 && n < 20) return n;
      }
      // "≤3 个场景" / "最多 3 个有戏人物" —— 必须带明确的"≤/不超过/最多"等限定词,
      // 绝不匹配裸数字("第1场景""1场景的描写"这类杂散数字会被误当成上限 → 假阳性)。
      const b = text.match(new RegExp(`(?:[≤<]=?|不超过|不多于|最多)\\s*(\\d{1,2})\\s*个?\\s*(?:有戏)?${kind}`));
      if (b) {
        const n = Number(b[1]);
        if (Number.isInteger(n) && n > 0 && n < 20) return n;
      }
    }
    return null;
  };
  return {
    sceneCap: grab("场景", "scenes?", "locations?"),
    characterCap: grab("人物", "角色", "characters?"),
  };
}

/** 从 observer 的结构化观察里数去重后的场景数与有戏人物数。 */
export function countScenesAndCharacters(observations: string): {
  scenes: string[];
  characters: string[];
} {
  const text = String(observations || "");

  // 角色:[角色行为] / [CHARACTERS] 段里每行 "- <名>: ..." 的名(去重)。
  const characters = new Set<string>();
  const charSection = text.match(/\[(?:角色行为|CHARACTERS)\]([\s\S]*?)(?:\n\s*\[|$)/);
  if (charSection) {
    for (const line of charSection[1].split("\n")) {
      const m = line.match(/^\s*-\s*([^:：(（\n]+?)\s*[:：]/);
      if (m) {
        const name = m[1].trim();
        // 过滤掉明显不是人名的(太长、占位符)
        if (name && name.length >= 1 && name.length <= 12 && !/^[<\[]/.test(name)) {
          characters.add(name);
        }
      }
    }
  }

  // 场景:(场景: 地点) / (scene: X) 的地点 + [位置变化]/[LOCATIONS] 的 "从 A 到 B"(去重)。
  const scenes = new Set<string>();
  for (const m of text.matchAll(/[(（]\s*(?:场景|scene)\s*[:：]\s*([^)）\n]+)[)）]/gi)) {
    const loc = m[1].trim();
    if (loc && loc.length <= 30 && !/^[<\[]/.test(loc)) scenes.add(loc);
  }
  const locSection = text.match(/\[(?:位置变化|LOCATIONS)\]([\s\S]*?)(?:\n\s*\[|$)/);
  if (locSection) {
    for (const m of locSection[1].matchAll(/从\s*(.+?)\s*到\s*([^\n]+)/g)) {
      if (m[1]?.trim() && m[1].trim().length <= 30) scenes.add(m[1].trim());
      if (m[2]?.trim() && m[2].trim().length <= 30) scenes.add(m[2].trim());
    }
  }

  // 归并子地点到主场景:observer 常给一个叙事场景里的走动打多个细地点标(出租屋客厅/出租屋门口/出租屋),
  // 若直接数会把 1 个叙事场景数成好几个 → 过报。这里把"被更短地点包含"的归并掉,只留主场景,贴近 memo 的"场景"语义。
  return { scenes: groupScenesByMajorLocation([...scenes]), characters: [...characters] };
}

function groupScenesByMajorLocation(rawLocations: string[]): string[] {
  const locs = [...new Set(rawLocations.map((l) => l.trim()).filter(Boolean))].sort(
    (a, b) => a.length - b.length,
  );
  const majors: string[] = [];
  for (const loc of locs) {
    // 已有某个更短的主场景被它包含(出租屋 ⊂ 出租屋客厅)→ 同一主场景,归并掉。
    if (majors.some((m) => loc.includes(m))) continue;
    majors.push(loc);
  }
  return majors;
}

/** 比对 observer 数出的场景/人物数与 memo 上限,超限即返回违规说明。 */
export function checkSceneCharacterBudget(
  observations: string,
  memoText: string,
): SceneCharacterBudgetResult {
  const { sceneCap, characterCap } = parseBudgetCapsFromMemo(memoText);
  const { scenes, characters } = countScenesAndCharacters(observations);
  const violations: string[] = [];
  if (sceneCap !== null && scenes.length > sceneCap) {
    violations.push(
      `本章场景数 ${scenes.length} 超过 memo 上限 ${sceneCap}（合并场景或砍掉过场：${scenes.slice(0, 6).join("、")}）`,
    );
  }
  if (characterCap !== null && characters.length > characterCap) {
    violations.push(
      `本章有戏人物数 ${characters.length} 超过 memo 上限 ${characterCap}（砍掉可有可无的角色或只报名字不展开：${characters.slice(0, 8).join("、")}）`,
    );
  }
  return {
    sceneCount: scenes.length,
    characterCount: characters.length,
    sceneCap,
    characterCap,
    scenes,
    characters,
    violations,
  };
}
