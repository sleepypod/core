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
import { CURVE_DESIGN_GUIDANCE } from '@/src/lib/sleepCurve/curvePrompt'
import { getCaller } from '@/src/mcp/caller'
import { registerBiometricTools, registerBiometricResourcesAndPrompts } from '@/src/mcp/tools/biometrics'
import { registerAutomationTools } from '@/src/mcp/tools/automations'
import { registerControlTools } from '@/src/mcp/tools/control'
import { registerMaintenanceTools } from '@/src/mcp/tools/maintenance'
import { registerScheduleTools } from '@/src/mcp/tools/schedules'
import { registerSettingsTools } from '@/src/mcp/tools/settings'
import { registerSleepTools } from '@/src/mcp/tools/sleep'
import { registerStageModelTools } from '@/src/mcp/tools/stageModels'
import { buildPodStatus, registerStatusTools } from '@/src/mcp/tools/status'

export const MCP_SERVER_NAME = 'sleepypod'

const INSTRUCTIONS = `Sleepypod controls an Eight Sleep Pod running the open-source sleepypod firmware on the local network.
The bed has two independent sides ("left" and "right"), each with its own temperature, schedules and sleeper.
Temperature control precedence, highest first: manual hold (set_temperature) > run-once curve > automation > schedule.
Start with get_pod_status for anything about the present, get_sleep_summary for last night, and diagnose_pod when something seems wrong.
Confirm with the user before prime_pod, pod_maintenance and manage_schedule delete.
Run apply_sleep_curve with mode "preview" and show the result before calling it with mode "apply".
Run preview_sleep_stage_rules before set_sleep_stage_rules and apply a tuned ruleset only when it improves kappa against the reference stages; a reset or rollback the user asks for does not need to.
Nights without reference stages cannot be scored (see get_sleep_stage_rules coverage); import Apple Watch stages with import_apple_watch_data first.
Every classifier change is recorded in the change log with the ruleset before it, and can be reverted by setting that previous ruleset again.
Personal stage models: run preview_stage_model before select_stage_model, report in-sample scores as in-sample, and select or activate a model only after the user approves; set_stage_model_active with active false returns a side to the rules.`

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
  registerStageModelTools(server)
  registerControlTools(server)
  registerScheduleTools(server)
  registerSettingsTools(server)
  registerAutomationTools(server)
  registerBiometricTools(server)
  registerBiometricResourcesAndPrompts(server)
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
          + 'with a wake time; if it is a one-off temperature now, use set_temperature; if a whole curve should repeat, '
          + 'use apply_sleep_curve; for a single recurring change, use manage_schedule. Explain the plan in one or two '
          + 'sentences before applying it.',
      },
    }],
  }))

  server.registerPrompt('design_sleep_curve', {
    title: 'Design a sleep curve',
    description: 'Build a recurring temperature curve for a side from its sleep data and the sleeper\'s preferences.',
    argsSchema: {
      side: z.enum(['left', 'right', 'both']).describe('Which side, or both.'),
      request: z.string().optional().describe('What the sleeper wants, in their words (e.g. "I run hot, wake at 6:30").'),
    },
  }, ({ side, request }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Design a recurring nightly temperature curve for the ${side === 'both' ? 'left and right sides' : `${side} side`}. `
          + (request ? `The sleeper says: "${request}". ` : '')
          + 'First gather data: get_schedules (current curve, unit, away mode), get_sleep_history for the last 14 days '
          + '(typical bedtime, wake time, wake-ups), get_vitals_trend (heart rate and HRV against baseline) and '
          + 'get_environment (room temperature). Use the sleeper\'s words over the data where they disagree, and say '
          + 'what you inferred from the data.\n\n'
          + `${CURVE_DESIGN_GUIDANCE}\n\n`
          + 'Build 8-15 set points from about 45 minutes before bedtime to 30 minutes after wake: warm-up, cooling ramp '
          + 'after bedtime, coldest hold through the first deep-sleep hours, gradual pre-wake warming, return toward '
          + 'neutral. If weekday and weekend sleep times differ, design one curve per group of days. Call '
          + 'apply_sleep_curve with mode "preview", show the curve, the on/off window and what it replaces in a short '
          + 'table with a sentence of reasoning, and call it with mode "apply" only after the sleeper agrees, passing a short '
          + 'notes string with what the curve is based on. To keep a '
          + 'curve without scheduling it, or when asked for a named curve, save it with manage_saved_curve.',
      },
    }],
  }))

  return server
}
