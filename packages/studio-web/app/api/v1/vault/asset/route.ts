import { backendUnavailable, backendUrl } from "@/lib/api/facade"

export async function GET(req: Request) {
  try {
    const response = await fetch(backendUrl("/api/v1/vault/asset", req), {
      cache: "no-store",
    })
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/octet-stream",
      },
    })
  } catch (error) {
    return backendUnavailable(error)
  }
}
