import { z } from 'zod'
import { capabilitiesSchema } from '@/src/capabilities/contract'
import { readCapabilities } from '@/src/capabilities/read'
import { publicProcedure, router } from '../trpc'

export const capabilitiesRouter = router({
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/capabilities', tags: ['System'] } })
    .input(z.object({}))
    .output(capabilitiesSchema)
    .query(() => readCapabilities()),
})
