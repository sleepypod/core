import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '../../tests/databaseFixture'

const fixture = vi.hoisted(() => ({ database: null as Database.Database | null,
  authority: vi.fn(), owner: vi.fn(), sample: vi.fn() }))
vi.mock('@/src/db', () => ({ get sqlite() {
  return fixture.database
} }))
vi.mock('@/src/temperature/instance', () => ({ getTemperatureControllerIfRunning: fixture.authority }))
vi.mock('../../instance', () => ({ getComfortOwner: fixture.owner,
  getComfortRuntimeIfRunning: () => ({ isRunning: () => true }), readComfortContext: fixture.sample }))
vi.mock('../../manual', () => ({ pendingManualPause: () => null }))

const { getExperimentExecution, getExperimentExecutionIfRunning } = await import('../execution-instance')
const shared = globalThis as typeof globalThis & { __sp_experimentHost?: unknown, __sp_experimentIdentity?: unknown }
beforeEach(() => {
  vi.clearAllMocks()
  fixture.database = migratedComfortDatabase()
  fixture.authority.mockReturnValue(undefined)
  fixture.owner.mockReturnValue({})
  delete shared.__sp_experimentHost
  delete shared.__sp_experimentIdentity
})
afterEach(async () => {
  await getExperimentExecutionIfRunning()?.stop()
  delete shared.__sp_experimentHost
  delete shared.__sp_experimentIdentity
  fixture.database?.close()
})

it('starts inertly before the first firmware poll has constructed the shared temperature authority', async () => {
  const host = getExperimentExecution()
  await host.start()
  expect(host.isRunning()).toBe(true)
  expect(getExperimentExecution()).toBe(host)
  expect(fixture.sample).not.toHaveBeenCalled()
  expect(fixture.database?.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_applications').get()).toEqual({ count: 0 })
})
