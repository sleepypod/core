/**
 * ScheduleTimeline: last night's schedule vs presence labels, the next set
 * point, and power / presence bars on the shared axis.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime()
const sec = (t: number) => t / 1000

const m = vi.hoisted(() => ({ records: {} as Record<string, unknown[]>, nowMinute: 0 as number | null }))

vi.mock('next/navigation', () => ({ usePathname: () => '/en' }))
vi.mock('@/src/hooks/useSideNames', () => ({
  useSideNames: () => ({ sideName: (s: string) => (s === 'left' ? 'Jon' : 'Heidi') }),
}))
vi.mock('@/src/components/Schedule/CurveChart', async orig => ({
  ...(await orig<object>()),
  useNowMinute: () => m.nowMinute,
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    schedules: {
      getAll: {
        useQuery: ({ side }: { side: string }) => ({
          data: {
            temperature: side === 'left'
              ? ['sunday', 'monday'].flatMap(day => [
                  { dayOfWeek: day, time: '23:15', temperature: 76, enabled: true },
                  { dayOfWeek: day, time: '03:00', temperature: 72, enabled: true },
                  { dayOfWeek: day, time: '07:00', temperature: 84, enabled: true },
                ])
              : [],
          },
        }),
      },
    },
    biometrics: { getSleepRecords: { useQuery: ({ side }: { side: string }) => ({ data: m.records[side] ?? [] }) } },
    health: {
      thermalHistory: {
        useQuery: () => ({
          data: {
            bucketSec: 240,
            points: [0, 1, 2].map(i => ({ t: at(27, 23, 20) + i * 240_000, leftTarget: 76, rightTarget: null })),
          },
        }),
      },
    },
  },
}))

import { ScheduleTimeline } from '../ScheduleTimeline'

afterEach(cleanup)

describe('ScheduleTimeline', () => {
  it('labels last night\'s empty bed and lie-in, and the next set point', () => {
    m.nowMinute = at(28, 19) / 60_000
    m.records = {
      left: [{
        enteredBedAt: new Date(at(28, 4, 5)),
        leftBedAt: new Date(at(28, 8, 22)),
        presentIntervals: [[sec(at(28, 4, 5)), sec(at(28, 6))], [sec(at(28, 6, 10)), sec(at(28, 8, 22))]],
      }],
    }
    render(<ScheduleTimeline unit="F" />)
    const card = screen.getByTestId('schedule-timeline')
    expect(within(card).getByText('bed empty while cooling · 4h 50m')).toBeTruthy()
    expect(within(card).getByText('in bed 1h 22m past schedule')).toBeTruthy()
    expect(within(card).getByText('next · 76° in 4h 15m')).toBeTruthy()
    expect(screen.getByTestId('timeline-left-presence').children).toHaveLength(2)
    expect(screen.getByTestId('timeline-left-power').children).toHaveLength(1)
    expect(screen.getByTestId('timeline-right-power').children).toHaveLength(0)
    expect(within(card).getByText('no schedule')).toBeTruthy()
  })

  it('draws a hover line with the time and each side\u2019s target under the pointer', () => {
    m.nowMinute = at(28, 19) / 60_000
    m.records = {}
    render(<ScheduleTimeline unit="F" />)
    const body = screen.getByTestId('timeline-body')
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 1096, height: 300, right: 1096, bottom: 300, toJSON: () => ({}) })
    // Window is 6 PM Sep 27 \u2192 9 AM Sep 29 (39 h); 1 AM Sep 28 is 7 h in, past the 96px label column.
    fireEvent.pointerMove(body, { clientX: 96 + 1000 * 7 / 39, clientY: 40 })
    expect(screen.getByTestId('timeline-hover').textContent).toMatch(/^1:00\sAM$/)
    expect(screen.getByTestId('timeline-left-hover').textContent).toBe('76\u00b0')
    expect(screen.queryByTestId('timeline-right-hover')).toBeNull()
    fireEvent.pointerMove(body, { clientX: 20, clientY: 40 })
    expect(screen.queryByTestId('timeline-hover')).toBeNull()
  })

  it('shows a skeleton until the client clock is known', () => {
    m.nowMinute = null
    render(<ScheduleTimeline unit="F" />)
    expect(screen.queryByTestId('schedule-timeline')).toBeNull()
  })
})
