export type AutopilotView = 'automations' | 'diagnostics'

export const AUTOPILOT_VIEWS: ReadonlyArray<{ id: AutopilotView, label: string }> = [
  { id: 'automations', label: 'Automations' },
  { id: 'diagnostics', label: 'Diagnostics' },
]

/** Resolve `?view=` — anything but Diagnostics lands on Automations. */
export function resolveAutopilotView(raw: string | null): AutopilotView {
  return raw === 'diagnostics' ? 'diagnostics' : 'automations'
}
