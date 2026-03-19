'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnSensorFrame, type PiezoDualFrame, type SensorFrame } from '@/src/hooks/useSensorStream'

/** Maximum samples to keep in the waveform buffer per channel. */
const MAX_SAMPLES = 1500
/** Downsampled point target for rendering (~200 points, matching iOS). */
const RENDER_TARGET_POINTS = 200
/** Minimum samples before rendering a trace (matching iOS guard). */
const MIN_SAMPLES = 20
/** Canvas height in CSS pixels. */
const CANVAS_HEIGHT = 160
/** Left channel color (matches iOS). */
const LEFT_COLOR = '#4a9eff'
/** Right channel color (matches iOS). */
const RIGHT_COLOR = '#40e0d0'
/** Minor grid line color (matching iOS "0a1018"). */
const GRID_MINOR_COLOR = '#0a1018'
/** Major grid line color (matching iOS "0f1a2a"). */
const GRID_MAJOR_COLOR = '#1a2a3a'
/** Background color. */
const BG_COLOR = '#09090b'

// ---------------------------------------------------------------------------
// Catmull-Rom interpolation helpers (matching iOS tracePath)
// ---------------------------------------------------------------------------

interface Point {
  x: number
  y: number
}

/**
 * Downsample raw samples using bucket-averaging (matching iOS approach).
 * Returns approximately `target` averaged points.
 */
function downsampleAvg(samples: number[], target: number): number[] {
  if (samples.length <= target) return samples
  const step = Math.max(1, Math.floor(samples.length / target))
  const n = Math.floor(samples.length / step)
  const result: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const lo = i * step
    const hi = Math.min(lo + step, samples.length)
    let sum = 0
    for (let j = lo; j < hi; j++) sum += samples[j]
    result[i] = sum / (hi - lo)
  }
  return result
}

/**
 * Compute shared min/max range across both channels with 10% padding.
 * Matching iOS `sharedRange` — both traces share the same Y-axis scale.
 */
function sharedRange(a: number[], b: number[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of a) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  for (const v of b) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!isFinite(lo) || !isFinite(hi) || lo >= hi) return [0, 1]
  const pad = (hi - lo) * 0.1
  return [lo - pad, hi + pad]
}

/**
 * Build an array of points from averaged samples, mapping to canvas coords.
 */
function buildPoints(
  samples: number[],
  w: number,
  h: number,
  rMin: number,
  range: number
): Point[] {
  const downsampled = downsampleAvg(samples, RENDER_TARGET_POINTS)
  if (downsampled.length < 2) return []

  const pts: Point[] = new Array(downsampled.length)
  for (let i = 0; i < downsampled.length; i++) {
    const norm = (downsampled[i] - rMin) / range
    const x = (i / (downsampled.length - 1)) * w
    const y = h * (1 - norm)
    // Clamp y to canvas bounds (matching iOS min/max clamping)
    pts[i] = {
      x: isFinite(x) ? x : 0,
      y: isFinite(y) ? Math.min(Math.max(y, 0), h) : h / 2,
    }
  }
  return pts
}

/**
 * Draw a Catmull-Rom interpolated trace on the canvas context.
 * Matches iOS `tracePath` which uses cubic Bézier with Catmull-Rom tangents:
 *   cp1 = p1 + (p2 - p0) / 6
 *   cp2 = p2 - (p3 - p1) / 6
 */
function drawCatmullRomTrace(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string,
  dpr: number
) {
  if (pts.length < 2) return

  ctx.strokeStyle = color
  ctx.lineWidth = 1.5 * dpr
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(i + 2, pts.length - 1)]

    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6

    if (isFinite(cp1x) && isFinite(cp1y) && isFinite(cp2x) && isFinite(cp2y)) {
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
    } else {
      ctx.lineTo(p2.x, p2.y)
    }
  }

  ctx.stroke()
}

// ---------------------------------------------------------------------------
// Grid drawing
// ---------------------------------------------------------------------------

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) {
  // Minor grid lines (matching iOS: dynamic column count, 8 rows)
  ctx.strokeStyle = GRID_MINOR_COLOR
  ctx.lineWidth = 0.5 * dpr

  // Vertical minor grid (spaced ~25 CSS px apart, matching iOS)
  const cols = Math.max(1, Math.floor(w / (25 * dpr)))
  for (let i = 1; i < cols; i++) {
    const x = Math.round((i / cols) * w) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }

  // Horizontal minor grid (8 divisions, matching iOS)
  for (let i = 1; i < 8; i++) {
    const y = Math.round((i / 8) * h) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }

  // Major center crosshair lines (matching iOS major color)
  ctx.strokeStyle = GRID_MAJOR_COLOR
  ctx.lineWidth = 0.8 * dpr

  // Horizontal center
  const cy = Math.round(h / 2) + 0.5
  ctx.beginPath()
  ctx.moveTo(0, cy)
  ctx.lineTo(w, cy)
  ctx.stroke()

  // Vertical center
  const cx = Math.round(w / 2) + 0.5
  ctx.beginPath()
  ctx.moveTo(cx, 0)
  ctx.lineTo(cx, h)
  ctx.stroke()
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Canvas-based real-time piezo waveform display.
 *
 * Renders dual-channel BCG signals (left/right sides) as continuous
 * oscilloscope traces with Catmull-Rom interpolation for smooth curves.
 * Uses requestAnimationFrame for 60fps rendering.
 *
 * Matches iOS PiezoWaveformView:
 *  - Shared Y-axis range across both channels
 *  - Bucket-averaging downsampling (~200 target points)
 *  - Catmull-Rom spline interpolation
 *  - Minor/major grid lines with center crosshair
 *  - Legend dots with Left/Right channel toggles
 */
export function PiezoWaveform() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Waveform buffers (mutated in-place for performance — no React state)
  const leftBufferRef = useRef<number[]>([])
  const rightBufferRef = useRef<number[]>([])
  const freqRef = useRef<number>(0)
  const hasDataRef = useRef(false)
  const animFrameRef = useRef<number>(0)

  // Track visibility for channel toggles
  const [showLeft, setShowLeft] = useState(true)
  const [showRight, setShowRight] = useState(true)
  // Reactive sample counts (updated on each frame for display)
  const [sampleCounts, setSampleCounts] = useState({ left: 0, right: 0 })

  // Receive piezo frames and append to buffers
  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    if (frame.type !== 'piezo-dual') return
    const piezo = frame as PiezoDualFrame

    hasDataRef.current = true
    freqRef.current = piezo.freq ?? freqRef.current

    // Append and trim left
    const left = leftBufferRef.current
    left.push(...piezo.left1)
    if (left.length > MAX_SAMPLES) {
      leftBufferRef.current = left.slice(-MAX_SAMPLES)
    }

    // Append and trim right
    const right = rightBufferRef.current
    right.push(...piezo.right1)
    if (right.length > MAX_SAMPLES) {
      rightBufferRef.current = right.slice(-MAX_SAMPLES)
    }

    // Update reactive sample counts (throttled via RAF)
    setSampleCounts({
      left: leftBufferRef.current.length,
      right: rightBufferRef.current.length,
    })
  }, []))

  // Canvas rendering loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    function render() {
      if (!canvas || !ctx) return

      const dpr = window.devicePixelRatio || 1

      // Resize canvas if container changed
      const container = containerRef.current
      if (container) {
        const rect = container.getBoundingClientRect()
        const newWidth = Math.floor(rect.width * dpr)
        const newHeight = CANVAS_HEIGHT * dpr
        if (canvas.width !== newWidth || canvas.height !== newHeight) {
          canvas.width = newWidth
          canvas.height = newHeight
          canvas.style.width = `${rect.width}px`
          canvas.style.height = `${CANVAS_HEIGHT}px`
        }
      }

      const w = canvas.width
      const h = canvas.height

      // Clear
      ctx.fillStyle = BG_COLOR
      ctx.fillRect(0, 0, w, h)

      // Draw grid (minor + major)
      drawGrid(ctx, w, h, dpr)

      if (!hasDataRef.current) {
        // "No data" text
        ctx.fillStyle = '#52525b'
        ctx.font = `${12 * dpr}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('Waiting for piezo data…', w / 2, h / 2)
        animFrameRef.current = requestAnimationFrame(render)
        return
      }

      const leftSamples = leftBufferRef.current
      const rightSamples = rightBufferRef.current

      // Compute shared range across both visible channels (matching iOS)
      const visibleLeft = showLeft ? leftSamples : []
      const visibleRight = showRight ? rightSamples : []

      if (visibleLeft.length < MIN_SAMPLES && visibleRight.length < MIN_SAMPLES) {
        // Not enough data yet
        ctx.fillStyle = '#52525b'
        ctx.font = `${11 * dpr}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('Collecting samples…', w / 2, h / 2)
        animFrameRef.current = requestAnimationFrame(render)
        return
      }

      const [rMin, rMax] = sharedRange(visibleLeft, visibleRight)
      const range = rMax - rMin
      if (range <= 0 || !isFinite(range)) {
        animFrameRef.current = requestAnimationFrame(render)
        return
      }

      // Build and draw Catmull-Rom interpolated traces
      if (showLeft && leftSamples.length >= MIN_SAMPLES) {
        const pts = buildPoints(leftSamples, w, h, rMin, range)
        drawCatmullRomTrace(ctx, pts, LEFT_COLOR, dpr)
      }

      if (showRight && rightSamples.length >= MIN_SAMPLES) {
        const pts = buildPoints(rightSamples, w, h, rMin, range)
        drawCatmullRomTrace(ctx, pts, RIGHT_COLOR, dpr)
      }

      // Frequency label (top-right)
      if (freqRef.current > 0) {
        ctx.fillStyle = '#52525b'
        const fontSize = 10 * dpr
        ctx.font = `${fontSize}px monospace`
        ctx.textAlign = 'right'
        ctx.fillText(`${freqRef.current} Hz`, w - 8 * dpr, 16 * dpr)
      }

      animFrameRef.current = requestAnimationFrame(render)
    }

    animFrameRef.current = requestAnimationFrame(render)

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
      }
    }
  }, [showLeft, showRight])

  return (
    <div className="space-y-2">
      {/* Header with title and legend/toggles */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <svg
            className="h-3.5 w-3.5 text-blue-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 12h2l3-7 4 14 4-10 3 3h4" />
          </svg>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Piezo Waveform
          </h3>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowLeft(v => !v)}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              showLeft
                ? 'bg-[#4a9eff]/15 text-[#4a9eff]'
                : 'bg-zinc-800 text-zinc-500'
            }`}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: showLeft ? LEFT_COLOR : '#52525b' }}
            />
            Left
          </button>
          <button
            onClick={() => setShowRight(v => !v)}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              showRight
                ? 'bg-[#40e0d0]/15 text-[#40e0d0]'
                : 'bg-zinc-800 text-zinc-500'
            }`}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: showRight ? RIGHT_COLOR : '#52525b' }}
            />
            Right
          </button>
        </div>
      </div>

      {/* Canvas waveform display */}
      <div ref={containerRef} className="overflow-hidden rounded-xl border border-[#1a2a3a]/50 bg-[#020208]">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: `${CANVAS_HEIGHT}px`, display: 'block' }}
        />
      </div>

      {/* Sample count footer */}
      <div className="flex justify-between text-[10px] text-zinc-600">
        <span>L: {sampleCounts.left} samples</span>
        <span>R: {sampleCounts.right} samples</span>
      </div>
    </div>
  )
}
