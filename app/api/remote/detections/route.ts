import { remoteStatus, subscribeRemote } from '@/src/remote/runtime'
import { onServerFrame } from '@/src/streaming/piezoStream'
import { isRemoteEvidence } from '@/src/remote/capture'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Stream live detections and heartbeat status, disconnecting slow readers and cleaning up on abort. */
export function GET(request: Request) {
  const encoder = new TextEncoder()

  let cleanup = () => {

  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => {
        // A slow diagnostic client must not accumulate an unbounded event queue.
        if (controller.desiredSize === null) return
        if ((controller.desiredSize ?? 0) <= 0) {
          cleanup()
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      const unsubscribe = subscribeRemote(send)
      const unsubscribeRaw = new URL(request.url).searchParams.get('raw') === '1'
        ? onServerFrame((record) => {
            if (!isRemoteEvidence(record)) return
            const receivedAt = Date.now()
            const bytes = encoder.encode(JSON.stringify(record)).length
            send(bytes <= 16384
              ? { type: 'raw', receivedAt, record }
              : { type: 'raw_omitted', receivedAt, reason: 'Record exceeds 16 KiB', bytes })
          })
        : () => {}

      const heartbeat = setInterval(() => {
        send({ type: 'status', ...remoteStatus() })
      }, 15000)

      cleanup = () => {
        unsubscribe()
        unsubscribeRaw()

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
  }, { highWaterMark: 16 })

  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' } })
}
