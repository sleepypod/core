import { z } from 'zod'
import { householdIdSchema, householdSessionSchema, revisionSchema, type HouseholdSession } from '../contract'
import { arrangementMaintenanceStatusSchema } from '../arrangementMaintenanceContract'
import { arrangementRestartReceiptSchema } from '../arrangementRestartContract'
import { arrangementRecoveryReceiptSchema } from '../arrangementRecoveryContract'
import { arrangementCancellationReceiptSchema } from '../arrangementCancellationContract'
import { identityKey, PersonalWebError } from './protocol'

const instant = z.number().int().positive().max(8_640_000_000_000_000)
export const transitionReplySchema = z.object({
  receipt: z.object({ operationId: householdIdSchema, reviewId: householdIdSchema, state: z.enum(['held', 'committed']),
    admissionRevision: revisionSchema, createdAt: instant, committedAt: instant.nullable(),
    hardware: z.literal('held_for_runtime_recovery') }).strict(),
  recovered: z.boolean(), replayed: z.boolean(),
}).strict()
export const restartReplySchema = z.object({ receipt: arrangementRestartReceiptSchema, replayed: z.boolean() }).strict()
const automaticServices = z.enum(['resumed', 'unavailable', 'unchanged_by_replay'])
export const recoveryReplySchema = z.object({ receipt: arrangementRecoveryReceiptSchema, automaticServices, replayed: z.boolean() }).strict()
export const cancellationReplySchema = z.object({ receipt: arrangementCancellationReceiptSchema, automaticServices, replayed: z.boolean() }).strict()

/** Only maintenance may reacquire revisions after its own transition. Ordinary controls stay strictly pinned. */
export function maintenanceOwner(input: unknown, anchor: HouseholdSession) {
  const current = householdSessionSchema.parse(input)
  if (identityKey(current) !== identityKey(anchor) || current.role !== 'owner' || anchor.role !== 'owner')
    throw new PersonalWebError('account_changed', 'Use the original personal owner connection to finish this transition.')
  return current
}

export function readMaintenanceStatus(input: unknown, session: HouseholdSession, now: number, operationId?: string) {
  const status = arrangementMaintenanceStatusSchema.parse(input)
  const operation = status.operation
  if (status.expectedSessionRevision !== session.sessionRevision || status.expectedAssignmentRevision !== session.assignmentRevision
    || status.observedAt > now || now - status.observedAt > 15_000
    || (operation && (operation.createdAt > status.observedAt || (operationId !== undefined && operation.operationId !== operationId)
      || (operation.state === 'held' || operation.state === 'cancelled' ? operation.committedAt !== null : operation.committedAt === null)
      || (operation.committedAt !== null && (operation.committedAt < operation.createdAt || operation.committedAt > status.observedAt))
      || (operation.state === 'completed') !== (operation.recovery !== null)
      || (operation.state === 'cancelled') !== (operation.cancellation !== null)
      || [operation.recovery, operation.cancellation, operation.restart].some(receipt => receipt !== null && receipt.operationId !== operation.operationId)
      || [operation.recovery, operation.cancellation].some(receipt => receipt !== null && (receipt.reviewId !== operation.reviewId || receipt.completedAt > status.observedAt))
      || (operation.restart && (operation.restart.requestedAt < operation.createdAt || operation.restart.requestedAt > status.observedAt
        || (operation.restart.resultAt !== null && operation.restart.resultAt > status.observedAt))))))
    throw new PersonalWebError('conflict', 'The saved transition changed or could not be verified. Check its current result.')
  return status
}

/** Exactly one optional operation ID is allowed; maintenance never accepts side/account selectors. */
export function maintenancePathAllowed(path: string, method: string, body: unknown) {
  if (method === 'POST') return ['household/transition', 'household/transition/restart', 'household/transition/recover', 'household/transition/cancel'].includes(path)
  if (method !== 'GET' || body !== undefined || path.includes('#')) return false
  const [pathname, search, extra] = path.split('?')
  if (extra !== undefined || !['household/transition', 'household/transition/cancellation-preview'].includes(pathname)) return false
  if (search === undefined) return pathname === 'household/transition'
  const entries = [...new URLSearchParams(search)]
  return entries.length === 1 && entries[0][0] === 'operationId' && householdIdSchema.safeParse(entries[0][1]).success
}
