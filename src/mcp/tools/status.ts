/**
 * Read-only "what is the pod doing right now" tools.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getCaller, jsonResult, runTool } from '@/src/mcp/caller'
import { isoDate, unit } from '@/src/mcp/schemas'
import { fromSetpointF, resolveUnit } from '@/src/mcp/units'

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/** Compact per-side view of the raw hardware status. */
export async function buildPodStatus(requestedUnit: 'F' | 'C' | undefined) {
  const caller = getCaller()
  const u = await resolveUnit(requestedUnit)
  const status = await caller.device.getStatus({ unit: u })
  const sideView = (key: 'leftSide' | 'rightSide', s: 'left' | 'right') => {
    // The router converts side temperatures but leaves the controller's target in °F.
    const control = status.temperatureControl?.[s]
    return {
      currentTemperature: status[key].currentTemperature,
      targetTemperature: status[key].targetTemperature,
      powered: status[key].targetLevel !== 0,
      alarmVibrating: status[key].isAlarmVibrating ?? false,
      snooze: status.snooze[s],
      temperatureControl: control
        ? { ...control, targetTemperature: fromSetpointF(control.targetTemperature, u) }
        : null,
      pumpStall: status.pumpStallNotifications?.[s] ?? null,
    }
  }
  return {
    unit: u,
    left: sideView('leftSide', 'left'),
    right: sideView('rightSide', 'right'),
    waterLevel: status.waterLevel,
    isPriming: status.isPriming,
    primeCompletedNotification: status.primeCompletedNotification ?? null,
    roomClimate: status.roomClimate,
    wifi: { ssid: status.wifiSSID, strength: status.wifiStrength },
    podVersion: status.podVersion,
  }
}

export function registerStatusTools(server: McpServer) {
  server.registerTool('get_pod_status', {
    title: 'Get pod status',
    description:
      'Current state of both sides of the bed: live and target temperature, whether each side is powered, '
      + 'who controls the temperature right now (manual hold, schedule, run-once session or automation), '
      + 'alarm and snooze state, water level, priming, pump-stall notices, room climate and Wi-Fi. '
      + 'Use this first for any question about what the pod is doing now. Temperatures are in the requested '
      + 'unit, defaulting to the unit in device settings.',
    inputSchema: { unit },
    annotations: READ_ONLY,
  }, async ({ unit: u }) => runTool(async () => jsonResult(await buildPodStatus(u))))

  server.registerTool('get_environment', {
    title: 'Get bedroom environment',
    description:
      'Latest bed surface temperatures per side, ambient room temperature and humidity, freezer (thermal unit) '
      + 'temperature and ambient light. Pass both startDate and endDate for averaged summaries over a range '
      + 'instead of the latest readings. Use for "is my room too warm", "how bright was it last night".',
    inputSchema: { unit, startDate: isoDate, endDate: isoDate },
    annotations: READ_ONLY,
  }, async ({ unit: u, startDate, endDate }) => runTool(async () => {
    const caller = getCaller()
    if ((startDate === undefined) !== (endDate === undefined)) {
      throw new Error('A range summary needs both startDate and endDate; omit both for the latest readings.')
    }
    const resolved = await resolveUnit(u)
    if (startDate && endDate) {
      const range = { startDate: new Date(startDate), endDate: new Date(endDate) }
      const [environment, ambientLight] = await Promise.all([
        caller.environment.getSummary({ ...range, unit: resolved }),
        caller.environment.getAmbientLightSummary(range),
      ])
      return jsonResult({ unit: resolved, range, environment, ambientLight })
    }
    const [bed, freezer, light] = await Promise.all([
      caller.environment.getLatestBedTemp({ unit: resolved }),
      caller.environment.getLatestFreezerTemp({ unit: resolved }),
      caller.environment.getLatestAmbientLight({}),
    ])
    return jsonResult({ unit: resolved, bed, freezer, ambientLight: light })
  }))

  server.registerTool('diagnose_pod', {
    title: 'Diagnose pod health',
    description:
      'One-shot health report: service and database health, hardware socket latency, thermal truth per side '
      + '(is the pump actually delivering what was commanded), water level and open water alerts, open pump '
      + 'alerts, disk usage and installed version. Use when the user says the bed is not heating/cooling, '
      + 'something seems wrong, or asks "is everything OK". Each section is fetched independently, so a '
      + 'failing subsystem shows an error string instead of failing the whole report.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => runTool(async () => {
    const caller = getCaller()
    const settle = async <T>(p: Promise<T>): Promise<T | { error: string }> => {
      try {
        return await p
      }
      catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
    const [system, hardware, thermal, waterLevel, waterAlerts, pumpAlerts, disk, version, internet] = await Promise.all([
      settle(caller.health.system({})),
      settle(caller.health.hardware({})),
      settle(caller.health.thermal({})),
      settle(caller.waterLevel.getLatest({})),
      settle(caller.waterLevel.getAlerts({})),
      settle(caller.pumpAlerts.list({ limit: 10, includeAcknowledged: false })),
      settle(caller.system.getDiskUsage({})),
      settle(caller.system.getVersion({})),
      settle(caller.system.internetStatus({})),
    ])
    return jsonResult({ system, hardware, thermal, waterLevel, waterAlerts, pumpAlerts, disk, version, internet })
  }))

  server.registerTool('get_logs', {
    title: 'Read service logs',
    description:
      'Recent journal lines from a sleepypod systemd unit, newest first. Units: sleepypod.service (core app), '
      + 'sleepypod-piezo-processor.service (vitals), sleepypod-sleep-detector.service (sleep sessions), '
      + 'sleepypod-environment-monitor.service (sensors). Use after diagnose_pod when a subsystem is degraded.',
    inputSchema: {
      unit: z.enum([
        'sleepypod.service',
        'sleepypod-piezo-processor.service',
        'sleepypod-sleep-detector.service',
        'sleepypod-environment-monitor.service',
      ]).default('sleepypod.service').describe('Which service to read.'),
      lines: z.number().int().min(1).max(500).default(100),
      priority: z.enum(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']).optional()
        .describe('Only show this priority and more severe.'),
      since: z.string().optional().describe('journalctl --since value, e.g. "1 hour ago" or "2026-09-28 22:00".'),
    },
    annotations: READ_ONLY,
  }, async input => runTool(async () => jsonResult(await getCaller().system.getLogs(input))))
}
