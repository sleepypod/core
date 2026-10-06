'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { BASE_SIDES } from '@/src/hardware/base/types'
import { SIDE_Z, createBedModel } from './bedModel3D'
import { ORBIT, attachOrbitInput, createOrbit, homeAzimuth } from './bedOrbit'
import type { BedRendererProps } from './BedView'
import type { Three } from './loadThree'

const DARK = { card: '#0f0f11', floor: '#17171a' }

interface Props extends BedRendererProps {
  three: Three
  onReady: () => void
  onFail: () => void
}

function mountBed(THREE: Three, host: HTMLDivElement, sides: readonly ('left' | 'right')[], focusZ: number, home: number, onReady: () => void, onFail: () => void) {
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

  const camera = new THREE.PerspectiveCamera(30, 600 / 330, 0.1, 40)
  const orbit = createOrbit(home)
  const place = () => {
    const { x, y, z } = orbit.position(focusZ)
    camera.position.set(x, y, z)
    camera.lookAt(0, ORBIT.lookY, focusZ)
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

  // Swing around to a newly selected side; any touch of the controls takes over.
  let swing = 0
  const swingTo = (azimuth: number) => {
    cancelAnimationFrame(swing)
    orbit.home = azimuth
    const from = orbit.state.azimuth
    if (from === azimuth) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const start = performance.now()
    const step = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - start) / ORBIT.swingMs)
      orbit.state.azimuth = from + (azimuth - from) * (1 - (1 - t) ** 3)
      place()
      requestRender()
      if (t < 1) swing = requestAnimationFrame(step)
    }
    swing = requestAnimationFrame(step)
  }
  const detachOrbit = attachOrbitInput(canvas, orbit, () => {
    cancelAnimationFrame(swing)
    place()
    requestRender()
  })
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
    swingTo,
    dispose() {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(swing)
      observer.disconnect()
      detachOrbit()
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
  const home = homeAzimuth(view.single ?? view.focus)
  const initialHome = useRef(home)

  useLayoutEffect(() => {
    if (!host.current) return
    const sides = view.single ? [view.single] : BASE_SIDES
    try {
      bed.current = mountBed(three, host.current, sides, view.single ? SIDE_Z[view.single] : 0, initialHome.current, () => callbacks.current.onReady(), () => callbacks.current.onFail())
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

  useLayoutEffect(() => {
    bed.current?.swingTo(home)
  }, [home])

  return <div ref={host} aria-hidden="true" data-testid="bed-view-3d" className="absolute inset-0" />
}
