import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutopilotConsole } from './AutopilotConsole'

const state = vi.hoisted(() => ({ save: vi.fn(), kill: vi.fn() }))
vi.mock('@/src/utils/trpc', () => {
  const query = (data: unknown) => ({ useQuery: () => ({ data, isLoading: false, isFetching: false }) })
  const mutation = (send: typeof state.save) => ({
    useMutation: (options: { onError: (e: Error) => void }) => ({
      isPending: false,
      mutate: (input: unknown) => {
        send(input)
        options.onError(new Error('Device connection lost'))
      },
    }),
  })
  return { trpc: {
    useUtils: () => ({ automations: {} }),
    automations: {
      list: query([]), status: query({ globalEnabled: true, rules: [] }), runs: query([]),
      nights: query([]), backtest: query(null),
      create: mutation(state.save), update: mutation(state.save),
      setEnabled: mutation(vi.fn()), setDryRun: mutation(vi.fn()), setKillSwitch: mutation(state.kill),
    },
    environment: { getLatestBedTemp: query({ ambientTemp: 70 }) },
  } }
})
vi.mock('./AutomationsList', () => ({ AutomationsList: ({ onNew }: { onNew: () => void }) => <button onClick={onNew}>New rule</button> }))
vi.mock('./StatusPanel', () => ({ StatusPanel: ({ onKill }: { onKill: (enabled: boolean) => void }) => <button onClick={() => onKill(false)}>Halt autopilot</button> }))
vi.mock('./CapZoneViz', () => ({ CapZoneViz: () => null }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Autopilot mutation feedback', () => {
  it('keeps failed-save edits open with an actionable error', () => {
    render(<AutopilotConsole />)
    fireEvent.click(screen.getByText('New rule'))
    fireEvent.change(screen.getByDisplayValue('New automation'), { target: { value: 'My retained rule' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'My retained rule' }))
    expect(screen.getByText(/Save failed: Device connection lost/)).toBeTruthy()
    expect(screen.getByDisplayValue('My retained rule')).toBeTruthy()
  })

  it('reports a failed global halt without claiming the engine stopped', () => {
    render(<AutopilotConsole />)
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    fireEvent.click(screen.getByRole('button', { name: 'Halt autopilot' }))
    expect(state.kill).toHaveBeenCalledWith({ enabled: false })
    expect(screen.getByRole('alert').textContent).toContain('Device connection lost')
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('blocks saving an invalid expression and explains the error', () => {
    render(<AutopilotConsole />)
    fireEvent.click(screen.getByText('New rule'))
    fireEvent.click(screen.getByRole('button', { name: 'Expression' }))
    fireEvent.change(screen.getByDisplayValue('ambient + 3'), { target: { value: 'ambient +' } })
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('Invalid temperature expression')
    fireEvent.click(save)
    expect(state.save).not.toHaveBeenCalled()
  })
})
