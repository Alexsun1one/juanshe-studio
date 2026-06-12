/**
 * Structural AI-tell detection — pure rule-based analysis (no LLM).
 *
 * Detects patterns common in AI-generated Chinese text:
 * - dim 20: Paragraph length uniformity (low variance)
 * - dim 21: Filler/hedge word density
 * - dim 22: Formulaic transition patterns
 * - dim 23: List-like structure (consecutive same-prefix sentences)
 */

export interface AITellIssue {
  readonly severity: "warning" | "info";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
}

export interface AITellResult {
  readonly issues: ReadonlyArray<AITellIssue>;
}

type AITellLanguage = "zh" | "en";

const HEDGE_WORDS: Record<AITellLanguage, ReadonlyArray<string>> = {
  zh: ["似乎", "可能", "或许", "大概", "某种程度上", "一定程度上", "在某种意义上"],
  en: ["seems", "seemed", "perhaps", "maybe", "apparently", "in some ways", "to some extent"],
};

const TRANSITION_WORDS: Record<AITellLanguage, ReadonlyArray<string>> = {
  zh: ["然而", "不过", "与此同时", "另一方面", "尽管如此", "话虽如此", "但值得注意的是"],
  en: ["however", "meanwhile", "on the other hand", "nevertheless", "even so", "still"],
};

// dim 24: 直白命名情绪(telling, not showing)—— 把情绪当结论说出来,而非用动作/感官演出来
const TELLING_EMOTION: Record<AITellLanguage, ReadonlyArray<RegExp>> = {
  zh: [
    /(感到|感觉到|感受到|涌起|涌上|涌现|升起|泛起|心中|心头|内心|心里)(?:一阵|一丝|一股|一种)?(恐惧|害怕|惧意|愤怒|怒火|紧张|不安|焦虑|焦躁|绝望|喜悦|欣喜|悲伤|悲痛|释然|兴奋|激动|震惊|恐慌|慌乱|失落|委屈|无奈|疲惫|羞愧|愧疚|悸动)/g,
  ],
  en: [
    /\b(felt|feeling|sensed)\s+(?:a\s+)?(wave|surge|sense|pang|rush|flood|flash)\s+of\s+\w+/gi,
    /\bcouldn'?t help but\b/gi,
  ],
};

// dim 25: 套话意象 / purple-prose 陈词 —— AI 写作高频通用模板,出现即偏离具体
const CLICHE_PHRASES: Record<AITellLanguage, ReadonlyArray<string>> = {
  zh: [
    "空气仿佛凝固", "时间仿佛静止", "无形的压力", "气氛凝重", "气氛压抑",
    "鸦雀无声", "落针可闻", "心跳漏了一拍", "勾起一抹", "闪过一丝", "不易察觉", "嘴角微微",
    // 与 engine anti-slop 词表同步(老一代指纹,真实书稿审计发现 core 运行时漏检——
    // 「深吸一口气」一章 9 次零报警);只收完整短语,单字/双字副词留给 engine 的加权口径,避免误伤
    "深吸一口气", "倒吸一口凉气", "心头一震", "眼神一凛", "眼中闪过", "眼底闪过", "挑了挑眉",
    // "第二代"身体反应陈词:旧词被禁后模型收敛出的新批量货(取自真实书稿审计)
    "脑子嗡", "指节发白", "后背发凉", "凉意爬上", "喉咙发紧", "心跳如擂鼓", "像擂鼓",
    "像一盆冰水", "影子拉得很长",
    // 模糊兜底名词的换壳逃逸
    "一种说不出的", "一种说不上来的",
  ],
  en: [
    "the air was thick with", "time seemed to stand still", "time stood still",
    "sent a shiver down", "a chill ran down", "deafening silence",
    "you could hear a pin drop", "ghost of a smile",
  ],
};

// 关键词标记(比 analyzeAITells 的结构检测更直接的"AI 腔"高频词)。
// 与 studio 旧 aiMarkers 列表对齐,补充几个常见的;作为 aiToneScore 的二级扣分项。
const AI_MARKER_WORDS: Record<AITellLanguage, ReadonlyArray<string>> = {
  zh: ["仿佛", "不禁", "忽然", "猛地", "竟然", "内心深处", "说不清", "莫名", "鬼使神差", "一种难以言喻"],
  en: ["somehow", "a part of (?:him|her|them)", "couldn't shake the feeling"],
};

/**
 * 人味指数(0-100,高=越像人写,低=AI 痕迹重)。
 *
 * 单一事实源:studio 的质量面板、core 的 polisher 自动追加润色门槛、总编签发硬门禁
 * 都调这一个函数,保证三处口径一致(别再各写一份阈值)。
 *
 * 算法:analyzeAITells 的 6 类结构化问题(段长方差/套话密度/公式化转折/列表式结构/
 * 直白命名情绪/陈词意象)按 warning -14 / info -7 扣分,再叠加关键词标记密度的二级扣分。
 */
export function aiToneScore(content: string, language: AITellLanguage = "zh"): number {
  const { issues } = analyzeAITells(content, language);
  let penalty = 0;
  for (const issue of issues) {
    penalty += issue.severity === "warning" ? 14 : 7;
  }
  // 关键词标记密度:每 3 个标记 -6(轻),>10 个再加重,封顶避免单项吃满
  let markerCount = 0;
  for (const word of AI_MARKER_WORDS[language]) {
    const regex = new RegExp(word, language === "en" ? "gi" : "g");
    markerCount += content.match(regex)?.length ?? 0;
  }
  penalty += Math.min(20, Math.floor(markerCount / 3) * 6);
  if (markerCount > 10) penalty += Math.min(10, (markerCount - 10) * 1.5);
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

/**
 * Analyze text content for structural AI-tell patterns.
 * Returns issues that can be merged into audit results.
 */
export function analyzeAITells(content: string, language: AITellLanguage = "zh"): AITellResult {
  const issues: AITellIssue[] = [];
  const isEnglish = language === "en";
  const joiner = isEnglish ? ", " : "、";

  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // dim 20: Paragraph length uniformity (needs ≥3 paragraphs)
  if (paragraphs.length >= 3) {
    const paragraphLengths = paragraphs.map((p) => p.length);
    const mean = paragraphLengths.reduce((a, b) => a + b, 0) / paragraphLengths.length;
    if (mean > 0) {
      const variance = paragraphLengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / paragraphLengths.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / mean;
      if (cv < 0.15) {
        issues.push({
          severity: "warning",
          category: isEnglish ? "Paragraph uniformity" : "段落等长",
          description: isEnglish
            ? `Paragraph-length coefficient of variation is only ${cv.toFixed(3)} (threshold <0.15), which suggests unnaturally uniform paragraph sizing`
            : `段落长度变异系数仅${cv.toFixed(3)}（阈值<0.15），段落长度过于均匀，呈现AI生成特征`,
          suggestion: isEnglish
            ? "Increase paragraph-length contrast: use shorter beats for impact and longer blocks for immersive detail"
            : "增加段落长度差异：短段落用于节奏加速或冲击，长段落用于沉浸描写",
        });
      }
    }
  }

  // dim 21: Hedge word density
  const totalChars = content.length;
  if (totalChars > 0) {
    let hedgeCount = 0;
    for (const word of HEDGE_WORDS[language]) {
      const regex = new RegExp(word, isEnglish ? "gi" : "g");
      const matches = content.match(regex);
      hedgeCount += matches?.length ?? 0;
    }
    const hedgeDensity = hedgeCount / (totalChars / 1000);
    if (hedgeDensity > 3) {
      issues.push({
        severity: "warning",
        category: isEnglish ? "Hedge density" : "套话密度",
        description: isEnglish
          ? `Hedge-word density is ${hedgeDensity.toFixed(1)} per 1k characters (threshold >3), making the prose sound overly tentative`
          : `套话词（似乎/可能/或许等）密度为${hedgeDensity.toFixed(1)}次/千字（阈值>3），语气过于模糊犹豫`,
        suggestion: isEnglish
          ? "Replace hedges with firmer narration: remove vague qualifiers and use concrete detail instead"
          : "用确定性叙述替代模糊表达：去掉「似乎」直接描述状态，用具体细节替代「可能」",
      });
    }
  }

  // dim 22: Formulaic transition repetition
  const transitionCounts: Record<string, number> = {};
  for (const word of TRANSITION_WORDS[language]) {
    const regex = new RegExp(word, isEnglish ? "gi" : "g");
    const matches = content.match(regex);
    const count = matches?.length ?? 0;
    if (count > 0) {
      transitionCounts[isEnglish ? word.toLowerCase() : word] = count;
    }
  }
  const repeatedTransitions = Object.entries(transitionCounts)
    .filter(([, count]) => count >= 3);
  if (repeatedTransitions.length > 0) {
    const detail = repeatedTransitions
      .map(([word, count]) => `"${word}"×${count}`)
      .join(joiner);
    issues.push({
      severity: "warning",
      category: isEnglish ? "Formulaic transitions" : "公式化转折",
      description: isEnglish
        ? `Transition words repeat too often: ${detail}. Reusing the same transition pattern 3+ times creates a formulaic AI texture`
        : `转折词重复使用：${detail}。同一转折模式≥3次暴露AI生成痕迹`,
      suggestion: isEnglish
        ? "Let scenes pivot through action, timing, or viewpoint shifts instead of repeating the same transitions"
        : "用情节自然转折替代转折词，或换用不同的过渡手法（动作切入、时间跳跃、视角切换）",
    });
  }

  // dim 23: List-like structure (consecutive sentences with same prefix pattern)
  const sentences = content
    .split(isEnglish ? /[.!?\n]/ : /[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);

  if (sentences.length >= 3) {
    let consecutiveSamePrefix = 1;
    let maxConsecutive = 1;
    for (let i = 1; i < sentences.length; i++) {
      const prevPrefix = isEnglish
        ? sentences[i - 1]!.split(/\s+/)[0]?.toLowerCase() ?? ""
        : sentences[i - 1]!.slice(0, 2);
      const currPrefix = isEnglish
        ? sentences[i]!.split(/\s+/)[0]?.toLowerCase() ?? ""
        : sentences[i]!.slice(0, 2);
      if (prevPrefix === currPrefix) {
        consecutiveSamePrefix++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveSamePrefix);
      } else {
        consecutiveSamePrefix = 1;
      }
    }
    if (maxConsecutive >= 3) {
      issues.push({
        severity: "info",
        category: isEnglish ? "List-like structure" : "列表式结构",
        description: isEnglish
          ? `Detected ${maxConsecutive} consecutive sentences with the same opening pattern, creating a list-like generated cadence`
          : `检测到${maxConsecutive}句连续以相同开头的句子，呈现列表式AI生成结构`,
        suggestion: isEnglish
          ? "Vary how sentences open: change subject, timing, or action entry to break the list effect"
          : "变换句式开头：用不同主语、时间词、动作词开头，打破列表感",
      });
    }
  }

  // dim 24: Telling-not-showing —— 直白命名情绪密度(需同时满足绝对数≥3 与密度阈值,避免短文本误报)
  if (totalChars > 0) {
    let tellingCount = 0;
    for (const re of TELLING_EMOTION[language]) {
      const matches = content.match(re);
      tellingCount += matches?.length ?? 0;
    }
    const tellingDensity = tellingCount / (totalChars / 1000);
    if (tellingCount >= 3 && tellingDensity > 2.5) {
      issues.push({
        severity: "warning",
        category: isEnglish ? "Telling, not showing" : "直白命名情绪",
        description: isEnglish
          ? `Emotions are named directly (felt fear/anger…) at ${tellingDensity.toFixed(1)} per 1k characters (threshold >2.5), which tells instead of shows`
          : `直接命名情绪(感到恐惧 / 心头涌起愤怒 等)密度 ${tellingDensity.toFixed(1)} 次/千字(阈值>2.5),偏向 telling 而非 showing`,
        suggestion: isEnglish
          ? "Replace named emotions with observable body signals, actions, or sensory detail so the reader feels it"
          : "把「感到 X」改成可观察的身体信号 / 动作 / 感官(指尖发凉、攥紧拳头、后背发紧),让读者自己感受到情绪",
      });
    }
  }

  // dim 25: Cliché imagery —— 套话 / purple-prose 陈词(绝对计数:≥3 警告,==2 提示)
  {
    const haystack = isEnglish ? content.toLowerCase() : content;
    let clicheCount = 0;
    const hits: string[] = [];
    for (const phrase of CLICHE_PHRASES[language]) {
      const needle = isEnglish ? phrase.toLowerCase() : phrase;
      const c = haystack.split(needle).length - 1;
      if (c > 0) {
        clicheCount += c;
        hits.push(phrase);
      }
    }
    if (clicheCount >= 2) {
      issues.push({
        severity: clicheCount >= 3 ? "warning" : "info",
        category: isEnglish ? "Cliché imagery" : "套话意象",
        description: isEnglish
          ? `Found ${clicheCount} cliché / purple-prose phrases (${hits.slice(0, 4).join(joiner)}…), a common AI writing tell`
          : `检测到 ${clicheCount} 处套话 / 陈词意象(${hits.slice(0, 4).join(joiner)}…),呈 AI 写作惯性`,
        suggestion: isEnglish
          ? "Swap generic templates for concrete, informative detail specific to this moment"
          : "换成此刻具体、有信息量的细节,避免「空气凝固 / 闪过一丝 / 勾起一抹」这类通用模板",
      });
    }
  }

  return { issues };
}
