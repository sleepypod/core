import { afterEach, describe, expect, it } from 'vitest'
import { ownerFixture } from './ownerFixture'

const open: ReturnType<typeof ownerFixture>[] = []
function fixture() {
  const value = ownerFixture()
  open.push(value)
  return value
}
afterEach(() => {
  for (const value of open.splice(0)) value.database.close()
})

describe('room configuration and overnight evidence', () => {
  it('cannot reuse a reviewed night collected without room context to activate the new policy', async () => {
    const value = fixture()
    await value.night(1)
    expect(await value.reports.activationProofs('left', value.identity)).toHaveLength(1)
    expect(await value.reports.activationProofs('left', { ...value.identity, bedroomConfiguration: 'e'.repeat(64),
      policy: { ...value.identity.policy, roomAware: true } })).toEqual([])
  })
  it('ties room-aware nights to the exact source configuration and qualified input lease', async () => {
    const value = fixture()
    value.identity.policy.roomAware = true
    value.identity.bedroomConfiguration = 'e'.repeat(64)
    const bedroom = { state: 'ready' as const, offsetF: -1 as const, reason: 'Synthetic warm room.',
      sourceIds: ['temperature', 'humidity'], expiresAt: value.now() + 60000, configuration: value.identity.bedroomConfiguration }
    await value.night(1, { bedroom })
    expect(await value.reports.activationProofs('left', value.identity)).toHaveLength(1)
    expect(await value.reports.activationProofs('left', { ...value.identity, bedroomConfiguration: 'f'.repeat(64) })).toEqual([])
    await value.night(2, { bedroom: { ...bedroom, state: 'unavailable' } })
    expect(await value.reports.activationProofs('left', value.identity)).toHaveLength(1)
  })
})
