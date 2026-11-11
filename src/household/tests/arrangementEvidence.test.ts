import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PodVersion } from '@/src/hardware/types'
import { readArrangementAlarmFile, validateArrangementEvidence, type ArrangementEvidenceSources } from '../arrangementEvidence'

const now = Date.UTC(2026, 10, 11, 12)
const runId = randomUUID()
let sources: ArrangementEvidenceSources
let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'arrangement-evidence-'))
  const presence = { occupied: false, classification: 'none' as const, available: true,
    movement: { active: false, peakScore: 0 },
    level: { active: false, deviation: 0, threshold: 100, ageMs: 1000, sampleAt: now - 1000, sourceKey: 'a'.repeat(64), zoneDeviations: [0, 0, 0], zones: 0 },
    vitals: { heartRate: null, breathingRate: null, humanRange: null } }
  const side = { currentTemperature: 70, targetTemperature: 70, currentLevel: 0, targetLevel: 0, heatingDuration: 0 }
  sources = {
    controller: { version: 1, invocationId: 'a'.repeat(32), bootId: randomUUID(), pid: 1000, startTicks: '5000', observedAt: now - 100 },
    presence: { left: structuredClone(presence), right: structuredClone(presence) },
    device: { status: { leftSide: { ...side }, rightSide: { ...side }, waterLevel: 'ok', isPriming: false, podVersion: PodVersion.POD_4, sensorLabel: 'fixture' },
      observedAt: now - 1500, synchronized: true,
      mirrors: [{ side: 'left', is_powered: 0, is_alarm_vibrating: 0 }, { side: 'right', is_powered: 0, is_alarm_vibrating: 0 }] },
    alarms: { disk: { alarms: {}, snoozes: {} }, memory: { alarms: {}, snoozes: {} }, active: false, snoozing: false },
    base: { state: 'connected', stale: false, lastUpdate: now - 2000, moving: false, busy: false,
      movingBySide: { left: false, right: false }, independentControl: false, splitBase: false,
      position: { left: { head: 0, feet: 0 }, right: { head: 0, feet: 0 } }, error: null },
  }
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

describe('actual-source arrangement evidence', () => {
  it('keeps each original sensor timestamp and the older of the two empty-bed samples', () => {
    sources.presence.right.level.sampleAt = now - 4000
    expect(validateArrangementEvidence(runId, sources, now).observation).toEqual({ runId,
      presence: { observedAt: now - 4000, left: 'empty', right: 'empty' },
      thermal: { observedAt: now - 1500, leftPowered: false, rightPowered: false, water: 'ok', priming: false },
      alarm: { observedAt: now, vibrating: false, snoozing: false }, base: { observedAt: now - 2000, state: 'stationary' } })
  })
  it.each(['left', 'right'] as const)('rejects unknown, occupied and uncalibrated %s readings', (side) => {
    for (const change of [
      () => { sources.presence[side].available = false },
      () => { sources.presence[side].occupied = true },
      () => { sources.presence[side].classification = 'light' },
      () => { sources.presence[side].level.active = true },
      () => { sources.presence[side].movement.active = true },
      () => { sources.presence[side].level.sourceKey = '' },
    ]) {
      const original = structuredClone(sources)
      change()
      expect(() => validateArrangementEvidence(runId, sources, now)).toThrow('empty-bed')
      sources = original
    }
  })
  it.each(['presence', 'device', 'base', 'controller'] as const)('rejects missing, future and expired %s measurement clocks', (source) => {
    for (const clock of [null, now + 1, now - 5001, Number.NaN]) {
      const original = structuredClone(sources)
      if (source === 'presence') sources.presence.left.level.sampleAt = clock ?? undefined
      if (source === 'device') sources.device.observedAt = clock
      if (source === 'base' && sources.base) sources.base.lastUpdate = clock
      if (source === 'controller') sources.controller = { ...(sources.controller as object), observedAt: clock }
      expect(() => validateArrangementEvidence(runId, sources, now)).toThrow()
      sources = original
    }
  })
  it.each(['missing', 'powered', 'water', 'priming', 'unsynced', 'duplicate-side', 'vibrating'] as const)('rejects %s thermal/controller state', (issue) => {
    const status = sources.device.status
    if (!status) throw new Error('Missing fixture device')
    if (issue === 'missing') sources.device.status = null
    if (issue === 'powered') status.leftSide.heatingDuration = 60
    if (issue === 'water') status.waterLevel = 'low'
    if (issue === 'priming') status.isPriming = true
    if (issue === 'unsynced') sources.device.synchronized = false
    if (issue === 'duplicate-side') sources.device.mirrors = [{ side: 'left', is_powered: 0, is_alarm_vibrating: 0 }, { side: 'left', is_powered: 0, is_alarm_vibrating: 0 }]
    if (issue === 'vibrating') sources.device.mirrors = [{ side: 'left', is_powered: 0, is_alarm_vibrating: 1 }, { side: 'right', is_powered: 0, is_alarm_vibrating: 0 }]
    expect(() => validateArrangementEvidence(runId, sources, now)).toThrow()
  })
  it.each(['disk', 'memory'] as const)('does not turn absent, malformed or pending %s alarms into quiet evidence', (source) => {
    for (const state of [null, {}, { alarms: {}, snoozes: [] }, { alarms: { left: { until: now - 1 } }, snoozes: {} }, { alarms: {}, snoozes: { right: { until: now + 1 } } }]) {
      sources.alarms[source] = state
      expect(() => validateArrangementEvidence(runId, sources, now)).toThrow('vibration')
    }
  })
  it.each(['active', 'snoozing'] as const)('retains in-memory %s even when the disk is empty', (field) => {
    sources.alarms[field] = true
    expect(() => validateArrangementEvidence(runId, sources, now)).toThrow('vibration')
  })
  it.each(['missing', 'unconfigured', 'disconnected', 'stale', 'moving', 'busy', 'unknown-side'] as const)('does not call a %s base stationary or unsupported', (issue) => {
    const base = sources.base
    if (!base) throw new Error('Missing fixture base')
    if (issue === 'missing') sources.base = null
    if (issue === 'unconfigured') base.state = 'unconfigured'
    if (issue === 'disconnected') base.state = 'disconnected'
    if (issue === 'stale') base.stale = true
    if (issue === 'moving') base.moving = true
    if (issue === 'busy') base.busy = true
    if (issue === 'unknown-side') base.movingBySide.right = null
    expect(() => validateArrangementEvidence(runId, sources, now)).toThrow('base')
  })
  it('reads a real bounded alarm file and rejects absent, corrupt and oversized files', () => {
    const filename = join(folder, 'alarm-state.json')
    expect(() => readArrangementAlarmFile(filename)).toThrow()
    writeFileSync(filename, JSON.stringify({ alarms: {}, snoozes: {} }))
    expect(readArrangementAlarmFile(filename)).toEqual({ alarms: {}, snoozes: {} })
    writeFileSync(filename, '{broken')
    expect(() => readArrangementAlarmFile(filename)).toThrow()
    writeFileSync(filename, ' '.repeat(65537))
    expect(() => readArrangementAlarmFile(filename)).toThrow()
  })
})
