import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Chart3DData } from '@/src/components/Chart3D/chart3dScene'

const mock = vi.hoisted(() => ({ chart3d: vi.fn(), now: null as number | null, style: '3d' }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
vi.mock('@/src/components/Chart3D/Chart3D', () => ({ Chart3D: (props: unknown) => {
  mock.chart3d(props)
  return <div data-testid="chart3d" />
} }))
vi.mock('@/src/components/Chart3D/chart3dData', async importOriginal => ({
  ...await importOriginal<object>(),
  useChartStyle: () => [mock.style, vi.fn()],
}))
vi.mock('../CurveChart', async importOriginal => ({
  ...await importOriginal<object>(),
  useNowMinute: () => mock.now,
}))
const { CurveChart3D, monotone } = await import('../CurveChart3D')
const { CurveCard } = await import('../CurveCard')

afterEach(() => {
  cleanup()
  mock.now = null
  mock.style = '3d'
})

const props = () => mock.chart3d.mock.lastCall?.[0] as { state: string, data: Chart3DData | null }
const night = [
  { time: '22:00', temperature: 72 },
  { time: '01:00', temperature: 84 },
  { time: '06:00', temperature: 80 },
]

describe('monotone curve', () => {
  it('passes through every set point without overshooting and holds flat runs', () => {
    expect(monotone([])(5)).toBe(0)
    expect(monotone([{ x: 0, y: 3 }])(9)).toBe(3)
    const f = monotone([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 10 }, { x: 3, y: 4 }])
    expect(f(1)).toBeCloseTo(1)
    expect(f(1.5)).toBeCloseTo(1)
    for (let x = 0; x <= 1; x += 0.1) expect(f(x)).toBeLessThanOrEqual(1 + 1e-9)
    // Past a zero-width step the curve takes its far value.
    expect(f(4)).toBe(4)
    // Steep runs are clamped (Fritsch–Carlson) instead of ringing.
    const steep = monotone([{ x: 0, y: 0 }, { x: 1, y: 0.1 }, { x: 1.1, y: 10 }, { x: 2, y: 10.1 }])
    for (let x = 0; x <= 2; x += 0.05) expect(steep(x)).toBeLessThanOrEqual(10.1 + 1e-9)
  })
})

describe('3D schedule curve', () => {
  it('tints the target per set point, breaks the bed line at gaps and draws NOW inside the night', () => {
    // 23:30 local on a day: inside the overnight window.
    mock.now = Math.floor(new Date(2026, 0, 1, 23, 30).getTime() / 60_000)
    const bed = [{ minutes: 22 * 60, temperature: 75 }, { minutes: 22 * 60 + 5, temperature: 76 }, { minutes: 23 * 60, temperature: 78 }]
    render(<CurveChart3D setPoints={night} bed={bed} showNow />)
    const { state, data } = props()
    expect(state).toBe('ready')
    const [target, measured] = data?.series ?? []
    expect(target.stops?.map(s => s.color)).toEqual(['var(--accent-cool)', 'var(--accent-warm)', 'var(--accent-neutral)'])
    expect(target.points.every(p => p.y != null && p.y >= 0 && p.y <= 1)).toBe(true)
    // A 55-minute hole in the bed samples becomes a null break.
    expect(measured.points.map(p => p.y === null)).toEqual([false, false, true, false])
    expect(data?.now?.label).toMatch(/^NOW 11:30/)
    expect(data?.yTicks?.length).toBeGreaterThan(1)
    expect(data?.xTicks?.length).toBeGreaterThan(1)
  })

  it('leaves NOW out when the night is elsewhere, and is empty without set points', () => {
    mock.now = Math.floor(new Date(2026, 0, 1, 15, 0).getTime() / 60_000)
    const { rerender } = render(<CurveChart3D setPoints={night} showNow />)
    expect(props().data?.now).toBeNull()
    rerender(<CurveChart3D setPoints={[]} />)
    expect(props().state).toBe('empty')
  })

  it('replaces the featured card chart when charts are 3D', () => {
    const group = { key: 'wk', days: ['monday'], setPoints: night } as never
    render(<CurveCard group={group} onEdit={vi.fn()} onDelete={vi.fn()} featured isActive />)
    expect(mock.chart3d).toHaveBeenCalled()
  })
})
