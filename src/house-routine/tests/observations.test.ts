import { afterEach, describe, expect, it } from 'vitest'
import type { SleeperPresence } from '@/src/lib/sleeperPresence'
import { ownerFixture } from '@/src/comfort/tests/ownerFixture'
import { buildHouseRoutineObservations, HouseRoutineObservationsUnavailable } from '../observations'

const fixtures: ReturnType<typeof ownerFixture>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.database.close()
})
function entry(presence: SleeperPresence) {
  if (!presence.entry) throw new Error('A calibrated test sample is required')
  return presence.entry
}
async function qualified() {
  const fixture = ownerFixture()
  fixtures.push(fixture)
  await fixture.qualify('presence_empty')
  fixture.context.presence.occupied = true
  entry(fixture.context.presence).state = 'present'
  await fixture.qualify('presence_occupied')
  return fixture
}

describe('House Control presence contract from actual qualification records', () => {
  it('uses the original firmware sample, with no activation, writes or private notes', async () => {
    const fixture = await qualified()
    const before = fixture.database.serialize()
    const sampleAt = fixture.now() - 8000
    entry(fixture.context.presence).measuredAt = sampleAt
    const result = buildHouseRoutineObservations(fixture.owner.presenceEvidence('left'))
    expect(result.observations).toEqual([{
      signal: 'bed', side: 'left', value: 'occupied', source: expect.stringMatching(/^pod-presence-v1:[a-f0-9]{64}$/),
      measured_at: new Date(sampleAt).toISOString(), qualified: true,
      fields: { whole_bed_empty: false, presence_scope: 'solo-anywhere', qualification: 'attended_empty_and_occupied',
        calibration: fixture.identity.calibration, expires_at: new Date(sampleAt + 30000).toISOString() },
    }])
    expect(JSON.stringify(result)).not.toContain('Synthetic owner')
    expect(fixture.database.serialize()).toEqual(before)
    expect(fixture.store.read('left').config.mode).toBe('preview')
  })

  it('does not renew an observation when polled, then withdraws it on expiry', async () => {
    const fixture = await qualified()
    const original = fixture.owner.presenceEvidence('left')
    const first = buildHouseRoutineObservations(original)
    expect(buildHouseRoutineObservations({ ...original, at: original.at + 30000 })).toEqual(first)
    expect(() => buildHouseRoutineObservations({ ...original, at: original.at + 30001 })).toThrow(HouseRoutineObservationsUnavailable)
  })

  it('reports empty only when the logical calibrated reading and occupied state agree', async () => {
    const fixture = await qualified()
    fixture.context.presence.occupied = false
    entry(fixture.context.presence).state = 'absent'
    expect(buildHouseRoutineObservations(fixture.owner.presenceEvidence('left')).observations[0])
      .toMatchObject({ value: 'empty', fields: { whole_bed_empty: true } })
    fixture.context.presence.occupied = true
    expect(() => buildHouseRoutineObservations(fixture.owner.presenceEvidence('left'))).toThrow(HouseRoutineObservationsUnavailable)
  })

  it('changes the source revision after a new attended check so consumer dwell timers restart', async () => {
    const fixture = await qualified()
    const previous = buildHouseRoutineObservations(fixture.owner.presenceEvidence('left')).observations[0]?.source
    await fixture.qualify('presence_occupied')
    const current = buildHouseRoutineObservations(fixture.owner.presenceEvidence('left')).observations[0]?.source
    expect(current).toBeTruthy()
    expect(current).not.toBe(previous)
  })

  it.each(['missing', 'unknown', 'stale', 'future', 'source_changed', 'unavailable', 'receive_clock_future'] as const)('withdraws %s source evidence', async (change) => {
    const fixture = await qualified()
    const evidence = fixture.owner.presenceEvidence('left')
    if (change === 'missing') delete evidence.presence.entry
    if (change === 'unknown') entry(evidence.presence).state = 'unknown'
    if (change === 'stale') entry(evidence.presence).measuredAt -= 30001
    if (change === 'future') entry(evidence.presence).measuredAt += 1
    if (change === 'source_changed') entry(evidence.presence).sourceKey = 'f'.repeat(64)
    if (change === 'unavailable') evidence.presence.available = false
    if (change === 'receive_clock_future') evidence.presence.observedAt = evidence.at + 1
    expect(() => buildHouseRoutineObservations(evidence)).toThrow(HouseRoutineObservationsUnavailable)
  })

  it.each(['presence_empty', 'presence_occupied'] as const)('honors the latest %s retest rather than falling back', async (kind) => {
    const fixture = await qualified()
    const previous = fixture.owner.presenceEvidence('left').qualifications.find(record => record.kind === kind)
    if (!previous) throw new Error('Qualification fixture missing')
    await fixture.owner.retest('left', kind, previous.id)
    expect(() => buildHouseRoutineObservations(fixture.owner.presenceEvidence('left'))).toThrow(HouseRoutineObservationsUnavailable)
  })

  it.each(['missing', 'duplicate', 'future', 'identity', 'wrong_observation', 'old_observation'] as const)('rejects %s attended evidence', async (change) => {
    const fixture = await qualified()
    const evidence = fixture.owner.presenceEvidence('left')
    const record = evidence.qualifications[0]
    if (!record) throw new Error('Qualification fixture missing')
    if (change === 'missing') evidence.qualifications.pop()
    if (change === 'duplicate') evidence.qualifications.push(record)
    if (change === 'future') record.at = evidence.at + 1
    if (change === 'identity') record.evidence.identity.build = 'f'.repeat(40)
    if (change === 'wrong_observation') record.evidence.presence = 'unavailable'
    if (change === 'old_observation') record.evidence.presenceAt = record.at - 30001
    expect(() => buildHouseRoutineObservations(evidence)).toThrow(HouseRoutineObservationsUnavailable)
  })

  it.each(['priming', 'vibrating', 'baseMoving'] as const)('withdraws presence during %s', async (field) => {
    const fixture = await qualified()
    fixture.context.device[field] = true
    expect(() => buildHouseRoutineObservations(fixture.owner.presenceEvidence('left'))).toThrow(HouseRoutineObservationsUnavailable)
  })

  it('withdraws unknown base status, absent identity and changed policy', async () => {
    const fixture = await qualified()
    fixture.context.device.baseMoving = null
    expect(() => buildHouseRoutineObservations(fixture.owner.presenceEvidence('left'))).toThrow()
    fixture.context.device.baseMoving = false
    fixture.setIdentifiable(false)
    expect(() => buildHouseRoutineObservations(fixture.owner.presenceEvidence('left'))).toThrow()
    fixture.setIdentifiable(true)
    fixture.configure({ config: { ...fixture.store.read('left').config, maximumF: 90 } })
    expect(() => buildHouseRoutineObservations(fixture.owner.presenceEvidence('left'))).toThrow()
  })
})
