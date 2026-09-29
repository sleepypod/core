// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import type * as DataPathModule from '../dataPath'
import type { DataPathInputs } from '../dataPath'
const mock = vi.hoisted(() => ({
  exec: vi.fn(), connect: vi.fn(), get: vi.fn(), integrity: vi.fn(), manager: vi.fn(), thermal: vi.fn(),
  select: vi.fn(), monitor: undefined as unknown,
}))
vi.mock('node:child_process', () => ({ execFile: (file: string, args: string[], opts: unknown, cb: (error: unknown, stdout?: string) => void) => {
  cb(mock.exec(file, args, opts), '')
} }))
vi.mock('@/src/db', () => ({ sqlite: { prepare: () => ({ get: mock.get }) }, biometricsDb: { select: () => ({ from: () => ({ all: mock.select, where: () => ({ all: mock.select }) }) }) } }))
vi.mock('@/src/db/integrity', () => ({ getDatabaseIntegrity: mock.integrity }))
vi.mock('@/src/scheduler', () => ({ getJobManager: mock.manager }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getSharedHardwareClient: () => ({ connect: mock.connect }), getDacMonitorIfRunning: () => mock.monitor }))
vi.mock('@/src/streaming/piezoStream', () => ({ getSensorFrameTimes: () => ({}), getStreamClientCount: () => 2, getStreamPort: () => 3001 }))
vi.mock('@/src/lib/serverPerformance', () => ({ getServerPerformance: () => ({ sensorSource: 'raw' }) }))
vi.mock('@/src/lib/occupancy', () => ({ getOccupancy: () => ({ occupied: false }) }))
vi.mock('@/src/lib/thermalTruth', () => ({ readThermalTruth: mock.thermal }))
vi.mock('@/src/lib/dataPath', async importOriginal => ({ ...await importOriginal<typeof DataPathModule>(), evaluateDataPath: (input: DataPathInputs) => input }))
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mock.integrity.mockReturnValue({ status: 'ok' })
  mock.manager.mockResolvedValue({ getScheduler: () => ({ getJobs: () => [1], isEnabled: () => true }) })
  mock.thermal.mockReturnValue({ sides: [{ side: 'left', verdict: 'delivering' }] })
  mock.select.mockReturnValue([{ at: new Date(1000), rows: 3, top: 2 }])
  mock.monitor = { getStatus: () => 'running', getLastPollAt: () => 1000, getPollIntervalMs: () => 2000 }
})

it('collects timestamps and health inputs once per cache window', async () => {
  const { getDataPath } = await import('../dataPathCollect')
  const first = getDataPath(10000)
  expect(getDataPath(11000)).toBe(first)
  const input = await first as unknown as DataPathInputs
  expect(input).toMatchObject({ lastVitalAt: { left: 1000, right: 1000 }, lastEnvAt: 1000, stillness: { left: { rows: 3, maxScore: 2 } }, scheduler: { enabled: true, jobs: 1, healthy: true }, dacSocket: { ok: true }, database: { ok: true }, streamClients: 2, thermal: [{ side: 'left', verdict: 'delivering' }] })
  expect(Object.values(input.units).every(Boolean)).toBe(true)
  expect(mock.connect).toHaveBeenCalledOnce()
  await getDataPath(14000)
  expect(mock.connect).toHaveBeenCalledTimes(2)
})

it('tolerates missing systemctl, disconnected hardware, degraded integrity and absent readings', async () => {
  mock.exec.mockReturnValue({ code: 'ENOENT' })
  mock.connect.mockRejectedValue(new Error('No socket'))
  mock.integrity.mockReturnValue({ status: 'degraded' })
  mock.manager.mockRejectedValue(new Error('Not initialized'))
  mock.thermal.mockImplementation(() => {
    throw new Error('No state')
  })
  mock.select.mockReturnValue([])
  mock.monitor = undefined
  const { getDataPath } = await import('../dataPathCollect')
  const input = await getDataPath() as unknown as DataPathInputs
  expect(Object.values(input.units)).toEqual([null, null, null])
  expect(input).toMatchObject({ dacSocket: { ok: false, error: 'No socket' }, database: { ok: false, error: 'integrity check failed' }, lastEnvAt: null, lastVitalAt: { left: null, right: null }, dacMonitor: { status: 'not_initialized', lastPollAt: null }, thermal: [], stillness: { right: { rows: 0, maxScore: 0 } } })
})

it('reports failed units and database errors and evicts a rejected collection', async () => {
  mock.exec.mockReturnValue({ code: 3 })
  mock.get.mockImplementation(() => {
    throw 'Database closed'
  })
  mock.connect.mockRejectedValue('Socket closed')
  mock.select.mockImplementationOnce(() => {
    throw new Error('DB unavailable')
  })
  const { getDataPath } = await import('../dataPathCollect')
  await expect(getDataPath(10000)).rejects.toThrow('DB unavailable')
  const input = await getDataPath(10001) as unknown as DataPathInputs
  expect(Object.values(input.units)).toEqual([false, false, false])
  expect(input.database).toMatchObject({ ok: false, error: 'Database closed' })
  expect(input.dacSocket).toMatchObject({ ok: false, error: 'Socket closed' })
})
