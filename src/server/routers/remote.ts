import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { db } from '@/src/db'
import { automations } from '@/src/db/schema'
import { publicProcedure, router } from '@/src/server/trpc'
import { BASE_INPUTS, configSchema, editSchema, sideSchema } from '@/src/remote/model'
import { remoteStore, remoteStatus } from '@/src/remote/runtime'
import { isRemoteConflictError } from '@/src/remote/store'
export const remoteRouter = router({
  mapping: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/remote/mapping', protect: false, tags: ['Remote'] } })
    .input(z.object({}).strict()).output(configSchema)
    .query(() => remoteStore.read()),
  update: publicProcedure
    .input(z.object({ side: sideSchema, revision: z.number().int().nonnegative(), edit: editSchema }).strict())
    .output(configSchema)
    .mutation(({ input }) => {
      if (input.edit.kind === 'remove' && BASE_INPUTS.includes(input.edit.input)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The three single presses cannot be removed' })
      }
      if (input.edit.kind === 'set' && input.edit.binding.action === 'automation.run') {
        if (!db.select({ id: automations.id }).from(automations).where(eq(automations.id, input.edit.binding.automationId)).get()) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose an existing automation' })
        }
      }
      try {
        return remoteStore.edit(input.side, input.revision, input.edit)
      }
      catch (error) {
        if (isRemoteConflictError(error))
          throw new TRPCError({ code: 'CONFLICT', message: error.message })
        throw error
      }
    }),
  status: publicProcedure.input(z.object({}).strict()).query(remoteStatus),
})
