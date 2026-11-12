import { randomUUID } from 'node:crypto'
import { beforeControlWrite } from '@/src/controls/context'
import { withSideLock } from '@/src/hardware/sideLock'
import type { Side } from '@/src/hardware/types'
import { createTemperatureApplicationRecorder } from '@/src/temperature/applications'
import { TemperatureController, type TemperatureControllerDeps, type TemperatureRequest } from '@/src/temperature/controller'
import { migratedComfortDatabase } from '../../tests/databaseFixture'
import { ExperimentApplicationAdapter, type ExperimentApplicationDeps, type ExperimentExecutionSnapshot } from '../application'
import type { ExperimentAdmission } from '../application-contract'
import { ExperimentApplicationStore } from '../applications'
import { experimentAuthorityRequestId, type ExperimentSample } from '../exposure'
import { createScheduledExperimentPlan, experimentNights, experimentPlanHash } from '../plan'
import { resolveExperimentSchedule } from '../schedule'
import { ComfortExperimentStore } from '../store'
import { context, createdAt, fixtureSchedule } from './fixture'

/** Real migrated stores and arbitration, synthetic admission/sensors and a two-write fake DAC. */
export function applicationFixture(filename = ':memory:') {
  const database = migratedComfortDatabase(filename)
  let now = createdAt, monotonic = 1000
  const plans = new ComfortExperimentStore(database, context.subjectKey, () => now)
  const schedule = resolveExperimentSchedule(fixtureSchedule(), '2026-11-13', createdAt)
  const proposed = createScheduledExperimentPlan(context, 69, schedule, createdAt)
  if (proposed.version !== 2) throw new Error('Expected scheduled fixture')
  const plan = { ...proposed, orders: ['baseline_first', 'baseline_first', 'variant_first', 'variant_first'] as typeof proposed.orders }
  plans.create(plan)
  const readRecord = () => {
    const record = plans.read(plan.id)
    if (!record) throw new Error('The fixture experiment is missing')
    return record
  }
  const window = plan.schedule.windows[2], night = experimentNights(plan)[2]
  now = window.windowStart + 60_000
  const journal = new ExperimentApplicationStore(database, () => now)
  const admission: ExperimentAdmission = { revision: randomUUID(), planHash: experimentPlanHash(plan),
    issuedAt: createdAt, expiresAt: plan.schedule.windows[plan.schedule.windows.length - 1].windowEnd, sides: ['left', 'right'] }
  const sample = (): ExperimentSample => ({ at: now, deviceAt: now, presenceAt: now, targetF: 70,
    powered: true, occupied: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false,
    bindingHash: context.bindingHash, routineHash: context.routineHash, wakeHash: context.wakeHash,
    selectedRequestId: null, attributionAmbiguous: false })
  const samples = { left: sample(), right: sample() }
  const settings = { enabled: true, adaptationSuspended: true, manualPausedUntil: 0, admission: admission as ExperimentAdmission | null }
  const baseline: TemperatureRequest = { id: 'scheduled-night', source: 'schedule', temperature: 70,
    startsAt: window.windowStart, expiresAt: window.windowEnd, createdAt: window.windowStart, priority: 0 }
  const baselines: Record<Side, TemperatureRequest[]> = { left: [baseline], right: [baseline] }
  const holds: Record<Side, TemperatureRequest | null> = { left: null, right: null }
  const deadlines: Record<Side, number | null> = { left: window.routineEnd, right: window.routineEnd }
  const writes: { side: Side, targetF: number, part: string }[] = []
  let beforeApply = async () => {}, betweenWrites = () => {}, reportTarget = true
  const advance = (milliseconds: number, fresh = true) => {
    now += milliseconds
    monotonic += Math.max(0, milliseconds)
    if (fresh) for (const side of ['left', 'right'] as const) samples[side].deviceAt = samples[side].presenceAt = now
  }
  const controllerDeps: TemperatureControllerDeps = {
    now: () => now, withSideLock,
    readHold: side => holds[side], writeHold: (side, hold) => { holds[side] = hold },
    readBaseline: side => baselines[side], isPowered: side => samples[side].powered,
    readCurrentTarget: side => samples[side].targetF, isBlocked: () => false,
    readHardwareDeadline: side => deadlines[side], writeHardwareDeadline: (side, at) => { deadlines[side] = at },
    connect: async () => {}, powerOff: async (side) => { samples[side].powered = false }, publish: () => {},
    onManualControl: () => { settings.manualPausedUntil = now + 6 * 3_600_000 },
    recordApplication: createTemperatureApplicationRecorder(database, () => now),
    apply: async (side, targetF) => {
      await beforeApply()
      beforeControlWrite()
      writes.push({ side, targetF, part: 'level' })
      betweenWrites()
      beforeControlWrite()
      writes.push({ side, targetF, part: 'duration' })
      advance(1, false)
      if (reportTarget) samples[side].targetF = targetF
      if (reportTarget) samples[side].deviceAt = now
    },
  }
  const authority = new TemperatureController(controllerDeps)
  const deps: ExperimentApplicationDeps = {
    now: () => now, monotonicNow: () => monotonic, withSideLock, authority,
    read: (side, at): ExperimentExecutionSnapshot => ({ ...settings, context,
      record: readRecord(), sample: { ...samples[side], at }, application: journal.latest(side) }),
    reserve: (reservation, current) => journal.reserve(reservation, current),
    finish: (reservation, receipt) => journal.finish(reservation, receipt),
  }
  return { database, plans, plan, window, night, journal, deps, controllerDeps, authority, record: readRecord, admission,
    adapter: new ExperimentApplicationAdapter(deps), samples, settings, writes, advance, holds, baselines,
    now: () => now, monotonic: (value: number) => { monotonic = value },
    selectedId: experimentAuthorityRequestId(plan, night.date),
    beforeApply: (work: () => Promise<void>) => { beforeApply = work },
    betweenWrites: (work: () => void) => { betweenWrites = work },
    reportTarget: (value: boolean) => { reportTarget = value },
  }
}
