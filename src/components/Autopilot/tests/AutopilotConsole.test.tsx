import { requiredTemplate } from './builderFixtures'
import type * as CurveChartModule from '@/src/components/Schedule/CurveChart'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AutopilotConsole } from '../AutopilotConsole'
import { toAST } from '../builderModel'

const mock = vi.hoisted(() => ({
  path: '/de/autopilot', query: '', push: vi.fn(), replace: vi.fn(), rows: [] as unknown[],
  enabled: vi.fn(), dryRun: vi.fn(), kill: vi.fn(), invalidate: vi.fn(),
  activity: vi.fn(), globalEnabled: true, diag: undefined as unknown,
}))
vi.mock('next/navigation', () => ({ usePathname: () => mock.path, useRouter: () => ({ push: mock.push, replace: mock.replace }), useSearchParams: () => new URLSearchParams(mock.query) }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
vi.mock('@/src/components/Schedule/CurveChart', async importOriginal => ({ ...await importOriginal<typeof CurveChartModule>(), useNowMinute: () => 29800000 }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ sideName: (s: string) => s }) }))
vi.mock('@/src/utils/trpc', () => {
  const mutation = (fn: typeof mock.enabled) => ({ useMutation: ({ onSuccess }: { onSuccess: () => void }) => ({
    mutate: (input: unknown) => {
      fn(input)
      onSuccess()
    },
    mutateAsync: async (input: unknown) => {
      await fn(input)
      onSuccess()
    },
  }) })
  return { trpc: {
    useUtils: () => ({ automations: Object.fromEntries(['list', 'status', 'diagnostics', 'tonight', 'getKillSwitch'].map(k => [k, { invalidate: mock.invalidate }])) }),
    schedules: { getAll: { useQuery: () => ({}) } },
    automations: {
      list: { useQuery: () => ({ data: mock.rows }) }, status: { useQuery: () => ({ data: { globalEnabled: mock.globalEnabled } }) },
      diagnostics: { useQuery: () => ({ data: mock.diag }) }, tonight: { useQuery: () => ({}) },
      backtestSummaries: { useQuery: () => ({ data: [{ id: 1, nights: 5, wouldFire: 0, peak: null, threshold: null }] }) },
      activity: { useQuery: (input: unknown, opts: { placeholderData: (p: unknown) => unknown }) => {
        mock.activity(input)
        const data = { now: 0, nights: [{ start: 0, entries: [{ ruleId: 1, ruleName: 'Water', outcome: 'fired', code: 'set-temperature', temp: 78, start: 0, end: 0, count: 1, sides: [] }] }], holds: [] }
        return { data: opts.placeholderData(data) }
      } },
      setEnabled: mutation(mock.enabled), setDryRun: mutation(mock.dryRun), setKillSwitch: mutation(mock.kill),
    },
  } }
})

beforeEach(() => {
  vi.clearAllMocks()
  mock.query = ''
  mock.globalEnabled = true
  mock.rows = [{ ...toAST(requiredTemplate('water-low')), id: 1, name: 'Water', enabled: false, dryRun: true }]
  mock.diag = undefined
})

it('opens rules and new templates, updates modes in order and invalidates data', async () => {
  const { rerender } = render(<AutopilotConsole />)
  expect(screen.getByTestId('automations-status').textContent).toBe('1 rule')
  fireEvent.click(screen.getByTestId('rule-1'))
  expect(mock.push).toHaveBeenLastCalledWith('/de/autopilot/1')
  for (const button of screen.getAllByRole('button', { name: 'New automation' })) fireEvent.click(button)
  expect(mock.push).toHaveBeenLastCalledWith('/de/autopilot/new')
  fireEvent.click(screen.getByRole('radio', { name: 'Active' }))
  await waitFor(() => expect(mock.enabled).toHaveBeenCalledWith({ id: 1, enabled: true }))
  expect(mock.dryRun).toHaveBeenCalledWith({ id: 1, dryRun: false })
  expect(mock.dryRun.mock.invocationCallOrder[0]).toBeLessThan(mock.enabled.mock.invocationCallOrder[0])
  expect(mock.invalidate).toHaveBeenCalled()
  mock.rows = [{ ...toAST(requiredTemplate('water-low')), id: 1, name: 'Water', enabled: true, dryRun: false }]
  rerender(<AutopilotConsole />)
  fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
  expect(mock.enabled).toHaveBeenLastCalledWith({ id: 1, enabled: false })
  fireEvent.click(screen.getByRole('radio', { name: 'Dry-run' }))
  await waitFor(() => expect(mock.dryRun).toHaveBeenLastCalledWith({ id: 1, dryRun: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
  expect(mock.activity.mock.lastCall?.[0].nightStarts).toHaveLength(4)
  mock.rows = []
  rerender(<AutopilotConsole />)
  fireEvent.click(screen.getByRole('button', { name: /Tell me when water is low/ }))
  expect(mock.push).toHaveBeenLastCalledWith('/de/autopilot/new?template=water-low')
})

it('preserves unrelated query parameters when switching views and toggles the kill switch', () => {
  mock.query = 'other=keep'
  const { rerender } = render(<AutopilotConsole />)
  fireEvent.click(screen.getByRole('tab', { name: 'Diagnostics' }))
  expect(mock.replace).toHaveBeenLastCalledWith('/de/autopilot?other=keep&view=diagnostics', { scroll: false })
  fireEvent.click(screen.getByRole('switch', { name: 'Autopilot enabled' }))
  expect(mock.kill).toHaveBeenCalledWith({ enabled: false })
  mock.globalEnabled = false
  mock.query = 'view=diagnostics'
  rerender(<AutopilotConsole />)
  expect(screen.getByRole('status').textContent).toBe('Autopilot is off. No rules are evaluated.')
  fireEvent.click(screen.getByRole('tab', { name: /Automations/ }))
  expect(mock.replace).toHaveBeenLastCalledWith('/de/autopilot', { scroll: false })
})

it('routes diagnostic mode changes and the diagnostic kill switch through mutations', async () => {
  mock.query = 'view=diagnostics'
  mock.diag = { now: new Date(), startOfDay: new Date(), globalEnabled: false, rules: [
    { ...mock.rows[0] as object, runs: [], signals: {} },
  ] }
  render(<AutopilotConsole />)
  fireEvent.click(screen.getByRole('tab', { name: 'Live' }))
  await waitFor(() => expect(mock.enabled).toHaveBeenCalledWith({ id: 1, enabled: true }))
  fireEvent.click(screen.getAllByRole('switch', { name: 'Autopilot enabled' }).slice(-1)[0])
  expect(mock.kill).toHaveBeenCalledWith({ enabled: true })
})
