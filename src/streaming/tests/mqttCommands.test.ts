import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beforeControlWrite } from '@/src/controls/context'
import { ControlService } from '@/src/controls/service'
import { createControlStore } from '@/src/controls/store'
import type { ControlRequest } from '@/src/controls/contract'
import { MqttCommandGateway, mqttClimateCommandTemplate } from '../mqttCommands'

const packet = { retain: false, dup: false }
let folder: string
let sqlite: Database.Database
let now: number
let monotonic: number
const request = (): ControlRequest => ({ requestId: randomUUID(), issuedAt: now, expiresAt: now + 30_000,
  action: { kind: 'temperature', side: 'left', temperature: 75 } })
const encode = (value: unknown) => Buffer.from(JSON.stringify(value))
const gateway = (execute = vi.fn(async () => {
  beforeControlWrite()
})) => {
  const service = new ControlService({ store: createControlStore(sqlite), execute, runId: randomUUID(),
    now: () => now, monotonicNow: () => monotonic })
  return new MqttCommandGateway(input => service.submit(input))
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'mqtt-receipts-'))
  sqlite = new Database(join(folder, 'controller.db'))
  sqlite.pragma('journal_mode = WAL')
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' })
  now = 1_800_000_000_000
  monotonic = 10
})
afterEach(() => {
  if (sqlite.open) sqlite.close()
  rmSync(folder, { force: true, recursive: true })
})

describe('MQTT uses durable command authority', () => {
  it('deduplicates ordinary duplicate delivery and a SQLite reopen', async () => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
    })
    const input = encode(request())
    const first = gateway(execute)
    const receipt = await first.receive(input, packet)
    expect(receipt).toMatchObject({ state: 'acknowledged', dispatchCount: 1, physicalVerification: 'unverified' })
    expect(await first.receive(input, packet)).toEqual(receipt)
    sqlite.close()
    sqlite = new Database(join(folder, 'controller.db'))
    expect(await gateway(execute).receive(input, packet)).toEqual(receipt)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('does not retry an uncertain write', async () => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
      throw new Error('connection lost')
    })
    const input = encode(request())
    expect(await gateway(execute).receive(input, packet)).toMatchObject({ state: 'unknown', replayAllowed: false })
    expect(await gateway(execute).receive(input, packet)).toMatchObject({ state: 'unknown' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it.each(['expired', 'future'] as const)('withholds a %s command before invoking control', async (kind) => {
    const input = request()
    const execute = vi.fn(async () => {
      beforeControlWrite()
    })
    now = kind === 'expired' ? input.expiresAt : input.issuedAt - 1
    expect(await gateway(execute).receive(encode(input), packet)).toMatchObject({ state: kind === 'expired' ? 'expired' : 'rejected', dispatchCount: 0 })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['wall', 'monotonic', 'rollback'] as const)('rechecks %s time after a hardware queue wait', async (kind) => {
    const input = request()
    let writes = 0
    const execute = vi.fn(async () => {
      if (kind === 'wall') now = input.expiresAt
      if (kind === 'monotonic') monotonic += 30_000
      if (kind === 'rollback') now = input.issuedAt - 1
      beforeControlWrite()
      writes++
    })
    expect(await gateway(execute).receive(encode(input), packet)).toMatchObject({ state: 'expired', dispatchCount: 0 })
    expect(writes).toBe(0)
  })

  it('fails closed if the receipt database is unavailable', async () => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
    })
    const client = gateway(execute)
    sqlite.close()
    await expect(client.receive(encode(request()), packet)).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([undefined, { retain: true, dup: false }, { retain: false, dup: true }])('rejects invalid packet flags %j', async (flags) => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
    })
    await expect(gateway(execute).receive(encode(request()), flags)).rejects.toThrow('retained_or_redelivered_command')
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['', ' ', '{}', 'null', '[]', '{malformed', 'x'.repeat(4097)])('rejects invalid payload %# without dispatch', async (payload) => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
    })
    await expect(gateway(execute).receive(Buffer.from(payload), packet)).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([{ kind: 'base.stop' }, { kind: 'base.position', head: 1, feet: 0 }, { kind: 'priming' }])('keeps unsupported action %j out of MQTT', async (action) => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
    })
    await expect(gateway(execute).receive(encode({ ...request(), action }), packet)).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('bounds admitted work and releases capacity after completion', async () => {
    const gate = Promise.withResolvers<undefined>()
    const execute = vi.fn(async () => {
      await gate.promise
      beforeControlWrite()
    })
    const client = gateway(execute)
    const pending = Array.from({ length: 8 }, () => client.receive(encode(request()), packet))
    await expect(client.receive(encode(request()), packet)).rejects.toThrow('command_capacity_reached')
    gate.resolve(undefined)
    await Promise.all(pending)
    expect(await client.receive(encode(request()), packet)).toMatchObject({ state: 'acknowledged' })
  })

  it.each([
    { kind: 'temperature', side: 'left', temperature: 75 },
    { kind: 'power', side: 'right', powered: false },
    { kind: 'vibration', side: 'left', intensity: 10, pattern: 'rise', duration: 10 },
    { kind: 'vibration.clear', side: 'right' },
  ])('routes supported action %j through the shared service', async (action) => {
    const execute = vi.fn(async () => {
      beforeControlWrite()
    })
    const result = await gateway(execute).receive(encode({ ...request(), action }), packet)
    expect(result).toMatchObject({ action, state: 'acknowledged', dispatchCount: 1 })
    expect(execute).toHaveBeenCalledWith(action)
  })

  it('does not allow changing an existing request under the same ID', async () => {
    const input = request()
    const client = gateway()
    await client.receive(encode(input), packet)
    await expect(client.receive(encode({ ...input, action: { kind: 'power', side: 'left', powered: false } }), packet)).rejects.toThrow('different control request')
  })
})

describe('Home Assistant command templates', () => {
  it('uses a short lifetime and never formats a legacy command', () => {
    for (const side of ['left', 'right'] as const) {
      for (const kind of ['temperature', 'power'] as const) {
        const template = mqttClimateCommandTemplate(side, kind)
        expect(template).toContain('issued + 30000')
        expect(template).toContain(`"kind":"${kind}","side":"${side}"`)
        expect(template).toContain('now().timestamp()')
      }
    }
  })
})
