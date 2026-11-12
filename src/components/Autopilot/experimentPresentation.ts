import type { ExperimentDetail } from '@/src/comfort/experiments/browserContract'

export function experimentDate(date: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
}

export const experimentGapLabels: Record<ExperimentDetail['comparison']['nights'][number]['exclusions'][number], string> = {
  missing_exposure: 'Temperature exposure not verified', source_withdrawn: 'Recording source was withdrawn',
  context_changed: 'Routine or assignment changed', preview_only: 'Preview only; no actual treatment',
  wrong_window: 'Recording does not cover the reviewed window', wake_overlap: 'Recording overlaps wake warming',
  wrong_target: 'Recorded target differs from the plan', insufficient_coverage: 'Insufficient fresh, occupied temperature coverage',
  manual_change: 'A manual temperature change interrupted this night', uncertain_command: 'A temperature command was not confirmed',
  safety_interruption: 'A protection interrupted this night', ambiguous_sleeper: 'The sleeper could not be attributed',
  missing_feedback: 'No morning feedback', partial_night: 'Reported as a partial night',
  invalid_feedback_clock: 'Feedback cannot be aligned with this recording', settling_unverified: 'The preceding settling night was not verified',
}
