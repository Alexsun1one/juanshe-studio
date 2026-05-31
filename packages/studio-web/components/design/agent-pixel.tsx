"use client"

/**
 * 编辑部 agent 的"像素角色头像"——可缩放 SVG,无图片资源。
 *
 * 设计原则(B4 重做后):
 *   · 16×16 像素网格,shapeRendering=crispEdges 保证硬边像素感。
 *   · 共用脸/眼睛/腮红/嘴的骨架,不变。
 *   · 每个 agent 独有四件套:
 *       - hair/hat:头发或独特帽子(贝雷帽 / 礼帽 / 警徽帽 / 工程帽 等)
 *       - face:可选眼镜/眼罩/胡子(覆盖默认眼睛)
 *       - body:衣服细节(领带 / 警徽 / 围巾 / 大衣领)
 *       - tool:右侧/腰间的职业道具(雷达 / 蓝图 / 放大镜 / 印章 / 剪刀 ...)
 *   · 即使遮住名字,也能凭轮廓 + 帽子 + 道具识别 17 个角色。
 */
import * as React from "react"
import { agentColor } from "@/lib/agent-identity"
import { toFrontendAgentId } from "@/lib/api/agent-aliases"
import { agentAvatar } from "@/lib/agent-avatars"

type Rect = [x: number, y: number, w: number, h: number, color?: string]

const SKIN = "#f5d3a8"
const BLUSH = "#f3a8a0"
const INK = "#1a1f2e"
const WHITE = "#ffffff"
const GOLD = "#FFC658"
const RED = "#E04848"
const STEEL = "#5C6478"
const GREEN = "#2BB97A"
const PAPER = "#FFFAF0"

type AgentSpec = {
  /** 帽子或头发(覆盖默认头发) */
  hair?: Rect[]
  /** 脸上叠加:眼镜/眼罩/胡子(在默认眼睛之上画) */
  face?: Rect[]
  /** 身体修饰:领带/警徽/围巾 */
  body?: Rect[]
  /** 右手/腰间道具 */
  tool: Rect[]
}

/**
 * 17 个角色独特设计。
 * 后端 id / 前端规范 id 双覆盖,toFrontendAgentId 会归一。
 */
const SPECS: Record<string, AgentSpec> = {
  // ─────────────────────────────── 战略选题 ─────────────────────────────
  // 市场雷达:雷达接收头盔(头顶天线 + 弧)+ 旁边波纹
  "market-radar": {
    hair: [
      [4, 2, 8, 1, STEEL], [3, 3, 10, 1, STEEL],  // 钢盔
      [7, 1, 2, 1, INK],    // 天线柱
      [8, 0, 1, 1, RED],    // 红信号灯
    ],
    tool: [
      [13, 5, 1, 1], [14, 4, 1, 1], [15, 3, 1, 1],   // 雷达波(身份色)
      [13, 7, 1, 1], [14, 6, 1, 1], [15, 5, 1, 1],
      [13, 9, 1, 1], [14, 8, 1, 1], [15, 7, 1, 1],
    ],
  },
  radar: {  // 后端别名
    hair: [
      [4, 2, 8, 1, STEEL], [3, 3, 10, 1, STEEL],
      [7, 1, 2, 1, INK],
      [8, 0, 1, 1, RED],
    ],
    tool: [
      [13, 5, 1, 1], [14, 4, 1, 1], [15, 3, 1, 1],
      [13, 7, 1, 1], [14, 6, 1, 1], [15, 5, 1, 1],
      [13, 9, 1, 1], [14, 8, 1, 1], [15, 7, 1, 1],
    ],
  },

  // 架构师:黄色安全帽 + 手持蓝图卷
  architect: {
    hair: [
      [3, 3, 10, 1, GOLD], [4, 2, 8, 1, GOLD],   // 帽身
      [3, 3, 1, 1, INK], [12, 3, 1, 1, INK],     // 帽沿黑边
      [7, 1, 2, 1, INK],                          // 帽顶脊
    ],
    body: [[7, 11, 2, 1, GOLD]],                  // 反光带
    tool: [
      [13, 10, 3, 1, PAPER], [13, 11, 3, 2, PAPER],
      [13, 13, 3, 1, PAPER],
      [13, 10, 1, 4, INK], [15, 10, 1, 4, INK],   // 卷边
      [14, 12, 1, 1],                              // 蓝图色块
    ],
  },

  // 建书复审官:学者圆框 monocle + 印章 + 长胡子
  "setup-auditor": {
    face: [
      [9, 5, 2, 2, WHITE],
      [9, 5, 1, 1, INK], [10, 5, 1, 1, INK],
      [9, 6, 1, 1, INK], [10, 6, 1, 1, INK],
      [11, 6, 1, 1, INK],
    ],
    hair: [[3, 3, 10, 1, INK], [4, 2, 8, 1, INK]],  // 黑短发
    body: [[6, 11, 4, 1, INK], [7, 12, 2, 1, INK]],  // 蝶形领结
    tool: [
      [13, 11, 3, 3, RED],   // 红印章
      [13, 10, 3, 1, INK],
      [14, 14, 1, 1, INK],   // 握柄
    ],
  },
  "foundation-reviewer": {  // 后端别名
    face: [
      [9, 5, 1, 1, INK], [10, 5, 1, 1, INK],
      [9, 6, 1, 1, INK], [10, 6, 1, 1, INK],
      [11, 6, 1, 1, INK],
    ],
    hair: [[3, 3, 10, 1, INK], [4, 2, 8, 1, INK]],
    body: [[6, 11, 4, 1, INK], [7, 12, 2, 1, INK]],
    tool: [
      [13, 11, 3, 3, RED],
      [13, 10, 3, 1, INK],
      [14, 14, 1, 1, INK],
    ],
  },

  // ──────────────────────────────── 写作 ───────────────────────────────
  // 规划师:道士古卷帽 + 罗盘十字
  planner: {
    hair: [
      [4, 2, 8, 1], [3, 3, 10, 1],   // 头巾身份色
      [6, 1, 4, 1, INK],             // 帽脊
    ],
    tool: [
      [13, 4, 3, 3, GOLD],
      [14, 5, 1, 1, INK],
      [14, 4, 1, 1, INK], [14, 6, 1, 1, INK],
      [13, 5, 1, 1, INK], [15, 5, 1, 1, INK],
    ],
  },

  // 写手:鸭舌帽 + 大马克笔
  writer: {
    hair: [
      [4, 2, 8, 1], [3, 3, 10, 1],
      [3, 4, 4, 1],                   // 帽檐向前伸
    ],
    tool: [
      [13, 9, 1, 6, INK],             // 笔身
      [13, 8, 1, 1, GOLD],            // 笔帽
      [13, 15, 1, 1, RED],            // 笔尖红
    ],
  },
  composer: {  // 后端别名
    hair: [[4, 2, 8, 1], [3, 3, 10, 1], [3, 4, 4, 1]],
    tool: [[13, 9, 1, 6, INK], [13, 8, 1, 1, GOLD], [13, 15, 1, 1, RED]],
  },

  // 章节分析官:学者方角帽(博士帽)+ 试管
  "chapter-analyst": {
    hair: [
      [4, 2, 8, 1, INK], [3, 3, 10, 1, INK],
      [2, 1, 12, 1, INK],             // 帽顶方板
      [8, 0, 1, 1, GOLD],             // 帽顶流苏
    ],
    tool: [
      [14, 10, 1, 5, INK], [13, 14, 3, 1, INK],   // 试管外壁
      [14, 12, 1, 3],                              // 试管内液(身份色)
      [13, 9, 3, 1, INK],                          // 试管口
    ],
  },
  "chapter-analyzer": {  // 后端别名
    hair: [[4, 2, 8, 1, INK], [3, 3, 10, 1, INK], [2, 1, 12, 1, INK], [8, 0, 1, 1, GOLD]],
    tool: [[14, 10, 1, 5, INK], [13, 14, 3, 1, INK], [14, 12, 1, 3], [13, 9, 3, 1, INK]],
  },

  // ──────────────────────────────── 评审 ───────────────────────────────
  // 审稿官:圆框眼镜 + 大放大镜
  editor: {
    face: [
      [5, 5, 1, 1, INK], [7, 5, 1, 1, INK],
      [8, 5, 1, 1, INK], [10, 5, 1, 1, INK],
      [5, 6, 1, 1, INK], [7, 6, 1, 1, INK],
      [8, 6, 1, 1, INK], [10, 6, 1, 1, INK],
      [6, 6, 1, 1, INK], [9, 6, 1, 1, INK],   // 镜框横梁
      [4, 5, 1, 1, INK], [11, 5, 1, 1, INK],  // 外框
      [4, 6, 1, 1, INK], [11, 6, 1, 1, INK],
    ],
    tool: [
      [13, 9, 1, 1, INK], [14, 9, 1, 1, INK], [15, 9, 1, 1, INK],
      [13, 10, 1, 1, INK], [15, 10, 1, 1, INK],
      [13, 11, 1, 1, INK], [14, 11, 1, 1, INK], [15, 11, 1, 1, INK],
      [14, 10, 1, 1],
      [14, 13, 1, 1, INK], [15, 14, 1, 1, INK], [15, 15, 1, 1, INK],
    ],
  },
  auditor: {  // 后端别名
    face: [
      [5, 5, 1, 1, INK], [7, 5, 1, 1, INK],
      [8, 5, 1, 1, INK], [10, 5, 1, 1, INK],
      [5, 6, 1, 1, INK], [7, 6, 1, 1, INK],
      [8, 6, 1, 1, INK], [10, 6, 1, 1, INK],
      [6, 6, 1, 1, INK], [9, 6, 1, 1, INK],
      [4, 5, 1, 1, INK], [11, 5, 1, 1, INK],
      [4, 6, 1, 1, INK], [11, 6, 1, 1, INK],
    ],
    tool: [
      [13, 9, 1, 1, INK], [14, 9, 1, 1, INK], [15, 9, 1, 1, INK],
      [13, 10, 1, 1, INK], [15, 10, 1, 1, INK],
      [13, 11, 1, 1, INK], [14, 11, 1, 1, INK], [15, 11, 1, 1, INK],
      [14, 10, 1, 1],
      [14, 13, 1, 1, INK], [15, 14, 1, 1, INK], [15, 15, 1, 1, INK],
    ],
  },

  // 读者评审官:心形墨镜 + 爆米花桶
  "reader-critic": {
    face: [
      [4, 5, 3, 2, INK], [9, 5, 3, 2, INK],   // 两块墨镜
      [7, 6, 1, 1, INK],                       // 鼻梁
      [5, 6, 1, 1], [10, 6, 1, 1],             // 镜片反光(身份色)
    ],
    tool: [
      [12, 10, 4, 5, RED],                     // 桶身红
      [12, 9, 4, 1, WHITE], [12, 10, 4, 1, WHITE],  // 顶部白(条纹)
      [13, 8, 1, 1, PAPER], [15, 8, 1, 1, PAPER],   // 爆米花探头
      [14, 9, 1, 1, PAPER],
    ],
  },
  reader: {  // 后端别名
    face: [
      [4, 5, 3, 2, INK], [9, 5, 3, 2, INK],
      [7, 6, 1, 1, INK],
      [5, 6, 1, 1], [10, 6, 1, 1],
    ],
    tool: [
      [12, 10, 4, 5, RED],
      [12, 9, 4, 1, WHITE], [12, 10, 4, 1, WHITE],
      [13, 8, 1, 1, PAPER], [15, 8, 1, 1, PAPER],
      [14, 9, 1, 1, PAPER],
    ],
  },

  // 质量报告官:皇冠 + 奖牌
  "quality-report": {
    hair: [
      [4, 2, 8, 1], [3, 3, 10, 1],
      [3, 1, 1, 1, GOLD], [7, 1, 2, 1, GOLD], [11, 1, 1, 1, GOLD],  // 皇冠三齿
      [4, 2, 1, 1, GOLD], [11, 2, 1, 1, GOLD],
      [5, 1, 1, 1, RED], [11, 1, 1, 1, INK],   // 宝石
    ],
    body: [[7, 13, 2, 2, GOLD]],
    tool: [
      [13, 10, 3, 4, PAPER],
      [14, 11, 1, 1], [14, 13, 1, 1],
    ],
  },
  "quality-reporter": {  // 后端别名
    hair: [
      [4, 2, 8, 1], [3, 3, 10, 1],
      [3, 1, 1, 1, GOLD], [7, 1, 2, 1, GOLD], [11, 1, 1, 1, GOLD],
      [4, 2, 1, 1, GOLD], [11, 2, 1, 1, GOLD],
    ],
    body: [[7, 13, 2, 2, GOLD]],
    tool: [
      [13, 10, 3, 4, PAPER],
      [14, 11, 1, 1], [14, 13, 1, 1],
    ],
  },

  // ────────────────────────────── 修改打磨 ─────────────────────────────
  // 修稿师:红头巾 + 大剪刀
  reviser: {
    hair: [
      [4, 2, 8, 1, RED], [3, 3, 10, 1, RED],
      [3, 4, 1, 2, RED], [12, 4, 1, 2, RED],     // 头巾两边垂下
    ],
    tool: [
      [13, 9, 1, 1, STEEL], [15, 9, 1, 1, STEEL],   // 剪刀双柄
      [13, 10, 1, 1, STEEL], [15, 10, 1, 1, STEEL],
      [14, 11, 1, 1, INK],                            // 螺丝中轴
      [13, 12, 1, 1, STEEL], [15, 12, 1, 1, STEEL],  // 刀刃
      [13, 13, 1, 2, STEEL], [15, 13, 1, 2, STEEL],
      [14, 14, 1, 1, INK],                            // 交叉点
    ],
  },

  // 字数治理官:工程黄帽 + 长尺
  "word-steward": {
    hair: [
      [4, 2, 8, 1, GOLD], [3, 3, 10, 1, GOLD],
      [3, 3, 1, 1, INK], [12, 3, 1, 1, INK],
      [6, 1, 4, 1, INK],
    ],
    tool: [
      [14, 6, 1, 9, PAPER],
      [13, 7, 1, 1, INK], [13, 9, 1, 1, INK],
      [13, 11, 1, 1, INK], [13, 13, 1, 1, INK],
    ],
  },
  "length-normalizer": {  // 后端别名
    hair: [
      [4, 2, 8, 1, GOLD], [3, 3, 10, 1, GOLD],
      [3, 3, 1, 1, INK], [12, 3, 1, 1, INK],
      [6, 1, 4, 1, INK],
    ],
    tool: [
      [14, 6, 1, 9, PAPER],
      [13, 7, 1, 1, INK], [13, 9, 1, 1, INK],
      [13, 11, 1, 1, INK], [13, 13, 1, 1, INK],
    ],
  },

  // 润色师:贝雷帽 + 羽毛笔
  polisher: {
    hair: [
      [4, 2, 8, 1], [3, 3, 10, 1],
      [2, 2, 1, 1], [13, 2, 1, 1],              // 贝雷帽边缘垂
      [8, 1, 2, 1],                              // 帽顶突起
      [9, 0, 1, 1, INK],                         // 帽尖小点
    ],
    tool: [
      [13, 6, 1, 1, GOLD], [14, 7, 1, 1, GOLD], [15, 8, 1, 1, GOLD],   // 羽毛
      [12, 7, 1, 1, GOLD], [13, 8, 1, 1, GOLD], [14, 9, 1, 1, GOLD],
      [11, 8, 1, 1, GOLD], [12, 9, 1, 1, GOLD], [13, 10, 1, 1, GOLD],
      [12, 11, 1, 1, INK], [13, 12, 1, 1, INK], [14, 13, 1, 1, INK],   // 笔杆
      [15, 14, 1, 1, INK],                                              // 笔尖
    ],
  },

  // ────────────────────────────── 运营质保 ─────────────────────────────
  // 状态校验员:警徽帽 + 大对勾
  "state-verifier": {
    hair: [
      [4, 2, 8, 1, INK], [3, 3, 10, 1, INK],
      [2, 4, 12, 1, INK],                        // 帽檐宽
      [7, 1, 2, 2, INK],
      [7, 2, 2, 1, GOLD],                        // 帽徽金
    ],
    body: [[7, 11, 2, 1, GOLD]],                  // 警徽
    tool: [
      [12, 11, 1, 1, GREEN], [13, 12, 1, 1, GREEN],   // 大对勾(绿)
      [14, 11, 1, 1, GREEN], [15, 10, 1, 1, GREEN],
      [15, 9, 1, 1, GREEN], [13, 13, 1, 1, GREEN],
      [14, 12, 1, 1, GREEN],
    ],
  },
  "state-validator": {  // 后端别名
    hair: [
      [4, 2, 8, 1, INK], [3, 3, 10, 1, INK],
      [2, 4, 12, 1, INK],
      [7, 1, 2, 2, INK],
      [7, 2, 2, 1, GOLD],
    ],
    body: [[7, 11, 2, 1, GOLD]],
    tool: [
      [12, 11, 1, 1, GREEN], [13, 12, 1, 1, GREEN],
      [14, 11, 1, 1, GREEN], [15, 10, 1, 1, GREEN],
      [15, 9, 1, 1, GREEN], [13, 13, 1, 1, GREEN],
      [14, 12, 1, 1, GREEN],
    ],
  },

  // 风格指纹官:墨镜 + 留声机喇叭
  "style-fingerprint": {
    face: [
      [4, 5, 8, 2, INK],                          // 一整条墨镜
      [5, 6, 1, 1], [10, 6, 1, 1],                // 镜片反光
    ],
    tool: [
      [13, 10, 3, 1, GOLD],                       // 喇叭顶
      [14, 11, 2, 1, GOLD],
      [15, 12, 1, 1, GOLD],
      [13, 13, 3, 1, INK],                        // 底座
      [14, 14, 1, 1, INK],
    ],
  },
  "style-governor": {  // 后端别名
    face: [[4, 5, 8, 2, INK], [5, 6, 1, 1], [10, 6, 1, 1]],
    tool: [
      [13, 10, 3, 1, GOLD], [14, 11, 2, 1, GOLD], [15, 12, 1, 1, GOLD],
      [13, 13, 3, 1, INK], [14, 14, 1, 1, INK],
    ],
  },

  // 提示词治理官:工程师帽 + 大扳手
  "prompt-steward": {
    hair: [
      [4, 2, 8, 1, STEEL], [3, 3, 10, 1, STEEL],
      [5, 1, 6, 1, STEEL],
      [6, 0, 4, 1, INK],                          // 帽顶黑条纹
    ],
    tool: [
      [13, 8, 1, 2, STEEL],                       // 扳手柄
      [13, 10, 1, 3, STEEL],
      [12, 13, 3, 1, STEEL],                      // 开口扳头
      [12, 14, 1, 1, STEEL], [14, 14, 1, 1, STEEL],
      [13, 14, 1, 1],                              // 内空(身份色)
    ],
  },
  "prompt-governor": {  // 后端别名
    hair: [
      [4, 2, 8, 1, STEEL], [3, 3, 10, 1, STEEL],
      [5, 1, 6, 1, STEEL],
      [6, 0, 4, 1, INK],
    ],
    tool: [
      [13, 8, 1, 2, STEEL], [13, 10, 1, 3, STEEL],
      [12, 13, 3, 1, STEEL],
      [12, 14, 1, 1, STEEL], [14, 14, 1, 1, STEEL],
      [13, 14, 1, 1],
    ],
  },

  // ────────────────────────────── 总编室 ───────────────────────────────
  // 执行主编:西装领带 + 公文包
  "managing-editor": {
    hair: [
      [4, 2, 8, 1, INK], [3, 3, 10, 1, INK],
      [4, 4, 1, 1, INK], [11, 4, 1, 1, INK],       // 鬓角
    ],
    body: [
      [7, 10, 2, 5, RED],                           // 红领带
      [6, 10, 1, 1, INK], [9, 10, 1, 1, INK],       // 领口
    ],
    tool: [
      [12, 12, 4, 3, INK],                          // 公文包身
      [12, 11, 4, 1, INK],
      [13, 10, 2, 1, INK],                          // 提手
      [13, 13, 2, 1, GOLD],                         // 金扣
    ],
  },

  // 总编:绅士礼帽 + 钢笔 + 单片眼镜
  "editor-in-chief": {
    hair: [
      [4, 2, 8, 1, INK], [3, 3, 10, 1, INK],
      [2, 1, 12, 1, INK],                           // 礼帽宽顶
      [3, 0, 10, 1, INK],
      [2, 4, 12, 1, INK],                           // 帽檐
      [4, 3, 8, 1, GOLD],                           // 金色帽带
    ],
    face: [
      [9, 5, 2, 1, INK],                            // monocle 上沿
      [9, 6, 1, 1, INK], [10, 6, 1, 1, INK],        // monocle 圆框
      [9, 7, 2, 1, INK],
      [11, 6, 1, 1, INK],                           // 链
    ],
    body: [
      [7, 10, 2, 1, WHITE], [7, 11, 2, 1, WHITE],   // 白衬衫
      [8, 11, 1, 4, GOLD],                          // 金领带
    ],
    tool: [
      [13, 10, 1, 5, GOLD],                         // 金钢笔
      [13, 15, 1, 1, INK],                          // 笔尖
      [13, 9, 1, 1, INK],                           // 笔帽
    ],
  },
}

// 兜底:身份色齿轮
const DEFAULT_SPEC: AgentSpec = {
  tool: [[13, 5, 1, 1], [12, 6, 3, 1], [13, 7, 1, 1]],
}

// "stroke" 占位标记 — 我们只用 fill 模式;有 "stroke" 的 rect 跳过(占位用)
function isStrokeMarker(c: string | undefined): boolean {
  return c === ("stroke" as unknown as string)
}

export function AgentPixel({
  id,
  size = 28,
  number,
  ariaLabel,
  className,
}: {
  id: string
  size?: number
  number?: number
  ariaLabel?: string
  className?: string
}) {
  const fid = toFrontendAgentId(id)
  const color = agentColor(fid)
  const spec = SPECS[fid] || SPECS[id] || DEFAULT_SPEC
  // 优先用 ImageGen 精致像素头像(public/agent-avatars-imagined);没有头像的角色 fallback 到下方程序画 SVG。
  const avatar = agentAvatar(fid)
  if (avatar) {
    return (
      <span
        className={`agent-avatar${className ? " " + className : ""}`}
        style={{ width: size, height: size }}
        role={ariaLabel ? "img" : undefined}
        aria-label={ariaLabel}
      >
        <img src={avatar} width={size} height={size} alt={ariaLabel ?? ""} loading="lazy" draggable={false} />
        {typeof number === "number" && <span className="agent-avatar-num">{number}</span>}
      </span>
    )
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-label={ariaLabel || fid}
      role="img"
      className={className}
      style={{ color, display: "block" }}
    >
      {/* 圆角底色贴 — 身份色浅化做"工位卡"感 */}
      <rect x={0} y={0} width={16} height={16} rx={3} fill="currentColor" fillOpacity={0.12} />
      {/* 头发 / 帽子(身份色 / agent 自定义) */}
      {spec.hair ? (
        spec.hair.filter(([, , , , c]) => !isStrokeMarker(c)).map(([x, y, w, h, c], i) => (
          <rect key={`hr${i}`} x={x} y={y} width={w} height={h} fill={c || "currentColor"} />
        ))
      ) : (
        <>
          <rect x={4} y={2} width={8} height={1} fill="currentColor" />
          <rect x={3} y={3} width={10} height={1} fill="currentColor" />
        </>
      )}
      {/* 脸(肤色)— 给帽子留出 row 0-3,脸固定 row 4-8 */}
      <rect x={4} y={4} width={8} height={5} fill={SKIN} />
      {/* 默认眼睛 — 如果 spec.face 有覆盖,后面会盖掉 */}
      <rect x={6} y={5} width={1} height={1} fill={INK} />
      <rect x={9} y={5} width={1} height={1} fill={INK} />
      {/* 腮红 */}
      <rect x={5} y={6} width={1} height={1} fill={BLUSH} opacity={0.55} />
      <rect x={10} y={6} width={1} height={1} fill={BLUSH} opacity={0.55} />
      {/* 嘴 */}
      <rect x={7} y={7} width={2} height={1} fill={INK} />
      {/* 颈 */}
      <rect x={7} y={9} width={2} height={1} fill={SKIN} />
      {/* 肩 / 衣身(身份色) */}
      <rect x={5} y={10} width={6} height={1} fill="currentColor" />
      <rect x={4} y={11} width={8} height={1} fill="currentColor" />
      <rect x={3} y={12} width={10} height={3} fill="currentColor" />
      {/* 衣领暗一档 */}
      <rect x={7} y={10} width={2} height={1} fill={INK} fillOpacity={0.18} />
      {/* 脸部叠加(眼镜 / monocle / 墨镜) — 覆盖默认眼睛 */}
      {spec.face?.filter(([, , , , c]) => !isStrokeMarker(c)).map(([x, y, w, h, c], i) => (
        <rect key={`fa${i}`} x={x} y={y} width={w} height={h} fill={c || "currentColor"} />
      ))}
      {/* 身体修饰(领带 / 警徽 / 围巾) */}
      {spec.body?.filter(([, , , , c]) => !isStrokeMarker(c)).map(([x, y, w, h, c], i) => (
        <rect key={`bd${i}`} x={x} y={y} width={w} height={h} fill={c || "currentColor"} />
      ))}
      {/* 职业道具 */}
      {spec.tool.filter(([, , , , c]) => !isStrokeMarker(c)).map(([x, y, w, h, c], i) => (
        <rect key={`tl${i}`} x={x} y={y} width={w} height={h} fill={c || "currentColor"} />
      ))}
      {/* 右下角小编号角标 */}
      {typeof number === "number" && number > 0 && (
        <>
          <rect x={11} y={11} width={5} height={5} rx={1} fill={INK} fillOpacity={0.85} />
          <text x={13.5} y={15} fill="#ffffff" fontSize="4" fontFamily="ui-monospace, Menlo, monospace" textAnchor="middle">{number}</text>
        </>
      )}
    </svg>
  )
}
