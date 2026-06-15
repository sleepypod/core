/**
 * Tests for the automations router's capacitive-history reads.
 *
 * Covers `capZoneReplay` (spatial-frame select + stride downsampling) and the
 * `backtest` path that pulls the scalar `{side}.cap.*` reducers out of the
 * cap-frame history via `loadSeries`. biometricsDb is a queue-backed `.all()`
 * mock (each select pops the next queued row-set in call order); the engine is
 * stubbed so importing the router has no side effects.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbState = vi.hoisted(() => ({
  queue: [] as unknown[][],
  pop(): unknown[] { return dbState.queue.shift() ?? [] },
}))

const biometricsMock = vi.hoisted(() => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'values', 'onConflictDoNothing', 'set', 'returning', 'insert', 'update', 'delete']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.all = vi.fn(() => dbState.pop())
  chain.run = vi.fn(() => undefined)
  return chain
})

vi.mock('@/src/db', () => ({ biometricsDb: biometricsMock, db: biometricsMock }))
vi.mock('@/src/automation', () => ({ getAutomationEngineIfRunning: () => null }))

const { automationsRouter } = await import('@/src/server/routers/automations')
const caller = automationsRouter.createCaller({})

const night = { enteredBedAt: new Date('2026-06-13T06:00:00Z'), leftBedAt: new Date('2026-06-13T14:00:00Z') }

function frameRow(i: number) {
  return { t: new Date(night.enteredBedAt.getTime() + i * 5000), zones: [i, i + 1, i + 2], peakZone: i % 3 }
}

beforeEach(() => {
  dbState.queue.length = 0
})

describe('automations.capZoneReplay', () => {
  it('returns the night window and persisted zone frames', async () => {
    dbState.queue.push([{ id: 7, ...night }]) // resolveNight by id
    dbState.queue.push([frameRow(0), frameRow(1), frameRow(2)]) // cap_sense_frames
    const out = await caller.capZoneReplay({ side: 'left', sleepRecordId: 7 })
    expect(out.ok).toBe(true)
    expect(out.night?.label).toBe('Last night')
    expect(out.night?.date).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
    expect(out.frames).toHaveLength(3)
    expect(out.frames[0]).toMatchObject({ zones: [0, 1, 2], peakZone: 0 })
    expect(out.frames[0].tMs).toBe(night.enteredBedAt.getTime())
  })

  it('strides frames down to the maxFrames budget, always keeping the first', async () => {
    dbState.queue.push([{ id: 7, ...night }])
    dbState.queue.push(Array.from({ length: 25 }, (_, i) => frameRow(i)))
    const out = await caller.capZoneReplay({ side: 'left', sleepRecordId: 7, maxFrames: 10 })
    // ceil(25/10) = 3 → indices 0,3,6,…,24 → 9 frames, first preserved.
    expect(out.frames).toHaveLength(9)
    expect(out.frames[0].zones).toEqual([0, 1, 2])
    expect(out.frames[1].zones).toEqual([3, 4, 5])
  })

  // Null-zone (Pod 3 scalar) frames are excluded by the query's
  // isNotNull(capSenseFrames.zones) filter, so they never reach the mapping —
  // not asserted here because the row-queue mock can't model the SQL predicate.

  it('reports ok:false with no frames when the side has no recorded nights', async () => {
    dbState.queue.push([]) // latest sleepRecords → none
    dbState.queue.push([]) // latest movement fallback → none
    const out = await caller.capZoneReplay({ side: 'right' })
    expect(out).toEqual({ ok: false, night: null, frames: [] })
  })
})

describe('automations.backtest — capacitive scalar reducers', () => {
  function capRow(i: number) {
    return { t: new Date(night.enteredBedAt.getTime() + i * 5000), max: 100 + i, mean: 50 + i, spread: 10 + i }
  }

  it('replays a rule over the {side}.cap.* series read from cap_sense_frames', async () => {
    dbState.queue.push([{ id: 7, ...night }]) // resolveNight by id
    // loadSeries selects, in order: movement, vitals, bedTemp, freezerTemp,
    // ambientLight, waterLevelReadings (all empty here), then cap_sense_frames.
    for (let i = 0; i < 6; i++) dbState.queue.push([])
    dbState.queue.push([capRow(0), capRow(1), capRow(2)]) // cap_sense_frames
    dbState.queue.push([]) // loadTimezone → deviceSettings (fallback tz)

    const out = await caller.backtest({
      side: 'left',
      sleepRecordId: 7,
      rule: {
        side: 'left',
        cooldownMin: 30,
        trigger: { kind: 'tick', everyMin: 1 },
        conditions: {
          kind: 'and',
          conditions: [{
            kind: 'compare',
            op: '>',
            left: { kind: 'window', fn: 'avg', signal: 'left.cap.max', lastMin: 10 },
            right: { kind: 'literal', value: 50 },
          }],
        },
        actions: [{
          kind: 'setTemperature',
          temp: { kind: 'literal', value: 68 },
          clamp: { min: 60, max: 75 },
          durationSec: 1200,
        }],
      },
    })

    expect(out.ok).toBe(true)
    expect(out.night?.label).toBe('Last night')
    // The condition's primary signal resolves to the cap series loadSeries built.
    expect(out.result?.primary?.key).toBe('left.cap.max')
  })
})
