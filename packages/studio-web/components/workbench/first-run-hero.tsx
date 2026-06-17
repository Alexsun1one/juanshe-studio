"use client"

/**
 * FirstRunHero —— 首次打开(无作品)时的第一屏。
 *
 * 这是用户对"卷·编辑部"的第一印象:不放一个干巴巴的文档图标,而是把整个
 * 17 人 AI 编辑部亮出来 —— 按部门排开的像素角色 + 各自职责,配欢迎语和开建 CTA。
 * 传达"你有一整支编辑部待命",开第一本书他们就在剧场里接力开工。
 */

import * as React from "react"
import Link from "next/link"
import useSWR from "swr"
import { Check, KeyRound, Sparkles, PenSquare, Wand2 } from "lucide-react"
import { fetchLLMProviders } from "@/lib/api/client"
import { AgentPixel } from "@/components/design/agent-pixel"
import { EDITORIAL_STAFF_COUNT } from "@/lib/agent-identity"
import { useAuthorName } from "@/lib/use-author-name"
import "./first-run-hero.css"

const DEPTS: ReadonlyArray<{
  id: string
  label: string
  agents: ReadonlyArray<{ fid: string; name: string; role: string }>
}> = [
  {
    id: "strategy", label: "战略选题",
    agents: [
      { fid: "market-radar", name: "市场雷达", role: "趋势侦察" },
      { fid: "architect", name: "架构师", role: "故事框架" },
      { fid: "setup-auditor", name: "建书复审官", role: "立基复审" },
    ],
  },
  {
    id: "writing", label: "写作",
    agents: [
      { fid: "planner", name: "规划师", role: "章节意图" },
      { fid: "writer", name: "写手", role: "正文落笔" },
      { fid: "chapter-analyst", name: "章节分析官", role: "结构拆解" },
    ],
  },
  {
    id: "review", label: "评审",
    agents: [
      { fid: "editor", name: "审稿官", role: "连续性把关" },
      { fid: "reader-critic", name: "读者评审官", role: "追读视角" },
      { fid: "quality-report", name: "质量报告官", role: "总分门禁" },
    ],
  },
  {
    id: "revision", label: "修改打磨",
    agents: [
      { fid: "reviser", name: "修稿师", role: "定点修订" },
      { fid: "word-steward", name: "字数治理官", role: "篇幅校准" },
      { fid: "polisher", name: "润色师", role: "文字打磨" },
    ],
  },
  {
    id: "ops", label: "运营质保",
    agents: [
      { fid: "state-verifier", name: "状态校验员", role: "真相结算" },
      { fid: "style-fingerprint", name: "风格指纹官", role: "嗓音一致" },
      { fid: "prompt-steward", name: "提示词治理官", role: "提示词进化" },
    ],
  },
  {
    id: "eic", label: "总编室",
    agents: [
      { fid: "managing-editor", name: "执行主编", role: "统筹派工" },
      { fid: "editor-in-chief", name: "总编", role: "签发裁决" },
    ],
  },
]

export function FirstRunHero({ onCreate }: { onCreate: () => void }) {
  const authorName = useAuthorName()
  const authorSalutation = authorName.trim().endsWith("大大") ? authorName.trim() : `${authorName.trim()} 大大`
  // 三步引导的真实完成态:第一步「配模型」按 provider 是否已配 key 判定 ——
  // 配好回来就打勾、视觉焦点自动移到第二步。取数失败保持静态三步,绝不误标完成。
  const { data: providers } = useSWR("llm-providers", fetchLLMProviders, { shouldRetryOnError: false })
  const llmReady = (providers ?? []).some((p) => p.hasKey && p.enabled)
  return (
    <div className="first-run">
      <header className="fr-head">
        <span className="fr-badge">
          <span className="fr-badge-dot" />
          卷舍 · {EDITORIAL_STAFF_COUNT} 位 AI 编辑已就位
        </span>
        <h1 className="fr-title">{authorSalutation},你的编辑部待命中</h1>
        <p className="fr-desc">
          上百个 AI、六个部门,日夜替你卷。开张只要三步:配好你自己的写作模型,开第一本书,剩下的——
          规划、落笔、评审、修订、签发——交给下面这群永不疲倦的家伙。
        </p>

        {/* 开张三步:新手引导 */}
        <ol className="fr-steps">
          <li className={`fr-step${llmReady ? " done" : ""}`}>
            <span className="fr-step-ic">{llmReady ? <Check size={15} /> : <KeyRound size={15} />}</span>
            <span className="fr-step-body">
              <b>配置写作模型(BYOK)</b>
              <span>填你自己的模型 Key(DeepSeek / Kimi / 智谱…),仅存本地、不上传。</span>
              <span className="fr-step-note">
                进阶:可在<Link href="/agents">编辑部成员</Link>给每个角色单独换模型
              </span>
            </span>
            {llmReady ? (
              <Link href="/llm" className="fr-step-cta done"><Check size={12} /> 已配置</Link>
            ) : (
              <Link href="/llm" className="fr-step-cta">去配置 →</Link>
            )}
          </li>
          <li className={`fr-step${llmReady ? " current" : ""}`}>
            <span className="fr-step-ic"><PenSquare size={15} /></span>
            <span className="fr-step-body">
              <b>开建第一本作品</b>
              <span>说一句想写的样子(题材/时代/主角/基调),编辑部几十秒起好框架与章节地图。</span>
            </span>
            <button type="button" className={`fr-step-cta solid${llmReady ? " pulse" : ""}`} onClick={onCreate}>开建 →</button>
          </li>
          <li className="fr-step">
            <span className="fr-step-ic"><Wand2 size={15} /></span>
            <span className="fr-step-body">
              <b>让编辑部开写</b>
              <span>点「继续创作 / 连续写」,角色们就在剧场里实时接力,一棒接一棒。</span>
            </span>
          </li>
        </ol>

        <div className="fr-actions">
          <button type="button" className="fr-btn primary" onClick={onCreate}>
            <Sparkles size={16} /> 开建第一本作品 →
          </button>
        </div>
      </header>

      <div className="fr-office" role="img" aria-label={`编辑部 ${EDITORIAL_STAFF_COUNT} 位 AI 角色`}>
        {DEPTS.map((dept) => (
          <section className="fr-dept" key={dept.id}>
            <div className="fr-dept-tag">{dept.label}</div>
            <div className="fr-dept-agents">
              {dept.agents.map((a) => (
                <div className="fr-agent" key={a.fid} title={`${a.name} · ${a.role}`}>
                  <span className="fr-agent-art">
                    <AgentPixel id={a.fid} size={48} ariaLabel={a.name} />
                  </span>
                  <span className="fr-agent-name">{a.name}</span>
                  <span className="fr-agent-role">{a.role}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
