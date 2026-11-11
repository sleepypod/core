import { describe, expect, it } from 'vitest'
import { bedCareSchema, careCheckCurrent } from '../contract'
import { evaluateBedCare, type CareSources } from '../evaluate'

const now = 1_800_000_000_000
function required<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error('Fixture value missing')
  return value
}
function sources(): CareSources {
  return { now, hardware: { at: now - 10_000, water: 'ok', priming: false }, blockedSides: [], protectionEnabled: true, lastExportAt: now - 86_400_000 + 0.75,
    recording: { apiVersion: 1, generatedAt: now - 15_000, expiresAt: now + 10_000, state: 'ready', summary: 'Ready', historicalWindowHours: 24,
      checks: [{ id: 'sensor-cap', title: 'Presence', state: 'ok', detail: 'Fresh source', nextStep: null, observedAt: now - 15_000 },
        { id: 'storage', title: 'Storage', state: 'ok', detail: '600 MB available', nextStep: null, observedAt: now - 15_000 }] } }
}
describe('bed care observations', () => {
  it('keeps timestamps independent and distinguishes an export from a recovery guarantee', () => {
    const report = bedCareSchema.parse(evaluateBedCare(sources()))
    expect(report.lastExportAt).toBe(now - 86_400_000)
    expect(report.checks.find(check => check.id === 'backup')?.detail).toContain('not verified')
    const water = required(report.checks.find(check => check.id === 'water'))
    const recording = required(report.checks.find(check => check.id === 'recording'))
    expect(careCheckCurrent(water, now + 15_000)).toBe(true)
    expect(careCheckCurrent(recording, now + 15_000)).toBe(false)
    expect(careCheckCurrent(water, now + 30_000)).toBe(false)
  })
  it.each([now + 1, now - 31_000, NaN])('withdraws invalid hardware time %s without hiding an active protection', (at) => {
    const input = sources()
    required(input.hardware).at = at
    input.blockedSides = ['left']
    const report = evaluateBedCare(input)
    expect(report.checks.find(check => check.id === 'water')).toMatchObject({ state: 'unknown', observedAt: null, expiresAt: null })
    expect(report.checks.find(check => check.id === 'circulation')).toMatchObject({ state: 'attention' })
  })
  it('distinguishes low water from in-progress priming without claiming a detected leak', () => {
    const input = sources()
    required(input.hardware).priming = true
    expect(evaluateBedCare(input).checks[0].state).toBe('busy')
    required(input.hardware).water = 'low'
    expect(evaluateBedCare(input).checks[0]).toMatchObject({ state: 'attention', detail: 'The Pod reports low water.' })
  })
  it('preserves failed processors and low storage as separate actions', () => {
    const input = sources()
    required(input.recording).checks[0] = { id: 'sleep-detector', title: 'Processor', state: 'attention', detail: 'Processor is down', nextStep: 'Inspect logs', observedAt: now }
    required(input.recording).checks[1].state = 'attention'
    const report = evaluateBedCare(input)
    expect(report.checks.find(check => check.id === 'recording')?.evidence[0].detail).toContain('Inspect logs')
    expect(report.checks.find(check => check.id === 'storage')?.state).toBe('attention')
  })
  it.each([null, now + 1, Infinity, -1])('does not invent a valid backup from %s', (lastExportAt) => {
    const report = evaluateBedCare({ ...sources(), lastExportAt })
    expect(report.lastExportAt).toBeNull()
    expect(report.checks.find(check => check.id === 'backup')?.state).toBe('unknown')
  })
  it('keeps missing sources unknown and expires a recording response independently', () => {
    const input = sources()
    input.hardware = null
    input.blockedSides = null
    required(input.recording).expiresAt = now
    const report = evaluateBedCare(input)
    expect(report.checks.filter(check => check.id !== 'backup').every(check => check.state === 'unknown')).toBe(true)
    expect(report.checks.find(check => check.id === 'recording')?.evidence).toEqual([])
  })
  it('reports disabled and unreadable protection settings without implying a healthy pump', () => {
    const disabled = evaluateBedCare({ ...sources(), protectionEnabled: false }).checks[1]
    expect(disabled).toMatchObject({ state: 'attention', detail: 'Automatic pump-stall protection is turned off.' })
    expect(evaluateBedCare({ ...sources(), protectionEnabled: null }).checks[1].state).toBe('unknown')
    const blocked = evaluateBedCare({ ...sources(), protectionEnabled: null, blockedSides: ['right'] }).checks[1]
    expect(blocked.state).toBe('attention')
    expect(blocked.detail).toContain('Right')
  })
})
