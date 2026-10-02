/**
 * Automations (Autopilot) tools. Rule bodies reuse the router's AST schema so
 * the model gets the same validation the UI does.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { automationCreateSchema, automationUpdateSchema } from '@/src/server/validation-schemas'
import { getCaller, jsonResult, runTool, textResult } from '@/src/mcp/caller'

export function registerAutomationTools(server: McpServer) {
  server.registerTool('get_automations', {
    title: 'List automations and tonight\'s plan',
    description:
      'Every automation rule with enabled/dry-run flags, last outcome and fires today, the global kill switch, '
      + 'and "tonight": per side, who controls the temperature now (hold, run-once, automation) and the last '
      + 'automation action. Pass includeRules to also return each rule\'s full trigger/condition/action JSON.',
    inputSchema: { includeRules: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ includeRules }) => runTool(async () => {
    const caller = getCaller()
    const [status, tonight, rules] = await Promise.all([
      caller.automations.status({}),
      caller.automations.tonight({}),
      includeRules ? caller.automations.list({}) : Promise.resolve(undefined),
    ])
    return jsonResult({ ...status, tonight, ...(rules && { rules }) })
  }))

  server.registerTool('manage_automation', {
    title: 'Enable, disable, edit or create an automation',
    description:
      'Actions: "enable"/"disable" a rule by id; "dry_run" (log only) or "live" (send actions) by id; '
      + '"kill_switch_on"/"kill_switch_off" to stop or resume all automations at once; "delete" by id; '
      + '"create" or "update" with a rule object. A rule has name, optional side, priority, cooldownMin, '
      + 'trigger ({kind:"tick",everyMin} | {kind:"signalChange",signal} | {kind:"timeOfDay",at}), conditions '
      + '(comparisons over dotted signals like "left.heartRate", "ambient.temperature", combinable with '
      + 'and/or/not) and actions (e.g. {kind:"setTemperature", side, temp: {kind:"literal", value}} or notify). Every temperature '
      + 'in a rule (signal thresholds, action values, clamps) is in °F regardless of the device unit; convert '
      + 'Celsius first (20°C = 68°F). New rules default to dryRun so nothing fires until the user switches it '
      + 'live. Read get_automations with includeRules first to copy the shape of an existing rule.',
    inputSchema: {
      action: z.enum(['enable', 'disable', 'dry_run', 'live', 'kill_switch_on', 'kill_switch_off', 'create', 'update', 'delete']),
      id: z.number().int().positive().optional().describe('Rule id for everything except create and kill switch.'),
      rule: z.record(z.string(), z.unknown()).optional().describe('Rule object for create/update, validated server-side.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ action, id, rule }) => runTool(async () => {
    const caller = getCaller()
    const needId = () => {
      if (id === undefined) throw new Error(`id is required for ${action}`)
      return id
    }
    switch (action) {
      case 'enable':
      case 'disable':
        return jsonResult(await caller.automations.setEnabled({ id: needId(), enabled: action === 'enable' }))
      case 'dry_run':
      case 'live':
        return jsonResult(await caller.automations.setDryRun({ id: needId(), dryRun: action === 'dry_run' }))
      case 'kill_switch_on':
      case 'kill_switch_off':
        await caller.automations.setKillSwitch({ enabled: action === 'kill_switch_off' })
        return textResult(action === 'kill_switch_on' ? 'All automations paused.' : 'Automations resumed.')
      case 'delete':
        await caller.automations.delete({ id: needId() })
        return textResult(`Automation ${id} deleted.`)
      case 'create':
        // Always start in dry-run, even when copying a live rule; "live" is a separate, explicit action.
        return jsonResult(await caller.automations.create(automationCreateSchema.parse({ ...rule, dryRun: true })))
      case 'update':
        return jsonResult(await caller.automations.update(automationUpdateSchema.parse({ ...rule, id: needId() })))
    }
  }))
}
