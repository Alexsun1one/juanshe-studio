import { backendUnavailable, backendUrl } from "@/lib/api/facade"

export async function GET(req: Request) {
  try {
    const response = await fetch(backendUrl("/api/v1/vault/file", req), {
      cache: "no-store",
    })
    const text = await response.text()
    return new Response(text, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "text/plain; charset=utf-8",
      },
    })
  } catch (error) {
    return backendUnavailable(error)
  }
}
