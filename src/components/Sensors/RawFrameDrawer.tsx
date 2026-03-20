'use client'

import { useCallback, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useOnSensorFrame } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'

const MAX_FRAMES = 20

interface StoredFrame {
  ts: number
  type: string
  data: string // JSON stringified
}

/**
 * Expandable raw frame inspector. Shows last N frames per sensor type
 * as formatted JSON. Useful for debugging sensor data without the
 * firmware log console.
 */
export function RawFrameDrawer() {
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)
  const framesRef = useRef<StoredFrame[]>([])
  const [frames, setFrames] = useState<StoredFrame[]>([])

  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    framesRef.current = [
      { ts: Date.now(), type: frame.type, data: JSON.stringify(frame, null, 2) },
      ...framesRef.current,
    ].slice(0, MAX_FRAMES * 10) // keep more in buffer, show MAX_FRAMES

    // Only update displayed frames if drawer is open (avoid unnecessary re-renders)
    if (expanded) {
      setFrames([...framesRef.current])
    }
  }, [expanded]))

  const handleToggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next) setFrames([...framesRef.current])
  }

  const filtered = filter
    ? frames.filter(f => f.type === filter).slice(0, MAX_FRAMES)
    : frames.slice(0, MAX_FRAMES)

  const types = [...new Set(framesRef.current.map(f => f.type))]

  return (
    <div>
      <button
        onClick={handleToggle}
        className="flex w-full items-center justify-between py-1 text-xs font-medium text-zinc-400"
      >
        <span>Raw Frames</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {expanded && (
        <div className="mt-1 space-y-1.5">
          {/* Type filter pills */}
          <div className="flex flex-wrap gap-1">
            <FilterPill
              label="All"
              active={filter === null}
              onClick={() => setFilter(null)}
            />
            {types.map(type => (
              <FilterPill
                key={type}
                label={type}
                active={filter === type}
                onClick={() => setFilter(type)}
              />
            ))}
          </div>

          {/* Frame list */}
          <div className="max-h-[300px] space-y-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="py-4 text-center text-[10px] text-zinc-600">Waiting for frames...</p>
            ) : (
              filtered.map((frame, i) => (
                <FrameEntry key={`${frame.ts}-${i}`} frame={frame} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={[
        'rounded-md px-2 py-0.5 text-[9px] font-medium transition-colors',
        active
          ? 'bg-sky-500/20 text-sky-400'
          : 'bg-zinc-800 text-zinc-500 active:bg-zinc-700',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

function FrameEntry({ frame }: { frame: StoredFrame }) {
  const [open, setOpen] = useState(false)
  const age = ((Date.now() - frame.ts) / 1000).toFixed(1)

  return (
    <div className="rounded-md bg-black/30">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
      >
        <span className="text-[9px] font-mono font-medium text-sky-400">{frame.type}</span>
        <span className="flex-1" />
        <span className="text-[8px] tabular-nums text-zinc-600">{age}s ago</span>
        {open ? <ChevronUp size={10} className="text-zinc-600" /> : <ChevronDown size={10} className="text-zinc-600" />}
      </button>
      {open && (
        <pre className="max-h-[200px] overflow-auto px-2 pb-1.5 text-[8px] leading-tight text-zinc-500">
          {frame.data}
        </pre>
      )}
    </div>
  )
}
