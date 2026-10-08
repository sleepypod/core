import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Three } from '@/src/components/Base/loadThree'
import { CAMERA, DEFAULT_CAMERA } from '../stageCamera'
import { resetKnit } from '../heatTexture'
import { SCENE, mountStageScene, slabGeometry } from '../stageScene'
import type { StageLabelRefs, StageSceneCallbacks, StageSceneState } from '../stageScene'

const t = vi.hoisted(() => ({
  frames: new Map<number, FrameRequestCallback>(),
  next: 1,
  resize: null as null | (() => void),
  observers: [] as { disconnect: ReturnType<typeof vi.fn> }[],
  reduced: { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  fills: 0,
  context: true,
}))

class Observer {
  disconnect = vi.fn()
  constructor(callback: () => void) {
    t.resize = callback
    t.observers.push(this)
  }

  observe() {}
}

/** Run queued animation frames until the scene stops asking (or `limit` frames pass). */
const flush = (limit = 400) => {
  for (let i = 0; i < limit && t.frames.size; i++) {
    const [[id, callback]] = t.frames
    t.frames.delete(id)
    callback(0)
  }
}

const gradient = () => ({ addColorStop() {} })
const context2d = () => ({
  globalCompositeOperation: 'source-over',
  fillStyle: '',
  fillRect: () => t.fills++,
  createLinearGradient: gradient,
  createRadialGradient: gradient,
  createPattern: () => null,
  save() {},
  restore() {},
  translate() {},
  scale() {},
})

interface Renderer {
  domElement: HTMLCanvasElement
  render: ReturnType<typeof vi.fn>
  setSize: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  forceContextLoss: ReturnType<typeof vi.fn>
  shadowMap: { enabled: boolean, type: number }
}

function setup(size = { width: 1000, height: 800 }) {
  const renderers: Renderer[] = []
  const cameras: THREE.PerspectiveCamera[] = []
  const library = {
    ...THREE,
    WebGLRenderer: class {
      domElement = document.createElement('canvas')
      shadowMap = { enabled: false, type: 0 }
      capabilities = { getMaxAnisotropy: () => 16 }
      // The real renderer updates world matrices before drawing; picking depends on it.
      render = vi.fn((scene: THREE.Scene) => scene.updateMatrixWorld())
      setSize = vi.fn()
      dispose = vi.fn()
      forceContextLoss = vi.fn()
      setPixelRatio() {}
      setClearColor() {}
      constructor() {
        renderers.push(this as unknown as Renderer)
      }
    },
    PerspectiveCamera: class extends THREE.PerspectiveCamera {
      constructor(...args: ConstructorParameters<typeof THREE.PerspectiveCamera>) {
        super(...args)
        cameras.push(this)
      }
    },
  } as unknown as Three
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rect = { left: 0, top: 0, ...size, right: size.width, bottom: size.height, x: 0, y: 0, toJSON() {} } as DOMRect
  host.getBoundingClientRect = () => rect
  const callbacks: StageSceneCallbacks = { onHover: vi.fn(), onSelect: vi.fn(), onDrag: vi.fn(), onDragEnd: vi.fn(), onNudge: vi.fn(), onFail: vi.fn() }
  const el = () => document.createElement('div')
  const refs: StageLabelRefs = {
    side: { left: el(), right: el() },
    linked: el(),
    zones: { left: [el(), el(), el()], right: [el(), el(), null] },
  }
  const scene = mountStageScene(library, host, callbacks, () => refs)
  const renderer = renderers[0]
  const canvas = renderer.domElement
  canvas.getBoundingClientRect = () => rect
  const camera = cameras[0]
  const three = () => renderer.render.mock.lastCall?.[0] as THREE.Scene
  /** Screen point of a world position through the scene camera. */
  const screen = (x: number, y: number, z: number) => {
    const p = new THREE.Vector3(x, y, z).project(camera)
    return { clientX: (p.x + 1) / 2 * size.width, clientY: (1 - p.y) / 2 * size.height }
  }
  return { scene, host, callbacks, refs, renderer, canvas, camera, three, screen }
}

const fire = (target: EventTarget, type: string, at: { clientX: number, clientY: number }, extra: { pointerId?: number, pointerType?: string, button?: number } = {}) => {
  const event = new MouseEvent(type, { clientX: at.clientX, clientY: at.clientY, button: extra.button ?? 0, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerId', { value: extra.pointerId ?? 1 })
  Object.defineProperty(event, 'pointerType', { value: extra.pointerType ?? 'mouse' })
  target.dispatchEvent(event)
  return event
}

const side = (shownF: number | null, targetF = 75) => ({ shownF, zonesF: [70, 72, 74] as [number, number, number], targetF })
const state = (over: Partial<StageSceneState> = {}): StageSceneState => ({
  sides: { left: side(72), right: side(86, 86) },
  selected: null,
  linked: false,
  zones: 'hover',
  previewing: false,
  autoReturn: false,
  hour: null,
  ...over,
})

beforeEach(() => {
  t.frames.clear()
  t.observers.length = 0
  t.fills = 0
  t.context = true
  t.reduced.matches = false
  t.reduced.addEventListener.mockClear()
  t.reduced.removeEventListener.mockClear()
  resetKnit()
  vi.stubGlobal('ResizeObserver', Observer)
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = t.next++
    t.frames.set(id, callback)
    return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => t.frames.delete(id)))
  vi.stubGlobal('matchMedia', () => t.reduced)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => (t.context ? context2d() : null) as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('slab geometry', () => {
  it('sits on y = 0 with its top cap at the slab height and the requested footprint', () => {
    const geometry = slabGeometry(THREE, 4, 3, 0.5, 0.2, 0.05)
    geometry.computeBoundingBox()
    const box = geometry.boundingBox as THREE.Box3
    expect(box.min.y).toBeCloseTo(0, 5)
    expect(box.max.y).toBeCloseTo(0.5, 5)
    expect(box.max.x - box.min.x).toBeCloseTo(4.1, 5)
    expect(box.max.z - box.min.z).toBeCloseTo(3.1, 5)
    expect(geometry.getIndex()).not.toBeNull()
  })
})

describe('stage scene', () => {
  it('builds the room, mattress and two invisible pick planes, sized to the host', () => {
    const { renderer, canvas, host, camera, three } = setup()
    expect(host.firstChild).toBe(canvas)
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    expect(canvas.style.cursor).toBe('grab')
    expect(renderer.shadowMap.enabled).toBe(true)
    expect(renderer.setSize).toHaveBeenCalledWith(1000, 800, false)
    expect(camera.aspect).toBeCloseTo(1.25)
    expect(camera.view?.offsetY).toBe(Math.round(400 - (CAMERA.bandTop + (800 - CAMERA.bandTop - CAMERA.bandBottom) / 2)))
    flush()
    const scene = three()
    const meshes = scene.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
    expect(meshes).toHaveLength(6)
    const picks = meshes.filter(m => m.name)
    expect(picks.map(p => [p.name, p.position.z])).toEqual([['L', SCENE.sideZ], ['R', -SCENE.sideZ]])
    expect((picks[0].material as THREE.MeshBasicMaterial).opacity).toBe(0)
    const mattress = meshes.find(m => Array.isArray(m.material)) as THREE.Mesh
    const [cap] = mattress.material as THREE.MeshStandardMaterial[]
    expect(cap.map).toBeInstanceOf(THREE.CanvasTexture)
    expect(cap.map?.anisotropy).toBe(4)
    expect(cap.map?.flipY).toBe(false)
    expect(scene.children.filter(c => c instanceof THREE.DirectionalLight)).toHaveLength(3)
    expect(scene.fog).toBeInstanceOf(THREE.Fog)
  })

  it('throws when the heat texture has no 2D canvas', () => {
    t.context = false
    expect(() => setup()).toThrow('No 2D canvas for the heat texture')
  })

  it('repaints the heat only when its inputs change and fades zone readouts in', () => {
    const { scene, three, refs } = setup()
    scene.update(state({ zones: 'always' }))
    flush()
    const cap = (three().children.find(c => c instanceof THREE.Mesh && Array.isArray(c.material)) as THREE.Mesh).material as THREE.MeshStandardMaterial[]
    const version = cap[0].map?.version ?? 0
    expect(version).toBeGreaterThan(0)
    expect(refs.zones.left[0]?.style.opacity).toBe('1')
    expect(refs.zones.left[0]?.style.transform).toMatch(/^translate3d\(/)
    expect(refs.side.left?.style.transform).toMatch(/scale\(1\)$/)
    const fills = t.fills
    scene.update(state({ zones: 'always' }))
    flush()
    expect(t.fills).toBe(fills)
    scene.update(state({ zones: 'always', sides: { left: side(60), right: side(86) } }))
    flush()
    expect(t.fills).toBeGreaterThan(fills)
    expect(cap[0].map?.version).toBeGreaterThan(version)
    scene.update(state({ zones: 'off' }))
    flush()
    expect(refs.zones.right[1]?.style.opacity).toBe('0')
    scene.update(state({ zones: 'always', previewing: true }))
    flush()
    expect(refs.zones.left[2]?.style.opacity).toBe('0')
  })

  it('shows zones for the selected side (both when linked) and grows its label', () => {
    const { scene, refs } = setup()
    scene.update(state({ selected: 'left' }))
    flush()
    expect(refs.zones.left[0]?.style.opacity).toBe('1')
    expect(refs.zones.right[0]?.style.opacity).toBe('0')
    expect(refs.side.left?.style.transform).toMatch(/scale\(1\.08\)$/)
    expect(refs.linked?.style.transform).toMatch(/scale\(1\.08\)$/)
    scene.update(state({ selected: 'left', linked: true }))
    flush()
    expect(refs.zones.right[0]?.style.opacity).toBe('1')
    expect(refs.side.left?.style.transform).toMatch(/scale\(1\)$/)
  })

  it('eases the camera to the selected side and home again', () => {
    const { scene } = setup()
    scene.update(state({ selected: 'right' }))
    flush()
    expect(scene.camera()).toMatchObject({ phi: 2.75, r: 6.8, oz: -0.35, lateral: 1.05 })
    scene.update(state())
    flush()
    expect(scene.camera()).toEqual(DEFAULT_CAMERA)
  })

  it('snaps the camera in one frame with reduced motion', () => {
    t.reduced.matches = true
    const { scene } = setup()
    flush()
    scene.update(state({ selected: 'left' }))
    expect(t.frames.size).toBe(1)
    flush()
    expect(scene.camera().phi).toBe(0.35)
    scene.orbitBy(0.25)
    expect(scene.camera().phi).toBeCloseTo(0.6)
  })

  it('swings the view by the arrow-key step', () => {
    const { scene } = setup()
    scene.update(state())
    flush()
    scene.orbitBy(CAMERA.orbitStep)
    flush()
    expect(scene.camera().phi).toBeCloseTo(DEFAULT_CAMERA.phi + CAMERA.orbitStep)
  })

  it('drifts home after a quiet spell when auto return is on and nothing is selected', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { scene } = setup()
    scene.update(state({ autoReturn: true }))
    scene.orbitBy(1)
    flush()
    expect(scene.camera().phi).toBeCloseTo(DEFAULT_CAMERA.phi + 1)
    vi.advanceTimersByTime(CAMERA.autoReturnMs)
    flush()
    expect(scene.camera().phi).toBeCloseTo(DEFAULT_CAMERA.phi)
  })

  it('dims and warms the key light through the night', () => {
    const { scene, three } = setup()
    scene.update(state())
    flush()
    const key = () => three().children.find(c => c instanceof THREE.DirectionalLight) as THREE.DirectionalLight
    const hemisphere = () => three().children.find(c => c instanceof THREE.HemisphereLight) as THREE.HemisphereLight
    expect(key().intensity).toBeCloseTo(1.1)
    scene.update(state({ hour: 2.5 }))
    flush()
    expect(key().intensity).toBeLessThan(0.5)
    expect(hemisphere().intensity).toBeLessThan(0.25)
    scene.update(state({ hour: 6 }))
    flush()
    expect(key().color.b).toBeLessThan(key().color.r)
  })

  it('hovers, taps and drags a side, and orbits from empty floor', () => {
    const { scene, canvas, callbacks, screen } = setup()
    scene.update(state())
    flush()
    const left = screen(0, 0.77, SCENE.sideZ)
    fire(canvas, 'pointermove', left)
    expect(callbacks.onHover).toHaveBeenLastCalledWith('left')
    expect(canvas.style.cursor).toBe('ns-resize')
    fire(canvas, 'pointermove', left)
    expect(callbacks.onHover).toHaveBeenCalledTimes(1)
    fire(canvas, 'pointerleave', left)
    expect(callbacks.onHover).toHaveBeenLastCalledWith(null)
    expect(canvas.style.cursor).toBe('grab')

    // A tap selects.
    fire(canvas, 'pointerdown', left)
    fire(canvas, 'pointermove', { clientX: left.clientX + 1, clientY: left.clientY })
    fire(canvas, 'pointerup', left)
    expect(callbacks.onSelect).toHaveBeenCalledWith('left')

    // A vertical drag sets the target: 14 px up per degree, from the side's target.
    fire(canvas, 'pointerdown', left)
    fire(canvas, 'pointermove', { clientX: left.clientX, clientY: left.clientY - 28 })
    expect(callbacks.onDrag).toHaveBeenLastCalledWith('left', 77)
    fire(canvas, 'pointermove', { clientX: left.clientX, clientY: left.clientY - 30 })
    expect(callbacks.onDrag).toHaveBeenCalledTimes(1)
    fire(canvas, 'pointermove', { clientX: left.clientX, clientY: left.clientY - 28 }, { pointerId: 2 })
    fire(canvas, 'pointerup', left)
    expect(callbacks.onDragEnd).toHaveBeenCalledWith('left', 77)
    expect(callbacks.onSelect).toHaveBeenCalledTimes(1)

    // A cancelled tap does nothing; a right click is ignored.
    fire(canvas, 'pointerdown', left)
    fire(canvas, 'pointercancel', left)
    fire(canvas, 'pointerdown', left, { button: 2 })
    fire(canvas, 'pointerup', left)
    expect(callbacks.onSelect).toHaveBeenCalledTimes(1)

    // Empty floor orbits.
    const floor = { clientX: 5, clientY: 5 }
    const phi = scene.camera().phi
    fire(canvas, 'pointerdown', floor, { pointerType: 'touch' })
    fire(canvas, 'pointermove', { clientX: 105, clientY: 5 }, { pointerType: 'touch' })
    expect(canvas.style.cursor).toBe('grabbing')
    expect(scene.camera().phi).toBeCloseTo(phi - 100 * CAMERA.orbitRate)
    fire(canvas, 'pointerup', floor, { pointerType: 'touch' })
    expect(canvas.style.cursor).toBe('grab')
    expect(callbacks.onSelect).toHaveBeenCalledTimes(1)
  })

  it('nudges a side with the wheel and zooms over empty floor within limits', () => {
    const { scene, canvas, callbacks, screen } = setup()
    scene.update(state())
    flush()
    const right = screen(0, 0.77, -SCENE.sideZ)
    const wheel = (at: { clientX: number, clientY: number }, deltaY: number) => {
      const event = new WheelEvent('wheel', { ...at, deltaY, cancelable: true })
      canvas.dispatchEvent(event)
      return event
    }
    expect(wheel(right, -100).defaultPrevented).toBe(true)
    expect(callbacks.onNudge).toHaveBeenLastCalledWith('right', 1)
    wheel(right, 100)
    expect(callbacks.onNudge).toHaveBeenLastCalledWith('right', -1)
    wheel({ clientX: 5, clientY: 5 }, 100)
    expect(scene.camera().r).toBeCloseTo(DEFAULT_CAMERA.r * Math.exp(100 * SCENE.wheelZoomRate))
    wheel({ clientX: 5, clientY: 5 }, 10000)
    expect(scene.camera().r).toBe(CAMERA.maxR)
    expect(callbacks.onNudge).toHaveBeenCalledTimes(2)
  })

  it('reports a lost context and skips rendering while the page is hidden', () => {
    const { scene, canvas, callbacks, renderer } = setup()
    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)
    expect(lost.defaultPrevented).toBe(true)
    expect(callbacks.onFail).toHaveBeenCalledOnce()
    flush()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    renderer.render.mockClear()
    scene.update(state())
    flush()
    expect(renderer.render).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    flush()
    expect(renderer.render).toHaveBeenCalled()
  })

  it('ignores a zero-sized host and hangs edge readouts inside the open panel', () => {
    const { scene, renderer, refs } = setup({ width: 0, height: 0 })
    expect(renderer.setSize).not.toHaveBeenCalled()
    flush()
    const wide = setup({ width: 1200, height: 800 })
    wide.scene.update(state({ selected: 'left', zones: 'always' }))
    flush()
    const zone = wide.refs.zones.left[0]?.style.transform ?? ''
    const x = Number(/translate3d\(([-\d.]+)px/.exec(zone)?.[1])
    expect(x).toBeLessThanOrEqual(1200 - SCENE.panelReserve)
    expect(zone).toContain('calc(-100% - 6px)')
    expect(refs.side.left?.style.transform ?? '').toBe('')
    scene.dispose()
  })

  it('releases GPU resources, listeners and the canvas on dispose', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { scene, canvas, host, renderer, callbacks, three, screen } = setup()
    scene.update(state({ autoReturn: true }))
    flush()
    const disposals: ReturnType<typeof vi.spyOn>[] = []
    three().traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      disposals.push(vi.spyOn(node.geometry, 'dispose'))
      for (const material of [node.material].flat()) disposals.push(vi.spyOn(material, 'dispose'))
    })
    const left = screen(0, 0.77, SCENE.sideZ)
    scene.update(state({ autoReturn: true }))
    scene.dispose()
    expect(t.frames.size).toBe(0)
    expect(host.contains(canvas)).toBe(false)
    expect(renderer.dispose).toHaveBeenCalledOnce()
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce()
    expect(t.observers[0].disconnect).toHaveBeenCalledOnce()
    expect(t.reduced.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    disposals.forEach(fn => expect(fn).toHaveBeenCalled())
    fire(canvas, 'pointermove', left)
    expect(callbacks.onHover).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CAMERA.autoReturnMs)
    t.resize?.()
    expect(t.frames.size).toBe(0)
  })
})
