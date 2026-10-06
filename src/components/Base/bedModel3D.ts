import type * as T from 'three'
import type { BaseSide } from '@/src/hardware/base/types'
import { DECK_THICKNESS, MATTRESS_THICKNESS, PIVOT_Y, liftArms, mattressBase, offset, pillow, profile, slab } from './bedGeometry'
import type { Point, Pose } from './bedGeometry'
import type { Three } from './loadThree'

const UNIT = 100
export const to3 = (p: Point) => ({ x: (p.x - 300) / UNIT, y: (PIVOT_Y - p.y) / UNIT })
export const SIDE_Z: Record<BaseSide, number> = { left: 0.97, right: -0.97 }
const HALF_WIDTH = 1.9
const THICKNESS = DECK_THICKNESS / UNIT
const BEVEL_SIZE = 0.035
const BEVEL_THICKNESS = 0.045
const CORNER = 0.14
const SEAM_GAP = 0.006
const MATTRESS_DEPTH = 1.88
const MATTRESS_BEVEL = 0.03
/** Rebuild a side only when an angle moved at least this far. */
export const REBUILD_EPSILON = 0.1

export interface SideState { pose: Pose, target: Pose, moving: boolean }
export type BedModel = 'base' | 'mattress'

interface Vec { x: number, y: number }
const sub = (a: Vec, b: Vec) => ({ x: a.x - b.x, y: a.y - b.y })
const unit = (v: Vec) => {
  const length = Math.hypot(v.x, v.y) || 1
  return { x: v.x / length, y: v.y / length }
}
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y
const upNormal = (d: Vec) => ({ x: -d.y, y: d.x })
const moved = (a: Pose | undefined, b: Pose) => !a || Math.abs(a.head - b.head) >= REBUILD_EPSILON || Math.abs(a.feet - b.feet) >= REBUILD_EPSILON

/** Plan outline (u along the panel, w across) with optional rounded free ends. */
function planShape(THREE: Three, length: number, roundStart: boolean, roundEnd: boolean) {
  const a = SEAM_GAP + BEVEL_SIZE
  const b = length - SEAM_GAP - BEVEL_SIZE
  const lo = -HALF_WIDTH / 2 + BEVEL_SIZE
  const hi = HALF_WIDTH / 2 - BEVEL_SIZE
  const r = CORNER - BEVEL_SIZE
  const r0 = roundStart ? r : 0
  const r1 = roundEnd ? r : 0
  const shape = new THREE.Shape()
  shape.moveTo(a + r0, lo)
  shape.lineTo(b - r1, lo)
  if (r1) shape.absarc(b - r1, lo + r1, r1, -Math.PI / 2, 0, false)
  shape.lineTo(b, hi - r1)
  if (r1) shape.absarc(b - r1, hi - r1, r1, 0, Math.PI / 2, false)
  shape.lineTo(a + r0, hi)
  if (r0) shape.absarc(a + r0, hi - r0, r0, Math.PI / 2, Math.PI, false)
  shape.lineTo(a, lo + r0)
  if (r0) shape.absarc(a + r0, lo + r0, r0, Math.PI, Math.PI * 1.5, false)
  return shape
}

interface Panel { mesh: T.Mesh, plan: Float32Array, planNormals: Float32Array, length: number }

function roundedRect(THREE: Three, width: number, height: number) {
  const r = height / 2
  const shape = new THREE.Shape()
  shape.moveTo(-width / 2 + r, -r)
  shape.lineTo(width / 2 - r, -r)
  shape.absarc(width / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false)
  shape.lineTo(-width / 2 + r, r)
  shape.absarc(-width / 2 + r, 0, r, Math.PI / 2, Math.PI * 1.5, false)
  return shape
}

/** The split base as three.js objects. Rendering, camera and input live in BedView3D. */
export function createBedModel(THREE: Three, sides: readonly BaseSide[]) {
  const root = new THREE.Group()
  const geometries = new Set<T.BufferGeometry>()
  const materials: T.Material[] = []
  const track = <G extends T.BufferGeometry>(geometry: G) => {
    geometries.add(geometry)
    return geometry
  }
  const material = <M extends T.Material>(m: M) => {
    materials.push(m)
    return m
  }
  const mesh = (geometry: T.BufferGeometry, mat: T.Material | T.Material[], shadows = true) => {
    const m = new THREE.Mesh(geometry, mat)
    m.castShadow = shadows
    m.receiveShadow = shadows
    return m
  }
  const standard = (color: string, extra: T.MeshStandardMaterialParameters = {}) => material(new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra }))
  const panelMaterials = [standard('#34343a'), standard('#232327')]
  const mattressMaterials = [standard('#2c2c31', { roughness: 0.95 }), standard('#4a4a50', { roughness: 0.95 })]
  const pillowMaterial = standard('#cfcfd2', { roughness: 0.9 })
  const railMaterial = standard('#2a2a2e', { metalness: 0.5, roughness: 0.5 })
  const legMaterial = standard('#101012', { roughness: 0.6 })
  const chrome = standard('#a8a8ae', { metalness: 0.85, roughness: 0.25 })
  const boxMaterial = standard('#45454b')
  const ghostMaterial = material(new THREE.MeshBasicMaterial({ color: '#ececec', transparent: true, opacity: 0.12, depthWrite: false }))

  // Static frame: sub-frame rails, 3 × 3 legs and the seat control box.
  // A single half (per-side card) keeps only its own half of the frame.
  const sign = sides.length === 1 ? Math.sign(SIDE_Z[sides[0]]) : 0
  const longRail = track(new THREE.BoxGeometry(4.9, 0.05, 0.05))
  for (const z of sign ? [1.72 * sign, 0.22 * sign] : [1.72, 0.22, -0.22, -1.72]) {
    const rail = mesh(longRail, railMaterial)
    rail.position.set(0.05, -0.065, z)
    root.add(rail)
  }
  const crossRail = track(new THREE.BoxGeometry(0.05, 0.05, sign ? 1.72 : 3.44))
  const legGeometry = track(new THREE.CylinderGeometry(0.075, 0.075, 0.52, 20))
  for (const x of [-2.2, 0.3, 2.3]) {
    const rail = mesh(crossRail, railMaterial)
    rail.position.set(x, -0.065, sign * 0.86)
    root.add(rail)
    for (const z of sign ? [0, 1.78 * sign] : [-1.78, 0, 1.78]) {
      const leg = mesh(legGeometry, legMaterial)
      leg.position.set(x, -0.35, z)
      root.add(leg)
    }
  }
  const controlBox = mesh(track(new THREE.BoxGeometry(0.26, 0.03, 0.26)), boxMaterial)
  controlBox.position.set(to3({ x: 285, y: PIVOT_Y }).x, THICKNESS + 0.015, 0)
  root.add(controlBox)

  const lengths = [200, 90, 90, 140].map(length => length / UNIT)
  const armGeometry = track(new THREE.CylinderGeometry(0.028, 0.028, 1, 10))
  const pillowGeometry = track(new THREE.ExtrudeGeometry(roundedRect(THREE, 0.62, 0.16), { depth: 1.3, bevelEnabled: false, curveSegments: 12 }))
  const barPath = new THREE.CurvePath<T.Vector3>()
  const bar = [[0, 0, -0.42], [0, 0.11, -0.42], [0, 0.11, 0.42], [0, 0, 0.42]].map(([x, y, z]) => new THREE.Vector3(x - 0.03, y, z))
  for (let i = 0; i < 3; i++) barPath.add(new THREE.LineCurve3(bar[i], bar[i + 1]))
  const barGeometry = track(new THREE.TubeGeometry(barPath, 48, 0.012, 8, false))

  const halves = sides.map((side) => {
    const z = SIDE_Z[side]
    const panels: Panel[] = lengths.map((length, i) => {
      const geometry = track(new THREE.ExtrudeGeometry(planShape(THREE, length, i === 0, i === lengths.length - 1), {
        depth: THICKNESS - 2 * BEVEL_THICKNESS,
        bevelEnabled: true,
        bevelSize: BEVEL_SIZE,
        bevelThickness: BEVEL_THICKNESS,
        bevelSegments: 6,
        curveSegments: 10,
      }))
      const m = mesh(geometry, panelMaterials)
      root.add(m)
      return {
        mesh: m,
        plan: Float32Array.from(geometry.getAttribute('position').array),
        planNormals: Float32Array.from(geometry.getAttribute('normal').array),
        length,
      }
    })
    const arms = [0, 1].map(() => {
      const arm = mesh(armGeometry, railMaterial)
      root.add(arm)
      return arm
    })
    const retainer = new THREE.Group()
    retainer.add(mesh(barGeometry, chrome))
    retainer.position.z = z
    root.add(retainer)
    const pillowMesh = mesh(pillowGeometry, pillowMaterial)
    root.add(pillowMesh)
    return { side, z, panels, arms, retainer, pillow: pillowMesh, mattress: null as T.Mesh | null, ghost: null as T.Mesh | null, built: undefined as Pose | undefined, ghostBuilt: undefined as Pose | undefined, model: undefined as BedModel | undefined }
  })

  const replace = (current: T.Mesh | null, next: T.Mesh | null) => {
    if (current) {
      root.remove(current)
      current.geometry.dispose()
      geometries.delete(current.geometry)
    }
    if (next) root.add(next)
    return next
  }
  const extrudeSlab = (points: Point[], depth: number, z: number, mat: T.Material | T.Material[], bevel = 0) => {
    const shape = new THREE.Shape(points.map(p => new THREE.Vector2(to3(p).x, to3(p).y)))
    const geometry = track(new THREE.ExtrudeGeometry(shape, bevel
      ? { depth: depth - 2 * bevel, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 4 }
      : { depth, bevelEnabled: false }))
    const m = mesh(geometry, mat, mat !== ghostMaterial)
    // A bevel grows the extrusion by its thickness at both faces.
    m.position.z = z - depth / 2 + bevel
    return m
  }

  /** Bend each flat panel into place, shearing its ends onto the hinge mitre. */
  function placePanels(half: typeof halves[number], points: Point[]) {
    const p = points.map(to3)
    const dirs = p.slice(0, -1).map((start, i) => unit(sub(p[i + 1], start)))
    const normals = dirs.map(upNormal)
    const shear = (i: number, j: number) => {
      const m = unit({ x: normals[i].x + normals[j].x, y: normals[i].y + normals[j].y })
      return dot(m, dirs[i]) / dot(m, normals[i])
    }
    half.panels.forEach((panel, i) => {
      const d = dirs[i]
      const n = normals[i]
      const s0 = i > 0 ? shear(i, i - 1) : 0
      const s1 = i < half.panels.length - 1 ? shear(i, i + 1) : 0
      const position = panel.mesh.geometry.getAttribute('position') as T.BufferAttribute
      const normal = panel.mesh.geometry.getAttribute('normal') as T.BufferAttribute
      const out = position.array as Float32Array
      const outNormals = normal.array as Float32Array
      for (let k = 0; k < out.length; k += 3) {
        const u = panel.plan[k]
        const w = panel.plan[k + 1]
        const v = panel.plan[k + 2] + BEVEL_THICKNESS
        const along = u + v * (s0 + (s1 - s0) * Math.min(1, Math.max(0, u / panel.length)))
        out[k] = p[i].x + d.x * along + n.x * v
        out[k + 1] = p[i].y + d.y * along + n.y * v
        // w maps to -z so the (u, w, v) → (d, z, n) frame stays right-handed.
        out[k + 2] = half.z - w
        const nu = panel.planNormals[k]
        const nw = panel.planNormals[k + 1]
        const nv = panel.planNormals[k + 2]
        outNormals[k] = d.x * nu + n.x * nv
        outNormals[k + 1] = d.y * nu + n.y * nv
        outNormals[k + 2] = -nw
      }
      position.needsUpdate = true
      normal.needsUpdate = true
      panel.mesh.geometry.computeBoundingSphere()
    })
  }

  const up = new THREE.Vector3(0, 1, 0)
  function placeArm(arm: T.Mesh, [from, to]: [Point, Point], z: number) {
    const a = to3(from)
    const b = to3(to)
    const direction = new THREE.Vector3(b.x - a.x, b.y - a.y, 0)
    const length = direction.length()
    arm.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, z)
    arm.scale.set(1, length, 1)
    arm.quaternion.setFromUnitVectors(up, direction.normalize())
  }

  /** Returns true when anything changed and a render is needed. */
  function update(states: Partial<Record<BaseSide, SideState>>, model: BedModel) {
    let changed = false
    const mattress = model === 'mattress'
    if (controlBox.visible === mattress) {
      controlBox.visible = !mattress
      changed = true
    }
    for (const half of halves) {
      const state = states[half.side]
      if (!state) continue
      if (moved(half.built, state.pose) || half.model !== model) {
        const points = profile(state.pose)
        placePanels(half, points)
        liftArms(points).forEach((arm, i) => placeArm(half.arms[i], arm, half.z))
        const top = offset(points, DECK_THICKNESS).map(to3)
        const foot = unit(sub(to3(points[4]), to3(points[3])))
        half.retainer.position.set(top[4].x, top[4].y, half.z)
        half.retainer.rotation.z = Math.atan2(foot.y, foot.x)
        const rest = pillow(points)
        const center = to3(rest.center)
        half.pillow.position.set(center.x, center.y, half.z - 0.65)
        half.pillow.rotation.z = -rest.angle * Math.PI / 180
        half.pillow.visible = mattress
        half.mattress = replace(half.mattress, mattress
          ? extrudeSlab(slab(offset(mattressBase(points), MATTRESS_BEVEL * UNIT), MATTRESS_THICKNESS - 2 * MATTRESS_BEVEL * UNIT), MATTRESS_DEPTH, half.z, mattressMaterials, MATTRESS_BEVEL)
          : null)
        half.built = { ...state.pose }
        changed = true
      }
      const ghostVisible = state.moving
      if (!ghostVisible && half.ghost) {
        half.ghost = replace(half.ghost, null)
        half.ghostBuilt = undefined
        changed = true
      }
      else if (ghostVisible && (moved(half.ghostBuilt, state.target) || half.model !== model || !half.ghost)) {
        const points = profile(state.target)
        const ghost = extrudeSlab(mattress ? slab(mattressBase(points), MATTRESS_THICKNESS) : slab(points, DECK_THICKNESS), HALF_WIDTH, half.z, ghostMaterial)
        ghost.renderOrder = 1
        half.ghost = replace(half.ghost, ghost)
        half.ghostBuilt = { ...state.target }
        changed = true
      }
      half.model = model
    }
    return changed
  }

  function dispose() {
    for (const geometry of geometries) geometry.dispose()
    for (const m of materials) m.dispose()
    geometries.clear()
    root.clear()
  }

  return { root, update, dispose, geometryCount: () => geometries.size }
}
