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
import { sortChronological } from '@/src/lib/scheduleGrouping'
import { CURVE_NOTES_MAX, planCurveSave } from '@/src/lib/sleepCurve/savePlan'
import { LIBRARY_SIDES, movedDays, normalizeDays, planClaims, setPointsToPoints, uniqueCurveName } from '@/src/lib/scheduleLibrary'
import { formatDayRange } from '@/src/components/Schedule/scheduleFormat'
import type { TempUnit } from '@/src/lib/tempUtils'

const curveSetPoints = z.array(z.object({ time: timeOfDay, temperature })).min(2).max(48)

/** Caller-unit set points to integer °F, rejecting duplicate times and out-of-range values. */
function toSetPointsF(points: Array<{ time: string, temperature: number }>, unit: TempUnit) {
  const seen = new Set<string>()
  return points.map((p) => {
    if (seen.has(p.time)) throw new Error(`Two set points at ${p.time}; give one temperature per time`)
    seen.add(p.time)
    const f = toSetpointF(p.temperature, unit)
    if (f < 55 || f > 110) throw new Error(`${p.temperature}°${unit} at ${p.time} is outside the hardware range 55-110°F (13-43°C)`)
    return { time: p.time, temperature: f }
  })
}

export function registerScheduleTools(server: McpServer) {
  server.registerTool('get_schedules', {
    title: 'List schedules',
    description:
      'All recurring schedules for one or both sides, grouped as temperature (set a temp at a time), power '
      + '(on/off window with a temp) and alarm (vibration wake-up with a temp), each with its id, day of week, '
      + 'time and enabled flag, plus curve notes per day and the library curves running on that side (curves, by name '
      + 'and days; a day no curve claims was written one schedule at a time). Also returns per-side away mode and '
      + 'always-on so you can explain why a schedule is not firing. Temperatures in the requested or device-default unit.',
    inputSchema: { side: optionalSide, unit },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ side: s, unit: u }) => runTool(async () => {
    const caller = getCaller()
    const settings = await caller.settings.getAll({})
    const resolved = u ?? (settings.device.temperatureUnit === 'C' ? 'C' : 'F')
    const sides = s ? [s] : (['left', 'right'] as const)
    const result: Record<string, unknown> = { unit: resolved }
    const library = await caller.curveTemplates.list({})
    for (const sd of sides) {
      const schedules = await caller.schedules.getAll({ side: sd, unit: resolved })
      const sideSettings = settings.sides[sd]
      result[sd] = {
        awayMode: sideSettings.awayMode,
        alwaysOn: sideSettings.alwaysOn,
        ...schedules,
        notes: await caller.schedules.getNotes({ side: sd }),
        curves: library.filter(c => c.active && c.days[sd].length > 0).map(c => ({ name: c.name, days: c.days[sd] })),
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
      'Run a whole night\'s temperature curve on one or both sides on the given days. Every curve lives in the pod\'s '
      + 'schedule library (get_saved_curves): give setPoints to save a new curve (named by name, or after its days) or '
      + 'update the curve called name, or curveName to put an existing curve on more days. The curve turns on: one that '
      + 'was already on gains those days and keeps its others, one that was off runs on just those days. Two curves that are on never share a side and day, so those days move from '
      + 'any other curve running them, and a curve left with no days turns off (the preview lists these moves). Each '
      + 'day\'s temperature and power schedules are replaced; alarms are kept. The side turns on at the first set point '
      + 'and off at the last (overnight curves wrap past midnight); endAction "maintain" holds the last temperature '
      + 'instead of turning off. Set points inside a flat hold are dropped. Each row fires on its own weekday, so on '
      + '"monday" a 01:00 point fires early Monday morning (the end of Sunday night). Call with mode "preview" first: '
      + 'it saves nothing and returns the simplified curve, the on/off window, the schedules it would replace, the '
      + 'days it moves and warnings. Show that to the user, then call again with mode "apply" and the same arguments. '
      + 'Design guidance: 8-15 points from about 45 min before bedtime to 30 min after wake; warm-up, cooling ramp, '
      + 'coldest hold in the first deep-sleep hours, gradual pre-wake warming; water takes 15-20 min to settle; neutral '
      + 'is about 82.5°F. Base it on get_sleep_history, get_vitals_trend and get_schedules when the user asks for a '
      + 'curve from their data. Add notes saying what the curve is based on and what to watch (shown on the curve\'s '
      + 'card; a library curve keeps its notes when omitted). For tonight only, use run_once_curve instead. '
      + 'Temperatures use the given unit or the device default.',
    inputSchema: {
      mode: z.enum(['preview', 'apply']).describe('"preview" is a dry run; "apply" saves.'),
      side: z.enum(['left', 'right', 'both']).describe('Which side to write, or "both" for the same curve on each.'),
      days: z.array(dayOfWeek).min(1).max(7).describe('Days of week this curve runs on, e.g. ["monday","tuesday"].'),
      setPoints: curveSetPoints.optional()
        .describe('Set points in any order; each holds until the next one fires. Omit when giving curveName.'),
      name: z.string().trim().min(1).max(30).optional()
        .describe('With setPoints: the library curve to save them as (replaces that curve\'s set points if it exists).'),
      curveName: z.string().optional().describe('Run this library curve (see get_saved_curves) instead of setPoints.'),
      notes: z.string().max(CURVE_NOTES_MAX).optional().describe('Short note for the curve, e.g. what data it is based on.'),
      endAction: z.enum(['turn_off', 'maintain']).optional().describe('After the last set point: turn off (default) or keep holding it.'),
      unit,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async input => runTool(async () => {
    const caller = getCaller()
    const resolved = await resolveUnit(input.unit)
    const sides = input.side === 'both' ? (['left', 'right'] as const) : [input.side]
    const days = [...new Set(input.days)]

    if ((input.setPoints === undefined) === (input.curveName === undefined)) throw new Error('Give exactly one of setPoints or curveName')
    if (input.curveName !== undefined && input.name !== undefined) throw new Error('name only goes with setPoints; curveName already names the curve')
    const library = await caller.curveTemplates.list({})
    const curveName = (input.curveName ?? input.name ?? '').trim()
    const existing = curveName ? library.find(t => t.name === curveName) : undefined
    let setPointsF: Array<{ time: string, temperature: number }>
    if (input.setPoints) {
      setPointsF = toSetPointsF(input.setPoints, resolved)
    }
    else {
      if (!existing) throw new Error(`No curve named "${curveName}"; call get_saved_curves for the names`)
      setPointsF = Object.entries(existing.points).map(([time, temp]) => ({ time, temperature: temp }))
    }
    const notes = input.notes ?? existing?.notes ?? ''
    const endAction = input.endAction ?? existing?.endAction ?? 'turn_off'

    const settings = await caller.settings.getAll({})
    const current = await Promise.all(sides.map(async sd => ({
      side: sd,
      ...(await caller.schedules.getAll({ side: sd, unit: resolved })),
      notes: await caller.schedules.getNotes({ side: sd }),
    })))
    const plan = planCurveSave({
      sides: [...sides],
      targetDays: days,
      setPoints: setPointsF,
      endAction,
      notes,
      existing: {
        temperature: current.flatMap(c => c.temperature),
        power: current.flatMap(c => c.power),
      },
    })

    // An active curve gains these days; one that is off runs on just these.
    const nextDays = normalizeDays(existing?.active ? existing.days : undefined)
    for (const sd of sides) nextDays[sd] = [...new Set([...nextDays[sd], ...days])]
    const { moves } = planClaims(library, existing?.id ?? null, normalizeDays(nextDays), true)
    const taken = new Set(library.filter(t => t.id !== existing?.id).map(t => t.name))
    const name = existing?.name ?? (curveName || uniqueCurveName(`${formatDayRange(days, { named: true })} curve`, taken))
    // The curve was running other days already: they are rewritten too when its set points change.
    const alsoRewrites = existing?.active && input.setPoints
      ? Object.fromEntries(LIBRARY_SIDES.map(sd => [sd, existing.days[sd].filter(d => !(sides as readonly string[]).includes(sd) || !days.includes(d))]).filter(([, d]) => d.length > 0))
      : {}

    const daySet = new Set<string>(days)
    const replaces: Record<string, unknown> = {}
    for (const c of current) {
      const perDay: Record<string, unknown> = {}
      for (const day of days) {
        const temps = c.temperature.filter(t => t.dayOfWeek === day)
        const power = c.power.filter(p => p.dayOfWeek === day)
        const note = c.notes.find(n => n.dayOfWeek === day)?.notes
        if (temps.length === 0 && power.length === 0 && !note) continue
        perDay[day] = {
          setPoints: temps.map(t => ({ time: t.time, temperature: t.temperature, enabled: t.enabled }))
            .sort((a, b) => a.time.localeCompare(b.time)),
          power: power.map(p => ({ onTime: p.onTime, offTime: p.offTime, onTemperature: p.onTemperature, endAction: p.endAction, enabled: p.enabled })),
          ...(note && { notes: note }),
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
      curve: { name, isNew: !existing, days: normalizeDays(nextDays) },
      sides,
      days,
      setPoints: plan.setPoints.map(p => ({ time: p.time, temperature: fromSetpointF(p.temperature, resolved) })),
      droppedFlatPoints: setPointsF.length - plan.setPoints.length,
      powerWindow: plan.power && { ...plan.power, onTemperature: fromSetpointF(plan.power.onTemperature, resolved) },
      notes: plan.notes.find(n => n.notes)?.notes ?? null,
      replaces,
      movesDaysFrom: movedDays(moves),
      ...(Object.keys(alsoRewrites).length > 0 && { alsoRewrites }),
      keptAlarms,
      warnings,
    }

    if (input.mode === 'preview') {
      return jsonResult({
        dryRun: true,
        ...summary,
        apply: 'Call apply_sleep_curve with mode "apply" and the same arguments to save exactly this.',
      })
    }

    const sorted = plan.setPoints
    await caller.curveTemplates.put({
      id: existing?.id,
      name,
      bedtime: existing && !input.setPoints ? existing.bedtime : sorted[0].time,
      wake: existing && !input.setPoints ? existing.wake : sorted[sorted.length - 1].time,
      points: setPointsToPoints(sorted),
      notes,
      endAction,
      days: normalizeDays(nextDays),
      active: true,
    })
    return jsonResult({ saved: true, ...summary })
  }))

  server.registerTool('get_saved_curves', {
    title: 'List the schedule library',
    description:
      'Every curve saved on the pod (by the Schedule screen, the AI curve wizard, apply_sleep_curve or '
      + 'manage_saved_curve), newest first. Each curve has its days per side and whether it is on: a curve that is on '
      + 'runs on its days, and two curves that are on never share a side and day. One that is off (or has no days) does '
      + 'nothing until turned on with manage_saved_curve "activate" or run with apply_sleep_curve curveName. Set points '
      + 'are in chronological order from bedtime; temperatures in the requested or device-default unit.',
    inputSchema: { unit },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ unit: u }) => runTool(async () => {
    const resolved = await resolveUnit(u)
    const curves = await getCaller().curveTemplates.list({})
    return jsonResult({
      unit: resolved,
      curves: curves.map(c => ({
        name: c.name,
        active: c.active,
        days: c.days,
        endAction: c.endAction,
        bedtime: c.bedtime,
        wake: c.wake,
        setPoints: sortChronological(Object.entries(c.points).map(([time, temp]) => ({ time, temperature: temp })))
          .map(p => ({ time: p.time, temperature: fromSetpointF(p.temperature, resolved) })),
        notes: c.notes,
        updatedAt: c.updatedAt.toISOString(),
      })),
    })
  }))

  server.registerTool('manage_saved_curve', {
    title: 'Save, turn on, turn off or delete a library curve',
    description:
      'Manage the schedule library by curve name (up to 30 characters). "save" stores set points under a name, '
      + 'replacing the set points of an existing curve and keeping its days; a curve that is on is rewritten straight '
      + 'away, a new one is saved off. "activate" turns a curve on: on its saved days, or with side and days on those '
      + 'days for that side (replacing its days there). Days another curve that is on runs move to it, and a curve left '
      + 'with no days turns off; the result lists them. "deactivate" turns it off: its days stop running but the curve '
      + 'and its days are kept. "delete" removes the curve, and its days stop running if it was on. bedtime and wake '
      + 'label the curve and anchor the editor; set points usually run from about 45 min before bedtime to 30 min after '
      + 'wake. Temperatures use the given unit or the device default.',
    inputSchema: {
      action: z.enum(['save', 'activate', 'deactivate', 'delete']),
      name: z.string().min(1).max(30).describe('Curve name, e.g. "Late Warm". Exact match except for save.'),
      bedtime: timeOfDay.optional().describe('Required for save.'),
      wake: timeOfDay.optional().describe('Required for save.'),
      setPoints: curveSetPoints.optional().describe('Required for save. 2-48 points in any order.'),
      notes: z.string().max(CURVE_NOTES_MAX).optional().describe('Optional note: why the curve looks the way it does, what data it is based on.'),
      endAction: z.enum(['turn_off', 'maintain']).optional().describe('save: after the last set point, turn off or keep holding it.'),
      side: z.enum(['left', 'right', 'both']).optional().describe('activate: the side(s) to set days on; omit to use the saved days.'),
      days: z.array(dayOfWeek).min(1).max(7).optional().describe('activate with side: the days it runs on there.'),
      unit,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async input => runTool(async () => {
    const caller = getCaller()
    const name = input.name.trim()
    if (input.action === 'delete') {
      const { deleted } = await caller.curveTemplates.delete({ name })
      return textResult(deleted ? `Deleted curve "${name}".` : `No curve named "${name}".`)
    }
    if (input.action === 'activate' || input.action === 'deactivate') {
      const curve = (await caller.curveTemplates.list({})).find(t => t.name === name)
      if (!curve) throw new Error(`No curve named "${name}"; call get_saved_curves for the names`)
      if ((input.side === undefined) !== (input.days === undefined)) throw new Error('Give side and days together, or neither to use the saved days')
      const moved = (r: { moved: Array<{ name: string, side: string, days: string[], deactivated: boolean }> }) => r.moved
      if (input.action === 'deactivate' || !input.side || !input.days) {
        const result = await caller.curveTemplates.setActive({ id: curve.id, active: input.action === 'activate' })
        return jsonResult({ name, active: result.curve.active, days: result.curve.days, movedDaysFrom: moved(result) })
      }
      const days = normalizeDays(curve.days)
      const sides = input.side === 'both' ? LIBRARY_SIDES : [input.side]
      for (const sd of sides) days[sd] = [...new Set(input.days)]
      const result = await caller.curveTemplates.put({
        id: curve.id,
        name: curve.name,
        bedtime: curve.bedtime,
        wake: curve.wake,
        points: curve.points,
        notes: curve.notes,
        endAction: curve.endAction,
        days: normalizeDays(days),
        active: true,
      })
      return jsonResult({ name, active: result.curve.active, days: result.curve.days, movedDaysFrom: moved(result) })
    }
    if (!input.bedtime || !input.wake || !input.setPoints) throw new Error('save needs bedtime, wake and setPoints')
    const resolved = await resolveUnit(input.unit)
    const points = Object.fromEntries(toSetPointsF(input.setPoints, resolved).map(p => [p.time, p.temperature]))
    const before = (await caller.curveTemplates.list({})).find(t => t.name === name)
    const saved = await caller.curveTemplates.save({
      name, bedtime: input.bedtime, wake: input.wake, points, notes: input.notes ?? '', endAction: input.endAction,
    })
    return jsonResult({
      saved: true,
      name: saved.name,
      bedtime: saved.bedtime,
      wake: saved.wake,
      setPointCount: Object.keys(saved.points).length,
      replacedExisting: before !== undefined,
      active: saved.active,
      days: saved.days,
    })
  }))
}
