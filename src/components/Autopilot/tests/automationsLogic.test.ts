import { describe, expect, it } from 'vitest'
import {
  backtestLine, currentNightStart, entryTime, matchesFilter, nightHeader, nightStarts, ownerView,
  reasonText, ruleMode, ruleWindow, scheduleBands, scheduleBlocks, statusLine, type SideTonight,
} from '../automationsLogic'
import { missingLiveSignals, templateRule, TEMPLATES } from '../builderModel'

const t = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime()
const fmt = (f: number) => `${f}°`
const curve = [
  { at: t(28, 22, 30), temperature: 80 },
  { at: t(28, 23, 15), temperature: 76 },
  { at: t(29, 7), temperature: 76 },
]
const side = (over: Partial<SideTonight>): SideTonight => ({ control: null, hold: null, runOnceUntil: null, lastAutopilot: null, ...over })

describe('ownerView', () => {
  it('explains a manual hold with when the dial was set and when the schedule resumes', () => {
    const v = ownerView(side({
      control: { source: 'manual', targetTemperature: 81, blocked: null },
      hold: { temperature: 81, startedAt: t(28, 18, 31), expiresAt: t(28, 19, 15) },
    }), curve, t(28, 19), fmt)
    expect(v.owner).toBe('manual')
    expect(v.label).toBe('Manual hold')
    expect(v.detail).toBe('Dial set to 81° at 6:31 PM. Schedule resumes at 7:15 PM.')
  })

  it('names the rule and setpoint when autopilot owns the side', () => {
    const v = ownerView(side({ control: { source: 'autopilot', targetTemperature: 78, blocked: null }, lastAutopilot: { ruleName: 'Cool', temp: 78, at: t(29, 2, 14) } }), curve, t(29, 3), fmt)
    expect(v.detail).toBe('Cool set 78° at 2:14 AM.')
  })

  it('shows the current schedule setpoint and what comes next', () => {
    const v = ownerView(side({ control: { source: 'schedule', targetTemperature: 80, blocked: null } }), curve, t(28, 22, 45), fmt)
    expect(v.detail).toBe('80° until 11:15 PM, then 76°.')
  })

  it('infers the owner from the hold and schedule when the controller is not running', () => {
    const hold = { temperature: 81, startedAt: t(28, 18, 31), expiresAt: t(28, 19, 15) }
    expect(ownerView(side({ hold }), curve, t(28, 19), fmt).owner).toBe('manual')
    expect(ownerView(side({}), curve, t(28, 23), fmt)).toMatchObject({ owner: 'schedule', detail: '80° until 11:15 PM, then 76°.' })
  })

  it('skips set points that read the same when saying what comes next', () => {
    const steps = [
      { at: t(28, 22), temperature: 80 },
      { at: t(28, 22, 30), temperature: 80.2 },
      { at: t(28, 23), temperature: 81 },
      { at: t(29, 7), temperature: 81 },
    ]
    const whole = (f: number) => `${Math.round(f)}°`
    expect(ownerView(side({}), steps, t(28, 22, 10), whole).detail).toBe('80° until 11:00 PM, then 81°.')
    // Nothing changes before power off: say when it ends, not a repeat.
    expect(ownerView(side({}), steps, t(28, 23, 10), whole).detail).toBe('81° until 7:00 AM.')
  })

  it('falls back to Off with when the schedule starts', () => {
    expect(ownerView(side({}), curve, t(28, 19), fmt)).toMatchObject({ owner: 'off', detail: 'Schedule starts at 10:30 PM.' })
    expect(ownerView(side({}), [], t(28, 19), fmt).detail).toBe('No schedule tonight.')
    expect(ownerView(side({ control: { source: 'schedule', targetTemperature: 80, blocked: 'off' } }), curve, t(28, 19), fmt).owner).toBe('off')
  })
})

describe('timeline lanes', () => {
  it('turns set points into blocks that hold until the next point', () => {
    expect(scheduleBlocks(curve, t(28, 18), t(29, 9))).toEqual([
      { start: t(28, 22, 30), end: t(28, 23, 15), temperature: 80 },
      { start: t(28, 23, 15), end: t(29, 7), temperature: 76 },
    ])
  })

  it('merges neighbouring set points that read the same', () => {
    const steps = [
      { at: t(28, 23), temperature: 79.2 },
      { at: t(28, 23, 10), temperature: 79.4 },
      { at: t(28, 23, 20), temperature: 80 },
      { at: t(28, 23, 30), temperature: 79.1 },
      { at: t(29, 7), temperature: 79.1 },
    ]
    const whole = (f: number) => `${Math.round(f)}°`
    expect(scheduleBlocks(steps, t(28, 18), t(29, 9), whole)).toEqual([
      { start: t(28, 23), end: t(28, 23, 20), temperature: 79.2 },
      { start: t(28, 23, 20), end: t(28, 23, 30), temperature: 80 },
      { start: t(28, 23, 30), end: t(29, 7), temperature: 79.1 },
    ])
    // Without a label, every distinct value keeps its own block.
    expect(scheduleBlocks(steps, t(28, 18), t(29, 9))).toHaveLength(4)
  })

  it('joins touching blocks of one colour into a band with its range', () => {
    const tone = (f: number) => (f < 80 ? 'cool' : f > 80 ? 'warm' : 'neutral')
    const blocks = [
      { start: 0, end: 10, temperature: 80 },
      { start: 10, end: 20, temperature: 81 },
      { start: 20, end: 30, temperature: 83 },
      { start: 30, end: 40, temperature: 74 },
      { start: 50, end: 60, temperature: 70 },
    ]
    expect(scheduleBands(blocks, tone)).toEqual([
      { start: 0, end: 10, lo: 80, hi: 80, tone: 'neutral' },
      { start: 10, end: 30, lo: 81, hi: 83, tone: 'warm' },
      { start: 30, end: 40, lo: 74, hi: 74, tone: 'cool' },
      // A gap starts a new band even in the same colour.
      { start: 50, end: 60, lo: 70, hi: 70, tone: 'cool' },
    ])
  })

  it('places a rule window tonight, rolling morning starts to the next day', () => {
    const midnight = new Date(2026, 8, 28)
    const cond = (start: string, end: string) => ({ kind: 'and' as const, conditions: [{ kind: 'timeBetween' as const, start, end }] })
    expect(ruleWindow(cond('23:00', '06:00'), midnight, t(28, 18), t(29, 9))).toEqual({ start: t(28, 23), end: t(29, 6) })
    expect(ruleWindow(cond('01:00', '05:00'), midnight, t(28, 18), t(29, 9))).toEqual({ start: t(29, 1), end: t(29, 5) })
    expect(ruleWindow({ kind: 'and', conditions: [] }, midnight, t(28, 18), t(29, 9))).toEqual({ start: t(28, 18), end: t(29, 9) })
  })
})

describe('nights', () => {
  it('uses 6 PM–6 PM nights', () => {
    expect(currentNightStart(t(28, 19))).toBe(t(28, 18))
    expect(currentNightStart(t(28, 3))).toBe(t(27, 18))
    expect(nightStarts(t(28, 19), 3)).toEqual([t(26, 18), t(27, 18), t(28, 18)])
  })

  it('labels tonight, last night, then dates', () => {
    expect(nightHeader(t(28, 18), t(28, 19))).toBe('TONIGHT · MON SEP 28')
    expect(nightHeader(t(27, 18), t(28, 19))).toBe('LAST NIGHT · SUN SEP 27')
    expect(nightHeader(t(26, 18), t(28, 19))).toBe('SAT SEP 26')
  })
})

describe('rule rows', () => {
  it('builds the header status line without zero parts', () => {
    expect(statusLine([{ enabled: true, dryRun: true }])).toBe('1 rule · 1 dry-run')
    expect(statusLine([{ enabled: true, dryRun: false }, { enabled: false, dryRun: true }])).toBe('2 rules · 1 active')
    expect(statusLine([])).toBe('no rules')
  })

  it('maps enabled + dryRun to the three-state mode', () => {
    expect(ruleMode({ enabled: false, dryRun: false })).toBe('off')
    expect(ruleMode({ enabled: true, dryRun: true })).toBe('dryrun')
    expect(ruleMode({ enabled: true, dryRun: false })).toBe('active')
  })

  it('summarises the 5-night backtest', () => {
    expect(backtestLine({ nights: 5, wouldFire: 0, peak: 64, threshold: 200 })).toBe('5-night backtest · 0 would fire · peak 64 of 200')
    expect(backtestLine({ nights: 5, wouldFire: 2, peak: null, threshold: null })).toBe('5-night backtest · 2 would fire')
    expect(backtestLine({ nights: 0, wouldFire: 0, peak: null, threshold: null })).toBe('no recorded nights to backtest')
    expect(backtestLine(undefined)).toBe('backtesting…')
  })

  it('flags signals with no live source', () => {
    const missing = (id: string) => {
      const rule = templateRule(id)
      if (!rule) throw new Error(`no template ${id}`)
      return missingLiveSignals(rule)
    }
    expect(missing('restless')).toEqual(['movement'])
    expect(missing('water-low')).toEqual([])
    expect(missing('hold-room')).toEqual([])
    expect(templateRule('nope')).toBeNull()
    expect(TEMPLATES.map(x => x.title)).toEqual(['Hold room +3°F', 'Cool when restless', 'Tell me when water is low'])
  })
})

describe('activity copy', () => {
  const rule = { conditions: { kind: 'and' as const, conditions: [{ kind: 'timeBetween' as const, start: '23:00', end: '06:00' }] } }
  it('formats reasons', () => {
    expect(reasonText({ code: 'outside-window', temp: null, sides: [] }, rule, [], fmt)).toBe('outside 11 PM–6 AM')
    expect(reasonText({ code: 'signal-unavailable', temp: null, sides: [] }, rule, ['movement'], fmt)).toBe('movement unavailable')
    expect(reasonText({ code: 'set-temperature', temp: 78, sides: ['left'] }, rule, [], fmt)).toBe('set 78°')
    expect(reasonText({ code: 'anti-thrash', temp: null, sides: [] }, rule, [], fmt)).toBe('below anti-thrash')
  })

  it('formats single times and collapsed ranges', () => {
    expect(entryTime(t(28, 18, 31), t(28, 18, 31), t(28, 19), 1)).toBe('6:31 PM')
    expect(entryTime(t(27, 23), t(28, 6), t(28, 19), 420)).toBe('11:00 PM → 6 AM')
    expect(entryTime(t(28, 6), t(28, 18, 59), t(28, 19), 781)).toBe('6:00 AM → now')
  })

  it('filters by outcome', () => {
    expect(matchesFilter('clamped', 'fired')).toBe(true)
    expect(matchesFilter('dry_run', 'would')).toBe(true)
    expect(matchesFilter('skipped', 'fired')).toBe(false)
    expect(matchesFilter('error', 'all')).toBe(true)
  })
})

it('explains run-once, missing control details and safety blocks', () => {
  expect(ownerView(side({ control: { source: 'run-once', targetTemperature: 78, blocked: null }, runOnceUntil: t(29, 7) }), [], t(28, 23), fmt).detail).toBe('78° from a run-once session until 7:00 AM.')
  expect(ownerView(side({ control: { source: 'run-once', targetTemperature: null, blocked: null } }), [], t(28, 23), fmt).detail).toBe('Run-once session.')
  expect(ownerView(side({ control: { source: 'autopilot', targetTemperature: null, blocked: null } }), [], t(28, 23), fmt).detail).toBe('An automation holds this side.')
  expect(ownerView(side({ control: { source: 'schedule', targetTemperature: null, blocked: null } }), [], t(28, 23), fmt).detail).toBe('Following the schedule.')
  expect(ownerView(side({ control: { source: null, targetTemperature: null, blocked: 'safety' } }), [], t(28, 23), fmt).detail).toBe('Paused by pump stall protection.')
  expect(ownerView(side({ hold: { temperature: 80, startedAt: t(28, 22), expiresAt: t(29, 1) } }), [], t(28, 23), fmt).detail).toContain('Hold ends')
  expect(scheduleBlocks(curve, t(29, 8), t(29, 9))).toEqual([])
  expect(ruleWindow({ kind: 'timeBetween', start: '12:00', end: '13:00' }, new Date(2026, 8, 28), t(28, 18), t(29, 9))).toBeNull()
})

it.each([
  ['condition-false', 'condition not met'], ['cooldown', 'cooling down'], ['manual-hold', 'manual hold'],
  ['side-off', 'side is off'], ['superseded', 'another source owns the side'], ['runaway', 'fired too often · rule disabled'],
  ['eval-error', 'evaluation failed'], ['action-error', 'command failed'], ['set-temperature', 'set temperature'],
  ['notify', 'sent a notification'], ['power-on', 'turned power on'], ['power-off', 'turned power off'],
  ['unknown', 'no reason recorded'], ['outside-window', 'outside its window'], ['signal-unavailable', 'signal unavailable'],
])('explains %s without a rule', (code, expected) => {
  expect(reasonText({ code, temp: null, sides: [] }, undefined, [], fmt)).toBe(expected)
})

it('formats minute precision and noon/midnight window boundaries', () => {
  expect(reasonText({ code: 'outside-window', temp: null, sides: [] }, { conditions: { kind: 'timeBetween', start: '00:05', end: '12:30' } }, [], fmt)).toBe('outside 12:05 AM–12:30 PM')
  expect(matchesFilter('skipped', 'skipped')).toBe(true)
  expect(matchesFilter('fired', 'skipped')).toBe(false)
})
