import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlService } from '../service'
import { createControlStore, ControlConflictError, type ControlStore } from '../store'
import { beforeControlWrite } from '../context'
import { controlReceiptSchema, type ControlRequest } from '../contract'

let folder: string
let sqlite: Database.Database
let store: ControlStore
let now: number
let monotonic: number
const runId = 'test-process'
const request = (): ControlRequest => ({ requestId: randomUUID(), issuedAt: now, expiresAt: now + 30_000, action: { kind: 'base.stop' } })
const service = (execute = vi.fn(async () => {
  beforeControlWrite()
}), id = runId) => new ControlService({ store, execute, runId: id, now: () => now, monotonicNow: () => monotonic })

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'control-receipts-'))
  sqlite = new Database(join(folder, 'controller.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' })
  store = createControlStore(sqlite)
  now = 1_800_000_000_000
  monotonic = 100
})
afterEach(() => {
  if (sqlite.open) sqlite.close()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('durable control lifecycle', () => {
  it('commits intent before the write and completion after its acknowledgment', async () => {
    const input = request()
    const pragma = vi.spyOn(sqlite, 'pragma')
    const controller = service(vi.fn(async () => {
      expect(store.get(input.requestId)).toMatchObject({ state: 'executing', dispatchCount: 0 })
      beforeControlWrite()
      expect(store.get(input.requestId)).toMatchObject({ state: 'executing', dispatchCount: 1, lastDispatchAt: now })
    }))
    const receipt = await controller.submit(input)
    expect(controlReceiptSchema.parse(receipt)).toMatchObject({ state: 'acknowledged', physicalVerification: 'unverified', replayAllowed: false, dispatchCount: 1 })
    expect(pragma.mock.calls.filter(([value]) => value === 'synchronous = FULL')).toHaveLength(3)
    expect(sqlite.pragma('synchronous', { simple: true })).toBe(1)
    expect(controller.get(input.requestId)).toEqual(receipt)
  })

  it('concurrent identical submissions execute once and return the same receipt after completion', async () => {
    const gate = Promise.withResolvers<undefined>()
    const execute = vi.fn(async () => {
      beforeControlWrite()
      await gate.promise
    })
    const controller = service(execute)
    const input = request()
    const first = controller.submit(input)
    expect(await controller.submit(input)).toMatchObject({ state: 'executing', dispatchCount: 1 })
    expect(execute).toHaveBeenCalledOnce()
    gate.resolve(undefined)
    const completed = await first
    now += 60_000
    expect(await controller.submit(input)).toEqual(completed)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects reuse of an ID with a new action or lifetime', async () => {
    const controller = service()
    const input = request()
    await controller.submit(input)
    await expect(controller.submit({ ...input, action: { kind: 'vibration.clear', side: 'left' } })).rejects.toBeInstanceOf(ControlConflictError)
    await expect(controller.submit({ ...input, expiresAt: input.expiresAt + 1 })).rejects.toBeInstanceOf(ControlConflictError)
  })

  it.each(['expired', 'future'] as const)('persists a %s rejection without executing, even if resubmitted later', async (kind) => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
    })
    const controller = service(execute)
    const input = request()
    if (kind === 'expired') now = input.expiresAt
    else now = input.issuedAt - 1
    const receipt = await controller.submit(input)
    expect(receipt.state).toBe(kind === 'expired' ? 'expired' : 'rejected')
    now = input.issuedAt + 100
    expect(await controller.submit(input)).toEqual(receipt)
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['wall', 'monotonic', 'rollback'] as const)('checks %s time again at each hardware write', async (clock) => {
    const input = request()
    const actualWrite = vi.fn()
    const controller = service(vi.fn(async () => {
      if (clock === 'wall') now = input.expiresAt
      if (clock === 'monotonic') monotonic += 30_000
      if (clock === 'rollback') now = input.issuedAt - 1
      beforeControlWrite()
      actualWrite()
    }))
    expect(await controller.submit(input)).toMatchObject({ state: 'expired', dispatchCount: 0 })
    expect(actualWrite).not.toHaveBeenCalled()
  })

  it('reports unknown if a multi-command action expires after the first write', async () => {
    const input = request()
    const actualWrite = vi.fn()
    const execute = vi.fn(async () => {
      beforeControlWrite()
      actualWrite()
      now = input.expiresAt
      beforeControlWrite()
      actualWrite()
    })
    const controller = service(execute)
    expect(await controller.submit(input)).toMatchObject({ state: 'unknown', dispatchCount: 1 })
    await controller.submit(input)
    expect(execute).toHaveBeenCalledOnce()
    expect(actualWrite).toHaveBeenCalledOnce()
  })

  it('does not mistake a superseded/debounced action for an acknowledgment', async () => {
    expect(await service(vi.fn(async () => {})).submit(request())).toMatchObject({ state: 'not_dispatched', dispatchCount: 0 })
  })

  it('retains an ambiguous result after a lost hardware response without replaying it', async () => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
      throw new Error('private hardware diagnostic')
    })
    const controller = service(execute)
    const input = request()
    const receipt = await controller.submit(input)
    expect(receipt).toMatchObject({ state: 'unknown', reason: 'dispatch_outcome_unknown', dispatchCount: 1 })
    expect(JSON.stringify(receipt)).not.toContain('private')
    expect(await controller.submit(input)).toEqual(receipt)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('never dispatches when durable claim or dispatch persistence fails', async () => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
      actualWrite()
    })
    const actualWrite = vi.fn()
    const controller = service(execute)
    const claim = vi.spyOn(store, 'claim').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(controller.submit(request())).rejects.toThrow('disk full')
    expect(execute).not.toHaveBeenCalled()
    claim.mockRestore()
    vi.spyOn(store, 'dispatch').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(await controller.submit(request())).toMatchObject({ state: 'rejected', dispatchCount: 0 })
    expect(actualWrite).not.toHaveBeenCalled()
  })

  it('blocks a write when the durable commit itself outlasts the deadline', async () => {
    const dispatch = store.dispatch
    const input = request()
    const actualWrite = vi.fn()
    vi.spyOn(store, 'dispatch').mockImplementation((...args) => {
      dispatch(...args)
      now = input.expiresAt
    })
    const controller = service(vi.fn(async () => {
      beforeControlWrite()
      actualWrite()
    }))
    expect(await controller.submit(input)).toMatchObject({ state: 'unknown', dispatchCount: 1 })
    expect(actualWrite).not.toHaveBeenCalled()
  })

  it('preserves the no-replay barrier across closing/reopening SQLite after completion persistence fails', async () => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
    })
    const original = service(execute)
    const input = request()
    vi.spyOn(store, 'finish').mockImplementationOnce(() => {
      throw new Error('storage interrupted')
    })
    await expect(original.submit(input)).rejects.toThrow('storage interrupted')
    expect(original.get(input.requestId)).toMatchObject({ state: 'unknown' })
    sqlite.close()
    sqlite = new Database(join(folder, 'controller.db'))
    store = createControlStore(sqlite)
    const restarted = service(execute, 'new-process')
    expect(await restarted.submit(input)).toMatchObject({ state: 'unknown', reason: 'execution_interrupted', dispatchCount: 1 })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects malformed lifetimes, out-of-bounds angles, and raw commands before claiming', async () => {
    const controller = service()
    const claim = vi.spyOn(store, 'claim')
    const input = request()
    for (const invalid of [
      { ...input, expiresAt: input.issuedAt },
      { ...input, expiresAt: input.issuedAt + 60_001 },
      { ...input, issuedAt: Number.NaN },
      { ...input, action: { kind: 'base.position', head: 61, feet: 0 } },
      { ...input, action: { kind: 'execute', command: 13 } },
    ]) await expect(controller.submit(invalid)).rejects.toThrow()
    expect(claim).not.toHaveBeenCalled()
  })

  it('cannot claim from an enclosing transaction that might later roll back', () => {
    expect(() => sqlite.transaction(() => {
      // Directly exercise the durability guard without starting async actuation.
      store.claim({ requestId: randomUUID(), request: '{}', fingerprint: '', state: 'executing', reason: null, receivedAt: now, finishedAt: null, dispatchCount: 0, lastDispatchAt: null, runId })
    })()).toThrow('independent durable transaction')
  })
})
