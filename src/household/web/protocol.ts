import { z } from 'zod'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { householdIdSchema, householdSessionSchema, type HouseholdSession } from '../contract'
import { personalBedSchema, type PersonalBed } from '../bedContract'
import { personalControlReceiptSchema, personalControlRequestSchema, type PersonalControlReceipt, type PersonalControlRequest } from '../controlContract'
import { personalRoutineReceiptSchema, personalRoutineReviewSchema, type PersonalRoutinePublish, type PersonalRoutineReceipt, type PersonalRoutineReview } from '../routineContract'
import { arrangementReviewSchema } from '../arrangementContract'
import { normalizeBedtimeDraft } from '@/src/lib/bedtimeRoutines'
export const identifier = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export const digest = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
export const identity = (session: HouseholdSession) => [session.podId, session.householdId, session.accountId, session.selfSleeperId]
export const identityKey = (session: HouseholdSession) => identity(session).join(':')
export const contextKey = (session: HouseholdSession) => JSON.stringify([identity(session), session.sessionRevision,
  session.assignmentRevision, session.arrangement, session.self.assignment, session.self.zones])
export function samePersonSession(input: unknown, anchor: HouseholdSession) {
  const current = householdSessionSchema.parse(input)
  if (contextKey(current) !== contextKey(anchor))
    throw new PersonalWebError('account_changed', 'Your account or bed assignment changed. Reconnect to review it.')
  return current
}
export class PersonalWebError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PersonalWebError'
  }
}
export const sameZones = (first: string[], second: string[]) => first.length === new Set(first).size
  && second.length === new Set(second).size && JSON.stringify([...first].sort()) === JSON.stringify([...second].sort())
export function scopeMatches(scope: PersonalBed['scope'], session: HouseholdSession) {
  return scope.podId === session.podId && scope.householdId === session.householdId && scope.sleeperId === session.selfSleeperId
    && scope.sessionRevision === session.sessionRevision && scope.assignmentRevision === session.assignmentRevision
}
/** Validate routing as well as JSON shape before displaying or commanding a zone. */
export function readPersonalBed(input: unknown, session: HouseholdSession) {
  const bed = personalBedSchema.parse(input)
  if (!scopeMatches(bed.scope, session) || bed.arrangement !== session.arrangement.mode)
    throw new PersonalWebError('account_changed', 'The bed response belongs to a different account or assignment.')
  const expected = session.self.assignment === 'solo'
    ? ['left', 'right']
    : session.self.assignment === 'unassigned' ? [] : [session.self.assignment]
  const allowed = bed.availability === 'ready' ? expected : []
  if (!sameZones(session.self.zones, expected) || (bed.availability === 'ready' && (!session.capabilities.personalControls || !expected.length))
    || !sameZones(bed.zones.map(zone => zone.side), allowed)
    || ![bed.routing.temperature, bed.routing.power, bed.routing.vibrationCancellation].every(zones => sameZones(zones, allowed))
    || (bed.availability === 'ready'
      ? !allowed.includes(bed.routing.routines ?? '') || !sameZones(bed.routing.scheduledVibration, [bed.routing.routines ?? ''])
      : bed.routing.routines !== null || bed.routing.scheduledVibration.length !== 0))
    throw new PersonalWebError('invalid', 'The controller returned inconsistent personal bed routing.')
  if (bed.observation.state === 'unavailable' && (bed.observation.observedAt !== null || bed.observation.water !== 'unknown'
    || bed.observation.priming !== null || bed.zones.some(zone => zone.measuredTemperatureF !== null || zone.reportedTargetF !== null || zone.reportedPowered !== null)))
    throw new PersonalWebError('invalid', 'Unavailable measurements were not cleared.')
  if (bed.observation.state === 'fresh' && bed.observation.observedAt === null)
    throw new PersonalWebError('invalid', 'The reading has no observation time.')
  return bed
}
/** A review may contain only the current person's operational zones and week. */
export function readRoutineReview(input: unknown, session: HouseholdSession) {
  const review = personalRoutineReviewSchema.parse(input)
  const zones = session.self.assignment === 'solo'
    ? ['left', 'right']
    : session.self.assignment === 'unassigned' ? [] : [session.self.assignment]
  if (!scopeMatches(review.scope, session) || !sameZones(review.temperatureZones, zones)
    || !zones.includes(review.sourceSide)
    || [review.liveWeek, review.draftWeek, review.changes].some(week => new Set(week.map(night => night.dayOfWeek)).size !== week.length)
    || review.canPublish !== (review.reason === 'ready'))
    throw new PersonalWebError('invalid', 'The routine comparison is inconsistent with your personal bed assignment.')
  return review
}

/** A shared proposal exposes the caller's private week and only partner readiness. */
export function readArrangementReview(input: unknown, session: HouseholdSession) {
  const review = arrangementReviewSchema.parse(input)
  const owner = session.role === 'owner'
  if (review.householdId !== session.householdId || review.podId !== session.podId || review.sleeperId !== session.selfSleeperId
    || review.assignmentRevision !== session.assignmentRevision
    || review.self.proposedSide === review.partner.proposedSide
    || review.self.assignmentAtReview !== (owner ? 'solo' : 'unassigned')
    || review.self.routineSource !== (owner ? 'preserved_operating_week' : 'own_private_draft')
    || new Set(review.self.week.map(night => night.dayOfWeek)).size !== review.self.week.length
    || review.expiresAt <= review.createdAt
    || (review.canApprove && (review.state !== 'awaiting_approval' || review.self.approved))
    || (review.state === 'approved_for_separate_activation' && (!review.self.approved || !review.partner.approved)))
    throw new PersonalWebError('invalid', 'The side review is inconsistent with your personal account.')
  return review
}

export const recoveryReferenceSchema = z.object({
  version: z.literal(1), requestId: householdIdSchema, identity: z.array(householdIdSchema).length(4),
  identityKey: z.string(), kind: z.enum(['control', 'publication']), expiresAt: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.identity.join(':') === value.identityKey, 'Recovery identity is inconsistent.')
export type RecoveryReference = z.infer<typeof recoveryReferenceSchema>
const controlFingerprint = (request: PersonalControlRequest, zones: string[]) => digest({ request: personalControlRequestSchema.parse(request), zones: [...zones].sort() })
const publicationFingerprint = (requestId: string, scope: PersonalBed['scope'], reviewRevision: string, draftRevision: number, sourceSide: string, week: PersonalRoutineReview['draftWeek']) => digest({ requestId, scope, reviewRevision, draftRevision, sourceSide,
  week: [...week].map(entry => ({ dayOfWeek: entry.dayOfWeek, draft: normalizeBedtimeDraft(entry.draft) })).sort((first, second) => first.dayOfWeek < second.dayOfWeek ? -1 : first.dayOfWeek > second.dayOfWeek ? 1 : 0) })
export function controlReference(session: HouseholdSession, request: PersonalControlRequest, zones: string[]): RecoveryReference {
  return recoveryReferenceSchema.parse({ version: 1, requestId: request.requestId, identity: identity(session), identityKey: identityKey(session),
    kind: 'control', expiresAt: request.expiresAt, fingerprint: controlFingerprint(request, zones) })
}
export function publicationReference(session: HouseholdSession, request: PersonalRoutinePublish, review: PersonalRoutineReview): RecoveryReference {
  return recoveryReferenceSchema.parse({ version: 1, requestId: request.requestId, identity: identity(session), identityKey: identityKey(session),
    kind: 'publication', expiresAt: request.expiresAt,
    fingerprint: publicationFingerprint(request.requestId, request.scope, request.reviewRevision, review.draftRevision, review.sourceSide, review.draftWeek) })
}
/** References retain no credential, temperature, routine or private receipt body. */
export function readOwnReceipt(input: unknown, reference: RecoveryReference, session: HouseholdSession): PersonalControlReceipt | PersonalRoutineReceipt {
  if (reference.identityKey !== identityKey(session))
    throw new PersonalWebError('account_changed', 'This recovery reference belongs to another account.')
  if (reference.kind === 'control') {
    const receipt = personalControlReceiptSchema.parse(input)
    const request = personalControlRequestSchema.parse({ version: 1, requestId: receipt.requestId, scope: receipt.scope,
      issuedAt: receipt.issuedAt, expiresAt: receipt.expiresAt, action: receipt.action })
    if (receipt.requestId !== reference.requestId || receipt.expiresAt !== reference.expiresAt
      || controlFingerprint(request, receipt.resolvedZones) !== reference.fingerprint
      || (receipt.state === 'acknowledged' && (!receipt.dispatchCount || receipt.lastDispatchAt === null || receipt.finishedAt === null))
      || (['expired', 'rejected', 'not_dispatched'].includes(receipt.state) && (receipt.dispatchCount !== 0 || receipt.lastDispatchAt !== null)))
      throw new PersonalWebError('invalid', 'The receipt does not match the saved command reference.')
    return receipt
  }
  const receipt = personalRoutineReceiptSchema.parse(input)
  if (receipt.requestId !== reference.requestId || publicationFingerprint(receipt.requestId, receipt.scope, receipt.reviewRevision, receipt.draftRevision, receipt.sourceSide, receipt.publishedWeek) !== reference.fingerprint)
    throw new PersonalWebError('invalid', 'The receipt does not match the reviewed schedule.')
  return receipt
}
export function receiptResolved(receipt: PersonalControlReceipt | PersonalRoutineReceipt) {
  return receipt.state === 'saved' ? receipt.scheduler === 'refreshed' : !['unknown', 'executing'].includes(receipt.state)
}
