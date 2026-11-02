import { describe, expect, it } from 'vitest'
import { comfortEvent } from '../store'
import { previousForecastInput } from '../thermal-forecast-input'
import { thermalConfiguration } from '../thermal-dataset'

function fixture() {
  const at = Date.parse('2026-10-30T22:05:00Z')
  const context = { targetF: 70, waterF: 71, roomF: 73, humidity: 50 }
  const previous = { ...comfortEvent(at, 'preview', 'Synthetic observation'), eligible: false, session: 'night', thermalContext: context,
    thermalObservation: { version: 1 as const, purpose: 'comfort_research' as const, bedroomConfiguration: 'e'.repeat(64) },
    preview: { format: 1 as const, runId: '00000000-0000-4000-8000-000000000001', environment: 'production' as const,
      buildRevision: 'a'.repeat(40), hardwareIdentity: 'b'.repeat(64), session: 'night', start: at - 300_000,
      end: at + 8 * 3_600_000, timezone: 'UTC', scheduleRevision: 'c'.repeat(64),
      policy: { minimumF: 69, maximumF: 71, sensorAware: true, followBedtime: false, roomAware: true, offsetF: 0 },
      bedroom: { state: 'ready' as const, offsetF: 0 as const, reason: 'Fixture', sourceIds: ['temperature', 'humidity'], expiresAt: at + 60_000, configuration: 'e'.repeat(64) },
      scheduledBaselineF: 70, decisionBaselineF: 70, presence: 'occupied' as const, presenceSourceKey: 'd'.repeat(64),
      mechanicallyQuiet: true, deviceFresh: true, sensorReady: false, manualPaused: false } }
  const current = { at: at + 300_000, session: 'night', context: { ...context, waterF: 71.5 },
    configuration: thermalConfiguration(previous.preview, 'e'.repeat(64)) }
  return { previous, current }
}
describe('live water forecast input', () => {
  it('uses an actual matching predecessor without requiring HR labels', () => {
    const { previous, current } = fixture()
    expect(previousForecastInput(previous, current, previous.at)).toEqual({ ...current.context, change5mF: 0.5 })
  })
  it('rejects a different session, source, target, clock or database timestamp', () => {
    const { previous, current } = fixture()
    for (const changed of [{ ...current, session: 'another' }, { ...current, configuration: 'f'.repeat(64) },
      { ...current, at: current.at + 60_000 }, { ...current, at: previous.at - 1 },
      { ...current, context: { ...current.context, targetF: 71 } }]) {
      expect(previousForecastInput(previous, changed, previous.at)).toBeNull()
    }
    expect(previousForecastInput(previous, current, previous.at + 1)).toBeNull()
  })
  it('rejects manually paused, stale, disturbed or test-origin predecessors', () => {
    const { previous, current } = fixture()
    for (const changes of [{ manualPaused: true }, { deviceFresh: false }, { mechanicallyQuiet: false }, { environment: 'test' }]) {
      expect(previousForecastInput({ ...previous, preview: { ...previous.preview, ...changes } }, current, previous.at)).toBeNull()
    }
    expect(previousForecastInput({ ...previous, thermalObservation: undefined }, current, previous.at)).toBeNull()
    expect(previousForecastInput({ ...previous, preview: { ...previous.preview, bedroom: undefined } }, current, previous.at)).toBeNull()
    expect(previousForecastInput({ ...previous, preview: { ...previous.preview, bedroom: { ...previous.preview.bedroom, expiresAt: previous.at - 1 } } }, current, previous.at)).toBeNull()
    expect(previousForecastInput({ ...previous, thermalObservation: { ...previous.thermalObservation, sleepWindowEnd: current.at } }, current, previous.at)).toBeNull()
    expect(previousForecastInput(null, current, previous.at)).toBeNull()
  })
})
