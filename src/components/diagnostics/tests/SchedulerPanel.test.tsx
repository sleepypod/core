import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  timeline: undefined as unknown,
  drift: { dbScheduleCount: 4, schedulerJobCount: 4, drifted: false } as unknown,
  params: new URLSearchParams(),
  replace: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/system',
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.params,
}))
vi.mock('@/src/hooks/useSideNames', () => ({
  useSideNames: () => ({ leftName: 'Jon', rightName: 'Right', sideName: (s: 'left' | 'right') => (s === 'left' ? 'Jon' : 'Right') }),
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    health: {
      schedulerTimeline: { useQuery: () => ({ data: mocks.timeline, error: null }) },
      system: { useQuery: () => ({ data: { scheduler: { drift: mocks.drift } } }) },
    },
  },
}))

import { SchedulerPanel } from '../SchedulerPanel'

// Mon 2026-09-28 5:34 PM local.
const NOW = new Date(2026, 8, 28, 17, 34).getTime()
const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m).getTime()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  mocks.params = new URLSearchParams()
  mocks.replace.mockReset()
  const job = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
    id, type, schedule: '0 3 * * *', oneTime: false, nextRun: null, targetTempF: null, brightness: null, ...extra,
  })
  mocks.timeline = {
    enabled: true,
    timezone: 'America/Los_Angeles',
    now: NOW,
    jobs: [
      job('temp-2103', 'temperature', { side: 'left', targetTempF: 80, nextRun: at(28, 23, 15), schedule: '15 23 * * 1' }),
      job('temp-2104', 'temperature', { side: 'left', targetTempF: 72, nextRun: at(29, 2, 0), schedule: '0 2 * * 2' }),
      job('led-night-start', 'led_brightness', { brightness: 2, nextRun: at(28, 23, 40), schedule: '40 23 * * *' }),
      job('daily-reboot', 'reboot', { nextRun: at(29, 3) }),
    ],
    occurrences: [
      { id: 'temp-2103', type: 'temperature', side: 'left', at: at(28, 23, 15), targetTempF: 80, brightness: null },
      { id: 'led-night-start', type: 'led_brightness', at: at(28, 23, 40), targetTempF: null, brightness: 2 },
      { id: 'temp-2104', type: 'temperature', side: 'left', at: at(29, 2), targetTempF: 72, brightness: null },
      { id: 'daily-reboot', type: 'reboot', at: at(29, 3), targetTempF: null, brightness: null },
      { id: 'led-night-start', type: 'led_brightness', at: at(30, 23, 40), targetTempF: null, brightness: 2 },
    ],
  }
})
afterEach(() => vi.useRealTimers())

describe('SchedulerPanel', () => {
  it('summarises jobs in one line whose parts add up, with the next job', () => {
    render(<SchedulerPanel />)
    const line = screen.getByTestId('scheduler-summary')
    expect(line.textContent).toContain('In sync')
    expect(line.textContent).toContain('4 jobs · 2 temperature · 1 maintenance · 1 other')
    expect(line.textContent).not.toContain('alarm')
    expect(line.textContent).toMatch(/nextJon→80°F.*11:15\sPM · in 5h 41m/)
  })

  it('draws tonight and dims nights without jobs', () => {
    render(<SchedulerPanel />)
    const timeline = screen.getByTestId('scheduler-timeline')
    expect(within(timeline).getAllByText('Tonight')).toHaveLength(2)
    expect(timeline.textContent).toContain('4 jobs')
    const tabs = within(timeline).getAllByRole('tab')
    expect(tabs).toHaveLength(7)
    expect(tabs[1].getAttribute('title')).toBe('No jobs this night')
    fireEvent.click(tabs[2])
    expect(timeline.textContent).toContain('1 jobs')
  })

  it('reads out each side\u2019s target under the pointer', () => {
    render(<SchedulerPanel />)
    const svg = screen.getByRole('img', { name: /Scheduled jobs/ })
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 640, height: 300, right: 640, bottom: 300, toJSON: () => ({}) })
    // The night axis runs 5 PM \u2192 9 AM (16 h): 1 AM is halfway across.
    fireEvent.pointerMove(svg, { clientX: 320, clientY: 50 })
    expect(screen.getByTestId('timeline-hover').textContent).toMatch(/^1:00\sAM \u00b7 Jon 80\u00b0 \u00b7 Right \u2014$/)
    fireEvent.pointerLeave(svg)
    expect(screen.queryByTestId('timeline-hover')).toBeNull()
  })

  it('lists the next five with plain labels and muted ids', () => {
    render(<SchedulerPanel />)
    expect(screen.getByText('5 of 5 this week')).toBeTruthy()
    expect(screen.getByText('temp-2103')).toBeTruthy()
    expect(screen.queryByText('led_brightness')).toBeNull()
    expect(screen.getAllByText('LED').length).toBeGreaterThan(0)
  })

  it('opens All jobs grouped by kind, filterable', () => {
    render(<SchedulerPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'All jobs' }))
    expect(mocks.replace).toHaveBeenCalledWith('/en/system?view=all', { scroll: false })

    mocks.params = new URLSearchParams('tab=scheduler&view=all')
    render(<SchedulerPanel />)
    const all = screen.getByTestId('scheduler-all-jobs')
    expect(within(all).getAllByText('Temperature').length).toBeGreaterThan(0)
    expect(within(all).getByText(/^Mon 11:15\sPM$/)).toBeTruthy()
    fireEvent.click(within(all).getByRole('button', { name: /Maintenance/ }))
    expect(within(all).queryByText('temp-2103')).toBeNull()
    expect(within(all).getByText('daily-reboot')).toBeTruthy()
  })

  it('warns when the scheduler has drifted from the database', () => {
    mocks.drift = { dbScheduleCount: 5, schedulerJobCount: 4, drifted: true }
    render(<SchedulerPanel />)
    expect(screen.getByTestId('scheduler-summary').textContent).toContain('Drifted · 5 scheduled vs 4 loaded')
  })
})
