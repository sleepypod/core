export type AutopilotView = 'automations' | 'diagnostics' | 'learning'

export const AUTOPILOT_VIEWS: ReadonlyArray<{ id: AutopilotView, label: string }> = [
  { id: 'automations', label: 'Automations' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'learning', label: 'Learning' },
]

/** Unknown saved links retain the existing Automations destination. */
export function resolveAutopilotView(raw: string | null): AutopilotView {
  return raw === 'diagnostics' || raw === 'learning' ? raw : 'automations'
}
