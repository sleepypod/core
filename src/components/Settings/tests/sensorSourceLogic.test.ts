import { describe, expect, it } from 'vitest'
import {
  FIRST_FRAME_GRACE_MS,
  FRAME_STALE_MS,
  sensorSourceVerdict,
  type SensorSourceVerdictInput,
} from '../sensorSourceLogic'

const base: SensorSourceVerdictInput = {
  source: 'nats',
  expectedTransport: 'nats',
  override: null,
  legacyNatsDisabled: false,
  lastFrameAgeMs: 2_000,
  uptimeSeconds: 600,
}

describe('sensorSourceVerdict', () => {
  it('reports live when frames are fresh and the pick matches the firmware', () => {
    const v = sensorSourceVerdict(base)
    expect(v).toMatchObject({ tone: 'ok', status: 'Live', note: null })
    expect(v.summary).toBe('Reading NATS stream. Last frame 2s ago.')
  })

  it('is muted while the source is still being chosen', () => {
    const v = sensorSourceVerdict({ ...base, source: 'pending', lastFrameAgeMs: null })
    expect(v.tone).toBe('muted')
    expect(v.status).toBe('Choosing')
  })

  it('gives a fresh process a grace period before silence is a warning', () => {
    const early = sensorSourceVerdict({ ...base, lastFrameAgeMs: null, uptimeSeconds: (FIRST_FRAME_GRACE_MS / 1000) - 1 })
    expect(early).toMatchObject({ tone: 'muted', status: 'Waiting' })
    const late = sensorSourceVerdict({ ...base, lastFrameAgeMs: null, uptimeSeconds: FIRST_FRAME_GRACE_MS / 1000 })
    expect(late).toMatchObject({ tone: 'warn', status: 'No frames' })
    expect(late.summary).toContain('no frames have arrived')
  })

  it('flags a stall once the last frame is older than the stale window', () => {
    const v = sensorSourceVerdict({ ...base, source: 'raw', expectedTransport: 'raw', lastFrameAgeMs: FRAME_STALE_MS + 1_000 })
    expect(v).toMatchObject({ tone: 'danger', status: 'Stalled', note: null })
    expect(v.summary).toBe('Reading .RAW files. No frames for 61s.')
  })

  it('explains a fallback when the pick disagrees with the firmware', () => {
    const v = sensorSourceVerdict({ ...base, source: 'raw' })
    expect(v.tone).toBe('ok') // freshness still decides the tone
    expect(v.note).toContain('Firmware looks like NATS firmware, but the stream fell back to .RAW files')
    const reverse = sensorSourceVerdict({ ...base, source: 'nats', expectedTransport: 'raw' })
    expect(reverse.note).toContain('Firmware looks like .RAW firmware, but the stream fell back to NATS stream')
    // A pending pick is not a mismatch yet, even when an override is absent.
    expect(sensorSourceVerdict({ ...base, source: 'pending', expectedTransport: 'raw', lastFrameAgeMs: null }).note).toBeNull()
  })

  it('names the env override instead of calling it a mismatch', () => {
    expect(sensorSourceVerdict({ ...base, source: 'raw', override: 'raw' }).note)
      .toBe('PIEZO_SENSOR_SOURCE=raw forces this source regardless of firmware.')
    expect(sensorSourceVerdict({ ...base, source: 'raw', legacyNatsDisabled: true }).note)
      .toBe('PIEZO_NATS_DISABLED=1 forces .RAW files regardless of firmware.')
    // An override that matches the firmware is still worth saying.
    expect(sensorSourceVerdict({ ...base, override: 'nats' }).note).toContain('PIEZO_SENSOR_SOURCE=nats')
  })
})
