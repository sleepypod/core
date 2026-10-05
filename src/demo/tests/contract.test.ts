/**
 * Every demo handler must honour the real router's contract: its input is
 * parsed by the router's own zod input schema (defaults applied, exactly as
 * the server would), and its result must pass the router's zod output schema.
 * This catches runtime drift that the type-level `DemoHandlers` check can't
 * (refinements, enums, ranges, nullability).
 */

import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { appRouter } from '@/src/server/routers/app'
import { demoRouters } from '../handlers'

interface ProcedureDef {
  type: 'query' | 'mutation'
  inputs: ZodType[]
  output?: ZodType
}

const procedures = appRouter._def.procedures as unknown as Record<string, { _def: ProcedureDef }>

type Handler = (input: unknown) => unknown
const handlerFor = (path: string): Handler => {
  const [router, procedure] = path.split('.')
  return (demoRouters as unknown as Record<string, Record<string, Handler>>)[router][procedure]
}

async function call<T = unknown>(path: string, ...args: [raw?: unknown]): Promise<T> {
  const raw = args.length > 0 ? args[0] : {}
  const def = procedures[path]._def
  const input = def.inputs[0] ? def.inputs[0].parse(raw) : raw
  const result = await handlerFor(path)(input)
  if (def.output) {
    const parsed = def.output.safeParse(result)
    if (!parsed.success) throw new Error(`${path} output violates the router schema: ${parsed.error.message}`)
  }
  return result as T
}

const allPaths = Object.entries(demoRouters).flatMap(([router, handlers]) =>
  Object.keys(handlers).map(procedure => `${router}.${procedure}`))

const acceptsEmptyInput = (path: string) => {
  const input = procedures[path]._def.inputs[0]
  return !input || input.safeParse({}).success
}

describe('demo handlers honour the real router contracts', () => {
  it('only implement procedures that exist on the real router', () => {
    expect(allPaths.filter(p => !procedures[p])).toEqual([])
  })

  it.each(allPaths.filter(p => procedures[p]?._def.type === 'query' && acceptsEmptyInput(p)))(
    '%s (default input)', async (path) => {
      await expect(call(path)).resolves.toBeDefined()
    },
  )

  it('base demo mutations match the hardware API and schedule output contracts', async () => {
    await call('base.reconnect')
    await call('base.setPosition', { head: 20, feet: 10 })
    await call('base.setPreset', { preset: 'relax' })
    await call('base.stop')
    const row = await call<{ id: number }>('base.saveSchedule', {
      dayOfWeek: 'tuesday', time: '23:15', head: 30, feet: 15, enabled: true,
    })
    await call('base.saveSchedule', { ...row, enabled: false })
    await call('base.getSchedules')
    await call('base.deleteSchedule', { id: row.id })
  })

  describe('queries with required input', () => {
    for (const side of ['left', 'right'] as const) {
      it(`answer per-side reads for ${side}`, async () => {
        const now = Date.now()
        const day = 24 * 3600_000
        await call('device.getTemperatureControl', { side })
        await call('biometrics.getLatestSleep', { side })
        await call('biometrics.getVitalsSummary', { side })
        await call('biometrics.getMovementBuckets', { side, bucketSeconds: 300 })
        await call('biometrics.getMovementSummary', { side })
        await call('biometrics.getSleepStages', { side })
        await call('calibration.getStatus', { side })
        await call('calibration.getHistory', { side })
        await call('calibration.getVitalsQuality', { side })
        await call('schedules.getAll', { side, unit: 'C' })
        await call('schedules.getByDay', { side, dayOfWeek: 'monday', unit: 'C' })
        await call('automations.nights', { side })
        await call('automations.capZoneReplay', { side })
        await call('environment.getSummary', { startDate: new Date(now - day), endDate: new Date(now) })
        await call('environment.getAmbientLightSummary', { startDate: new Date(now - day), endDate: new Date(now) })
        await call('system.getLogs', { unit: 'sleepypod-core.service', priority: 'err' })
      })
    }

    it('reports live occupancy', async () => {
      await call('biometrics.getOccupancy', undefined)
    })

    it('look up sleep records and stages by id', async () => {
      const records = await call<Array<{ id: number, side: 'left' | 'right' }>>('biometrics.getSleepRecords')
      expect(records.length).toBeGreaterThan(0)
      const { id, side } = records[0]
      await call('biometrics.getSleepRecord', { id })
      await call('biometrics.getSleepStages', { side, sleepRecordId: id })
    })

    it('page database rows for a real table', async () => {
      const overview = await call<{ databases: Array<{ key: 'sleepypod' | 'biometrics', tables: Array<{ name: string }> }> }>('databases.overview')
      for (const db of overview.databases) {
        await call('databases.rows', { db: db.key, table: db.tables[0].name })
      }
    })

    it('backtest and replay an existing automation', async () => {
      const [rule] = await call<Array<{ id: number, side: 'left' | 'right' | null, cooldownMin: number | null, trigger: unknown, conditions: unknown, actions: unknown[] }>>('automations.list')
      await call('automations.get', { id: rule.id })
      const ruleInput = { side: rule.side, cooldownMin: rule.cooldownMin, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions }
      await call('automations.backtest', { side: rule.side ?? 'left', rule: ruleInput })
      await call('automations.backtestRange', { rule: ruleInput })
      const nights = await call<Array<{ startMs: number }>>('automations.nights', { side: 'left' })
      await call('automations.activity', { nightStarts: nights.map(n => Math.floor(n.startMs)).slice(0, 3) })
    })
  })

  describe('mutations persist into later reads', () => {
    it('drives the device', async () => {
      await call('device.setTemperature', { side: 'left', temperature: 70, holdMinutes: 30 })
      const status = await call<{ temperatureControl: { left: { source: string, holdUntil: number | null } } }>('device.getStatus', { unit: 'F' })
      expect(status.temperatureControl.left.source).toBe('manual')
      expect(status.temperatureControl.left.holdUntil).not.toBeNull()

      await call('device.resumeTemperature', { side: 'left' })
      await call('device.setPower', { side: 'right', powered: false })
      const off = await call<{ rightSide: { targetTemperature: number | null } }>('device.getStatus', { unit: 'C' })
      expect(off.rightSide.targetTemperature).toBeNull()
      await call('device.setPower', { side: 'right', powered: true, temperature: 80 })

      await call('device.setAlarm', { side: 'left', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 30 })
      await call('device.snoozeAlarm', { side: 'left', duration: 300 })
      await call('device.clearAlarm', { side: 'left' })
      await call('device.startPriming')
      await call('device.dismissPrimeNotification')
    })

    it('edits schedules', async () => {
      const created = await call<{ id: number }>('schedules.createTemperatureSchedule', { side: 'left', dayOfWeek: 'monday', time: '23:15', temperature: 66 })
      await call('schedules.updateTemperatureSchedule', { id: created.id, temperature: 65 })
      const power = await call<{ id: number }>('schedules.createPowerSchedule', { side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 70 })
      await call('schedules.updatePowerSchedule', { id: power.id, offTime: '07:30' })
      const alarm = await call<{ id: number }>('schedules.createAlarmSchedule', { side: 'left', dayOfWeek: 'monday', time: '06:30', vibrationIntensity: 40, duration: 60, alarmTemperature: 78 })
      await call('schedules.updateAlarmSchedule', { id: alarm.id, time: '06:45' })
      await call('schedules.batchUpdate', {})

      await call('schedules.deleteTemperatureSchedule', { id: created.id })
      await call('schedules.deletePowerSchedule', { id: power.id })
      await call('schedules.deleteAlarmSchedule', { id: alarm.id })
      const after = await call<{ temperature: Array<{ id: number }> }>('schedules.getAll', { side: 'left' })
      expect(after.temperature.map(s => s.id)).not.toContain(created.id)
    })

    it('edits settings and gestures', async () => {
      await call('settings.updateDevice', { ledNightModeEnabled: false })
      await call('settings.updateSide', { side: 'right', name: 'Riley' })
      await call('settings.setAlwaysOn', { side: 'right', alwaysOn: false })
      await call('settings.setGesture', { side: 'right', tapType: 'quadTap', actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 120 })
      await call('settings.deleteGesture', { side: 'right', tapType: 'quadTap' })
      const settings = await call<{ sides: { right: { name: string } } }>('settings.getAll')
      expect(settings.sides.right.name).toBe('Riley')
    })

    it('manages automations', async () => {
      const [rule] = await call<Array<{ id: number, name: string, trigger: unknown, conditions: unknown, actions: unknown[] }>>('automations.list')
      const created = await call<{ id: number }>('automations.create', { name: 'Test copy', trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions })
      await call('automations.update', { id: created.id, name: 'Renamed copy' })
      await call('automations.setEnabled', { id: created.id, enabled: false })
      await call('automations.setDryRun', { id: created.id, dryRun: true })
      await call('automations.setKillSwitch', { enabled: false })
      await call('automations.setKillSwitch', { enabled: true })
      await call('automations.delete', { id: created.id })
      const after = await call<Array<{ id: number }>>('automations.list')
      expect(after.map(r => r.id)).not.toContain(created.id)
    })

    it('edits and deletes sleep records', async () => {
      const records = await call<Array<{ id: number, timesExitedBed: number }>>('biometrics.getSleepRecords')
      const { id } = records[records.length - 1]
      await call('biometrics.updateSleepRecord', { id, timesExitedBed: 3 })
      await expect(call<{ timesExitedBed: number }>('biometrics.getSleepRecord', { id })).resolves.toMatchObject({ timesExitedBed: 3 })
      await call('biometrics.deleteSleepRecord', { id })
      await expect(call('biometrics.getSleepRecord', { id })).resolves.toBeNull()
    })

    it('handles system, integration and alert actions', async () => {
      await call('archivePush.generateKey')
      await call('archivePush.setConfig', { enabled: true, host: 'backup.example', remoteUser: 'sleepypod', remotePath: '/srv/pod', port: 22, identity: 'id_ed25519', include: ['db'] })
      await call('archivePush.testConnection')
      await call('mqtt.updateSettings', { enabled: true })
      await call('mqtt.testConnection', { url: 'mqtt://192.0.2.20:1883' })
      await call('homekit.setEnabled', { enabled: false })
      await call('homekit.unpair')
      await call('system.setInternetAccess', { blocked: false })
      await call('system.freeStorage')
      await call('system.triggerUpdate')
      await call('health.restartService', { unit: 'sleepypod-piezo-processor.service' })
      await call('databases.checkIntegrity')
      await call('calibration.triggerCalibration', { side: 'left', sensorType: 'piezo' })
      await call('calibration.triggerFullCalibration')

      const [alert] = await call<Array<{ id: number }>>('pumpAlerts.list')
      await call('pumpAlerts.dismissAlert', { id: alert.id })
      await call('pumpAlerts.dismissNotification', { side: 'left' })
      await call('pumpAlerts.acknowledgeAndRestore', { side: 'left' })

      const files = await call<Array<{ name: string }>>('raw.files')
      await expect(call('raw.deleteFile', { filename: files[files.length - 1].name })).resolves.toMatchObject({ deleted: true })
      await expect(call('raw.deleteFile', { filename: files[0].name })).resolves.toMatchObject({ deleted: false })
    })

    it('rejects unknown waterLevel alerts like the real router', async () => {
      await expect(call('waterLevel.dismissAlert', { id: 999_999 })).rejects.toThrow()
    })
  })
})
