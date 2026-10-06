import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORBIT, attachOrbitInput, createOrbit, homeAzimuth } from '../bedOrbit'
import type { Orbit } from '../bedOrbit'

const deg = Math.PI / 180
let canvas: HTMLDivElement
let orbit: Orbit
let changed: ReturnType<typeof vi.fn<() => void>>
let detach: () => void

const pointer = (type: string, id: number, x: number, y: number, pointerType = 'touch', time = 0) => {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true })
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType }, timeStamp: { value: time } })
  canvas.dispatchEvent(event)
}
const touchMove = (fingers: number) => {
  const event = new Event('touchmove', { cancelable: true })
  Object.defineProperty(event, 'touches', { value: { length: fingers } })
  canvas.dispatchEvent(event)
  return event.defaultPrevented
}
const wheel = (init: WheelEventInit) => {
  const event = new WheelEvent('wheel', { cancelable: true, ...init })
  canvas.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  canvas = document.createElement('div')
  orbit = createOrbit()
  changed = vi.fn<() => void>()
  detach = attachOrbitInput(canvas, orbit, changed)
})

describe('bed orbit', () => {
  it('starts at the product shot: foot end, 9.2 out and 3.7 up', () => {
    const { x, y, z } = createOrbit().position(0)
    expect(Math.hypot(x, z)).toBeCloseTo(9.2)
    expect(y).toBeCloseTo(3.7)
    expect(Math.atan2(z, x)).toBeCloseTo(0.62)
    expect(createOrbit().position(-0.97).z).toBeCloseTo(z - 0.97)
  })

  it('frames each sleeper from their own side and resets to the current home', () => {
    expect(homeAzimuth()).toBe(ORBIT.azimuth)
    expect(homeAzimuth('both')).toBe(ORBIT.azimuth)
    expect(homeAzimuth('left')).toBe(ORBIT.azimuth)
    expect(homeAzimuth('right')).toBe(-ORBIT.azimuth)
    const o = createOrbit(homeAzimuth('right'))
    expect(o.position(0).z).toBeLessThan(0)
    o.drag(50, 40)
    o.zoom(1.3)
    o.reset()
    expect(o.state).toEqual({ azimuth: -ORBIT.azimuth, elevation: ORBIT.elevation, distance: ORBIT.distance })
    o.home = ORBIT.azimuth
    o.reset()
    expect(o.state.azimuth).toBe(ORBIT.azimuth)
  })

  it('clamps rotation, tilt and zoom so the bed stays in view', () => {
    const o = createOrbit()
    o.drag(-10_000, 10_000)
    expect(o.state.azimuth).toBe(ORBIT.maxAzimuth)
    expect(o.state.elevation).toBeCloseTo(65 * deg)
    o.drag(10_000, -10_000)
    expect(o.state.azimuth).toBe(-ORBIT.maxAzimuth)
    expect(o.state.elevation).toBeCloseTo(8 * deg)
    expect(o.position(0).y).toBeGreaterThan(0.2)
    o.zoom(100)
    expect(o.state.distance).toBe(5.5)
    o.zoom(0.01)
    expect(o.state.distance).toBe(12)
    o.zoom(0)
    o.zoom(Number.NaN)
    expect(o.state.distance).toBe(12)
    o.reset()
    expect(o.state).toEqual({ azimuth: ORBIT.azimuth, elevation: ORBIT.elevation, distance: ORBIT.distance })
  })

  it('rotates and tilts with a mouse drag', () => {
    pointer('pointerdown', 1, 100, 100, 'mouse')
    expect(canvas.style.cursor).toBe('grabbing')
    pointer('pointermove', 1, 90, 120, 'mouse')
    expect(orbit.state.azimuth).toBeCloseTo(ORBIT.azimuth + 10 * ORBIT.rotateRate)
    expect(orbit.state.elevation).toBeCloseTo(ORBIT.elevation + 20 * ORBIT.tiltRate)
    pointer('pointerup', 1, 90, 120, 'mouse')
    expect(canvas.style.cursor).toBe('grab')
    pointer('pointermove', 1, 0, 0, 'mouse')
    expect(changed).toHaveBeenCalledOnce()
  })

  it('ignores secondary mouse buttons', () => {
    const event = new MouseEvent('pointerdown', { button: 2 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    canvas.dispatchEvent(event)
    pointer('pointermove', 1, 50, 50, 'mouse')
    expect(changed).not.toHaveBeenCalled()
  })

  it('leaves vertical one-finger swipes to page scrolling', () => {
    expect(canvas.style.touchAction).toBe('pan-y')
    pointer('pointerdown', 1, 100, 100)
    pointer('pointermove', 1, 80, 160)
    expect(orbit.state.azimuth).toBeCloseTo(ORBIT.azimuth + 20 * ORBIT.rotateRate)
    expect(orbit.state.elevation).toBe(ORBIT.elevation)
    expect(touchMove(1)).toBe(false)
  })

  it('tilts with a two-finger drag and zooms with a pinch, blocking page gestures', () => {
    pointer('pointerdown', 1, 100, 100)
    pointer('pointerdown', 2, 200, 100)
    expect(touchMove(2)).toBe(true)
    pointer('pointermove', 1, 100, 120)
    expect(orbit.state.elevation).toBeCloseTo(ORBIT.elevation + 10 * ORBIT.tiltRate)
    const before = orbit.state.distance
    pointer('pointermove', 2, 220, 120)
    expect(orbit.state.distance).toBeCloseTo(before * Math.hypot(100, 20) / 120)
  })

  it('zooms with ctrl/⌘ + wheel or Safari pinches, and lets a plain wheel scroll', () => {
    expect(wheel({ deltaY: 100 })).toBe(false)
    expect(orbit.state.distance).toBe(ORBIT.distance)
    expect(wheel({ deltaY: -100, ctrlKey: true })).toBe(true)
    expect(orbit.state.distance).toBeCloseTo(ORBIT.distance / Math.exp(100 * ORBIT.wheelRate))
    wheel({ deltaY: 100, metaKey: true })
    expect(orbit.state.distance).toBeCloseTo(ORBIT.distance)
    canvas.dispatchEvent(new Event('gesturestart', { cancelable: true }))
    const gesture = new Event('gesturechange', { cancelable: true })
    Object.defineProperty(gesture, 'scale', { value: 1.25 })
    canvas.dispatchEvent(gesture)
    expect(gesture.defaultPrevented).toBe(true)
    expect(orbit.state.distance).toBeCloseTo(ORBIT.distance / 1.25)
  })

  it('resets on double-click and on a quick double tap, but not after a drag', () => {
    orbit.drag(100, 50)
    canvas.dispatchEvent(new MouseEvent('dblclick'))
    expect(orbit.state.azimuth).toBe(ORBIT.azimuth)

    orbit.drag(100, 50)
    pointer('pointerdown', 1, 10, 10, 'touch', 0)
    pointer('pointerup', 1, 10, 10, 'touch', 100)
    pointer('pointerdown', 2, 60, 10, 'touch', 150)
    pointer('pointermove', 2, 80, 10, 'touch', 160)
    pointer('pointerup', 2, 80, 10, 'touch', 200)
    expect(orbit.state.azimuth).not.toBe(ORBIT.azimuth)
    pointer('pointerdown', 3, 10, 10, 'touch', 1000)
    pointer('pointerup', 3, 10, 10, 'touch', 1080)
    pointer('pointerdown', 4, 12, 12, 'touch', 1200)
    pointer('pointerup', 4, 12, 12, 'touch', 1260)
    expect(orbit.state.elevation).toBe(ORBIT.elevation)
    expect(orbit.state.distance).toBe(ORBIT.distance)
  })

  it('detaches every listener', () => {
    detach()
    pointer('pointerdown', 1, 0, 0, 'mouse')
    pointer('pointermove', 1, 50, 50, 'mouse')
    canvas.dispatchEvent(new MouseEvent('dblclick'))
    expect(wheel({ deltaY: 10, ctrlKey: true })).toBe(false)
    expect(changed).not.toHaveBeenCalled()
  })
})
