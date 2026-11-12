import { z } from 'zod'
import { experimentHashSchema } from './contract'

/** Server-derived references permit overnight revalidation without retaining a bearer secret. */
export const experimentPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('legacy'), installationId: z.string().uuid(), credentialRevision: experimentHashSchema }).strict(),
  z.object({ kind: z.literal('personal'), deviceId: z.string().uuid() }).strict(),
])
export type ExperimentPrincipal = z.infer<typeof experimentPrincipalSchema>
