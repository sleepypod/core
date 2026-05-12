'use client'

import { useState } from 'react'
import { Vibrate, Play, Square, ChevronDown } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import clsx from 'clsx'
import { FIXED_INTENSITY, FIXED_PATTERN, VIBRATION_PRESETS } from '@/src/lib/vibrationPatterns'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HapticsTestCard({ filterSide }: { filterSide?: 'left' | 'right' } = {}) {
  const { side: contextSide } = useSide()
  const side = filterSide ?? contextSide
  const [customExpanded, setCustomExpanded] = useState(false)
  const [customDuration, setCustomDuration] = useState(10)
  const [activePattern, setActivePattern] = useState<string | null>(null)

  const setAlarm = trpc.device.setAlarm.useMutation({
    onSuccess: (_, variables) => {
      setActivePattern(variables.side)
    },
  })
  const clearAlarm = trpc.device.clearAlarm.useMutation({
    onSuccess: () => {
      setActivePattern(null)
    },
  })

  const isMutating = setAlarm.isPending || clearAlarm.isPending

  function handleTest(duration: number, label?: string) {
    setAlarm.mutate({
      side,
      vibrationIntensity: FIXED_INTENSITY,
      vibrationPattern: FIXED_PATTERN,
      duration,
    })
    setActivePattern(label ?? 'custom')
  }

  function handleStop() {
    clearAlarm.mutate({ side })
  }

  function handleQuickTest() {
    handleTest(10, 'quick')
  }

  return (
    <div className="space-y-3 rounded-2xl bg-zinc-900 p-3 sm:space-y-4 sm:p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Vibrate size={16} className="text-zinc-400" />
            <h3 className="text-sm font-medium text-white">Test Vibration Patterns</h3>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Test vibration patterns on the
            {' '}
            {side}
            {' '}
            side
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Quick test */}
          <button
            onClick={handleQuickTest}
            disabled={isMutating}
            className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-sky-500/20 px-3 py-2 text-xs font-medium text-sky-400 transition-colors active:bg-sky-500/30 disabled:opacity-50"
          >
            <Vibrate size={12} />
            Quick Test
          </button>
          {/* Stop */}
          {activePattern && (
            <button
              onClick={handleStop}
              disabled={clearAlarm.isPending}
              className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-2 text-xs font-medium text-red-400 transition-colors active:bg-red-500/30 disabled:opacity-50"
            >
              <Square size={12} />
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Sample patterns */}
      <div className="space-y-1.5">
        {VIBRATION_PRESETS.map(p => (
          <div
            key={p.name}
            className="flex min-h-[44px] items-center gap-3 rounded-xl bg-zinc-800/60 px-3 py-2.5"
          >
            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-zinc-200">{p.name}</span>
                <span className="text-[9px] text-zinc-600">
                  {p.duration}
                  s
                </span>
              </div>
              <p className="text-[10px] text-zinc-500 truncate">{p.description}</p>
            </div>
            {/* Play button */}
            <button
              onClick={() => handleTest(p.duration, p.name)}
              disabled={isMutating}
              className={clsx(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50',
                activePattern === p.name
                  ? 'bg-sky-500/30 text-sky-400'
                  : 'bg-zinc-700 text-zinc-400 active:bg-zinc-600'
              )}
            >
              <Play size={14} />
            </button>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-zinc-600">
        Intensity and pattern are firmware-clamped on Pod 5 — only duration affects the buzz.
      </p>

      {/* Custom controls (collapsible) */}
      <div>
        <button
          onClick={() => setCustomExpanded(!customExpanded)}
          className="flex w-full min-h-[44px] items-center justify-between py-1 text-xs font-medium text-zinc-400"
        >
          <span>Custom</span>
          <ChevronDown
            size={14}
            className={clsx('transition-transform', customExpanded && 'rotate-180')}
          />
        </button>

        {customExpanded && (
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3 mt-1">
            {/* Duration slider */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-400">Duration</span>
                <span className="text-xs font-medium text-white">
                  {customDuration}
                  s
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={60}
                step={1}
                value={customDuration}
                onChange={e => setCustomDuration(parseInt(e.target.value, 10))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-600">
                <span>1s</span>
                <span>60s</span>
              </div>
            </div>

            {/* Test button */}
            <button
              onClick={() => handleTest(customDuration)}
              disabled={isMutating}
              className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-lg bg-sky-500/20 py-2.5 text-sm font-medium text-sky-400 transition-colors active:bg-sky-500/30 disabled:opacity-50"
            >
              <Vibrate size={14} />
              {isMutating ? 'Sending...' : 'Test'}
            </button>
          </div>
        )}
      </div>

      {/* Error display */}
      {setAlarm.error && (
        <p className="text-xs text-red-400">{setAlarm.error.message}</p>
      )}
      {clearAlarm.error && (
        <p className="text-xs text-red-400">{clearAlarm.error.message}</p>
      )}
    </div>
  )
}
