// Look-development helpers shared by the base and thermal scenes: soft shapes,
// a baked contact shadow and a procedural studio environment. Everything here
// uses the core three.js build only (no examples/jsm) and runs once at mount.

import type * as T from 'three'
import type { Point } from './bedGeometry'
import type { Three } from './loadThree'

export interface Palette {
  /** Articulating deck panels. */
  deck: string
  deckUnder: string
  mattress: string
  mattressSide: string
  pillow: string
  /** Upholstered platform under the thermal view. */
  platform: string
  frame: string
  leg: string
  chrome: string
  /** Translucent target ghosts carry each sleeper's accent. */
  ghostLeft: string
  ghostRight: string
  shadow: number
}

/** Warm studio neutrals: charcoal cover, stone platform, cream pillow. */
export const DARK_PALETTE: Palette = {
  deck: '#46474d',
  deckUnder: '#2b2b30',
  mattress: '#55585f',
  mattressSide: '#43464d',
  pillow: '#d8d4cd',
  platform: '#5b5751',
  frame: '#1c1c20',
  leg: '#1a1a1e',
  chrome: '#b8b8bd',
  ghostLeft: '#a99cf2',
  ghostRight: '#f08cc4',
  shadow: 0.5,
}

export const LIGHT_PALETTE: Palette = {
  deck: '#4e4f55',
  deckUnder: '#35363b',
  mattress: '#a4a8b0',
  mattressSide: '#8c9099',
  pillow: '#ece9e3',
  platform: '#d9d2c6',
  frame: '#2e2f34',
  leg: '#2a2a2e',
  chrome: '#c8c8cc',
  ghostLeft: '#6a58d6',
  ghostRight: '#c2438c',
  shadow: 0.24,
}

/**
 * The room the bed stands in: a floor, a backdrop wall with a soft cove where they meet,
 * a haze that fades the far wall, and a window-light pool on the floor. The light theme
 * is a sunlit afternoon in sand tones; the dark theme is the same room at night under a
 * cool moon, so the card stays easy on the eyes in a dark bedroom.
 */
export interface Room {
  floor: string
  wall: string
  /** Haze colour; also what the canvas clears to above the wall. */
  haze: string
  pool: string
  poolOpacity: number
}

export const DAY_ROOM: Room = { floor: '#d5c9b6', wall: '#e3dacc', haze: '#ece5d9', pool: '#fff1cf', poolOpacity: 0.5 }
export const NIGHT_ROOM: Room = { floor: '#20212a', wall: '#292a35', haze: '#1b1c25', pool: '#9fb6e0', poolOpacity: 0.1 }
export const roomFor = (light: boolean) => light ? DAY_ROOM : NIGHT_ROOM

export const isLightTheme = () => typeof document !== 'undefined'
  && (document.documentElement.dataset.theme === 'light'
    || (document.documentElement.dataset.theme !== 'dark' && !!window.matchMedia?.('(prefers-color-scheme: light)').matches))

export const paletteFor = (light: boolean) => light ? LIGHT_PALETTE : DARK_PALETTE

/**
 * A rounded box: the segmented box's vertices projected onto the surface of a box with
 * edge radius r. Faces stay flat, edges and corners become quarter rounds.
 */
export function roundedBoxGeometry(THREE: Three, width: number, height: number, depth: number, radius: number, segments = 12) {
  const geometry = new THREE.BoxGeometry(width, height, depth, segments, Math.max(3, Math.round(segments * height / width)), Math.round(segments * depth / width))
  const position = geometry.getAttribute('position') as T.BufferAttribute
  const half = [width / 2, height / 2, depth / 2]
  const r = Math.min(radius, ...half)
  const v = [0, 0, 0]
  const inner = [0, 0, 0]
  for (let i = 0; i < position.count; i++) {
    for (let k = 0; k < 3; k++) {
      v[k] = position.getComponent(i, k)
      inner[k] = Math.max(-(half[k] - r), Math.min(half[k] - r, v[k]))
    }
    const d = [v[0] - inner[0], v[1] - inner[1], v[2] - inner[2]]
    const length = Math.hypot(d[0], d[1], d[2]) || 1
    for (let k = 0; k < 3; k++) position.setComponent(i, k, inner[k] + d[k] / length * r)
  }
  position.needsUpdate = true
  return geometry
}

/** A plump pillow: a rounded box whose top domes gently toward the centre. */
export function pillowGeometry(THREE: Three, width: number, height: number, depth: number, dome = 0.35, segments = 14) {
  const geometry = roundedBoxGeometry(THREE, width, height, depth, height * 0.42, segments)
  const position = geometry.getAttribute('position') as T.BufferAttribute
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) / (width / 2)
    const y = position.getY(i)
    const z = position.getZ(i) / (depth / 2)
    const bulge = Math.max(0, 1 - x * x) * Math.max(0, 1 - z * z)
    position.setY(i, y * (1 + dome * bulge))
  }
  position.needsUpdate = true
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Weld coincident vertices and recompute normals so bevels and fillets shade as one
 * continuous surface. ExtrudeGeometry and BoxGeometry duplicate vertices per face, which
 * renders every segment as a visible flat band. Returns the same geometry, now indexed.
 */
export function smoothNormals<G extends T.BufferGeometry>(geometry: G, precision = 1e-4): G {
  const position = geometry.getAttribute('position') as T.BufferAttribute
  const source = geometry.getIndex()
  const count = source ? source.count : position.count
  const lookup = new Map<string, number>()
  const index: number[] = []
  const scale = 1 / precision
  for (let i = 0; i < count; i++) {
    const v = source ? source.getX(i) : i
    const key = `${Math.round(position.getX(v) * scale)},${Math.round(position.getY(v) * scale)},${Math.round(position.getZ(v) * scale)}`
    let shared = lookup.get(key)
    if (shared === undefined) {
      shared = v
      lookup.set(key, v)
    }
    index.push(shared)
  }
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  return geometry
}

/** Replace each convex corner of a closed polygon with an arc of radius r (clamped to its edges). */
export function filletPolygon(points: Point[], r: number, steps = 6): Point[] {
  const out: Point[] = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const cur = points[i]
    const next = points[(i + 1) % n]
    const a = { x: prev.x - cur.x, y: prev.y - cur.y }
    const b = { x: next.x - cur.x, y: next.y - cur.y }
    const la = Math.hypot(a.x, a.y) || 1
    const lb = Math.hypot(b.x, b.y) || 1
    const ua = { x: a.x / la, y: a.y / la }
    const ub = { x: b.x / lb, y: b.y / lb }
    const cos = Math.max(-0.9999, Math.min(0.9999, ua.x * ub.x + ua.y * ub.y))
    const theta = Math.acos(cos)
    // Nearly straight joints (hinge seams) keep their vertex; rounding them would ripple the surface.
    if (Math.PI - theta < 0.08) {
      out.push(cur)
      continue
    }
    const radius = Math.min(r, (Math.min(la, lb) / 2) * Math.tan(theta / 2))
    const t = radius / Math.tan(theta / 2)
    const start = { x: cur.x + ua.x * t, y: cur.y + ua.y * t }
    const end = { x: cur.x + ub.x * t, y: cur.y + ub.y * t }
    const bisector = { x: ua.x + ub.x, y: ua.y + ub.y }
    const lbis = Math.hypot(bisector.x, bisector.y) || 1
    const centre = { x: cur.x + bisector.x / lbis * radius / Math.sin(theta / 2), y: cur.y + bisector.y / lbis * radius / Math.sin(theta / 2) }
    const a0 = Math.atan2(start.y - centre.y, start.x - centre.x)
    let a1 = Math.atan2(end.y - centre.y, end.x - centre.x)
    // Sweep the short way round.
    while (a1 - a0 > Math.PI) a1 -= Math.PI * 2
    while (a0 - a1 > Math.PI) a1 += Math.PI * 2
    for (let s = 0; s <= steps; s++) {
      const angle = a0 + (a1 - a0) * s / steps
      out.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius })
    }
  }
  return out
}

/** A soft radial shadow, drawn once; cheaper and softer than a shadow map on phones. */
export function contactShadow(THREE: Three, width: number, depth: number, opacity: number) {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size / 2)
    gradient.addColorStop(0, 'rgba(0,0,0,1)')
    gradient.addColorStop(0.55, 'rgba(0,0,0,0.55)')
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, size, size)
  }
  const texture = new THREE.CanvasTexture(canvas)
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity, depthWrite: false })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.renderOrder = -1
  return {
    mesh,
    setOpacity(value: number) {
      material.opacity = value
    },
    dispose() {
      mesh.geometry.dispose()
      material.dispose()
      texture.dispose()
    },
  }
}

/**
 * A soft studio: a large warm overhead panel, a cool fill from one side, a dim floor
 * bounce. Prefiltered once so standard materials pick up gentle specular and ambient.
 */
export function studioEnvironment(THREE: Three, renderer: T.WebGLRenderer, light: boolean) {
  const room = new THREE.Scene()
  const panel = (color: string, intensity: number, size: [number, number], position: [number, number, number], lookAt: [number, number, number]) => {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...size), material)
    mesh.position.set(...position)
    mesh.lookAt(...lookAt)
    room.add(mesh)
  }
  const ambient = light ? 0.7 : 0.35
  // Walls set the overall tone; panels add the soft highlights.
  room.background = new THREE.Color(light ? '#d8d2c8' : '#26252a').multiplyScalar(ambient)
  panel('#fff4e6', light ? 2.4 : 2.6, [6, 4], [0, 6, 1], [0, 0, 0])
  panel('#dfe9ff', light ? 1.6 : 1.2, [3, 6], [-7, 2, 3], [0, 0.5, 0])
  panel('#fff1e0', light ? 1.1 : 0.8, [3, 5], [6, 2, -4], [0, 0.5, 0])
  panel(light ? '#cfc6ba' : '#2d2b2f', 1, [16, 16], [0, -3, 0], [0, 0, 0])
  const pmrem = new THREE.PMREMGenerator(renderer)
  const target = pmrem.fromScene(room, 0.04)
  pmrem.dispose()
  room.traverse((node) => {
    const mesh = node as T.Mesh
    if (mesh.isMesh) {
      mesh.geometry.dispose()
      ;(mesh.material as T.Material).dispose()
    }
  })
  return target
}

/** Grayscale vertical ramp: a little occlusion where the wall meets the floor. */
function coveTexture(THREE: Three) {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 128
  const context = canvas.getContext('2d')
  if (context) {
    const gradient = context.createLinearGradient(0, 128, 0, 0)
    gradient.addColorStop(0, '#d6d6d6')
    gradient.addColorStop(0.12, '#ffffff')
    gradient.addColorStop(1, '#ffffff')
    context.fillStyle = gradient
    context.fillRect(0, 0, 2, 128)
  }
  return new THREE.CanvasTexture(canvas)
}

/**
 * A pool of window light: a soft ellipse with two mullion shadows. Drawn small on purpose;
 * the texture's magnification filter is the blur, which every browser's canvas can do.
 */
function lightPoolTexture(THREE: Three) {
  const size = 96
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (context) {
    context.translate(size / 2, size / 2)
    context.scale(1, 0.72)
    const gradient = context.createRadialGradient(0, 0, size * 0.1, 0, 0, size * 0.5)
    gradient.addColorStop(0, 'rgba(255,255,255,1)')
    gradient.addColorStop(0.6, 'rgba(255,255,255,0.7)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    context.fillStyle = gradient
    context.fillRect(-size / 2, -size / 2, size, size)
    // Faint mullion shadows: enough to say "window", not enough to draw a grid.
    context.globalCompositeOperation = 'destination-out'
    context.fillStyle = 'rgba(0,0,0,0.3)'
    for (const x of [-size * 0.17, size * 0.17]) context.fillRect(x - 1.5, -size, 3, size * 2)
    context.fillRect(-size, -1.5, size * 2, 3)
  }
  return new THREE.CanvasTexture(canvas)
}

export const ROOM = {
  /** The backdrop wall stands this far behind the bed, along the camera's line of sight. */
  wallDistance: 4.6,
  wallWidth: 60,
  wallHeight: 18,
  fogNear: 12,
  fogFar: 26,
  /** Window light falls across the near-left floor and under the bed's edge. */
  pool: { width: 11, depth: 7.5, x: 0.4, z: 2.4, rotation: -0.35 },
} as const

/**
 * Builds the room around the bed. The wall follows the camera's azimuth so it is always
 * squarely behind the bed, as on a turntable; the floor and its light pool stay put.
 */
export function roomBackdrop(THREE: Three, scene: T.Scene, renderer: T.WebGLRenderer, light: boolean, floorY: number) {
  let room = roomFor(light)
  const group = new THREE.Group()
  const floorGeometry = new THREE.PlaneGeometry(90, 90)
  const floorMaterial = new THREE.MeshBasicMaterial({ color: room.floor })
  const floor = new THREE.Mesh(floorGeometry, floorMaterial)
  floor.rotation.x = -Math.PI / 2
  floor.position.y = floorY - 0.004
  group.add(floor)
  const cove = coveTexture(THREE)
  const wallGeometry = new THREE.PlaneGeometry(ROOM.wallWidth, ROOM.wallHeight)
  const wallMaterial = new THREE.MeshBasicMaterial({ color: room.wall, map: cove })
  const wall = new THREE.Mesh(wallGeometry, wallMaterial)
  group.add(wall)
  const poolTexture = lightPoolTexture(THREE)
  const poolGeometry = new THREE.PlaneGeometry(ROOM.pool.width, ROOM.pool.depth)
  const poolMaterial = new THREE.MeshBasicMaterial({ map: poolTexture, color: room.pool, transparent: true, opacity: room.poolOpacity, depthWrite: false })
  const pool = new THREE.Mesh(poolGeometry, poolMaterial)
  pool.rotation.set(-Math.PI / 2, 0, ROOM.pool.rotation)
  pool.position.set(ROOM.pool.x, floorY - 0.002, ROOM.pool.z)
  pool.renderOrder = -2
  group.add(pool)
  const fog = new THREE.Fog(room.haze, ROOM.fogNear, ROOM.fogFar)
  scene.fog = fog
  scene.add(group)
  const paint = () => {
    floorMaterial.color.set(room.floor)
    wallMaterial.color.set(room.wall)
    poolMaterial.color.set(room.pool)
    poolMaterial.opacity = room.poolOpacity
    fog.color.set(room.haze)
    renderer.setClearColor(room.haze, 1)
  }
  paint()
  return {
    group,
    /** Keep the wall behind the bed as seen from this azimuth, centred on the focused half. */
    follow(azimuth: number, focusZ: number) {
      wall.position.set(-ROOM.wallDistance * Math.cos(azimuth), floorY + ROOM.wallHeight / 2, focusZ - ROOM.wallDistance * Math.sin(azimuth))
      wall.rotation.y = Math.PI / 2 - azimuth
    },
    recolor(next: boolean) {
      room = roomFor(next)
      paint()
    },
    dispose() {
      scene.remove(group)
      scene.fog = null
      floorGeometry.dispose()
      floorMaterial.dispose()
      wallGeometry.dispose()
      wallMaterial.dispose()
      cove.dispose()
      poolGeometry.dispose()
      poolMaterial.dispose()
      poolTexture.dispose()
    },
  }
}
