import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SystemLogViewer } from '../SystemLogViewer'
const mock = vi.hoisted(() => ({ query: '', sources: undefined as unknown, lines: [] as string[], loading: false, error: null as Error | null, logs: vi.fn(), refetch: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(mock.query) }))
vi.mock('@/src/components/Sensors/FirmwareLogConsole', () => ({ FirmwareLogConsole: () => <div>Firmware output</div> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { system: {
  getLogSources: { useQuery: () => ({ data: mock.sources, isLoading: mock.loading, error: mock.error }) },
  getLogs: { useQuery: (input: unknown, options: unknown) => {
    mock.logs(input, options)
    return { data: { lines: mock.lines }, isLoading: mock.loading, error: mock.error, refetch: mock.refetch }
  } },
} } }))
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mock, { query: '', sources: { sources: [{ name: 'Core', unit: 'sleepypod.service', active: true }, { name: 'Piezo', unit: 'sleepypod-piezo.service', active: false }] }, lines: ['2026-09-28T23:39:02+0000 pod sleepypod[12]: Started', '2026-09-28T23:38:02+0000 pod sleepypod[12]: warning sample'], loading: false, error: null })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('selects sources and priorities, filters text, pauses follow and refreshes', () => {
  mock.query = 'unit=sleepypod-piezo.service'
  render(<SystemLogViewer />)
  expect(screen.getByRole('option', { name: /Piezo/ }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('option', { name: /Core/ }))
  fireEvent.click(screen.getByRole('tab', { name: 'Warn' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Follow logs' }))
  expect(mock.logs).toHaveBeenLastCalledWith({ unit: 'sleepypod.service', lines: 200, priority: 'warning' }, { enabled: true, refetchInterval: false })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'STARTED' } })
  expect(screen.getByTestId('log-lines').textContent).toContain('Started')
  expect(screen.queryByText('warning sample')).toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } })
  expect(screen.getByText('No lines match the filter')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh logs' }))
  expect(mock.refetch).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Open console' }))
  expect(screen.getByText('Firmware output')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByText('Firmware output')).toBeNull()
})

it('copies and downloads the displayed lines', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const create = vi.fn().mockReturnValue('blob:test'), revoke = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<SystemLogViewer />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
  expect(writeText).toHaveBeenCalledWith(mock.lines.join('\n'))
  fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  expect(create.mock.calls[0][0].type).toBe('text/plain')
  expect(click).toHaveBeenCalledOnce()
  expect(revoke).toHaveBeenCalledWith('blob:test')
})

it('renders source and log errors, loading and empty results', () => {
  mock.loading = true
  const { rerender } = render(<SystemLogViewer />)
  expect(screen.getByText('Loading…')).toBeTruthy()
  mock.loading = false
  mock.error = new Error('No journal')
  rerender(<SystemLogViewer />)
  expect(screen.getAllByText('No journal')).toHaveLength(2)
  mock.error = null
  mock.sources = undefined
  mock.lines = []
  rerender(<SystemLogViewer />)
  expect(screen.getByText('No logs found')).toBeTruthy()
  expect(mock.logs).toHaveBeenLastCalledWith({ unit: '', lines: 200, priority: undefined }, { enabled: false, refetchInterval: 5000 })
})

it('resets the copy acknowledgement after its timeout', async () => {
  vi.useFakeTimers()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  render(<SystemLogViewer />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
  expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  act(() => vi.advanceTimersByTime(1500))
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
})
