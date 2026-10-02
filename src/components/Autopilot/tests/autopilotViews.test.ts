import { describe, expect, it } from 'vitest'
import { AUTOPILOT_VIEWS, resolveAutopilotView } from '../autopilotViews'

describe('resolveAutopilotView', () => {
  it('lands on Automations unless ?view=diagnostics', () => {
    expect(resolveAutopilotView(null)).toBe('automations')
    expect(resolveAutopilotView('bogus')).toBe('automations')
    expect(resolveAutopilotView('diagnostics')).toBe('diagnostics')
  })

  it('lists the views A–Z', () => {
    expect(AUTOPILOT_VIEWS.map(v => v.label)).toEqual(['Automations', 'Diagnostics'])
  })
})
