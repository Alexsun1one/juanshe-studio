"use client"

import * as React from "react"
import Link from "next/link"
import { PixelBadge } from "@/components/design/pixel-badge"
import { ArrowRight, Sparkles } from "lucide-react"
import "./guide.css"

/* ───────────────────────────────────────────────────────────
   创作指南 · /guide
   把引擎内部的写作哲学透给用户:你的输入正好喂中引擎奖励的东西,
   就能稳定出好稿。内容内联(无后端),正文长文用思源宋体,
   标题/UI 用像素,好/坏示范用对比卡片。
   ─────────────────────────────────────────────────────────── */

type Example = {
  /** 好示范(暖绿/品牌紫边) */
  good: string
  /** 坏示范(暖橙/玫瑰边) */
  bad: string
  /** 为什么 —— 克制的小标注,讲引擎为何奖励 */
  why?: string
}

type Block =
  | { type: "lead"; text: string }
  | { type: "para"; text: string }
  | { type: "points"; items: { k: string; v: string }[] }
  | { type: "examples"; goodLabel?: string; badLabel?: string; items: Example[] }
  | { type: "callout"; tone?: "brand" | "warm"; title: string; text: string }

type Section = {
  id: string
  no: string
  pixel: import("@/components/design/pixel-badge").PixelBadgeKind
  title: string
  tagline: string
  blocks: Block[]
}

const GUIDE_SECTIONS: Section[] = [
  {
    id: "how-it-thinks",
    no: "01",
    pixel: "workbench",
    title: "编辑部怎么读你的输入",
    tagline: "先懂引擎奖励什么,再写你的灵感",
    blocks: [
      {
        type: "lead",
        text:
          "卷舍不是一个「续写机」,它是一支会评分的编辑部。你给的每一句设定,都会被架构师拆成故事框架、被复审官审一遍逻辑与潜力、再被判官按五个维度逐章打分。你越知道它在奖励什么,你的输入就越精准地喂中它——出稿质量是被你的输入决定的,不是靠运气。",
      },
      {
        type: "para",
        text:
          "判官每章按五个维度打分,权重是公开的:文笔 0.25、一致性 0.20、情感 0.20、去 AI 味 0.20、节奏 0.15。这五条就是你输入要瞄准的靶心——它们解释了为什么「具体」「有动机」「有钩子」的灵感总是出好稿,而「宏大」「空泛」「正能量」的灵感总是出平庸货。",
      },
      {
        type: "points",
        items: [
          { k: "文笔 25%", v: "画面、对白、细节是否具体可感;有没有废话。抽象名词堆砌一律低分。" },
          { k: "一致性 20%", v: "人物、设定、前情不打架;本章是否兑现了上一章埋的钩子。" },
          { k: "情感 20%", v: "情绪要演出来——动作、生理、感官,而不是把「他很愤怒」当结论报出来。" },
          { k: "去 AI 味 20%", v: "句长有变化、不堆套话、不用机器句式。整章一个语速立刻露馅。" },
          { k: "节奏 15%", v: "开篇 300 字内有失衡/悬念,章末断在「事已发、果未现」的定格上。" },
        ],
      },
      {
        type: "callout",
        tone: "brand",
        title: "一句话记住",
        text:
          "你不是在「描述一个故事」,你是在给编辑部递一份「能照着开写、且每章都拿得到高分」的施工图。越具体、越有张力、越能落到画面,引擎越买账。",
      },
    ],
  },
  {
    id: "one-line",
    no: "02",
    pixel: "outline",
    title: "一句话灵感:决定整本书的开关",
    tagline: "把「宏大空泛」换成「具体可拍」",
    blocks: [
      {
        type: "lead",
        text:
          "建书框里那段「想写的样子」,是架构师起稿的唯一依据。它定了基调、人物、世界、节奏的初始坐标——写偏一寸,后面几十万字偏一丈。最好的一句话灵感,读完能立刻在脑子里「看见」一个画面、一个具体的人、一件正在发生的事。",
      },
      {
        type: "examples",
        items: [
          {
            bad: "我想写一个关于成长与救赎的史诗故事,主角历经磨难最终找到自我。",
            good:
              "近未来海滨城市,女主是能「听见」老建筑记忆的修复师,接下一桩旧剧院翻新案,逐渐卷进二十年前的失踪旧案。基调温暖带悬疑。",
            why:
              "坏的全是抽象名词(成长/救赎/史诗/自我),架构师无从落地;好的给了时代、地点、主角的具体能力、一个正在发生的具体案子——架构师能立刻搭出场景、冲突、人物矩阵。",
          },
          {
            bad: "都市爽文,主角很强,打脸装逼,爽就完了。",
            good:
              "都市,主角是被甲方坑到破产的独立游戏制作人,靠一套能预判玩家情绪的算法翻身;爽点来自每次发布会现场实时打脸唱衰者。基调快、有黑色幽默。",
            why:
              "「爽」是结果不是设定。好的把「爽」落到了具体职业、具体金手指、具体爽点场景——引擎才知道该怎么演这个爽,而不是空喊。",
          },
        ],
      },
      {
        type: "callout",
        tone: "warm",
        title: "自检三件套",
        text:
          "写完一句话灵感,问自己三个问题:① 有没有一个具体的「人」?② 有没有一件正在发生的「事」?③ 有没有一个能感到的「基调」?三个都有,才递给编辑部。",
      },
    ],
  },
  {
    id: "constraints",
    no: "03",
    pixel: "characters",
    title: "给约束:动机、基调、节奏",
    tagline: "约束不是限制创意,是给引擎瞄准镜",
    blocks: [
      {
        type: "lead",
        text:
          "很多人怕「写太死」,于是只给一个题材就提交——结果引擎只能给最大公约数的平庸稿。恰恰相反:越精确的约束,出稿越有个性。引擎奖励一致性和情感,而一致性来自清晰的人物动机,情感来自明确的基调。这两样你不给,它只能自己猜,猜出来的就是「正确但无聊」。",
      },
      {
        type: "points",
        items: [
          { k: "主角动机", v: "他「想要什么、怕什么」。一句话:'她要救回被顶替的署名,但每靠近真相一步就更可能失去现在的安稳。'" },
          { k: "基调", v: "用两三个感官化的词锁定语气:温暖带刺 / 冷峻克制 / 荒诞黑色幽默。别用「好看」「高级」这种没有方向的词。" },
          { k: "章节节奏", v: "告诉它一章给读者什么:'每章一个小发现,三章一个反转。' 这直接喂中「节奏」维度的钩子判据。" },
          { k: "雷区清单", v: "明确说不要什么:'不要穿越,不要后宫,不要洒狗血的误会流。' 负向约束和正向约束一样有用。" },
        ],
      },
      {
        type: "examples",
        items: [
          {
            bad: "题材:仙侠。要好看,要有深度,要大气。",
            good:
              "仙侠。主角动机:为查清师门灭门真相而忍辱拜入仇敌门下,越往上爬越要背叛真心。基调:克制、内伤式的悲。节奏:每卷一个身份揭穿。不要金手指碾压,不要圣母。",
            why:
              "「好看/深度/大气」是评价词不是约束,引擎接不住。好的把动机、基调、节奏、雷区全锁死了——这正是一致性(20%)和情感(20%)两个维度的弹药。",
          },
        ],
      },
    ],
  },
  {
    id: "style-sample",
    no: "04",
    pixel: "editor",
    title: "风格样本:让它学你的腔",
    tagline: "几百字真实文字,胜过十个形容词",
    blocks: [
      {
        type: "lead",
        text:
          "如果你想要特定的笔触,别用「文艺一点」「接地气」这种词去描述——直接喂一段你喜欢的文字当样本。引擎会从样本里提取可量化的风格指纹:句长的长短搭配(burstiness)、短句占比、虚词比例、标点习惯,转成一串可执行的「风格戒律」注入到每一次生成里。",
      },
      {
        type: "callout",
        tone: "brand",
        title: "只学腔调,不抄原文",
        text:
          "引擎只存风格的数值指纹和可读戒律,代码级守卫确保绝不留存样本原文——这是法律红线。所以放心喂你欣赏的文字当节拍器,它学的是「怎么呼吸」,不是「抄哪句」。",
      },
      {
        type: "examples",
        goodLabel: "好的样本特征",
        badLabel: "无效的风格指令",
        items: [
          {
            bad: "「写得文艺一点,有高级感,像那种获奖作家的文笔。」",
            good:
              "贴一段 300–800 字、你真心喜欢的中文叙事:有长短句交错、有具体细节、有你想要的语气。引擎从中量出节奏与用词偏好。",
            why:
              "「文艺/高级/获奖」无法量化,引擎只能转译成它对这些词的刻板印象(往往就是套话美文)。真实样本能被精确测量,出稿才真的像你要的腔。",
          },
        ],
      },
    ],
  },
  {
    id: "continuation",
    no: "05",
    pixel: "runs",
    title: "续写引导:每章把舵",
    tagline: "一句具体的指令,改写一整章走向",
    blocks: [
      {
        type: "lead",
        text:
          "开写之后,你不是只能看着它跑。每次续写都能给一句引导——这是你对单章最直接的控制。引擎在续写时会优先满足你的引导,同时仍受五维评分约束。最有效的引导是「具体到画面或转折」的,最无效的是「再写好一点」。",
      },
      {
        type: "examples",
        goodLabel: "把舵的引导",
        badLabel: "失灵的引导",
        items: [
          {
            bad: "这章再写精彩一点,加点冲突,节奏快一些。",
            good:
              "这章让女主在剧院后台发现一张三十年前的旧票根,上面的名字正是失踪者;别解释意义,断在她把票根攥进掌心、听见身后脚步那一刻。",
            why:
              "「精彩/快一些」是抽象评价,引擎只能往套路上靠。好的给了具体道具(旧票根)、具体转折(名字对上了)、还指定了章末钩子(定格在脚步声)——三个维度全部喂中。",
          },
          {
            bad: "让两个人感情升温。",
            good:
              "让两人在抢修暴雨漏水时不得不共用一把伞,谁都没说话,但他默默把伞往她那边偏了半尺——靠动作演,别写「他们的心越来越近」。",
            why:
              "情感维度奖励「演」不奖励「报」。坏的会得到一段直白的心理旁白;好的指定了用动作和细节演出来,正中情感(20%)与去 AI 味(20%)。",
          },
        ],
      },
      {
        type: "callout",
        tone: "warm",
        title: "续写引导的万能模板",
        text:
          "「让 [谁] 在 [具体场景] 做 [具体动作/发现具体东西],别解释意义,断在 [一个未完成的动作画面] 上。」 把这个模板填满,基本不会写垮。",
      },
    ],
  },
  {
    id: "anti-slop",
    no: "06",
    pixel: "detect",
    title: "避开机器味:引擎在扣什么分",
    tagline: "知道雷区,你的输入就不会引它踩雷",
    blocks: [
      {
        type: "lead",
        text:
          "「去 AI 味」占 20% 权重,而且有一套零成本的机检会逐条点名。了解它扣什么,有两个用处:一是别在你的灵感/引导里用这些词(你怎么写,它就怎么学);二是看到成稿里冒出来,你知道该让它重写哪里。",
      },
      {
        type: "points",
        items: [
          { k: "句长单调", v: "好几句 15–25 字的句子连排,是机器味的头号信号。真人会长短交错。" },
          { k: "套话与连接词", v: "「值得注意的是」「然而/此外/与此同时」「总而言之」——说明文腔,小说里出现即扣。" },
          { k: "空洞美文词", v: "「淋漓尽致/栩栩如生/熠熠生辉」「一抹/一丝/缓缓/微微」堆叠,一段三个就该重写。" },
          { k: "禁用句式", v: "「不是 A,而是 B」及其逗号变体、「仿佛…一般」明喻套壳、「这一刻终于明白」顿悟总结——机检逐条命中即点名。" },
          { k: "报情绪而非演", v: "「他感到一阵恐惧」「心中涌起愤怒」是把情绪当结论。要换成手在抖、喉咙发紧、把杯子攥出白印。" },
        ],
      },
      {
        type: "examples",
        items: [
          {
            bad: "他不是急,不是求,而是一种说不上来的笃定,仿佛一切尽在掌握。",
            good: "那眼神太笃定了,像早就知道他会接。",
            why:
              "坏的同时踩了「不是…而是」、逗号三连、「说不上来的」模糊兜底、「仿佛…」套壳——四个雷区。好的用一个具体的眼神和一句口语,把同样的笃定演了出来。",
          },
          {
            bad: "空气仿佛凝固,气氛凝重,她的心跳漏了一拍,百感交集。",
            good: "她的指甲掐进掌心,没说话。桌上的茶凉透了,谁都没碰。",
            why:
              "坏的全是批量套话意象(凝固/凝重/漏一拍/百感交集)。好的用此情此景独有的具体细节(指甲、凉茶)让读者自己感到紧张——这就是引擎奖励的「具体可感」。",
          },
        ],
      },
    ],
  },
]

export default function GuidePage() {
  const [activeId, setActiveId] = React.useState(GUIDE_SECTIONS[0].id)
  const sectionRefs = React.useRef<Record<string, HTMLElement | null>>({})
  const scrollRef = React.useRef<HTMLDivElement>(null)

  // 滚动监听:高亮当前章节锚点(用主滚动容器做 root,不是 window)
  React.useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (visible?.target.id) setActiveId(visible.target.id)
      },
      { root, rootMargin: "-20% 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] },
    )
    GUIDE_SECTIONS.forEach((s) => {
      const el = sectionRefs.current[s.id]
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [])

  const jump = (id: string) => {
    const el = sectionRefs.current[id]
    el?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="cj-screen cj-guide">
      <div className="guide-shell">
        {/* ── 左侧章节锚点导航 ── */}
        <nav className="guide-toc scroll-thin" aria-label="章节导航">
          <div className="guide-toc-brand">
            <PixelBadge kind="wiki" size={20} />
            <span>创作指南</span>
          </div>
          <ol className="guide-toc-list">
            {GUIDE_SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`guide-toc-item${activeId === s.id ? " active" : ""}`}
                  onClick={() => jump(s.id)}
                >
                  <span className="guide-toc-no">{s.no}</span>
                  <span className="guide-toc-label">{s.title}</span>
                </button>
              </li>
            ))}
          </ol>
          <Link href="/books" className="guide-toc-cta">
            <Sparkles size={13} />
            去建一本书
            <ArrowRight size={13} />
          </Link>
        </nav>

        {/* ── 正文 ── */}
        <div className="guide-body scroll-thin" ref={scrollRef}>
          <header className="guide-hero">
            <div className="guide-hero-pixel">
              <PixelBadge kind="wiki" size={40} />
            </div>
            <h1 className="guide-hero-title">把灵感写成编辑部读得懂的施工图</h1>
            <p className="guide-hero-lead">
              卷舍的出稿质量,几乎完全由你的输入决定。这份指南把引擎内部的评分哲学透给你——
              当你的一句话灵感、约束、风格样本和续写引导,正好喂中引擎奖励的东西,好稿就是稳定的,而不是碰运气。
            </p>
            <div className="guide-hero-meta">6 节 · 约 8 分钟读完 · 越早读越省一整本书的弯路</div>
          </header>

          {GUIDE_SECTIONS.map((s) => (
            <section
              key={s.id}
              id={s.id}
              className="guide-section"
              ref={(el) => {
                sectionRefs.current[s.id] = el
              }}
            >
              <div className="guide-sec-head">
                <PixelBadge kind={s.pixel} size={26} className="guide-sec-pixel" />
                <div className="guide-sec-headtext">
                  <div className="guide-sec-no">{s.no}</div>
                  <h2 className="guide-sec-title">{s.title}</h2>
                  <div className="guide-sec-tagline">{s.tagline}</div>
                </div>
              </div>

              <div className="guide-sec-body">
                {s.blocks.map((b, i) => (
                  <GuideBlock key={i} block={b} />
                ))}
              </div>
            </section>
          ))}

          <footer className="guide-foot">
            <PixelBadge kind="assistant" size={22} />
            <div className="guide-foot-text">
              <strong>读完就去试。</strong>
              带着「具体的人 · 正在发生的事 · 能感到的基调」回到建书框,你会立刻看到出稿的不同。
            </div>
            <Link href="/books" className="guide-foot-cta">
              开始创作
              <ArrowRight size={14} />
            </Link>
          </footer>
        </div>
      </div>
    </div>
  )
}

function GuideBlock({ block }: { block: Block }) {
  switch (block.type) {
    case "lead":
      return <p className="guide-lead">{block.text}</p>
    case "para":
      return <p className="guide-para">{block.text}</p>
    case "points":
      return (
        <dl className="guide-points">
          {block.items.map((p, i) => (
            <div className="guide-point" key={i}>
              <dt className="guide-point-k">{p.k}</dt>
              <dd className="guide-point-v">{p.v}</dd>
            </div>
          ))}
        </dl>
      )
    case "callout":
      return (
        <aside className={`guide-callout tone-${block.tone ?? "brand"}`}>
          <div className="guide-callout-title">{block.title}</div>
          <p className="guide-callout-text">{block.text}</p>
        </aside>
      )
    case "examples":
      return (
        <div className="guide-examples">
          {block.items.map((ex, i) => (
            <div className="guide-ex" key={i}>
              <div className="guide-ex-pair">
                <div className="guide-ex-card bad">
                  <div className="guide-ex-tag">{block.badLabel ?? "别这样写"}</div>
                  <p className="guide-ex-text">{ex.bad}</p>
                </div>
                <div className="guide-ex-card good">
                  <div className="guide-ex-tag">{block.goodLabel ?? "这样写"}</div>
                  <p className="guide-ex-text">{ex.good}</p>
                </div>
              </div>
              {ex.why && (
                <p className="guide-ex-why">
                  <span className="guide-ex-why-tag">为什么</span>
                  {ex.why}
                </p>
              )}
            </div>
          ))}
        </div>
      )
  }
}
