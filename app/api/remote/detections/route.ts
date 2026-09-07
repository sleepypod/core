import { remoteStatus, subscribeRemote } from '@/src/remote/runtime'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export function GET(request: Request) {
  const encoder = new TextEncoder()

  let cleanup = () => {

  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))

      const unsubscribe = subscribeRemote(send)

      const heartbeat = setInterval(() => {
        try {
          send({ type: 'status', ...remoteStatus() })
        }
        catch {
          cleanup()
        }
      }, 15000)

      cleanup = () => {
        unsubscribe()

        clearInterval(heartbeat)

        request.signal.removeEventListener('abort', abort)
      }

      const abort = () => {
        cleanup()

        try {
          controller.close()
        }
        catch {
          /* already closed */
        }
      }

      request.signal.addEventListener('abort', abort, { once: true })

      if (request.signal.aborted) {
        abort()

        return
      }

      send({ type: 'status', ...remoteStatus() })
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' } })
}
