// ============================================================================
// Route Handler 工具：Next.js App Router 的 server-side 帮助函数
// 后端接管时可在此处统一改成代理到真实后端：fetch(BACKEND_URL+path)
// ============================================================================

import { NextResponse } from "next/server"

export function jsonOK<T>(data: T): NextResponse {
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "no-store",
    },
  })
}

export function jsonErr(
  code: string,
  message: string,
  status = 400,
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status })
}

/** 统一的人为延迟（仅 mock 阶段使用，模拟真实远端） */
export function delay(min = 60, max = 180): Promise<void> {
  return new Promise((r) =>
    setTimeout(r, Math.floor(min + Math.random() * (max - min))),
  )
}
