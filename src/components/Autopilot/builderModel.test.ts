import { describe, expect, it } from 'vitest'
import {
  blankRule,
  buildSentence,
  type BuilderRule,
  fmtClock,
  fromAST,
  parseExpr,
  printExpr,
  type RuleAST,
  sigLabel,
  sigUnit,
  toAST,
} from './builderModel'
import type { Condition, Expr } from '@/src/automation/types'

/** Render a sentence to a flat string for assertions. */
function sentence(b: BuilderRule): string {
  return buildSentence(b).map(c => c.text).join('')
}

describe('parseExpr / printExpr', () => {
  it('parses signal ± literal', () => {
    expect(parseExpr('ambient + 3', 'both')).toEqual({
      kind: 'binary', op: '+',
      left: { kind: 'signal', signal: 'ambient.temperature' },
      right: { kind: 'literal', value: 3 },
    })
  })
  it('resolves {side} variables against the rule side', () => {
    expect(parseExpr('target - 2', 'right')).toEqual({
      kind: 'binary', op: '-',
      left: { kind: 'signal', signal: 'right.targetTemperature' },
      right: { kind: 'literal', value: 2 },
    })
  })
  it('parses a bare number and a bare variable', () => {
    expect(parseExpr('72', 'both')).toEqual({ kind: 'literal', value: 72 })
    expect(parseExpr('ambient', 'both')).toEqual({ kind: 'signal', signal: 'ambient.temperature' })
  })
  it('rejects garbage', () => {
    expect(parseExpr('', 'both')).toBeNull()
    expect(parseExpr('frobnicate', 'both')).toBeNull()
  })
  it('round-trips through printExpr', () => {
    const e = parseExpr('ambient + 3', 'left')
    expect(e).not.toBeNull()
    expect(printExpr(e as NonNullable<typeof e>, 'left')).toBe('ambient + 3')
  })
})

describe('toAST — motivating example 1 (continuous policy: ambient + 3 overnight)', () => {
  const rule: BuilderRule = {
    name: 'Ambient-follow night hold', enabled: true, mode: 'active', side: 'both', priority: 1,
    when: { type: 'time', between: ['23:00', '06:00'] },
    ifs: [],
    then: [{ action: 'setTemperature', expr: 'ambient + 3', clamp: [60, 75] }],
    cooldown: 0,
  }
  const ast = toAST(rule)

  it('uses a tick trigger gated by a timeBetween condition', () => {
    expect(ast.trigger).toEqual({ kind: 'tick', everyMin: 1 })
    expect(ast.conditions).toEqual({ kind: 'and', conditions: [{ kind: 'timeBetween', start: '23:00', end: '06:00' }] })
  })
  it('emits an expression-based setTemperature with the clamp band', () => {
    expect(ast.actions).toEqual([{
      kind: 'setTemperature',
      temp: { kind: 'binary', op: '+', left: { kind: 'signal', signal: 'ambient.temperature' }, right: { kind: 'literal', value: 3 } },
      clamp: { min: 60, max: 75 },
    }])
  })
  it('maps both → null side, active → dryRun false, no cooldown → null', () => {
    expect(ast.side).toBeNull()
    expect(ast.dryRun).toBe(false)
    expect(ast.cooldownMin).toBeNull()
  })
})

describe('toAST — motivating example 2 (edge: movement avg > 200 → lower 2°F)', () => {
  const rule: BuilderRule = {
    name: 'Restless cool-down', enabled: true, mode: 'active', side: 'left', priority: 2,
    when: { type: 'agg', agg: 'avg', signal: '{side}.movement', window: 10, op: '>', value: 200 },
    ifs: [{ type: 'time', between: ['23:00', '06:00'] }],
    then: [{ action: 'setTemperature', delta: -2, revert: 20, clamp: [60, 75] }],
    cooldown: 30,
  }
  const ast = toAST(rule)

  it('uses tick + window compare AND time window, side resolved to left', () => {
    expect(ast.trigger).toEqual({ kind: 'tick', everyMin: 1 })
    expect(ast.conditions).toEqual({
      kind: 'and',
      conditions: [
        { kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }, right: { kind: 'literal', value: 200 } },
        { kind: 'timeBetween', start: '23:00', end: '06:00' },
      ],
    })
  })
  it('lowers by 2°F off currentTemperature with a revert duration', () => {
    expect(ast.actions).toEqual([{
      kind: 'setTemperature',
      temp: { kind: 'binary', op: '-', left: { kind: 'signal', signal: 'left.currentTemperature' }, right: { kind: 'literal', value: 2 } },
      clamp: { min: 60, max: 75 },
      durationSec: 1200,
    }])
    expect(ast.cooldownMin).toBe(30)
  })
})

describe('fromAST(toAST(b)) round-trip', () => {
  const cases: BuilderRule[] = [
    blankRule(),
    {
      name: 'policy', enabled: true, mode: 'active', side: 'both', priority: 1,
      when: { type: 'time', between: ['23:00', '06:00'] }, ifs: [],
      then: [{ action: 'setTemperature', expr: 'ambient + 3', clamp: [60, 75] }], cooldown: 0,
    },
    {
      name: 'edge', enabled: true, mode: 'active', side: 'left', priority: 2,
      when: { type: 'agg', agg: 'avg', signal: '{side}.movement', window: 10, op: '>', value: 200 },
      ifs: [{ type: 'time', between: ['23:00', '06:00'] }],
      then: [{ action: 'setTemperature', delta: -2, revert: 20, clamp: [60, 75] }], cooldown: 30,
    },
    {
      name: 'threshold notify', enabled: false, mode: 'dryrun', side: 'right', priority: 4,
      when: { type: 'cond', signal: '{side}.heartRate', op: '>', value: 70 }, ifs: [],
      then: [{ action: 'notify', message: 'high HR' }], cooldown: 120,
    },
    {
      name: 'signal change', enabled: true, mode: 'dryrun', side: 'both', priority: 5,
      when: { type: 'change', signal: 'water.low' }, ifs: [],
      then: [{ action: 'setPower', on: false }], cooldown: 0,
    },
    {
      name: 'not-equal threshold', enabled: true, mode: 'active', side: 'right', priority: 1,
      when: { type: 'cond', signal: '{side}.heartRate', op: '≠', value: 70 }, ifs: [],
      then: [{ action: 'notify', message: 'HR off baseline' }], cooldown: 0,
    },
    {
      name: 'zero delta hold', enabled: true, mode: 'active', side: 'left', priority: 0,
      when: { type: 'time', between: ['23:00', '06:00'] }, ifs: [],
      then: [{ action: 'setTemperature', delta: 0, revert: 20, clamp: [60, 75] }], cooldown: 0,
    },
  ]

  for (const c of cases) {
    it(`preserves "${c.name}"`, () => {
      const round = fromAST({ ...toAST(c), id: 7 })
      // id is added by fromAST; strip for comparison against the source.
      const { id, ...rest } = round
      expect(id).toBe(7)
      expect(rest).toEqual(c)
    })
  }
})

describe('buildSentence', () => {
  it('reads the edge example as plain English', () => {
    const s = sentence({
      name: 'x', enabled: true, mode: 'active', side: 'left', priority: 0,
      when: { type: 'agg', agg: 'avg', signal: '{side}.movement', window: 10, op: '>', value: 200 },
      ifs: [{ type: 'time', between: ['23:00', '06:00'] }],
      then: [{ action: 'setTemperature', delta: -2, revert: 20, clamp: [60, 75] }],
      cooldown: 30,
    })
    expect(s).toContain('left-side movement averages rises above 200 over the last 10 min')
    expect(s).toContain('it\'s between 11pm–6am')
    expect(s).toContain('lower temperature by 2°F for 20 min then revert')
    expect(s).toContain('wait 30 min before firing again')
  })
  it('reads the policy example with the clamp', () => {
    const s = sentence({
      name: 'x', enabled: true, mode: 'active', side: 'both', priority: 0,
      when: { type: 'time', between: ['23:00', '06:00'] }, ifs: [],
      then: [{ action: 'setTemperature', expr: 'ambient + 3', clamp: [60, 75] }], cooldown: 0,
    })
    expect(s).toContain('the clock reaches 11pm–6am')
    expect(s).toContain('set temperature to ambient + 3 (clamped 60–75°F)')
  })

  it('reads a threshold WHEN, condition IF, raise/notify/power THENs', () => {
    const s = sentence({
      name: 'x', enabled: true, mode: 'active', side: 'right', priority: 0,
      when: { type: 'cond', signal: '{side}.heartRate', op: '>', value: 70 },
      ifs: [{ type: 'cond', signal: '{side}.movement', op: '≥', value: 100 }],
      then: [
        { action: 'setTemperature', delta: 2, clamp: [60, 75] },
        { action: 'notify', message: 'hi' },
        { action: 'setPower', on: true },
      ],
      cooldown: 0,
    })
    expect(s).toContain('heart rate rises above 70bpm')
    expect(s).toContain('movement is at least 100')
    expect(s).toContain('raise temperature by 2°F')
    expect(s).toContain('send a notification')
    expect(s).toContain('turn power on')
  })

  it('reads a signal-change WHEN', () => {
    const s = sentence({
      name: 'x', enabled: true, mode: 'dryrun', side: 'both', priority: 0,
      when: { type: 'change', signal: 'water.low' }, ifs: [],
      then: [{ action: 'notify', message: '' }], cooldown: 0,
    })
    expect(s).toContain('water low changes')
  })
})

describe('parseExpr / printExpr — branch corners', () => {
  it('rejects an expression that fails the variable regex', () => {
    expect(parseExpr('3 + ambient', 'both')).toBeNull() // leading digit → no match
  })
  it('prints a signal with no friendly variable as its templatized key', () => {
    expect(printExpr({ kind: 'signal', signal: 'left.movement' }, 'left')).toBe('{side}.movement')
  })
  it('prints an unknown expr kind as an empty string', () => {
    expect(printExpr({ kind: 'bogus' } as unknown as Expr, 'both')).toBe('')
  })
})

describe('toAST — action branch corners', () => {
  const base = (then: BuilderRule['then']): BuilderRule => ({
    name: 'x', enabled: true, mode: 'active', side: 'left', priority: 0,
    when: { type: 'time', between: ['23:00', '06:00'] }, ifs: [], then, cooldown: 0,
  })

  it('defaults an empty notify message', () => {
    const ast = toAST(base([{ action: 'notify', message: '' }]))
    expect(ast.actions[0]).toEqual({ kind: 'notify', message: 'Autopilot notification' })
  })
  it('falls back to 72°F when an expression cannot be parsed', () => {
    const ast = toAST(base([{ action: 'setTemperature', expr: 'not valid!!', clamp: [60, 75] }]))
    expect(ast.actions[0]).toMatchObject({ kind: 'setTemperature', temp: { kind: 'literal', value: 72 } })
  })
  it('treats a missing delta as a zero-delta currentTemperature hold', () => {
    const ast = toAST(base([{ action: 'setTemperature', clamp: [60, 75] }]))
    expect(ast.actions[0]).toMatchObject({ temp: { kind: 'signal', signal: 'left.currentTemperature' } })
  })
  it('emits a + binary for a positive delta', () => {
    const ast = toAST(base([{ action: 'setTemperature', delta: 3, clamp: [60, 75] }]))
    expect(ast.actions[0]).toMatchObject({ temp: { kind: 'binary', op: '+', right: { kind: 'literal', value: 3 } } })
  })
  it('names an all-whitespace rule "Untitled automation"', () => {
    const ast = toAST({ ...base([{ action: 'notify', message: 'x' }]), name: '   ' })
    expect(ast.name).toBe('Untitled automation')
  })
})

describe('fromAST — branch corners', () => {
  const mk = (over: Partial<RuleAST>): RuleAST => ({
    name: 'n', enabled: true, side: null, priority: 0, dryRun: false, cooldownMin: null,
    trigger: { kind: 'tick', everyMin: 1 },
    conditions: { kind: 'and', conditions: [] },
    actions: [{ kind: 'notify', message: 'hi' }],
    ...over,
  })

  it('unwraps a top-level condition that is not an AND', () => {
    const b = fromAST(mk({ conditions: { kind: 'timeBetween', start: '23:00', end: '06:00' } }))
    expect(b.when).toEqual({ type: 'time', between: ['23:00', '06:00'] })
  })
  it('ignores a compare whose right side is not a literal', () => {
    const cond: Condition = { kind: 'compare', op: '>', left: { kind: 'signal', signal: 'left.heartRate' }, right: { kind: 'signal', signal: 'left.hrv' } }
    const b = fromAST(mk({ conditions: { kind: 'and', conditions: [cond] } }))
    expect(b.when).toEqual({ type: 'cond', signal: '{side}.movement', op: '>', value: 200 }) // unusable → default
    expect(b.ifs).toEqual([])
  })
  it('falls back to ">" for an unrecognized compare operator', () => {
    const cond = { kind: 'compare', op: '≈', left: { kind: 'signal', signal: 'left.heartRate' }, right: { kind: 'literal', value: 5 } } as unknown as Condition
    const b = fromAST(mk({ conditions: { kind: 'and', conditions: [cond] } }))
    expect(b.when).toMatchObject({ type: 'cond', op: '>' })
  })
  it('keeps a second time window as an IF when the first drives the WHEN', () => {
    const b = fromAST(mk({
      conditions: { kind: 'and', conditions: [
        { kind: 'timeBetween', start: '23:00', end: '06:00' },
        { kind: 'timeBetween', start: '12:00', end: '13:00' },
      ] },
    }))
    expect(b.when).toEqual({ type: 'time', between: ['23:00', '06:00'] })
    expect(b.ifs).toContainEqual({ type: 'time', between: ['12:00', '13:00'] })
  })
  it('defaults the clamp band when an action carries none', () => {
    const b = fromAST(mk({ actions: [{ kind: 'setTemperature', temp: { kind: 'literal', value: 72 }, clamp: undefined } as never] }))
    expect(b.then[0]).toMatchObject({ clamp: [60, 75] })
  })
  it('reads a zero-delta hold with no revert duration', () => {
    const b = fromAST(mk({ actions: [{ kind: 'setTemperature', temp: { kind: 'signal', signal: 'left.currentTemperature' }, clamp: { min: 60, max: 75 } }] }))
    expect(b.then[0]).toEqual({ action: 'setTemperature', delta: 0, revert: undefined, clamp: [60, 75] })
  })
  it('reads a positive delta binary with no revert duration', () => {
    const b = fromAST(mk({ actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: { kind: 'signal', signal: 'left.currentTemperature' }, right: { kind: 'literal', value: 2 } }, clamp: { min: 60, max: 75 } }] }))
    expect(b.then[0]).toEqual({ action: 'setTemperature', delta: 2, revert: undefined, clamp: [60, 75] })
  })
  it('falls back to an empty notify when the rule has no actions', () => {
    const b = fromAST(mk({ actions: [] }))
    expect(b.then).toEqual([{ action: 'notify', message: '' }])
  })
})

describe('label / clock helpers', () => {
  it('falls back to the bare key for an unknown signal label and unit', () => {
    expect(sigLabel('mystery.signal')).toBe('mystery.signal')
    expect(sigUnit('mystery.signal')).toBe('')
  })
  it('renders midnight as 12am and keeps non-zero minutes', () => {
    expect(fmtClock('00:00')).toBe('12am')
    expect(fmtClock('09:30')).toBe('9:30am')
  })
})

describe('buildSentence — remaining shapes', () => {
  const flat = (b: BuilderRule): string => buildSentence(b).map(c => c.text).join('')
  it('names a non-average aggregate and a delta-less raise', () => {
    const s = flat({
      name: 'x', enabled: true, mode: 'active', side: 'both', priority: 0,
      when: { type: 'agg', agg: 'max', signal: '{side}.movement', window: 10, op: '>', value: 200 },
      ifs: [], then: [{ action: 'setTemperature', clamp: [60, 75] }], cooldown: 0,
    })
    expect(s).toContain('movement max ')
    expect(s).toContain('raise temperature by 0°F')
  })
  it('reads a power-off action', () => {
    const s = flat({
      name: 'x', enabled: true, mode: 'active', side: 'both', priority: 0,
      when: { type: 'change', signal: 'water.low' }, ifs: [],
      then: [{ action: 'setPower', on: false }], cooldown: 0,
    })
    expect(s).toContain('turn power off')
  })
})

describe('printExpr — clamp passthrough', () => {
  it('prints a clamp by rendering its inner value', () => {
    const e: Expr = {
      kind: 'clamp',
      value: { kind: 'signal', signal: 'ambient.temperature' },
      min: { kind: 'literal', value: 60 },
      max: { kind: 'literal', value: 75 },
    }
    expect(printExpr(e, 'both')).toBe('ambient')
  })
})

describe('toAST — condition IFs', () => {
  it('maps a threshold IF to a signal compare', () => {
    const ast = toAST({
      name: 'x', enabled: true, mode: 'active', side: 'right', priority: 0,
      when: { type: 'time', between: ['23:00', '06:00'] },
      ifs: [{ type: 'cond', signal: '{side}.heartRate', op: '>', value: 60 }],
      then: [{ action: 'notify', message: 'hi' }], cooldown: 0,
    })
    expect(ast.conditions.kind === 'and' && ast.conditions.conditions).toContainEqual({
      kind: 'compare', op: '>', left: { kind: 'signal', signal: 'right.heartRate' }, right: { kind: 'literal', value: 60 },
    })
  })
})

describe('fromAST — edge cases', () => {
  it('falls back to a default WHEN when no compare or time condition drives the rule', () => {
    const ast: RuleAST = {
      name: 'n', enabled: true, side: null, priority: 0, dryRun: false, cooldownMin: null,
      trigger: { kind: 'tick', everyMin: 1 },
      conditions: { kind: 'and', conditions: [] },
      actions: [{ kind: 'notify', message: 'hi' }],
    }
    expect(fromAST(ast).when).toEqual({ type: 'cond', signal: '{side}.movement', op: '>', value: 200 })
  })

  it('ignores a non-threshold (binary-left) compare and exposes a generic action as an expression', () => {
    const ast: RuleAST = {
      name: 'n', enabled: true, side: null, priority: 0, dryRun: false, cooldownMin: null,
      trigger: { kind: 'tick', everyMin: 1 },
      conditions: {
        kind: 'and',
        conditions: [{ kind: 'compare', op: '>', left: { kind: 'binary', op: '+', left: { kind: 'signal', signal: 'ambient.temperature' }, right: { kind: 'literal', value: 1 } }, right: { kind: 'literal', value: 5 } }],
      },
      actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '*', left: { kind: 'signal', signal: 'ambient.temperature' }, right: { kind: 'literal', value: 2 } }, clamp: { min: 60, max: 75 } }],
    }
    const b = fromAST(ast)
    expect(b.when).toEqual({ type: 'cond', signal: '{side}.movement', op: '>', value: 200 }) // binary-left compare not usable → default
    expect(b.then[0]).toEqual({ action: 'setTemperature', expr: 'ambient * 2', clamp: [60, 75] })
  })

  it('pushes a leftover time window and a non-windowed compare into the IFs', () => {
    const ast: RuleAST = {
      name: 'n', enabled: true, side: null, priority: 0, dryRun: false, cooldownMin: null,
      trigger: { kind: 'tick', everyMin: 1 },
      conditions: {
        kind: 'and',
        conditions: [
          { kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }, right: { kind: 'literal', value: 200 } },
          { kind: 'timeBetween', start: '23:00', end: '06:00' },
          { kind: 'compare', op: '<', left: { kind: 'signal', signal: 'left.heartRate' }, right: { kind: 'literal', value: 50 } },
        ],
      },
      actions: [{ kind: 'notify', message: 'hi' }],
    }
    const b = fromAST(ast)
    expect(b.when.type).toBe('agg')
    expect(b.ifs).toContainEqual({ type: 'time', between: ['23:00', '06:00'] })
    expect(b.ifs).toContainEqual({ type: 'cond', signal: '{side}.heartRate', op: '<', value: 50 })
  })
})
