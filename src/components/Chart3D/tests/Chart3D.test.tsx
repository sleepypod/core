import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chart3DData, Chart3DSpec, ColorResolver } from '../chart3dScene'

const m = vi.hoisted(() => ({
  webgl: true,
  load: vi.fn(),
  mount: vi.fn(),
  scene: { setState: vi.fn(), setData: vi.fn(), recolor: vi.fn(), dispose: vi.fn() },
}))
vi.mock('@/src/components/Base/loadThree', () => ({ hasWebGL: () => m.webgl, loadThree: m.load }))
vi.mock('../chart3dScene', () => ({ mountChart3DScene: m.mount }))
const { Chart3D } = await import('../Chart3D')
const { chartState, lastValue, timeSeries3D, timeTicks, useChartStyle } = await import('../chart3dData')

const spec: Chart3DSpec = { series: [{ kind: 'ribbon' }] }
const data: Chart3DData = { series: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: 'var(--accent-cool)' }] }

beforeEach(() => {
  vi.clearAllMocks()
  m.webgl = true
  m.load.mockResolvedValue({ WebGLRenderer: function WebGLRenderer() {} })
  m.mount.mockReturnValue(m.scene)
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Chart3D', () => {
  it('mounts once per spec, forwards state and data, resolves tokens and disposes', async () => {
    const view = render(<Chart3D spec={spec} state="loading" aspect={3} label="Bed" />)
    await act(async () => {})
    expect(m.mount).toHaveBeenCalledOnce()
    expect(m.scene.setState).toHaveBeenLastCalledWith('loading')
    const box = screen.getByRole('img', { name: 'Bed' })
    expect(box.style.aspectRatio).toBe('3 / 1')
    expect(box.getAttribute('aria-busy')).toBe('true')

    // The resolver reads computed colours as rgb(); jsdom reports what was set.
    const resolve = m.mount.mock.lastCall?.[3] as ColorResolver
    expect(resolve('rgb(10, 20, 30)')).toBe('rgb(10,20,30)')
    expect(resolve('rgba(10, 20, 30, 0.5)')).toBe('rgb(10,20,30)')
    vi.spyOn(window, 'getComputedStyle').mockReturnValueOnce({ color: 'color(srgb 1 0 0.5)' } as CSSStyleDeclaration)
    expect(resolve('red')).toBe('rgb(255,0,128)')
    vi.spyOn(window, 'getComputedStyle').mockReturnValueOnce({ color: '' } as CSSStyleDeclaration)
    expect(resolve('nonsense')).toBe('#888888')

    view.rerender(<Chart3D spec={spec} state="ready" data={data} aspect={3} label="Bed" />)
    expect(m.scene.setData).toHaveBeenLastCalledWith(data)
    // Ready with nothing to draw is the empty state.
    view.rerender(<Chart3D spec={spec} state="ready" data={null} aspect={3} label="Bed" message="No data" />)
    expect(m.scene.setState).toHaveBeenLastCalledWith('empty')
    expect(screen.getByText('No data')).toBeTruthy()

    // A theme switch re-reads the colours.
    document.documentElement.dataset.theme = 'light'
    await act(async () => {})
    expect(m.scene.recolor).toHaveBeenCalled()
    delete document.documentElement.dataset.theme

    view.unmount()
    expect(m.scene.dispose).toHaveBeenCalledOnce()
  })

  it('applies the latest state when three.js arrives late and offers Retry on error', async () => {
    const onRetry = vi.fn()
    render(<Chart3D spec={spec} state="ready" data={data} aspect={2} label="Flow" message="Failed" onRetry={onRetry} />)
    await act(async () => {})
    expect(m.scene.setData).toHaveBeenCalledWith(data)
    cleanup()
    render(<Chart3D spec={spec} state="error" aspect={2} label="Flow" message="Failed" onRetry={onRetry} />)
    await act(async () => {})
    expect(m.scene.setState).toHaveBeenLastCalledWith('error')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('switches every chart to flat when WebGL, three.js or the scene fails', async () => {
    const { result } = renderHook(() => useChartStyle())
    expect(result.current[0]).toBe('3d')
    act(() => result.current[1]('flat'))
    expect(result.current[0]).toBe('flat')
    act(() => result.current[1]('3d'))

    m.mount.mockImplementationOnce(() => {
      throw new Error('no context')
    })
    render(<Chart3D spec={spec} state="loading" aspect={3} label="Bed" />)
    await act(async () => {})
    expect(result.current[0]).toBe('flat')
  })
})

describe('chart data helpers', () => {
  it('maps query flags to chart states', () => {
    expect(chartState({ isLoading: true, isError: false }, false)).toBe('loading')
    expect(chartState({ isLoading: false, isError: true }, false)).toBe('error')
    expect(chartState({ isLoading: false, isError: false }, true)).toBe('empty')
    expect(chartState({ isLoading: false, isError: false }, false)).toBe('ready')
  })

  it('steps clock ticks to fit and normalises time series onto one range', () => {
    const start = new Date(2026, 0, 1, 10, 7).getTime()
    const ticks = timeTicks(start, start + 6 * 3_600_000, t => new Date(t).getHours().toString())
    expect(ticks.length).toBeLessThanOrEqual(6)
    expect(ticks[0].label).toBe('11')
    expect(ticks.every(tk => tk.x >= 0 && tk.x <= 1)).toBe(true)
    expect(timeTicks(start, start, String)).toEqual([])
    // Longer than every step: the largest step still applies.
    expect(timeTicks(start, start + 30 * 86_400_000, String).length).toBeGreaterThan(6)

    const out = timeSeries3D([0, 60_000, 120_000], [{ values: [10, null, 20], color: 'red', value: '20' }], 10, 20, String)
    expect(out.series[0].points).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: null }, { x: 1, y: 1 }])
    expect(out.series[0].value).toBe('20')
    expect(timeSeries3D([], [{ values: [], color: 'red' }], 0, 0, String).series[0].points).toEqual([])
    expect(lastValue([1, 2, null])).toBe(2)
    expect(lastValue([null])).toBeNull()
  })
})
