import { describe, expect, it } from 'vitest'
import { NODES, type DataPathState } from '@/src/lib/dataPath'
import type { HealthHistory } from '@/src/lib/healthHistory'
import { evaluateRecordingHealth, MINIMUM_RECORDING_FREE_BYTES } from '../evaluate'
import { recordingHealthSchema } from '../contract'
import { assessPresenceBreaks } from '../fragmentation'

const now = Date.UTC(2026, 10, 10, 22)
function fixture() {
  const path: DataPathState = { at: now - 1000, occupancy: { left: 'empty', right: 'empty' },
    nodes: NODES.map(node => ({ ...node, status: 'ok', metric: 'recent', detail: 'Fresh output.', lastOutputAt: now - 1000 })),
    edges: [], verdict: { tone: 'ok', headline: 'Data flows', nodeId: null, lastGoodId: null, fix: null, also: [] } }
  const history: HealthHistory = { from: now - 24 * 3_600_000, to: now, recordedSince: now - 3_600_000,
    checks: [{ id: 'sensor-cap', label: 'Presence', runs: [], healthyShare: 1, incidents: 0 }], incidents: [], gaps: [] }
  const start = now / 1000 - 9 * 3600, end = now / 1000 - 3600
  const presenceBreaks = assessPresenceBreaks([{ side: 'left', start, end, present: JSON.stringify([[start, end]]), absent: '[]' }], now)
  return { now, path, history, presenceBreaks, storage: { availableBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 }, recordingDatabaseReadable: true }
}

describe('recording readiness', () => {
  it('requires actual current checks and distinguishes equipment from sleep quality', () => {
    const result = recordingHealthSchema.parse(evaluateRecordingHealth(fixture()))
    expect(result.state).toBe('ready')
    expect(result.checks).toHaveLength(8)
    expect(result.summary).toBe('Recording checks are ready')
    expect(result.expiresAt).toBe(now - 1000 + 60_000)
  })

  it('treats an idle processor in an empty bed as expected', () => {
    const input = fixture()
    input.path.nodes.forEach((node) => {
      if (node.id === 'piezo-processor') node.status = 'idle'
    })
    expect(evaluateRecordingHealth(input).state).toBe('ready')
  })

  it('surfaces a sensor failure with a useful next step', () => {
    const input = fixture()
    input.path.nodes.forEach((node) => {
      if (node.id === 'sensor-cap') node.status = 'stale'
    })
    const result = evaluateRecordingHealth(input)
    expect(result.state).toBe('attention')
    expect(result.checks[0]).toMatchObject({ state: 'attention', nextStep: expect.stringContaining('cover connection') })
  })

  it.each([now + 1, now - 60_001, Number.NaN])('does not trust a bad snapshot timestamp %s', (at) => {
    const input = fixture()
    input.path.at = at
    const result = evaluateRecordingHealth(input)
    expect(result.state).toBe('unknown')
    expect(result.checks.slice(0, 5).every(check => check.state === 'unknown' && check.observedAt === null)).toBe(true)
  })

  it('does not accept a future sensor timestamp even if the old diagnostic says ok', () => {
    const input = fixture()
    input.path.nodes[0].lastOutputAt = now + 1000
    expect(evaluateRecordingHealth(input).state).toBe('unknown')
  })

  it('checks recording access separately from configuration database health', () => {
    const input = fixture()
    input.recordingDatabaseReadable = false
    const result = evaluateRecordingHealth(input)
    expect(result.state).toBe('attention')
    expect(result.checks.find(check => check.id === 'database')?.state).toBe('ok')
    expect(result.checks.find(check => check.id === 'recording-database')?.state).toBe('attention')
  })

  it('requires output evidence for a sensor or processor marked ok', () => {
    const input = fixture()
    input.path.nodes[0].lastOutputAt = null
    expect(evaluateRecordingHealth(input).state).toBe('unknown')
  })

  it.each([0, MINIMUM_RECORDING_FREE_BYTES - 1, 300 * 1024 ** 2])('warns before recording storage is exhausted (%s bytes)', (availableBytes) => {
    const input = fixture()
    input.storage.availableBytes = availableBytes
    expect(evaluateRecordingHealth(input).checks.find(check => check.id === 'storage')?.state).toBe('attention')
  })

  it.each([null, { availableBytes: -1, totalBytes: 100 }, { availableBytes: 101, totalBytes: 100 }])('leaves missing or impossible storage unknown', (storage) => {
    expect(evaluateRecordingHealth({ ...fixture(), storage }).checks.find(check => check.id === 'storage')?.state).toBe('unknown')
  })

  it('identifies repeated presence-signal loss without calling it time awake', () => {
    const input = fixture()
    input.history.incidents = [1, 2].map(index => ({ checkId: 'sensor-cap', label: 'Presence', status: 'stale',
      start: now - index * 3_600_000, end: now - index * 3_600_000 + 600_000, detail: 'Frames stopped' }))
    const result = evaluateRecordingHealth(input)
    const check = result.checks.find(item => item.id === 'presence-history')
    expect(check?.state).toBe('attention')
    expect(check?.detail).toContain('2 presence-signal interruptions')
    expect(check?.detail).toContain('does not prove time awake')
  })

  it('does not call missing history zero interruptions', () => {
    const result = evaluateRecordingHealth({ ...fixture(), history: null })
    expect(result.state).toBe('unknown')
    expect(result.checks.at(-1)?.detail).toContain('Not enough monitoring history')
  })

  it('withdraws historical conclusions when the history response is stale or future-dated', () => {
    for (const timestamp of [now - 60_001, now + 1000]) {
      const input = fixture()
      input.history.to = timestamp
      expect(evaluateRecordingHealth(input).checks.at(-1)?.state).toBe('unknown')
    }
  })

  it('flags clustered explicit breaks even while the sensor stream remains healthy', () => {
    const input = fixture()
    input.presenceBreaks.sides[0].shortBreaks = 4
    input.presenceBreaks.sides[0].mostInOneHour = 3
    const result = recordingHealthSchema.parse(evaluateRecordingHealth(input))
    expect(result.checks).toHaveLength(8)
    expect(result.checks[0].state).toBe('ok')
    expect(result.checks.at(-1)).toMatchObject({ state: 'attention', detail: expect.stringContaining('genuine exits and inconsistent sensing') })
    expect(result.checks.at(-1)?.nextStep).toContain('changes neither')
    expect(result.checks.at(-1)?.detail).toContain('solo-anywhere')
  })

  it.each([null, { ...fixture().presenceBreaks, status: 'unavailable' as const },
    { ...fixture().presenceBreaks, status: 'partial' as const }, assessPresenceBreaks([], now)])('keeps incomplete interval review unknown (%j)', (presenceBreaks) => {
    const result = evaluateRecordingHealth({ ...fixture(), presenceBreaks })
    expect(result.checks.at(-1)?.state).toBe('unknown')
    if (presenceBreaks?.status === 'partial') {
      expect(result.checks.at(-1)?.detail).toContain('usable completed intervals')
      expect(result.checks.at(-1)?.detail).toContain('Some interval evidence was excluded')
    }
    else { expect(result.checks.at(-1)?.detail).not.toContain('0 short reported breaks') }
  })

  it('withdraws expired or future interval analysis and expires at its original observation', () => {
    const input = fixture()
    for (const observedAt of [now - 60_001, now + 1]) {
      input.presenceBreaks.observedAt = observedAt
      expect(evaluateRecordingHealth(input).checks.at(-1)?.state).toBe('unknown')
    }
    input.presenceBreaks.observedAt = now - 20_000
    expect(evaluateRecordingHealth(input).expiresAt).toBe(now + 40_000)
  })
})
