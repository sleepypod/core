import { z } from 'zod'

const failure = z.object({ error: z.object({ code: z.enum(['invalid_request', 'conflict', 'not_found', 'not_ready']),
  message: z.string().min(1).max(2000) }).strict() }).strict()
export class ExperimentBrowserProblem extends Error {}
export function experimentBrowserProblem(input: unknown) {
  const parsed = failure.safeParse(input)
  return parsed.success ? new ExperimentBrowserProblem(parsed.data.error.message) : new Error('The comparison request failed.')
}
