'use client'

import { useCallback, useRef, useState } from 'react'
import { Braces, Pause, Play } from 'lucide-react'
import { useOnSensorFrame } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'
import { Button, Modal, Pill } from '@/src/components/ds'
import { cn } from '@/lib/utils'

const MAX_FRAMES = 50

interface StoredFrame {
  ts: number
  type: string
  data: string
}

/**
 * Raw frame inspector. A button opens a dialog (bottom sheet
 * on phones) listing recent WebSocket frames; selecting one pauses live
 * updates so the JSON doesn't shift while reading.
 */
export function RawFrameDrawer() {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [selectedFrame, setSelectedFrame] = useState<StoredFrame | null>(null)
  const framesRef = useRef<StoredFrame[]>([])
  const [frames, setFrames] = useState<StoredFrame[]>([])
  // Track every frame type ever seen so the filter stays populated even
  // while paused or when the displayed `frames` slice doesn't include a
  // given type. Reading framesRef.current during render trips react-hooks/refs.
  const [seenTypes, setSeenTypes] = useState<readonly string[]>([])

  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    framesRef.current = [
      { ts: Date.now(), type: frame.type, data: JSON.stringify(frame, null, 2) },
      ...framesRef.current,
    ].slice(0, MAX_FRAMES * 5)

    setSeenTypes(prev => prev.includes(frame.type) ? prev : [...prev, frame.type])

    if (open && !paused) {
      setFrames([...framesRef.current])
    }
  }, [open, paused]))

  const handleOpen = () => {
    setFrames([...framesRef.current])
    setOpen(true)
  }

  const handleClose = useCallback(() => {
    setOpen(false)
    setSelectedFrame(null)
    setPaused(false)
  }, [])

  const filtered = filter
    ? frames.filter(f => f.type === filter).slice(0, MAX_FRAMES)
    : frames.slice(0, MAX_FRAMES)

  return (
    <>
      <Button size="sm" icon={Braces} onClick={handleOpen}>Raw frames</Button>

      <Modal
        open={open}
        onClose={handleClose}
        title="Raw frames"
        width={760}
        headerRight={(
          <Button
            size="sm"
            variant={paused ? 'secondary' : 'ghost'}
            icon={paused ? Play : Pause}
            onClick={() => setPaused(p => !p)}
            className={paused ? 'text-warn' : undefined}
          >
            {paused ? 'Paused' : 'Live'}
          </Button>
        )}
      >
        <div className="flex flex-wrap gap-1.5">
          <Pill selected={filter === null} onClick={() => setFilter(null)} className="px-2.5 py-1 font-mono text-xs">All</Pill>
          {seenTypes.map(type => (
            <Pill key={type} selected={filter === type} onClick={() => setFilter(type)} className="px-2.5 py-1 font-mono text-xs">{type}</Pill>
          ))}
        </div>

        <div className="flex h-[52dvh] min-h-0 overflow-hidden rounded-ctl border border-line bg-code">
          <div className={cn('overflow-y-auto', selectedFrame ? 'w-1/3 min-w-[120px] border-r border-line' : 'flex-1')}>
            {filtered.length === 0
              ? <p className="py-8 text-center text-xs text-fg-3">Waiting for frames</p>
              : filtered.map((frame, i) => {
                  const isSelected = selectedFrame?.ts === frame.ts && selectedFrame?.type === frame.type
                  // eslint-disable-next-line react-hooks/purity
                  const age = ((Date.now() - frame.ts) / 1000).toFixed(1)
                  return (
                    <button
                      key={`${frame.ts}-${i}`}
                      type="button"
                      onClick={() => {
                        setSelectedFrame(isSelected ? null : frame)
                        if (!paused) setPaused(true)
                      }}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2 border-0 border-b border-line bg-transparent px-3 py-1.5 text-left font-mono text-xs',
                        isSelected ? 'bg-active' : 'hover:bg-active',
                      )}
                    >
                      <span className="text-fg">{frame.type}</span>
                      <span className="flex-1" />
                      <span className="text-[11px] text-fg-3">{`${age}s`}</span>
                    </button>
                  )
                })}
          </div>

          {selectedFrame && (
            <div className="min-w-0 flex-1 overflow-auto p-3">
              <div className="mb-1.5 flex items-center gap-2 font-mono text-xs">
                <span className="text-fg">{selectedFrame.type}</span>
                <span className="text-fg-3">
                  {new Date(selectedFrame.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
              <pre className="font-mono text-[11px] leading-relaxed text-fg-2">{selectedFrame.data}</pre>
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
