import { proxySSEOrFallback } from "@/lib/api/facade"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  return proxySSEOrFallback(
    req,
    `/api/v1/books/${encodeURIComponent(id)}/agents/events/stream`,
    () => heartbeatStream(req, id),
  )
}

function heartbeatStream(request: Request, bookId: string) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        )
      }

      send({ type: "ping", ts: new Date().toISOString(), bookId })

      const interval = setInterval(() => {
        send({ type: "ping", ts: new Date().toISOString(), bookId })
      }, 15000)

      const close = () => {
        clearInterval(interval)
        controller.close()
      }

      request.signal.addEventListener("abort", close, { once: true })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
