// The stage's three.js scene: one mattress on a frame and plinth in a dark room, the
// heat painted into the cover, invisible pick planes per side, an eased orbit camera
// and the per-frame projection of the HTML labels. Core three.js build only.

import type * as T from 'three'
import type { Three } from '@/src/components/Base/loadThree'
import { smoothNormals } from '@/src/components/Base/bedLook'
import { CAMERA, cameraGoal, cameraPose, clampDistance, easeCamera, nightLight, spreadRows, viewOffset, viewScale } from './stageCamera'
import type { CameraParams } from './stageCamera'
import { HEAT, heatKey, paintHeat } from './heatTexture'
import type { HeatInput } from './heatTexture'
import { STAGE, STAGE_SIDES, dragTargetF } from './stageColors'
import type { StageSide } from './stageColors'

export type ZoneMode = 'hover' | 'always' | 'off'

export interface StageSceneSide {
  /** Colour the half wears: target while on, measured while off, scheduled while previewing. */
  shownF: number | null
  zonesF: [number | null, number | null, number | null]
  /** Where a drag on the bed starts from. */
  targetF: number
}

export interface StageSceneState {
  sides: Record<StageSide, StageSceneSide>
  selected: StageSide | null
  linked: boolean
  zones: ZoneMode
  previewing: boolean
  autoReturn: boolean
  /** Clock hour the room is lit for (the preview hour, else now); null keeps the studio light. */
  hour: number | null
}

export interface StageSceneCallbacks {
  onHover: (side: StageSide | null) => void
  /** A tap on a side; the owner decides whether that selects or deselects. */
  onSelect: (side: StageSide) => void
  /** Vertical drag in progress: show this target (and turn the side on). */
  onDrag: (side: StageSide, f: number) => void
  onDragEnd: (side: StageSide, f: number) => void
  /** Wheel over a side: ±1°. */
  onNudge: (side: StageSide, delta: number) => void
  onFail: () => void
}

export interface StageLabelRefs {
  side: Record<StageSide, HTMLElement | null>
  linked: HTMLElement | null
  zones: Record<StageSide, (HTMLElement | null)[]>
}

export const SCENE = {
  floorY: -0.5,
  sideZ: HEAT.sideZ,
  mattressTop: 0.76,
  /** Side label anchors (x, y) per side; z is the half's centre. */
  sideLabel: { left: [0.9, 0.56] as const, right: [-1.0, 0.56] as const },
  linkedLabel: [-0.3, 0.56, 0] as const,
  zoneLabelX: 2.2,
  zoneLabelY: 0.78,
  /** Minimum pixel spacing between projected zone readouts. */
  zoneRowGap: 14,
  /** Room a zone readout needs to the right of its point before it flips to the left. */
  zoneLabelWidth: 120,
  /** Panel width plus its margins, reserved on wide screens while a side is selected. */
  panelReserve: 376,
  panelBreakpoint: 900,
  /** Per-frame easing of zone visibility and highlight. */
  fade: 0.12,
  tapSlop: 4,
  wheelZoomRate: 0.002,
} as const

/** A rounded rectangle centred on the origin, in the extrude's shape plane. */
function roundedRect(THREE: Three, width: number, depth: number, radius: number) {
  const shape = new THREE.Shape()
  const x = -width / 2
  const y = -depth / 2
  const r = Math.min(radius, width / 2, depth / 2)
  shape.moveTo(x + r, y)
  shape.lineTo(x + width - r, y)
  shape.absarc(x + width - r, y + r, r, -Math.PI / 2, 0, false)
  shape.lineTo(x + width, y + depth - r)
  shape.absarc(x + width - r, y + depth - r, r, 0, Math.PI / 2, false)
  shape.lineTo(x + r, y + depth)
  shape.absarc(x + r, y + depth - r, r, Math.PI / 2, Math.PI, false)
  shape.lineTo(x, y + r)
  shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false)
  return shape
}

/**
 * A slab: the rounded rectangle extruded to `height` with a bevel, laid flat so its
 * bottom sits at y = 0 and its top cap (material 0) at y = height. Cap UVs stay in
 * shape units, which is what the heat texture's repeat and offset expect.
 */
export function slabGeometry(THREE: Three, width: number, depth: number, height: number, radius: number, bevel: number) {
  const geometry = new THREE.ExtrudeGeometry(roundedRect(THREE, width, depth, radius), {
    depth: height - 2 * bevel,
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 6,
    curveSegments: 12,
  })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, bevel, 0)
  return smoothNormals(geometry)
}

const PLINTH = { width: 4.5, depth: 3.9, height: 0.46, radius: 0.18, bevel: 0.05, y: -0.5 }
const FRAME = { width: 4.3, depth: 3.7, height: 0.3, radius: 0.14, bevel: 0.03, y: -0.04 }
const MATTRESS = { width: HEAT.bedLength, depth: HEAT.bedWidth, height: 0.5, radius: 0.12, bevel: 0.08, y: 0.26 }
const PICK = { width: HEAT.bedLength, depth: 1.75, y: 0.77 }

interface Pointer { id: number, x0: number, y0: number, side: StageSide | null, startF: number, mode: 'pending' | 'temp' | 'orbit', lastF: number, lastX: number }

export function mountStageScene(THREE: Three, host: HTMLDivElement, callbacks: StageSceneCallbacks, labels: () => StageLabelRefs) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab'
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.9
  renderer.setClearColor(STAGE.app, 1)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(STAGE.app, 10, 22)
  const disposables: { dispose: () => void }[] = []
  const track = <D extends { dispose: () => void }>(d: D) => {
    disposables.push(d)
    return d
  }

  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(60, 60)), track(new THREE.MeshStandardMaterial({ color: STAGE.floor, roughness: 1 })))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = SCENE.floorY
  floor.receiveShadow = true
  scene.add(floor)

  const slab = (spec: typeof PLINTH, materials: T.Material | T.Material[]) => {
    const mesh = new THREE.Mesh(track(slabGeometry(THREE, spec.width, spec.depth, spec.height, spec.radius, spec.bevel)), materials)
    mesh.position.y = spec.y
    mesh.castShadow = true
    mesh.receiveShadow = true
    scene.add(mesh)
    return mesh
  }
  slab(PLINTH, track(new THREE.MeshStandardMaterial({ color: STAGE.plinth, roughness: 0.9 })))
  slab(FRAME, track(new THREE.MeshStandardMaterial({ color: STAGE.frame, roughness: 0.7 })))

  // The heat: a small canvas on the mattress caps; rows run across the bed (z).
  const heatCanvas = document.createElement('canvas')
  heatCanvas.width = HEAT.width
  heatCanvas.height = HEAT.height
  const heatContext = heatCanvas.getContext('2d')
  if (!heatContext) throw new Error('No 2D canvas for the heat texture')
  const heat = track(new THREE.CanvasTexture(heatCanvas))
  heat.colorSpace = THREE.SRGBColorSpace
  heat.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())
  heat.flipY = false
  heat.repeat.set(1 / HEAT.bedLength, 1 / HEAT.bedWidth)
  heat.offset.set(0.5, 0.5)
  heat.wrapS = THREE.ClampToEdgeWrapping
  heat.wrapT = THREE.ClampToEdgeWrapping
  const capMaterial = track(new THREE.MeshStandardMaterial({ map: heat, roughness: 0.92 }))
  const sideMaterial = track(new THREE.MeshStandardMaterial({ color: STAGE.cover, roughness: 0.92 }))
  slab(MATTRESS, [capMaterial, sideMaterial])

  // Pick targets: a plane per half, drawn with nothing.
  const pickGeometry = track(new THREE.PlaneGeometry(PICK.width, PICK.depth))
  const pickMaterial = track(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
  const picks = STAGE_SIDES.map((side) => {
    const plane = new THREE.Mesh(pickGeometry, pickMaterial)
    plane.rotation.x = -Math.PI / 2
    plane.position.set(0, PICK.y, side === 'left' ? SCENE.sideZ : -SCENE.sideZ)
    plane.name = side === 'left' ? 'L' : 'R'
    scene.add(plane)
    return plane
  })
  const sideOf = (object: T.Object3D): StageSide | null => object.name === 'L' ? 'left' : object.name === 'R' ? 'right' : null

  const hemisphere = new THREE.HemisphereLight('#ffffff', '#1a1a22', 0.45)
  scene.add(hemisphere)
  const key = new THREE.DirectionalLight('#fff6ec', 1.1)
  key.position.set(2.5, 7, 4.5)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.radius = 6
  key.shadow.bias = -0.0004
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 20 })
  key.shadow.camera.updateProjectionMatrix()
  scene.add(key)
  const rim = new THREE.DirectionalLight('#ffffff', 0.5)
  rim.position.set(-4, 4, -6)
  scene.add(rim)
  const fill = new THREE.DirectionalLight('#bfd4ff', 0.3)
  fill.position.set(-4, 1.5, 4)
  scene.add(fill)

  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 60)
  const params: CameraParams = cameraGoal(null, false)
  let goal: CameraParams = cameraGoal(null, false)
  let scale = 1
  let width = 0
  let height = 0
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const place = () => {
    const pose = cameraPose(params, scale)
    camera.position.set(...pose.position)
    camera.lookAt(...pose.target)
    camera.updateMatrixWorld()
  }

  let state: StageSceneState | null = null
  let hover: StageSide | null = null
  const visibility: Record<StageSide, number> = { left: 0, right: 0 }
  const highlight: Record<StageSide, number> = { left: 0, right: 0 }
  let paintedKey = ''

  const zoneTarget = (side: StageSide) => {
    if (!state || state.previewing || state.zones === 'off') return 0
    if (state.zones === 'always') return 1
    const { selected, linked } = state
    const lit = (s: StageSide) => s === hover || s === selected
    return lit(side) || (linked && (lit('left') || lit('right'))) ? 1 : 0
  }
  const highlightTarget = (side: StageSide) => {
    if (!state) return 0
    const sel = state.selected && (state.linked || state.selected === side)
    const hov = hover && (state.linked || hover === side)
    return sel ? HEAT.highlightSelected : hov ? HEAT.highlightHover : 0
  }
  /** Step toward the targets; returns true while any value is still moving. */
  const fade = () => {
    let moving = false
    for (const side of STAGE_SIDES) {
      for (const [values, target] of [[visibility, zoneTarget(side)], [highlight, highlightTarget(side)]] as const) {
        const delta = target - values[side]
        if (Math.abs(delta) < 0.004) {
          values[side] = target
          continue
        }
        values[side] += Math.sign(delta) * Math.min(Math.abs(delta), SCENE.fade * (values === highlight ? HEAT.highlightSelected : 1))
        moving = true
      }
    }
    return moving
  }
  const repaint = () => {
    if (!state) return false
    const { sides } = state
    const input = Object.fromEntries(STAGE_SIDES.map(side => [side, {
      shownF: sides[side].shownF,
      zonesF: sides[side].zonesF,
      zoneVisibility: visibility[side],
      highlight: highlight[side],
    }])) as HeatInput
    const next = heatKey(input)
    if (next === paintedKey) return false
    paintedKey = next
    paintHeat(heatContext, input)
    heat.needsUpdate = true
    return true
  }

  const vector = new THREE.Vector3()
  const project = (x: number, y: number, z: number) => {
    vector.set(x, y, z).project(camera)
    return { x: (vector.x + 1) / 2 * width, y: (1 - vector.y) / 2 * height, behind: vector.z > 1 }
  }
  const placeLabels = () => {
    const refs = labels()
    for (const side of STAGE_SIDES) {
      const z = side === 'left' ? SCENE.sideZ : -SCENE.sideZ
      const label = refs.side[side]
      if (label) {
        const [x, y] = SCENE.sideLabel[side]
        const p = project(x, y, z)
        const grown = state?.selected === side && !state.linked
        label.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0) translate(-50%,-100%) scale(${grown ? 1.08 : 1})`
        label.style.visibility = p.behind ? 'hidden' : ''
      }
    }
    // Zone readouts share one x beside the bed; spread the six rows so none overlap.
    const zonePoints = STAGE_SIDES.flatMap(side => HEAT.zoneOffsets.map((offset) => {
      const z = (side === 'left' ? 1 : -1) * (SCENE.sideZ + offset)
      return { side, ...project(SCENE.zoneLabelX, SCENE.zoneLabelY, z) }
    }))
    const rows = spreadRows(zonePoints.map(p => p.y), SCENE.zoneRowGap)
    // The open panel takes the right of the frame; readouts must not slide under it.
    const limit = state?.selected && width >= SCENE.panelBreakpoint ? width - SCENE.panelReserve : width
    zonePoints.forEach((p, i) => {
      const zone = refs.zones[p.side][i % HEAT.zoneOffsets.length]
      if (!zone) return
      // Near the right edge the readout sits to the left of its point instead of running off screen.
      const flip = p.x + SCENE.zoneLabelWidth > limit
      // A point past the edge still gets its readout, hung just inside the frame.
      const x = flip ? Math.min(p.x, limit) : p.x
      zone.style.transform = `translate3d(${x.toFixed(1)}px,${rows[i].toFixed(1)}px,0) translate(${flip ? 'calc(-100% - 6px)' : '6px'},-50%)`
      zone.style.opacity = p.behind ? '0' : visibility[p.side].toFixed(3)
    })
    if (refs.linked) {
      const p = project(...SCENE.linkedLabel)
      refs.linked.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0) translate(-50%,-100%) scale(${state?.selected ? 1.08 : 1})`
      refs.linked.style.visibility = p.behind ? 'hidden' : ''
    }
  }

  // The room follows the clock: dimmer in the small hours, warmer toward dawn.
  const relight = () => {
    const light = nightLight(state?.hour ?? null)
    key.intensity = 1.1 * light.key
    key.color.setRGB(1, 0.965 - 0.1 * light.warmth, 0.925 - 0.25 * light.warmth)
    hemisphere.intensity = 0.45 * light.hemisphere
  }

  let frame = 0
  let disposed = false
  const render = () => {
    frame = 0
    if (disposed) return
    const cameraMoving = easeCamera(params, goal, reduced.matches)
    place()
    const fading = fade()
    repaint()
    relight()
    if (!document.hidden) {
      renderer.render(scene, camera)
      placeLabels()
    }
    if (cameraMoving || fading) frame = requestAnimationFrame(render)
  }
  const requestRender = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(render)
  }
  // With nothing selected the view drifts home after a quiet spell; any input restarts the clock.
  let returnTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleAutoReturn = () => {
    clearTimeout(returnTimer)
    if (!state?.autoReturn || state.selected || reduced.matches) return
    returnTimer = setTimeout(() => {
      goal = cameraGoal(null, false)
      requestRender()
    }, CAMERA.autoReturnMs)
  }
  const touched = () => {
    scheduleAutoReturn()
    requestRender()
  }

  const resize = () => {
    const rect = host.getBoundingClientRect()
    width = rect.width
    height = rect.height
    if (!width || !height) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    scale = viewScale(width, height)
    const offset = viewOffset(height)
    camera.setViewOffset(width, height, offset.x, offset.y, width, height)
    camera.updateProjectionMatrix()
    requestRender()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)

  const raycaster = new THREE.Raycaster()
  const pointerAt = (event: { clientX: number, clientY: number }): StageSide | null => {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera)
    const hit = raycaster.intersectObjects(picks, false)[0]
    return hit ? sideOf(hit.object) : null
  }
  const setHover = (side: StageSide | null) => {
    if (side === hover) return
    hover = side
    canvas.style.cursor = side ? 'ns-resize' : 'grab'
    callbacks.onHover(side)
    requestRender()
  }

  let pointer: Pointer | null = null
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const side = pointerAt(event)
    pointer = { id: event.pointerId, x0: event.clientX, y0: event.clientY, lastX: event.clientX, side, startF: side && state ? state.sides[side].targetF : 0, lastF: 0, mode: 'pending' }
    canvas.setPointerCapture?.(event.pointerId)
    touched()
  }
  const move = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) {
      if (!pointer && event.pointerType === 'mouse') setHover(pointerAt(event))
      return
    }
    const dx = event.clientX - pointer.x0
    const dy = event.clientY - pointer.y0
    if (pointer.mode === 'pending' && Math.hypot(dx, dy) >= SCENE.tapSlop) {
      pointer.mode = pointer.side ? 'temp' : 'orbit'
      if (pointer.mode === 'orbit') canvas.style.cursor = 'grabbing'
    }
    if (pointer.mode === 'temp' && pointer.side) {
      const f = dragTargetF(pointer.startF, dy)
      if (f !== pointer.lastF) {
        pointer.lastF = f
        callbacks.onDrag(pointer.side, f)
      }
    }
    else if (pointer.mode === 'orbit') {
      const step = (event.clientX - pointer.lastX) * CAMERA.orbitRate
      pointer.lastX = event.clientX
      params.phi -= step
      goal.phi -= step
    }
    touched()
  }
  const up = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return
    const { mode, side, lastF } = pointer
    pointer = null
    canvas.style.cursor = hover ? 'ns-resize' : 'grab'
    if (event.type === 'pointerup') {
      if (mode === 'pending' && side) callbacks.onSelect(side)
      else if (mode === 'temp' && side) callbacks.onDragEnd(side, lastF)
    }
    touched()
  }
  const wheel = (event: WheelEvent) => {
    event.preventDefault()
    const side = pointerAt(event)
    if (side) callbacks.onNudge(side, event.deltaY < 0 ? 1 : -1)
    else {
      const r = clampDistance(goal.r * Math.exp(event.deltaY * SCENE.wheelZoomRate))
      goal.r = r
      params.r = r
    }
    touched()
  }
  const leave = () => setHover(null)
  const lost = (event: Event) => {
    event.preventDefault()
    callbacks.onFail()
  }
  const visible = () => {
    if (!document.hidden) requestRender()
  }
  const listeners: [string, EventListener, AddEventListenerOptions?][] = [
    ['pointerdown', down as EventListener],
    ['pointermove', move as EventListener],
    ['pointerup', up as EventListener],
    ['pointercancel', up as EventListener],
    ['pointerleave', leave],
    ['wheel', wheel as EventListener, { passive: false }],
    ['webglcontextlost', lost],
  ]
  for (const [type, listener, options] of listeners) canvas.addEventListener(type, listener, options)
  document.addEventListener('visibilitychange', visible)
  reduced.addEventListener('change', requestRender)
  host.appendChild(canvas)
  place()
  resize()

  let selectionKey = ''
  return {
    update(next: StageSceneState) {
      state = next
      const key = `${next.selected ?? ''}|${next.linked}`
      if (key !== selectionKey) {
        selectionKey = key
        goal = cameraGoal(next.selected, next.linked)
      }
      scheduleAutoReturn()
      requestRender()
    },
    /** Arrow keys: swing the view a quarter radian. */
    orbitBy(radians: number) {
      goal.phi += radians
      if (reduced.matches) params.phi = goal.phi
      touched()
    },
    /** For tests and diagnostics. */
    camera: () => ({ ...params }),
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      clearTimeout(returnTimer)
      observer.disconnect()
      for (const [type, listener] of listeners) canvas.removeEventListener(type, listener)
      document.removeEventListener('visibilitychange', visible)
      reduced.removeEventListener('change', requestRender)
      for (const d of disposables) d.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}

export type StageScene = ReturnType<typeof mountStageScene>
