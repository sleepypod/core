import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Three } from '@/src/components/Base/loadThree'
import { mountThermalScene } from '../thermalScene'
import { thermalColor } from '../thermalData'

class Observer {
  observe() {}
  disconnect() {}
}
afterEach(() => vi.unstubAllGlobals())

interface HeatUniforms { zoneColors: { value: THREE.Color[] }, time: { value: number }, direction: { value: number }, strength: { value: number }, selected: { value: number } }
const heat = (materials: THREE.MeshPhysicalMaterial[]) => materials.filter(m => m.userData.uniforms).map(m => m.userData.uniforms as HeatUniforms)

describe('six measured regions in 3D', () => {
  it('paints each side from its three readings, grays missing regions and disposes annotations', () => {
    vi.stubGlobal('ResizeObserver', Observer)
    vi.stubGlobal('IntersectionObserver', Observer)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    const materials: THREE.MeshPhysicalMaterial[] = []
    const library = {
      ...THREE,
      MeshPhysicalMaterial: class extends THREE.MeshPhysicalMaterial {
        constructor(params: THREE.MeshPhysicalMaterialParameters) {
          super(params)
          materials.push(this)
        }
      },
      WebGLRenderer: class {
        domElement = document.createElement('canvas')
        setPixelRatio() {}
        setClearColor() {}
        setSize() {}
        dispose() {}
        forceContextLoss() {}
      },
      // No GL in jsdom: the studio environment prefilter is skipped.
      PMREMGenerator: class {
        fromScene() {
          return { texture: null, dispose() {} }
        }

        dispose() {}
      },
    } as unknown as Three
    const host = document.createElement('div')
    const scene = mountThermalScene(library, host, vi.fn())
    const left = { zones: [20, null, 24] as [number, null, number], direction: -1 as const, strength: 1, mode: 'cooling' as const, targetF: 70, currentF: 80 }
    const right = { zones: [30, 32, 34] as [number, number, number], direction: 1 as const, strength: 1, mode: 'heating' as const, targetF: 90, currentF: 80 }
    scene.update({ left, right }, null, 'F')
    // Region callouts only; the status pills belong to the overview.
    expect(host.querySelectorAll('[data-thermal-pill]')).toHaveLength(0)
    // The heat field lives in the mattress top material, one per side.
    const sides = heat(materials)
    expect(sides).toHaveLength(2)
    const zoneColors = () => sides.flatMap(u => u.zoneColors.value.map(c => c.getHexString()))
    expect(zoneColors()).toEqual([20, null, 24, 30, 32, 34].map(v => new THREE.Color(thermalColor(v)).getHexString()))
    expect(sides.map(u => u.direction.value)).toEqual([-1, 1])
    scene.update({ left: { ...left, zones: [null, null, null] }, right }, null, 'F')
    expect(sides[0].strength.value).toBe(0)
    expect(sides[0].direction.value).toBe(0)
    scene.update({ left, right }, null, 'F')
    expect(host.querySelector('[data-thermal-region="left-outer"]')?.textContent).toBe('L outer68.0°')
    expect(host.querySelector('[data-thermal-region="left-center"]')?.textContent).toBe('L center--')
    scene.update({ left, right }, 'left', 'C')
    expect(host.querySelector('[data-thermal-region="right-inner"]')?.textContent).toBe('R inner34.0°')
    expect(sides.map(u => u.selected.value)).toEqual([1, 0])
    const dispose = materials.map(m => vi.spyOn(m, 'dispose'))
    scene.dispose()
    expect(host.childElementCount).toBe(0)
    dispose.forEach(fn => expect(fn).toHaveBeenCalledOnce())
    materials.length = 0
    const overview = mountThermalScene(library, host, vi.fn(), 'overview')
    overview.update({ left, right }, null, 'C')
    const means = heat(materials)
    expect(means).toHaveLength(2)
    // The overview paints each side's mean into all three zones.
    expect(means.map(u => new Set(u.zoneColors.value.map(c => c.getHexString())).size)).toEqual([1, 1])
    expect(means.map(u => u.zoneColors.value[0].getHexString())).toEqual([22, 32].map(v => new THREE.Color(thermalColor(v)).getHexString()))
    expect(host.querySelectorAll('[data-thermal-region]')).toHaveLength(0)
    // One status pill per side: surface mean, setpoint and the pod's mode for the ring.
    const pill = (side: string) => host.querySelector<HTMLElement>(`[data-thermal-pill="${side}"]`)
    expect(pill('left')?.dataset.mode).toBe('cooling')
    expect(pill('left')?.title).toBe('Cooling')
    expect(pill('left')?.textContent).toBe('22°→ 21°')
    expect(pill('right')?.textContent).toBe('32°→ 32°')
    overview.update({ left: { ...left, zones: [null, null, null], mode: 'off', targetF: null }, right }, 'right', 'F')
    expect(pill('left')?.dataset.mode).toBe('off')
    expect(pill('left')?.textContent).toBe('--')
    expect(pill('left')?.style.opacity).toBe('0.45')
    expect(pill('right')?.style.opacity).toBe('1')
    overview.dispose()
    expect(host.childElementCount).toBe(0)
  })
})

describe('thermal scene lifecycle', () => {
  it('sizes, animates while driving, relights for the theme and pauses off screen', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let next = 1
    let now = 0
    const flush = (limit = 5) => {
      for (let i = 0; i < limit && frames.size; i++) {
        const [[id, callback]] = frames
        frames.delete(id)
        callback(now += 100)
      }
    }
    let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {}
    const reduced = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('ResizeObserver', Observer)
    vi.stubGlobal('IntersectionObserver', class extends Observer {
      constructor(callback: typeof intersect) {
        super()
        intersect = callback
      }
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(next, callback)
      return next++
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)))
    vi.stubGlobal('matchMedia', (query: string) => query.includes('reduced-motion') ? reduced : { matches: false })
    const materials: THREE.MeshPhysicalMaterial[] = []
    const renderer = { render: vi.fn(), setSize: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn() }
    const environments: { dispose: ReturnType<typeof vi.fn> }[] = []
    const library = {
      ...THREE,
      MeshPhysicalMaterial: class extends THREE.MeshPhysicalMaterial {
        constructor(params: THREE.MeshPhysicalMaterialParameters) {
          super(params)
          materials.push(this)
        }
      },
      WebGLRenderer: class {
        domElement = document.createElement('canvas')
        render = renderer.render
        setSize = renderer.setSize
        dispose = renderer.dispose
        forceContextLoss = renderer.forceContextLoss
        setPixelRatio() {}
        setClearColor() {}
      },
      PMREMGenerator: class {
        fromScene() {
          const environment = { texture: new THREE.Texture(), dispose: vi.fn() }
          environments.push(environment)
          return environment
        }

        dispose() {}
      },
    } as unknown as Three
    const host = document.createElement('div')
    host.getBoundingClientRect = () => ({ width: 400, height: 400 }) as DOMRect
    const onFail = vi.fn()
    const scene = mountThermalScene(library, host, onFail)
    const canvas = host.querySelector('canvas') as HTMLCanvasElement
    // A narrow host drops the zone names and widens the lens.
    expect(renderer.setSize).toHaveBeenCalledWith(400, 400, false)
    const camera = () => renderer.render.mock.lastCall?.[1] as THREE.PerspectiveCamera
    flush()
    expect(camera().fov).toBe(30)
    expect(host.querySelector<HTMLElement>('[data-thermal-region="left-outer"] span')?.style.display).toBe('none')
    const left = { zones: [20, 22, 24] as [number, number, number], direction: -1 as const, strength: 1, mode: 'cooling' as const, targetF: 70, currentF: 80 }
    const right = { zones: [30, 32, 34] as [number, number, number], direction: 0 as const, strength: 0, mode: 'off' as const, targetF: null, currentF: 80 }
    scene.update({ left, right }, 'right', 'F')
    flush()
    const label = host.querySelector<HTMLElement>('[data-thermal-region="left-outer"]') as HTMLElement
    expect((label.previousElementSibling?.previousElementSibling as HTMLElement).style.opacity).toBe('0.5')
    expect(label.style.left).toMatch(/px$/)
    // A driving side keeps animating; the heat time advances with the clock.
    const sides = heat(materials)
    expect(frames.size).toBe(1)
    flush(1)
    expect(sides[0].time.value).toBeCloseTo(now / 1000)
    expect(frames.size).toBe(1)
    // Reduced motion freezes the bands and stops the loop.
    reduced.matches = true
    flush(1)
    expect(sides[0].time.value).toBe(0)
    expect(frames.size).toBe(0)
    reduced.matches = false
    // The shader is patched to carry the heat field.
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' }
    const cover = materials.find(m => m.userData.uniforms) as THREE.MeshPhysicalMaterial
    cover.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer)
    expect(shader.uniforms.zoneColors).toBe(cover.userData.uniforms.zoneColors)
    expect(shader.vertexShader).toContain('vHeatPos = (modelMatrix')
    expect(shader.fragmentShader).toContain('uniform vec3 zoneColors[3]')
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mix(shown, cover')
    expect(cover.customProgramCacheKey()).toBe('thermal-cover')
    // Theme flip: a new studio, light-theme ramp and re-applied readings.
    document.documentElement.dataset.theme = 'light'
    await Promise.resolve()
    expect(environments[0].dispose).toHaveBeenCalledOnce()
    expect(environments).toHaveLength(2)
    expect(sides[1].zoneColors.value[0].getHexString()).toBe(new THREE.Color(thermalColor(30, 'light')).getHexString())
    flush(1)
    expect(label.style.cssText).toContain('color: rgb(26, 26, 28)')
    // Off screen nothing renders until it scrolls back.
    renderer.render.mockClear()
    intersect([{ isIntersecting: false }])
    flush()
    expect(renderer.render).not.toHaveBeenCalled()
    intersect([{ isIntersecting: true }])
    flush(1)
    expect(renderer.render).toHaveBeenCalledOnce()
    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)
    expect(lost.defaultPrevented).toBe(true)
    expect(onFail).toHaveBeenCalledOnce()
    scene.dispose()
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce()
    expect(reduced.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    expect(frames.size).toBe(0)
    delete document.documentElement.dataset.theme
  })
})
