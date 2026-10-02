import type { AppRouter } from '@/src/server/routers/app'
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server'

export type RouterInputs = inferRouterInputs<AppRouter>
export type RouterOutputs = inferRouterOutputs<AppRouter>

type Routers = keyof RouterOutputs & keyof RouterInputs

/**
 * Fake implementations for one tRPC router. Typed against the real router's
 * inferred input/output, so a shape change on the server fails `tsc` here.
 */
export type DemoHandlers<R extends Routers> = {
  [P in keyof RouterOutputs[R]]?: (
    input: P extends keyof RouterInputs[R] ? RouterInputs[R][P] : never,
  ) => RouterOutputs[R][P] | Promise<RouterOutputs[R][P]>
}
