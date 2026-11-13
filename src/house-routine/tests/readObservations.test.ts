// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ownerFixture } from '@/src/comfort/tests/ownerFixture'

const runtime = vi.hoisted(() => ({ database: vi.fn(), owner: vi.fn() }))
vi.mock('@/src/db', () => ({
  get sqlite() { return runtime.database() },
}))
vi.mock('@/src/comfort/instance', () => ({ getComfortOwner: runtime.owner }))
const { readHouseRoutineObservations } = await import('../readObservations')
let fixture: ReturnType<typeof ownerFixture>
beforeEach(async () => {
  fixture = ownerFixture()
  runtime.database.mockReturnValue(fixture.database)
  runtime.owner.mockReturnValue(fixture.owner)
  fixture.database.prepare('INSERT INTO device_settings (bed_mode, unused_zone_mode) VALUES (\'solo-left\', \'follow\')').run()
  await fixture.qualify('presence_empty')
  fixture.context.presence.occupied = true
  if (!fixture.context.presence.entry) throw new Error('Qualification fixture missing')
  fixture.context.presence.entry.state = 'present'
  await fixture.qualify('presence_occupied')
})
afterEach(() => {
  fixture.database.close()
  vi.clearAllMocks()
})

it('reads a qualified solo-anywhere observation without altering persisted state', async () => {
  const before = fixture.database.serialize()
  expect((await readHouseRoutineObservations()).observations[0]).toMatchObject({ side: 'left', value: 'occupied', qualified: true })
  expect(fixture.database.serialize()).toEqual(before)
})

it.each(['two', 'solo-right'])('does not remap or expose unsupported %s arrangements', async (mode) => {
  fixture.database.prepare('UPDATE device_settings SET bed_mode = ?').run(mode)
  await expect(readHouseRoutineObservations()).rejects.toThrow('unavailable')
  expect(runtime.owner).not.toHaveBeenCalled()
})

it('withdraws the endpoint when solo following is disabled or configuration disappears', async () => {
  fixture.database.prepare('UPDATE device_settings SET unused_zone_mode = \'off\'').run()
  await expect(readHouseRoutineObservations()).rejects.toThrow('unavailable')
  fixture.database.prepare('DELETE FROM device_settings').run()
  await expect(readHouseRoutineObservations()).rejects.toThrow('unavailable')
  expect(runtime.owner).not.toHaveBeenCalled()
})
