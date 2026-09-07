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
    expect(screen.queryByText('Run log')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Live' }))
    expect(screen.getByRole('region', { name: 'Live rule state' })).toBeTruthy()
    expect(screen.queryByText('Run log')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }))
    expect(screen.getByText('Run log')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Live rule state' })).toBeNull()
    expect(screen.getAllByRole('switch', { name: 'Autopilot running' })).toHaveLength(1)
    expect(screen.queryByText('Remote capture')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mapping' })).toBeNull()
    expect(screen.queryByText(/Open builder/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New automation' }))
    expect(screen.getByRole('dialog', { name: 'Automation editor' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
