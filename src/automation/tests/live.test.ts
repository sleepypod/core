import { describe, expect, it } from 'vitest'
import { readRuleLive } from '../live'
import { WindowStore } from '../windows'
import type { AutomationRule, Expr } from '../types'

const sig: Expr = { kind: 'signal', signal: 'ambient.temperature' }
const literal: Expr = { kind: 'literal', value: 3 }
const ctx = { signal: () => 69, windows: new WindowStore(), nowMs: 0, nowMinutes: 0, dayOfWeek: 'monday' as const }
const rule: AutomationRule = { id: 1, name: 'Policy', enabled: true, dryRun: true, side: null, priority: 0, cooldownMin: null, trigger: { kind: 'tick', everyMin: 1 }, conditions: { kind: 'and', conditions: [] }, actions: [] }

describe('readRuleLive', () => {
  it('finds a primary comparison after schedule conditions in an AND', () => {
    const live = readRuleLive({ ...rule, conditions: { kind: 'and', conditions: [{ kind: 'timeBetween', start: '23:00', end: '06:00' }, { kind: 'compare', op: '>', left: sig, right: literal }] } }, ctx)
    expect(live).toMatchObject({ signal: 'ambient.temperature', value: 69, threshold: 3, matched: true })
  })
  it('does not claim a single comparison represents OR or NOT', () => {
    const condition = { kind: 'compare' as const, op: '>' as const, left: sig, right: literal }
    expect(readRuleLive({ ...rule, conditions: { kind: 'or', conditions: [condition] } }, ctx)).toBeNull()
    expect(readRuleLive({ ...rule, conditions: { kind: 'not', condition } }, ctx)).toBeNull()
  })
  it('shows a change-trigger value without inventing a threshold', () => {
    expect(readRuleLive({ ...rule, trigger: { kind: 'signalChange', signal: 'water.low' } }, ctx)).toMatchObject({ signal: 'water.low', value: 69, threshold: null, matched: null })
  })
  it('finds the policy input through clamp and arithmetic expressions', () => {
    const expr: Expr = { kind: 'clamp', value: { kind: 'binary', op: '+', left: literal, right: sig }, min: literal, max: literal }
    expect(readRuleLive({ ...rule, actions: [{ kind: 'notify', message: 'test' }, { kind: 'setTemperature', temp: expr }] }, ctx)).toMatchObject({ signal: 'ambient.temperature', value: 69, op: null })
    expect(readRuleLive({ ...rule, actions: [{ kind: 'setPower', on: true }, { kind: 'setTemperature', temp: literal }] }, ctx)).toBeNull()
  })
})
