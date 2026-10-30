// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { createBedroomStore } from '../store'
import { bedroomConfigSchema } from '../contract'

const runtime = vi.hoisted(() => ({ database: undefined as unknown as ReturnType<typeof migratedComfortDatabase> }))
vi.mock('@/src/db', () => ({ get sqlite() {
  return runtime.database
} }))
let database: ReturnType<typeof migratedComfortDatabase>
beforeEach(() => {
  database = migratedComfortDatabase()
  runtime.database = database
  vi.resetModules()
})
afterEach(() => {
  delete (globalThis as typeof globalThis & { __sp_bedroom?: unknown }).__sp_bedroom
  delete (globalThis as typeof globalThis & { __sp_roomContext?: unknown }).__sp_roomContext
  database.close()
})

it('switches rule input to the combined sources and withdraws missing data without a legacy fallback', async () => {
  const { getRoomContext, RoomSignalReader } = await import('@/src/home-context/instance')
  const legacy = getRoomContext()
  const legacyRead = vi.spyOn(legacy, 'signals').mockReturnValue({ 'room.temperature': 90 })
  const reader = new RoomSignalReader()
  expect(reader.read()).toEqual({ 'room.temperature': 90 })
  const combined = createBedroomStore(database)
  combined.configure(bedroomConfigSchema.parse({ enabled: true, roomName: 'Bedroom', sources: [] }), 0)
  legacyRead.mockClear()
  expect(reader.read()).toEqual({})
  expect(legacyRead).not.toHaveBeenCalled()
})
