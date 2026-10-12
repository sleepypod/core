'use client'

import { useRef, useState, type ComponentProps } from 'react'
import { Button } from '@/src/components/ds'
import { VitalsChart } from './VitalsChart'

/** Zoom keeps the full range available; the scrollbar, drag, and buttons pan it. */
export function VitalsExplorer(props: ComponentProps<typeof VitalsChart>) {
  const [zoom, setZoom] = useState(1)
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number, scroll: number } | null>(null)
  const changeZoom = (factor: number) => {
    const el = viewport.current
    const next = Math.min(16, Math.max(1, zoom * factor))
    const center = el ? (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth : 0
    setZoom(next)
    requestAnimationFrame(() => {
      if (el) el.scrollLeft = center * el.scrollWidth - el.clientWidth / 2
    })
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Chart navigation">
        <Button size="sm" disabled={zoom <= 1} onClick={() => changeZoom(0.5)}>Zoom out</Button>
        <Button size="sm" disabled={zoom >= 16} onClick={() => changeZoom(2)}>Zoom in</Button>
        <Button size="sm" onClick={() => viewport.current?.scrollBy({ left: -viewport.current.clientWidth * 0.7, behavior: 'smooth' })}>Pan earlier</Button>
        <Button size="sm" onClick={() => viewport.current?.scrollBy({ left: viewport.current.clientWidth * 0.7, behavior: 'smooth' })}>Pan later</Button>
        <Button
          size="sm"
          onClick={() => {
            setZoom(1)
            if (viewport.current) viewport.current.scrollLeft = 0
          }}
        >
          Reset zoom
        </Button>
        <span className="font-mono text-xs text-fg-2" role="status">
          {zoom}
          × · drag or swipe to pan
        </span>
      </div>
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
          if (e.pointerType !== 'mouse' || e.button !== 0) return
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
          <VitalsChart {...props} />
        </div>
      </div>
    </div>
  )
}
