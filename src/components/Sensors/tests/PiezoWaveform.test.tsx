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
function draw(time = 0) {
  act(() => nextFrame?.(time))
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
    fireEvent.pointerMove(box, { clientX: 190, clientY: 10 })
    expect(screen.queryByTestId('chart-hover')).toBeNull()
    // Sweep the cursor across the one-second frame: it stops on the newest sample.
    for (let t = 0; t <= 1500; t += 100) draw(t)
    // An 8 s sweep of 200 buckets: sample 50000 (ts 100) is the cursor, at x = 200.
    // x = 190 is bucket 95, centred on sample 49910, 0.18 s behind the cursor.
    fireEvent.pointerMove(box, { clientX: 190, clientY: 10 })
    expect(screen.getByTestId('chart-hover').textContent).toBe('-0.18s · L 0 · R 0')
    fireEvent.click(screen.getByRole('button', { name: /Right/ }))
    fireEvent.pointerMove(box, { clientX: 190, clientY: 10 })
    expect(screen.getByTestId('chart-hover').textContent).toBe('-0.18s · L 0')
    // Inside the gap ahead of the cursor, and on the empty previous sweep
    fireEvent.pointerMove(box, { clientX: 205, clientY: 10 })
    expect(screen.queryByTestId('chart-hover')).toBeNull()
    fireEvent.pointerMove(box, { clientX: 300, clientY: 10 })
    expect(screen.queryByTestId('chart-hover')).toBeNull()
    fireEvent.pointerMove(box, { clientX: 190, clientY: 10 })
    expect(screen.getByTestId('chart-hover')).toBeTruthy()
    fireEvent.pointerMove(box, { clientX: 500, clientY: 10 })
    expect(screen.queryByTestId('chart-hover')).toBeNull()
    fireEvent.pointerMove(box, { clientX: 190, clientY: 10 })
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
    for (let i = 0; i < 60; i++) draw(i * 16)
    expect(ctx.bezierCurveTo).toHaveBeenCalled()
  })

  it('sweeps in place: drawn samples keep their position as the cursor advances and frames land', () => {
    stream.waveform = [frame(96), frame(97), frame(98), frame(99)]
    const { rerender } = render(<PiezoWaveform />)
    // The cursor is the last stroke of each frame; trace points are the curve endpoints.
    const cursorAt = () => ctx.lineTo.mock.calls.at(-1)?.[0] as number
    const pointsDrawn = () => new Set(ctx.bezierCurveTo.mock.calls.map(call => `${call[4]},${call[5]}`))
    draw(0)
    // 8 s sweep over 400 px, cursor 1.5 s behind the newest sample (ts 100): x = 125.
    expect(cursorAt()).toBe(125.5)
    const before = pointsDrawn()
    ctx.bezierCurveTo.mockClear()
    draw(100)
    // 100 ms later the cursor has crept 5 px, not jumped a frame's width.
    expect(cursorAt()).toBe(130.5)
    // The stream keeps ~10 s of frames, so everything on screen is still held.
    stream.waveform = [frame(96), frame(97), frame(98), frame(99), frame(100)]
    rerender(<PiezoWaveform />)
    ctx.bezierCurveTo.mockClear()
    draw(200)
    const after = pointsDrawn()
    const kept = [...before].filter(point => after.has(point)).length
    expect(kept).toBeGreaterThan(before.size * 0.9)
  })

  it('holds the vertical scale through a spike instead of rescaling to it', () => {
    // Behind the cursor, which trails the newest sample (ts 100) by 1.5 s
    const spiky = frame(98)
    spiky.left1[100] = 1_000_000
    stream.waveform = [frame(97), spiky, frame(99)]
    render(<PiezoWaveform />)
    draw(0)
    // The spike clips at the top. Left averages 4.5 and right -4.5, and they stay well
    // apart; scaling to the spike would have flattened both onto one line near the bottom.
    const ys = ctx.bezierCurveTo.mock.calls.map(call => call[5] as number).filter(y => y > 0 && y < 96)
    expect(ctx.bezierCurveTo.mock.calls.some(call => call[5] === 0)).toBe(true)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(30)
  })
})
