import { createHash } from 'node:crypto'
import { z } from 'zod'
import { normalizeBedtimeDraft, routineDaySchema, validateBedtimeWeek } from '@/src/lib/bedtimeRoutines'
import { householdContextSchema, householdIdSchema, householdSideSchema, personalWeekSchema, personPreferencesSchema, revisionSchema } from '../contract'
import { HouseholdError } from '../store'

const instant = z.number().int().nonnegative().max(8_640_000_000_000_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const TEMPORARY_REVIEW_LIFETIME_MS = 60 * 60 * 1000
export const MAX_TEMPORARY_ARRANGEMENT_MS = 3 * 24 * 60 * 60 * 1000
const assignment = z.enum(['solo', 'left', 'right', 'unassigned'])
const person = z.object({
  accountId: householdIdSchema, sleeperId: householdIdSchema,
  displayName: z.string().trim().min(1).max(80), role: z.enum(['owner', 'member']),
  sessionRevision: revisionSchema, preferencesRevision: revisionSchema, draftRevision: revisionSchema,
  assignment, operatingWeek: personalWeekSchema, preferences: personPreferencesSchema,
}).strict()

/** Private server snapshot. It is never accepted as client input or returned as a shared plan. */
export const temporarySourceSchema = z.object({
  version: z.literal(1), householdId: householdIdSchema, podId: householdIdSchema,
  householdRevision: revisionSchema, assignmentRevision: revisionSchema,
  effectiveAt: instant, mode: z.enum(['solo-anywhere', 'assigned']), sourceSide: householdSideSchema,
  bedMode: z.enum(['solo-left', 'solo-right', 'two']), unusedZoneMode: z.enum(['follow', 'off']),
  timeZone: z.string().min(1).max(100).refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
      return true
    }
    catch { return false }
  }),
  policyDigest: digest,
  history: z.object({ datasetId: householdIdSchema, epochId: householdIdSchema,
    attributionRevision: revisionSchema, startsAt: instant, epochHash: digest, sourceBindingHash: digest }).strict(),
  people: z.array(person).min(1).max(2),
}).strict().superRefine((source, context) => {
  const owners = source.people.filter(value => value.role === 'owner')
  const unique = (field: 'accountId' | 'sleeperId') => new Set(source.people.map(value => value[field])).size === source.people.length
  const solo = source.mode === 'solo-anywhere'
  const arrangementValid = solo
    ? source.bedMode === `solo-${source.sourceSide}` && source.unusedZoneMode === 'follow'
    && owners[0]?.assignment === 'solo' && source.people.filter(value => value.role !== 'owner').every(value => value.assignment === 'unassigned')
    : source.bedMode === 'two' && source.unusedZoneMode === 'off' && source.people.length === 2
      && new Set(source.people.map(value => value.assignment)).size === 2
      && source.people.every(value => value.assignment === 'left' || value.assignment === 'right')
  if (owners.length !== 1 || !unique('accountId') || !unique('sleeperId') || !arrangementValid)
    context.addIssue({ code: 'custom', message: 'Use one current owner and the actual reviewed bed arrangement.' })
  for (const value of source.people) {
    if (value.assignment === 'unassigned' && value.operatingWeek.length)
      context.addIssue({ code: 'custom', message: 'An unassigned account has no operating physical week.' })
  }
})
export type TemporarySource = z.infer<typeof temporarySourceSchema>

const proposalContext = householdContextSchema.extend({ version: z.literal(1), endsAt: instant })
export const temporaryProposalSchema = z.discriminatedUnion('kind', [
  proposalContext.extend({ kind: z.literal('side_swap') }).strict(),
  proposalContext.extend({ kind: z.literal('guest'), residentSide: householdSideSchema,
    acknowledgeGuestRecordingWithheld: z.literal(true) }).strict(),
])
export type TemporaryProposal = z.infer<typeof temporaryProposalSchema>
const unavailable = () => new HouseholdError('not_ready', 409, 'Prepare a fresh temporary-arrangement review. The bed has not changed.')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function sourceSnapshot(input: unknown): TemporarySource {
  const source = temporarySourceSchema.parse(input)
  source.people.sort((first, second) => first.accountId.localeCompare(second.accountId))
  for (const value of source.people) {
    value.operatingWeek = value.operatingWeek.map(entry => ({ ...entry, draft: normalizeBedtimeDraft(entry.draft) }))
      .sort((first, second) => routineDaySchema.options.indexOf(first.dayOfWeek) - routineDaySchema.options.indexOf(second.dayOfWeek))
    if (value.assignment !== 'unassigned')
      validateBedtimeWeek(value.assignment === 'solo' ? source.sourceSide : value.assignment, value.operatingWeek)
  }
  return source
}
const opposite = (side: 'left' | 'right') => side === 'left' ? 'right' as const : 'left' as const

/** An inert plan preserves private operating weeks; it never edits assignments, schedules or learning. */
export function prepareTemporaryArrangement(sourceInput: unknown, ownerAccountId: string, requestInput: unknown, now: number) {
  const source = sourceSnapshot(sourceInput)
  const request = temporaryProposalSchema.parse(requestInput)
  instant.parse(now)
  const owner = source.people.find(value => value.role === 'owner')
  if (!owner || owner.accountId !== ownerAccountId)
    throw new HouseholdError('forbidden', 403, 'The current owner prepares a temporary-arrangement review.')
  if (request.expectedAssignmentRevision !== source.assignmentRevision || request.expectedSessionRevision !== owner.sessionRevision
    || source.effectiveAt > now || source.history.startsAt >= now || request.endsAt <= now
    || request.endsAt - now > MAX_TEMPORARY_ARRANGEMENT_MS) throw unavailable()
  if (request.kind === 'side_swap' && source.mode !== 'assigned')
    throw new HouseholdError('not_ready', 409, 'A temporary side swap needs two people with reviewed side assignments.')
  const participants = source.people.filter(value => value.assignment !== 'unassigned').map((value) => {
    const proposedSide = request.kind === 'guest'
      ? value.role === 'owner' ? request.residentSide : null
      : opposite(value.assignment as 'left' | 'right')
    return { accountId: value.accountId, sleeperId: value.sleeperId, displayName: value.displayName,
      sessionRevision: value.sessionRevision, assignmentAtReview: value.assignment,
      originalOperatingWeek: structuredClone(value.operatingWeek),
      proposedSide, operatingWeek: proposedSide === null ? [] : structuredClone(value.operatingWeek),
      preferences: structuredClone(value.preferences), approvalRequired: true as const }
  })
  return {
    version: 1 as const, reviewId: request.requestId, ownerAccountId, request, source,
    sourceDigest: hash(source), createdAt: now, expiresAt: Math.min(now + TEMPORARY_REVIEW_LIFETIME_MS, request.endsAt),
    participants, guestSide: request.kind === 'guest' ? opposite(request.residentSide) : null,
    recordingPolicy: request.kind === 'guest' ? 'withhold_personal_records_for_guest_interval' as const : 'reviewed_assignments_after_new_epoch' as const,
    learningPolicy: 'paused_until_reviewed_return' as const,
    sharedActionPolicy: 'quiet_until_reviewed_return' as const,
    returnPolicy: 'fresh_review_never_automatic_reversion' as const,
  }
}
export type TemporaryArrangementPlan = ReturnType<typeof prepareTemporaryArrangement>

/** Rebuild a persisted plan rather than trusting mutable projections or a copied source digest. */
function verifiedPlan(plan: TemporaryArrangementPlan) {
  const rebuilt = prepareTemporaryArrangement(plan.source, plan.ownerAccountId, plan.request, plan.createdAt)
  if (hash(rebuilt) !== hash(plan)) throw unavailable()
  return rebuilt
}

export function temporaryPlanCurrent(plan: TemporaryArrangementPlan, sourceInput: unknown, now: number) {
  try {
    const saved = verifiedPlan(plan)
    return instant.safeParse(now).success && now >= saved.createdAt && now < saved.expiresAt
      && saved.sourceDigest === hash(sourceSnapshot(sourceInput))
  }
  catch { return false }
}

/** Only the caller's routine/preferences leave this boundary. A prepared invitation is not a sleeper. */
export function projectTemporaryArrangement(plan: TemporaryArrangementPlan, accountId: string, sourceInput: unknown, now: number) {
  const saved = verifiedPlan(plan)
  const self = saved.participants.find(value => value.accountId === accountId)
  if (!self) throw new HouseholdError('forbidden', 403, 'This account is not a participant in the temporary arrangement.')
  // Check the current account too; a historical participant loses access after revocation/removal.
  const currentSource = sourceSnapshot(sourceInput)
  const current = currentSource.people.find(value => value.accountId === accountId)
  if (currentSource.householdId !== saved.source.householdId || currentSource.podId !== saved.source.podId
    || !current || current.sleeperId !== self.sleeperId || current.sessionRevision !== self.sessionRevision)
    throw new HouseholdError('forbidden', 403, 'Reload the current personal account before reading this review.')
  return {
    version: 1 as const, reviewId: saved.reviewId, kind: saved.request.kind,
    householdId: saved.source.householdId, podId: saved.source.podId, sleeperId: self.sleeperId,
    assignmentRevision: saved.source.assignmentRevision, timeZone: saved.source.timeZone,
    createdAt: saved.createdAt, reviewExpiresAt: saved.expiresAt, intendedEnd: saved.request.endsAt,
    state: temporaryPlanCurrent(saved, sourceInput, now) ? 'review_only' as const : 'stale' as const,
    self: { displayName: self.displayName, assignmentAtReview: self.assignmentAtReview, proposedSide: self.proposedSide,
      originalOperatingWeek: structuredClone(self.originalOperatingWeek),
      operatingWeek: structuredClone(self.operatingWeek), preferences: structuredClone(self.preferences), approvalRequired: self.approvalRequired },
    others: saved.participants.filter(value => value.accountId !== accountId).map(value => ({
      displayName: value.displayName, proposedSide: value.proposedSide, approvalRequired: value.approvalRequired,
    })),
    guestSide: saved.guestSide, recordingPolicy: saved.recordingPolicy,
    learningPolicy: saved.learningPolicy, sharedActionPolicy: saved.sharedActionPolicy, returnPolicy: saved.returnPolicy,
    canActivate: false as const, effect: 'review_only_bed_unchanged' as const,
  }
}
