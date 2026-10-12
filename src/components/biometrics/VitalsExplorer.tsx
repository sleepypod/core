'use client'

import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { ArrowLeft, ArrowRight, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/src/components/ds'
import { type RangeWindow } from './biometricsLogic'
import { VitalsChart } from './VitalsChart'

/** Zoom keeps the full range available; the scrollbar, drag, and buttons pan it. */
export function VitalsExplorer(props: ComponentProps<typeof VitalsChart>) {
  const [window, setWindow] = useState<RangeWindow | null>(null)
  const [zoom, setZoom] = useState(1)
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number, scroll: number } | null>(null)
  const zoomRef = useRef(1)
  const frame = useRef<number | null>(null)
  const changeZoom = useCallback((factor: number, pointerX?: number) => {
    const el = viewport.current
    const next = Math.min(16, Math.max(1, zoomRef.current * factor))
    if (next === zoomRef.current) return
    const anchor = el ? Math.max(0, Math.min(el.clientWidth, pointerX ?? el.clientWidth / 2)) : 0
    const fraction = el && el.scrollWidth ? (el.scrollLeft + anchor) / el.scrollWidth : 0
    zoomRef.current = next
    setZoom(next)
    if (frame.current != null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      if (el) el.scrollLeft = fraction * el.scrollWidth - anchor
    })
  }, [])
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return
      // React's wheel listener is passive; use a native non-passive listener
      // so Ctrl+wheel zooms only this chart, not the browser page.
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1)
      changeZoom(Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.003), event.clientX - el.getBoundingClientRect().left)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [changeZoom])

  const selectWindow = (selected: RangeWindow) => {
    if (!props.sessions.some(s => s.points.some(p => p.t >= selected.start && p.t <= selected.end))) return
    if (frame.current != null) cancelAnimationFrame(frame.current)
    setWindow(selected)
    zoomRef.current = 1
    setZoom(1)
    if (viewport.current) viewport.current.scrollLeft = 0
  }
  const sessions = window
    ? props.sessions.flatMap((session) => {
        const points = session.points.filter(p => p.t >= window.start && p.t <= window.end)
        return points.length ? [{ start: points[0].t, end: points[points.length - 1].t, points }] : []
      })
    : props.sessions

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Chart navigation">
        <Button icon={ZoomOut} size="sm" disabled={zoom <= 1} onClick={() => changeZoom(0.5)}>Zoom out</Button>
        <Button icon={ZoomIn} size="sm" disabled={zoom >= 16} onClick={() => changeZoom(2)}>Zoom in</Button>
        <Button
          icon={RotateCcw}
          size="sm"
          onClick={() => {
            if (frame.current != null) cancelAnimationFrame(frame.current)
            setWindow(null)
            zoomRef.current = 1
            setZoom(1)
            if (viewport.current) viewport.current.scrollLeft = 0
          }}
        >
          Reset zoom
        </Button>
        <Button icon={ArrowLeft} size="sm" onClick={() => viewport.current?.scrollBy({ left: -viewport.current.clientWidth * 0.7, behavior: 'smooth' })}>Pan earlier</Button>
        <Button icon={ArrowRight} size="sm" onClick={() => viewport.current?.scrollBy({ left: viewport.current.clientWidth * 0.7, behavior: 'smooth' })}>Pan later</Button>
        <span className="ml-auto text-right font-mono text-xs text-fg-2" role="status">
          {`${Number(zoom.toFixed(1))}× · Ctrl + scroll to zoom · drag to select · Shift + drag to pan`}
        </span>
      </div>
      {window && <span className="text-xs text-fg-2" role="status">Selected window · Reset zoom to show the full range</span>}
      <div
        ref={viewport}
        className="overflow-x-auto overscroll-x-contain rounded focus-visible:outline-2 focus-visible:outline-link"
        tabIndex={0}
        role="region"
        aria-label="Scrollable vitals chart"
        onKeyDown={(e) => {
          if (e.key === '+' || e.key === '=') {
            e.preventDefault()
            changeZoom(2)
          }
          if (e.key === '-') {
            e.preventDefault()
            changeZoom(0.5)
          }
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'mouse' || e.button !== 0 || !e.shiftKey) return
          drag.current = { x: e.clientX, scroll: e.currentTarget.scrollLeft }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (drag.current) e.currentTarget.scrollLeft = drag.current.scroll - (e.clientX - drag.current.x)
        }}
        onPointerUp={() => { drag.current = null }}
        onPointerCancel={() => { drag.current = null }}
        onLostPointerCapture={() => { drag.current = null }}
      >
        <div style={{ width: `${zoom * 100}%`, minWidth: 560 }}>
          <VitalsChart {...props} key={window ? `${window.start}-${window.end}` : 'full'} sessions={sessions} stall={window ? null : props.stall} onSelectWindow={selectWindow} />
        </div>
      </div>
    </div>
  )
}
