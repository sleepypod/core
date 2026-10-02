import type { AppRouter } from '@/src/server/routers/app'
import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'

// Enough latency that loading states flash the way they do against a real pod.
const LATENCY_MS = { query: 120, mutation: 250 } as const

// Gated on the build-time flag so non-demo builds drop the handlers entirely.
const loadHandlers = () => process.env.NEXT_PUBLIC_DEMO === '1'
  ? import('./handlers')
  : Promise.reject(new Error('Demo mode is disabled'))

/**
 * tRPC link that answers every call from in-browser demo handlers instead of
 * the pod. Handlers load lazily so the fake data never ships in the main chunk.
 */
export function demoLink(): TRPCLink<AppRouter> {
  return () => ({ op }) => observable((observer) => {
    let cancelled = false

    void (async () => {
      try {
        const { resolveDemoCall } = await loadHandlers()
        await new Promise(r => setTimeout(r, op.type === 'mutation' ? LATENCY_MS.mutation : LATENCY_MS.query))
        const data = await resolveDemoCall(op.path, op.input)
        if (cancelled) return
        observer.next({ result: { type: 'data', data } })
        observer.complete()
      }
      catch (err) {
        if (!cancelled) observer.error(TRPCClientError.from(err instanceof Error ? err : new Error(String(err))))
      }
    })()

    return () => {
      cancelled = true
    }
  })
}
