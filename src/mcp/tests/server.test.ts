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
      getLatestSleep: fn(), getSleepRecords: fn(), getSleepStages: fn(), getVitalsSummary: fn(),
      getMovementSummary: fn(), getVitalsBaseline: fn(), getOccupancy: fn(),
    },
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
  temperatureControl: { left: { owner: 'manual' }, right: { owner: 'schedule' } },
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
      'get_sleep_summary',
      'get_vitals_trend',
      'manage_alarm',
      'manage_automation',
      'manage_schedule',
      'pod_maintenance',
      'prime_pod',
      'resume_schedule',
      'run_once_curve',
      'set_device_settings',
      'set_power',
      'set_side_settings',
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
      left: { currentTemperature: 70, targetTemperature: 72, powered: true, temperatureControl: { owner: 'manual' } },
      right: { powered: false },
      waterLevel: 'ok',
      wifi: { ssid: 'home', strength: -50 },
    })
    expect(callerMock.device.getStatus).toHaveBeenCalledWith({ unit: 'F' })
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

    const result = await client.callTool({ name: 'get_sleep_summary', arguments: { side: 'left' } }) as CallToolResult
    expect(parse(result)).toMatchObject({
      record: { id: 42, inBed: false, sleepDurationSeconds: 28800 },
      stages: { distribution: { deep: 3 } },
      vitals: { avgHeartRate: 55 },
      movement: { positionChanges: 12 },
    })
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

  it('serves the status resource', async () => {
    const client = await connect()
    const { contents } = await client.readResource({ uri: 'sleepypod://status' })
    const [content] = contents
    expect(content.mimeType).toBe('application/json')
    if (!('text' in content)) throw new Error('expected text content')
    expect(JSON.parse(content.text)).toMatchObject({ left: { powered: true } })
  })
})
