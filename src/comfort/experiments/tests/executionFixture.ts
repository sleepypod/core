import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { beforeControlWrite } from '@/src/controls/context'
import type { Side } from '@/src/hardware/types'
import { createComfortLimitStore } from '@/src/temperature/limitStore'
import { TemperatureController, type TemperatureRequest } from '@/src/temperature/controller'
import { createTemperatureApplicationRecorder } from '@/src/temperature/applications'
import { ownerFixture } from '../../tests/ownerFixture'
import { qualificationSchema } from '../../owner-contract'
import { readExperimentAvailability, type ExperimentAccess } from '../access'
import { ExperimentExecutionHost, type ExperimentExecutionDeps } from '../execution'
import { createScheduledExperimentPlan, experimentPlanHash } from '../plan'
import { resolveExperimentSchedule } from '../schedule'
import { ComfortExperimentStore } from '../store'
import { fixtureSchedule } from './fixture'
import type { ExperimentPrincipal } from '../execution-principal'

/** Qualified synthetic history, real controller/storage, fake firmware; never a production qualification. */
export async function executionFixture() {
  const test = ownerFixture()
  await test.ready()
  const { database } = test
  database.exec(`INSERT INTO device_settings (id, bed_mode, unused_zone_mode, timezone) VALUES (1, 'solo-left', 'follow', 'UTC');
    INSERT INTO side_settings (side, name) VALUES ('left', 'Left'), ('right', 'Right');`)
  const source = fixtureSchedule()
  for (const row of source.powers) database.prepare(`INSERT INTO power_schedules
    (side, day_of_week, on_time, off_time, off_day_offset, on_temperature) VALUES ('left', ?, ?, ?, 1, 75)`)
    .run(row.dayOfWeek, row.onTime, row.offTime)
  for (const row of source.alarm.rows) database.prepare(`INSERT INTO alarm_schedules
    (side, day_of_week, time, duration, alarm_temperature, vibration_intensity) VALUES ('left', ?, ?, 20, 105, 50)`).run(row.dayOfWeek, row.time)
  createComfortLimitStore(database).save('left', 0, { enabled: true, minF: 70, maxF: 76 })
  const access: ExperimentAccess = { subjectKey: '1'.repeat(64), scope: { syntheticAccount: 'left-person' },
    binding: { syntheticAssignment: 1 }, routineSide: 'left', ready: true }
  const availability = readExperimentAvailability(database, access)
  if (!availability.context || !availability.schedule) throw new Error('Missing synthetic schedules')
  const proposed = createScheduledExperimentPlan(availability.context, 74,
    resolveExperimentSchedule(availability.schedule, '2026-11-06', test.now()), test.now())
  if (proposed.version !== 2) throw new Error('Expected scheduled fixture')
  const plan = { ...proposed, orders: ['variant_first', 'variant_first', 'baseline_first', 'baseline_first'] as typeof proposed.orders }
  const plans = new ComfortExperimentStore(database, access.subjectKey, test.now)
  plans.create(plan)
  const principal: ExperimentPrincipal = { kind: 'personal', deviceId: randomUUID() }
  const sample = { targetF: 75, powered: true, occupied: true, deviceAt: test.now(), presenceAt: test.now() }
  const samples = { left: sample, right: { ...sample } }
  const zones: Side[] = ['left']
  const baseline: TemperatureRequest = { id: 'night', source: 'schedule', temperature: 75, startsAt: test.now(),
    expiresAt: plan.schedule.windows[plan.schedule.windows.length - 1].windowEnd, createdAt: test.now(), priority: 0 }
  const baselines = [baseline]
  const writes = vi.fn<(side: Side, targetF: number) => void>()
  let deadline: number | null = baseline.expiresAt
  let monotonic = 1, admitted = true, pendingPause: number | null = null
  let beforeApply = async () => {}
  const authority = new TemperatureController({ now: test.now, withSideLock: test.deps.withSideLock,
    readHold: () => null, writeHold: () => {}, readBaseline: () => baselines,
    isPowered: side => samples[side].powered, readCurrentTarget: side => samples[side].targetF, isBlocked: () => false,
    readHardwareDeadline: () => deadline, writeHardwareDeadline: (_side, value) => { deadline = value },
    connect: async () => {}, powerOff: async () => {}, publish: () => {},
    recordApplication: createTemperatureApplicationRecorder(database, test.now),
    apply: async (side, targetF) => {
      await beforeApply()
      beforeControlWrite()
      writes(side, targetF)
      samples[side].targetF = targetF
    } })
  const deps: ExperimentExecutionDeps = { database, now: test.now, monotonicNow: () => monotonic,
    enabled: () => admitted, pendingManualPause: () => pendingPause,
    subject: () => {
      if (!admitted) throw new Error('Device revoked')
      return access.subjectKey
    },
    resolve: () => {
      if (!admitted) throw new Error('Device revoked')
      return { access, zones }
    }, owner: test.owner, withSideLock: test.deps.withSideLock, authority,
    sample: (side, at, context) => ({ ...samples[side], at, waterAdequate: true, priming: false, vibrating: false, baseMoving: false,
      bindingHash: context.bindingHash, routineHash: context.routineHash, wakeHash: context.wakeHash,
      selectedRequestId: null, attributionAmbiguous: false }) }
  const host = new ExperimentExecutionHost(deps)
  await host.start()
  const advance = (at: number) => {
    monotonic += Math.max(0, at - test.now())
    test.refresh(at)
    for (const item of Object.values(samples)) item.deviceAt = item.presenceAt = at
  }
  const admit = async () => {
    const review = await host.prepare(principal, plan.id, () => {})
    return host.confirm(principal, review.id, experimentPlanHash(plan), () => {})
  }
  // These copied records are synthetic test observations, never an attended or live qualification.
  const qualifyRight = async () => {
    const proof = await test.owner.experimentEvidence('left')
    test.store.commit('right', test.store.read('left'))
    for (const row of database.prepare('SELECT record FROM comfort_qualifications WHERE side = ?').all('left') as { record: string }[]) {
      const record = { ...qualificationSchema.parse(JSON.parse(row.record)), id: randomUUID() }
      database.prepare('INSERT INTO comfort_qualifications (id, side, kind, record) VALUES (?, ?, ?, ?)')
        .run(record.id, 'right', record.kind, JSON.stringify(record))
    }
    database.prepare(`INSERT INTO comfort_events (side, observed_at, event, report_id)
      SELECT 'right', observed_at, event, report_id FROM comfort_events WHERE side = 'left' AND report_id IS NOT NULL`).run()
    for (const night of proof.nights) {
      const detail = await test.reports.detail('right', night.summary.id)
      await test.reports.review({ side: 'right', id: night.summary.id, digest: detail.summary.digest,
        expectedReviewId: null, outcome: 'reviewed', confirmedActualNight: true, note: 'Synthetic second-zone history.' })
    }
    zones.push('right')
  }
  return { ...test, access, plan, plans, principal, host, deps, admit, advance, sample, samples, writes, baselines, authority, qualifyRight,
    admitted: (value: boolean) => { admitted = value },
    pendingPause: (value: number | null) => { pendingPause = value },
    beforeApply: (work: () => Promise<void>) => { beforeApply = work } }
}
