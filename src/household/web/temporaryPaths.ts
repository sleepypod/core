import { householdIdSchema } from '../contract'
import { approveTemporaryReviewSchema, cancelTemporaryReviewSchema, temporaryProposalSchema } from '../temporary/contract'

/** Only private review operations are reachable; activation is deliberately absent. */
export function personalTemporaryPath(path: string, method: string, body: unknown) {
  const root = 'household/temporary-arrangement'
  if (path === root) return method === 'GET' ? body === undefined : method === 'POST' && temporaryProposalSchema.safeParse(body).success
  if (path === `${root}/approve`) return method === 'POST' && approveTemporaryReviewSchema.safeParse(body).success
  if (path === `${root}/cancel`) return method === 'POST' && cancelTemporaryReviewSchema.safeParse(body).success
  return method === 'GET' && body === undefined && path.startsWith(`${root}/`)
    && householdIdSchema.safeParse(path.slice(root.length + 1)).success
}
