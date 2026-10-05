import type { AppRouter } from '@/src/server/routers/app'
import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { createBaseSimulator } from './baseSimulator'

/** Base-only simulator. Unknown base calls fail closed; other routers pass through. */
export function baseDebugLink(): TRPCLink<AppRouter> {
  const simulator = createBaseSimulator()
  return () => ({ op, next }) => {
    if (!op.path.startsWith('base.')) return next(op)
    return observable((observer) => {
      try {
        const procedure = op.path.slice('base.'.length)
        if (!Object.hasOwn(simulator, procedure)) throw new Error(`Not available in base debug (${op.path})`)
        const handler = simulator[procedure as keyof typeof simulator] as (input: unknown) => unknown
        observer.next({ result: { type: 'data', data: handler(op.input) } })
        observer.complete()
      }
      catch (error) {
        observer.error(TRPCClientError.from(error instanceof Error ? error : new Error(String(error))))
      }
    })
  }
}
