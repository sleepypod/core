import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { createTemperatureApplicationRecorder, readTemperatureApplications, type TemperatureApplicationInput } from '../applications'

const databases: ReturnType<typeof migratedComfortDatabase>[] = []
const directories: string[] = []
afterEach(() => {
  databases.splice(0).forEach((database) => {
    if (database.open) database.close()
  })
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
  vi.restoreAllMocks()
})
function fixture(filename = ':memory:') {
  const database = migratedComfortDatabase(filename)
  databases.push(database)
  let now = Date.parse('2026-10-26T08:00:00Z')
  const input: TemperatureApplicationInput = { side: 'left', targetF: 74, durationSec: null, reason: 'reconcile',
    source: 'autopilot', requestId: 'policy:comfort:session-1:step-1' }
  return { database, input, record: createTemperatureApplicationRecorder(database, () => now),
    read: (side: 'left' | 'right' = 'left', beforeId?: number) => readTemperatureApplications(database, side, beforeId, now),
    advance: (milliseconds: number) => { now += milliseconds } }
}

describe('durable temperature application evidence', () => {
  it('persists an attempt before sending and keeps requested temperature separate from physical confirmation', async () => {
    const context = fixture()
    const apply = vi.fn(async () => {
      expect(context.read().items[0]).toMatchObject({ targetF: 74, outcome: 'attempting', finishedAt: null, acknowledgment: 'unconfirmed' })
      context.advance(100)
    })
    await context.record(context.input, apply)
    expect(apply).toHaveBeenCalledOnce()
    expect(context.read().items[0]).toMatchObject({ source: 'autopilot', requestId: context.input.requestId,
      outcome: 'acknowledged', acknowledgment: 'accepted_not_physically_verified', durationSec: null })
    const completed = context.read().items[0]
    expect(completed.finishedAt).toBe(completed.attemptedAt + 100)
    expect(context.read('right').items).toEqual([])
  })

  it('leaves failed or partial hardware/state writes unknown and preserves the original error', async () => {
    const context = fixture()
    const failure = new Error('Synthetic partial write')
    await expect(context.record(context.input, async () => {
      throw failure
    })).rejects.toBe(failure)
    expect(context.read().items[0]).toMatchObject({ outcome: 'unknown', acknowledgment: 'unconfirmed' })
    context.database.exec('CREATE TRIGGER reject_result BEFORE UPDATE ON temperature_applications BEGIN SELECT RAISE(ABORT, \'test\'); END')
    await expect(context.record(context.input, async () => {
      throw failure
    })).rejects.toBe(failure)
    expect(context.read().items[0]).toMatchObject({ outcome: 'attempting', finishedAt: null, acknowledgment: 'unconfirmed' })
  })

  it('does not call hardware if the durable attempt fails, and rolls back retention in the same transaction', async () => {
    const context = fixture()
    await context.record(context.input, async () => {})
    context.advance(31 * 86_400_000)
    context.database.exec('CREATE TRIGGER reject_attempt BEFORE INSERT ON temperature_applications BEGIN SELECT RAISE(ABORT, \'test\'); END')
    const apply = vi.fn(async () => {})
    await expect(context.record(context.input, apply)).rejects.toThrow('test')
    expect(apply).not.toHaveBeenCalled()
    expect(context.database.prepare('SELECT count(*) AS total FROM temperature_applications').get()).toEqual({ total: 1 })
  })

  it('does not turn a successful command into a retry when completion persistence or the completion clock fails', async () => {
    const context = fixture()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    context.database.exec('CREATE TRIGGER reject_ack BEFORE UPDATE ON temperature_applications WHEN NEW.outcome = \'acknowledged\' BEGIN SELECT RAISE(ABORT, \'test\'); END')
    await expect(context.record(context.input, async () => {})).resolves.toMatchObject({ outcome: 'unknown' })
    expect(context.read().items[0]).toMatchObject({ outcome: 'unknown', acknowledgment: 'unconfirmed' })
    context.database.exec('DROP TRIGGER reject_ack')
    await context.record(context.input, async () => {
      context.advance(-1)
    })
    expect(context.read().items[0]).toMatchObject({ outcome: 'unknown', finishedAt: null })
  })

  it('retains interrupted attempts across database reopen without replaying them', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sleepypod-applications-'))
    directories.push(directory)
    const filename = path.join(directory, 'config.db')
    const context = fixture(filename)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    context.database.exec('CREATE TRIGGER reject_result BEFORE UPDATE ON temperature_applications BEGIN SELECT RAISE(ABORT, \'test\'); END')
    await context.record(context.input, async () => {})
    const attemptId = context.read().items[0].attemptId
    context.database.close()
    const reopened = fixture(filename)
    expect(reopened.read().items[0]).toMatchObject({ attemptId, outcome: 'attempting', acknowledgment: 'unconfirmed' })
    expect(reopened.read().items).toHaveLength(1)
  })

  it('keeps concurrent sides distinct and records repeated hardware attempts as separate receipts', async () => {
    const context = fixture()
    await Promise.all([
      context.record(context.input, async () => {}),
      context.record({ ...context.input, side: 'right', targetF: 77 }, async () => {}),
    ])
    await context.record(context.input, async () => {})
    const left = context.read().items
    expect(left).toHaveLength(2)
    expect(left[0].attemptId).not.toBe(left[1].attemptId)
    expect(context.read('right').items).toHaveLength(1)
  })

  it('paginates by stable per-side IDs and applies age and count retention without synthesizing old receipts', async () => {
    const context = fixture()
    for (let index = 0; index < 52; index++) await context.record(context.input, async () => {})
    const first = context.read()
    expect(first.items).toHaveLength(50)
    expect(first.nextBeforeId).toBe(first.items.at(-1)?.id)
    await context.record(context.input, async () => {})
    if (first.nextBeforeId === null) throw new Error('Expected another page')
    const last = context.read('left', first.nextBeforeId)
    expect(last.items).toHaveLength(2)
    expect(last.nextBeforeId).toBeNull()
    expect(new Set([...first.items, ...last.items].map(item => item.id)).size).toBe(52)
    context.advance(30 * 86_400_000 + 1)
    expect(context.read().items).toEqual([])
    await context.record(context.input, async () => {})
    const row = context.database.prepare('SELECT * FROM temperature_applications').get() as { attempted_at: number, request: string }
    const insert = context.database.prepare('INSERT INTO temperature_applications (attempt_id, side, attempted_at, outcome, request) VALUES (?, \'left\', ?, \'attempting\', ?)')
    context.database.transaction(() => {
      for (let index = 0; index < 10002; index++) insert.run(`fixture-${index}`, row.attempted_at, row.request)
    })()
    await context.record(context.input, async () => {})
    expect(context.database.prepare('SELECT count(*) AS total FROM temperature_applications').get()).toEqual({ total: 10000 })
  })

  it('rejects malformed requests, cursors and corrupt stored evidence instead of silently dropping it', async () => {
    const context = fixture()
    const apply = vi.fn(async () => {})
    for (const changes of [{ targetF: NaN }, { targetF: 111 }, { durationSec: -1 }, { requestId: '' }, { source: 'llm' }]) {
      await expect(context.record({ ...context.input, ...changes } as TemperatureApplicationInput, apply)).rejects.toThrow()
    }
    expect(apply).not.toHaveBeenCalled()
    expect(() => context.read('left', -1)).toThrow()
    await context.record(context.input, async () => {})
    context.database.prepare('UPDATE temperature_applications SET request = ?').run(JSON.stringify({ ...context.input, side: 'right' }))
    expect(() => context.read()).toThrow('side mismatch')
  })
})
