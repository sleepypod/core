// three.js chart scene shared by every 3D chart: series laid out as ribbons, lines or
// bars in depth lanes over a floor grid, with a loading wave that sweeps into the data.
// Core three.js build only, unlit materials, transparent so the card shows through.

import type * as T from 'three'
import type { Three } from '@/src/components/Base/loadThree'
import { attachOrbit, createLabels, fitCamera, orbitDirection } from './chart3dKit'
import type { ColorResolver, Label } from './chart3dKit'

export type { ColorResolver } from './chart3dKit'

export type Chart3DState = 'loading' | 'ready' | 'empty' | 'error'
export type SeriesKind = 'ribbon' | 'line' | 'bars'

export interface Chart3DSeriesSpec {
  kind: SeriesKind
  /** Depth lane, front first; series on one lane overlay. Defaults to the series index. */
  lane?: number
  /** Lane name drawn at the left end of the floor. */
  label?: string
  dashed?: boolean
}

export interface Chart3DSpec {
  series: Chart3DSeriesSpec[]
  /** Camera orbit around the scene (radians): yaw turns it, pitch raises it. */
  yaw?: number
  pitch?: number
  /** Ribbon and line samples; bars draw one per point. */
  samples?: number
  /** Bars drawn by the loading wave before the real count is known. */
  skeletonBars?: number
  /** Room kept for labels from the first frame, so nothing reflows when data lands. */
  reserve?: { yTicks?: boolean, values?: boolean, xTicks?: boolean, now?: boolean }
}

export interface Chart3DPoint { x: number, y: number | null }

export interface Chart3DSeries {
  /** x and y both normalised to 0..1, sorted by x; a null y breaks the series. */
  points: Chart3DPoint[]
  /** Any CSS colour, `var(--token)` included. */
  color: string
  /** Colour stops along x that tint the series instead of `color`. */
  stops?: Array<{ x: number, color: string }>
  /** Shown beside the series' last point once the data has landed. */
  value?: string
}

export interface Chart3DData {
  /** Same order as the spec's series. */
  series: Chart3DSeries[]
  xTicks?: Array<{ x: number, label: string }>
  yTicks?: Array<{ y: number, label: string }>
  now?: { x: number, label?: string } | null
}

export interface Chart3DScene {
  setState: (state: Chart3DState) => void
  /** Store the data and show it: sweeps in from the wave, or tweens from what is on screen. */
  setData: (data: Chart3DData) => void
  /** Re-read every CSS colour after a theme change. */
  recolor: () => void
  dispose: () => void
}

const WORLD = {
  width: 10,
  height: 2,
  laneGap: 1.3,
  band: 0.42,
  line: 0.1,
  barDepth: 0.3,
  fov: 26,
} as const

export const MOTION = {
  sweepMs: 1300,
  tweenMs: 600,
  waveSpeed: 3.2,
  waveFreq: 9,
} as const

const PALETTE = {
  skeleton: 'var(--text-3)',
  grid: 'var(--border-2)',
  axis: 'var(--text-3)',
  lane: 'var(--text-2)',
  value: 'var(--text-1)',
  now: 'var(--text-1)',
} as const

const LABEL_PX = { axis: 11, lane: 11, value: 12 } as const
const SKELETON_ALPHA = 0.5
const MAX_BARS = 512

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3
const easeInOutCubic = (t: number) => {
  const c = clamp01(t)
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2
}

/** The loading wave's height (0..1) at sample i of n. */
export function wave(i: number, n: number, seconds: number, lane = 0) {
  return 0.1 + 0.06 * Math.sin((i / Math.max(1, n)) * MOTION.waveFreq - seconds * MOTION.waveSpeed + lane * 0.8)
}

/** Blend weight of sample i of n at sweep progress p: left to right, each easing out. */
export function sweepWeight(p: number, i: number, n: number) {
  return easeOutCubic(p * 1.5 - (i / Math.max(1, n - 1)) * 0.5)
}

/**
 * Linear resample at n evenly spaced x in 0..1. Outside the series, or across a null
 * neighbour, the sample is null so gaps stay gaps.
 */
export function resample(points: Chart3DPoint[], n: number): Array<number | null> {
  const out: Array<number | null> = Array.from({ length: n }, () => null)
  if (points.length === 0) return out
  let j = 0
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1)
    if (x < points[0].x || x > points[points.length - 1].x) continue
    while (j < points.length - 2 && points[j + 1].x < x) j++
    const a = points[j]
    const b = points[Math.min(j + 1, points.length - 1)]
    if (a.y == null || b.y == null) {
      const near = Math.abs(x - a.x) <= Math.abs(b.x - x) ? a : b
      out[i] = near.x === x ? near.y : null
      continue
    }
    const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x)
    out[i] = a.y + (b.y - a.y) * t
  }
  return out
}

/** The colour at x along stops sorted by x, blended between neighbours. */
function stopColor(stops: Array<{ x: number, color: T.Color }>, x: number, out: T.Color) {
  if (x <= stops[0].x) return out.copy(stops[0].color)
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (x <= b.x) return out.copy(a.color).lerp(b.color, b.x === a.x ? 1 : (x - a.x) / (b.x - a.x))
  }
  return out.copy(stops[stops.length - 1].color)
}

interface SeriesView {
  spec: Chart3DSeriesSpec
  lane: number
  n: number
  /** What the series moves toward, and where it started from in a tween. */
  target: Float32Array
  targetAlpha: Float32Array
  targetColor: Float32Array
  from: Float32Array
  fromAlpha: Float32Array
  fromColor: Float32Array
  /** What is on screen this frame. */
  y: Float32Array
  alpha: Float32Array
  color: Float32Array
  mesh: T.Mesh | T.InstancedMesh
  value: Label | null
  lastIndex: number
}

export function mountChart3DScene(THREE: Three, host: HTMLElement, spec: Chart3DSpec, resolve: ColorResolver, onFail: () => void): Chart3DScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'display:block;width:100%;height:100%'
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(WORLD.fov, 1, 0.1, 400)
  const disposables: { dispose: () => void }[] = []
  const track = <D extends { dispose: () => void }>(d: D) => {
    disposables.push(d)
    return d
  }

  const lanes = Math.max(1, ...spec.series.map((s, i) => (s.lane ?? i) + 1))
  const laneZ = (lane: number) => -lane * WORLD.laneGap
  const front = WORLD.band / 2
  const back = laneZ(lanes - 1) - WORLD.band / 2
  const xOf = (x: number) => (x - 0.5) * WORLD.width
  const samples = spec.samples ?? 120

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  let state: Chart3DState = 'loading'
  let data: Chart3DData | null = null
  let mode: 'sweep' | 'tween' = 'sweep'
  let startedAt = 0
  let frozenAt = 0
  let frame = 0
  let visible = true
  let disposed = false
  let sizeDirty = true

  const palette = { skeleton: new THREE.Color(), grid: new THREE.Color(), now: new THREE.Color() }
  const colorOf = (css: string, out = new THREE.Color()) => {
    try {
      return out.setStyle(resolve(css))
    }
    catch {
      return out.set(0x888888)
    }
  }

  const labels = createLabels(THREE, scene, host, camera, resolve, () => {
    sizeDirty = true
    requestRender()
  })

  // ── Grid: lane lines, x ticks across the floor, y ticks on the back wall ──
  const gridMaterial = track(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }))
  const grid = new THREE.LineSegments(track(new THREE.BufferGeometry()), gridMaterial)
  grid.renderOrder = 0
  scene.add(grid)
  const laneLabels = spec.series.flatMap((s, i) => s.label
    ? [{ label: labels.make(s.label, PALETTE.lane, LABEL_PX.lane, 'right'), lane: s.lane ?? i }]
    : [])
  for (const { label, lane } of laneLabels) label.sprite.position.set(xOf(0) - 0.18, 0.04, laneZ(lane))
  let tickLabels: Label[] = []
  let xTickLabels: Label[] = []
  const buildGrid = () => {
    const pts: number[] = []
    const seg = (a: [number, number, number], b: [number, number, number]) => pts.push(...a, ...b)
    for (let lane = 0; lane < lanes; lane++) seg([xOf(0), 0, laneZ(lane) + front], [xOf(1), 0, laneZ(lane) + front])
    seg([xOf(0), 0, back], [xOf(1), 0, back])
    for (const t of data?.xTicks ?? []) seg([xOf(t.x), 0, front + 0.12], [xOf(t.x), 0, back])
    for (const t of data?.yTicks ?? []) seg([xOf(0), t.y * WORLD.height, back], [xOf(1), t.y * WORLD.height, back])
    grid.geometry.dispose()
    grid.geometry = new THREE.BufferGeometry()
    grid.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    for (const l of tickLabels) labels.drop(l)
    xTickLabels = (data?.xTicks ?? []).map((t) => {
      const l = labels.make(t.label, PALETTE.axis, LABEL_PX.axis, 'below')
      l.sprite.position.set(xOf(t.x), 0, front + 0.3)
      return l
    })
    tickLabels = [
      ...xTickLabels,
      ...(data?.yTicks ?? []).map((t) => {
        const l = labels.make(t.label, PALETTE.axis, LABEL_PX.axis, 'right')
        l.sprite.position.set(xOf(0) - 0.12, t.y * WORLD.height, back)
        return l
      }),
    ]
  }

  // ── "Now": a translucent plane through every lane ─────────────────────────
  const nowMaterial = track(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }))
  const nowPlane = new THREE.Mesh(track(new THREE.PlaneGeometry(front - back + 0.2, WORLD.height * 1.08)), nowMaterial)
  nowPlane.rotation.y = Math.PI / 2
  nowPlane.position.set(0, (WORLD.height * 1.08) / 2, (front + back) / 2)
  nowPlane.renderOrder = 50
  nowPlane.visible = false
  scene.add(nowPlane)
  const nowEdgeMaterial = track(new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
  const nowEdge = new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, front + 0.1),
    new THREE.Vector3(0, WORLD.height * 1.08, front + 0.1),
  ])), nowEdgeMaterial)
  nowEdge.renderOrder = 51
  nowEdge.visible = false
  scene.add(nowEdge)
  let nowLabel: Label | null = null

  // ── Series ─────────────────────────────────────────────────────────────────
  const barGeometry = (() => {
    const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
    const normal = g.getAttribute('normal')
    const shade: number[] = []
    for (let i = 0; i < normal.count; i++) {
      const s = normal.getY(i) > 0.5 ? 1 : normal.getZ(i) > 0.5 ? 0.74 : Math.abs(normal.getX(i)) > 0.5 ? 0.58 : 0.45
      shade.push(s, s, s)
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3))
    return track(g)
  })()

  const ribbonGeometry = (n: number, kind: SeriesKind) => {
    const per = kind === 'ribbon' ? 4 : 2
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * per * 3), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * per * 4), 4))
    const index: number[] = []
    for (let i = 0; i < n - 1; i++) {
      const a = i * per
      const b = (i + 1) * per
      index.push(a, a + 1, b, a + 1, b + 1, b)
      if (per === 4) index.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2)
    }
    g.setIndex(index)
    return g
  }

  const views: SeriesView[] = spec.series.map((s, i) => {
    const lane = s.lane ?? i
    const bars = s.kind === 'bars'
    const n = bars ? MAX_BARS : samples
    let mesh: T.Mesh | T.InstancedMesh
    if (bars) {
      const inst = new THREE.InstancedMesh(barGeometry, track(new THREE.MeshBasicMaterial({ vertexColors: true })), MAX_BARS)
      inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BARS * 3), 3)
      inst.count = spec.skeletonBars ?? 40
      inst.frustumCulled = false
      mesh = inst
    }
    else {
      mesh = new THREE.Mesh(
        track(ribbonGeometry(n, s.kind)),
        track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide })),
      )
      mesh.frustumCulled = false
    }
    // Back lanes first so translucent fronts blend over them; lines over ribbons.
    mesh.renderOrder = 10 + (lanes - lane) * 3 + (s.kind === 'line' ? 1 : 0)
    scene.add(mesh)
    const f = () => new Float32Array(n)
    return {
      spec: s, lane, n: bars ? (spec.skeletonBars ?? 40) : n,
      target: f(), targetAlpha: f(), targetColor: new Float32Array(n * 3),
      from: f(), fromAlpha: f(), fromColor: new Float32Array(n * 3),
      y: f(), alpha: f(), color: new Float32Array(n * 3),
      mesh, value: null, lastIndex: -1,
    }
  })

  const scratch = new THREE.Color()
  const loadTargets = () => {
    views.forEach((v, si) => {
      const series = data?.series[si]
      const base = colorOf(series?.color ?? PALETTE.skeleton)
      const stops = series?.stops?.length ? series.stops.map(s => ({ x: s.x, color: colorOf(s.color) })) : null
      const empty = state === 'empty' || !series
      if (v.spec.kind === 'bars') {
        const pts = empty ? [] : series.points
        v.n = Math.min(MAX_BARS, empty ? (spec.skeletonBars ?? 40) : pts.length)
        ;(v.mesh as T.InstancedMesh).count = v.n
        for (let i = 0; i < v.n; i++) {
          v.target[i] = empty ? 0.004 : clamp01(pts[i].y ?? 0)
          v.targetAlpha[i] = 1
          const c = empty ? palette.skeleton : stops ? stopColor(stops, pts[i].x, scratch) : base
          v.targetColor.set([c.r, c.g, c.b], i * 3)
        }
        v.lastIndex = v.n - 1
        return
      }
      const ys = empty ? Array.from({ length: v.n }, () => 0.004) : resample(series.points, v.n)
      v.lastIndex = -1
      for (let i = 0; i < v.n; i++) {
        const y = ys[i]
        v.target[i] = y == null ? (i > 0 ? v.target[i - 1] : 0) : clamp01(y)
        v.targetAlpha[i] = y == null ? 0 : 1
        if (y != null) v.lastIndex = i
        const c = empty ? palette.skeleton : stops ? stopColor(stops, i / (v.n - 1), scratch) : base
        v.targetColor.set([c.r, c.g, c.b], i * 3)
      }
      // Gaps hold the next real height so the fade into them doesn't dive to the floor.
      for (let i = v.n - 2; i >= 0; i--) if (v.targetAlpha[i] === 0 && v.targetAlpha[i + 1] === 1) v.target[i] = v.target[i + 1]
    })
  }

  const syncValueLabels = () => {
    views.forEach((v, si) => {
      const text = state === 'ready' ? data?.series[si]?.value : undefined
      if (!text) {
        labels.drop(v.value)
        v.value = null
        return
      }
      if (v.value) labels.setText(v.value, text)
      else v.value = labels.make(text, PALETTE.value, LABEL_PX.value, 'left')
    })
    const now = state === 'ready' ? data?.now : null
    nowPlane.visible = nowEdge.visible = now != null
    if (now) {
      nowPlane.position.x = nowEdge.position.x = xOf(now.x)
      if (now.label) {
        if (nowLabel) labels.setText(nowLabel, now.label)
        else nowLabel = labels.make(now.label, PALETTE.now, LABEL_PX.axis, 'left')
        nowLabel.sprite.position.set(xOf(now.x) + 0.1, WORLD.height * 1.08, front + 0.1)
      }
    }
    if (!now?.label) {
      labels.drop(nowLabel)
      nowLabel = null
    }
  }

  // ── Per-frame animation ────────────────────────────────────────────────────
  /** Progress 0..1 of the current sweep or tween; 1 when settled. */
  const progress = (now: number) => {
    if (state === 'loading' || reduced.matches) return state === 'loading' ? 0 : 1
    if (state === 'error') return 0
    return clamp01((now - startedAt) / (mode === 'sweep' ? MOTION.sweepMs : MOTION.tweenMs))
  }

  const animate = (now: number) => {
    const p = progress(now)
    const seconds = reduced.matches ? 0 : (state === 'error' ? frozenAt : now) / 1000
    const dim = state === 'error' ? 0.45 : 1
    const sk = palette.skeleton
    for (const v of views) {
      for (let i = 0; i < v.n; i++) {
        const w = wave(i, v.n, seconds, v.lane)
        let e: number
        let y0: number, a0: number, r0: number, g0: number, b0: number
        if (state === 'loading' || state === 'error') {
          e = 0
          y0 = w
          a0 = SKELETON_ALPHA * dim
          r0 = sk.r
          g0 = sk.g
          b0 = sk.b
        }
        else if (mode === 'sweep') {
          e = reduced.matches ? 1 : sweepWeight(p, i, v.n)
          y0 = w
          a0 = SKELETON_ALPHA
          r0 = sk.r
          g0 = sk.g
          b0 = sk.b
        }
        else {
          e = easeInOutCubic(p)
          y0 = v.from[i]
          a0 = v.fromAlpha[i]
          r0 = v.fromColor[i * 3]
          g0 = v.fromColor[i * 3 + 1]
          b0 = v.fromColor[i * 3 + 2]
        }
        v.y[i] = y0 + (v.target[i] - y0) * e
        v.alpha[i] = a0 + (v.targetAlpha[i] - a0) * e
        v.color[i * 3] = r0 + (v.targetColor[i * 3] - r0) * e
        v.color[i * 3 + 1] = g0 + (v.targetColor[i * 3 + 1] - g0) * e
        v.color[i * 3 + 2] = b0 + (v.targetColor[i * 3 + 2] - b0) * e
      }
      writeSeries(v)
    }
    const shown = state === 'ready' ? easeOutCubic(p * 1.4 - 0.4) : 0
    nowMaterial.opacity = 0.07 * shown
    nowEdgeMaterial.opacity = 0.5 * shown
    for (const v of views) {
      if (!v.value) continue
      const i = Math.max(0, v.lastIndex)
      const x = v.spec.kind === 'bars' ? barX(i, v.n) : i / (v.n - 1)
      v.value.sprite.position.set(xOf(x) + 0.14, v.y[i] * WORLD.height + 0.08, laneZ(v.lane))
      v.value.material.opacity = shown
    }
    if (nowLabel) nowLabel.material.opacity = shown
    return state === 'loading' ? !reduced.matches : (state === 'ready' || state === 'empty') && p < 1
  }

  const barX = (i: number, n: number) => (i + 0.5) / n
  const matrix = new THREE.Matrix4()
  const writeSeries = (v: SeriesView) => {
    const z = laneZ(v.lane)
    if (v.spec.kind === 'bars') {
      const inst = v.mesh as T.InstancedMesh
      const width = Math.min(0.22, (WORLD.width / v.n) * 0.6)
      for (let i = 0; i < v.n; i++) {
        matrix.makeScale(width, Math.max(0.004, v.y[i]) * WORLD.height, WORLD.barDepth)
        matrix.setPosition(xOf(barX(i, v.n)), 0, z)
        inst.setMatrixAt(i, matrix)
        inst.instanceColor?.setXYZ(i, v.color[i * 3], v.color[i * 3 + 1], v.color[i * 3 + 2])
      }
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      return
    }
    const geometry = (v.mesh as T.Mesh).geometry
    const pos = geometry.getAttribute('position') as T.BufferAttribute
    const col = geometry.getAttribute('color') as T.BufferAttribute
    const ribbon = v.spec.kind === 'ribbon'
    const half = (ribbon ? WORLD.band : WORLD.line) / 2
    const lift = ribbon ? 0 : 0.012
    const per = ribbon ? 4 : 2
    for (let i = 0; i < v.n; i++) {
      const x = xOf(i / (v.n - 1))
      const y = v.y[i] * WORLD.height + lift
      const dash = v.spec.dashed && Math.floor(i / 2) % 2 === 1 ? 0 : 1
      const a = v.alpha[i] * dash
      const [r, g, b] = [v.color[i * 3], v.color[i * 3 + 1], v.color[i * 3 + 2]]
      const k = i * per
      pos.setXYZ(k, x, y, z + half)
      pos.setXYZ(k + 1, x, y, z - half)
      col.setXYZW(k, r, g, b, a)
      col.setXYZW(k + 1, r * 0.82, g * 0.82, b * 0.82, a)
      if (ribbon) {
        pos.setXYZ(k + 2, x, y, z + half)
        pos.setXYZ(k + 3, x, 0, z + half)
        col.setXYZW(k + 2, r, g, b, a * 0.34)
        col.setXYZW(k + 3, r, g, b, 0)
      }
    }
    pos.needsUpdate = true
    col.needsUpdate = true
  }

  // ── Fit: pull the camera back until the scene fills the box less its label margins ─
  const target = new THREE.Vector3(0, WORLD.height * 0.45, (front + back) / 2)
  const home = { yaw: spec.yaw ?? 0.16, pitch: spec.pitch ?? 0.32 }
  let direction = orbitDirection(THREE, home.yaw, home.pitch)
  const corners: T.Vector3[] = []
  for (const x of [xOf(0), xOf(1)]) for (const y of [0, WORLD.height * 1.08]) for (const z of [front, back]) corners.push(new THREE.Vector3(x, y, z))
  /** Pixel margins: lane names and y ticks on the left, values on the right, x ticks below. */
  const margins = () => {
    const r = spec.reserve ?? {}
    const lane = Math.max(0, ...spec.series.map(s => (s.label ? labels.width(s.label, LABEL_PX.lane) : 0)))
    return {
      left: 6 + Math.max(lane + 10, r.yTicks ? 34 : 0),
      right: r.values ? 52 : 8,
      bottom: r.xTicks === false ? 4 : 20,
      top: r.now ? 20 : 6,
    }
  }
  const fit = () => fitCamera(renderer, camera, host, corners, target, direction, margins())

  // ── Screen-space label layout: thin colliding x ticks, stack value labels ──
  const px = new THREE.Vector3()
  const toScreen = (o: T.Object3D) => {
    o.getWorldPosition(px).project(camera)
    return { x: ((px.x + 1) / 2) * host.clientWidth, y: ((1 - px.y) / 2) * host.clientHeight }
  }
  const layoutLabels = () => {
    if (!labels.ready) return
    let right = -Infinity
    for (const label of xTickLabels) {
      const { x } = toScreen(label.sprite)
      const half = (LABEL_PX.axis * label.aspect) / 2
      label.sprite.visible = x - half > right + 8
      if (label.sprite.visible) right = x + half
    }
    const values = views.flatMap(v => (v.value ? [{ label: v.value, y: toScreen(v.value.sprite).y }] : [])).sort((a, b) => a.y - b.y)
    let prev = -Infinity
    for (const item of values) {
      const y = Math.max(item.y, prev + LABEL_PX.value + 3)
      item.label.sprite.center.y = 0.5 + (y - item.y) / LABEL_PX.value
      prev = y
    }
  }

  // ── Loop ───────────────────────────────────────────────────────────────────
  const render = (now: number) => {
    frame = 0
    if (disposed || document.hidden || !visible) return
    if (sizeDirty) sizeDirty = !fit()
    const moving = animate(now)
    labels.size()
    layoutLabels()
    renderer.render(scene, camera)
    if (moving) frame = requestAnimationFrame(render)
  }
  const requestRender = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(render)
  }

  const recolor = () => {
    colorOf(PALETTE.skeleton, palette.skeleton)
    colorOf(PALETTE.grid, palette.grid)
    colorOf(PALETTE.now, palette.now)
    gridMaterial.color.copy(palette.grid)
    nowMaterial.color.copy(palette.now)
    nowEdgeMaterial.color.copy(palette.now)
    labels.redraw()
    loadTargets()
    requestRender()
  }

  const resizeObserver = new ResizeObserver(() => {
    sizeDirty = true
    requestRender()
  })
  resizeObserver.observe(host)
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    requestRender()
  })
  intersection.observe(host)
  const lost = (event: Event) => {
    event.preventDefault()
    onFail()
  }
  canvas.addEventListener('webglcontextlost', lost)
  document.addEventListener('visibilitychange', requestRender)
  reduced.addEventListener('change', requestRender)
  host.appendChild(canvas)

  const detachOrbit = attachOrbit(canvas, home, (yaw, pitch) => {
    direction = orbitDirection(THREE, yaw, pitch)
    sizeDirty = true
    requestRender()
  })

  recolor()
  buildGrid()

  return {
    setState(next) {
      if (next === state && next !== 'loading') return
      const prev = state
      state = next
      if (next === 'error') frozenAt = performance.now()
      if (next === 'ready' || next === 'empty') {
        mode = 'sweep'
        startedAt = performance.now()
        if (prev === next) return
        loadTargets()
      }
      syncValueLabels()
      sizeDirty = true
      requestRender()
    },
    setData(next) {
      const settled = state === 'ready' && progress(performance.now()) >= 1
      // Background refresh: tween from what is on screen instead of replaying the sweep.
      const sameShape = views.every(v => v.spec.kind !== 'bars' || v.n === next.series[views.indexOf(v)]?.points.length)
      if (settled && sameShape) {
        for (const v of views) {
          v.from.set(v.y)
          v.fromAlpha.set(v.alpha)
          v.fromColor.set(v.color)
        }
        mode = 'tween'
        startedAt = performance.now()
      }
      else if (state !== 'ready') {
        mode = 'sweep'
        startedAt = performance.now()
      }
      data = next
      state = 'ready'
      loadTargets()
      buildGrid()
      syncValueLabels()
      sizeDirty = true
      requestRender()
    },
    recolor,
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      intersection.disconnect()
      document.removeEventListener('visibilitychange', requestRender)
      reduced.removeEventListener('change', requestRender)
      canvas.removeEventListener('webglcontextlost', lost)
      detachOrbit()
      labels.dispose()
      grid.geometry.dispose()
      for (const d of disposables) d.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
