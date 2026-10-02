import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ status: undefined as unknown }))

vi.mock('next/navigation', () => ({ usePathname: () => '/en' }))
vi.mock('@/src/utils/trpc', () => ({
  trpc: { automations: { status: { useQuery: () => ({ data: m.status }) } } },
}))

import { AutopilotStatusChip } from '../AutopilotStatusChip'

const rule = (enabled: boolean, dryRun = false) => ({ enabled, dryRun })

describe('AutopilotStatusChip', () => {
  afterEach(cleanup)

  it('hides until a rule is enabled', () => {
    m.status = undefined
    const { container } = render(<AutopilotStatusChip />)
    expect(container.innerHTML).toBe('')
    m.status = { globalEnabled: true, rules: [rule(false)] }
    render(<AutopilotStatusChip />)
    expect(screen.queryByTestId('autopilot-chip')).toBeNull()
  })

  it('counts live rules and links to the console', () => {
    m.status = { globalEnabled: true, rules: [rule(true), rule(true), rule(true, true), rule(false)] }
    render(<AutopilotStatusChip />)
    expect(screen.getByText('AUTOPILOT · 2 ACTIVE')).toBeTruthy()
    expect(screen.getByTestId('autopilot-chip').getAttribute('href')).toBe('/en/autopilot')
  })

  it('shows dry run when no rule is live, and halted under the kill switch', () => {
    m.status = { globalEnabled: true, rules: [rule(true, true)] }
    render(<AutopilotStatusChip />)
    expect(screen.getByText('AUTOPILOT · DRY RUN')).toBeTruthy()
    cleanup()
    m.status = { globalEnabled: false, rules: [rule(true)] }
    render(<AutopilotStatusChip />)
    expect(screen.getByText('AUTOPILOT · HALTED')).toBeTruthy()
  })
})
