// Pieces every three.js chart shares: fixed-pixel-size text labels, the camera fit
// that fills the box less its label margins, and drag-to-orbit.

import type * as T from 'three'
import type { Three } from '@/src/components/Base/loadThree'

/** CSS colour expression → a colour three.js and canvas 2D can parse. */
export type ColorResolver = (css: string) => string

export type LabelAlign = 'left' | 'right' | 'center' | 'below'

export interface Label {
  sprite: T.Sprite
  material: T.SpriteMaterial
  text: string
  css: string
  /** On-screen text height in CSS px. */
  px: number
  aspect: number
}

/**
 * Canvas-texture sprite labels sized every frame to a fixed on-screen height. Text
 * draws once the page fonts are ready; until then the sprites stay hidden.
 */
export function createLabels(THREE: Three, scene: T.Scene, host: HTMLElement, camera: T.PerspectiveCamera, resolve: ColorResolver, onReady: () => void) {
  const labels = new Set<Label>()
  let ready = false
  let disposed = false
  let fontFamily = getComputedStyle(host).getPropertyValue('--font-mono').trim() || 'monospace'
  const tmp = new THREE.Vector3()

  const draw = (label: Label) => {
    const fontPx = 40
    const font = `500 ${fontPx}px ${fontFamily}`
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')
    if (ctx) ctx.font = font
    c.width = Math.max(2, Math.ceil((ctx?.measureText(label.text).width ?? fontPx * label.text.length * 0.6) + 8))
    c.height = Math.ceil(fontPx * 1.3)
    if (ctx) {
      ctx.font = font
      ctx.fillStyle = resolve(label.css)
      ctx.textBaseline = 'middle'
      ctx.fillText(label.text, 4, c.height / 2)
    }
    label.material.map?.dispose()
    const texture = new THREE.CanvasTexture(c)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 2
    label.material.map = texture
    label.material.needsUpdate = true
    label.aspect = c.width / c.height
  }

  void document.fonts.ready.then(() => {
    if (disposed) return
    ready = true
    fontFamily = getComputedStyle(host).getPropertyValue('--font-mono').trim() || fontFamily
    for (const label of labels) {
      draw(label)
      label.sprite.visible = true
    }
    onReady()
  })

  return {
    get ready() {
      return ready
    },
    make(text: string, css: string, px: number, align: LabelAlign): Label {
      const material = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false })
      const sprite = new THREE.Sprite(material)
      sprite.renderOrder = 100
      sprite.center.set(align === 'left' ? 0 : align === 'right' ? 1 : 0.5, align === 'below' ? 0.9 : 0.5)
      const label: Label = { sprite, material, text, css, px, aspect: 1 }
      if (ready) draw(label)
      else sprite.visible = false
      labels.add(label)
      scene.add(sprite)
      return label
    },
    drop(label: Label | null) {
      if (!label) return
      scene.remove(label.sprite)
      label.material.map?.dispose()
      label.material.dispose()
      labels.delete(label)
    },
    setText(label: Label, text: string) {
      if (label.text === text) return
      label.text = text
      if (ready) draw(label)
    },
    redraw() {
      if (ready) for (const label of labels) draw(label)
    },
    /** Scale every sprite so its text is `px` tall on screen at its depth. */
    size() {
      const h = host.clientHeight || 1
      const tan = Math.tan((camera.fov * Math.PI) / 360)
      for (const label of labels) {
        label.sprite.getWorldPosition(tmp)
        const depth = Math.max(0.1, -tmp.applyMatrix4(camera.matrixWorldInverse).z)
        const height = label.px * ((2 * depth * tan) / h)
        label.sprite.scale.set(height * label.aspect, height, 1)
      }
    },
    /** Text width in CSS px at `px`, for reserving margins before the labels exist. */
    width(text: string, px: number) {
      const ctx = document.createElement('canvas').getContext('2d')
      if (!ctx) return text.length * px * 0.62
      ctx.font = `500 ${px}px ${fontFamily}`
      return ctx.measureText(text).width
    },
    dispose() {
      disposed = true
      for (const label of [...labels]) this.drop(label)
    },
  }
}

export type Labels = ReturnType<typeof createLabels>

export interface Margins { left: number, right: number, top: number, bottom: number }

/**
 * Size the renderer to the host, then pull the camera back along `direction` until
 * the projected `corners` fit inside the box less `margins` (CSS px), centred there
 * with a view offset. Returns false while the host has no size.
 */
export function fitCamera(renderer: T.WebGLRenderer, camera: T.PerspectiveCamera, host: HTMLElement, corners: T.Vector3[], target: T.Vector3, direction: T.Vector3, m: Margins) {
  const w = host.clientWidth
  const h = host.clientHeight
  if (!w || !h) return false
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.clearViewOffset()
  camera.updateProjectionMatrix()
  const q = target.clone()
  const spans = (distance: number) => {
    camera.position.copy(target).addScaledVector(direction, distance)
    camera.lookAt(target)
    camera.updateMatrixWorld()
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of corners) {
      q.copy(p).project(camera)
      minX = Math.min(minX, q.x)
      maxX = Math.max(maxX, q.x)
      minY = Math.min(minY, q.y)
      maxY = Math.max(maxY, q.y)
    }
    return { minX, maxX, minY, maxY }
  }
  const roomX = (2 * Math.max(20, w - m.left - m.right)) / w
  const roomY = (2 * Math.max(20, h - m.top - m.bottom)) / h
  let lo = 4
  let hi = 400
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2
    const s = spans(mid)
    if (s.maxX - s.minX > roomX || s.maxY - s.minY > roomY) lo = mid
    else hi = mid
  }
  const s = spans(hi)
  const cx = (s.minX + s.maxX) / 2 - (m.left - m.right) / w
  const cy = (s.minY + s.maxY) / 2 - (m.bottom - m.top) / h
  camera.setViewOffset(w, h, (cx * w) / 2, (-cy * h) / 2, w, h)
  camera.updateProjectionMatrix()
  return true
}

/** Camera direction for an orbit: yaw turns around the vertical axis, pitch raises it. */
export function orbitDirection(THREE: Three, yaw: number, pitch: number) {
  return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
}

export const ORBIT = {
  /** Radians per CSS px of drag. */
  rate: 0.008,
  yaw: [-1.1, 1.1] as const,
  pitch: [0.06, 1.25] as const,
} as const

/**
 * Drag to orbit: mouse and pen turn and tilt; touch turns only, so a vertical swipe
 * still scrolls the page. Double-click resets. Returns a detach function.
 */
export function attachOrbit(canvas: HTMLCanvasElement, home: { yaw: number, pitch: number }, onChange: (yaw: number, pitch: number) => void) {
  let yaw = home.yaw
  let pitch = home.pitch
  let drag: { id: number, x: number, y: number, touch: boolean } | null = null
  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v))
  canvas.style.touchAction = 'pan-y'
  canvas.style.cursor = 'grab'
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' }
    canvas.setPointerCapture(e.pointerId)
    canvas.style.cursor = 'grabbing'
  }
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    yaw = clamp(yaw - (e.clientX - drag.x) * ORBIT.rate, ORBIT.yaw)
    if (!drag.touch) pitch = clamp(pitch + (e.clientY - drag.y) * ORBIT.rate, ORBIT.pitch)
    drag.x = e.clientX
    drag.y = e.clientY
    onChange(yaw, pitch)
  }
  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    drag = null
    canvas.style.cursor = 'grab'
  }
  const reset = () => {
    yaw = home.yaw
    pitch = home.pitch
    onChange(yaw, pitch)
  }
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)
  canvas.addEventListener('dblclick', reset)
  return () => {
    canvas.removeEventListener('pointerdown', down)
    canvas.removeEventListener('pointermove', move)
    canvas.removeEventListener('pointerup', up)
    canvas.removeEventListener('pointercancel', up)
    canvas.removeEventListener('dblclick', reset)
  }
}
