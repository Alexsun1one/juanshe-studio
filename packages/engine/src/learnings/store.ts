/**
 * 卷舍 · 经验库持久化(注入接口,副作用唯一出口;仿 driver.persist)
 * 引擎核心不碰 fs;studio 侧提供 FileLearningStore 落 <workspace>/.autow/learnings.json(跨书共享)。
 */
import type { PatternLibrary } from "./types.js"

export interface LearningStore {
  load(): Promise<PatternLibrary>
  save(lib: PatternLibrary): Promise<void>
}

export interface LearningDeps {
  readonly store: LearningStore
  readonly now: () => string // ISO
  readonly newId: () => string
  /** 可选向量;缺省走 lexical 相似度,不强依赖向量服务 */
  readonly embed?: (text: string) => Promise<number[]>
}

export function emptyLibrary(now: string): PatternLibrary {
  return { version: 1, updatedAt: now, learnings: [], index: {} }
}

export class InMemoryLearningStore implements LearningStore {
  private lib: PatternLibrary
  constructor(seed?: PatternLibrary) {
    this.lib = seed ?? emptyLibrary("")
  }
  async load(): Promise<PatternLibrary> {
    return this.lib
  }
  async save(lib: PatternLibrary): Promise<void> {
    this.lib = lib
  }
}

export const bucketKey = (genreId: string, platformId: string): string => `${genreId}::${platformId}`
