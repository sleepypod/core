import { describe, expect, it } from 'vitest'
import { bucketRuns, classifyRun, collapseRuns, conditionTimeWindow, inTimeWindow, type RunRow } from '../activity'

const at = (min: number) => new Date(Date.UTC(2026, 8, 28, 0, min))
const run = (min: number, outcome: RunRow['outcome'], detail: unknown, automationId = 1): RunRow => ({ automationId, firedAt: at(min), outcome, detail })

describe('classifyRun', () => {
  it('maps engine skip reasons to reason codes', () => {
    expect(classifyRun(run(0, 'skipped', { reason: 'condition-unknown' }), null).code).toBe('signal-unavailable')
    expect(classifyRun(run(0, 'skipped', { reason: 'condition-false' }), false).code).toBe('outside-window')
    expect(classifyRun(run(0, 'skipped', { reason: 'condition-false' }), true).code).toBe('condition-false')
    expect(classifyRun(run(0, 'skipped', { reason: 'condition-false' }), null).code).toBe('condition-false')
    expect(classifyRun(run(0, 'skipped', { reason: 'cooldown' }), null).code).toBe('cooldown')
    expect(classifyRun(run(0, 'error', { reason: 'runaway-disabled' }), null)).toMatchObject({ outcome: 'error', code: 'runaway' })
    expect(classifyRun(run(0, 'error', { reason: 'eval-threw' }), null)).toMatchObject({ outcome: 'error', code: 'eval-error' })
  })

  it('reads gated actions: manual hold, off side, unknown temp, superseded', () => {
    const gated = (skipped: string) => classifyRun(run(0, 'skipped', { actions: [{ kind: 'setTemperature', side: 'left', skipped }] }), null)
    expect(gated('manual-hold')).toMatchObject({ outcome: 'skipped', code: 'manual-hold', sides: ['left'] })
    expect(gated('off').code).toBe('side-off')
    expect(gated('safety').code).toBe('side-off')
    expect(gated('temp-unknown').code).toBe('signal-unavailable')
    expect(gated('schedule').code).toBe('superseded')
  })

  it('treats an anti-thrash re-assert as a skip even though the engine logged it fired', () => {
    const c = classifyRun(run(0, 'fired', { actions: [{ kind: 'setTemperature', side: 'right', antiThrash: true, temp: 72 }] }), null)
    expect(c).toMatchObject({ outcome: 'skipped', code: 'anti-thrash', temp: 72 })
  })

  it('describes what a fired or dry-run rule did', () => {
    expect(classifyRun(run(0, 'fired', { actions: [{ kind: 'setTemperature', side: 'left', sent: true, temp: 78 }] }), null))
      .toMatchObject({ outcome: 'fired', code: 'set-temperature', temp: 78, sides: ['left'] })
    expect(classifyRun(run(0, 'dry_run', { actions: [{ kind: 'setTemperature', side: 'left', dryRun: true, temp: 76 }, { kind: 'setTemperature', side: 'right', dryRun: true, temp: 76 }] }), null))
      .toMatchObject({ outcome: 'dry_run', sides: ['left', 'right'] })
    expect(classifyRun(run(0, 'fired', { actions: [{ kind: 'notify', notified: true }] }), null).code).toBe('notify')
    expect(classifyRun(run(0, 'fired', { actions: [{ kind: 'setPower', side: 'left', on: false, sent: true }] }), null).code).toBe('power-off')
    expect(classifyRun(run(0, 'fired', { actions: [{ kind: 'setPower', side: 'left', on: true, sent: true }] }), null).code).toBe('power-on')
    expect(classifyRun(run(0, 'error', { actions: [{ kind: 'setTemperature', error: 'boom' }] }), null).code).toBe('action-error')
  })

  it('tolerates missing or malformed detail', () => {
    expect(classifyRun(run(0, 'skipped', null), null).code).toBe('unknown')
    expect(classifyRun(run(0, 'skipped', { actions: 'nope' }), null).code).toBe('unknown')
  })
})

describe('collapseRuns', () => {
  it('merges consecutive same-reason skips per rule into one ranged entry, newest first', () => {
    const rows = [
      run(0, 'skipped', { reason: 'condition-unknown' }),
      run(1, 'skipped', { reason: 'condition-unknown' }),
      run(2, 'skipped', { reason: 'condition-unknown' }, 2),
      run(3, 'skipped', { reason: 'condition-unknown' }),
      run(4, 'skipped', { reason: 'cooldown' }),
      run(5, 'dry_run', { actions: [{ kind: 'notify', dryRun: true }] }),
      run(6, 'skipped', { reason: 'cooldown' }),
    ].map(r => classifyRun(r, null))
    const out = collapseRuns(rows)
    expect(out.map(e => [e.ruleId, e.code, e.count, e.start, e.end])).toEqual([
      [1, 'cooldown', 1, at(6).getTime(), at(6).getTime()],
      [1, 'notify', 1, at(5).getTime(), at(5).getTime()],
      [1, 'cooldown', 1, at(4).getTime(), at(4).getTime()],
      [1, 'signal-unavailable', 3, at(0).getTime(), at(3).getTime()],
      [2, 'signal-unavailable', 1, at(2).getTime(), at(2).getTime()],
    ])
  })

  it('never merges non-skip outcomes', () => {
    const fired = { actions: [{ kind: 'notify', notified: true }] }
    expect(collapseRuns([run(0, 'fired', fired), run(1, 'fired', fired)].map(r => classifyRun(r, null)))).toHaveLength(2)
  })
})

describe('time windows and buckets', () => {
  it('finds the first timeBetween in a condition tree', () => {
    expect(conditionTimeWindow({ kind: 'and', conditions: [{ kind: 'compare', op: '>', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 0 } }, { kind: 'timeBetween', start: '23:00', end: '06:00' }] }))
      .toEqual({ start: '23:00', end: '06:00' })
    expect(conditionTimeWindow({ kind: 'not', condition: { kind: 'timeBetween', start: '01:00', end: '02:00' } })).toBeNull()
    expect(conditionTimeWindow({ kind: 'onDays', days: ['monday'] })).toBeNull()
  })

  it('handles windows that wrap past midnight', () => {
    const w = { start: '23:00', end: '06:00' }
    expect(inTimeWindow(23 * 60, w)).toBe(true)
    expect(inTimeWindow(3 * 60, w)).toBe(true)
    expect(inTimeWindow(6 * 60, w)).toBe(false)
    expect(inTimeWindow(12 * 60, w)).toBe(false)
    expect(inTimeWindow(10 * 60, { start: '09:00', end: '17:00' })).toBe(true)
    expect(inTimeWindow(10 * 60, { start: '09:00', end: '09:00' })).toBe(false)
  })

  it('buckets runs by ascending starts, dropping runs before the first or at/after the end', () => {
    const runs = [{ at: 5 }, { at: 10 }, { at: 15 }, { at: 25 }, { at: 30 }]
    expect(bucketRuns(runs, [10, 20], 30)).toEqual([[{ at: 10 }, { at: 15 }], [{ at: 25 }]])
  })
})
