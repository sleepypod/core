import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/src/utils/trpc', () => {
  const query = (data: unknown) => ({ useQuery: () => ({ data, isLoading: false }) })
  const mutation = { useMutation: () => ({ mutate: vi.fn(), isPending: false }) }
  const cache = { invalidate: vi.fn() }
  return { trpc: {
    automations: {
      list: query([]), status: query({ rules: [], globalEnabled: true }), runs: query([]),
      create: mutation, update: mutation, setEnabled: mutation, setDryRun: mutation, setKillSwitch: mutation,
    },
    useUtils: () => ({ automations: { list: cache, status: cache, runs: cache, getKillSwitch: cache } }),
  } }
})
vi.mock('../RuleEditor', () => ({ RuleEditor: ({ onClose }: { onClose: () => void }) => (
  <div role="dialog" aria-label="Automation editor"><button onClick={onClose}>Close editor</button></div>
) }))
import { AutopilotConsole } from '../AutopilotConsole'

afterEach(cleanup)

describe('Combined Autopilot page', () => {
  it('shows engine state with the list and opens a new automation without navigating away', () => {
    render(<AutopilotConsole />)
    expect(screen.getByRole('heading', { name: 'Autopilot' })).toBeTruthy()
    expect(screen.getByText('Autopilot running')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Live state & run log' })).toBeTruthy()
    expect(screen.queryByText(/Open builder/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New automation' }))
    expect(screen.getByRole('dialog', { name: 'Automation editor' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
