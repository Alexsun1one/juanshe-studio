"use client"

import * as React from "react"
import useSWR from "swr"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft, Network } from "lucide-react"
import { fetchStoryEntity } from "@/lib/api/client"
import { useWorkspace } from "@/lib/workspace-context"
import { predicateLabel, formatChapter } from "@/lib/labels"
import "./entity.css"

const soft = { shouldRetryOnError: false }
const TYPE_LABEL: Record<string, string> = { person: "人物", item: "物件", place: "地点", org: "组织", concept: "概念", other: "其它" }
const initial = (s: string) => (s || "?").trim().replace(/[《》"'\s]/g, "").charAt(0) || "?"

function entitySourceLabel(data: { fallback?: string } | undefined) {
  if (!data) return ""
  if (data.fallback === "character_matrix") return "角色真相文件 fallback"
  if (data.fallback) return `Fallback: ${data.fallback}`
  return "MemoryDB 实体"
}

export default function EntityDetailPage() {
  const { bookId, booksLoading } = useWorkspace()
  const router = useRouter()
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(String(params?.name ?? ""))
  const { data, error, isLoading } = useSWR(
    bookId && name ? ["entity", bookId, name] : null,
    () => fetchStoryEntity(bookId, name),
    soft,
  )

  const goEntity = (n: string) => router.push(`/characters/${encodeURIComponent(n)}`)
  // ③ 角色页反链:点出场章号直接回到该章沉浸阅读 —— 省掉"这人到底哪章出现过"的来回翻找
  const goChapter = (n: number) => { if (n > 0) router.push(`/immersive?chapter=${n}`) }
  const chapterLink = (n: number) =>
    n > 0 ? (
      <button type="button" className="e-ch-link num v-brand" onClick={() => goChapter(n)} title={`回到第 ${n} 章阅读`}>
        {n}
      </button>
    ) : (
      <b className="num v-brand">?</b>
    )
  // 状态/关系里的「自第 X 章」也做成可点回读,角色页每个章节引用都能直达
  const sinceLink = (n: number, prefix = "") =>
    n > 0 ? (
      <button type="button" className="e-since e-since-link" onClick={() => goChapter(n)} title={`回到第 ${n} 章阅读`}>
        {prefix}{formatChapter(n)}
      </button>
    ) : null

  const outgoing = (data?.relations ?? []).filter((r) => !r.incoming)
  const incoming = (data?.relations ?? []).filter((r) => r.incoming)
  const pending = booksLoading || (!!bookId && isLoading && !data)
  const stateHint = data?.fallback ? "角色真相文件 fallback,待写作后入 MemoryDB" : "活图谱,矛盾已自纠错"

  return (
    <div className="page cj-entity">
      <div className="e-bar">
        <button type="button" className="btn ghost sm" onClick={() => router.push("/graph")}><ArrowLeft size={14} /> 故事图谱</button>
      </div>

      {pending && <div className="skel" style={{ height: 320 }} />}
      {!pending && !bookId && <div className="e-missing">还没有选中作品。请先回到书库选择一本作品,再查看实体详情。</div>}
      {!pending && error && !data && (
        <div className="e-missing">
          <div className="e-missing-title">没找到「{name}」这个实体</div>
          <div className="e-missing-copy">它可能还没进入 MemoryDB,也可能不在角色真相文件里。先回角色设定确认名称,或打开故事图谱查看当前可用实体。</div>
          <div className="e-missing-actions">
            <button type="button" className="btn sm" onClick={() => router.push("/characters")}>角色与设定</button>
            <button type="button" className="btn primary sm" onClick={() => router.push("/graph")}>故事图谱</button>
          </div>
        </div>
      )}

      {data && (
        <>
          <header className="e-hero card">
            <div className={`e-av t-${data.entity.type}`}>{initial(data.entity.name)}</div>
            <div className="e-hero-main">
              <div className="e-name-row">
                <h1 className="e-name">{data.entity.name}</h1>
                <span className={`e-type t-${data.entity.type}`}>{TYPE_LABEL[data.entity.type] ?? data.entity.type}</span>
                <span className={`e-source${data.fallback ? " fallback" : " live"}`}>{entitySourceLabel(data)}</span>
              </div>
              {data.entity.summary && <p className="e-summary">{data.entity.summary}</p>}
              <div className="e-facts">
                {data.entity.aliases && <span className="e-fact">别名 · {data.entity.aliases}</span>}
                <span className="e-fact">出场 · 第 {chapterLink(data.entity.firstChapter)}–{chapterLink(data.entity.lastChapter)} 章</span>
                <span className="e-fact"><Network size={11} /> <b className="num v-rose">{data.relations.length}</b> 关系 · <b className="num v-brand">{data.neighbors.length}</b> 邻居</span>
                {data.source && <span className="e-fact">来源 · {data.source}</span>}
              </div>
            </div>
          </header>

          <div className="e-grid">
            <section className="card e-sec">
              <h4 className="e-sec-h"><span className="e-sec-t">当前状态</span> <span className="e-sec-meta">{stateHint}</span></h4>
              {data.state.length ? (
                <div className="e-state">
                  {data.state.map((s, i) => (
                    <div className="e-state-row" key={i}>
                      <span className="e-state-k">{predicateLabel(s.predicate)}</span>
                      <span className="e-state-v">{s.object}</span>
                      {sinceLink(s.sinceChapter, "自")}
                    </div>
                  ))}
                </div>
              ) : <div className="e-empty">暂无状态记录,写作推进后会自动入档。</div>}
            </section>

            <section className="card e-sec">
              <h4 className="e-sec-h"><span className="e-sec-t">关系</span> <span className="e-sec-meta"><b className="num v-rose">{outgoing.length}</b> 主动 · <b className="num v-brand">{incoming.length}</b> 被指向</span></h4>
              {outgoing.length + incoming.length === 0 && <div className="e-empty">暂无关系,等故事里有了互动就会连上。</div>}
              {outgoing.map((r, i) => (
                <div className="e-rel" key={`o${i}`}>
                  <span className="e-rel-pred">{predicateLabel(r.predicate)}</span>
                  <span className="e-rel-arrow">→</span>
                  {r.objectIsEntity
                    ? <button type="button" className="e-rel-obj link" onClick={() => goEntity(r.object)}>{r.object}</button>
                    : <span className="e-rel-obj">{r.object}</span>}
                  {sinceLink(r.sinceChapter)}
                </div>
              ))}
              {incoming.map((r, i) => (
                <div className="e-rel incoming" key={`i${i}`}>
                  <button type="button" className="e-rel-obj link" onClick={() => goEntity(r.subject)}>{r.subject}</button>
                  <span className="e-rel-arrow">→</span>
                  <span className="e-rel-pred">{predicateLabel(r.predicate)}</span>
                  <span className="e-rel-self">本实体</span>
                </div>
              ))}
            </section>
          </div>

          <section className="card e-sec">
            <h4 className="e-sec-h"><span className="e-sec-t">邻居</span> <span className="e-sec-meta"><b className="num v-brand">{data.neighbors.length}</b> 个 · 1 跳可达</span></h4>
            {data.neighbors.length ? (
              <div className="e-neighbors">
                {data.neighbors.map((n) => (
                  <button type="button" key={n.id} className="e-nb" onClick={() => goEntity(n.name)} title={n.summary}>
                    <span className={`e-nb-av t-${n.type}`}>{initial(n.name)}</span>
                    <span className="e-nb-name">{n.name}</span>
                    <span className={`e-type t-${n.type}`}>{TYPE_LABEL[n.type] ?? n.type}</span>
                  </button>
                ))}
              </div>
            ) : <div className="e-empty">暂无邻居,这个实体目前还很「独立」。</div>}
          </section>
        </>
      )}
    </div>
  )
}
