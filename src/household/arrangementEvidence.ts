import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { z } from 'zod'
import { controllerGenerationSchema, readControllerGeneration, type ControllerGeneration } from '@/src/server/controllerGeneration'
import type { DeviceStatus } from '@/src/hardware/types'
import type { BaseStatus } from '@/src/hardware/base/types'
import type { OccupancyResult } from '@/src/lib/occupancy'
import { arrangementObservationSchema, type ArrangementObservation } from './arrangementTransitionContract'
import { HouseholdError } from './store'

const MAX_AGE_MS = 5000
const sideState = z.object({ side: z.enum(['left', 'right']), is_powered: z.literal(0), is_alarm_vibrating: z.literal(0) }).strict()
const inactiveAlarms = z.object({
  alarms: z.object({ left: z.undefined().optional(), right: z.undefined().optional() }).strict(),
  snoozes: z.object({ left: z.undefined().optional(), right: z.undefined().optional() }).strict(),
}).strict()

export interface ArrangementEvidence {
  observation: ArrangementObservation
  controller: ControllerGeneration
}
export interface ArrangementEvidenceSources {
  controller: unknown
  presence: Record<'left' | 'right', OccupancyResult>
  device: { status: DeviceStatus | null, observedAt: number | null, synchronized: boolean, mirrors: unknown }
  alarms: { disk: unknown, memory: unknown, active: boolean, snoozing: boolean }
  base: BaseStatus | null
}
const unavailable = (message: string) => new HouseholdError('conflict', 409, message)

/** Each source keeps its actual measurement clock. Reading it again does not renew its freshness. */
export function validateArrangementEvidence(runId: string, sources: ArrangementEvidenceSources, now: number): ArrangementEvidence {
  const fresh = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= now && now - value <= MAX_AGE_MS
  const controller = controllerGenerationSchema.parse(sources.controller)
  if (!Number.isSafeInteger(now) || now <= 0 || !fresh(controller.observedAt)) throw unavailable('The current controller generation needs a fresh check.')
  const sampleTimes: number[] = []
  for (const side of ['left', 'right'] as const) {
    const presence = sources.presence[side]
    if (!presence?.available || presence.occupied !== false || presence.classification !== 'none'
      || presence.movement.active !== false || presence.level.active !== false || !fresh(presence.level.sampleAt)
      || !/^[a-f0-9]{64}$/.test(presence.level.sourceKey ?? '')) {
      throw unavailable('Both bed zones need fresh calibrated empty-bed readings.')
    }
    sampleTimes.push(presence.level.sampleAt)
  }
  const { device, alarms, base } = sources
  const mirrors = z.array(sideState).length(2).safeParse(device.mirrors)
  if (!fresh(device.observedAt) || !device.synchronized || !device.status || !mirrors.success
    || new Set(mirrors.data.map(row => row.side)).size !== 2
    || device.status.leftSide.heatingDuration !== 0 || device.status.rightSide.heatingDuration !== 0
    || device.status.waterLevel !== 'ok' || device.status.isPriming !== false) {
    throw unavailable('Confirm both zones are off, the water level is adequate and priming has stopped.')
  }
  // Firmware does not report vibration. Require consistent quiet controller records;
  // this is not physical vibration verification, and never replaces attendance.
  if (alarms.active || alarms.snoozing || !inactiveAlarms.safeParse(alarms.disk).success || !inactiveAlarms.safeParse(alarms.memory).success) {
    throw unavailable('Clear pending vibration and snooze alarms before changing the arrangement.')
  }
  if (!base || base.state !== 'connected' || base.stale || !fresh(base.lastUpdate)
    || base.moving !== false || base.busy || base.movingBySide.left !== false || base.movingBySide.right !== false) {
    throw unavailable('A fresh stationary base reading is required. Missing configuration does not prove that no base is attached.')
  }
  return { controller, observation: arrangementObservationSchema.parse({ runId,
    presence: { observedAt: Math.min(...sampleTimes), left: 'empty', right: 'empty' },
    thermal: { observedAt: device.observedAt, leftPowered: false, rightPowered: false, water: 'ok', priming: false },
    alarm: { observedAt: now, vibrating: false, snoozing: false },
    base: { observedAt: base.lastUpdate, state: 'stationary' },
  }) }
}

/** Missing/corrupt alarm persistence cannot become an empty record during maintenance. */
export function readArrangementAlarmFile(filename: string): unknown {
  const descriptor = openSync(filename, 'r')
  try {
    const size = fstatSync(descriptor).size
    if (!Number.isSafeInteger(size) || size < 2 || size > 65536) throw unavailable('The saved alarm state could not be verified.')
    const buffer = Buffer.alloc(size + 1)
    const count = readSync(descriptor, buffer, 0, buffer.length, 0)
    if (count !== size || fstatSync(descriptor).size !== size) throw unavailable('The saved alarm state changed during verification.')
    return JSON.parse(buffer.subarray(0, count).toString('utf8'))
  }
  finally { closeSync(descriptor) }
}

/** Inspect existing readers only; never initialize Bluetooth, start a controller or send a command. */
export async function readArrangementEvidence(runId: string): Promise<ArrangementEvidence> {
  const [{ sqlite }, { getDacMonitorIfRunning }, { getOccupancy }, { hasFirmwareSynced },
    { alarmStatePath, loadAlarmState }, { getActiveAlarmConfig }, { getSnoozeStatus }, { getBaseControllerIfRunning }] = await Promise.all([
    import('@/src/db'), import('@/src/hardware/dacMonitor.instance'), import('@/src/lib/occupancy'), import('@/src/hardware/sideMutations'),
    import('@/src/hardware/alarmPersistence'), import('@/src/hardware/alarmState'), import('@/src/hardware/snoozeManager'), import('@/src/hardware/base/instance'),
  ])
  const controller = await readControllerGeneration()
  const monitor = getDacMonitorIfRunning()
  const sides = ['left', 'right'] as const
  return validateArrangementEvidence(runId, {
    controller, presence: { left: getOccupancy('left'), right: getOccupancy('right') },
    device: { status: monitor?.getFreshStatus(MAX_AGE_MS) ?? null, observedAt: monitor?.getLastPollAt() ?? null,
      synchronized: hasFirmwareSynced(), mirrors: sqlite.prepare('SELECT side, is_powered, is_alarm_vibrating FROM device_state').all() },
    alarms: { disk: readArrangementAlarmFile(alarmStatePath()), memory: loadAlarmState(),
      active: sides.some(side => getActiveAlarmConfig(side) !== null), snoozing: sides.some(side => getSnoozeStatus(side).active) },
    base: getBaseControllerIfRunning()?.status() ?? null,
  }, Date.now())
}
