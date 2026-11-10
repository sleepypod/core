import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingHealth } from '../contract'
import type * as Filesystem from 'node:fs/promises'

const mocks = vi.hoisted(() => ({
  get: vi.fn(), prepare: vi.fn(), path: vi.fn(), history: vi.fn(), statfs: vi.fn(),
}))
vi.mock('@/src/db', () => ({ biometricsDb: { $client: { name: '/recordings/biometrics.db', prepare: mocks.prepare } } }))
vi.mock('@/src/lib/dataPathCollect', () => ({ getObservedDataPath: mocks.path }))
vi.mock('@/src/lib/healthHistory', () => ({ readHistory: mocks.history }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Filesystem>()
  return { ...actual, statfs: mocks.statfs, default: { ...actual, statfs: mocks.statfs } }
})
const { getRecordingHealth } = await import('../instance')
const globals = globalThis as typeof globalThis & { __sp_recordingHealth?: { saved?: RecordingHealth, pending?: Promise<RecordingHealth> } }

beforeEach(() => {
  delete globals.__sp_recordingHealth
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 10, 10, 22))
  vi.resetAllMocks()
  mocks.prepare.mockReturnValue({ get: mocks.get })
  mocks.path.mockResolvedValue(null)
  mocks.history.mockReturnValue(null)
  mocks.statfs.mockResolvedValue({ bavail: 500_000, blocks: 2_000_000, bsize: 4096 })
})
afterEach(() => {
  delete globals.__sp_recordingHealth
  vi.useRealTimers()
})

describe('recording health collection', () => {
  it('reads the actual recording filesystem and table without mutations', async () => {
    const report = await getRecordingHealth()
    expect(mocks.statfs).toHaveBeenCalledWith('/recordings/biometrics.db')
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('SELECT id FROM sleep_records LIMIT 1')
    expect(report.checks.find(check => check.id === 'recording-database')?.state).toBe('ok')
    expect(report.checks.find(check => check.id === 'storage')?.state).toBe('ok')
  })

  it('coalesces concurrent reads and refreshes only after the bounded cache expires', async () => {
    const [first, second] = await Promise.all([getRecordingHealth(), getRecordingHealth()])
    expect(first).toEqual(second)
    expect(mocks.path).toHaveBeenCalledTimes(1)
    await getRecordingHealth()
    expect(mocks.path).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(15_000)
    await getRecordingHealth()
    expect(mocks.path).toHaveBeenCalledTimes(2)
  })

  it('withdraws an old cached check when the clock moves backwards', async () => {
    await getRecordingHealth()
    vi.setSystemTime(Date.UTC(2026, 10, 10, 21))
    await getRecordingHealth()
    expect(mocks.path).toHaveBeenCalledTimes(2)
  })

  it('reports independent missing sources without exposing internal errors or deleting files', async () => {
    mocks.path.mockRejectedValue(new Error('private path'))
    mocks.statfs.mockRejectedValue(new Error('private storage path'))
    mocks.history.mockImplementation(() => {
      throw new Error('private schema')
    })
    const report = await getRecordingHealth()
    expect(report.state).toBe('unknown')
    expect(JSON.stringify(report)).not.toContain('private')
    expect(report.checks.find(check => check.id === 'recording-database')?.state).toBe('ok')
    expect(report.checks.find(check => check.id === 'storage')?.state).toBe('unknown')
  })

  it('surfaces a recording table read failure without attempting a repair', async () => {
    mocks.get.mockImplementation(() => {
      throw new Error('database busy')
    })
    const report = await getRecordingHealth()
    expect(report.state).toBe('attention')
    expect(report.checks.find(check => check.id === 'recording-database')?.state).toBe('attention')
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('SELECT id FROM sleep_records LIMIT 1')
  })
})
