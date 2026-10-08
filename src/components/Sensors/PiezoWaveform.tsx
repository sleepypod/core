'use client'

import { formatClock, type TimeFormat } from '@/src/lib/timeFormat'
import { useTimeFormat } from '@/src/providers/TimeFormatProvider'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSensorStream, type PiezoDualFrame } from '@/src/hooks/useSensorStream'
import { Card, HoverMark, SectionLabel, Slider } from '@/src/components/ds'
import { cn } from '@/lib/utils'

/** Maximum samples to keep in the waveform buffer per channel. */
const MAX_SAMPLES = 10_000
/** Bucket-averaged points across the canvas (~200, matching iOS). */
const RENDER_TARGET_POINTS = 200
/** Minimum samples before rendering a trace (matching iOS guard). */
const MIN_SAMPLES = 20
/** Canvas height in CSS pixels. */
const CANVAS_HEIGHT = 96
/** Seconds of signal one sweep spans. The stream keeps ~11 s, so a sweep plus the lag fits. */
const SWEEP_SECONDS = 8
/**
 * How far the sweep cursor trails the newest sample. Frames arrive about once a
 * second, so the cursor needs more than a frame of runway to move without stalling.
 */
const LAG_SECONDS = 1.5
/** Blank strip ahead of the cursor that separates new signal from the previous sweep. */
const GAP_SECONDS = 0.3
/** Vertical scale easing: grow fast so peaks stay on canvas, shrink slowly so it holds still. */
const RANGE_GROW_TAU = 0.12
const RANGE_SHRINK_TAU = 2.5
/** Sample rate assumed when a frame omits it. */
const FALLBACK_HZ = 500

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

interface Point {
  x: number
  y: number
}

/** One channel's samples, each tagged with its absolute sample number (epoch seconds × rate). */
interface Channel {
  n: number[]
  v: number[]
}

interface Trace {
  left: Channel
  right: Channel
  hz: number
  /** Absolute sample numbers of the first and last samples held. */
  first: number
  last: number
}

/**
 * Flatten frames into channels keyed by absolute sample number. Positions come from
 * the frame timestamp, not the buffer index, so a sample keeps its place on screen
 * as the window slides.
 */
function toTrace(frames: PiezoDualFrame[]): Trace | null {
  if (frames.length === 0) return null
  const hz = frames.at(-1)?.freq || FALLBACK_HZ
  const channel = (pick: (f: PiezoDualFrame) => number[]): Channel => {
    const n: number[] = []
    const v: number[] = []
    for (const f of frames) {
      const start = Math.round(f.ts * hz)
      const samples = pick(f)
      for (let i = 0; i < samples.length; i++) {
        n.push(start + i)
        v.push(samples[i])
      }
    }
    return n.length > MAX_SAMPLES ? { n: n.slice(-MAX_SAMPLES), v: v.slice(-MAX_SAMPLES) } : { n, v }
  }
  const left = channel(f => f.left1)
  const right = channel(f => f.right1)
  const ends = [left.n[0], right.n[0], left.n.at(-1), right.n.at(-1)].filter((x): x is number => x != null)
  if (ends.length === 0) return null
  return { left, right, hz, first: Math.min(...ends), last: Math.max(...ends) }
}

/** Index of the sample numbered `n`, or -1. Channels are ascending. */
function findSample(ch: Channel, n: number): number {
  let lo = 0
  let hi = ch.n.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (ch.n[mid] === n) return mid
    if (ch.n[mid] < n) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/**
 * Average samples into `count` buckets of `size` samples starting at bucket `first`,
 * where bucket b covers sample numbers [b·size, (b+1)·size). Buckets are anchored to
 * absolute sample numbers, so a bucket's value never changes once it is full.
 * Samples past `maxN` are ignored; empty buckets are NaN.
 */
function bucketAverages(ch: Channel, first: number, count: number, size: number, maxN = Infinity): Float64Array {
  const sums = new Float64Array(count)
  const counts = new Uint32Array(count)
  for (let i = 0; i < ch.n.length; i++) {
    const n = ch.n[i]
    if (n > maxN) break
    const b = Math.floor(n / size) - first
    if (b < 0 || b >= count) continue
    sums[b] += ch.v[i]
    counts[b]++
  }
  for (let b = 0; b < count; b++) sums[b] = counts[b] > 0 ? sums[b] / counts[b] : Number.NaN
  return sums
}

/**
 * Shared vertical range from the 0.5th–99.5th percentiles of the visible samples, padded
 * 15%. Percentiles keep one movement spike from squashing the rest of the trace.
 */
function robustRange(channels: Channel[], fromN: number): [number, number] | null {
  const values: number[] = []
  for (const ch of channels) {
    for (let i = 0; i < ch.n.length; i++) {
      if (ch.n[i] >= fromN && Number.isFinite(ch.v[i])) values.push(ch.v[i])
    }
  }
  if (values.length === 0) return null
  values.sort((a, b) => a - b)
  const at = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))]
  const lo = at(0.005)
  const hi = at(0.995)
  if (!(hi > lo)) return [lo - 1, lo + 1]
  const pad = (hi - lo) * 0.15
  return [lo - pad, hi + pad]
}

/** Split bucket averages into drawable runs, breaking at empty buckets. */
function toRuns(avgs: Float64Array, xOf: (k: number) => number, yOf: (v: number) => number, out: Point[][]) {
  let run: Point[] = []
  for (let k = 0; k < avgs.length; k++) {
    const v = avgs[k]
    if (Number.isNaN(v)) {
      if (run.length > 1) out.push(run)
      run = []
      continue
    }
    run.push({ x: xOf(k), y: yOf(v) })
  }
  if (run.length > 1) out.push(run)
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

/**
 * Sweep geometry for the live view. A sweep spans `points` buckets of `size` samples,
 * anchored to absolute sample numbers, so every sample has a fixed x for the life of
 * its sweep.
 */
interface SweepView {
  mode: 'live'
  play: number
  size: number
  points: number
  gap: number
  hz: number
}

/** Replay shows the fetched window once, laid out by sample number across the canvas. */
interface ReplayView {
  mode: 'replay'
  first: number
  span: number
  hz: number
}

function sweepGeometry(hz: number) {
  const points = RENDER_TARGET_POINTS
  const size = Math.max(1, Math.round(SWEEP_SECONDS * hz / points))
  return { points, size, gap: Math.ceil(GAP_SECONDS * hz / size) }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Format an epoch-seconds timestamp as a short time string (e.g. "2:34 AM"). */
function formatTime(epochSeconds: number, timeFormat: TimeFormat = '12h'): string {
  const d = new Date(epochSeconds * 1000)
  return formatClock(d, timeFormat, { hour: 'numeric', minute: '2-digit' })
}

/**
 * Canvas-based real-time piezo waveform display.
 *
 * Live data draws in sweep mode, like a bedside monitor: the traces stay put while a
 * cursor sweeps left to right, writing new signal over the previous sweep behind a
 * small gap. Nothing already drawn moves sideways. The shared vertical scale comes
 * from robust percentiles and eases toward its target, growing fast and shrinking
 * slowly, so the traces don't lurch every time a frame lands.
 *
 * Replay draws the fetched window statically. Both channels share one Y scale and use
 * bucket-averaged, Catmull-Rom interpolated traces (matching iOS PiezoWaveformView).
 */
export function PiezoWaveform({ enabled = true, className }: { enabled?: boolean, className?: string }) {
  const timeFormat = useTimeFormat()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Waveform data and view state live in refs (mutated per frame, not React state)
  const traceRef = useRef<Trace | null>(null)
  const replayRef = useRef(false)
  const versionRef = useRef(0)
  const viewRef = useRef<SweepView | ReplayView | null>(null)
  const freqRef = useRef<number>(0)
  const animFrameRef = useRef<number>(0)
  // Sweep cursor (a fractional absolute sample number) and the displayed vertical
  // range. Kept across render-loop restarts so a channel toggle doesn't reset them.
  const sweepRef = useRef<{ play: number | null, mode: 'live' | 'replay' | null, shown: [number, number] | null }>({ play: null, mode: null, shown: null })

  // Track visibility for channel toggles
  const [showLeft, setShowLeft] = useState(true)
  const [showRight, setShowRight] = useState(true)
  // Reactive sample counts + rate (updated when data arrives)
  const [sampleCounts, setSampleCounts] = useState({ left: 0, right: 0 })
  const [freq, setFreq] = useState(0)
  // Hover readout over the canvas: the sample under the pointer on each channel,
  // resolved through the current sweep or replay layout.
  const [readout, setReadout] = useState<{ pct: number, label: string } | null>(null)
  const onHover = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : -1
    const trace = traceRef.current
    const view = viewRef.current
    if (!Number.isFinite(frac) || frac < 0 || frac > 1 || !trace || !view) {
      setReadout(null)
      return
    }
    let n: number
    let pct: number
    let end: number
    if (view.mode === 'live') {
      const k = Math.min(view.points - 1, Math.floor(frac * view.points))
      const cursor = Math.floor(view.play / view.size)
      const passStart = cursor - (cursor % view.points)
      const c = cursor - passStart
      if (k > c && k <= c + view.gap) {
        setReadout(null)
        return
      }
      const bucket = k <= c ? passStart + k : passStart - view.points + k
      n = Math.min(bucket * view.size + (view.size >> 1), Math.floor(view.play))
      pct = ((k + 0.5) / view.points) * 100
      end = view.play
    }
    else {
      const i = Math.round(frac * (view.span - 1))
      n = view.first + i
      pct = view.span > 1 ? (i / (view.span - 1)) * 100 : 0
      end = view.first + view.span - 1
    }
    const li = showLeft ? findSample(trace.left, n) : -1
    const ri = showRight ? findSample(trace.right, n) : -1
    if (li < 0 && ri < 0) {
      setReadout(null)
      return
    }
    setReadout({
      pct,
      label: [
        `-${((end - n) / view.hz).toFixed(2)}s`,
        li >= 0 ? `L ${Math.round(trace.left.v[li])}` : null,
        ri >= 0 ? `R ${Math.round(trace.right.v[ri])}` : null,
      ].filter(Boolean).join(' · '),
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
    traceRef.current = toTrace(frames)
    replayRef.current = replayWaveform !== null
    versionRef.current++
    freqRef.current = frames.at(-1)?.freq ?? freqRef.current

    setSampleCounts({ left: traceRef.current?.left.n.length ?? 0, right: traceRef.current?.right.n.length ?? 0 })
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
    let lastTime: number | null = null
    const sweepState = sweepRef.current
    // Target vertical range, recomputed when the data or the visible channels change
    let target: [number, number] | null = null
    let targetVersion = -1

    function render(time: number) {
      if (!canvas || !ctx) return
      const dt = lastTime === null ? 0 : Math.min(Math.max((time - lastTime) / 1000, 0), 0.1)
      lastTime = time

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

      const trace = traceRef.current
      if (!trace) {
        viewRef.current = null
        ctx.fillStyle = colors.text
        ctx.font = `${12 * dpr}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('Waiting for piezo data', w / 2, h / 2 + 4 * dpr)
        animFrameRef.current = requestAnimationFrame(render)
        return
      }

      const visible = [showLeft ? trace.left : null, showRight ? trace.right : null].filter((c): c is Channel => c !== null)
      if (visible.every(c => c.n.length < MIN_SAMPLES)) {
        ctx.fillStyle = colors.text
        ctx.font = `${11 * dpr}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('Collecting samples', w / 2, h / 2 + 4 * dpr)
        animFrameRef.current = requestAnimationFrame(render)
        return
      }

      const mode = replayRef.current ? 'replay' : 'live'
      const { points, size, gap } = sweepGeometry(trace.hz)
      const sweep = points * size

      // Advance the sweep cursor in real time, trimming its rate toward a fixed lag
      // behind the newest sample. It never runs past the data, and it jumps only after
      // a long gap (a hidden tab or a reconnect).
      let { play, shown } = sweepState
      if (mode === 'live') {
        const end = trace.last + 1
        const goal = Math.max(trace.first, end - LAG_SECONDS * trace.hz)
        if (play === null || sweepState.mode !== 'live' || Math.abs(goal - play) > 4 * trace.hz) play = goal
        else {
          const err = (goal - play) / trace.hz
          play += dt * trace.hz * (1 + Math.min(Math.max(err * 0.5, -0.25), 0.25))
        }
        play = Math.min(play, end)
      }
      if (sweepState.mode !== mode) shown = null
      sweepState.mode = mode
      sweepState.play = play

      if (targetVersion !== versionRef.current || !target) {
        target = robustRange(visible, mode === 'live' ? trace.last - sweep : -Infinity)
        targetVersion = versionRef.current
      }
      if (!target) {
        animFrameRef.current = requestAnimationFrame(render)
        return
      }
      if (!shown) shown = [target[0], target[1]]
      else {
        const ease = (from: number, to: number, grow: boolean) => from + (to - from) * (1 - Math.exp(-dt / (grow ? RANGE_GROW_TAU : RANGE_SHRINK_TAU)))
        shown = [ease(shown[0], target[0], target[0] < shown[0]), ease(shown[1], target[1], target[1] > shown[1])]
      }
      sweepState.shown = shown
      const [rMin, rMax] = shown
      const range = rMax - rMin
      const yOf = (v: number) => {
        const y = h * (1 - (v - rMin) / range)
        return Number.isFinite(y) ? Math.min(Math.max(y, 0), h) : h / 2
      }

      const runs = (ch: Channel): Point[][] => {
        const out: Point[][] = []
        if (mode === 'live' && play !== null) {
          const cursor = Math.floor(play / size)
          const passStart = cursor - (cursor % points)
          const c = cursor - passStart
          const headX = ((play - passStart * size) / sweep) * w
          // This sweep, up to the cursor; the newest point sits on the cursor itself
          toRuns(bucketAverages(ch, passStart, c + 1, size, play), k => (k === c ? headX : ((k + 0.5) / points) * w), yOf, out)
          // The previous sweep, from just past the gap to the right edge
          const from = c + 1 + gap
          if (from < points) {
            toRuns(bucketAverages(ch, passStart - points + from, points - from, size), k => ((from + k + 0.5) / points) * w, yOf, out)
          }
        }
        else {
          const span = trace.last - trace.first + 1
          const bucket = Math.max(1, Math.ceil(span / points))
          const count = Math.ceil(span / bucket)
          const shifted: Channel = { n: ch.n.map(n => n - trace.first), v: ch.v }
          toRuns(bucketAverages(shifted, 0, count, bucket), k => (count > 1 ? (k / (count - 1)) * w : 0), yOf, out)
        }
        return out
      }

      if (showLeft && trace.left.n.length >= MIN_SAMPLES) {
        for (const run of runs(trace.left)) drawCatmullRomTrace(ctx, run, colors.left, dpr)
      }
      if (showRight && trace.right.n.length >= MIN_SAMPLES) {
        for (const run of runs(trace.right)) drawCatmullRomTrace(ctx, run, colors.right, dpr)
      }

      if (mode === 'live' && play !== null) {
        viewRef.current = { mode: 'live', play, size, points, gap, hz: trace.hz }
        // Sweep cursor
        const x = Math.round(((play % sweep) / sweep) * w) + 0.5
        ctx.strokeStyle = colors.text
        ctx.lineWidth = dpr
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
      else {
        viewRef.current = { mode: 'replay', first: trace.first, span: trace.last - trace.first + 1, hz: trace.hz }
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
          <span className="shrink-0">{formatTime(timeRange.min, timeFormat)}</span>
          <Slider
            label="Piezo replay position"
            min={timeRange.min}
            max={timeRange.max}
            value={isLive ? timeRange.max : Math.max(timeRange.min, Math.min(scrubValue ?? timeRange.max, timeRange.max))}
            onChange={handleScrub}
          />
          <span className="shrink-0">{formatTime(timeRange.max, timeFormat)}</span>
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
