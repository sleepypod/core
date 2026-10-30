import { z } from 'zod'
import type { ComfortContext, ComfortState, RoutineWindow } from './policy'

const MINUTE = 60_000
export const ENTRY_STABILITY_MS = 10 * MINUTE
export const ENTRY_MAX_GAP_MS = 90_000
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const bedtimeSelectionSchema = z.object({
  session: z.string().min(1).max(500), revision: digest, sourceKey: digest,
  entryAt: timestamp, confirmedAt: timestamp,
  shiftMinutes: z.number().int().min(-30).max(30),
}).strict().refine(value => value.confirmedAt - value.entryAt >= ENTRY_STABILITY_MS, 'Bed entry requires ten observed minutes')
export type BedtimeSelection = z.infer<typeof bedtimeSelectionSchema>

export const bedtimeStatusSchema = z.object({
  state: z.enum(['off', 'waiting', 'ready', 'withheld']),
  reason: z.string(), selection: bedtimeSelectionSchema.nullable(),
  scheduledBaselineF: z.number().nullable(), phaseBaselineF: z.number().nullable(),
})
export type BedtimeStatus = z.infer<typeof bedtimeStatusSchema>
export interface BedEntrySample { measuredAt: number, sourceKey: string, state: 'absent' | 'present' | 'unknown' }

/** Observe an actual transition; repeated frames and time spent offline prove nothing. */
export class BedEntryTracker {
  private previous?: BedEntrySample
  private checkedAt?: number
  private entryAt?: number

  reset(): void {
    this.previous = undefined
    this.checkedAt = undefined
    this.entryAt = undefined
  }

  observe(sample: BedEntrySample | undefined, now: number): { entryAt: number, confirmedAt: number, sourceKey: string } | null {
    if (!sample || !Number.isSafeInteger(now) || !Number.isSafeInteger(sample.measuredAt)
      || sample.measuredAt > now || now - sample.measuredAt > ENTRY_MAX_GAP_MS
      || !digest.safeParse(sample.sourceKey).success || sample.state === 'unknown') {
      this.reset()
      return null
    }
    if (this.checkedAt !== undefined && (now < this.checkedAt || now - this.checkedAt > ENTRY_MAX_GAP_MS)) this.reset()
    this.checkedAt = now
    const previous = this.previous
    if (previous && (previous.sourceKey !== sample.sourceKey || sample.measuredAt < previous.measuredAt
      || sample.measuredAt - previous.measuredAt > ENTRY_MAX_GAP_MS
      || (sample.measuredAt === previous.measuredAt && sample.state !== previous.state))) {
      this.reset()
      // This frame becomes a new baseline, never an inferred entry.
      this.checkedAt = now
    }
    if (sample.state === 'absent') this.entryAt = undefined
    else if (this.previous?.state === 'absent' && sample.measuredAt > this.previous.measuredAt) this.entryAt = sample.measuredAt
    this.previous = sample
    return this.entryAt !== undefined && sample.measuredAt - this.entryAt >= ENTRY_STABILITY_MS
      ? { entryAt: this.entryAt, confirmedAt: sample.measuredAt, sourceKey: sample.sourceKey }
      : null
  }
}

/** Keep every intermediate phase inside its original power window, including short routines. */
function shiftFor(window: RoutineWindow, entryAt: number): number | null {
  const changes = window.phases?.changes
  if (!changes?.length || Math.abs(entryAt - window.start) > 90 * MINUTE) return null
  const earliest = Math.min(...changes.map(change => change.at))
  const latest = Math.max(...changes.map(change => change.at))
  const minimum = Math.max(-30, Math.ceil((window.start + 1 - earliest) / MINUTE))
  const maximum = Math.min(30, Math.floor((window.end - 1 - latest) / MINUTE))
  return minimum <= maximum ? Math.max(minimum, Math.min(maximum, Math.round((entryAt - window.start) / MINUTE))) : null
}

/** Select once after guarded observation, then map only the routine’s intermediate phases. */
export function bedtimePreview(state: ComfortState, context: ComfortContext, tracker: BedEntryTracker, maySelect: boolean): {
  selection: BedtimeSelection | undefined
  window: RoutineWindow | null
  status: BedtimeStatus
} {
  const { window, now } = context
  const status = (phase: BedtimeStatus['state'], reason: string, selection: BedtimeSelection | null = null): BedtimeStatus => ({
    state: phase, reason, selection, scheduledBaselineF: window?.baselineF ?? null, phaseBaselineF: null,
  })
  const result = (value: BedtimeStatus) => ({ selection: undefined, window, status: value })
  if (state.config.mode !== 'preview' || !state.config.followBedtime || !state.config.sensorAware) {
    tracker.reset()
    return result(status('off', 'Bed-entry timing Preview is off.'))
  }
  const mechanical = context.device.priming !== false || context.device.vibrating !== false || context.device.baseMoving !== false
  const sample = mechanical || !context.presence.available ? undefined : context.presence.entry
  const entry = tracker.observe(sample, now)
  if (!window?.phases?.changes.length) return result(status('waiting', 'Waiting for a routine with intermediate temperature phases.'))
  let selection = state.bedtime?.session === window.session ? state.bedtime : undefined
  if (selection && (selection.revision !== window.phases.revision || (sample && selection.sourceKey !== sample.sourceKey))) {
    return result(status('withheld', 'The routine or calibrated sensor changed after this night’s timing was selected. Keeping the original routine.', selection))
  }
  if (!selection) {
    if (!entry) return result(status('waiting', 'Waiting for observed empty-to-occupied entry followed by ten minutes of fresh presence.'))
    const shiftMinutes = shiftFor(window, entry.entryAt)
    if (shiftMinutes === null) return result(status('withheld', 'Observed bed entry is outside the 90-minute routine window. Keeping the original routine.'))
    if (!maySelect) return result(status('waiting', 'Bed entry observed; waiting for all comfort and sensor guards before selecting timing.'))
    selection = { ...entry, shiftMinutes, session: window.session, revision: window.phases.revision }
  }
  if (!bedtimeSelectionSchema.safeParse(selection).success || selection.confirmedAt > now
    || shiftFor(window, selection.entryAt) !== selection.shiftMinutes) {
    return result(status('withheld', 'Stored bed-entry timing is not valid for the current routine or clock.'))
  }
  if (!sample || !Number.isSafeInteger(sample.measuredAt) || sample.state !== 'present' || sample.measuredAt > now || now - sample.measuredAt > ENTRY_MAX_GAP_MS) {
    return result(status('waiting', 'Waiting for fresh calibrated presence before using this night’s timing.', selection))
  }
  const phase = window.phases.changes.filter(change => change.at + selection.shiftMinutes * MINUTE <= now)
    .sort((first, second) => second.at - first.at || first.id.localeCompare(second.id))[0]
  const baselineF = phase?.temperatureF ?? window.phases.startF
  const mapped = { ...window, baselineF, scheduledBaselineF: window.baselineF,
    segment: `${window.session}:bed-entry:${selection.shiftMinutes}:${phase?.id ?? 'start'}:${phase?.at ?? window.start}` }
  return {
    selection, window: mapped,
    status: { ...status('ready', 'Preview shifts intermediate temperature phases only. Power and alarm times stay fixed.', selection), phaseBaselineF: baselineF },
  }
}
