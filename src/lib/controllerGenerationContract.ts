import { z } from 'zod'

export const controllerGenerationInstantSchema = z.number().int().positive().max(8_640_000_000_000_000)
export const controllerInvocationIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
/** Data-only contract; browser receipt validation must not import the Linux reader. */
export const controllerGenerationSchema = z.object({
  version: z.literal(1), invocationId: controllerInvocationIdSchema, bootId: z.uuid(),
  pid: z.number().int().min(2).max(2_147_483_647),
  startTicks: z.string().refine(value => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n),
  observedAt: controllerGenerationInstantSchema,
}).strict()
export type ControllerGeneration = z.infer<typeof controllerGenerationSchema>
