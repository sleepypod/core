import { act, cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StageCanvasHandle } from '../StageCanvas'
import type { StageSceneCallbacks, StageSceneState } from '../stageScene'

const m = vi.hoisted(() => ({ webgl: true, load: vi.fn(), mount: vi.fn(), update: vi.fn(), orbitBy: vi.fn(), dispose: vi.fn() }))
vi.mock('@/src/components/Base/loadThree', () => ({ hasWebGL: () => m.webgl, loadThree: m.load }))
vi.mock('../stageScene', () => ({ mountStageScene: m.mount }))
const { default: StageCanvas } = await import('../StageCanvas')

const state = (selected: StageSceneState['selected'] = null): StageSceneState => ({
  sides: { left: { shownF: 72, zonesF: [70, 72, 74], targetF: 72 }, right: { shownF: 86, zonesF: [85, 86, 87], targetF: 86 } },
  selected,
  linked: false,
  zones: 'hover',
  previewing: false,
  autoReturn: true,
  hour: null,
})
const callbacks = () => ({ onHover: vi.fn(), onSelect: vi.fn(), onDrag: vi.fn(), onDragEnd: vi.fn(), onNudge: vi.fn() })
const labels = () => ({ side: { left: null, right: null }, linked: null, zones: { left: [], right: [] } })
const three = { WebGLRenderer: function WebGLRenderer() {} }

beforeEach(() => {
  vi.clearAllMocks()
  m.webgl = true
  m.load.mockResolvedValue(three)
  m.mount.mockReturnValue({ update: m.update, orbitBy: m.orbitBy, dispose: m.dispose })
})
afterEach(cleanup)

describe('StageCanvas lifecycle', () => {
  it('mounts once, forwards state, callbacks, labels and orbit, and disposes on unmount', async () => {
    const onMode = vi.fn()
    const ref = createRef<StageCanvasHandle>()
    const first = callbacks()
    const view = render(<StageCanvas ref={ref} state={state()} callbacks={first} labels={labels} onMode={onMode} />)
    await act(async () => {})
    expect(m.mount).toHaveBeenCalledOnce()
    const [library, host, forward, readLabels] = m.mount.mock.lastCall as [unknown, HTMLElement, StageSceneCallbacks, () => unknown]
    expect(library).toBe(three)
    expect(host.dataset.testid).toBe('stage-canvas')
    expect(host.getAttribute('aria-hidden')).toBe('true')
    expect(m.update).toHaveBeenLastCalledWith(state())
    expect(onMode).toHaveBeenLastCalledWith('3d')
    expect(readLabels()).toEqual(labels())

    // Callbacks always reach the latest props without remounting the scene.
    const second = callbacks()
    view.rerender(<StageCanvas ref={ref} state={state('left')} callbacks={second} labels={labels} onMode={onMode} />)
    expect(m.update).toHaveBeenLastCalledWith(state('left'))
    forward.onHover('right')
    forward.onSelect('left')
    forward.onDrag('left', 80)
    forward.onDragEnd('left', 81)
    forward.onNudge('right', -1)
    expect(second.onHover).toHaveBeenCalledWith('right')
    expect(second.onSelect).toHaveBeenCalledWith('left')
    expect(second.onDrag).toHaveBeenCalledWith('left', 80)
    expect(second.onDragEnd).toHaveBeenCalledWith('left', 81)
    expect(second.onNudge).toHaveBeenCalledWith('right', -1)
    expect(first.onSelect).not.toHaveBeenCalled()
    ref.current?.orbitBy(0.25)
    expect(m.orbitBy).toHaveBeenCalledWith(0.25)
    expect(m.mount).toHaveBeenCalledOnce()
    view.unmount()
    expect(m.dispose).toHaveBeenCalledOnce()
  })

  it('falls back to 2D without WebGL, without three.js or when mounting throws', async () => {
    m.webgl = false
    const onMode = vi.fn()
    const first = render(<StageCanvas state={state()} callbacks={callbacks()} labels={labels} onMode={onMode} />)
    await act(async () => {})
    expect(onMode).toHaveBeenLastCalledWith('2d')
    expect(m.load).not.toHaveBeenCalled()
    first.unmount()

    m.webgl = true
    m.load.mockResolvedValue(null)
    onMode.mockClear()
    const second = render(<StageCanvas state={state()} callbacks={callbacks()} labels={labels} onMode={onMode} />)
    await act(async () => {})
    expect(onMode).toHaveBeenLastCalledWith('2d')
    expect(m.mount).not.toHaveBeenCalled()
    second.unmount()

    m.load.mockResolvedValue(three)
    m.mount.mockImplementation(() => {
      throw new Error('No 2D canvas for the heat texture')
    })
    onMode.mockClear()
    render(<StageCanvas state={state()} callbacks={callbacks()} labels={labels} onMode={onMode} />)
    await act(async () => {})
    expect(onMode).toHaveBeenCalledExactlyOnceWith('2d')
  })

  it('releases a lost context and selects the flat cards', async () => {
    const onMode = vi.fn()
    render(<StageCanvas state={state()} callbacks={callbacks()} labels={labels} onMode={onMode} />)
    await act(async () => {})
    const forward = m.mount.mock.lastCall?.[2] as StageSceneCallbacks
    act(() => forward.onFail())
    expect(m.dispose).toHaveBeenCalledOnce()
    expect(onMode).toHaveBeenLastCalledWith('2d')
  })

  it('does not mount a late library after unmount', async () => {
    let resolve: (value: unknown) => void = () => {}
    m.load.mockReturnValue(new Promise((r) => {
      resolve = r
    }))
    const onMode = vi.fn()
    const view = render(<StageCanvas state={state()} callbacks={callbacks()} labels={labels} onMode={onMode} />)
    view.unmount()
    await act(async () => resolve(three))
    expect(m.mount).not.toHaveBeenCalled()
    expect(onMode).not.toHaveBeenCalled()
  })
})
