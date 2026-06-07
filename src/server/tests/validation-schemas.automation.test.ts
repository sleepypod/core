import { describe, expect, it } from 'vitest'
import {
  automationActionSchema,
  automationConditionSchema,
  automationCreateSchema,
  automationExprSchema,
  automationTriggerSchema,
  automationUpdateSchema,
} from '../validation-schemas'
import type { Condition, Expr } from '@/src/automation/types'

const sig = (signal: string): Expr => ({ kind: 'signal', signal })
const lit = (value: number): Expr => ({ kind: 'literal', value })

describe('automationExprSchema', () => {
  it('accepts each expression node kind', () => {
    expect(automationExprSchema.safeParse(lit(72)).success).toBe(true)
    expect(automationExprSchema.safeParse(sig('left.movement')).success).toBe(true)
    expect(automationExprSchema.safeParse({ kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }).success).toBe(true)
    expect(automationExprSchema.safeParse({ kind: 'binary', op: '+', left: sig('ambient.temperature'), right: lit(3) }).success).toBe(true)
    expect(automationExprSchema.safeParse({ kind: 'clamp', value: lit(72), min: lit(60), max: lit(75) }).success).toBe(true)
  })

  it('rejects a non-dotted signal key and an unknown kind', () => {
    expect(automationExprSchema.safeParse({ kind: 'signal', signal: 'bad key!' }).success).toBe(false)
    expect(automationExprSchema.safeParse({ kind: 'nope' }).success).toBe(false)
  })

  it('bounds the window lastMin to 1..1440', () => {
    expect(automationExprSchema.safeParse({ kind: 'window', fn: 'sum', signal: 'left.hrv', lastMin: 0 }).success).toBe(false)
    expect(automationExprSchema.safeParse({ kind: 'window', fn: 'sum', signal: 'left.hrv', lastMin: 1441 }).success).toBe(false)
  })

  it('rejects unknown extra keys (strict)', () => {
    expect(automationExprSchema.safeParse({ kind: 'literal', value: 1, extra: true }).success).toBe(false)
  })
})

describe('automationConditionSchema', () => {
  it('accepts a nested boolean tree', () => {
    const cond: Condition = {
      kind: 'and',
      conditions: [
        { kind: 'or', conditions: [{ kind: 'compare', op: '>', left: sig('left.movement'), right: lit(200) }] },
        { kind: 'not', condition: { kind: 'timeBetween', start: '23:00', end: '06:00' } },
        { kind: 'between', subject: sig('left.hrv'), min: lit(0), max: lit(100) },
        { kind: 'onDays', days: ['saturday', 'sunday'] },
      ],
    }
    expect(automationConditionSchema.safeParse(cond).success).toBe(true)
  })

  it('rejects a bad time string and an empty onDays list', () => {
    expect(automationConditionSchema.safeParse({ kind: 'timeBetween', start: '24:00', end: '06:00' }).success).toBe(false)
    expect(automationConditionSchema.safeParse({ kind: 'onDays', days: [] }).success).toBe(false)
  })

  it('caps a boolean group at 24 children', () => {
    const many = Array.from({ length: 25 }, () => ({ kind: 'compare', op: '>', left: sig('left.movement'), right: lit(1) }))
    expect(automationConditionSchema.safeParse({ kind: 'and', conditions: many }).success).toBe(false)
  })
})

describe('automationTriggerSchema', () => {
  it('accepts tick / signalChange / timeOfDay', () => {
    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 1 }).success).toBe(true)
    expect(automationTriggerSchema.safeParse({ kind: 'signalChange', signal: 'water.low' }).success).toBe(true)
    expect(automationTriggerSchema.safeParse({ kind: 'timeOfDay', at: '23:00', days: ['monday'] }).success).toBe(true)
  })

  it('rejects an out-of-range tick interval', () => {
    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 0 }).success).toBe(false)
    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 1441 }).success).toBe(false)
  })
})

describe('automationActionSchema', () => {
  it('accepts notify / setTemperature / setPower', () => {
    expect(automationActionSchema.safeParse({ kind: 'notify', message: 'hi' }).success).toBe(true)
    expect(automationActionSchema.safeParse({ kind: 'setTemperature', temp: lit(72), clamp: { min: 60, max: 75 } }).success).toBe(true)
    expect(automationActionSchema.safeParse({ kind: 'setPower', on: true, temp: lit(72) }).success).toBe(true)
  })

  it('rejects an empty notify message and an over-long one', () => {
    expect(automationActionSchema.safeParse({ kind: 'notify', message: '' }).success).toBe(false)
    expect(automationActionSchema.safeParse({ kind: 'notify', message: 'x'.repeat(281) }).success).toBe(false)
  })

  it('rejects a clamp whose min exceeds max', () => {
    expect(automationActionSchema.safeParse({ kind: 'setTemperature', temp: lit(72), clamp: { min: 80, max: 70 } }).success).toBe(false)
  })
})

describe('automationCreateSchema', () => {
  const base = {
    name: 'Restless cool-down',
    trigger: { kind: 'tick', everyMin: 1 },
    conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }, right: lit(200) }] },
    actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '-', left: sig('left.currentTemperature'), right: lit(2) }, clamp: { min: 60, max: 75 } }],
  }

  it('parses a valid rule and applies defaults', () => {
    const parsed = automationCreateSchema.parse(base)
    expect(parsed.enabled).toBe(true)
    expect(parsed.dryRun).toBe(true)
    expect(parsed.side).toBeNull()
    expect(parsed.priority).toBe(0)
    expect(parsed.cooldownMin).toBeNull()
  })

  it('requires at least one action and caps at ten', () => {
    expect(automationCreateSchema.safeParse({ ...base, actions: [] }).success).toBe(false)
    const eleven = Array.from({ length: 11 }, () => ({ kind: 'notify', message: 'x' }))
    expect(automationCreateSchema.safeParse({ ...base, actions: eleven }).success).toBe(false)
  })

  it('rejects an AST that exceeds the node budget', () => {
    // Build a left-leaning binary chain well past AUTOMATION_MAX_AST_NODES (400).
    let temp: Expr = sig('left.currentTemperature')
    for (let i = 0; i < 250; i++) temp = { kind: 'binary', op: '+', left: temp, right: lit(1) }
    const res = automationCreateSchema.safeParse({ ...base, actions: [{ kind: 'setTemperature', temp, clamp: { min: 60, max: 75 } }] })
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error.issues.some(i => i.message.includes('too large'))).toBe(true)
  })

  it('measures clamp expressions and between conditions when enforcing bounds', () => {
    const res = automationCreateSchema.safeParse({
      ...base,
      conditions: {
        kind: 'and',
        conditions: [
          { kind: 'between', subject: sig('left.hrv'), min: lit(0), max: lit(100) },
          { kind: 'timeBetween', start: '23:00', end: '06:00' },
        ],
      },
      actions: [{
        kind: 'setTemperature',
        temp: { kind: 'clamp', value: { kind: 'binary', op: '+', left: sig('ambient.temperature'), right: lit(3) }, min: lit(60), max: lit(75) },
        clamp: { min: 60, max: 75 },
      }],
    })
    expect(res.success).toBe(true)
  })

  it('rejects an AST that exceeds the depth budget', () => {
    // A deep but small-node nested NOT chain trips depth (16) before nodes (400).
    let cond: Condition = { kind: 'compare', op: '>', left: sig('left.movement'), right: lit(1) }
    for (let i = 0; i < 20; i++) cond = { kind: 'not', condition: cond }
    const res = automationCreateSchema.safeParse({ ...base, conditions: cond })
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error.issues.some(i => i.message.includes('too deep'))).toBe(true)
  })
})

describe('automationUpdateSchema', () => {
  it('requires an id and accepts a partial payload', () => {
    expect(automationUpdateSchema.safeParse({ name: 'rename' }).success).toBe(false) // no id
    expect(automationUpdateSchema.safeParse({ id: 5, enabled: false }).success).toBe(true)
  })

  it('still enforces AST bounds on the partial actions/conditions', () => {
    let temp: Expr = sig('left.currentTemperature')
    for (let i = 0; i < 250; i++) temp = { kind: 'binary', op: '+', left: temp, right: lit(1) }
    expect(automationUpdateSchema.safeParse({ id: 5, actions: [{ kind: 'setTemperature', temp, clamp: { min: 60, max: 75 } }] }).success).toBe(false)
  })
})
