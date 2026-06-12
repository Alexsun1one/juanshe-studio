"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardCopy,
  Copy,
  FileText,
  Layers,
  ListChecks,
  Plus,
  Radio,
  Send,
  ShieldCheck,
  Sparkles,
  Wand2,
} from "lucide-react"
import { fetchChapters, fetchPublishChannels } from "@/lib/api/client"
import type { Chapter } from "@/lib/studio-data"
import type { PublishChannel } from "@/lib/api/types"
import { useWorkspace } from "@/lib/workspace-context"
import { CjPlaceholder } from "@/components/design/cj-placeholder"
import { PixelBadge } from "@/components/design/pixel-badge"
import { AgentPixel } from "@/components/design/agent-pixel"
import { KpiChip, StatLine, Meter, FoldCard } from "@/components/design/kit"
import { EarnPath } from "@/components/workbench/earn-path"
import { ChapterPublishModal } from "./chapter-publish-modal"
import {
  ChannelAuthModal,
  PUBLISH_PLATFORMS,
  connectedChannelNames,
  loadChannelAuth,
  type AuthMap,
} from "./channel-auth-modal"
import "./publish.css"

const soft = { shouldRetryOnError: false }
const QUEUE_LIMIT = 30
const fmt = (n: number | undefined | null) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "—")

const CHAP_STATE: Record<string, { label: string; state: string }> = {
  published: { label: "已发布", state: "published" },
  done: { label: "已完成", state: "success" },
  review: { label: "审校中", state: "warn" },
  "audit-failed": { label: "待修硬伤", state: "warn" },
  writing: { label: "写作中", state: "running" },
  queued: { label: "排队", state: "queued" },
  draft: { label: "草稿", state: "draft" },
}

// 后端主渠道状态 → 给「这本书在主平台到了哪一步」一个人话标签
const PRIMARY_STATE: Record<string, { label: string; state: string }> = {
  released: { label: "已上线", state: "success" },
  published: { label: "已发布", state: "published" },
  queue: { label: "已就绪 · 待发布", state: "queued" },
  draft: { label: "尚无章节", state: "draft" },
}

/**
 * 每个平台的「变现动作」配置:把通用导出格式映射成各平台落地路径。
 * 诚实约定:AutoW 不代持平台密钥、暂无自动群发,所以唯一打通的发布动作是
 * 「取最新成稿 → 按该平台格式复制 → 到平台粘贴发布」;需改写风格的(小红书/知乎)
 * 引导到「多平台创作」生成平台体裁。这里只描述真实可走的一步,不画假按钮。
 */
type PlatActionKind = "copy" | "compose"
const PLAT_META: Record<
  string,
  { use: string; action: PlatActionKind; actionLabel: string; fmtHint: string }
> = {
  wechat_mp: { use: "深度长文沉淀公域读者", action: "copy", actionLabel: "取成稿复制", fmtHint: "Markdown 直接粘贴" },
  xiaohongshu: { use: "强钩子短文涨粉引流", action: "compose", actionLabel: "生成种草文", fmtHint: "需改写为种草体裁" },
  zhihu: { use: "论证型长答立专业心智", action: "copy", actionLabel: "取成稿复制", fmtHint: "Markdown 直接粘贴" },
  x: { use: "分条 thread 撬动转发", action: "copy", actionLabel: "取成稿分条", fmtHint: "确定性切分为 thread" },
  newsletter: { use: "邮件专栏沉淀私域订阅", action: "copy", actionLabel: "取成稿复制", fmtHint: "首屏摘要 + 轻 CTA" },
}

export default function PublishPage() {
  const { books, bookId, booksLoading } = useWorkspace()
  const active = books.find((b) => b.id === bookId)
  const router = useRouter()
  const [selected, setSelected] = React.useState<Chapter | null>(null)
  const [queueExpanded, setQueueExpanded] = React.useState(false)
  const [authOpen, setAuthOpen] = React.useState(false)
  const [auth, setAuth] = React.useState<AuthMap>({})
  const { data: channels } = useSWR(bookId ? ["channels", bookId] : null, () => fetchPublishChannels(bookId), soft)
  const { data: chapters } = useSWR(bookId ? ["chapters", bookId] : null, () => fetchChapters(bookId), soft)
  const activeTitle = typeof active?.title === "string" ? active.title : active?.title?.zh

  React.useEffect(() => {
    setAuth(loadChannelAuth())
  }, [])

  if (!booksLoading && !bookId) {
    return <CjPlaceholder title="发布管理" sub="本地工作区还没有作品,创建后这里会出现平台变现矩阵与发布队列。" />
  }

  const chans: PublishChannel[] = channels ?? []
  const chaps = chapters ?? []
  const publishedChaps = chaps.filter((c) => c.status === "published").length
  // 最新成稿:状态为已发布/已完成/审校/写作中且有字数的最后一章 —— 这是「取成稿复制」的对象
  const latestReady = [...chaps]
    .reverse()
    .find((c) => c.words > 0 && ["published", "done", "review", "writing"].includes(c.status)) // audit-failed 带硬违规,刻意排除出「取成稿」口径
  const draftableCount = chaps.filter((c) => c.words > 0).length

  // 后端只返回作品在「主平台」的真实状态(profile),用它点亮矩阵里对应平台那一行
  const primary = chans[0]
  const primaryProfileId = primary?.id
  const primarySt = primary ? PRIMARY_STATE[primary.status] ?? { label: primary.status, state: "pending" } : null

  const connectedNames = connectedChannelNames(auth)
  // 变现就绪平台数:已标记连接 OR 有成稿可复制粘贴(后者是真实打通的最小变现路径)
  const copyReady = draftableCount > 0
  const readyCount = PUBLISH_PLATFORMS.filter((p) => auth[p.id]?.connected || copyReady).length
  const ready = readyCount > 0
  const readiness = ready
    ? { label: copyReady ? "复制发布就绪" : "待生成成稿", cls: copyReady ? "ok" : "brand" }
    : { label: "待标记渠道", cls: "muted" }

  // 一句「下一步」:把当前最该做的一步说清楚,而不是堆状态
  const nextStep = !copyReady
    ? { text: "先写出 / 导入一章成稿,即可复制到各平台发布", cta: "去写作台", go: () => router.push("/workbench") }
    : connectedNames.length === 0
      ? { text: `已有 ${draftableCount} 章成稿可复制 — 标记你的平台账号,发布路径更清晰`, cta: "标记渠道", go: () => setAuthOpen(true) }
      : { text: `${connectedNames.length} 个平台已标记 · ${draftableCount} 章成稿就绪 — 选平台取成稿,或为小红书/知乎生成体裁`, cta: "多平台创作", go: () => router.push("/compose") }

  // 平台动作:能复制的直接打开最新成稿的导出弹窗;需改写的引导到多平台创作
  const runPlatformAction = (platId: string) => {
    const meta = PLAT_META[platId]
    if (meta?.action === "compose") {
      router.push("/compose")
      return
    }
    if (latestReady) {
      setSelected(latestReady)
    } else {
      toast("还没有可复制的成稿", {
        description: "写出或导入一章正文后,这里就能按各平台格式取成稿复制粘贴。",
        action: { label: "去写作台", onClick: () => router.push("/workbench") },
      })
    }
  }

  const loaded = Boolean(channels && chapters)

  return (
    <div className="cj-screen cj-publish">
      {/* ── 顶部工作条:运营主编像素 + 标题 + 一行密集 KPI(非大卡平铺)── */}
      <header className="cj-workhead pub-head">
        <div className="pub-headline">
          <AgentPixel id="managing-editor" size={44} className="pub-hero-pixel" ariaLabel="运营主编" />
          <div className="pub-headline-text">
            <div className="page-title-row">
              <h1 className="page-title">发布管理</h1>
              <span className={`pub-grade ${readiness.cls}`}>
                <b>{readyCount}</b>
                <i>/ {PUBLISH_PLATFORMS.length} 平台 · {readiness.label}</i>
              </span>
            </div>
            <div className="page-sub">
              《{activeTitle ?? "—"}》多平台变现 —— 取最新成稿,按公众号 / 小红书 / 知乎 / X / Newsletter 格式发布。
            </div>
            <div className="page-sub" style={{ opacity: 0.62 }}>
              本页管「发布进度与平台频道」 · 单篇排版格式去「平台导出」、成品总览去「内容库」。
            </div>
          </div>
          <button type="button" className="btn primary pub-head-cta" onClick={() => router.push("/compose")}>
            <Send size={13} /> 去多平台创作
          </button>
        </div>
        <div className="pub-kpis" role="group" aria-label="发布概览">
          <KpiChip label="目标平台" value={PUBLISH_PLATFORMS.length} unit="个" tone="brand" />
          <KpiChip
            label="成稿可复制"
            value={draftableCount}
            unit="章"
            tone={draftableCount > 0 ? "ok" : "neutral"}
            sub={<StatLine items={[{ n: chaps.length, label: "章总计" }]} />}
            hint="有字数、可按各平台格式取成稿复制的章节"
          />
          <KpiChip
            label="已标记账号"
            value={connectedNames.length}
            unit="个"
            tone={connectedNames.length > 0 ? "amber" : "neutral"}
            hint={connectedNames.length ? connectedNames.join(" / ") : "在「连接标记」里登记你的平台账号"}
          />
          <KpiChip label="已发布" value={publishedChaps} unit="章" tone={publishedChaps > 0 ? "ok" : "neutral"} />
          <KpiChip
            label="主平台"
            value={primary?.name.zh ?? "—"}
            tone="info"
            sub={primarySt ? <StatLine items={[{ n: primarySt.label, label: "" }]} /> : undefined}
            hint="后端返回的作品主平台状态"
          />
        </div>
      </header>

      {/* ── 主体:平台变现矩阵(主区,pane 内滚) + 发布检视(Inspector)── */}
      <div className="cj-screen-body pub-body">
        <div className="cj-mainpane pub-mainpane">
          {/* 下一步引导:把「现在最该做的一步」一行说清(降发布焦虑,常驻主区顶部) */}
          <button type="button" className="pub-next" onClick={nextStep.go}>
            <span className="pub-next-pin"><Sparkles size={13} /></span>
            <span className="pub-next-text">下一步 · {nextStep.text}</span>
            <span className="pub-next-cta">{nextStep.cta} <ArrowRight size={13} /></span>
          </button>

          <div className="pub-mainpane-head">
            <span className="pub-mainpane-title"><Layers size={14} /> 平台变现矩阵</span>
            <button type="button" className="pub-mainpane-act" onClick={() => setAuthOpen(true)}>
              <ShieldCheck size={12} /> 连接标记
            </button>
          </div>

          <div className="cj-pane-scroll pub-pane-scroll">
            <div className="plat-list">
              {PUBLISH_PLATFORMS.map((p) => {
                const meta = PLAT_META[p.id]
                const conn = auth[p.id]
                const isPrimary = primaryProfileId === p.id
                // 状态优先级:已标记账号 > 主平台后端状态 > 有成稿可复制 > 待标记
                const st = conn?.connected
                  ? { label: "账号已标记", state: "success" }
                  : isPrimary && primarySt
                    ? primarySt
                    : copyReady
                      ? { label: "复制就绪", state: "queued" }
                      : { label: "待生成成稿", state: "draft" }
                const Icon = meta?.action === "compose" ? Wand2 : Copy
                const HintIcon = meta?.action === "compose" ? Wand2 : ClipboardCopy
                return (
                  <div className={`plat-row${conn?.connected ? " on" : ""}`} key={p.id}>
                    <span className="logo" style={{ background: p.grad }}>{p.logo}</span>
                    <span className="pn">
                      <span className="nm">{p.name}{isPrimary ? <span className="primary-tag">主平台</span> : null}</span>
                      <span className="use">{meta?.use ?? p.note}</span>
                    </span>
                    <span className="plat-state">
                      <span className="pill" data-state={st.state}><span className="dot" />{st.label}</span>
                      {conn?.connected && conn.handle ? (
                        <span className="handle">{conn.handle}</span>
                      ) : (
                        <span className="fmt-hint"><HintIcon size={11} />{meta?.fmtHint}</span>
                      )}
                    </span>
                    <button type="button" className="plat-act" onClick={() => runPlatformAction(p.id)} title={meta?.fmtHint}>
                      <Icon size={12} /> {meta?.actionLabel ?? "去创作"}
                    </button>
                  </div>
                )
              })}
            </div>
            <p className="plat-note">
              <ShieldCheck size={12} aria-hidden />
              <span>
                AutoW 不代持平台密钥、暂无自动群发 —— 当前打通的发布路径是
                <b>「取最新成稿 → 按平台格式复制 → 到平台粘贴」</b>;小红书/知乎需改写体裁,由「多平台创作」生成。
              </span>
            </p>
          </div>
        </div>

        {/* ── Inspector:变现路径 + 章节发布队列(卡内滚) + 发布路径说明 ── */}
        <aside className="cj-inspector pub-inspector">
          <div className="cj-pane-scroll pub-insp-scroll">
            <section className="card pub-path-card">
              <div className="card-head" style={{ marginBottom: 8 }}>
                <div className="card-title">变现路径</div>
                <button type="button" className="card-action" onClick={() => router.push("/compose")}>多平台创作 →</button>
              </div>
              <EarnPath current="publish" />
            </section>

            <FoldCard
              title="章节发布队列"
              count={chaps.length}
              icon={<ListChecks size={14} />}
              defaultOpen
              scrollable={chaps.length > 5}
              maxHeight={360}
              right={<span className="pub-queue-hint">点开 → 多格式导出 / 复制</span>}
            >
              {chaps.length ? (() => {
                const ordered = [...chaps].reverse()
                const rows = queueExpanded ? ordered : ordered.slice(0, QUEUE_LIMIT)
                const hidden = ordered.length - rows.length
                return (
                  <div className="q-list">
                    {rows.map((c) => {
                      const cs = CHAP_STATE[c.status] ?? { label: c.status, state: "pending" }
                      return (
                        <button type="button" className="q-row clickable" key={c.id} onClick={() => setSelected(c)}>
                          <span className="qn"><FileText size={13} />第 {c.num} 章</span>
                          <span className="qc">
                            <span className="qt">{c.title.zh || "(无标题)"}</span>
                            <span className="qw">{fmt(c.words)} 字</span>
                          </span>
                          <span className="pill" data-state={cs.state}><span className="dot" />{cs.label}</span>
                        </button>
                      )
                    })}
                    {hidden > 0 && (
                      <button type="button" className="q-more" onClick={() => setQueueExpanded(true)}>
                        展开剩余 {hidden} 章(共 {ordered.length} 章)
                      </button>
                    )}
                    {queueExpanded && ordered.length > QUEUE_LIMIT && (
                      <button type="button" className="q-more" onClick={() => setQueueExpanded(false)}>
                        收起,仅显示最近 {QUEUE_LIMIT} 章
                      </button>
                    )}
                  </div>
                )
              })() : loaded ? (
                <div className="q-empty">
                  <PixelBadge kind="publish" size={34} ariaLabel="发布" />
                  <p>还没有章节 —— 写出第一章,这里就会排起可一键导出、复制到各平台的发布队列。</p>
                  <button type="button" className="btn primary sm" onClick={() => router.push("/workbench")}><Plus size={12} /> 去写作台</button>
                </div>
              ) : (
                <div className="q-skel">
                  {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 40, borderRadius: "var(--r-md)" }} />)}
                </div>
              )}
            </FoldCard>

            <FoldCard title="发布就绪" count={`${readyCount}/${PUBLISH_PLATFORMS.length}`} icon={<Radio size={14} />} defaultOpen>
              <div className="pub-ready">
                <Meter
                  label="可发布平台"
                  value={readyCount}
                  max={PUBLISH_PLATFORMS.length}
                  tone={copyReady ? "ok" : "brand"}
                  showValue={false}
                />
                <div className="pub-ready-cap">
                  <span className="num">{readyCount}</span>
                  <span className="pub-ready-of">/ {PUBLISH_PLATFORMS.length} 平台</span>
                  <span className="pub-ready-tag">{readiness.label}</span>
                </div>
                <div className="pub-readgrid">
                  <span className="pub-rstat" data-tone="brand">
                    <BookOpen size={13} />
                    <b className="num">{draftableCount}</b>
                    <i>章成稿</i>
                  </span>
                  <span className="pub-rstat" data-tone="amber">
                    <ShieldCheck size={13} />
                    <b className="num">{connectedNames.length}</b>
                    <i>已标记</i>
                  </span>
                  <span className="pub-rstat" data-tone="ok">
                    <CheckCircle2 size={13} />
                    <b className="num">{publishedChaps}</b>
                    <i>已发布</i>
                  </span>
                </div>
              </div>
            </FoldCard>
          </div>
        </aside>
      </div>

      {selected && bookId && <ChapterPublishModal bookId={bookId} chapter={selected} onClose={() => setSelected(null)} />}
      {authOpen && <ChannelAuthModal onClose={() => setAuthOpen(false)} onSaved={setAuth} />}
    </div>
  )
}
