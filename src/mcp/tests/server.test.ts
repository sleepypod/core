/**
 * MCP server tests. The tRPC caller is replaced with a fake so each tool's
 * argument mapping, unit conversion and error surfacing can be checked
 * without hardware or databases.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callerMock = vi.hoisted(() => {
  const fn = () => vi.fn()
  return {
    device: {
      getStatus: fn(), setTemperature: fn(), setPower: fn(), resumeTemperature: fn(),
      setAlarm: fn(), clearAlarm: fn(), snoozeAlarm: fn(), startPriming: fn(),
    },
    settings: { getAll: fn(), updateSide: fn(), updateDevice: fn() },
    schedules: {
      getAll: fn(), createTemperatureSchedule: fn(), createPowerSchedule: fn(), createAlarmSchedule: fn(),
      updateTemperatureSchedule: fn(), updatePowerSchedule: fn(), updateAlarmSchedule: fn(),
      deleteTemperatureSchedule: fn(), deletePowerSchedule: fn(), deleteAlarmSchedule: fn(),
    },
    biometrics: {
      getLatestSleep: fn(), getSleepRecord: fn(), getSleepRecords: fn(), getSleepStages: fn(), getVitalsSummary: fn(),
      getMovementSummary: fn(), getVitalsBaseline: fn(), getOccupancy: fn(), importReferenceVitals: fn(), importReferenceStages: fn(),
      getReferenceStages: fn(), getReferenceVitals: fn(), getVitals: fn(),
    },
    sleepStages: { getClassifier: fn(), previewClassifier: fn(), setClassifier: fn() },
    environment: {
      getSummary: fn(), getAmbientLightSummary: fn(), getLatestBedTemp: fn(), getLatestFreezerTemp: fn(),
      getLatestAmbientLight: fn(),
    },
    health: { system: fn(), hardware: fn(), thermal: fn(), restartService: fn() },
    waterLevel: { getLatest: fn(), getAlerts: fn(), dismissAlert: fn() },
    pumpAlerts: { list: fn(), acknowledgeAndRestore: fn() },
    system: { getDiskUsage: fn(), getVersion: fn(), internetStatus: fn(), getLogs: fn(), freeStorage: fn(), triggerUpdate: fn() },
    runOnce: { start: fn(), getActive: fn(), cancel: fn() },
    automations: {
      status: fn(), tonight: fn(), list: fn(), setEnabled: fn(), setDryRun: fn(), setKillSwitch: fn(),
      delete: fn(), create: fn(), update: fn(),
    },
    databases: { checkIntegrity: fn() },
  }
})

vi.mock('@/src/server/routers/app', () => ({
  appRouter: { createCaller: () => callerMock },
}))

import { createSleepypodMcpServer } from '@/src/mcp/server'
import { DEFAULT_STAGE_CLASSIFIER, DEFAULT_STAGE_RULESET, STAGE_RULESET_PRESETS } from '@/src/lib/sleep-stage-rules'

const SIDE = { currentTemperature: 70, targetTemperature: 72, currentLevel: 10, targetLevel: 20, heatingDuration: 0 }
const STATUS = {
  leftSide: SIDE,
  rightSide: { ...SIDE, targetLevel: 0 },
  waterLevel: 'ok',
  isPriming: false,
  podVersion: 'J00',
  sensorLabel: 'capSense2',
  snooze: { left: { active: false, snoozeUntil: null }, right: { active: false, snoozeUntil: null } },
  wifiStrength: -50,
  wifiSSID: 'home',
  roomClimate: { temperatureC: 21, humidity: 40, timestamp: 1 },
  waterLevelRaw: { raw: null, calibratedEmpty: null, calibratedFull: null, timestamp: null },
  temperatureControl: { left: { owner: 'manual', targetTemperature: 72 }, right: { owner: 'schedule', targetTemperature: null } },
}

async function connect() {
  const server = createSleepypodMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientTransport)
  return client
}

function text(result: CallToolResult): string {
  const block = result.content[0]
  if (block.type !== 'text') throw new Error('expected text block')
  return block.text
}

function parse(result: CallToolResult): unknown {
  return JSON.parse(text(result))
}

describe('sleepypod MCP server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callerMock.settings.getAll.mockResolvedValue({
      device: { temperatureUnit: 'F', timezone: 'America/Los_Angeles' },
      sides: { left: { awayMode: false, alwaysOn: false }, right: { awayMode: true, alwaysOn: false } },
      gestures: { left: [], right: [] },
    })
    callerMock.device.getStatus.mockResolvedValue(STATUS)
  })

  it('exposes the curated tool, resource and prompt surface', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      'diagnose_pod',
      'get_automations',
      'get_bed_occupancy',
      'get_environment',
      'get_logs',
      'get_pod_status',
      'get_schedules',
      'get_settings',
      'get_sleep_history',
      'get_sleep_stage_rules',
      'get_sleep_summary',
      'get_vitals_trend',
      'import_apple_watch_data',
      'manage_alarm',
      'manage_automation',
      'manage_schedule',
      'pod_maintenance',
      'preview_sleep_stage_rules',
      'prime_pod',
      'resume_schedule',
      'run_once_curve',
      'set_device_settings',
      'set_power',
      'set_side_settings',
      'set_sleep_stage_rules',
      'set_temperature',
    ])
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy()
      expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf('boolean')
    }
    const { resources } = await client.listResources()
    expect(resources.map(r => r.uri).sort()).toEqual(['sleepypod://settings', 'sleepypod://status'])
    const { prompts } = await client.listPrompts()
    expect(prompts.map(p => p.name).sort()).toEqual(['bedtime', 'morning_report'])
  })

  it('get_pod_status compacts the hardware status per side', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'get_pod_status', arguments: {} }) as CallToolResult
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({
      unit: 'F',
      left: { currentTemperature: 70, targetTemperature: 72, powered: true, temperatureControl: { owner: 'manual', targetTemperature: 72 } },
      right: { powered: false },
      waterLevel: 'ok',
      wifi: { ssid: 'home', strength: -50 },
    })
    expect(callerMock.device.getStatus).toHaveBeenCalledWith({ unit: 'F' })
  })

  it('get_pod_status converts the controller target into the requested unit', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'get_pod_status', arguments: { unit: 'C' } }) as CallToolResult
    expect(parse(result)).toMatchObject({
      unit: 'C',
      left: { temperatureControl: { targetTemperature: 22.2 } },
      right: { temperatureControl: { targetTemperature: null } },
    })
  })

  it('set_temperature converts the caller unit to a °F setpoint', async () => {
    const client = await connect()
    callerMock.device.setTemperature.mockResolvedValue({ success: true })
    const result = await client.callTool({
      name: 'set_temperature',
      arguments: { side: 'left', temperature: 20, unit: 'C', holdMinutes: 90 },
    }) as CallToolResult
    expect(result.isError).toBeFalsy()
    expect(callerMock.device.setTemperature).toHaveBeenCalledWith({ side: 'left', temperature: 68, holdMinutes: 90 })
    expect(text(result)).toContain('68°F')
  })

  it('set_temperature falls back to the device unit when none is given', async () => {
    const client = await connect()
    callerMock.settings.getAll.mockResolvedValue({ device: { temperatureUnit: 'C' }, sides: {}, gestures: {} })
    callerMock.device.setTemperature.mockResolvedValue({ success: true })
    await client.callTool({ name: 'set_temperature', arguments: { side: 'right', temperature: 25 } })
    expect(callerMock.device.setTemperature).toHaveBeenCalledWith({ side: 'right', temperature: 77, holdMinutes: undefined })
  })

  it('surfaces router errors as isError results with the TRPC code', async () => {
    const client = await connect()
    callerMock.device.setTemperature.mockRejectedValue(
      new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Pump stall guard tripped' }),
    )
    const result = await client.callTool({
      name: 'set_temperature',
      arguments: { side: 'left', temperature: 70 },
    }) as CallToolResult
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('PRECONDITION_FAILED: Pump stall guard tripped')
  })

  it('hides internal error details from the model', async () => {
    const client = await connect()
    callerMock.device.setTemperature.mockRejectedValue(
      new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'SQLITE_BUSY: database is locked at /persistent/sleepypod.db' }),
    )
    const result = await client.callTool({
      name: 'set_temperature',
      arguments: { side: 'left', temperature: 70 },
    }) as CallToolResult
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('INTERNAL_SERVER_ERROR: the pod could not complete the request')
    expect(text(result)).not.toContain('SQLITE')
  })

  it('manage_alarm maps snooze minutes to seconds and reports the resume time', async () => {
    const client = await connect()
    callerMock.device.snoozeAlarm.mockResolvedValue({ success: true, snoozeUntil: 1_700_000_000 })
    const result = await client.callTool({
      name: 'manage_alarm',
      arguments: { side: 'left', action: 'snooze', snoozeMinutes: 10 },
    }) as CallToolResult
    expect(callerMock.device.snoozeAlarm).toHaveBeenCalledWith({
      side: 'left', duration: 600, vibrationIntensity: 50, vibrationPattern: 'rise', alarmDuration: 120,
    })
    expect(text(result)).toContain('2023-11-14T22:13:20.000Z')
  })

  it('manage_schedule routes each kind/action pair to the matching procedure', async () => {
    const client = await connect()
    callerMock.schedules.createPowerSchedule.mockResolvedValue({ id: 7 })
    callerMock.schedules.deleteAlarmSchedule.mockResolvedValue({ success: true })

    await client.callTool({
      name: 'manage_schedule',
      arguments: { action: 'create', kind: 'power', side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', temperature: 68 },
    })
    expect(callerMock.schedules.createPowerSchedule).toHaveBeenCalledWith({
      side: 'left', dayOfWeek: 'monday', enabled: true, onTime: '22:00', offTime: '07:00', onTemperature: 68,
    })

    await client.callTool({ name: 'manage_schedule', arguments: { action: 'delete', kind: 'alarm', id: 3 } })
    expect(callerMock.schedules.deleteAlarmSchedule).toHaveBeenCalledWith({ id: 3 })

    const missing = await client.callTool({
      name: 'manage_schedule',
      arguments: { action: 'create', kind: 'temperature', side: 'left', dayOfWeek: 'monday', temperature: 68 },
    }) as CallToolResult
    expect(missing.isError).toBe(true)
    expect(text(missing)).toBe('time is required for create temperature')
  })

  it('get_sleep_summary joins the record, stages, vitals and movement for the night', async () => {
    const client = await connect()
    const enteredBedAt = new Date('2026-09-28T05:00:00Z')
    const leftBedAt = new Date('2026-09-28T13:00:00Z')
    callerMock.biometrics.getLatestSleep.mockResolvedValue({
      id: 42, side: 'left', enteredBedAt, leftBedAt, sleepDurationSeconds: 28800, timesExitedBed: 1,
      presentIntervals: [], notPresentIntervals: [], createdAt: leftBedAt,
    })
    callerMock.biometrics.getSleepStages.mockResolvedValue({ epochs: [], blocks: [], distribution: { wake: 1, light: 2, deep: 3, rem: 4 } })
    callerMock.biometrics.getVitalsSummary.mockResolvedValue({ avgHeartRate: 55, recordCount: 10 })
    callerMock.biometrics.getMovementSummary.mockResolvedValue({ positionChanges: 12, restlessMinutes: 3, sampleCount: 480 })
    callerMock.biometrics.getReferenceStages.mockResolvedValue([])

    const result = await client.callTool({ name: 'get_sleep_summary', arguments: { side: 'left' } }) as CallToolResult
    expect(parse(result)).toMatchObject({
      record: { id: 42, inBed: false, sleepDurationSeconds: 28800 },
      stages: { distribution: { deep: 3 } },
      vitals: { avgHeartRate: 55 },
      movement: { positionChanges: 12 },
      referenceAgreement: null,
      referenceHint: expect.stringContaining('import_apple_watch_data'),
    })
    expect(callerMock.biometrics.getReferenceStages).toHaveBeenCalledWith({ side: 'left', startDate: enteredBedAt, endDate: leftBedAt, limit: 20000 })
    expect(callerMock.biometrics.getSleepStages).toHaveBeenCalledWith({ side: 'left', sleepRecordId: 42 })
    expect(callerMock.biometrics.getVitalsSummary).toHaveBeenCalledWith({ side: 'left', startDate: enteredBedAt, endDate: leftBedAt })
  })

  it('diagnose_pod keeps going when one subsystem throws', async () => {
    const client = await connect()
    callerMock.health.system.mockResolvedValue({ status: 'ok' })
    callerMock.health.hardware.mockRejectedValue(new Error('dac.sock timeout'))
    for (const fn of [
      callerMock.health.thermal, callerMock.waterLevel.getLatest, callerMock.waterLevel.getAlerts,
      callerMock.pumpAlerts.list, callerMock.system.getDiskUsage, callerMock.system.getVersion,
      callerMock.system.internetStatus,
    ]) fn.mockResolvedValue(null)

    const result = await client.callTool({ name: 'diagnose_pod', arguments: {} }) as CallToolResult
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ system: { status: 'ok' }, hardware: { error: 'dac.sock timeout' } })
  })

  it('manage_automation flips the kill switch with inverted polarity', async () => {
    const client = await connect()
    callerMock.automations.setKillSwitch.mockResolvedValue({ enabled: false })
    const result = await client.callTool({ name: 'manage_automation', arguments: { action: 'kill_switch_on' } }) as CallToolResult
    expect(callerMock.automations.setKillSwitch).toHaveBeenCalledWith({ enabled: false })
    expect(text(result)).toBe('All automations paused.')
  })

  it('manage_schedule covers every kind/action pair', async () => {
    const client = await connect()
    const s = callerMock.schedules
    for (const fn of Object.values(s)) fn.mockResolvedValue({ ok: true })
    const base = { side: 'left', dayOfWeek: 'monday' }

    await client.callTool({ name: 'manage_schedule', arguments: { action: 'create', kind: 'temperature', ...base, time: '22:00', temperature: 20, unit: 'C' } })
    expect(s.createTemperatureSchedule).toHaveBeenCalledWith({ ...base, enabled: true, time: '22:00', temperature: 68 })
    await client.callTool({ name: 'manage_schedule', arguments: { action: 'create', kind: 'alarm', ...base, time: '07:00', temperature: 75 } })
    expect(s.createAlarmSchedule).toHaveBeenCalledWith({
      ...base, enabled: true, time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 60, alarmTemperature: 75,
    })

    await client.callTool({ name: 'manage_schedule', arguments: { action: 'update', kind: 'temperature', id: 1, time: '23:00', enabled: false } })
    expect(s.updateTemperatureSchedule).toHaveBeenCalledWith({ id: 1, time: '23:00', temperature: undefined, enabled: false })
    await client.callTool({ name: 'manage_schedule', arguments: { action: 'update', kind: 'power', id: 2, onTime: '21:00', temperature: 70 } })
    expect(s.updatePowerSchedule).toHaveBeenCalledWith({ id: 2, onTime: '21:00', offTime: undefined, onTemperature: 70, enabled: undefined })
    await client.callTool({ name: 'manage_schedule', arguments: { action: 'update', kind: 'alarm', id: 3, intensity: 80, pattern: 'double' } })
    expect(s.updateAlarmSchedule).toHaveBeenCalledWith({
      id: 3, time: undefined, vibrationIntensity: 80, vibrationPattern: 'double', duration: undefined, alarmTemperature: undefined, enabled: undefined,
    })

    await client.callTool({ name: 'manage_schedule', arguments: { action: 'delete', kind: 'temperature', id: 4 } })
    expect(s.deleteTemperatureSchedule).toHaveBeenCalledWith({ id: 4 })
    await client.callTool({ name: 'manage_schedule', arguments: { action: 'delete', kind: 'power', id: 5 } })
    expect(s.deletePowerSchedule).toHaveBeenCalledWith({ id: 5 })
  })

  it('manage_schedule refuses to move a schedule to another day or side on update', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'manage_schedule',
      arguments: { action: 'update', kind: 'alarm', id: 3, dayOfWeek: 'tuesday' },
    }) as CallToolResult
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cannot be changed on update')
    expect(callerMock.schedules.updateAlarmSchedule).not.toHaveBeenCalled()
  })

  it('get_schedules reports both sides with away mode and always-on', async () => {
    const client = await connect()
    callerMock.schedules.getAll.mockResolvedValue({ temperature: [], power: [], alarm: [] })
    const result = await client.callTool({ name: 'get_schedules', arguments: {} }) as CallToolResult
    expect(parse(result)).toMatchObject({ unit: 'F', left: { awayMode: false }, right: { awayMode: true, alarm: [] } })
    expect(callerMock.schedules.getAll).toHaveBeenCalledTimes(2)
    expect(callerMock.settings.getAll).toHaveBeenCalledTimes(1)
  })

  it('pod_maintenance routes each action and demands its required argument', async () => {
    const client = await connect()
    callerMock.pumpAlerts.acknowledgeAndRestore.mockResolvedValue({ success: true })
    callerMock.waterLevel.dismissAlert.mockResolvedValue({ success: true })
    callerMock.health.restartService.mockResolvedValue({ ok: true, message: 'Restarted' })
    callerMock.system.freeStorage.mockResolvedValue({ freedBytes: 10, removed: 1 })
    callerMock.databases.checkIntegrity.mockResolvedValue({})
    callerMock.system.triggerUpdate.mockResolvedValue({ triggered: true, branch: 'main', message: '' })

    const call = (args: Record<string, unknown>) =>
      client.callTool({ name: 'pod_maintenance', arguments: args }) as Promise<CallToolResult>

    await call({ action: 'acknowledge_pump_alert', side: 'right', alertId: 9 })
    expect(callerMock.pumpAlerts.acknowledgeAndRestore).toHaveBeenCalledWith({ side: 'right', alertId: 9 })
    await call({ action: 'dismiss_water_alert', alertId: 4 })
    expect(callerMock.waterLevel.dismissAlert).toHaveBeenCalledWith({ id: 4 })
    await call({ action: 'restart_service', service: 'sleepypod-sleep-detector.service' })
    expect(callerMock.health.restartService).toHaveBeenCalledWith({ unit: 'sleepypod-sleep-detector.service' })
    await call({ action: 'free_storage' })
    expect(callerMock.system.freeStorage).toHaveBeenCalledWith({ includeDbBackups: false })
    await call({ action: 'check_database_integrity' })
    expect(callerMock.databases.checkIntegrity).toHaveBeenCalledWith({})
    await call({ action: 'update_software', branch: 'feat/mcp' })
    expect(callerMock.system.triggerUpdate).toHaveBeenCalledWith({ branch: 'feat/mcp' })

    const missing = await call({ action: 'restart_service' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toBe('service is required for restart_service')
    expect(callerMock.health.restartService).toHaveBeenCalledTimes(1)
  })

  it('set_power and resume_schedule forward to the device router', async () => {
    const client = await connect()
    callerMock.device.setPower.mockResolvedValue({ success: true })
    callerMock.device.resumeTemperature.mockResolvedValue({ owner: 'schedule' })
    await client.callTool({ name: 'set_power', arguments: { side: 'left', powered: true, temperature: 22, unit: 'C' } })
    expect(callerMock.device.setPower).toHaveBeenCalledWith({ side: 'left', powered: true, temperature: 72 })
    await client.callTool({ name: 'set_power', arguments: { side: 'right', powered: false } })
    expect(callerMock.device.setPower).toHaveBeenCalledWith({ side: 'right', powered: false, temperature: undefined })
    const resumed = await client.callTool({ name: 'resume_schedule', arguments: { side: 'left' } }) as CallToolResult
    expect(parse(resumed)).toEqual({ owner: 'schedule' })
  })

  it('manage_alarm trigger and stop use defaults and clear', async () => {
    const client = await connect()
    callerMock.device.setAlarm.mockResolvedValue({ success: true })
    callerMock.device.clearAlarm.mockResolvedValue({ success: true })
    await client.callTool({ name: 'manage_alarm', arguments: { side: 'left', action: 'trigger', intensity: 80 } })
    expect(callerMock.device.setAlarm).toHaveBeenCalledWith({ side: 'left', vibrationIntensity: 80, vibrationPattern: 'rise', duration: 60 })
    await client.callTool({ name: 'manage_alarm', arguments: { side: 'left', action: 'stop' } })
    expect(callerMock.device.clearAlarm).toHaveBeenCalledWith({ side: 'left' })
  })

  it('run_once_curve starts, inspects and cancels a session with converted set points', async () => {
    const client = await connect()
    callerMock.runOnce.start.mockResolvedValue({ sessionId: 5, expiresAt: 1_700_000_000 })
    callerMock.runOnce.getActive.mockResolvedValue(null)
    callerMock.runOnce.cancel.mockResolvedValue({ success: true })

    const started = await client.callTool({
      name: 'run_once_curve',
      arguments: { side: 'left', action: 'start', wakeTime: '07:00', unit: 'C', setPoints: [{ time: '22:00', temperature: 20 }] },
    }) as CallToolResult
    expect(callerMock.runOnce.start).toHaveBeenCalledWith({ side: 'left', wakeTime: '07:00', setPoints: [{ time: '22:00', temperature: 68 }] })
    expect(parse(started)).toMatchObject({ sessionId: 5, expiresAt: '2023-11-14T22:13:20.000Z' })

    const missing = await client.callTool({ name: 'run_once_curve', arguments: { side: 'left', action: 'start' } }) as CallToolResult
    expect(missing.isError).toBe(true)

    const none = await client.callTool({ name: 'run_once_curve', arguments: { side: 'left', action: 'status' } }) as CallToolResult
    expect(callerMock.runOnce.getActive).toHaveBeenCalledWith({ side: 'left' })
    expect(parse(none)).toEqual({ unit: 'F', active: null })
    callerMock.runOnce.getActive.mockResolvedValue({ id: 5, side: 'left', setPoints: [{ time: '22:00', temperature: 68 }], wakeTime: '07:00', startedAt: 0, expiresAt: 1, status: 'active' })
    const status = await client.callTool({ name: 'run_once_curve', arguments: { side: 'left', action: 'status', unit: 'C' } }) as CallToolResult
    expect(parse(status)).toMatchObject({ unit: 'C', active: { setPoints: [{ time: '22:00', temperature: 20 }] } })
    await client.callTool({ name: 'run_once_curve', arguments: { side: 'left', action: 'cancel' } })
    expect(callerMock.runOnce.cancel).toHaveBeenCalledWith({ side: 'left' })
  })

  it('prime_pod starts priming', async () => {
    const client = await connect()
    callerMock.device.startPriming.mockResolvedValue({ success: true })
    const result = await client.callTool({ name: 'prime_pod', arguments: {} }) as CallToolResult
    expect(callerMock.device.startPriming).toHaveBeenCalledWith({})
    expect(text(result)).toContain('Priming started')
  })

  it('settings tools pass through to the settings router', async () => {
    const client = await connect()
    callerMock.settings.updateSide.mockResolvedValue({ side: 'left', awayMode: true })
    callerMock.settings.updateDevice.mockResolvedValue({ temperatureUnit: 'C' })
    await client.callTool({ name: 'set_side_settings', arguments: { side: 'left', awayMode: true } })
    expect(callerMock.settings.updateSide).toHaveBeenCalledWith({ side: 'left', awayMode: true })
    await client.callTool({ name: 'set_device_settings', arguments: { temperatureUnit: 'C' } })
    expect(callerMock.settings.updateDevice).toHaveBeenCalledWith({ temperatureUnit: 'C' })
    const settings = await client.callTool({ name: 'get_settings', arguments: {} }) as CallToolResult
    expect(parse(settings)).toMatchObject({ device: { temperatureUnit: 'F' }, sides: { right: { awayMode: true } } })
  })

  it('sleep history, vitals trend and occupancy read the biometrics router', async () => {
    const client = await connect()
    callerMock.biometrics.getSleepRecords.mockResolvedValue([{ id: 1, side: 'left', enteredBedAt: new Date(0), leftBedAt: null, sleepDurationSeconds: 0, timesExitedBed: 0 }])
    callerMock.biometrics.getVitalsBaseline.mockResolvedValue({ hrMean: 55 })
    callerMock.biometrics.getVitalsSummary.mockResolvedValue({ avgHeartRate: 58 })
    callerMock.biometrics.getOccupancy.mockResolvedValue({ left: { occupied: true } })

    const history = await client.callTool({ name: 'get_sleep_history', arguments: { side: 'left', days: 3 } }) as CallToolResult
    expect(parse(history)).toEqual([{ id: 1, side: 'left', enteredBedAt: '1970-01-01T00:00:00.000Z', leftBedAt: null, sleepDurationSeconds: 0, timesExitedBed: 0 }])
    expect(callerMock.biometrics.getSleepRecords).toHaveBeenCalledWith(expect.objectContaining({ side: 'left', limit: 14 }))

    const trend = await client.callTool({ name: 'get_vitals_trend', arguments: { side: 'left', baselineDays: 14 } }) as CallToolResult
    expect(parse(trend)).toEqual({ side: 'left', baseline: { hrMean: 55 }, recent: { avgHeartRate: 58 } })
    expect(callerMock.biometrics.getVitalsBaseline).toHaveBeenCalledWith({ side: 'left', days: 14 })

    const occupancy = await client.callTool({ name: 'get_bed_occupancy', arguments: {} }) as CallToolResult
    expect(parse(occupancy)).toEqual({ left: { occupied: true } })
  })

  it('get_sleep_summary looks a record up by id and rejects ids from the other side', async () => {
    const client = await connect()
    const record = { id: 9, side: 'left', enteredBedAt: new Date(0), leftBedAt: new Date(1000), sleepDurationSeconds: 1, timesExitedBed: 0, presentIntervals: [], notPresentIntervals: [], createdAt: new Date(0) }
    callerMock.biometrics.getSleepRecord.mockResolvedValue(record)
    callerMock.biometrics.getSleepStages.mockResolvedValue({ epochs: [], blocks: [], distribution: {} })
    callerMock.biometrics.getVitalsSummary.mockResolvedValue({})
    callerMock.biometrics.getMovementSummary.mockResolvedValue({})
    callerMock.biometrics.getReferenceStages.mockResolvedValue([])
    const ok = await client.callTool({ name: 'get_sleep_summary', arguments: { side: 'left', sleepRecordId: 9 } }) as CallToolResult
    expect(parse(ok)).toMatchObject({ record: { id: 9 } })
    expect(callerMock.biometrics.getSleepRecord).toHaveBeenCalledWith({ id: 9 })
    expect(callerMock.biometrics.getLatestSleep).not.toHaveBeenCalled()

    const wrongSide = await client.callTool({ name: 'get_sleep_summary', arguments: { side: 'right', sleepRecordId: 9 } }) as CallToolResult
    expect(wrongSide.isError).toBe(true)
    expect(text(wrongSide)).toContain('not found for the right side')
  })

  it('get_vitals_trend forwards a partial date range instead of dropping it', async () => {
    const client = await connect()
    callerMock.biometrics.getVitalsBaseline.mockResolvedValue({})
    callerMock.biometrics.getVitalsSummary.mockResolvedValue({})
    await client.callTool({ name: 'get_vitals_trend', arguments: { side: 'left', startDate: '2026-09-20' } })
    expect(callerMock.biometrics.getVitalsSummary).toHaveBeenCalledWith({ side: 'left', startDate: new Date('2026-09-20') })
  })

  it('get_sleep_history defaults to 7 days and get_vitals_trend forwards an endDate alone', async () => {
    const client = await connect()
    callerMock.biometrics.getSleepRecords.mockResolvedValue([])
    callerMock.biometrics.getVitalsBaseline.mockResolvedValue({})
    callerMock.biometrics.getVitalsSummary.mockResolvedValue({})
    const before = Date.now()
    await client.callTool({ name: 'get_sleep_history', arguments: { side: 'left' } })
    const { startDate, endDate } = callerMock.biometrics.getSleepRecords.mock.calls[0][0]
    expect(endDate.getTime() - startDate.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
    expect(endDate.getTime()).toBeGreaterThanOrEqual(before)

    await client.callTool({ name: 'get_vitals_trend', arguments: { side: 'left', endDate: '2026-09-29' } })
    expect(callerMock.biometrics.getVitalsSummary).toHaveBeenCalledWith({ side: 'left', endDate: new Date('2026-09-29') })
  })

  it('get_environment rejects a half-specified range', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'get_environment', arguments: { endDate: '2026-09-29' } }) as CallToolResult
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('both startDate and endDate')
    expect(callerMock.environment.getLatestBedTemp).not.toHaveBeenCalled()
  })

  it('get_sleep_summary reports an empty history', async () => {
    const client = await connect()
    callerMock.biometrics.getLatestSleep.mockResolvedValue(null)
    const result = await client.callTool({ name: 'get_sleep_summary', arguments: { side: 'right' } }) as CallToolResult
    expect(parse(result)).toMatchObject({ side: 'right', record: null })
  })

  it('get_environment returns latest readings or a range summary', async () => {
    const client = await connect()
    callerMock.environment.getLatestBedTemp.mockResolvedValue({ ambientTemp: 70 })
    callerMock.environment.getLatestFreezerTemp.mockResolvedValue({ temp: 40 })
    callerMock.environment.getLatestAmbientLight.mockResolvedValue({ lux: 3 })
    callerMock.environment.getSummary.mockResolvedValue({ avgAmbient: 69 })
    callerMock.environment.getAmbientLightSummary.mockResolvedValue({ avgLux: 2 })

    const latest = await client.callTool({ name: 'get_environment', arguments: {} }) as CallToolResult
    expect(parse(latest)).toEqual({ unit: 'F', bed: { ambientTemp: 70 }, freezer: { temp: 40 }, ambientLight: { lux: 3 } })

    const range = await client.callTool({
      name: 'get_environment',
      arguments: { startDate: '2026-09-28', endDate: '2026-09-29', unit: 'C' },
    }) as CallToolResult
    expect(parse(range)).toMatchObject({ unit: 'C', environment: { avgAmbient: 69 }, ambientLight: { avgLux: 2 } })
    expect(callerMock.environment.getSummary).toHaveBeenCalledWith(expect.objectContaining({ unit: 'C' }))
  })

  it('get_logs applies the default unit and forwards filters', async () => {
    const client = await connect()
    callerMock.system.getLogs.mockResolvedValue({ lines: ['a'], nextCursor: null })
    const result = await client.callTool({ name: 'get_logs', arguments: { priority: 'err', lines: 5 } }) as CallToolResult
    expect(callerMock.system.getLogs).toHaveBeenCalledWith({ unit: 'sleepypod.service', lines: 5, priority: 'err', since: undefined })
    expect(parse(result)).toEqual({ lines: ['a'], nextCursor: null })
  })

  it('get_automations merges status, tonight and optionally rules', async () => {
    const client = await connect()
    callerMock.automations.status.mockResolvedValue({ globalEnabled: true, rules: [] })
    callerMock.automations.tonight.mockResolvedValue({ now: 1, sides: {} })
    callerMock.automations.list.mockResolvedValue([{ id: 1 }])
    const bare = await client.callTool({ name: 'get_automations', arguments: {} }) as CallToolResult
    expect(parse(bare)).toEqual({ globalEnabled: true, rules: [], tonight: { now: 1, sides: {} } })
    expect(callerMock.automations.list).not.toHaveBeenCalled()
    const full = await client.callTool({ name: 'get_automations', arguments: { includeRules: true } }) as CallToolResult
    expect(parse(full)).toMatchObject({ rules: [{ id: 1 }] })
  })

  it('manage_automation routes id-based actions and validates rule bodies', async () => {
    const client = await connect()
    callerMock.automations.setEnabled.mockResolvedValue({ id: 2, enabled: false })
    callerMock.automations.setDryRun.mockResolvedValue({ id: 2, dryRun: false })
    callerMock.automations.delete.mockResolvedValue({ success: true })
    await client.callTool({ name: 'manage_automation', arguments: { action: 'disable', id: 2 } })
    expect(callerMock.automations.setEnabled).toHaveBeenCalledWith({ id: 2, enabled: false })
    await client.callTool({ name: 'manage_automation', arguments: { action: 'live', id: 2 } })
    expect(callerMock.automations.setDryRun).toHaveBeenCalledWith({ id: 2, dryRun: false })
    await client.callTool({ name: 'manage_automation', arguments: { action: 'delete', id: 2 } })
    expect(callerMock.automations.delete).toHaveBeenCalledWith({ id: 2 })

    const noId = await client.callTool({ name: 'manage_automation', arguments: { action: 'enable' } }) as CallToolResult
    expect(noId.isError).toBe(true)
    const badRule = await client.callTool({ name: 'manage_automation', arguments: { action: 'create', rule: { name: '' } } }) as CallToolResult
    expect(badRule.isError).toBe(true)
    expect(callerMock.automations.create).not.toHaveBeenCalled()
  })

  it('manage_automation create always starts in dry-run, even when copying a live rule', async () => {
    const client = await connect()
    callerMock.automations.create.mockImplementation(async (input: unknown) => input)
    const rule = {
      name: 'Cool when hot',
      dryRun: false,
      trigger: { kind: 'tick', everyMin: 5 },
      conditions: { kind: 'compare', op: '>', left: { kind: 'signal', signal: 'ambient.temperature' }, right: { kind: 'literal', value: 75 } },
      actions: [{ kind: 'setTemperature', side: 'left', temp: { kind: 'literal', value: 66 } }],
    }
    const result = await client.callTool({ name: 'manage_automation', arguments: { action: 'create', rule } }) as CallToolResult
    expect(result.isError, text(result)).toBeFalsy()
    expect(callerMock.automations.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Cool when hot', dryRun: true }))
  })

  it('rejects unparseable dates at the schema boundary', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'get_vitals_trend',
      arguments: { side: 'left', startDate: 'garbage', endDate: '2026-09-29' },
    }) as CallToolResult
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('ISO 8601')
    expect(callerMock.biometrics.getVitalsSummary).not.toHaveBeenCalled()
  })

  it('serves the settings resource and renders both prompts', async () => {
    const client = await connect()
    const { contents } = await client.readResource({ uri: 'sleepypod://settings' })
    const [content] = contents
    if (!('text' in content)) throw new Error('expected text content')
    expect(JSON.parse(content.text)).toMatchObject({ sides: { right: { awayMode: true } } })

    const morning = await client.getPrompt({ name: 'morning_report', arguments: {} })
    expect(morning.messages[0].content).toMatchObject({ type: 'text' })
    const bedtime = await client.getPrompt({ name: 'bedtime', arguments: { side: 'left', request: 'cool please' } })
    const block = bedtime.messages[0].content
    if (block.type !== 'text') throw new Error('expected text')
    expect(block.text).toContain('left side')
    expect(block.text).toContain('cool please')
  })

  it('serves the status resource', async () => {
    const client = await connect()
    const { contents } = await client.readResource({ uri: 'sleepypod://status' })
    const [content] = contents
    expect(content.mimeType).toBe('application/json')
    if (!('text' in content)) throw new Error('expected text content')
    expect(JSON.parse(content.text)).toMatchObject({ left: { powered: true } })
  })
})

it('imports Watch batches through the shared procedures and reports partial stage failure', async () => {
  callerMock.biometrics.importReferenceVitals.mockResolvedValue({ written: 1 })
  callerMock.biometrics.importReferenceStages.mockRejectedValue(new TRPCError({ code: 'BAD_REQUEST', message: 'overlap' }))
  const client = await connect()
  try {
    const result = await client.callTool({ name: 'import_apple_watch_data', arguments: {
      side: 'right', samples: [{ timestamp: 1791700000, heartRate: 60 }],
      segments: [{ start: 1791700000, end: 1791700060, stage: 'deep' }],
    } }) as CallToolResult
    expect(JSON.parse(text(result))).toMatchObject({ vitals: 1, stages: 0, stageError: 'Stage import failed: overlap' })
    expect(callerMock.biometrics.importReferenceVitals).toHaveBeenCalledWith({ side: 'right', source: 'apple_watch', samples: [{ timestamp: 1791700000, heartRate: 60 }] })
  }
  finally { await client.close() }
})

it('does not expose internal errors from Watch stage import', async () => {
  callerMock.biometrics.importReferenceStages.mockRejectedValue(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'private database path' }))
  const client = await connect()
  try {
    const result = await client.callTool({ name: 'import_apple_watch_data', arguments: {
      side: 'left', segments: [{ start: 1791700000, end: 1791700060, stage: 'deep' }],
    } }) as CallToolResult
    expect(JSON.parse(text(result))).toMatchObject({ vitals: 0, stages: 0, stageError: expect.stringContaining('stored stages were preserved') })
    expect(text(result)).not.toContain('private database path')
  }
  finally { await client.close() }
})

it('imports stage-only Watch data and rejects empty import requests', async () => {
  callerMock.biometrics.importReferenceStages.mockResolvedValue({ written: 1 })
  const client = await connect()
  try {
    const result = await client.callTool({ name: 'import_apple_watch_data', arguments: {
      side: 'left', segments: [{ start: 1791700000, end: 1791700060, stage: 'deep' }],
    } }) as CallToolResult
    expect(JSON.parse(text(result))).toEqual({ vitals: 0, stages: 1, stageError: null })
    const empty = await client.callTool({ name: 'import_apple_watch_data', arguments: { side: 'left' } }) as CallToolResult
    expect(empty.isError).toBe(true)
    expect(text(empty)).toContain('Provide samples or segments')
    callerMock.biometrics.importReferenceVitals.mockResolvedValue({ written: 1 })
    const vitalsOnly = await client.callTool({ name: 'import_apple_watch_data', arguments: {
      side: 'left', samples: [{ timestamp: 1791700000, heartRate: 60 }],
    } }) as CallToolResult
    expect(JSON.parse(text(vitalsOnly))).toEqual({ vitals: 1, stages: 0, stageError: null })
  }
  finally { await client.close() }
})

describe('sleep stage tuning tools', () => {
  const AGREEMENT = {
    epochs: 10, accuracy: 0.6, kappa: 0.2,
    confusion: { wake: { wake: 1, light: 0, deep: 0, rem: 0 }, light: { wake: 0, light: 3, deep: 2, rem: 0 }, deep: { wake: 0, light: 2, deep: 1, rem: 0 }, rem: { wake: 0, light: 0, deep: 0, rem: 1 } },
    recall: { wake: 1, light: 0.6, deep: 1 / 3, rem: 1 },
  }
  const STAGES = {
    blocks: [], distribution: { wake: 10, light: 50, deep: 20, rem: 20 }, qualityScore: 80, totalSleepMs: 8 * 3_600_000,
    durations: { wake: 48 * 60_000, light: 240 * 60_000, deep: 96 * 60_000, rem: 96 * 60_000 },
    stats: { epochs: 96, nights: 1, lowSignalNights: 0, rules: null, lowSignalRules: null, metricRanges: {}, heartRateReadings: 0, spikesDropped: 0, smoothed: 0, transitionFixes: 0 },
  }
  const PRESETS = Object.entries(STAGE_RULESET_PRESETS).map(([id, p]) => ({ id, label: p.label, description: p.description, classifier: { engine: 'rules', ruleset: p.ruleset } }))
  const CHANGE = { id: 7, changedAt: 1_791_700_000_000, summary: 'Rule 2: Deep HR ratio < 0.92 → < 0.9', before: DEFAULT_STAGE_CLASSIFIER, agreementBefore: 0.5, agreementAfter: 0.7 }
  const classifierState = (changes: typeof CHANGE[] = []) => ({
    classifier: DEFAULT_STAGE_CLASSIFIER, isDefault: true, defaults: DEFAULT_STAGE_CLASSIFIER, engines: [], presets: PRESETS, changes,
  })
  const enteredBedAt = new Date('2026-10-12T05:00:00Z')
  const leftBedAt = new Date('2026-10-12T13:00:00Z')
  const segment = { id: 1, side: 'left', source: 'apple_watch', start: new Date('2026-10-12T06:00:00Z'), end: new Date('2026-10-12T12:00:00Z'), stage: 'light', createdAt: leftBedAt }
  const record = { id: 42, side: 'left', enteredBedAt, leftBedAt, sleepDurationSeconds: 28800, timesExitedBed: 0, presentIntervals: [], notPresentIntervals: [], createdAt: leftBedAt }

  beforeEach(() => {
    vi.clearAllMocks()
    callerMock.sleepStages.getClassifier.mockResolvedValue(classifierState())
    callerMock.biometrics.getReferenceStages.mockResolvedValue([])
    callerMock.biometrics.getSleepRecords.mockResolvedValue([])
    callerMock.biometrics.getReferenceVitals.mockResolvedValue([])
    callerMock.biometrics.getVitals.mockResolvedValue([])
  })

  async function call(name: string, args: Record<string, unknown>) {
    const client = await connect()
    try {
      return await client.callTool({ name, arguments: args }) as CallToolResult
    }
    finally { await client.close() }
  }

  it('get_sleep_summary scores the night against reference stages when it has them', async () => {
    callerMock.biometrics.getLatestSleep.mockResolvedValue(record)
    callerMock.biometrics.getSleepStages.mockResolvedValue({
      blocks: [], distribution: {},
      epochs: [
        { start: segment.start.getTime(), duration: 300_000, stage: 'light', heartRate: null, hrv: null, breathingRate: null, movement: null },
        { start: segment.start.getTime() + 300_000, duration: 300_000, stage: 'deep', heartRate: null, hrv: null, breathingRate: null, movement: null },
      ],
    })
    callerMock.biometrics.getVitalsSummary.mockResolvedValue({})
    callerMock.biometrics.getMovementSummary.mockResolvedValue({})
    callerMock.biometrics.getReferenceStages.mockResolvedValue([segment])

    const result = await call('get_sleep_summary', { side: 'left' })
    expect(parse(result)).toMatchObject({
      referenceAgreement: {
        source: 'apple_watch', epochs: 2, accuracy: 0.5,
        confusion: { light: { light: 1, deep: 1 } },
        recall: { light: 0.5, deep: null },
      },
      referenceHint: null,
    })
  })

  it('get_sleep_stage_rules reports coverage for a side with and without reference', async () => {
    callerMock.biometrics.getReferenceStages.mockImplementation(async ({ side }: { side: string }) => side === 'left' ? [segment] : [])
    callerMock.biometrics.getSleepRecords.mockImplementation(async ({ side }: { side: string }) => side === 'left' ? [record] : [record])
    callerMock.sleepStages.getClassifier.mockResolvedValue(classifierState([CHANGE]))

    const both = parse(await call('get_sleep_stage_rules', {})) as Array<Record<string, unknown>>
    expect(both.map(r => r.side)).toEqual(['left', 'right'])
    expect(both[0]).toMatchObject({
      isDefault: true,
      presets: [{ id: 'default' }, { id: 'movementOnly' }, { id: 'hrvFirst' }],
      recentChanges: [{ id: 7, summary: CHANGE.summary, before: DEFAULT_STAGE_CLASSIFIER, accuracyBefore: 0.5, accuracyAfter: 0.7 }],
      referenceCoverage: { days: 14, nights: 1, segments: 1, epochs: 72, latestReferenceAt: segment.end.toISOString(), source: 'apple_watch', heartRateAgreement: null },
      hint: null,
    })
    expect((both[0].classifier as { ruleset: unknown }).ruleset).toEqual(DEFAULT_STAGE_RULESET)
    expect(both[1]).toMatchObject({
      referenceCoverage: { nights: 0, segments: 0, epochs: 0, latestReferenceAt: null, source: null },
      hint: expect.stringContaining('import_apple_watch_data'),
    })

    const one = parse(await call('get_sleep_stage_rules', { side: 'right' })) as Record<string, unknown>
    expect(one.side).toBe('right')
    expect(callerMock.biometrics.getReferenceStages).toHaveBeenLastCalledWith(expect.objectContaining({ side: 'right', limit: 20000 }))
  })

  it('preview_sleep_stage_rules dry-runs a preset and never saves', async () => {
    callerMock.sleepStages.previewClassifier.mockResolvedValue({
      sleepRecordId: 42, enteredBedAt: enteredBedAt.getTime(), leftBedAt: leftBedAt.getTime(), nights: 3, hasReference: true,
      saved: { ...STAGES, agreement: AGREEMENT },
      candidate: { ...STAGES, durations: { ...STAGES.durations, deep: 120 * 60_000 }, agreement: { ...AGREEMENT, accuracy: 0.7, kappa: 0.45 } },
      changed: { segments: [], changed: 12, total: 96 },
    })

    const result = parse(await call('preview_sleep_stage_rules', { side: 'left', nights: 3, presetId: 'movementOnly' }))
    expect(result).toMatchObject({
      dryRun: true, candidateSource: 'preset:movementOnly', candidateRuleset: STAGE_RULESET_PRESETS.movementOnly.ruleset, nights: 3, hasReference: true, hint: null,
      saved: { agreement: { kappa: 0.2, confusion: AGREEMENT.confusion, recall: AGREEMENT.recall }, stageMinutesPerNight: { wake: 48, light: 240, deep: 96, rem: 96 } },
      candidate: { agreement: { kappa: 0.45 }, stageMinutesPerNight: { deep: 120 } },
      kappaDelta: 0.25, epochsChanged: 12, epochsTotal: 96,
      apply: expect.stringContaining('set_sleep_stage_rules'),
    })
    expect(callerMock.sleepStages.previewClassifier).toHaveBeenCalledWith({
      side: 'left', nights: 3, classifier: { engine: 'rules', ruleset: STAGE_RULESET_PRESETS.movementOnly.ruleset },
    })
    expect(callerMock.sleepStages.setClassifier).not.toHaveBeenCalled()
  })

  it('preview_sleep_stage_rules applies threshold overrides to the saved rules and defaults to 7 nights', async () => {
    callerMock.sleepStages.previewClassifier.mockResolvedValue({
      sleepRecordId: 42, enteredBedAt: 0, leftBedAt: 0, nights: 7, hasReference: false,
      saved: { ...STAGES, agreement: null }, candidate: { ...STAGES, agreement: null }, changed: { segments: [], changed: 0, total: 96 },
    })

    const result = parse(await call('preview_sleep_stage_rules', { side: 'left', overrides: [{ ruleIndex: 1, conditionIndex: 0, value: 0.9 }] }))
    expect(result).toMatchObject({ candidateSource: 'overrides:1', hasReference: false, hint: expect.stringContaining('import_apple_watch_data'), kappaDelta: null, saved: { agreement: null } })
    const sent = callerMock.sleepStages.previewClassifier.mock.calls[0][0]
    expect(sent.nights).toBe(7)
    expect(sent.classifier.ruleset.rules[1].when[0]).toEqual({ ...DEFAULT_STAGE_RULESET.rules[1].when[0], value: 0.9 })
    expect(sent.classifier.ruleset.rules[0]).toEqual(DEFAULT_STAGE_RULESET.rules[0])
    expect(DEFAULT_STAGE_RULESET.rules[1].when[0].value).not.toBe(0.9)
    expect(callerMock.sleepStages.setClassifier).not.toHaveBeenCalled()

    const bad = await call('preview_sleep_stage_rules', { side: 'left', overrides: [{ ruleIndex: 99, conditionIndex: 0, value: 1 }] })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('rules[99].when[0]')

    const low = await call('preview_sleep_stage_rules', { side: 'left', overrides: [{ list: 'lowSignalRules', ruleIndex: 0, conditionIndex: 0, value: 150 }] })
    expect(low.isError).toBeFalsy()
    const lowSent = callerMock.sleepStages.previewClassifier.mock.calls[1][0]
    expect(lowSent.classifier.ruleset.lowSignalRules[0].when[0]).toEqual({ ...DEFAULT_STAGE_RULESET.lowSignalRules[0].when[0], value: 150 })
    expect(lowSent.classifier.ruleset.rules).toEqual(DEFAULT_STAGE_RULESET.rules)
    const lowBad = await call('preview_sleep_stage_rules', { side: 'left', overrides: [{ list: 'lowSignalRules', ruleIndex: 5, conditionIndex: 0, value: 1 }] })
    expect(text(lowBad)).toContain('lowSignalRules[5].when[0]')
  })

  it('preview_sleep_stage_rules rejects several candidates at once and none at all', async () => {
    const both = await call('preview_sleep_stage_rules', { side: 'left', presetId: 'default', overrides: [{ ruleIndex: 0, conditionIndex: 0, value: 1 }] })
    expect(both.isError).toBe(true)
    expect(text(both)).toContain('exactly one')
    const none = await call('preview_sleep_stage_rules', { side: 'left' })
    expect(none.isError).toBe(true)
    expect(text(none)).toContain('exactly one')
    expect(callerMock.sleepStages.previewClassifier).not.toHaveBeenCalled()
    expect(callerMock.sleepStages.setClassifier).not.toHaveBeenCalled()
  })

  it('set_sleep_stage_rules saves a preset and returns the new change-log entry', async () => {
    const movementOnly = { engine: 'rules', ruleset: STAGE_RULESET_PRESETS.movementOnly.ruleset }
    callerMock.sleepStages.getClassifier
      .mockResolvedValueOnce(classifierState([CHANGE]))
      .mockResolvedValueOnce({ ...classifierState([{ ...CHANGE, id: 8, summary: 'Switched to Movement only', agreementBefore: 0.1, agreementAfter: 0.4 }, CHANGE]), classifier: movementOnly, isDefault: false })
    callerMock.sleepStages.setClassifier.mockResolvedValue({ classifier: movementOnly, isDefault: false })

    const result = parse(await call('set_sleep_stage_rules', { side: 'left', presetId: 'movementOnly' }))
    expect(result).toMatchObject({
      candidateSource: 'preset:movementOnly', isDefault: false, classifier: movementOnly,
      change: { id: 8, summary: 'Switched to Movement only', before: DEFAULT_STAGE_CLASSIFIER, accuracyBefore: 0.1, accuracyAfter: 0.4 },
      message: 'Saved: Switched to Movement only',
    })
    expect(callerMock.sleepStages.setClassifier).toHaveBeenCalledWith({ side: 'left', classifier: movementOnly })
  })

  it('set_sleep_stage_rules reset clears the classifier and reports no change when already default', async () => {
    callerMock.sleepStages.setClassifier.mockResolvedValue({ classifier: DEFAULT_STAGE_CLASSIFIER, isDefault: true })
    const result = parse(await call('set_sleep_stage_rules', { side: 'right', reset: true }))
    expect(result).toMatchObject({ candidateSource: 'reset', isDefault: true, change: null, message: expect.stringContaining('No change') })
    expect(callerMock.sleepStages.setClassifier).toHaveBeenCalledWith({ side: 'right', classifier: null })
  })

  it('set_sleep_stage_rules applies overrides to the saved ruleset', async () => {
    callerMock.sleepStages.setClassifier.mockImplementation(async ({ classifier }: { classifier: unknown }) => ({ classifier, isDefault: false }))
    const result = parse(await call('set_sleep_stage_rules', { side: 'left', overrides: [{ ruleIndex: 1, conditionIndex: 0, value: 0.88 }] })) as { classifier: { ruleset: typeof DEFAULT_STAGE_RULESET } }
    const sent = callerMock.sleepStages.setClassifier.mock.calls[0][0]
    expect(sent.side).toBe('left')
    expect(sent.classifier.ruleset.rules[1].when[0].value).toBe(0.88)
    expect(sent.classifier.ruleset.outliers).toEqual(DEFAULT_STAGE_RULESET.outliers)
    expect(result.classifier.ruleset.rules[1].when[0].value).toBe(0.88)
  })

  it('set_sleep_stage_rules rejects ambiguous input and surfaces CONFLICT as retryable', async () => {
    const ambiguous = await call('set_sleep_stage_rules', { side: 'left', presetId: 'default', reset: true })
    expect(ambiguous.isError).toBe(true)
    expect(text(ambiguous)).toContain('exactly one')
    const none = await call('set_sleep_stage_rules', { side: 'left' })
    expect(none.isError).toBe(true)
    expect(callerMock.sleepStages.setClassifier).not.toHaveBeenCalled()

    callerMock.sleepStages.setClassifier.mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: 'Stage classifier for left changed during save; reload and try again' }))
    const conflict = await call('set_sleep_stage_rules', { side: 'left', presetId: 'movementOnly' })
    expect(conflict.isError).toBe(true)
    expect(text(conflict)).toContain('CONFLICT (retryable)')
    expect(text(conflict)).toContain('get_sleep_stage_rules')
  })

  it('get_sleep_summary flags reference stages that cover none of the pod epochs on an in-bed night', async () => {
    callerMock.biometrics.getLatestSleep.mockResolvedValue({ ...record, leftBedAt: null })
    callerMock.biometrics.getSleepStages.mockResolvedValue({
      blocks: [], distribution: {},
      epochs: [{ start: enteredBedAt.getTime(), duration: 300_000, stage: 'light', heartRate: null, hrv: null, breathingRate: null, movement: null }],
    })
    callerMock.biometrics.getVitalsSummary.mockResolvedValue({})
    callerMock.biometrics.getMovementSummary.mockResolvedValue({})
    callerMock.biometrics.getReferenceStages.mockResolvedValue([segment])

    const result = parse(await call('get_sleep_summary', { side: 'left' }))
    expect(result).toMatchObject({
      record: { leftBedAt: null, inBed: true },
      referenceAgreement: null,
      referenceHint: expect.stringContaining('cover none'),
    })
    const { endDate } = callerMock.biometrics.getVitalsSummary.mock.calls[0][0]
    expect(endDate.getTime()).toBeGreaterThan(leftBedAt.getTime())
  })

  it('get_sleep_stage_rules counts an in-bed night and picks the latest of several reference segments', async () => {
    const earlier = { ...segment, id: 2, start: new Date('2026-10-11T06:00:00Z'), end: new Date('2026-10-11T12:00:00Z') }
    callerMock.biometrics.getReferenceStages.mockResolvedValue([segment, earlier])
    callerMock.biometrics.getSleepRecords.mockResolvedValue([{ ...record, leftBedAt: null }])

    const result = parse(await call('get_sleep_stage_rules', { side: 'left' }))
    expect(result).toMatchObject({
      side: 'left',
      referenceCoverage: { nights: 1, segments: 2, epochs: 144, latestReferenceAt: segment.end.toISOString(), source: 'apple_watch', truncated: false },
      hint: null,
    })
  })

  it('get_sleep_stage_rules marks coverage as truncated when a query hits its row cap', async () => {
    callerMock.biometrics.getReferenceStages.mockResolvedValue([segment])
    callerMock.biometrics.getSleepRecords.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ ...record, id: i + 1 })))

    const result = parse(await call('get_sleep_stage_rules', { side: 'left' }))
    expect(result).toMatchObject({ referenceCoverage: { nights: 100, segments: 1, truncated: true }, hint: expect.stringContaining('lower bounds') })
    expect(callerMock.biometrics.getSleepRecords).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }))
  })

  it('get_sleep_stage_rules reports pod-vs-watch heart-rate agreement and warns when it is weak', async () => {
    const t0 = Date.now() - 2 * 24 * 3_600_000
    const watch = Array.from({ length: 12 }, (_, i) => ({ id: i, side: 'left', source: 'apple_watch', timestamp: new Date(t0 + i * 300_000), heartRate: 50 + i, createdAt: new Date() }))
    const pod = watch.map((w, i) => ({ id: i, side: 'left', timestamp: new Date(w.timestamp.getTime() + 20_000), heartRate: 90 - i, hrv: null, breathingRate: null }))
    callerMock.biometrics.getReferenceStages.mockResolvedValue([segment])
    callerMock.biometrics.getSleepRecords.mockResolvedValue([record])
    callerMock.biometrics.getReferenceVitals.mockResolvedValue(watch)
    callerMock.biometrics.getVitals.mockResolvedValue([...pod, { id: 99, side: 'left', timestamp: new Date(t0 + 3_600_000), heartRate: 200, hrv: null, breathingRate: null }])

    const result = parse(await call('get_sleep_stage_rules', { side: 'left' }))
    expect(result).toMatchObject({
      referenceCoverage: { heartRateAgreement: { pairs: 12, correlation: -1, watchMeanBpm: 55.5, podMeanBpm: 84.5 } },
      hint: expect.stringContaining('hrvFirst'),
    })
    expect(callerMock.biometrics.getVitals).toHaveBeenCalledWith(expect.objectContaining({ side: 'left', limit: 100000 }))

    callerMock.biometrics.getVitals.mockResolvedValue(watch.map((w, i) => ({ id: i, side: 'left', timestamp: w.timestamp, heartRate: w.heartRate + 1, hrv: null, breathingRate: null })))
    const good = parse(await call('get_sleep_stage_rules', { side: 'left' }))
    expect(good).toMatchObject({ referenceCoverage: { heartRateAgreement: { correlation: 1, meanAbsErrorBpm: 1 } }, hint: null })
  })

  it('get_sleep_stage_rules clips segment durations to the coverage window', async () => {
    const straddling = { ...segment, start: new Date(Date.now() - 20 * 24 * 3_600_000), end: new Date(Date.now() - 14 * 24 * 3_600_000 + 10 * 60_000) }
    callerMock.biometrics.getReferenceStages.mockResolvedValue([straddling])
    callerMock.biometrics.getSleepRecords.mockResolvedValue([])
    const result = parse(await call('get_sleep_stage_rules', { side: 'left' })) as { referenceCoverage: { epochs: number, segments: number } }
    expect(result.referenceCoverage.segments).toBe(1)
    expect(result.referenceCoverage.epochs).toBe(2)
  })

  it('preview_sleep_stage_rules explains a null agreement when reference covers no classified epoch', async () => {
    callerMock.sleepStages.previewClassifier.mockResolvedValue({
      sleepRecordId: 42, enteredBedAt: 0, leftBedAt: 0, nights: 1, hasReference: true,
      saved: { ...STAGES, agreement: null }, candidate: { ...STAGES, agreement: null }, changed: { segments: [], changed: 0, total: 96 },
    })
    const result = parse(await call('preview_sleep_stage_rules', { side: 'left', presetId: 'default' }))
    expect(result).toMatchObject({ hasReference: true, hint: expect.stringContaining('cover none of the classified epochs') })
  })

  it('set_sleep_stage_rules does not claim another writer\'s change entry', async () => {
    const movementOnly = { engine: 'rules', ruleset: STAGE_RULESET_PRESETS.movementOnly.ruleset }
    callerMock.sleepStages.getClassifier
      .mockResolvedValueOnce(classifierState([CHANGE]))
      .mockResolvedValueOnce(classifierState([{ ...CHANGE, id: 9, summary: 'Reset to default' }, CHANGE]))
    callerMock.sleepStages.setClassifier.mockResolvedValue({ classifier: movementOnly, isDefault: false })
    const result = parse(await call('set_sleep_stage_rules', { side: 'left', presetId: 'movementOnly' }))
    expect(result).toMatchObject({ classifier: movementOnly, change: null, message: expect.stringContaining('another save landed') })
  })

  it('preview_sleep_stage_rules accepts a full ruleset and reports a side with no nights', async () => {
    callerMock.sleepStages.previewClassifier.mockResolvedValue({
      sleepRecordId: null, enteredBedAt: null, leftBedAt: null, nights: 0, hasReference: false, saved: null, candidate: null, changed: null,
    })

    const result = parse(await call('preview_sleep_stage_rules', { side: 'right', ruleset: STAGE_RULESET_PRESETS.movementOnly.ruleset }))
    expect(result).toMatchObject({
      side: 'right', candidateSource: 'ruleset', nights: 0, hasReference: false,
      hint: 'No sleep records for this side yet.',
      saved: null, candidate: null, kappaDelta: null, epochsChanged: 0, epochsTotal: 0,
    })
    expect(callerMock.sleepStages.previewClassifier).toHaveBeenCalledWith({
      side: 'right', nights: 7, classifier: { engine: 'rules', ruleset: STAGE_RULESET_PRESETS.movementOnly.ruleset },
    })
  })

  it('set_sleep_stage_rules saves a full ruleset and rethrows errors other than CONFLICT', async () => {
    callerMock.sleepStages.setClassifier.mockRejectedValue(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'disk full' }))
    const result = await call('set_sleep_stage_rules', { side: 'left', ruleset: STAGE_RULESET_PRESETS.movementOnly.ruleset })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('INTERNAL_SERVER_ERROR')
    expect(text(result)).not.toContain('CONFLICT (retryable)')
    expect(callerMock.sleepStages.setClassifier).toHaveBeenCalledWith({
      side: 'left', classifier: { engine: 'rules', ruleset: STAGE_RULESET_PRESETS.movementOnly.ruleset },
    })
  })
})
