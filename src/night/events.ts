import { z } from 'zod'
import type { NightEvent } from './contract'
import { temperatureApplicationSchema } from '@/src/temperature/applications'
import { comfortEventSchema } from '@/src/comfort/contract'

export type StoredNightRow = Record<string, unknown>
export function recordedJSON(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 100_000) throw new Error('Invalid recorded payload')
  return JSON.parse(value)
}
const safeText = (value: string) => Array.from(value.slice(0, 2000), character => character.charCodeAt(0) < 32 ? ' ' : character).join('')
const temperature = (value: number | null, minimum = 55) => value !== null && Number.isFinite(value) && value >= minimum && value <= (minimum === 55 ? 110 : 130) ? value : null

export function applicationEvent(row: StoredNightRow, side: 'left' | 'right', through: number): NightEvent {
  const input = z.record(z.string(), z.unknown()).parse(recordedJSON(row.request))
  const record = temperatureApplicationSchema.parse({ ...input, id: row.id, attemptId: row.attemptId, attemptedAt: row.at,
    finishedAt: row.finishedAt, outcome: row.outcome,
    acknowledgment: row.outcome === 'acknowledged' ? 'accepted_not_physically_verified' : 'unconfirmed' })
  if (record.side !== side || (record.finishedAt !== null && record.finishedAt > through)) throw new Error('Inconsistent receipt identity or clock')
  const limit = record.comfortLimit
  const limitText = limit?.state === 'limited'
    ? ' The automatic comfort limit reduced the requested target.'
    : limit?.state === 'wake' ? ' The controller recorded the scheduled wake-warming exception.' : ''
  return { id: `application:${record.id}`, source: 'applications', at: record.attemptedAt, through: record.attemptedAt, count: 1,
    scope: side, kind: record.outcome === 'acknowledged' ? 'acknowledged' : 'unconfirmed',
    title: record.outcome === 'acknowledged' ? 'Temperature request acknowledged' : 'Temperature request unconfirmed',
    detail: `Recorded source: ${record.source ?? 'not recorded'}; reason: ${record.reason}. This is a controller receipt, not physical verification.${limitText}`,
    targetF: record.targetF, reportedF: null, owner: record.source, evidence: 'controller_receipt' }
}
export function decisionEvent(row: StoredNightRow, side: 'left' | 'right'): NightEvent {
  const event = comfortEventSchema.parse(recordedJSON(row.event))
  if (event.at !== row.at || [event.deviceObservedAt, event.presenceObservedAt].some(at => at !== null && at > event.at)) throw new Error('Inconsistent policy clock')
  const kind = event.kind === 'feedback'
    ? 'feedback'
    : event.kind === 'configuration'
      ? 'configuration'
      : !event.eligible || event.kind === 'manual_pause' ? 'withheld' : 'preview'
  return { id: `decision:${row.id}`, source: 'decisions', at: event.at, through: event.at, count: 1, scope: side, kind,
    title: event.kind === 'manual_pause'
      ? 'Personal adaptation paused'
      : kind === 'withheld'
        ? 'Personal adaptation held back'
        : kind === 'feedback'
          ? 'Comfort feedback recorded'
          : kind === 'configuration'
            ? 'Personal policy changed'
            : event.kind === 'preview' ? 'Preview suggestion only' : 'Personal policy proposal',
    detail: safeText(event.message), targetF: temperature(event.proposedF), reportedF: temperature(event.reportedF, 32),
    owner: event.owner, evidence: 'policy_evaluation' }
}
const actionSchema = z.object({
  kind: z.string().max(100).optional(), side: z.enum(['left', 'right']).optional(), temp: z.number().min(55).max(110).optional(),
  sent: z.boolean().optional(), dryRun: z.boolean().optional(), notified: z.boolean().optional(),
  skipped: z.string().max(160).optional(), error: z.string().max(2000).optional(), on: z.boolean().optional(),
})
const detailSchema = z.object({ reason: z.string().max(160).optional(), actions: z.array(actionSchema).max(32).optional() })
const reasonLabels: Record<string, string> = {
  'condition-unknown': 'A required signal was unavailable.', 'condition-false': 'The recorded condition was not met.',
  'cooldown': 'The rule was in its cooldown period.', 'manual-hold': 'A manual hold took priority.',
  'runaway-disabled': 'The rule was disabled by its repeated-action guard.', 'eval-threw': 'The rule could not be evaluated.',
  'off': 'The zone was off.', 'safety': 'A control guard withheld the action.', 'temp-unknown': 'The temperature was unavailable.',
}
export function ruleEvents(row: StoredNightRow, side: 'left' | 'right'): NightEvent[] {
  const record = z.object({ automationId: z.number().int().positive(), outcome: z.enum(['fired', 'skipped', 'clamped', 'dry_run', 'error']) }).parse(row)
  const detail = detailSchema.parse(row.detail === null ? {} : recordedJSON(row.detail))
  const actions = detail.actions ?? []
  const retained = actions.map((action, index) => ({ action, index })).filter(({ action }) => !action.side || action.side === side)
  if (actions.length && !retained.length) return []
  return (retained.length ? retained : [{ action: undefined, index: 0 }]).map(({ action, index }) => {
    const reason = action?.skipped ?? detail.reason
    const withheld = record.outcome === 'skipped' || record.outcome === 'error' || !!action?.skipped || !!action?.error
    const preview = record.outcome === 'dry_run' || action?.dryRun === true
    return { id: `rule:${row.id}:${index}`, source: 'rules', at: Number(row.at), through: Number(row.at), count: 1,
      scope: action?.side ?? 'unassigned', kind: withheld ? 'withheld' : preview ? 'preview' : 'rule_output',
      title: `Rule ${record.automationId} · ${withheld ? 'held back' : preview ? 'preview only' : 'output recorded'}`,
      detail: `${reason ? reasonLabels[reason] ?? `Recorded reason: ${safeText(reason)}.` : 'No detailed reason was retained.'} ${action?.sent ? 'The rule logged a submitted action; inspect controller receipts separately.' : 'This evaluation is not a hardware acknowledgment.'}`,
      targetF: action?.temp ?? null, reportedF: null, owner: null, evidence: 'rule_evaluation' }
  })
}

/** Group identical evaluations within 90 seconds, retaining count and endpoints rather than inferred coverage. */
export function groupNightDecisions(events: NightEvent[]): NightEvent[] {
  const grouped: NightEvent[] = []
  const identity = (item: NightEvent) => JSON.stringify([item.scope, item.kind, item.title, item.detail, item.targetF, item.reportedF, item.owner])
  for (const event of events) {
    const previous = grouped.at(-1)
    if (previous && event.source === 'decisions' && previous.source === event.source && event.at >= previous.through
      && event.at - previous.through <= 90_000 && identity(previous) === identity(event)) {
      previous.through = event.through
      previous.count += event.count
    }
    else grouped.push({ ...event })
  }
  return grouped
}
