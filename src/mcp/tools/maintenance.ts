/**
 * Maintenance actions. Kept separate from the read-only diagnose_pod so the
 * host can show a distinct approval prompt for anything that restarts,
 * deletes or re-energizes.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { branchNameSchema } from '@/src/server/validation-schemas'
import { getCaller, jsonResult, runTool } from '@/src/mcp/caller'
import { side } from '@/src/mcp/schemas'

export function registerMaintenanceTools(server: McpServer) {
  server.registerTool('pod_maintenance', {
    title: 'Run a maintenance action',
    description:
      'Actions: "acknowledge_pump_alert" (side required) clears a pump-stall trip and restores the side\'s '
      + 'previous target; "dismiss_water_alert" (alertId required) hides a water-level alert; '
      + '"restart_service" (service required) restarts a biometrics sidecar; "free_storage" deletes old raw '
      + 'sensor files, and database backups too when includeDbBackups is true; "check_database_integrity" runs '
      + 'a SQLite integrity check; "update_software" opens the firewall briefly and installs the latest release '
      + '(or branch), restarting the app. Confirm with the user before restart, free_storage or update.',
    inputSchema: {
      action: z.enum([
        'acknowledge_pump_alert',
        'dismiss_water_alert',
        'restart_service',
        'free_storage',
        'check_database_integrity',
        'update_software',
      ]),
      side: side.optional(),
      alertId: z.number().int().positive().optional(),
      service: z.enum([
        'sleepypod-piezo-processor.service',
        'sleepypod-sleep-detector.service',
        'sleepypod-environment-monitor.service',
      ]).optional(),
      includeDbBackups: z.boolean().optional(),
      branch: branchNameSchema.optional().describe('Git branch to install instead of the latest release.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ action, side: s, alertId, service, includeDbBackups, branch }) => runTool(async () => {
    const caller = getCaller()
    const need = <T>(value: T | undefined, name: string): T => {
      if (value === undefined) throw new Error(`${name} is required for ${action}`)
      return value
    }
    switch (action) {
      case 'acknowledge_pump_alert':
        return jsonResult(await caller.pumpAlerts.acknowledgeAndRestore({ side: need(s, 'side'), alertId }))
      case 'dismiss_water_alert':
        return jsonResult(await caller.waterLevel.dismissAlert({ id: need(alertId, 'alertId') }))
      case 'restart_service':
        return jsonResult(await caller.health.restartService({ unit: need(service, 'service') }))
      case 'free_storage':
        return jsonResult(await caller.system.freeStorage({ includeDbBackups: includeDbBackups ?? false }))
      case 'check_database_integrity':
        return jsonResult(await caller.databases.checkIntegrity({}))
      case 'update_software':
        return jsonResult(await caller.system.triggerUpdate({ branch }))
    }
  }))
}
