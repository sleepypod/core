// Camera orbit for the 3D bed: rotate, tilt and zoom around a fixed target. No pan;
// the bed always stays centred.

import type { BaseScope } from '@/src/hardware/base/types'

const deg = Math.PI / 180
const LOOK_Y = 0.2
// The product shot: foot end, on the left sleeper's side, pulled back far enough
// that the near legs clear the bottom of the frame.
const DEFAULT_HORIZONTAL = 9.2
const DEFAULT_HEIGHT = 3.7
export const ORBIT = {
  azimuth: 0.62,
  elevation: Math.atan2(DEFAULT_HEIGHT - LOOK_Y, DEFAULT_HORIZONTAL),
  distance: Math.hypot(DEFAULT_HORIZONTAL, DEFAULT_HEIGHT - LOOK_Y),
  maxAzimuth: 1.5,
  // Never under the floor, never straight down onto a flat slab.
  minElevation: 8 * deg,
  maxElevation: 65 * deg,
  // Close enough to inspect a hinge (the ends crop); far enough out that fog stays off the bed.
  minDistance: 5.5,
  maxDistance: 12,
  rotateRate: 0.008,
  swingMs: 450,
  tiltRate: 0.006,
  wheelRate: 0.002,
  lookY: LOOK_Y,
} as const

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export interface OrbitState { azimuth: number, elevation: number, distance: number }

/** Each sleeper's default view is from their own side; Both uses the left sleeper's. */
export const homeAzimuth = (focus?: BaseScope) => focus === 'right' ? -ORBIT.azimuth : ORBIT.azimuth

export function createOrbit(home: number = ORBIT.azimuth) {
  const state: OrbitState = { azimuth: home, elevation: ORBIT.elevation, distance: ORBIT.distance }
  return {
    state,
    home,
    /** Drag by pixels; grabbing the bed and pulling down shows more of its top. */
    drag(dx: number, dy: number) {
      state.azimuth = clamp(state.azimuth - dx * ORBIT.rotateRate, -ORBIT.maxAzimuth, ORBIT.maxAzimuth)
      state.elevation = clamp(state.elevation + dy * ORBIT.tiltRate, ORBIT.minElevation, ORBIT.maxElevation)
    },
    /** Scale > 1 moves closer, as when fingers spread. */
    zoom(scale: number) {
      if (scale > 0 && Number.isFinite(scale)) state.distance = clamp(state.distance / scale, ORBIT.minDistance, ORBIT.maxDistance)
    },
    reset() {
      Object.assign(state, { azimuth: this.home, elevation: ORBIT.elevation, distance: ORBIT.distance })
    },
    position(focusZ: number) {
      const ground = state.distance * Math.cos(state.elevation)
      return {
        x: ground * Math.cos(state.azimuth),
        y: ORBIT.lookY + state.distance * Math.sin(state.elevation),
        z: focusZ + ground * Math.sin(state.azimuth),
      }
    },
  }
}

export type Orbit = ReturnType<typeof createOrbit>

const TAP_MS = 250
const TAP_SLOP = 8
const DOUBLE_TAP_MS = 300

interface SafariGestureEvent extends Event { scale: number }

/**
 * Mouse: drag rotates and tilts; ⌘/Ctrl + wheel or a trackpad pinch zooms; plain wheel
 * scrolls the page; double-click resets. Touch: one finger rotates (vertical swipes keep
 * scrolling the page); two fingers tilt and pinch-zoom; double-tap resets.
 */
export function attachOrbitInput(canvas: HTMLElement, orbit: Orbit, onChange: () => void) {
  const pointers = new Map<number, { x: number, y: number, type: string, start: number, moved: boolean, sx: number, sy: number }>()
  let lastTap = 0
  let gestureScale = 1
  const centroid = () => {
    const all = [...pointers.values()]
    return { x: all.reduce((sum, p) => sum + p.x, 0) / all.length, y: all.reduce((sum, p) => sum + p.y, 0) / all.length }
  }
  const spread = () => {
    const [a, b] = [...pointers.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  const cursor = () => {
    canvas.style.cursor = [...pointers.values()].some(p => p.type === 'mouse') ? 'grabbing' : 'grab'
  }

  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, type: event.pointerType, start: event.timeStamp, moved: false })
    canvas.setPointerCapture?.(event.pointerId)
    cursor()
  }
  const move = (event: PointerEvent) => {
    const pointer = pointers.get(event.pointerId)
    if (!pointer) return
    const before = centroid()
    const beforeSpread = pointers.size === 2 ? spread() : 0
    pointer.x = event.clientX
    pointer.y = event.clientY
    if (Math.hypot(pointer.x - pointer.sx, pointer.y - pointer.sy) > TAP_SLOP) pointer.moved = true
    const after = centroid()
    if (pointers.size === 2) {
      orbit.drag(after.x - before.x, after.y - before.y)
      if (beforeSpread > 0) orbit.zoom(spread() / beforeSpread)
    }
    else if (pointers.size === 1) {
      // One finger only rotates; its vertical motion belongs to page scrolling.
      orbit.drag(after.x - before.x, pointer.type === 'mouse' ? after.y - before.y : 0)
    }
    onChange()
  }
  const up = (event: PointerEvent) => {
    const pointer = pointers.get(event.pointerId)
    if (!pointer) return
    pointers.delete(event.pointerId)
    cursor()
    if (event.type !== 'pointerup' || pointer.type === 'mouse' || pointer.moved || pointers.size > 0 || event.timeStamp - pointer.start > TAP_MS) return
    if (event.timeStamp - lastTap < DOUBLE_TAP_MS) {
      lastTap = 0
      orbit.reset()
      onChange()
    }
    else lastTap = event.timeStamp
  }
  const doubleClick = () => {
    orbit.reset()
    onChange()
  }
  const wheel = (event: WheelEvent) => {
    // Browsers report trackpad pinches as ctrl + wheel.
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    orbit.zoom(Math.exp(-event.deltaY * ORBIT.wheelRate))
    onChange()
  }
  // A two-finger gesture is ours: keep the browser from scrolling or zooming the page.
  const touchMove = (event: TouchEvent) => {
    if (event.touches.length > 1 && event.cancelable) event.preventDefault()
  }
  // Safari reports trackpad pinches as gesture events instead.
  const gestureStart = (event: Event) => {
    event.preventDefault()
    gestureScale = 1
  }
  const gestureChange = (event: Event) => {
    event.preventDefault()
    const { scale } = event as SafariGestureEvent
    orbit.zoom(scale / gestureScale)
    gestureScale = scale
    onChange()
  }

  canvas.style.cursor = 'grab'
  // Vertical one-finger swipes scroll the page; everything else reaches the handlers.
  canvas.style.touchAction = 'pan-y'
  const listeners: [string, EventListener, AddEventListenerOptions?][] = [
    ['pointerdown', down as EventListener],
    ['pointermove', move as EventListener],
    ['pointerup', up as EventListener],
    ['pointercancel', up as EventListener],
    ['dblclick', doubleClick],
    ['wheel', wheel as EventListener, { passive: false }],
    ['touchmove', touchMove as EventListener, { passive: false }],
    ['gesturestart', gestureStart],
    ['gesturechange', gestureChange],
  ]
  for (const [type, listener, options] of listeners) canvas.addEventListener(type, listener, options)
  return () => {
    for (const [type, listener] of listeners) canvas.removeEventListener(type, listener)
  }
}
