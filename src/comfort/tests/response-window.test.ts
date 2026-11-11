import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { assessResponseWindow } from '../response-window'
import { responseFixture } from './responseFixture'

describe('observed small target response windows', () => {
  it.each([-1, 1] as const)('separates pre-command features from actual future outcomes (%s)', (direction) => {
    const fixture = responseFixture(direction)
    const result = assessResponseWindow(fixture.recording, fixture.application, [fixture.application], fixture.samples, fixture.now)
    expect(result.reason).toBeNull()
    expect(result.window).toMatchObject({ previousTargetF: 70, requestedTargetF: 70 + direction, waterBeforeF: 70, waterChange5mF: 0 })
    expect(result.window?.beforeAt).toBeLessThan(fixture.at)
    expect(result.window?.contextAt).toBeLessThan(fixture.at)
    expect(result.window?.confirmationAt).toBeGreaterThan(fixture.application.finishedAt ?? 0)
    expect(result.window?.outcomes.map(value => value.changeF)).toEqual([direction * 0.25, direction * 0.5])
    const changed = structuredClone(fixture.samples)
    for (const sample of changed) if (sample.at > fixture.at) sample.waterF = 74
    const second = assessResponseWindow(fixture.recording, fixture.application, [fixture.application], changed, fixture.now)
    expect(second.window?.waterBeforeF).toBe(result.window?.waterBeforeF)
    expect(second.window?.waterChange5mF).toBe(result.window?.waterChange5mF)
    expect(second.window?.outcomes.map(value => value.changeF)).toEqual([4, 4])
  })

  it.each(['invalid-date', 'missing-receipt', 'duplicate-receipt', 'conflicting-receipt', 'missing', 'duplicate', 'unpowered', 'water-null', 'target-null', 'wrong-target', 'two-degrees', 'unknown',
    'manual', 'wake', 'power-on', 'room-change', 'room-gap', 'late-confirmation', 'unfinished'])(
    'excludes %s evidence instead of inventing a response', (failure) => {
      const fixture = responseFixture()
      const receipts = [structuredClone(fixture.application)]
      if (failure === 'invalid-date') fixture.recording.date = '2026-02-31'
      if (failure === 'missing-receipt') receipts.pop()
      if (failure === 'duplicate-receipt') receipts.push(structuredClone(fixture.application))
      if (failure === 'conflicting-receipt') receipts[0].targetF = 72
      if (failure === 'missing') fixture.samples.splice(30, 4)
      if (failure === 'duplicate') fixture.samples.splice(30, 0, fixture.samples[30])
      if (failure === 'unpowered') fixture.samples[40].powered = false
      if (failure === 'water-null') fixture.samples[40].waterF = null
      if (failure === 'target-null') fixture.samples[40].targetF = null
      if (failure === 'wrong-target') fixture.samples[40].targetF = 69
      if (failure === 'two-degrees') fixture.application.targetF = 72
      if (failure === 'unknown') fixture.application.outcome = 'unknown'
      if (failure === 'manual') fixture.application.source = 'manual'
      if (failure === 'wake') fixture.application.comfortLimit = { state: 'wake', requestedF: 71, targetF: 71, minF: 69, maxF: 71, revision: 1, wakeUntil: fixture.at + 3_600_000 }
      if (failure === 'power-on') fixture.application.reason = 'power_on'
      if (failure === 'room-change') fixture.recording.samples[40].context.roomF = 80
      if (failure === 'room-gap') fixture.recording.samples.splice(37, 2)
      if (failure === 'late-confirmation') fixture.application.finishedAt = fixture.at + 31_000
      if (failure === 'unfinished') fixture.now = fixture.at + 1_800_000
      expect(assessResponseWindow(fixture.recording, fixture.application, receipts, fixture.samples, fixture.now).window).toBeNull()
    })

  it('allows confirmed same-target keepalives but rejects competing or unresolved commands', () => {
    const fixture = responseFixture()
    const other = { ...fixture.application, attemptId: randomUUID(), id: 2, attemptedAt: fixture.at + 60_000,
      finishedAt: fixture.at + 60_100, reason: 'keepalive' as const }
    const check = () => assessResponseWindow(fixture.recording, fixture.application, [fixture.application, other], fixture.samples, fixture.now)
    expect(check().window).not.toBeNull()
    other.targetF = 70
    expect(check().reason).toContain('overlaps')
    other.targetF = 71
    other.outcome = 'unknown'
    expect(check().window).toBeNull()
  })

  it.each([Number.NaN, 0, -1, Infinity, 8_640_000_000_000_001])('rejects an invalid evaluation clock %s', (now) => {
    const fixture = responseFixture()
    expect(assessResponseWindow(fixture.recording, fixture.application, [fixture.application], fixture.samples, now).window).toBeNull()
  })
})
