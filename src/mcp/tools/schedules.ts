/**
 * Recurring schedule tools. One read tool, one write tool with an action
 * enum, instead of the router's ten procedures.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getCaller, jsonResult, runTool, textResult } from '@/src/mcp/caller'
import {
  alarmDuration,
  dayOfWeek,
  optionalSide,
  side,
  temperature,
  timeOfDay,
  unit,
  vibrationIntensity,
  vibrationPattern,
} from '@/src/mcp/schemas'
import { resolveUnit, toSetpointF } from '@/src/mcp/units'

export function registerScheduleTools(server: McpServer) {
  server.registerTool('get_schedules', {
    title: 'List schedules',
    description:
      'All recurring schedules for one or both sides, grouped as temperature (set a temp at a time), power '
      + '(on/off window with a temp) and alarm (vibration wake-up with a temp), each with its id, day of week, '
      + 'time and enabled flag. Also returns per-side away mode and always-on so you can explain why a '
      + 'schedule is not firing. Temperatures in the requested or device-default unit.',
    inputSchema: { side: optionalSide, unit },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ side: s, unit: u }) => runTool(async () => {
    const caller = getCaller()
    const settings = await caller.settings.getAll({})
    const resolved = u ?? (settings.device.temperatureUnit === 'C' ? 'C' : 'F')
    const sides = s ? [s] : (['left', 'right'] as const)
    const result: Record<string, unknown> = { unit: resolved }
    for (const sd of sides) {
      const schedules = await caller.schedules.getAll({ side: sd, unit: resolved })
      const sideSettings = settings.sides[sd]
      result[sd] = {
        awayMode: sideSettings.awayMode,
        alwaysOn: sideSettings.alwaysOn,
        ...schedules,
      }
    }
    return jsonResult(result)
  }))

  server.registerTool('manage_schedule', {
    title: 'Create, update or delete a schedule',
    description:
      'Write one recurring schedule. action "create" needs side, dayOfWeek and the fields for its kind; '
      + '"update" and "delete" need the id from get_schedules. An update cannot change side or dayOfWeek: '
      + 'delete and recreate instead. Kinds: "temperature" (time + temperature), '
      + '"power" (onTime, offTime, temperature) and "alarm" (time, intensity, pattern, duration, temperature to '
      + 'warm to at wake). A schedule covers one day; call once per day for "every weekday". Temperatures use '
      + 'the given unit or the device default.',
    inputSchema: {
      action: z.enum(['create', 'update', 'delete']),
      kind: z.enum(['temperature', 'power', 'alarm']),
      id: z.number().int().positive().optional().describe('Schedule id for update/delete.'),
      side: side.optional(),
      dayOfWeek: dayOfWeek.optional(),
      time: timeOfDay.optional().describe('Fire time for temperature and alarm schedules.'),
      onTime: timeOfDay.optional().describe('Power schedules: when to turn on.'),
      offTime: timeOfDay.optional().describe('Power schedules: when to turn off.'),
      temperature: temperature.optional(),
      unit,
      intensity: vibrationIntensity.optional(),
      pattern: vibrationPattern.optional(),
      duration: alarmDuration.optional(),
      enabled: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async input => runTool(async () => {
    const caller = getCaller()
    const { action, kind, id } = input
    const need = <T>(value: T | undefined, name: string): T => {
      if (value === undefined) throw new Error(`${name} is required for ${action} ${kind}`)
      return value
    }

    if (action === 'delete') {
      const target = { id: need(id, 'id') }
      if (kind === 'temperature') await caller.schedules.deleteTemperatureSchedule(target)
      else if (kind === 'power') await caller.schedules.deletePowerSchedule(target)
      else await caller.schedules.deleteAlarmSchedule(target)
      return textResult(`Deleted ${kind} schedule ${target.id}.`)
    }

    const resolved = await resolveUnit(input.unit)
    const temp = input.temperature === undefined ? undefined : toSetpointF(input.temperature, resolved)

    if (action === 'create') {
      const base = { side: need(input.side, 'side'), dayOfWeek: need(input.dayOfWeek, 'dayOfWeek'), enabled: input.enabled ?? true }
      if (kind === 'temperature') {
        return jsonResult(await caller.schedules.createTemperatureSchedule({
          ...base, time: need(input.time, 'time'), temperature: need(temp, 'temperature'),
        }))
      }
      if (kind === 'power') {
        return jsonResult(await caller.schedules.createPowerSchedule({
          ...base,
          onTime: need(input.onTime, 'onTime'),
          offTime: need(input.offTime, 'offTime'),
          onTemperature: need(temp, 'temperature'),
        }))
      }
      return jsonResult(await caller.schedules.createAlarmSchedule({
        ...base,
        time: need(input.time, 'time'),
        vibrationIntensity: input.intensity ?? 50,
        vibrationPattern: input.pattern ?? 'rise',
        duration: input.duration ?? 60,
        alarmTemperature: need(temp, 'temperature'),
      }))
    }

    const target = need(id, 'id')
    if (input.side !== undefined || input.dayOfWeek !== undefined) {
      throw new Error('side and dayOfWeek cannot be changed on update; delete the schedule and create a new one')
    }
    if (kind === 'temperature') {
      return jsonResult(await caller.schedules.updateTemperatureSchedule({
        id: target, time: input.time, temperature: temp, enabled: input.enabled,
      }))
    }
    if (kind === 'power') {
      return jsonResult(await caller.schedules.updatePowerSchedule({
        id: target, onTime: input.onTime, offTime: input.offTime, onTemperature: temp, enabled: input.enabled,
      }))
    }
    return jsonResult(await caller.schedules.updateAlarmSchedule({
      id: target,
      time: input.time,
      vibrationIntensity: input.intensity,
      vibrationPattern: input.pattern,
      duration: input.duration,
      alarmTemperature: temp,
      enabled: input.enabled,
    }))
  }))
}
