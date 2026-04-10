import { z } from 'zod'
import { publicProcedure, router } from '@/src/server/trpc'

export const miniRouter = router({
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/mini/status', protect: false, tags: ['Mini'] } })
    .input(z.object({}))
    .output(z.object({
      enabled: z.boolean(),
    }))
    .query(() => ({ enabled: true })),
})
