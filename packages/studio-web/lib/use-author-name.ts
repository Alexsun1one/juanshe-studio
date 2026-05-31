"use client"

import * as React from "react"

/**
 * 作者称谓("作者大大"):登录/激活时填写,存 localStorage(cj.authorName)。
 * SSR 安全:默认「作者大大」,挂载后读本地值;监听 storage + 自定义事件以便同标签页改名即时生效。
 * 账号级真身份(SaaS user.authorName)后续接通后改为优先读账号,本地仅作乐观草稿。
 */
const KEY = "cj.authorName"
const FALLBACK = "作者大大"
const EVENT = "cj:author-name"

export function setAuthorName(name: string): void {
  try {
    localStorage.setItem(KEY, name || FALLBACK)
    window.dispatchEvent(new CustomEvent(EVENT))
  } catch {
    /* ignore */
  }
}

export function useAuthorName(): string {
  const [name, setName] = React.useState(FALLBACK)
  React.useEffect(() => {
    const read = () => {
      try {
        setName(localStorage.getItem(KEY) || FALLBACK)
      } catch {
        setName(FALLBACK)
      }
    }
    read()
    window.addEventListener("storage", read)
    window.addEventListener(EVENT, read)
    return () => {
      window.removeEventListener("storage", read)
      window.removeEventListener(EVENT, read)
    }
  }, [])
  return name
}
