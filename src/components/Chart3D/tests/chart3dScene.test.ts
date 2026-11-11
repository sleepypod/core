import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Three } from '@/src/components/Base/loadThree'
import { easeOutCubic, mountChart3DScene, resample, sweepWeight, wave } from '../chart3dScene'
import type { Chart3DData, Chart3DSpec } from '../chart3dScene'

const t = vi.hoisted(() => ({
  now: 0,
  frame: null as FrameRequestCallback | null,
  resize: null as (() => void) | null,
  intersect: null as ((entries: Array<{ isIntersecting: boolean }>) => void) | null,
  reduced: false,
  render: vi.fn(),
  setSize: vi.fn(),
}))

class Resize {
  constructor(cb: () => void) {
    t.resize = cb
  }

  observe() {}
  disconnect() {}
}
class Intersect {
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    t.intersect = cb
  }

  observe() {}
  disconnect() {}
}

const library = {
  ...THREE,
  WebGLRenderer: class {
    domElement = document.createElement('canvas')
    setPixelRatio() {}
    setClearColor() {}
    setSize = t.setSize
    render = t.render
    dispose() {}
    forceContextLoss() {}
  },
} as unknown as Three

const resolve = (css: string) => (css.includes('cool') ? 'rgb(0,0,255)' : css.includes('warm') ? 'rgb(255,0,0)' : 'rgb(128,128,128)')

/** Run the pending animation frame at `time` ms. */
function flush(time: number) {
  t.now = time
  const cb = t.frame
  t.frame = null
  cb?.(time)
}

function host() {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: 400 })
  Object.defineProperty(el, 'clientHeight', { value: 150 })
  document.body.appendChild(el)
  return el
}

const sceneOf = () => t.render.mock.lastCall?.[0] as THREE.Scene
const meshes = () => sceneOf().children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh) && (o.geometry.getAttribute('color')?.itemSize === 4))
const bars = () => sceneOf().children.find((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh)
const sprites = () => sceneOf().children.filter((o): o is THREE.Sprite => o instanceof THREE.Sprite)
const yAt = (mesh: THREE.Mesh, i: number, per: number) => mesh.geometry.getAttribute('position').getY(i * per)
const alphaAt = (mesh: THREE.Mesh, i: number, per: number) => (mesh.geometry.getAttribute('color') as THREE.BufferAttribute).getW(i * per)

beforeEach(() => {
  Object.assign(t, { now: 0, frame: null, reduced: false })
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', Resize)
  vi.stubGlobal('IntersectionObserver', Intersect)
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
    t.frame = cb
    return 1
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('matchMedia', () => ({ get matches() {
    return t.reduced
  }, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(performance, 'now').mockImplementation(() => t.now)
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '', fillStyle: '', textBaseline: '', measureText: (s: string) => ({ width: s.length * 20 }), fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('loading wave and sweep helpers', () => {
  it('waves low and grey, sweeps left to right, and resamples with gaps', () => {
    expect(wave(0, 10, 0)).toBeCloseTo(0.1)
    for (let i = 0; i < 20; i++) expect(Math.abs(wave(i, 20, 1.3, 2) - 0.1)).toBeLessThanOrEqual(0.06 + 1e-9)
    expect(easeOutCubic(-1)).toBe(0)
    expect(easeOutCubic(2)).toBe(1)
    // At the start nothing has moved; mid-sweep the left leads the right; at the end all have landed.
    expect(sweepWeight(0, 0, 10)).toBe(0)
    expect(sweepWeight(0.5, 0, 10)).toBeGreaterThan(sweepWeight(0.5, 9, 10))
    expect(sweepWeight(1, 9, 10)).toBe(1)
    expect(resample([], 3)).toEqual([null, null, null])
    expect(resample([{ x: 0, y: 0 }, { x: 1, y: 1 }], 3)).toEqual([0, 0.5, 1])
    // Outside the series and across a null neighbour are gaps; a sample on a point keeps it.
    expect(resample([{ x: 0.25, y: 1 }, { x: 0.5, y: null }, { x: 0.75, y: 0.5 }], 5)).toEqual([null, 1, null, 0.5, null])
    expect(resample([{ x: 0, y: 0.4 }], 1)).toEqual([0.4])
  })
})

describe('chart scene', () => {
  const spec: Chart3DSpec = {
    series: [{ kind: 'ribbon', label: 'L' }, { kind: 'line', lane: 0, dashed: true }, { kind: 'bars', lane: 1 }],
    reserve: { yTicks: true, values: true, now: true },
    samples: 11,
    skeletonBars: 4,
  }
  const data: Chart3DData = {
    series: [
      { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: 'var(--accent-cool)', value: '1.0°', stops: [{ x: 0, color: 'var(--accent-cool)' }, { x: 1, color: 'var(--accent-warm)' }] },
      { points: [{ x: 0, y: 0.5 }, { x: 0.4, y: 0.5 }, { x: 0.5, y: null }, { x: 1, y: 0.5 }], color: 'var(--text-2)' },
      { points: [{ x: 0.25, y: 0.2 }, { x: 0.75, y: 0.8 }], color: 'var(--accent-warm)', value: '8/hr' },
    ],
    xTicks: [{ x: 0, label: '10 PM' }, { x: 0.05, label: '10:05 PM' }, { x: 1, label: '6 AM' }],
    yTicks: [{ y: 0.5, label: '70°' }],
    now: { x: 0.5, label: 'NOW 2:00' },
  }

  it('waves while loading, sweeps into the data, then tweens a refresh', async () => {
    const onFail = vi.fn()
    const el = host()
    const scene = mountChart3DScene(library, el, spec, resolve, onFail)
    await Promise.resolve()
    scene.setState('loading')
    flush(100)
    expect(t.setSize).toHaveBeenCalledWith(400, 150, false)
    const [ribbon, line] = meshes()
    // The wave sits low and the skeleton is half-transparent grey.
    // The wave stays within 0.04..0.16 of the 2-unit chart height.
    expect(yAt(ribbon, 5, 4)).toBeGreaterThanOrEqual(0.04 * 2)
    expect(yAt(ribbon, 5, 4)).toBeLessThanOrEqual(0.16 * 2)
    expect(alphaAt(ribbon, 5, 4)).toBeCloseTo(0.5)
    expect(bars()?.count).toBe(4)
    // Loading keeps animating.
    expect(t.frame).not.toBeNull()

    t.now = 1000
    scene.setData(data)
    flush(1000 + 650)
    // Mid-sweep the left has landed further than the right.
    const mid = yAt(ribbon, 0, 4)
    expect(mid).toBeLessThan(0.2)
    flush(1000 + 1400)
    // Settled: the ribbon is the data, the gap in the line is transparent, the bars match the points.
    expect(yAt(ribbon, 10, 4)).toBeCloseTo(2)
    expect(yAt(ribbon, 0, 4)).toBeCloseTo(0)
    expect(alphaAt(line, 5, 2)).toBe(0)
    expect(bars()?.count).toBe(2)
    // Stops tint the ribbon cool at the left and warm at the right.
    const col = ribbon.geometry.getAttribute('color') as THREE.BufferAttribute
    expect(col.getZ(0)).toBeGreaterThan(col.getX(0))
    expect(col.getX(40)).toBeGreaterThan(col.getZ(40))
    // Settled charts stop requesting frames.
    expect(t.frame).toBeNull()
    // Value labels, NOW label, lane label, ticks; the crowded 10:05 tick is dropped.
    const texts = sprites()
    expect(texts.length).toBeGreaterThanOrEqual(8)
    expect(texts.filter(s => !s.visible)).toHaveLength(1)

    // A background refresh tweens from what is on screen instead of replaying the sweep.
    t.now = 5000
    scene.setData({ ...data, series: [{ ...data.series[0], points: [{ x: 0, y: 1 }, { x: 1, y: 1 }], value: '2.0°' }, data.series[1], data.series[2]] })
    flush(5000 + 300)
    const between = yAt(ribbon, 0, 4)
    expect(between).toBeGreaterThan(0.1)
    expect(between).toBeLessThan(1.9)
    flush(5000 + 700)
    expect(yAt(ribbon, 0, 4)).toBeCloseTo(2)

    // A different bar count replays the sweep instead.
    t.now = 8000
    scene.setData({ ...data, series: [data.series[0], data.series[1], { ...data.series[2], points: [{ x: 0.5, y: 1 }] }] })
    flush(8000 + 1400)
    expect(bars()?.count).toBe(1)

    scene.recolor()
    flush(9500)
    scene.dispose()
    expect(el.querySelector('canvas')).toBeNull()
    expect(onFail).not.toHaveBeenCalled()
  })

  it('draws an empty baseline, freezes a dimmed wave on error and skips work off-screen', async () => {
    const el = host()
    const scene = mountChart3DScene(library, el, { series: [{ kind: 'ribbon' }, { kind: 'bars' }] }, resolve, vi.fn())
    await Promise.resolve()
    scene.setState('empty')
    flush(1500)
    const [ribbon] = meshes()
    expect(yAt(ribbon, 60, 4)).toBeLessThan(0.02)
    scene.setState('empty')
    scene.setState('error')
    flush(1600)
    // The skeleton's 0.5 alpha, dimmed to 45%.
    expect(alphaAt(ribbon, 3, 4)).toBeCloseTo(0.225)
    // Frozen: no further frames.
    expect(t.frame).toBeNull()
    const renders = t.render.mock.calls.length
    t.intersect?.([{ isIntersecting: false }])
    flush(1700)
    expect(t.render.mock.calls.length).toBe(renders)
    t.intersect?.([{ isIntersecting: true }])
    t.resize?.()
    flush(1800)
    expect(t.render.mock.calls.length).toBe(renders + 1)
    scene.dispose()
  })

  it('lands the data at once with reduced motion and reports a lost context', async () => {
    t.reduced = true
    const onFail = vi.fn()
    const el = host()
    const scene = mountChart3DScene(library, el, { series: [{ kind: 'ribbon' }] }, resolve, onFail)
    await Promise.resolve()
    scene.setData({ series: [{ points: [{ x: 0, y: 1 }, { x: 1, y: 1 }], color: 'var(--accent-cool)' }] })
    flush(10)
    expect(yAt(meshes()[0], 50, 4)).toBeCloseTo(2)
    el.querySelector('canvas')?.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(onFail).toHaveBeenCalledOnce()
    scene.dispose()
  })

  it('orbits on drag, turns only on touch, and resets on double-click', async () => {
    const el = host()
    const scene = mountChart3DScene(library, el, { series: [{ kind: 'ribbon' }] }, resolve, vi.fn())
    await Promise.resolve()
    scene.setState('loading')
    flush(0)
    const canvas = el.querySelector('canvas') as HTMLCanvasElement
    const camera = () => t.render.mock.lastCall?.[1] as THREE.PerspectiveCamera
    const pointer = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
      const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0 })
      for (const [k, v] of Object.entries(extra)) Object.defineProperty(e, k, { value: v })
      canvas.dispatchEvent(e)
    }
    const home = camera().position.clone()
    // Moves without a press, and other buttons, do nothing.
    pointer('pointermove', 50, 50)
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 2 }))
    pointer('pointermove', 80, 50)
    flush(16)
    expect(camera().position.distanceTo(home)).toBeLessThan(1e-6)
    expect(canvas.style.cursor).toBe('grab')

    pointer('pointerdown', 100, 100, { pointerId: 1, pointerType: 'mouse' })
    expect(canvas.style.cursor).toBe('grabbing')
    pointer('pointermove', 40, 140, { pointerId: 1 })
    pointer('pointermove', 0, 0, { pointerId: 2 })
    flush(32)
    const turned = camera().position.clone()
    expect(turned.distanceTo(home)).toBeGreaterThan(0.1)
    pointer('pointerup', 40, 140, { pointerId: 2 })
    pointer('pointerup', 40, 140, { pointerId: 1 })
    expect(canvas.style.cursor).toBe('grab')

    canvas.dispatchEvent(new MouseEvent('dblclick'))
    flush(48)
    expect(camera().position.distanceTo(home)).toBeLessThan(1e-6)

    // Touch: a vertical drag leaves the tilt alone (the page scrolls instead).
    pointer('pointerdown', 100, 100, { pointerId: 3, pointerType: 'touch' })
    pointer('pointermove', 100, 20, { pointerId: 3 })
    pointer('pointercancel', 100, 20, { pointerId: 3 })
    flush(64)
    expect(camera().position.distanceTo(home)).toBeLessThan(1e-6)
    scene.dispose()
  })
})
