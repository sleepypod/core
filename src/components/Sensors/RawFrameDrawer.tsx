'use client'

import { useCallback, useRef, useState } from 'react'
import { ChevronDown, X, Pause, Play } from 'lucide-react'
import { useOnSensorFrame } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'

const MAX_FRAMES = 50

interface StoredFrame {
  ts: number
  type: string
  data: string
}

/**
 * Raw frame inspector — opens as a fixed bottom sheet overlay so it
 * stays in place while the page scrolls underneath. Pauses live updates
 * when a frame is expanded so content doesn't shift while reading.
 */
export function RawFrameDrawer() {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [selectedFrame, setSelectedFrame] = useState<StoredFrame | null>(null)
  const framesRef = useRef<StoredFrame[]>([])
  const [frames, setFrames] = useState<StoredFrame[]>([])

  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    framesRef.current = [
      { ts: Date.now(), type: frame.type, data: JSON.stringify(frame, null, 2) },
      ...framesRef.current,
    ].slice(0, MAX_FRAMES * 5)

    if (open && !paused) {
      setFrames([...framesRef.current])
    }
  }, [open, paused]))

  const handleOpen = () => {
    setFrames([...framesRef.current])
    setOpen(true)
  }

  const handleClose = () => {
    setOpen(false)
    setSelectedFrame(null)
    setPaused(false)
  }

  const filtered = filter
    ? frames.filter(f => f.type === filter).slice(0, MAX_FRAMES)
    : frames.slice(0, MAX_FRAMES)

  const types = [...new Set(framesRef.current.map(f => f.type))]

  return (
    <>
      {/* Inline trigger button */}
      <button
        onClick={handleOpen}
        className="flex w-full items-center justify-between py-1 text-xs font-medium text-zinc-400"
      >
        <span>Raw Frames</span>
        <ChevronDown size={14} />
      </button>

      {/* Bottom sheet overlay */}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col">
          {/* Backdrop */}
          <div className="flex-1 bg-black/60" onClick={handleClose} />

          {/* Sheet */}
          <div className="flex max-h-[70dvh] flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-950">
            {/* Handle + header */}
            <div className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-zinc-300">Raw Frames</span>
                <button
                  onClick={() => setPaused(p => !p)}
                  className={`rounded-md px-2 py-0.5 text-[9px] font-medium ${
                    paused ? 'bg-amber-500/20 text-amber-400' : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {paused
                    ? (
                        <>
                          <Pause size={8} className="inline mr-0.5" />
                          {' '}
                          Paused
                        </>
                      )
                    : (
                        <>
                          <Play size={8} className="inline mr-0.5" />
                          {' '}
                          Live
                        </>
                      )}
                </button>
              </div>
              <button onClick={handleClose} className="p-1 text-zinc-500 active:text-zinc-300">
                <X size={16} />
              </button>
            </div>

            {/* Type filter pills */}
            <div className="flex flex-wrap gap-1 px-3 pb-2">
              <FilterPill label="All" active={filter === null} onClick={() => setFilter(null)} />
              {types.map(type => (
                <FilterPill key={type} label={type} active={filter === type} onClick={() => setFilter(type)} />
              ))}
            </div>

            {/* Split view: frame list on left, detail on right (or stacked on mobile) */}
            <div className="flex flex-1 overflow-hidden">
              {/* Frame list */}
              <div className={`overflow-y-auto border-r border-zinc-800/50 ${selectedFrame ? 'w-1/3 min-w-[120px]' : 'flex-1'}`}>
                {filtered.length === 0
                  ? (
                      <p className="py-8 text-center text-[10px] text-zinc-600">Waiting for frames...</p>
                    )
                  : (
                      filtered.map((frame, i) => {
                        const isSelected = selectedFrame?.ts === frame.ts && selectedFrame?.type === frame.type
                        const age = ((Date.now() - frame.ts) / 1000).toFixed(1)
                        return (
                          <button
                            key={`${frame.ts}-${i}`}
                            onClick={() => {
                              setSelectedFrame(isSelected ? null : frame)
                              if (!paused) setPaused(true)
                            }}
                            className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left border-b border-zinc-900 ${
                              isSelected ? 'bg-sky-500/10' : 'active:bg-zinc-900'
                            }`}
                          >
                            <span className="text-[8px] font-mono font-medium text-sky-400">{frame.type}</span>
                            <span className="flex-1" />
                            <span className="text-[7px] tabular-nums text-zinc-600">
                              {age}
                              s
                            </span>
                          </button>
                        )
                      })
                    )}
              </div>

              {/* Detail panel */}
              {selectedFrame && (
                <div className="flex-1 overflow-auto p-2">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[9px] font-mono font-medium text-sky-400">{selectedFrame.type}</span>
                    <span className="text-[8px] text-zinc-600">
                      {new Date(selectedFrame.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>
                  <pre className="text-[9px] leading-relaxed text-zinc-400 font-mono">
                    {selectedFrame.data}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function FilterPill({ label, active, onClick }: { label: string, active: boolean, onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={[
        'rounded-md px-2 py-0.5 text-[9px] font-medium transition-colors',
        active ? 'bg-sky-500/20 text-sky-400' : 'bg-zinc-800 text-zinc-500 active:bg-zinc-700',
      ].join(' ')}
    >
      {label}
    </button>
  )
}
