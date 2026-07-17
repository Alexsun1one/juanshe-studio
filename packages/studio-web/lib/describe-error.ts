/**
 * describeFailure — 把操作失败翻成用户能懂的话。
 *
 * 背景:全站 ~30 处 catch 直接 toast 原始 e.message,后端的英文技术语/堆栈
 * 就上屏了("生成失败 (500)"、"fetch failed"...)。统一收口:按 HTTP 状态翻人话,
 * 已是中文的业务文案(409 写作冲突等)原文放行,原始错误仍进 description 供排查。
 *
 * 用法:
 *   toast.error("生成失败", { description: describeFailure(e) })
 */
export function describeFailure(error: unknown): string {
  const status = (error as { status?: number } | null)?.status
  const raw = error instanceof Error ? error.message : String(error ?? "")

  if (status === 401) return "登录已过期,请重新登录"
  if (status === 403) return "没有权限执行这个操作"
  if (status === 404) return "内容不存在或已被删除"
  // 409 的业务文案后端已给中文(写作冲突/门禁拦截等),原文最有信息量
  if (status === 409) return raw
  if (status === 429) return "操作太频繁了,稍等一会再试"
  if (typeof status === "number" && status >= 500) return "服务暂时不可用,请稍后重试"

  // 网络层失败(后端不可达/断网)
  if (/Failed to fetch|NetworkError|Load failed|timed? ?out|ECONNREFUSED/i.test(raw)) {
    return "网络连接失败,检查网络后重试"
  }
  // 已是中文的 message 直接放行
  if (/[一-鿿]/.test(raw)) return raw
  // 无可翻:返回空串,调用方自己给兜底文案(别让英文原文上屏)
  return ""
}

/** 认证/激活场景的报错翻译:后端英文 message 按状态码翻人话,中文原文放行。 */
export function authErrorMessage(res: Response, data: unknown, fallback: string): string {
  const err = (data as { error?: { message?: string } } | null)?.error
  const msg = typeof err?.message === "string" ? err.message : ""
  if (/[一-鿿]/.test(msg)) return msg
  if (res.status === 401 || res.status === 403) return fallback
  if (res.status === 409) return "这个激活码已绑定其他设备或账号,如需换绑请联系支持。"
  if (res.status === 429) return "尝试太频繁了,稍等一会再试。"
  if (res.status >= 500) return "服务暂时不可用,请稍后重试。"
  return msg || fallback
}
