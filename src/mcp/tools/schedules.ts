/**
 * Recurring schedule tools. One read tool, one write tool with an action
 * enum, instead of the router's ten procedures, plus apply_sleep_curve for
 * writing a whole curve across sides and days in one batch.
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
import { fromSetpointF, resolveUnit, toSetpointF } from '@/src/mcp/units'
import { planCurveSave } from '@/src/lib/sleepCurve/savePlan'

const BATCH_ROW_LIMIT = 1000

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
      offTime: timeOfDay.optional().describe('Power schedules: schedule end time.'),
      endAction: z.enum(['turn_off', 'maintain']).optional().describe('Power schedules: turn off (default) or maintain the final temperature after the schedule ends.'),
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
          endAction: input.endAction,
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
        id: target, onTime: input.onTime, offTime: input.offTime, endAction: input.endAction, onTemperature: temp, enabled: input.enabled,
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

  server.registerTool('apply_sleep_curve', {
    title: 'Preview or save a recurring temperature curve',
    description:
      'Save a whole night\'s temperature curve as the recurring schedule for one or both sides on the given days, '
      + 'the same way the Schedule screen\'s curve editor does. Each day\'s temperature and power schedules are '
      + 'replaced; alarms are kept. The side turns on at the first set point and off at the last (overnight curves wrap '
      + 'past midnight); endAction "maintain" holds the last temperature instead of turning off. Set points inside a '
      + 'flat hold are dropped. Each row fires on its own weekday, so on "monday" a 01:00 point fires early Monday '
      + 'morning (the end of Sunday night). Call with mode "preview" first: it saves nothing and returns the simplified curve, the '
      + 'on/off window, the schedules it would replace and warnings. Show that to the user, then call again with mode '
      + '"apply" and the same arguments. Design guidance: 8-15 points from about 45 min before bedtime to 30 min after '
      + 'wake; warm-up, cooling ramp, coldest hold in the first deep-sleep hours, gradual pre-wake warming; water takes '
      + '15-20 min to settle; neutral is about 82.5°F. Base it on get_sleep_history, get_vitals_trend and '
      + 'get_schedules when the user asks for a curve from their data. For tonight only, use run_once_curve instead. '
      + 'Temperatures use the given unit or the device default.',
    inputSchema: {
      mode: z.enum(['preview', 'apply']).describe('"preview" is a dry run; "apply" saves.'),
      side: z.enum(['left', 'right', 'both']).describe('Which side to write, or "both" for the same curve on each.'),
      days: z.array(dayOfWeek).min(1).max(7).describe('Days of week this curve runs on, e.g. ["monday","tuesday"].'),
      setPoints: z.array(z.object({ time: timeOfDay, temperature })).min(2).max(48)
        .describe('Set points in any order; each holds until the next one fires.'),
      endAction: z.enum(['turn_off', 'maintain']).optional().describe('After the last set point: turn off (default) or keep holding it.'),
      unit,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async input => runTool(async () => {
    const caller = getCaller()
    const resolved = await resolveUnit(input.unit)
    const sides = input.side === 'both' ? (['left', 'right'] as const) : [input.side]
    const days = [...new Set(input.days)]

    const seen = new Set<string>()
    const setPointsF = input.setPoints.map((p) => {
      if (seen.has(p.time)) throw new Error(`Two set points at ${p.time}; give one temperature per time`)
      seen.add(p.time)
      const f = toSetpointF(p.temperature, resolved)
      if (f < 55 || f > 110) throw new Error(`${p.temperature}°${resolved} at ${p.time} is outside the hardware range 55-110°F (13-43°C)`)
      return { time: p.time, temperature: f }
    })

    const settings = await caller.settings.getAll({})
    const current = await Promise.all(sides.map(async sd => ({ side: sd, ...(await caller.schedules.getAll({ side: sd, unit: resolved })) })))
    const plan = planCurveSave({
      sides: [...sides],
      targetDays: days,
      setPoints: setPointsF,
      endAction: input.endAction,
      existing: {
        temperature: current.flatMap(c => c.temperature),
        power: current.flatMap(c => c.power),
      },
    })
    // schedules.batchUpdate caps each list at 1,000 rows; fail the preview rather than only the apply.
    const lists = { 'temperature deletes': plan.deletes.temperature, 'power deletes': plan.deletes.power, 'temperature creates': plan.creates.temperature, 'power creates': plan.creates.power }
    for (const [label, rows] of Object.entries(lists)) {
      if (rows.length > BATCH_ROW_LIMIT) throw new Error(`${rows.length} ${label} exceed the ${BATCH_ROW_LIMIT}-row batch limit; apply the curve to fewer days at a time`)
    }

    const daySet = new Set<string>(days)
    const replaces: Record<string, unknown> = {}
    for (const c of current) {
      const perDay: Record<string, unknown> = {}
      for (const day of days) {
        const temps = c.temperature.filter(t => t.dayOfWeek === day)
        const power = c.power.filter(p => p.dayOfWeek === day)
        if (temps.length === 0 && power.length === 0) continue
        perDay[day] = {
          setPoints: temps.map(t => ({ time: t.time, temperature: t.temperature, enabled: t.enabled }))
            .sort((a, b) => a.time.localeCompare(b.time)),
          power: power.map(p => ({ onTime: p.onTime, offTime: p.offTime, onTemperature: p.onTemperature, endAction: p.endAction, enabled: p.enabled })),
        }
      }
      replaces[c.side] = perDay
    }

    const warnings: string[] = []
    if (!plan.power) warnings.push('No on/off window: the first and last set points share a time. Add a later point or use endAction "maintain".')
    for (const sd of sides) {
      if (settings.sides[sd].awayMode) warnings.push(`Away mode is on for ${sd}: schedules will not fire until it is turned off.`)
    }
    const keptAlarms = current.reduce((n, c) => n + c.alarm.filter(a => daySet.has(a.dayOfWeek)).length, 0)

    const summary = {
      unit: resolved,
      sides,
      days,
      setPoints: plan.setPoints.map(p => ({ time: p.time, temperature: fromSetpointF(p.temperature, resolved) })),
      droppedFlatPoints: setPointsF.length - plan.setPoints.length,
      powerWindow: plan.power && { ...plan.power, onTemperature: fromSetpointF(plan.power.onTemperature, resolved) },
      replaces,
      keptAlarms,
      warnings,
    }

    if (input.mode === 'preview') {
      return jsonResult({
        dryRun: true,
        ...summary,
        rowsToDelete: plan.deletes.temperature.length + plan.deletes.power.length,
        rowsToCreate: plan.creates.temperature.length + plan.creates.power.length,
        apply: 'Call apply_sleep_curve with mode "apply" and the same arguments to save exactly this.',
      })
    }

    await caller.schedules.batchUpdate({ deletes: plan.deletes, creates: plan.creates })
    return jsonResult({
      saved: true,
      ...summary,
      rowsDeleted: plan.deletes.temperature.length + plan.deletes.power.length,
      rowsCreated: plan.creates.temperature.length + plan.creates.power.length,
    })
  }))
}
