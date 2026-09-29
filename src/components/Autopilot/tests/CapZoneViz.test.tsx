import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CapZoneViz } from '../CapZoneViz'
import type { SensorFrame } from '@/src/hooks/useSensorStream'
const mock = vi.hoisted(() => ({ frame: (_f: SensorFrame) => {
  void _f
}, live: undefined as unknown, frames: [] as unknown[], loading: true }))
vi.mock('@/src/hooks/useSensorStream', () => ({ useSensorFrame: () => mock.live, useOnSensorFrame: (cb: typeof mock.frame) => {
  mock.frame = cb
} }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { automations: { capZoneReplay: { useQuery: (_input: unknown, opts: { placeholderData: (p: unknown) => unknown }) => ({ data: opts.placeholderData({ frames: mock.frames }), isLoading: mock.loading }) } } } }))
afterEach(() => vi.useRealTimers())
it('shows live zone variance and replays, scrubs and pauses recorded frames', () => {
  vi.useFakeTimers()
  const { rerender, unmount } = render(<CapZoneViz side="both" backtestSide="left" nightId={1} />)
  expect(screen.getByText('Waiting for live capacitive data…')).toBeTruthy()
  mock.live = { ts: 1700000000 }
  rerender(<CapZoneViz side="both" backtestSide="left" nightId={1} />)
  act(() => mock.frame({ type: 'capSense', left: 0, right: 0 } as SensorFrame))
  act(() => mock.frame({ type: 'capSense2', left: [2, 2, 1, 1, 0, 0], right: [0, 0, 0, 0, 0, 0] } as SensorFrame))
  expect(screen.getAllByText('1.00').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('tab', { name: 'Replay' }))
  expect(screen.getByText('Loading replay…')).toBeTruthy()
  mock.loading = false
  rerender(<CapZoneViz side="both" backtestSide="left" nightId={1} />)
  expect(screen.getByText('No spatial presence history for this night.')).toBeTruthy()
  mock.frames = [{ tMs: 1, zones: [1, 0, 0], peakZone: 0 }, { tMs: 1000, zones: [0, 2, 0], peakZone: null }]
  rerender(<CapZoneViz side="both" backtestSide="left" nightId={1} />)
  fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
  act(() => vi.advanceTimersByTime(350))
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('1')
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } })
  expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
