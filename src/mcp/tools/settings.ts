/**
 * Settings tools. Away mode, always-on and auto-off live on the side;
 * timezone, unit, LED and daily maintenance live on the device.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getCaller, jsonResult, runTool, textResult } from '@/src/mcp/caller'
import { side, timeOfDay } from '@/src/mcp/schemas'
import { natsSubjectPrefixSchema } from '@/src/server/validation-schemas'

const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }

export const NATS_PREFIX_FOLLOW_UP
  = 'natsSubjectPrefix saved. The live sensor stream re-subscribed already. The biometrics modules read the prefix at '
    + 'startup: restart sleepypod-piezo-processor.service, sleepypod-sleep-detector.service and '
    + 'sleepypod-environment-monitor.service with pod_maintenance restart_service (confirm with the user first); '
    + 'sleepypod-calibrator.service picks it up on its next restart. '
    + 'Check get_sensor_source afterwards to confirm frames are arriving.'

export function registerSettingsTools(server: McpServer) {
  server.registerTool('get_settings', {
    title: 'Get device and side settings',
    description:
      'Device settings (timezone, temperature unit, LED night mode, daily reboot and prime, pump-stall '
      + 'protection, HomeKit) and per-side settings (name, away mode, always-on, auto-off). Read before '
      + 'changing anything so you only send the fields that differ.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => runTool(async () => {
    const settings = await getCaller().settings.getAll({})
    return jsonResult({ device: settings.device, sides: settings.sides })
  }))

  server.registerTool('set_side_settings', {
    title: 'Change side settings',
    description:
      'Update one side. awayMode pauses the recurring schedules for that side ("I am travelling until Friday": '
      + 'set awayMode with awayReturn). It does not pause automations; use manage_automation for those. '
      + 'alwaysOn keeps the side running past the firmware 8-hour timeout. '
      + 'autoOff turns the side off after autoOffMinutes once the bed is empty. '
      + 'autoOn (experimental) turns the side on once a person has been in bed for autoOnMinutes, between autoOnStart '
      + 'and autoOnEnd local time (HH:MM, wraps midnight; equal times = any time); pets and other light loads never trigger it. '
      + 'Only the provided fields change.',
    inputSchema: {
      side,
      name: z.string().min(1).max(20).optional().describe('Display name, e.g. the sleeper\'s first name.'),
      awayMode: z.boolean().optional(),
      awayStart: z.string().datetime({ offset: true }).nullable().optional().describe('ISO datetime away mode begins.'),
      awayReturn: z.string().datetime({ offset: true }).nullable().optional().describe('ISO datetime away mode ends automatically.'),
      alwaysOn: z.boolean().optional(),
      autoOffEnabled: z.boolean().optional(),
      autoOffMinutes: z.number().int().min(5).max(120).optional(),
      autoOnEnabled: z.boolean().optional(),
      autoOnMinutes: z.number().int().min(1).max(60).optional().describe('Minutes a person must be in bed before auto-on fires.'),
      autoOnStart: timeOfDay.optional().describe('Auto-on window start, HH:MM local time.'),
      autoOnEnd: timeOfDay.optional().describe('Auto-on window end, HH:MM local time.'),
    },
    annotations: MUTATING,
  }, async input => runTool(async () => jsonResult(await getCaller().settings.updateSide(input))))

  server.registerTool('set_device_settings', {
    title: 'Change device settings',
    description:
      'Update pod-wide settings: timezone (IANA name), temperatureUnit shown in the app, daily reboot and daily '
      + 'prime times, LED night mode and brightness, globalMaxOnHours safety cap, natsSubjectPrefix for the sensor '
      + 'readers. Only the provided fields change.',
    inputSchema: {
      timezone: z.string().optional().describe('IANA timezone, e.g. "America/Los_Angeles".'),
      temperatureUnit: z.enum(['F', 'C']).optional(),
      defaultScheduleEndAction: z.enum(['turn_off', 'maintain']).optional().describe('Default for new curves in the apps; existing schedules are unchanged.'),
      rebootDaily: z.boolean().optional(),
      rebootTime: timeOfDay.optional(),
      primePodDaily: z.boolean().optional(),
      primePodTime: timeOfDay.optional(),
      ledNightModeEnabled: z.boolean().optional(),
      ledDayBrightness: z.number().int().min(0).max(100).optional(),
      ledNightBrightness: z.number().int().min(0).max(100).optional(),
      ledNightStartTime: timeOfDay.optional(),
      ledNightEndTime: timeOfDay.optional(),
      globalMaxOnHours: z.number().int().min(1).max(48).nullable().optional()
        .describe('Force every side off after this many continuous hours. null disables the cap.'),
      natsSubjectPrefix: natsSubjectPrefixSchema.nullable().optional()
        .describe('NATS subject prefix the sensor readers subscribe under (<prefix>.sens.> and <prefix>.frz.>). '
          + 'null = auto: read "raw" and "rawmem", raw winning per subject. Pin a prefix only when get_sensor_source '
          + 'shows the firmware publishing under one the readers do not subscribe to; set null to return to auto.'),
    },
    annotations: MUTATING,
  }, async input => runTool(async () => {
    const result = jsonResult(await getCaller().settings.updateDevice(input))
    if (input.natsSubjectPrefix === undefined) return result
    return { content: [...result.content, ...textResult(NATS_PREFIX_FOLLOW_UP).content] }
  }))
}
