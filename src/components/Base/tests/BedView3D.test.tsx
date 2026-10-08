import { act, cleanup, render } from '@testing-library/react'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BedRendererProps } from '../BedView'
import type { Three } from '../loadThree'
import BedView3D from '../BedView3D'
import { DAY_ROOM, NIGHT_ROOM } from '../bedLook'
import { ORBIT, createOrbit } from '../bedOrbit'

const t = vi.hoisted(() => ({
  frames: new Map<number, FrameRequestCallback>(),
  next: 1,
  observers: [] as { disconnect: ReturnType<typeof vi.fn> }[],
  reduced: false,
  light: false,
  environments: [] as { texture: unknown, dispose: ReturnType<typeof vi.fn> }[],
  renderers: [] as Renderer[],
}))

interface Renderer {
  domElement: HTMLCanvasElement
  render: ReturnType<typeof vi.fn>
  setSize: ReturnType<typeof vi.fn>
  setClearColor: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  forceContextLoss: ReturnType<typeof vi.fn>
}

class Observer {
  disconnect = vi.fn()
  constructor() {
    t.observers.push(this)
  }

  observe() {}
}

/** Run queued frames well past any swing so eased motion lands in one pass. */
const flush = (limit = 50) => act(() => {
  for (let i = 0; i < limit && t.frames.size; i++) {
    const [[id, callback]] = t.frames
    t.frames.delete(id)
    callback(performance.now() + 10_000)
  }
})

const gradient = () => ({ addColorStop() {} })
const context2d = () => ({ fillStyle: '', globalCompositeOperation: '', fillRect() {}, translate() {}, scale() {}, createLinearGradient: gradient, createRadialGradient: gradient })

const library = {
  ...THREE,
  WebGLRenderer: class {
    domElement = document.createElement('canvas')
    shadowMap = { enabled: false, type: 0 }
    render = vi.fn((scene: THREE.Scene) => scene.updateMatrixWorld())
    setSize = vi.fn()
    setClearColor = vi.fn()
    dispose = vi.fn()
    forceContextLoss = vi.fn()
    setPixelRatio() {}
    constructor() {
      t.renderers.push(this as unknown as Renderer)
    }
  },
  // No GL in jsdom: the studio environment prefilter is skipped.
  PMREMGenerator: class {
    fromScene() {
      const environment = { texture: new THREE.Texture(), dispose: vi.fn() }
      t.environments.push(environment)
      return environment
    }

    dispose() {}
  },
} as unknown as Three

const props: BedRendererProps = {
  left: { head: 0, feet: 0 },
  right: { head: 0, feet: 0 },
  leftTarget: { head: 0, feet: 0 },
  rightTarget: { head: 0, feet: 0 },
  moving: { left: false, right: false },
  split: true,
  bedModel: 'base',
}

function mount(over: Partial<BedRendererProps> = {}, three = library) {
  const onReady = vi.fn()
  const onFail = vi.fn()
  const view = render(<BedView3D three={three} onReady={onReady} onFail={onFail} {...props} {...over} />)
  const host = view.getByTestId('bed-view-3d')
  const renderer = () => t.renderers[t.renderers.length - 1]
  const scene = () => renderer().render.mock.lastCall?.[0] as THREE.Scene
  const camera = () => renderer().render.mock.lastCall?.[1] as THREE.PerspectiveCamera
  const rerender = (next: Partial<BedRendererProps>) => view.rerender(<BedView3D three={three} onReady={onReady} onFail={onFail} {...props} {...next} />)
  return { view, host, renderer, scene, camera, rerender, onReady, onFail }
}

beforeEach(() => {
  t.frames.clear()
  t.observers.length = 0
  t.environments.length = 0
  t.renderers.length = 0
  t.reduced = false
  t.light = false
  delete document.documentElement.dataset.theme
  vi.stubGlobal('ResizeObserver', Observer)
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = t.next++
    t.frames.set(id, callback)
    return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => t.frames.delete(id)))
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduced-motion') ? t.reduced : t.light }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context2d() as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 600, height: 330 } as DOMRect)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete document.documentElement.dataset.theme
})

describe('BedView3D', () => {
  it('mounts a decorative canvas in a night room and reveals it on the first frame', () => {
    const { host, renderer, scene, onReady } = mount()
    const canvas = renderer().domElement
    expect(host.firstChild).toBe(canvas)
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    expect(host.className).toContain('[&>canvas]:opacity-0')
    expect(renderer().setSize).toHaveBeenCalledWith(600, 330, false)
    expect(renderer().setClearColor).toHaveBeenLastCalledWith(NIGHT_ROOM.haze, 1)
    expect(onReady).not.toHaveBeenCalled()
    flush()
    expect(onReady).toHaveBeenCalledOnce()
    expect(host.className).not.toContain('opacity-0')
    expect(scene().environment).toBe(t.environments[0].texture)
    expect(scene().environmentIntensity).toBe(0.9)
    const shadow = scene().children.find(c => c instanceof THREE.Mesh && c.material instanceof THREE.ShadowMaterial) as THREE.Mesh<THREE.BufferGeometry, THREE.ShadowMaterial>
    expect(shadow.material.opacity).toBe(0.3)
    expect(scene().children.filter(c => c instanceof THREE.DirectionalLight)).toHaveLength(3)
    // Further frames do not announce readiness again.
    renderer().domElement.dispatchEvent(new MouseEvent('dblclick'))
    flush()
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('starts in the day room for the light theme and relights when the theme flips', async () => {
    t.light = true
    const { renderer, scene } = mount()
    flush()
    expect(renderer().setClearColor).toHaveBeenLastCalledWith(DAY_ROOM.haze, 1)
    expect(scene().environmentIntensity).toBe(0.7)
    const hemisphere = scene().children.find(c => c instanceof THREE.HemisphereLight) as THREE.HemisphereLight
    expect(hemisphere.intensity).toBeCloseTo(1.9 * 0.75)
    document.documentElement.dataset.theme = 'dark'
    await act(async () => {})
    flush()
    expect(t.environments[0].dispose).toHaveBeenCalledOnce()
    expect(scene().environment).toBe(t.environments[1].texture)
    expect(renderer().setClearColor).toHaveBeenLastCalledWith(NIGHT_ROOM.haze, 1)
    expect(hemisphere.intensity).toBeCloseTo(1.9)
    // A class change that keeps the theme only re-renders.
    document.documentElement.classList.add('x')
    await act(async () => {})
    expect(t.environments).toHaveLength(2)
    document.documentElement.classList.remove('x')
  })

  it('re-renders only when a pose moves and draws a ghost while moving', () => {
    const { rerender, renderer, scene } = mount()
    flush()
    const calls = renderer().render.mock.calls.length
    rerender({})
    expect(t.frames.size).toBe(0)
    rerender({ left: { head: 30, feet: 10 }, rightTarget: { head: 40, feet: 0 }, moving: { left: false, right: true } })
    flush()
    expect(renderer().render.mock.calls.length).toBe(calls + 1)
    const ghosts: THREE.Mesh[] = []
    scene().traverse(node => node instanceof THREE.Mesh && !Array.isArray(node.material) && node.material.transparent && node.material.opacity > 0 && node.material.opacity < 1 && ghosts.push(node))
    expect(ghosts.length).toBeGreaterThan(0)
  })

  it('swings round to a newly focused side, snapping with reduced motion', () => {
    const { rerender, camera } = mount()
    flush()
    const at = (azimuth: number) => {
      const orbit = createOrbit(azimuth)
      return orbit.position(0)
    }
    expect(camera().position.z).toBeCloseTo(at(ORBIT.azimuth).z)
    rerender({ focus: 'right' })
    expect(t.frames.size).toBeGreaterThan(0)
    flush()
    expect(camera().position.z).toBeCloseTo(at(-ORBIT.azimuth).z)
    expect(camera().position.z).toBeLessThan(0)
    t.reduced = true
    rerender({ focus: 'left' })
    flush(1)
    expect(camera().position.z).toBeCloseTo(at(ORBIT.azimuth).z)
    flush()
    // Both keeps the left sleeper's home, so nothing moves.
    rerender({ focus: 'both' })
    expect(t.frames.size).toBe(0)
  })

  it('orbits on drag, pauses while hidden and reports a lost context', () => {
    const { renderer, camera, onFail } = mount()
    flush()
    const canvas = renderer().domElement
    const z = camera().position.z
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { clientX: x, clientY: 0, button: 0 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      canvas.dispatchEvent(event)
    }
    pointer('pointerdown', 0)
    pointer('pointermove', 60)
    pointer('pointerup', 60)
    flush()
    expect(camera().position.z).toBeLessThan(z)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    renderer().render.mockClear()
    pointer('pointerdown', 0)
    pointer('pointermove', 30)
    flush()
    expect(renderer().render).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    flush()
    expect(renderer().render).toHaveBeenCalledOnce()
    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)
    expect(lost.defaultPrevented).toBe(true)
    expect(onFail).toHaveBeenCalledOnce()
  })

  it('builds one half for a single side, rebuilds when the side set changes and cleans up', () => {
    const { rerender, renderer, view, host } = mount({ single: 'left' })
    flush()
    const first = renderer()
    const disposals: ReturnType<typeof vi.spyOn>[] = []
    ;(first.render.mock.lastCall?.[0] as THREE.Scene).traverse((node) => {
      if (node instanceof THREE.Mesh) disposals.push(vi.spyOn(node.geometry, 'dispose'))
    })
    rerender({ single: 'right' })
    expect(t.renderers).toHaveLength(2)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(first.forceContextLoss).toHaveBeenCalledOnce()
    expect(host.contains(first.domElement)).toBe(false)
    expect(t.observers[0].disconnect).toHaveBeenCalledOnce()
    disposals.forEach(spy => expect(spy).toHaveBeenCalled())
    expect(t.environments[0].dispose).toHaveBeenCalledOnce()
    const second = renderer()
    view.unmount()
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(t.frames.size).toBe(0)
  })

  it('reports failure when the scene cannot be built', () => {
    const broken = { ...library, WebGLRenderer: function WebGLRenderer() {
      throw new Error('no context')
    } } as unknown as Three
    const { onFail, host } = mount({}, broken)
    expect(onFail).toHaveBeenCalledOnce()
    expect(host.childElementCount).toBe(0)
  })

  it('waits for a sized host, eases a swing over several frames and ignores visibility while hidden', () => {
    vi.stubGlobal('devicePixelRatio', 0)
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 0, height: 0 } as DOMRect)
    const { renderer, rerender, camera } = mount()
    expect(renderer().setSize).not.toHaveBeenCalled()
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 600, height: 330 } as DOMRect)
    flush()
    rerender({ focus: 'right' })
    // A frame early in the swing leaves the camera part way and asks for another.
    const [[id, step]] = t.frames
    t.frames.delete(id)
    act(() => step(performance.now()))
    expect(t.frames.size).toBeGreaterThan(0)
    flush()
    expect(camera().position.z).toBeLessThan(0)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(t.frames.size).toBe(0)
  })
})

