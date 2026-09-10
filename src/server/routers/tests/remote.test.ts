import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig } from '@/src/remote/model'
import { RemoteConflictError } from '@/src/remote/store'
const mocks = vi.hoisted(() => ({ read: vi.fn(), edit: vi.fn(), automation: vi.fn() }))
vi.mock('@/src/remote/runtime', () => ({ remoteStore: mocks, remoteStatus: () => ({ running: true, lastDetectionAt: null, lastError: null }) }))
vi.mock('@/src/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: mocks.automation }) }) }) } }))
import { remoteRouter } from '../remote'
describe('remote API', () => {
  const caller = remoteRouter.createCaller({})
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.read.mockReturnValue(emptyConfig())
    mocks.edit.mockReturnValue(emptyConfig())
    mocks.automation.mockReturnValue({ id: 42 })
  })
  it('returns persisted configuration and runtime status', async () => {
    await expect(caller.mapping({})).resolves.toEqual(emptyConfig())
    await expect(caller.status({})).resolves.toMatchObject({ running: true })
  })
  it('classifies permanent-input removal as a client validation error', async () => {
    await expect(caller.update({ side: 'left', revision: 0, edit: { kind: 'remove', input: 'top.single' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.edit).not.toHaveBeenCalled()
  })
  it('recognizes a revision conflict thrown by a different module graph', async () => {
    vi.resetModules()
    const foreign = await import('@/src/remote/store')
    const error = new foreign.RemoteConflictError('Concurrent edit')
    expect(error instanceof RemoteConflictError).toBe(false)
    mocks.edit.mockImplementation(() => {
      throw error
    })
    await expect(caller.update({ side: 'left', revision: 0, edit: { kind: 'copy' } })).rejects.toMatchObject({ code: 'CONFLICT', message: 'Concurrent edit' })
  })
  it('validates structured actions before persisting them', async () => {
    const edit = { kind: 'set' as const, input: 'top.single' as const, binding: { action: 'temp.up' as const, deltaF: 2 as const } }
    await caller.update({ side: 'right', revision: 3, edit })
    expect(mocks.edit).toHaveBeenCalledExactlyOnceWith('right', 3, edit)
    await expect(caller.update({ side: 'right', revision: 3, edit: { ...edit, binding: { action: 'temp.up', deltaF: '2°F' } as never } })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.edit).toHaveBeenCalledTimes(1)
  })
  it('rejects deleted automations and propagates revision conflicts', async () => {
    const edit = { kind: 'set' as const, input: 'top.double' as const, binding: { action: 'automation.run' as const, automationId: 42 } }
    mocks.automation.mockReturnValue(undefined)
    await expect(caller.update({ side: 'left', revision: 0, edit })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.edit).not.toHaveBeenCalled()
    mocks.automation.mockReturnValue({ id: 42 })
    mocks.edit.mockImplementation(() => {
      throw new RemoteConflictError('Reload mapping')
    })
    await expect(caller.update({ side: 'left', revision: 0, edit })).rejects.toMatchObject({ code: 'CONFLICT', message: 'Reload mapping' })
    mocks.edit.mockImplementation(() => {
      throw new Error('Database unavailable')
    })
    await expect(caller.update({ side: 'left', revision: 0, edit })).rejects.toThrow('Database unavailable')
  })
})
