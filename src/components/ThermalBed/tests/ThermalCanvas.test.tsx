import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ webgl: true, load: vi.fn(), mount: vi.fn(), update: vi.fn(), dispose: vi.fn() }))
vi.mock('@/src/components/Base/loadThree', () => ({ hasWebGL: () => m.webgl, loadThree: m.load }))
vi.mock('../thermalScene', () => ({ mountThermalScene: m.mount }))
import ThermalCanvas from '../ThermalCanvas'
const states = {
  left: { zones: [20, 22, 24] as [number, number, number], direction: -1 as const, strength: 0.5, mode: 'cooling' as const, targetF: 70, currentF: 80 },
  right: { zones: [30, 32, 34] as [number, number, number], direction: 1 as const, strength: 0.5, mode: 'off' as const, targetF: null, currentF: 80 },
}
beforeEach(() => {
  vi.clearAllMocks()
  m.webgl = true
  m.load.mockResolvedValue({})
  m.mount.mockReturnValue({ update: m.update, dispose: m.dispose })
})
afterEach(cleanup)
describe('ThermalCanvas lifecycle', () => {
  it('keeps a flat overview when WebGL or the loader is unavailable', async () => {
    m.webgl = false
    const first = render(<ThermalCanvas unit="F" states={states} focus={null} />)
    expect(first.getByText('Surface overview')).toBeTruthy()
    expect(m.load).not.toHaveBeenCalled()
    first.unmount()
    m.webgl = true
    m.load.mockResolvedValue(null)
    const second = render(<ThermalCanvas unit="F" states={states} focus={null} />)
    await act(async () => {})
    expect(second.getByText('Surface overview')).toBeTruthy()
    expect(m.mount).not.toHaveBeenCalled()
  })
  it('shows exactly six independent regions in anatomical order in the fallback', () => {
    m.webgl = false
    const view = render(<ThermalCanvas unit="C" states={states} focus={null} />)
    const regions = Array.from(view.container.querySelectorAll('[data-thermal-region]'))
    expect(regions.map(region => region.getAttribute('data-thermal-region'))).toEqual([
      'left-outer', 'left-center', 'left-inner', 'right-inner', 'right-center', 'right-outer',
    ])
    expect(regions.map(region => region.textContent)).toEqual([
      'L outer20.0°', 'L center22.0°', 'L inner24.0°', 'R inner34.0°', 'R center32.0°', 'R outer30.0°',
    ])
    view.rerender(<ThermalCanvas unit="F" states={{ ...states, left: { ...states.left, zones: [null, 22, 24] } }} focus={null} />)
    expect(regions[0].textContent).toBe('L outer--')
    expect(regions[1].textContent).toBe('L center71.6°')
  })
  it('uses two continuous sides without regional labels for the overview fallback', () => {
    m.webgl = false
    const view = render(<ThermalCanvas unit="C" states={states} focus={null} view="overview" />)
    expect(view.container.querySelectorAll('[data-thermal-region]')).toHaveLength(2)
    expect(view.queryByText('L outer')).toBeNull()
    // The flat view carries the same status pills as the 3D overlay.
    const pills = Array.from(view.container.querySelectorAll<HTMLElement>('.thermal-pill'))
    expect(pills.map(pill => pill.dataset.mode)).toEqual(['cooling', 'off'])
    expect(pills.map(pill => pill.textContent)).toEqual(['22°→ 21°', '32°'])
  })
  it('updates without rebuilding the scene and releases GPU resources on unmount', async () => {
    const view = render(<ThermalCanvas unit="F" states={states} focus={null} />)
    await act(async () => {})
    expect(m.mount).toHaveBeenCalledTimes(1)
    view.rerender(<ThermalCanvas unit="F" states={states} focus="right" />)
    expect(m.update).toHaveBeenLastCalledWith(states, 'right', 'F')
    expect(m.mount).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })
  it('releases a lost context and selects the fallback', async () => {
    const view = render(<ThermalCanvas unit="F" states={states} focus={null} />)
    await act(async () => {})
    act(() => m.mount.mock.lastCall?.[2]())
    expect(view.getByText('Surface overview')).toBeTruthy()
    expect(m.dispose).toHaveBeenCalledTimes(1)
  })
  it('does not mount a late library after the card has been closed', async () => {
    let resolve: (value: object) => void = () => {}
    m.load.mockReturnValue(new Promise<object>((r) => {
      resolve = r
    }))
    const view = render(<ThermalCanvas unit="F" states={states} focus={null} />)
    view.unmount()
    await act(async () => resolve({}))
    expect(m.mount).not.toHaveBeenCalled()
  })
})
