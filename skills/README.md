# Skill Registry —— AI 编辑部技能库

可版本化、可组合、可评估的写作能力库。
Agent 负责"角色",Skill 负责"能力";风格编辑 / 平台适配 Agent 在运行时**挂载**对应 Skill。

## 目录结构
```
skills/
  style/      风格原型(如何写) —— kazike-narrative, de-ai-tone, ...
  platform/   平台适配(给谁写) —— wechat-longform, xiaohongshu-note, zhihu-answer, x-thread, ...
  genre/      体裁(写什么)     —— opinion, tutorial, review, story, ...
  layout/     排版规则          —— wechat-minimal, xhs-card, ...
```

## 已有
| 路径 | 类型 | 说明 | 来源/许可证 |
|---|---|---|---|
| `style/kazike-narrative.md` | 风格 | 卡兹克式"活人感"叙事 | 改编自 KKKKhazix/khazix-skills · MIT |
| `style/de-ai-tone.md` | 风格 | 去 AI 腔质检 | 蒸馏自 blader/humanizer · op7418/Humanizer-zh · MIT |
| `platform/wechat-longform.md` | 平台 | 公众号长文 | 思路参考 oaker-io/wewrite · MIT |

## Skill 文件模板(§6)
```markdown
# Skill: 名称
> 来源/署名(若改编自第三方,注明仓库 + 许可证)
## Purpose / Applies To / Input / Output
## Rules / Style Tokens / Layout Rules
## Do / Don't / Examples / Evaluation
```

## 版权与署名策略(硬约束)
- **可采用**:开源且许可证允许(如 MIT)的素材 —— 蒸馏成本库 Skill 时**保留原仓库署名/许可证**。
- **不可照搬**:无许可证 / 保留所有权利的作者素材,以及任何**在世博主的独特原句** —— 只抽象"可解释的模式"(开头方式、节奏、结构、禁忌),不内置其原文。
- 本库 Skill 描述的是**通用模式**,不是某个具体作者的仿写器。

## 加载
程序化读取见 `packages/core/src/skills/registry.ts`(`listSkills` / `loadSkill`)。
Agent prompt 注入(把选中的 Skill 拼进风格编辑/平台适配 Agent 的系统提示)为后续步骤。
