/**
 * Tests for the HomeKit router — buildStatus shape, setEnabled lifecycle
 * (DB persists after enable/disable, rollback on persist failure),
 * unpair/regenerate passthrough, and seedProbe legacy detection.
 *
 * The homekit module + storage probes + qrcode + db are fully mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const homekitMock = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  regeneratePairing: vi.fn(),
  status: vi.fn(),
  unpair: vi.fn(),
}))

const storageMock = vi.hoisted(() => ({
  probeSeedSources: vi.fn(),
  readIdentityIfPresent: vi.fn(),
}))

const qrcodeMock = vi.hoisted(() => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,FAKE'),
}))

// db.select chain returns a row with homekitEnabled. db.update chain swallows
// the set/where pair.
const dbMock = vi.hoisted(() => {
  const selectRow: { homekitEnabled: boolean } = { homekitEnabled: false }
  const limit = vi.fn(async () => [selectRow])
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))

  const setSpy = vi.fn<(updates: Record<string, unknown>) => { where: ReturnType<typeof vi.fn> }>(
    () => ({ where: vi.fn(async () => undefined) }),
  )
  const update = vi.fn(() => ({ set: setSpy }))

  return { select, update, setSpy, selectRow, limit, where, from }
})

vi.mock('@/src/homekit', () => homekitMock)
vi.mock('@/src/homekit/storage', () => storageMock)
vi.mock('qrcode', () => ({ default: qrcodeMock }))

vi.mock('@/src/db', () => ({
  db: { select: dbMock.select, update: dbMock.update },
  biometricsDb: {},
}))

const { homekitRouter } = await import('@/src/server/routers/homekit')
const caller = homekitRouter.createCaller({})

beforeEach(() => {
  homekitMock.enable.mockReset().mockResolvedValue(undefined)
  homekitMock.disable.mockReset().mockResolvedValue(undefined)
  homekitMock.regeneratePairing.mockReset().mockResolvedValue(undefined)
  homekitMock.unpair.mockReset().mockResolvedValue(undefined)
  homekitMock.status.mockReset().mockReturnValue({
    running: false,
    transitioning: false,
    pincode: null,
    setupId: null,
    setupURI: null,
    pairedControllers: [],
  })
  storageMock.probeSeedSources.mockReset()
  storageMock.readIdentityIfPresent.mockReset()
  qrcodeMock.toDataURL.mockClear().mockResolvedValue('data:image/png;base64,FAKE')
  dbMock.select.mockClear()
  dbMock.update.mockClear()
  dbMock.setSpy.mockClear()
  dbMock.selectRow.homekitEnabled = false
})

describe('homekit.getStatus', () => {
  it('returns flat status with qrDataUrl=null when setupURI is null', async () => {
    dbMock.selectRow.homekitEnabled = false
    homekitMock.status.mockReturnValue({
      running: false,
      transitioning: false,
      pincode: null,
      setupId: null,
      setupURI: null,
      pairedControllers: [],
    })

    const result = await caller.getStatus({})

    expect(result).toEqual({
      enabled: false,
      running: false,
      transitioning: false,
      pincode: null,
      setupId: null,
      setupURI: null,
      qrDataUrl: null,
      pairedControllers: [],
    })
    expect(qrcodeMock.toDataURL).not.toHaveBeenCalled()
  })

  it('encodes setupURI as a QR data URL when present and reflects DB enabled flag', async () => {
    dbMock.selectRow.homekitEnabled = true
    homekitMock.status.mockReturnValue({
      running: true,
      transitioning: false,
      pincode: '111-22-333',
      setupId: 'XYZ1',
      setupURI: 'X-HM://0024K0R3F',
      pairedControllers: ['controllerA'],
    })

    const result = await caller.getStatus({})

    expect(result.enabled).toBe(true)
    expect(result.running).toBe(true)
    expect(result.transitioning).toBe(false)
    expect(result.pincode).toBe('111-22-333')
    expect(result.qrDataUrl).toBe('data:image/png;base64,FAKE')
    expect(qrcodeMock.toDataURL).toHaveBeenCalledWith(
      'X-HM://0024K0R3F',
      { errorCorrectionLevel: 'Q', margin: 1 },
    )
    expect(result.pairedControllers).toEqual(['controllerA'])
  })

  it('surfaces transitioning=true when a lifecycle op is in flight', async () => {
    dbMock.selectRow.homekitEnabled = true
    homekitMock.status.mockReturnValue({
      running: false,
      transitioning: true,
      pincode: null,
      setupId: null,
      setupURI: null,
      pairedControllers: [],
    })

    const result = await caller.getStatus({})

    expect(result.transitioning).toBe(true)
    expect(result.running).toBe(false)
  })
})

describe('homekit.setEnabled', () => {
  it('enables HomeKit then persists the flag', async () => {
    await caller.setEnabled({ enabled: true })

    expect(homekitMock.enable).toHaveBeenCalledTimes(1)
    expect(homekitMock.disable).not.toHaveBeenCalled()
    // Update should set homekitEnabled=true
    expect(dbMock.setSpy).toHaveBeenCalled()
    const setUpdates = dbMock.setSpy.mock.calls.at(-1)?.[0]
    expect(setUpdates).toMatchObject({ homekitEnabled: true })
    expect(setUpdates?.updatedAt).toBeInstanceOf(Date)
  })

  it('disables HomeKit then persists the flag', async () => {
    dbMock.selectRow.homekitEnabled = true

    await caller.setEnabled({ enabled: false })

    expect(homekitMock.disable).toHaveBeenCalledTimes(1)
    expect(homekitMock.enable).not.toHaveBeenCalled()
    const setUpdates = dbMock.setSpy.mock.calls.at(-1)?.[0]
    expect(setUpdates).toMatchObject({ homekitEnabled: false })
  })

  it('reverts the lifecycle when the DB persist fails (was disabled → enable rollback to disable)', async () => {
    // Prior state was disabled. Caller is enabling; persist throws; router
    // should call disableHomeKit again to roll back the runtime state.
    dbMock.selectRow.homekitEnabled = false
    dbMock.setSpy.mockReturnValueOnce({
      where: vi.fn(async () => { throw new Error('disk full') }),
    })

    await expect(caller.setEnabled({ enabled: true })).rejects.toThrow(/Failed to toggle HomeKit/)

    expect(homekitMock.enable).toHaveBeenCalledTimes(1)
    // Rollback: prior wasEnabled=false → disable() runs again
    expect(homekitMock.disable).toHaveBeenCalledTimes(1)
  })

  it('wraps lifecycle errors as INTERNAL_SERVER_ERROR', async () => {
    homekitMock.enable.mockRejectedValueOnce(new Error('mDNS failure'))

    await expect(caller.setEnabled({ enabled: true })).rejects.toThrow(/Failed to toggle HomeKit: mDNS failure/)
  })
})

describe('homekit.unpair / regenerate', () => {
  it('unpair calls homekit.unpair() and returns status', async () => {
    const result = await caller.unpair({})
    expect(homekitMock.unpair).toHaveBeenCalledTimes(1)
    expect(result.enabled).toBe(false)
  })

  it('regenerate calls homekit.regeneratePairing() and returns status', async () => {
    const result = await caller.regenerate({})
    expect(homekitMock.regeneratePairing).toHaveBeenCalledTimes(1)
    expect(result.enabled).toBe(false)
  })
})

describe('homekit.seedProbe', () => {
  it('passes through resolved + sources and reports identity present and non-legacy', async () => {
    storageMock.probeSeedSources.mockReturnValue({
      resolved: 'machineId',
      sources: [
        { source: 'machineId', path: '/etc/machine-id', present: true, readable: true, looksDegenerate: false },
        { source: 'serial', path: null, present: false, readable: false, looksDegenerate: false },
      ],
    })
    storageMock.readIdentityIfPresent.mockReturnValue({
      derivedFrom: 'machineId',
      rotation: 1,
      derivedAt: 1700000000,
    })

    const result = await caller.seedProbe({})

    expect(result.resolved).toBe('machineId')
    expect(result.sources).toHaveLength(2)
    expect(result.identity).toEqual({
      derivedFrom: 'machineId',
      rotation: 1,
      derivedAt: 1700000000,
      legacy: false,
    })
  })

  it('returns null identity fields when no identity file is present', async () => {
    storageMock.probeSeedSources.mockReturnValue({
      resolved: 'random',
      sources: [],
    })
    storageMock.readIdentityIfPresent.mockReturnValue(null)

    const result = await caller.seedProbe({})

    expect(result.identity).toEqual({
      derivedFrom: null,
      rotation: null,
      derivedAt: null,
      legacy: false,
    })
  })

  it('marks identity legacy when derivedFrom is missing on the file', async () => {
    storageMock.probeSeedSources.mockReturnValue({ resolved: 'machineId', sources: [] })
    // Legacy identity files predate ADR 0020 — derivedFrom undefined.
    storageMock.readIdentityIfPresent.mockReturnValue({})

    const result = await caller.seedProbe({})

    expect(result.identity.legacy).toBe(true)
    expect(result.identity.derivedFrom).toBe(null)
    expect(result.identity.rotation).toBe(null)
  })
})
