import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiezoDualFrame, TimeRange } from '@/src/hooks/useSensorStream'
import { PiezoWaveform } from '../PiezoWaveform'

const stream = vi.hoisted(() => ({
  waveform: [] as PiezoDualFrame[],
  replayWaveform: null as PiezoDualFrame[] | null,
  timeRange: { min: 60, max: 100 } as TimeRange | null,
  isSeeking: false,
  seekWaveform: vi.fn(),
  goLive: vi.fn(),
  getTimeRange: vi.fn(),
}))
vi.mock('@/src/hooks/useSensorStream', () => ({ useSensorStream: () => stream }))
vi.mock('@/src/components/ds', () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverMark: ({ label }: { label: ReactNode }) => <span data-testid="chart-hover">{label}</span>,
  SectionLabel: ({ children, right }: { children: ReactNode, right: ReactNode }) => (
    <div>
      {children}
      {right}
    </div>
  ),
  Slider: ({ label, min, max, value, onChange }: { label: string, min: number, max: number, value: number, onChange: (n: number) => void }) => (
    <input aria-label={label} type="range" min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))} />
  ),
}))
const frame = (ts: number, count = 500): PiezoDualFrame => ({
  type: 'piezo-dual', ts, freq: 500,
  left1: Array.from({ length: count }, (_, i) => i % 10),
  right1: Array.from({ length: count }, (_, i) => -i % 10),
})
const ctx = {
  clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
  stroke: vi.fn(), bezierCurveTo: vi.fn(), fillText: vi.fn(),
}
let nextFrame: FrameRequestCallback | undefined
function draw() {
  act(() => nextFrame?.(0))
}

beforeEach(() => {
  vi.useFakeTimers()
  stream.waveform = []
  stream.replayWaveform = null
  stream.timeRange = { min: 60, max: 100 }
  stream.isSeeking = false
  vi.clearAllMocks()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect)
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    nextFrame = callback
    return 1
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('PiezoWaveform', () => {
  it('installs a complete snapshot at the live edge, then replaces it without duplicate samples', () => {
    stream.waveform = [frame(98), frame(99)]
    const { rerender, unmount } = render(<PiezoWaveform />)
    expect(screen.getByText('500 Hz · L 1000 · R 1000')).toBeTruthy()
    expect(screen.getByText('Latest')).toBeTruthy()
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('100')
    expect(stream.goLive).toHaveBeenCalledOnce()
    draw()
    expect(ctx.bezierCurveTo).toHaveBeenCalled()
    stream.waveform = [frame(98), frame(99), frame(100)]
    rerender(<PiezoWaveform />)
    expect(screen.getByText('500 Hz · L 1500 · R 1500')).toBeTruthy()
    act(() => vi.advanceTimersByTime(5000))
    expect(stream.getTimeRange).toHaveBeenCalledTimes(2)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it('reads out the sample under the pointer on each channel, honouring the channel toggles', () => {
    stream.waveform = [frame(99)]
    const { container } = render(<PiezoWaveform />)
    const box = container.querySelector('canvas')?.parentElement as HTMLElement
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, toJSON: () => ({}) })
    // 400px wide: halfway lands on sample 250 of 500, 0.50 s before the end.
    fireEvent.pointerMove(box, { clientX: 200, clientY: 10 })
    expect(screen.getByTestId('chart-hover').textContent).toBe('-0.50s · L 0 · R 0')
    fireEvent.click(screen.getByRole('button', { name: /Right/ }))
    fireEvent.pointerMove(box, { clientX: 200, clientY: 10 })
    expect(screen.getByTestId('chart-hover').textContent).toBe('-0.50s · L 0')
    fireEvent.pointerMove(box, { clientX: 500, clientY: 10 })
    expect(screen.queryByTestId('chart-hover')).toBeNull()
    fireEvent.pointerMove(box, { clientX: 200, clientY: 10 })
    fireEvent.pointerLeave(box)
    expect(screen.queryByTestId('chart-hover')).toBeNull()
  })

  it('keeps replay fixed while live data arrives and restores the newest window on Go live', () => {
    stream.waveform = [frame(100)]
    const { rerender } = render(<PiezoWaveform />)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '75' } })
    expect(stream.seekWaveform).toHaveBeenCalledWith(75)
    stream.isSeeking = true
    stream.replayWaveform = []
    rerender(<PiezoWaveform />)
    expect(screen.getByRole('button', { name: 'seeking' })).toBeTruthy()
    stream.isSeeking = false
    stream.replayWaveform = [frame(75, 100)]
    rerender(<PiezoWaveform />)
    expect(screen.getByText('500 Hz · L 100 · R 100')).toBeTruthy()
    stream.waveform = [frame(100), frame(101)]
    rerender(<PiezoWaveform />)
    expect(screen.getByText('500 Hz · L 100 · R 100')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go live' }))
    expect(stream.goLive).toHaveBeenCalledTimes(2)
    stream.replayWaveform = null
    rerender(<PiezoWaveform />)
    expect(screen.getByText('500 Hz · L 1000 · R 1000')).toBeTruthy()
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('100')
  })

  it('freezes samples and range polling when paused, and resumes with the current window', () => {
    stream.waveform = [frame(100)]
    const { rerender } = render(<PiezoWaveform />)
    rerender(<PiezoWaveform enabled={false} />)
    stream.waveform = [frame(101), frame(102)]
    rerender(<PiezoWaveform enabled={false} />)
    expect(screen.getByText('500 Hz · L 500 · R 500')).toBeTruthy()
    expect(screen.getByText('Paused')).toBeTruthy()
    act(() => vi.advanceTimersByTime(10_000))
    expect(stream.getTimeRange).toHaveBeenCalledOnce()
    rerender(<PiezoWaveform />)
    expect(screen.getByText('500 Hz · L 1000 · R 1000')).toBeTruthy()
    expect(stream.getTimeRange).toHaveBeenCalledTimes(2)
  })

  it('allows leaving replay after the available range expires, and clamps a moving range', () => {
    const { rerender } = render(<PiezoWaveform />)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '65' } })
    stream.replayWaveform = [frame(65)]
    stream.timeRange = { min: 70, max: 110 }
    rerender(<PiezoWaveform />)
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('70')
    stream.timeRange = null
    rerender(<PiezoWaveform />)
    expect(screen.queryByRole('slider')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Go live' }))
    expect(stream.goLive).toHaveBeenCalledTimes(2)
  })

  it('bounds the displayed samples and supports channel toggles without stopping updates', () => {
    stream.waveform = [frame(100, 12_000)]
    render(<PiezoWaveform />)
    expect(screen.getByText('500 Hz · L 10000 · R 10000')).toBeTruthy()
    draw()
    expect(ctx.bezierCurveTo).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Left' }))
    expect(screen.getByRole('button', { name: 'Left' }).getAttribute('aria-pressed')).toBe('false')
    draw()
    fireEvent.click(screen.getByRole('button', { name: 'Right' }))
    draw()
    expect(ctx.fillText).toHaveBeenCalledWith('Collecting samples', expect.any(Number), expect.any(Number))
  })

  it('renders waiting and collecting states until enough waveform samples exist', () => {
    const { rerender } = render(<PiezoWaveform />)
    draw()
    expect(ctx.fillText).toHaveBeenCalledWith('Waiting for piezo data', expect.any(Number), expect.any(Number))
    stream.waveform = [frame(100, 5)]
    rerender(<PiezoWaveform />)
    draw()
    expect(ctx.fillText).toHaveBeenCalledWith('Collecting samples', expect.any(Number), expect.any(Number))
    stream.waveform = [frame(101, 30)]
    rerender(<PiezoWaveform />)
    for (let i = 0; i < 60; i++) draw()
    expect(ctx.bezierCurveTo).toHaveBeenCalled()
  })
})
