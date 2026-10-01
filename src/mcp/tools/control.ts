/**
 * Tools that command hardware. Every one goes through the device or run-once
 * router so side locks, debounce and the pump-stall guard apply.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getCaller, jsonResult, runTool, textResult } from '@/src/mcp/caller'
import {
  alarmDuration,
  side,
  temperature,
  timeOfDay,
  unit,
  vibrationIntensity,
  vibrationPattern,
} from '@/src/mcp/schemas'
import { fromSetpointF, resolveUnit, toSetpointF } from '@/src/mcp/units'

// Repeating these calls has no further effect: same target, same power state, same released hold.
const IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
// Repeating these moves a deadline (hold expiry, snooze) or re-fires the motor.
const TIMED = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
// Starting a curve replaces any active session on that side.
const REPLACING = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }

export function registerControlTools(server: McpServer) {
  server.registerTool('set_temperature', {
    title: 'Set bed temperature',
    description:
      'Set the target temperature for one side and power it on. Takes a manual hold that overrides schedules '
      + 'and automations until it expires or resume_schedule is called. The hold lasts holdMinutes, default 30 '
      + 'minutes; when it expires, schedules and automations may take over again, but the side keeps running '
      + 'at the last target until the firmware\'s separate 8-hour runtime ends. Pass holdMinutes for "keep it '
      + 'at 68 all night". The bed moves about 1-2°F per minute, so a 7°F change takes 4-7 minutes. '
      + 'Temperature is in the given unit, defaulting to the device setting; it is converted to the 55-110°F '
      + 'hardware range.',
    inputSchema: {
      side,
      temperature,
      unit,
      holdMinutes: z.number().int().min(1).max(1440).optional()
        .describe('Keep this manual temperature for N minutes, then hand control back to schedules.'),
    },
    annotations: TIMED,
  }, async ({ side: s, temperature: t, unit: u, holdMinutes }) => runTool(async () => {
    const resolved = await resolveUnit(u)
    const setpoint = toSetpointF(t, resolved)
    await getCaller().device.setTemperature({ side: s, temperature: setpoint, holdMinutes })
    return textResult(`${s} side set to ${t}°${resolved} (${setpoint}°F)${holdMinutes ? ` for ${holdMinutes} min` : ''}.`)
  }))

  server.registerTool('set_power', {
    title: 'Turn a side on or off',
    description:
      'Power a side on (optionally at a temperature) or off. "Off" sets the bed to neutral; the pod has no true '
      + 'off state. Turning off does not disable schedules; the next scheduled event will turn it back on. '
      + 'Use set_side_settings with awayMode for a longer absence.',
    inputSchema: { side, powered: z.boolean().describe('true to turn on, false to turn off.'), temperature: temperature.optional(), unit },
    annotations: IDEMPOTENT,
  }, async ({ side: s, powered, temperature: t, unit: u }) => runTool(async () => {
    const resolved = await resolveUnit(u)
    const setpoint = t === undefined ? undefined : toSetpointF(t, resolved)
    await getCaller().device.setPower({ side: s, powered, temperature: setpoint })
    return textResult(`${s} side ${powered ? 'on' : 'off'}${setpoint ? ` at ${setpoint}°F` : ''}.`)
  }))

  server.registerTool('resume_schedule', {
    title: 'Release manual hold',
    description:
      'Drop the manual temperature hold on a side so schedules, run-once sessions and automations control it again. '
      + 'Returns the new controller status.',
    inputSchema: { side },
    annotations: IDEMPOTENT,
  }, async ({ side: s }) => runTool(async () => jsonResult(await getCaller().device.resumeTemperature({ side: s }))))

  server.registerTool('manage_alarm', {
    title: 'Trigger, stop or snooze the vibration alarm',
    description:
      'Immediate alarm control for one side. action "trigger" starts vibrating now (intensity, pattern and '
      + 'duration default to 50, "rise" and 60 s); "stop" silences it; "snooze" silences it and re-fires after '
      + 'snoozeMinutes (default 5). '
      + 'Scheduled wake-up alarms are managed with manage_schedule, not here.',
    inputSchema: {
      side,
      action: z.enum(['trigger', 'stop', 'snooze']),
      intensity: vibrationIntensity.optional(),
      pattern: vibrationPattern.optional(),
      duration: alarmDuration.optional(),
      snoozeMinutes: z.number().int().min(1).max(30).optional(),
    },
    annotations: TIMED,
  }, async ({ side: s, action, intensity, pattern, duration, snoozeMinutes }) => runTool(async () => {
    const caller = getCaller()
    if (action === 'stop') {
      await caller.device.clearAlarm({ side: s })
      return textResult(`${s} alarm stopped.`)
    }
    if (action === 'snooze') {
      const result = await caller.device.snoozeAlarm({
        side: s,
        duration: (snoozeMinutes ?? 5) * 60,
        vibrationIntensity: intensity ?? 50,
        vibrationPattern: pattern ?? 'rise',
        alarmDuration: duration ?? 120,
      })
      return textResult(`${s} alarm snoozed until ${new Date(result.snoozeUntil * 1000).toISOString()}.`)
    }
    await caller.device.setAlarm({
      side: s,
      vibrationIntensity: intensity ?? 50,
      vibrationPattern: pattern ?? 'rise',
      duration: duration ?? 60,
    })
    return textResult(`${s} alarm vibrating.`)
  }))

  server.registerTool('run_once_curve', {
    title: 'One-night temperature curve',
    description:
      'Start, inspect or cancel a one-night temperature curve for a side: a list of HH:MM set points applied '
      + 'from now until wakeTime, when the side is powered OFF. It does not vibrate or sound an alarm at '
      + 'wakeTime, and it does not hand control back to a schedule until the next scheduled event. Good for '
      + '"tonight only" requests like "68 now, 72 at 3am, warm to 78 at 6:30". There is no one-off alarm tool: '
      + 'a recurring wake-up alarm is manage_schedule kind "alarm", and manage_alarm only vibrates immediately. '
      + 'Max 14 hours. Replaces any active curve on that side. Temperatures use the given unit or the device default.',
    inputSchema: {
      side,
      action: z.enum(['start', 'status', 'cancel']),
      setPoints: z.array(z.object({ time: timeOfDay, temperature })).min(1).max(96).optional()
        .describe('Required for "start". First point applies immediately regardless of its time.'),
      wakeTime: timeOfDay.optional().describe('Required for "start". When the curve ends.'),
      unit,
    },
    annotations: REPLACING,
  }, async ({ side: s, action, setPoints, wakeTime, unit: u }) => runTool(async () => {
    const caller = getCaller()
    if (action === 'status') {
      const resolved = await resolveUnit(u)
      const active = await caller.runOnce.getActive({ side: s })
      if (!active) return jsonResult({ unit: resolved, active: null })
      return jsonResult({
        unit: resolved,
        active: {
          ...active,
          setPoints: active.setPoints.map(p => ({ ...p, temperature: fromSetpointF(p.temperature, resolved) })),
        },
      })
    }
    if (action === 'cancel') {
      await caller.runOnce.cancel({ side: s })
      return textResult(`Run-once curve on ${s} cancelled.`)
    }
    if (!setPoints || !wakeTime) throw new Error('"start" needs setPoints and wakeTime')
    const resolved = await resolveUnit(u)
    const result = await caller.runOnce.start({
      side: s,
      wakeTime,
      setPoints: setPoints.map(p => ({ time: p.time, temperature: toSetpointF(p.temperature, resolved) })),
    })
    return jsonResult({ ...result, expiresAt: new Date(result.expiresAt * 1000).toISOString() })
  }))

  server.registerTool('prime_pod', {
    title: 'Prime the water system',
    description:
      'Circulate water to purge air bubbles. Takes 2-5 minutes, is loud and vibrates the bed: never run it while '
      + 'someone is in bed. Use after a refill, when water level reads low, or when heating/cooling seems weak. '
      + 'Check get_pod_status isPriming first; priming while already priming errors.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async () => runTool(async () => {
    await getCaller().device.startPriming({})
    return textResult('Priming started. Poll get_pod_status until isPriming is false.')
  }))
}
