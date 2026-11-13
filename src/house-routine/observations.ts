import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ownerIdentitySchema, qualificationSchema } from '@/src/comfort/owner-contract'
import type { SleeperPresence } from '@/src/lib/sleeperPresence'

const MAX_AGE_MS = 30_000
const instant = z.number().int().positive().max(8_640_000_000_000_000)
const presenceKinds = ['presence_empty', 'presence_occupied'] as const
const evidenceSchema = z.object({
  at: instant, identity: ownerIdentitySchema.nullable(), qualifications: z.array(qualificationSchema), mechanicallyQuiet: z.boolean(),
  presence: z.object({
    observedAt: instant.nullable(), available: z.boolean(), occupied: z.boolean(),
    entry: z.object({ measuredAt: instant, sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
      state: z.enum(['present', 'absent', 'unknown']) }).strict().optional(),
  }).strict(),
}).strict()

export const houseRoutineObservationsSchema = z.object({
  version: z.literal(1),
  observations: z.array(z.object({
    signal: z.literal('bed'), side: z.literal('left'), value: z.enum(['occupied', 'empty']),
    source: z.string().regex(/^pod-presence-v1:[a-f0-9]{64}$/),
    measured_at: z.iso.datetime(), qualified: z.literal(true),
    fields: z.object({
      whole_bed_empty: z.boolean(), presence_scope: z.literal('solo-anywhere'),
      qualification: z.literal('attended_empty_and_occupied'),
      calibration: z.string().regex(/^[a-f0-9]{64}$/), expires_at: z.iso.datetime(),
    }).strict(),
  }).strict()).length(1),
}).strict()

export class HouseRoutineObservationsUnavailable extends Error {
  constructor() { super('Qualified house-routine observations are unavailable.') }
}

function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new HouseRoutineObservationsUnavailable()
}

/** Only current calibrated samples can drive entry/exit timers; polling never renews their clock. */
export function buildHouseRoutineObservations(input: {
  at: number
  identity: unknown
  qualifications: unknown[]
  presence: SleeperPresence
  mechanicallyQuiet: boolean
}) {
  const parsed = evidenceSchema.safeParse(input)
  requireEvidence(parsed.success)
  const { at, identity, presence, qualifications } = parsed.data
  const fresh = (value: number | null | undefined) => typeof value === 'number' && value <= at && at - value <= MAX_AGE_MS
  requireEvidence(parsed.data.mechanicallyQuiet && identity && presence.available && fresh(presence.observedAt) && fresh(presence.entry?.measuredAt))
  const entry = presence.entry
  requireEvidence(entry && entry.sourceKey === identity.calibration && entry.state !== 'unknown'
    && presence.occupied === (entry.state === 'present'))
  const checks = qualifications.filter(record => presenceKinds.some(kind => kind === record.kind))
  // Duplicate or revoked/latest retest records cannot fall back to an older confirmation.
  requireEvidence(checks.length === 2 && presenceKinds.every(kind => checks.filter(record => record.kind === kind).length === 1))
  requireEvidence(checks.every(record => record.outcome === 'confirmed' && record.at <= at
    && JSON.stringify(record.evidence.identity) === JSON.stringify(identity)
    && record.evidence.presence === (record.kind === 'presence_empty' ? 'empty' : 'occupied')
    && record.evidence.presenceAt !== null && record.evidence.presenceAt <= record.at
    && record.at - record.evidence.presenceAt <= MAX_AGE_MS
    && record.evidence.observedAt <= record.at && record.at - record.evidence.observedAt <= MAX_AGE_MS))
  const empty = entry.state === 'absent'
  const source = createHash('sha256').update(JSON.stringify({ version: 1, identity,
    checks: presenceKinds.map(kind => checks.find(record => record.kind === kind)?.id) })).digest('hex')
  return houseRoutineObservationsSchema.parse({ version: 1, observations: [{
    signal: 'bed', side: 'left', value: empty ? 'empty' : 'occupied', source: `pod-presence-v1:${source}`,
    measured_at: new Date(entry.measuredAt).toISOString(), qualified: true,
    fields: { whole_bed_empty: empty, presence_scope: 'solo-anywhere', qualification: 'attended_empty_and_occupied',
      calibration: identity.calibration, expires_at: new Date(entry.measuredAt + MAX_AGE_MS).toISOString() },
  }] })
}
