'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { BASE_SIDES } from '@/src/hardware/base/types'
import { SIDE_Z, createBedModel } from './bedModel3D'
import type { BedRendererProps } from './BedView'
import type { Three } from './loadThree'

export const CAMERA = { fov: 30, radius: 8.4, height: 3.4, lookY: 0.2, azimuth: 0.62, maxAzimuth: 1.5, dragRate: 0.008 }
const DARK = { card: '#0f0f11', floor: '#17171a' }
export const clampAzimuth = (value: number) => Math.max(-CAMERA.maxAzimuth, Math.min(CAMERA.maxAzimuth, value))

interface Props extends BedRendererProps {
  three: Three
  onReady: () => void
  onFail: () => void
}

function mountBed(THREE: Three, host: HTMLDivElement, sides: readonly ('left' | 'right')[], focusZ: number, onReady: () => void, onFail: () => void) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' })
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(DARK.card)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.25
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  const background = new THREE.Color(DARK.card)
  const fog = new THREE.Fog(DARK.card, 9, 17)
  scene.background = background
  scene.fog = fog
  const floorGeometry = new THREE.PlaneGeometry(40, 40)
  const floorMaterial = new THREE.MeshStandardMaterial({ color: DARK.floor, roughness: 0.92 })
  const floor = new THREE.Mesh(floorGeometry, floorMaterial)
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.61
  floor.receiveShadow = true
  scene.add(floor)

  scene.add(new THREE.HemisphereLight('#ffffff', '#202024', 1.3))
  const key = new THREE.DirectionalLight('#fff6ec', 2.6)
  key.position.set(2.5, 6.5, 4.5)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 20 })
  key.shadow.camera.updateProjectionMatrix()
  key.shadow.bias = -0.0004
  scene.add(key)
  const rim = new THREE.DirectionalLight('#ffffff', 1.5)
  rim.position.set(-3.5, 3.5, -5)
  scene.add(rim)
  const fill = new THREE.DirectionalLight('#bfd4ff', 0.45)
  fill.position.set(-4, 2, 4)
  scene.add(fill)

  const model = createBedModel(THREE, sides)
  scene.add(model.root)

  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 600 / 330, 0.1, 40)
  let azimuth = CAMERA.azimuth
  const place = () => {
    camera.position.set(CAMERA.radius * Math.cos(azimuth), CAMERA.height, focusZ + CAMERA.radius * Math.sin(azimuth))
    camera.lookAt(0, CAMERA.lookY, focusZ)
  }
  place()

  let frame = 0
  let ready = false
  const render = () => {
    frame = 0
    if (document.hidden) return
    renderer.render(scene, camera)
    if (!ready) {
      ready = true
      onReady()
    }
  }
  // Render on demand only; motion arrives as new props each animation frame.
  const requestRender = () => {
    if (!frame) frame = requestAnimationFrame(render)
  }

  const resize = () => {
    const { width, height } = host.getBoundingClientRect()
    if (!width || !height) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    requestRender()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)

  let drag: { id: number, x: number } | null = null
  const down = (event: PointerEvent) => {
    drag = { id: event.pointerId, x: event.clientX }
    canvas.setPointerCapture?.(event.pointerId)
    canvas.style.cursor = 'grabbing'
  }
  const move = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return
    azimuth = clampAzimuth(azimuth - (event.clientX - drag.x) * CAMERA.dragRate)
    drag.x = event.clientX
    place()
    requestRender()
  }
  const up = (event: PointerEvent) => {
    if (drag?.id !== event.pointerId) return
    drag = null
    canvas.style.cursor = 'grab'
  }
  const lost = (event: Event) => {
    event.preventDefault()
    onFail()
  }
  const visibility = () => {
    if (!document.hidden) requestRender()
  }
  // Fade the floor into whichever card surface the theme draws.
  const applyTheme = () => {
    const css = getComputedStyle(host)
    const card = css.getPropertyValue('--surface-card').trim() || DARK.card
    background.set(card)
    fog.color.set(card)
    renderer.setClearColor(card)
    floorMaterial.color.set(css.getPropertyValue('--surface-active').trim() || DARK.floor)
    requestRender()
  }
  const theme = new MutationObserver(applyTheme)
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
  applyTheme()
  canvas.style.cursor = 'grab'
  canvas.style.touchAction = 'none'
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)
  canvas.addEventListener('webglcontextlost', lost)
  document.addEventListener('visibilitychange', visibility)
  host.appendChild(canvas)
  resize()

  return {
    update(props: BedRendererProps) {
      const states = Object.fromEntries(BASE_SIDES.map(side => [side, {
        pose: props[side],
        target: props[side === 'left' ? 'leftTarget' : 'rightTarget'],
        moving: !!props.moving[side],
      }]))
      if (model.update(states, props.bedModel)) requestRender()
    },
    dispose() {
      cancelAnimationFrame(frame)
      observer.disconnect()
      theme.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('webglcontextlost', lost)
      model.dispose()
      floorGeometry.dispose()
      floorMaterial.dispose()
      renderer.dispose()
      // Release the context now; phones cap how many can be open at once.
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}

/** three.js bed. Decorative: the legend in BedView is the accessible readout. */
export default function BedView3D({ three, onReady, onFail, ...view }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const bed = useRef<ReturnType<typeof mountBed> | null>(null)
  const callbacks = useRef({ onReady, onFail })
  useEffect(() => {
    callbacks.current = { onReady, onFail }
  })
  const sidesKey = view.single ?? 'both'

  useLayoutEffect(() => {
    if (!host.current) return
    const sides = view.single ? [view.single] : BASE_SIDES
    try {
      bed.current = mountBed(three, host.current, sides, view.single ? SIDE_Z[view.single] : 0, () => callbacks.current.onReady(), () => callbacks.current.onFail())
    }
    catch {
      callbacks.current.onFail()
      return
    }
    return () => {
      bed.current?.dispose()
      bed.current = null
    }
    // Only a new library or side set needs a new scene; poses flow through update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [three, sidesKey])

  useLayoutEffect(() => {
    bed.current?.update(view)
  })

  return <div ref={host} aria-hidden="true" data-testid="bed-view-3d" className="absolute inset-0" />
}
