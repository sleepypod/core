import { describe, expect, it } from 'vitest'
import type { Trigger } from '@/src/automation/types'
import {
  buildStrip, cadenceText, filterCounts, groupLog, lastVerdict, missingTicks, runKind, thresholds, type EvalRun,
} from '../evaluationStrip'

const MIN = 60_000
const base = Date.UTC(2026, 8, 28, 15, 0, 0)
const everyMinute: Trigger = { kind: 'tick', everyMin: 1 }
const run = (min: number, outcome: EvalRun['outcome'] = 'skipped', reason: string | null = 'condition-false', sent = false): EvalRun =>
  ({ t: new Date(base + min * MIN + 5000), outcome, reason, sent })

describe('runKind', () => {
  it.each([
    [{ outcome: 'dry_run', reason: null }, 'would'],
    [{ outcome: 'fired', reason: null }, 'fired'],
    [{ outcome: 'clamped', reason: null }, 'fired'],
    [{ outcome: 'error', reason: 'eval-threw' }, 'error'],
    [{ outcome: 'skipped', reason: 'cooldown' }, 'cooldown'],
    [{ outcome: 'skipped', reason: 'condition-false' }, 'skipped'],
  ] as const)('%o → %s', (r, kind) => {
    expect(runKind(r)).toBe(kind)
  })
})

describe('missingTicks', () => {
  it('flags every expected minute inside a gap and up to now', () => {
    const runs = [run(0), run(1), run(5)]
    const now = base + 8 * MIN + 10_000
    const miss = missingTicks(runs, everyMinute, base, now).map(t => Math.round((t - base - 5000) / MIN))
    expect(miss).toEqual([2, 3, 4, 6, 7])
  })

  it('tolerates tick drift under the grace window', () => {
    const runs = [run(0), { ...run(1), t: new Date(base + MIN + 40_000) }]
    expect(missingTicks(runs, everyMinute, base, base + 2 * MIN + 20_000)).toEqual([])
  })

  it('steps by the trigger cadence and ignores non-tick triggers', () => {
    const runs = [run(0), run(20)]
    expect(missingTicks(runs, { kind: 'tick', everyMin: 5 }, base, base + 20 * MIN + 5000)).toHaveLength(3)
    expect(missingTicks(runs, { kind: 'signalChange', signal: 'x' }, base, base + 60 * MIN)).toEqual([])
    expect(missingTicks([], everyMinute, base, base + 60 * MIN)).toEqual([])
  })
})

describe('buildStrip', () => {
  it('paints one slot per minute, highest-priority outcome wins, cooldown spans merge', () => {
    const runs = [
      run(170, 'skipped'),
      run(171, 'dry_run', null),
      { ...run(171, 'skipped'), t: new Date(base + 171 * MIN + 20_000) },
      run(172, 'skipped', 'cooldown'),
      run(173, 'skipped', 'cooldown'),
      run(174, 'skipped', 'cooldown'),
      run(175, 'skipped'),
    ]
    const now = base + 179 * MIN + 30_000
    const s = buildStrip(runs, everyMinute, now, 3, true)
    expect(s.ticks).toHaveLength(180)
    expect(s.endMs - s.startMs).toBe(180 * MIN)
    const idx = (m: number) => Math.floor((base + m * MIN - s.startMs) / MIN)
    expect(s.ticks[idx(170)]).toBe('skipped')
    expect(s.ticks[idx(171)]).toBe('would')
    expect(s.cooldowns).toEqual([[idx(172), idx(174)]])
    expect(s.ticks[idx(177)]).toBe('missing')
    expect(s.ticks[idx(100)]).toBe('none') // before the first recorded row
  })

  it('omits missing slots when not expected', () => {
    const s = buildStrip([run(170)], everyMinute, base + 179 * MIN, 3, false)
    expect(s.ticks.includes('missing')).toBe(false)
  })
})

describe('groupLog + filterCounts', () => {
  it('collapses consecutive identical results newest-first and counts evaluations', () => {
    const runs = [run(0), run(1), run(2, 'dry_run', null), run(3, 'fired', null, true), run(4), run(5)]
    const groups = groupLog(runs, [base + 7 * MIN])
    expect(groups.map(g => [g.kind, g.count])).toEqual([
      ['missing', 1], ['skipped', 2], ['fired', 1], ['would', 1], ['skipped', 2],
    ])
    expect(groups[1].firstMs).toBeLessThan(groups[1].lastMs)
    expect(groups[2].sent).toBe(1)
    expect(filterCounts(groups)).toEqual({ all: 7, would: 1, fired: 1, skipped: 4, missing: 1 })
  })

  it('keeps different skip reasons apart', () => {
    const groups = groupLog([run(0), run(1, 'skipped', 'cooldown')], [])
    expect(groups).toHaveLength(2)
  })
})

describe('text helpers', () => {
  it('cadenceText', () => {
    expect(cadenceText(everyMinute)).toBe('every minute')
    expect(cadenceText({ kind: 'tick', everyMin: 5 })).toBe('every 5 min')
    expect(cadenceText({ kind: 'timeOfDay', at: '06:30' })).toBe('daily at 06:30')
    expect(cadenceText({ kind: 'signalChange', signal: 'left.movement' })).toBe('on left.movement change')
  })

  it('lastVerdict', () => {
    expect(lastVerdict(undefined)).toBeNull()
    expect(lastVerdict(run(0))).toBe('false')
    expect(lastVerdict(run(0, 'skipped', 'condition-unknown'))).toBe('unknown')
    expect(lastVerdict(run(0, 'skipped', 'cooldown'))).toBe('true')
    expect(lastVerdict(run(0, 'dry_run', null))).toBe('true')
    expect(lastVerdict(run(0, 'error', 'eval-threw'))).toBe('error')
  })

  it('thresholds walks nested conditions for literal compares', () => {
    expect(thresholds({
      kind: 'and',
      conditions: [
        { kind: 'timeBetween', start: '22:00', end: '06:00' },
        { kind: 'not', condition: { kind: 'compare', op: '<', left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }, right: { kind: 'literal', value: 200 } } },
        { kind: 'compare', op: '>', left: { kind: 'signal', signal: 'ambient.temperature' }, right: { kind: 'signal', signal: 'x' } },
      ],
    })).toEqual([{ signal: 'left.movement', op: '<', value: 200, window: { fn: 'avg', lastMin: 10 } }])
  })
})
