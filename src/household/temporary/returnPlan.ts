import { createHash } from 'node:crypto'
import { z } from 'zod'
import { normalizeBedtimeDraft, routineDaySchema, validateBedtimeWeek } from '@/src/lib/bedtimeRoutines'
import { householdIdSchema, householdSideSchema, personalWeekSchema, personPreferencesSchema, revisionSchema } from '../contract'
import { HouseholdError } from '../store'
import { TEMPORARY_REVIEW_LIFETIME_MS, verifiedTemporaryPlan, type TemporaryArrangementPlan } from './plan'

const instant = z.number().int().nonnegative().max(8_640_000_000_000_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const timeZone = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
    return true
  }
  catch { return false }
})
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reject = () => new HouseholdError('not_ready', 409, 'Review the current temporary arrangement before preparing a return. The bed has not changed.')

/** Server-only input from a future committed transition, never a client assertion of activation. */
export const temporaryIntervalReceiptSchema = z.object({
  version: z.literal(1), operationId: householdIdSchema, reviewId: householdIdSchema,
  householdId: householdIdSchema, podId: householdIdSchema, sourceDigest: digest,
  committedAt: instant, assignmentRevision: revisionSchema, intervalRevision: revisionSchema,
}).strict()
export type TemporaryIntervalReceipt = z.infer<typeof temporaryIntervalReceiptSchema>

/** The eventual return coordinator must read this snapshot inside its own configuration transaction. */
export const temporaryReturnSourceSchema = z.object({
  version: z.literal(1), householdId: householdIdSchema, podId: householdIdSchema,
  operationId: householdIdSchema, intervalRevision: revisionSchema,
  householdRevision: revisionSchema, assignmentRevision: revisionSchema,
  activatedAt: instant, timeZone, policyDigest: digest,
  history: z.object({ datasetId: householdIdSchema, attributionRevision: revisionSchema,
    sourceBindingHash: digest, processingHash: digest,
    mode: z.enum(['guest_withheld', 'assigned']), epochId: householdIdSchema.nullable(),
  }).strict(),
  people: z.array(z.object({
    accountId: householdIdSchema, sleeperId: householdIdSchema,
    displayName: z.string().trim().min(1).max(80), role: z.enum(['owner', 'member']),
    sessionRevision: revisionSchema, preferencesRevision: revisionSchema, draftRevision: revisionSchema,
    currentSide: householdSideSchema.nullable(), operatingWeek: personalWeekSchema,
    preferences: personPreferencesSchema,
  }).strict()).min(1).max(2),
}).strict().superRefine((source, context) => {
  const residents = source.people.filter(person => person.currentSide !== null)
  const unique = (field: 'accountId' | 'sleeperId') => new Set(source.people.map(person => person[field])).size === source.people.length
  if (source.people.filter(person => person.role === 'owner').length !== 1 || !unique('accountId') || !unique('sleeperId')
    || new Set(residents.map(person => person.currentSide)).size !== residents.length
    || source.people.some(person => person.currentSide === null && person.operatingWeek.length > 0)
    || (source.history.mode === 'guest_withheld'
      ? source.history.epochId !== null || residents.length !== 1
      : source.history.epochId === null || residents.length !== 2)) {
    context.addIssue({ code: 'custom', message: 'Use the actual temporary residents and the current recording boundary.' })
  }
})
export type TemporaryReturnSource = z.infer<typeof temporaryReturnSourceSchema>

export const temporaryReturnRequestSchema = z.object({
  version: z.literal(1), requestId: householdIdSchema, operationId: householdIdSchema,
  expectedSessionRevision: revisionSchema, expectedAssignmentRevision: revisionSchema,
  expectedIntervalRevision: revisionSchema,
  acknowledgeNewerRoutinesPreserved: z.literal(true), acknowledgeSeparateActivation: z.literal(true),
}).strict()

function canonicalSource(input: unknown) {
  const source = temporaryReturnSourceSchema.parse(input)
  source.people.sort((first, second) => first.accountId.localeCompare(second.accountId))
  for (const person of source.people) {
    person.operatingWeek = person.operatingWeek.map(entry => ({ ...entry, draft: normalizeBedtimeDraft(entry.draft) }))
      .sort((first, second) => routineDaySchema.options.indexOf(first.dayOfWeek) - routineDaySchema.options.indexOf(second.dayOfWeek))
    if (person.currentSide !== null) validateBedtimeWeek(person.currentSide, person.operatingWeek)
  }
  return source
}

/** Restore ownership through a fresh review while carrying newer resident routines with their person. */
export function prepareTemporaryReturn(entryInput: TemporaryArrangementPlan, receiptInput: unknown,
  sourceInput: unknown, ownerAccountId: string, requestInput: unknown, now: number) {
  const entry = verifiedTemporaryPlan(entryInput)
  const receipt = temporaryIntervalReceiptSchema.parse(receiptInput)
  const source = canonicalSource(sourceInput)
  const request = temporaryReturnRequestSchema.parse(requestInput)
  instant.parse(now)
  const owner = source.people.find(person => person.role === 'owner')
  if (ownerAccountId !== entry.ownerAccountId || owner?.accountId !== ownerAccountId)
    throw new HouseholdError('forbidden', 403, 'The current household owner prepares a return review.')
  if (receipt.householdId !== entry.source.householdId || receipt.podId !== entry.source.podId
    || receipt.reviewId !== entry.reviewId || receipt.sourceDigest !== entry.sourceDigest
    || receipt.committedAt < entry.createdAt || receipt.committedAt >= entry.expiresAt
    || receipt.assignmentRevision !== entry.source.assignmentRevision + 1
    || source.householdId !== receipt.householdId || source.podId !== receipt.podId
    || source.operationId !== receipt.operationId || source.activatedAt !== receipt.committedAt
    || source.activatedAt >= now || source.assignmentRevision !== receipt.assignmentRevision
    || source.intervalRevision !== receipt.intervalRevision
    || source.householdRevision <= entry.source.householdRevision
    || source.history.datasetId !== entry.source.history.datasetId
    || source.history.sourceBindingHash !== entry.source.history.sourceBindingHash
    || source.history.attributionRevision <= entry.source.history.attributionRevision
    || source.history.mode !== (entry.request.kind === 'guest' ? 'guest_withheld' : 'assigned')
    || source.history.epochId === entry.source.history.epochId
    || request.operationId !== receipt.operationId || request.expectedIntervalRevision !== source.intervalRevision
    || request.expectedAssignmentRevision !== source.assignmentRevision || request.expectedSessionRevision !== owner.sessionRevision
    || source.people.length !== entry.participants.length) throw reject()

  const participants = source.people.map((person) => {
    const original = entry.participants.find(value => value.accountId === person.accountId && value.sleeperId === person.sleeperId)
    const originalPerson = entry.source.people.find(value => value.accountId === person.accountId)
    if (!original || !originalPerson || originalPerson.role !== person.role || original.proposedSide !== person.currentSide
      || person.sessionRevision <= original.sessionRevision || person.preferencesRevision < originalPerson.preferencesRevision
      || person.draftRevision < originalPerson.draftRevision) throw reject()
    const returnSide = original.assignmentAtReview === 'solo' ? entry.source.sourceSide : original.assignmentAtReview
    if (returnSide !== 'left' && returnSide !== 'right') throw reject()
    const routineSource = person.currentSide === null ? 'preserved_absent_person_week' as const : 'current_person_week' as const
    const week = structuredClone(person.currentSide === null ? original.originalOperatingWeek : person.operatingWeek)
    validateBedtimeWeek(returnSide, week)
    return { accountId: person.accountId, sleeperId: person.sleeperId, displayName: person.displayName,
      sessionRevision: person.sessionRevision, currentSide: person.currentSide, returnSide,
      returnAssignment: original.assignmentAtReview, operatingWeek: week, routineSource,
      differsFromBeforeVisit: hash(week) !== hash(original.originalOperatingWeek),
      preferences: structuredClone(person.preferences), approvalRequired: true as const }
  })
  return {
    version: 1 as const, reviewId: request.requestId, ownerAccountId, request, entry, receipt, source,
    sourceDigest: hash(source), createdAt: now, expiresAt: instant.parse(now + TEMPORARY_REVIEW_LIFETIME_MS),
    intendedEndPassed: now >= entry.request.endsAt, participants,
    returnArrangement: { mode: entry.source.mode, sourceSide: entry.source.sourceSide,
      bedMode: entry.source.bedMode, unusedZoneMode: entry.source.unusedZoneMode },
    recordingPolicy: 'new_reviewed_epoch_after_return' as const,
    learningPolicy: 'remain_paused_pending_separate_qualification' as const,
    sharedActionPolicy: 'retain_each_person_quiet_request' as const,
    returnPolicy: 'fresh_review_never_automatic_reversion' as const,
  }
}
export type TemporaryReturnPlan = ReturnType<typeof prepareTemporaryReturn>

function verifiedReturn(plan: TemporaryReturnPlan) {
  const rebuilt = prepareTemporaryReturn(plan.entry, plan.receipt, plan.source, plan.ownerAccountId, plan.request, plan.createdAt)
  if (hash(rebuilt) !== hash(plan)) throw reject()
  return rebuilt
}

export function temporaryReturnCurrent(plan: TemporaryReturnPlan, sourceInput: unknown, now: number) {
  try {
    const saved = verifiedReturn(plan)
    return instant.safeParse(now).success && now >= saved.createdAt && now < saved.expiresAt
      && saved.sourceDigest === hash(canonicalSource(sourceInput))
  }
  catch { return false }
}

/** A returning partner can review their own preserved week; another person's edits never leave the server. */
export function projectTemporaryReturn(plan: TemporaryReturnPlan, accountId: string, sourceInput: unknown, now: number) {
  const saved = verifiedReturn(plan), source = canonicalSource(sourceInput)
  const self = saved.participants.find(person => person.accountId === accountId)
  const current = source.people.find(person => person.accountId === accountId)
  if (!self || !current || source.householdId !== saved.source.householdId || source.podId !== saved.source.podId
    || current.sleeperId !== self.sleeperId || current.sessionRevision !== self.sessionRevision) {
    throw new HouseholdError('forbidden', 403, 'Reload the current personal account before reading this return review.')
  }
  return {
    version: 1 as const, reviewId: saved.reviewId, operationId: saved.receipt.operationId,
    householdId: saved.source.householdId, podId: saved.source.podId, sleeperId: self.sleeperId,
    assignmentRevision: saved.source.assignmentRevision, intervalRevision: saved.source.intervalRevision,
    createdAt: saved.createdAt, reviewExpiresAt: saved.expiresAt, timeZone: saved.source.timeZone,
    state: temporaryReturnCurrent(saved, sourceInput, now) ? 'review_only' as const : 'stale' as const,
    intendedEndPassed: saved.intendedEndPassed, returnArrangement: structuredClone(saved.returnArrangement),
    self: { displayName: self.displayName, currentSide: self.currentSide, returnSide: self.returnSide,
      returnAssignment: self.returnAssignment, operatingWeek: structuredClone(self.operatingWeek),
      routineSource: self.routineSource, differsFromBeforeVisit: self.differsFromBeforeVisit,
      preferences: structuredClone(self.preferences), approvalRequired: true as const },
    others: saved.participants.filter(person => person.accountId !== accountId).map(person => ({
      displayName: person.displayName, currentSide: person.currentSide, returnSide: person.returnSide, approvalRequired: true as const,
    })),
    recordingPolicy: saved.recordingPolicy, learningPolicy: saved.learningPolicy,
    sharedActionPolicy: saved.sharedActionPolicy, returnPolicy: saved.returnPolicy,
    canActivate: false as const, effect: 'review_only_bed_unchanged' as const,
  }
}
