/**
 * Sleepypod MCP server.
 *
 * A curated, intent-shaped view over the tRPC API for LLM hosts (Claude
 * Desktop, Claude Code, Cursor, ...). Tools wrap one or several procedures
 * each; see src/mcp/README.md for the intent catalogue. The server is
 * stateless: a fresh instance is built per HTTP request, which is cheap
 * because registration is just closures over the shared tRPC caller.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getCaller } from '@/src/mcp/caller'
import { registerAutomationTools } from '@/src/mcp/tools/automations'
import { registerControlTools } from '@/src/mcp/tools/control'
import { registerMaintenanceTools } from '@/src/mcp/tools/maintenance'
import { registerScheduleTools } from '@/src/mcp/tools/schedules'
import { registerSettingsTools } from '@/src/mcp/tools/settings'
import { registerSleepTools } from '@/src/mcp/tools/sleep'
import { buildPodStatus, registerStatusTools } from '@/src/mcp/tools/status'

export const MCP_SERVER_NAME = 'sleepypod'

const INSTRUCTIONS = `Sleepypod controls an Eight Sleep Pod running the open-source sleepypod firmware on the local network.
The bed has two independent sides ("left" and "right"), each with its own temperature, schedules and sleeper.
Temperature control precedence, highest first: manual hold (set_temperature) > run-once curve > automation > schedule.
Start with get_pod_status for anything about the present, get_sleep_summary for last night, and diagnose_pod when something seems wrong.
Confirm with the user before prime_pod, pod_maintenance and manage_schedule delete.`

function json(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] }
}

export function createSleepypodMcpServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: process.env.npm_package_version ?? '0.0.0-dev' },
    { instructions: INSTRUCTIONS },
  )

  registerStatusTools(server)
  registerSleepTools(server)
  registerControlTools(server)
  registerScheduleTools(server)
  registerSettingsTools(server)
  registerAutomationTools(server)
  registerMaintenanceTools(server)

  server.registerResource('status', 'sleepypod://status', {
    title: 'Pod status',
    description: 'Live snapshot of both sides, water level, priming and room climate.',
    mimeType: 'application/json',
  }, async uri => json(uri.href, await buildPodStatus(undefined)))

  server.registerResource('settings', 'sleepypod://settings', {
    title: 'Device and side settings',
    description: 'Timezone, unit, away mode, always-on and other configuration.',
    mimeType: 'application/json',
  }, async (uri) => {
    const settings = await getCaller().settings.getAll({})
    return json(uri.href, { device: settings.device, sides: settings.sides })
  })

  server.registerPrompt('morning_report', {
    title: 'Morning report',
    description: 'Summarize last night for both sides and flag anything unusual.',
    argsSchema: {},
  }, () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: 'Give me a short morning report for the pod. For each side that was slept on, call get_sleep_summary '
          + 'and get_vitals_trend, then compare last night to the baseline. Call diagnose_pod and mention anything '
          + 'degraded, low water, or open alerts. Keep it to a few sentences per side.',
      },
    }],
  }))

  server.registerPrompt('bedtime', {
    title: 'Set up tonight',
    description: 'Plan tonight\'s temperatures for one side from a plain-language request.',
    argsSchema: {
      side: z.enum(['left', 'right']).describe('Which side.'),
      request: z.string().describe('What the sleeper wants tonight, in their words.'),
    },
  }, ({ side, request }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Set up the ${side} side for tonight. The sleeper says: "${request}". First call get_pod_status and `
          + 'get_schedules to see the current state and unit. If the request is for tonight only, use run_once_curve '
          + 'with a wake time; if it is a one-off temperature now, use set_temperature; if it should repeat, use '
          + 'manage_schedule. Explain the plan in one or two sentences before applying it.',
      },
    }],
  }))

  return server
}
