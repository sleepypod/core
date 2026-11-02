import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { thermalObservation } from '../thermal-observation'
import { capturePreviewEvidence } from '../report-evidence'
import { defaultComfortState, type ComfortContext, type ComfortState } from '../policy'
import { missingComfortSignals } from '../signals'

function fixture() {
  const now = Date.parse('2026-10-30T08:00:00Z')
  const state: ComfortState = { ...defaultComfortState(), config: { mode: 'preview', minimumF: 68, maximumF: 72, roomAware: true, sensorAware: true } }
  const context: ComfortContext = {
    now, window: { session: 'night', segment: 'night:baseline', start: now - 3600000, end: now + 6 * 3600000,
      baselineF: 70, alarmAt: now + 5 * 3600000, phases: { revision: 'a'.repeat(64), startF: 70, changes: [] } },
    device: { observedAt: now, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false, targetF: 70 },
    presence: { observedAt: now, available: true, occupied: true, entry: { measuredAt: now, sourceKey: 'b'.repeat(64), state: 'present' } },
    eitherAway: false, routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true,
    signals: missingComfortSignals('Low signal'),
    bedroom: { state: 'ready', reason: 'Room readings available', sourceIds: ['temperature', 'humidity'], offsetF: 0,
      expiresAt: now + 60000, configuration: 'c'.repeat(64) },
    thermalContext: { targetF: 70, waterF: 71, roomF: 74, humidity: 45 },
  }
  const capture = () => capturePreviewEvidence(state, context, 70, 'America/Los_Angeles', randomUUID(),
    { environment: 'production', buildRevision: 'd'.repeat(40), hardwareIdentity: 'e'.repeat(64) })
  return { state, context, capture }
}

describe('thermal research admission stays independent from actuator admission', () => {
  it('admits observed thermal context without using HR or inferred body temperature', () => {
    const { state, context, capture } = fixture()
    expect(thermalObservation(state, context, capture())).toEqual({ version: 1, purpose: 'comfort_research',
      bedroomConfiguration: 'c'.repeat(64), sleepWindowEnd: context.now + 4.5 * 3600000 })
  })
  it.each([
    ['off', (state: ComfortState) => { state.config.mode = 'off' }],
    ['active', (state: ComfortState) => { state.config.mode = 'active' }],
    ['manual pause', (state: ComfortState) => { state.pausedUntil = Number.MAX_SAFE_INTEGER }],
    ['room response off', (state: ComfortState) => { state.config.roomAware = false }],
  ] as const)('withholds research when %s', (_name, change) => {
    const { state, context, capture } = fixture()
    change(state)
    expect(thermalObservation(state, context, capture())).toBeNull()
  })
  it.each([
    ['power off', (context: ComfortContext) => { context.device.powered = false }],
    ['low water', (context: ComfortContext) => { context.device.waterAdequate = false }],
    ['priming', (context: ComfortContext) => { context.device.priming = true }],
    ['base unknown', (context: ComfortContext) => { context.device.baseMoving = null }],
    ['vibration', (context: ComfortContext) => { context.device.vibrating = true }],
    ['stale hardware', (context: ComfortContext) => { context.device.observedAt = context.now - 16000 }],
    ['empty bed', (context: ComfortContext) => { context.presence.occupied = false }],
    ['unattributed presence', (context: ComfortContext) => { context.presence.entry = undefined }],
    ['alarm warming', (context: ComfortContext) => { if (context.window) context.window.alarmAt = context.now + 1800000 }],
    ['alarm change', (context: ComfortContext) => { context.alarmOverride = true }],
    ['unexpected target', (context: ComfortContext) => { context.targetKnown = false }],
    ['away', (context: ComfortContext) => { context.eitherAway = true }],
    ['routine pause', (context: ComfortContext) => { context.routinesPaused = true }],
    ['stale room', (context: ComfortContext) => { if (context.bedroom) context.bedroom.expiresAt = context.now }],
    ['mismatched thermal target', (context: ComfortContext) => { if (context.thermalContext) context.thermalContext.targetF = 71 }],
  ] as const)('excludes %s rather than label it a usable comfort example', (_name, change) => {
    const { state, context, capture } = fixture()
    change(context)
    expect(thermalObservation(state, context, capture())).toBeNull()
  })
})
