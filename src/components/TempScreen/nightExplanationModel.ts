import type { NightExplanation } from '@/src/night/contract'

/** Draw only adjacent recorded samples. No path crosses a missing minute or a missing value. */
export function nightTemperatureSegments(samples: NightExplanation['thermal'], field: 'reportedF' | 'targetF') {
  const segments: { at: number, value: number }[][] = []
  let previousAt: number | null = null
  let current: { at: number, value: number }[] | null = null
  for (const sample of samples) {
    const value = field === 'targetF' && !sample.powered ? null : sample[field]
    if (value === null) {
      current = null
      previousAt = null
      continue
    }
    if (!current || previousAt === null || sample.at - previousAt > 90_000 || sample.at <= previousAt) {
      current = []
      segments.push(current)
    }
    current.push({ at: sample.at, value })
    previousAt = sample.at
  }
  return segments
}
export const nightSourceLabels = { applications: 'Controller requests', decisions: 'Personal Autopilot', rules: 'Automation rules', thermal: 'Pod temperatures', room: 'Room conditions' }
export const nightKindLabels = { acknowledged: 'Acknowledged', unconfirmed: 'Unconfirmed', preview: 'Proposal only', withheld: 'Held back', feedback: 'Feedback', configuration: 'Configuration', rule_output: 'Rule log' }
