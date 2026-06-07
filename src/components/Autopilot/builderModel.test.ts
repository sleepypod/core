import { describe, expect, it } from 'vitest'
import {
  blankRule,
  buildSentence,
  type BuilderRule,
  fromAST,
  parseExpr,
  printExpr,
  toAST,
} from './builderModel'

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
})
