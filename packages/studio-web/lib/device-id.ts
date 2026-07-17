/** 设备指纹:SaaS 激活码绑设备用。localStorage 持久化,首次访问生成。 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem("cj.deviceId")
    if (!id) {
      const rnd =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `dev-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
      id = rnd
      localStorage.setItem("cj.deviceId", id)
    }
    return id
  } catch {
    return "unknown-device"
  }
}
