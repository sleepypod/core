'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSensorStream } from '@/src/hooks/useSensorStream'
import { Card, HoverMark, SectionLabel, Slider } from '@/src/components/ds'
import { cn } from '@/lib/utils'

/** Maximum samples to keep in the waveform buffer per channel. */
const MAX_SAMPLES = 10_000
/** Downsampled point target for rendering (~200 points, matching iOS). */
const RENDER_TARGET_POINTS = 200
/** Minimum samples before rendering a trace (matching iOS guard). */
const MIN_SAMPLES = 20
/** Canvas height in CSS pixels. */
const CANVAS_HEIGHT = 96

/** Theme colors resolved from CSS tokens (refreshed periodically so theme switches apply). */
interface WaveColors {
  left: string
  right: string
  grid: string
  gridMajor: string
  text: string
}

function readColors(): WaveColors {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    left: v('--accent-cool', '#7ab5e0'),
    right: v('--accent-warm', '#e0976a'),
    grid: v('--border-grid', '#16161a'),
    gridMajor: v('--border-1', '#1f1f22'),
    text: v('--text-3', '#5d5d63'),
  }
}

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
    }
    else {
      ctx.lineTo(p2.x, p2.y)
    }
  }

  ctx.stroke()
}

// ---------------------------------------------------------------------------
// Grid drawing
// ---------------------------------------------------------------------------

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, colors: WaveColors) {
  // Minor grid lines (matching iOS: dynamic column count, 8 rows)
  ctx.strokeStyle = colors.grid
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
  ctx.strokeStyle = colors.gridMajor
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
/** Format an epoch-seconds timestamp as a short time string (e.g. "2:34 AM"). */
function formatTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function PiezoWaveform({ enabled = true, className }: { enabled?: boolean, className?: string }) {
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
  // Reactive sample counts + rate (updated on each frame for display)
  const [sampleCounts, setSampleCounts] = useState({ left: 0, right: 0 })
  const [freq, setFreq] = useState(0)
  // Hover readout over the canvas: the sample under the pointer on each
  // channel. Read from the buffers in the handler (they are refs, not state).
  const [readout, setReadout] = useState<{ pct: number, label: string } | null>(null)
  const onHover = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : -1
    const n = Math.max(leftBufferRef.current.length, rightBufferRef.current.length)
    if (!Number.isFinite(frac) || frac < 0 || frac > 1 || n < 2) {
      setReadout(null)
      return
    }
    const i = Math.round(frac * (n - 1))
    const back = freqRef.current > 0 ? `-${((n - 1 - i) / freqRef.current).toFixed(2)}s` : `#${i}`
    const l = leftBufferRef.current[i]
    const r = rightBufferRef.current[i]
    setReadout({
      pct: (i / (n - 1)) * 100,
      label: [back, showLeft && l != null ? `L ${Math.round(l)}` : null, showRight && r != null ? `R ${Math.round(r)}` : null].filter(Boolean).join(' · '),
    })
  }

  // Seek / timeline scrubber state. `enabled` follows the System Stop toggle
  // so this consumer doesn't hold the shared socket open while paused.
  const { seekWaveform: seek, goLive, waveform, replayWaveform, getTimeRange, isSeeking, timeRange } = useSensorStream({ sensors: ['piezo-dual'], enabled })
  const [scrubValue, setScrubValue] = useState<number | null>(null) // null = live
  const timeRangeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    goLive()
  }, [goLive])

  // Fetch time range on mount and every 5 seconds
  useEffect(() => {
    if (!enabled) return
    getTimeRange()
    timeRangeIntervalRef.current = setInterval(() => {
      getTimeRange()
    }, 5_000)
    return () => {
      if (timeRangeIntervalRef.current) {
        clearInterval(timeRangeIntervalRef.current)
      }
    }
  }, [getTimeRange, enabled])

  const isLive = replayWaveform === null

  const handleScrub = useCallback((val: number) => {
    setScrubValue(val)
    seek(val)
  }, [seek])

  const handleGoLive = useCallback(() => {
    setScrubValue(null)
    goLive()
  }, [goLive])

  // A snapshot/replay is installed as one window; live data continues to collect
  // separately while scrubbing, so Go live immediately restores the newest view.
  useEffect(() => {
    if (!enabled) return
    const frames = replayWaveform ?? waveform
    leftBufferRef.current = frames.flatMap(f => f.left1).slice(-MAX_SAMPLES)
    rightBufferRef.current = frames.flatMap(f => f.right1).slice(-MAX_SAMPLES)
    hasDataRef.current = frames.length > 0
    freqRef.current = frames.at(-1)?.freq ?? freqRef.current

    setSampleCounts({ left: leftBufferRef.current.length, right: rightBufferRef.current.length })
    setFreq(freqRef.current)
  }, [enabled, waveform, replayWaveform])

  // Canvas rendering loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let colors = readColors()
    let tick = 0

    function render() {
      if (!canvas || !ctx) return

      // Re-read tokens about once a second so theme switches apply
      if (++tick % 60 === 0) colors = readColors()

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

      ctx.clearRect(0, 0, w, h)
      drawGrid(ctx, w, h, dpr, colors)

      if (!hasDataRef.current) {
        ctx.fillStyle = colors.text
        ctx.font = `${12 * dpr}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('Waiting for piezo data', w / 2, h / 2 + 4 * dpr)
        animFrameRef.current = requestAnimationFrame(render)
        return
      }

      const leftSamples = leftBufferRef.current
      const rightSamples = rightBufferRef.current

      // Compute shared range across both visible channels (matching iOS)
      const visibleLeft = showLeft ? leftSamples : []
      const visibleRight = showRight ? rightSamples : []

      if (visibleLeft.length < MIN_SAMPLES && visibleRight.length < MIN_SAMPLES) {
        ctx.fillStyle = colors.text
        ctx.font = `${11 * dpr}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('Collecting samples', w / 2, h / 2 + 4 * dpr)
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
        drawCatmullRomTrace(ctx, pts, colors.left, dpr)
      }

      if (showRight && rightSamples.length >= MIN_SAMPLES) {
        const pts = buildPoints(rightSamples, w, h, rMin, range)
        drawCatmullRomTrace(ctx, pts, colors.right, dpr)
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
    <Card className={cn('gap-2 px-4 py-3.5', className)}>
      <SectionLabel
        right={(
          <span className="font-mono">
            {freq > 0 ? `${freq} Hz` : '--'}
            {` · L ${sampleCounts.left} · R ${sampleCounts.right}`}
          </span>
        )}
      >
        Piezo
        <ChannelChip label="Left" on={showLeft} color="var(--accent-cool)" onClick={() => setShowLeft(v => !v)} />
        <ChannelChip label="Right" on={showRight} color="var(--accent-warm)" onClick={() => setShowRight(v => !v)} />
      </SectionLabel>

      <div ref={containerRef} className="relative overflow-hidden" onPointerMove={onHover} onPointerLeave={() => setReadout(null)}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: `${CANVAS_HEIGHT}px`, display: 'block' }}
        />
        {readout && <HoverMark pct={readout.pct} label={readout.label} />}
      </div>

      {!timeRange && !isLive && (
        <button type="button" onClick={handleGoLive} className="self-end text-xs text-ok hover:underline">
          Go live
        </button>
      )}
      {/* Timeline scrubber */}
      {timeRange && (
        <div className="flex items-center gap-2.5 font-mono text-[11px] text-fg-3">
          <span className="shrink-0">{formatTime(timeRange.min)}</span>
          <Slider
            label="Piezo replay position"
            min={timeRange.min}
            max={timeRange.max}
            value={isLive ? timeRange.max : Math.max(timeRange.min, Math.min(scrubValue ?? timeRange.max, timeRange.max))}
            onChange={handleScrub}
          />
          <span className="shrink-0">{formatTime(timeRange.max)}</span>
          {isLive
            ? <span className="shrink-0 text-fg-3">{enabled ? 'Latest' : 'Paused'}</span>
            : (
                <button type="button" onClick={handleGoLive} className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-ok hover:underline">
                  {isSeeking ? 'seeking' : 'Go live'}
                </button>
              )}
        </div>
      )}
    </Card>
  )
}

function ChannelChip({ label, on, color, onClick }: { label: string, on: boolean, color: string, onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-[11px] tracking-normal normal-case',
        on ? 'text-fg-2' : 'text-fg-3 line-through',
      )}
    >
      <span className="block h-0.5 w-2.5" style={{ background: on ? color : 'var(--text-3)' }} />
      {label}
    </button>
  )
}
