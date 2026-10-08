'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BASE_SIDES } from '@/src/hardware/base/types'
import { SIDE_Z, createBedModel } from './bedModel3D'
import { contactShadow, isLightTheme, paletteFor, roomBackdrop, studioEnvironment } from './bedLook'
import { ORBIT, attachOrbitInput, createOrbit, homeAzimuth } from './bedOrbit'
import type { BedRendererProps } from './BedView'
import type { Three } from './loadThree'

const FLOOR_Y = -0.61
// Soft studio: one large warm key high and slightly behind the camera, a cool fill
// from the far side, and a hemisphere doing most of the lifting so shadows stay gentle.
const LIGHTS = {
  hemisphere: { sky: '#fbf7f0', ground: '#62626a', intensity: 1.9 },
  key: { color: '#fff6ea', intensity: 2.4, position: [3.5, 7, 3] as const },
  fill: { color: '#dfe8ff', intensity: 0.7, position: [-5, 3, -2] as const },
  rim: { color: '#ffffff', intensity: 0.7, position: [-2, 4, -6] as const },
  exposure: 1.1,
}

interface Props extends BedRendererProps {
  three: Three
  onReady: () => void
  onFail: () => void
}

function mountBed(THREE: Three, host: HTMLDivElement, sides: readonly ('left' | 'right')[], focusZ: number, home: number, onReady: () => void, onFail: () => void) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = LIGHTS.exposure
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.VSMShadowMap

  const scene = new THREE.Scene()
  // Shadows land on a transparent plane laid over the room's floor.
  const floorGeometry = new THREE.PlaneGeometry(40, 40)
  const floorMaterial = new THREE.ShadowMaterial({ opacity: 0.3 })
  const floor = new THREE.Mesh(floorGeometry, floorMaterial)
  floor.rotation.x = -Math.PI / 2
  floor.position.y = FLOOR_Y
  floor.receiveShadow = true
  scene.add(floor)
  const contact = contactShadow(THREE, 9, 7.2, 0.5)
  contact.mesh.position.set(0.1, FLOOR_Y + 0.002, focusZ)
  scene.add(contact.mesh)

  const hemisphere = new THREE.HemisphereLight(LIGHTS.hemisphere.sky, LIGHTS.hemisphere.ground, LIGHTS.hemisphere.intensity)
  scene.add(hemisphere)
  const key = new THREE.DirectionalLight(LIGHTS.key.color, LIGHTS.key.intensity)
  key.position.set(...LIGHTS.key.position)
  key.castShadow = true
  key.shadow.mapSize.set(1536, 1536)
  // Wide enough that the frustum edge never crosses the visible floor and prints a line.
  Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 30 })
  key.shadow.camera.updateProjectionMatrix()
  key.shadow.bias = -0.0002
  key.shadow.radius = 7
  key.shadow.blurSamples = 10
  scene.add(key)
  const fill = new THREE.DirectionalLight(LIGHTS.fill.color, LIGHTS.fill.intensity)
  fill.position.set(...LIGHTS.fill.position)
  scene.add(fill)
  // Lifts the far mattress edge off a dark card; nearly off in the light theme.
  const rim = new THREE.DirectionalLight(LIGHTS.rim.color, LIGHTS.rim.intensity)
  rim.position.set(...LIGHTS.rim.position)
  scene.add(rim)

  let light = isLightTheme()
  const room = roomBackdrop(THREE, scene, renderer, light, FLOOR_Y)
  let environment = studioEnvironment(THREE, renderer, light)
  // A white card needs less light than a dark one for the same perceived softness.
  const relight = () => {
    scene.environment = environment.texture
    scene.environmentIntensity = light ? 0.7 : 0.9
    hemisphere.intensity = LIGHTS.hemisphere.intensity * (light ? 0.75 : 1)
    key.intensity = LIGHTS.key.intensity * (light ? 0.75 : 1)
    rim.intensity = LIGHTS.rim.intensity * (light ? 0.4 : 1)
  }
  relight()
  const model = createBedModel(THREE, sides, { palette: paletteFor(light), pillows: false })
  scene.add(model.root)

  const camera = new THREE.PerspectiveCamera(30, 600 / 330, 0.1, 40)
  const orbit = createOrbit(home)
  const place = () => {
    const { x, y, z } = orbit.position(focusZ)
    camera.position.set(x, y, z)
    camera.lookAt(0, ORBIT.lookY, focusZ)
    room.follow(orbit.state.azimuth, focusZ)
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
  // Relight for the theme: a light UI wants a brighter studio and a fainter shadow.
  const applyTheme = () => {
    const next = isLightTheme()
    if (next !== light) {
      light = next
      environment.dispose()
      environment = studioEnvironment(THREE, renderer, light)
      relight()
      room.recolor(light)
      model.recolor(paletteFor(light))
    }
    floorMaterial.opacity = light ? 0.18 : 0.3
    contact.setOpacity(paletteFor(light).shadow)
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
      contact.dispose()
      room.dispose()
      environment.dispose()
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
  const [shown, setShown] = useState(false)
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
      bed.current = mountBed(three, host.current, sides, view.single ? SIDE_Z[view.single] : 0, initialHome.current, () => {
        // Reveal the canvas here, not in a wrapped callback: the first frame can land
        // before the effect that would wrap it runs, leaving the canvas invisible.
        setShown(true)
        callbacks.current.onReady()
      }, () => callbacks.current.onFail())
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

  // The first frame fades in over the skeleton instead of popping.
  return <div ref={host} aria-hidden="true" data-testid="bed-view-3d" className={`bed-backdrop absolute inset-0 [&>canvas]:transition-opacity [&>canvas]:duration-500 ${shown ? '' : '[&>canvas]:opacity-0'}`} />
}
