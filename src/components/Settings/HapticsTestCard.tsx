'use client'

import { useState } from 'react'
import { Vibrate, Play, Square, ChevronDown } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import clsx from 'clsx'
import { VIBRATION_PRESETS } from '@/src/lib/vibrationPatterns'

// ---------------------------------------------------------------------------
// Intensity color helpers
// ---------------------------------------------------------------------------

/** Returns a tailwind-compatible color class based on intensity level. */
function intensityColor(intensity: number): string {
  if (intensity <= 30) return 'bg-green-500'
  if (intensity <= 60) return 'bg-amber-500'
  return 'bg-red-500'
}

function intensityTextColor(intensity: number): string {
  if (intensity <= 30) return 'text-green-400'
  if (intensity <= 60) return 'text-amber-400'
  return 'text-red-400'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HapticsTestCard({ filterSide }: { filterSide?: 'left' | 'right' } = {}) {
  const { side: contextSide } = useSide()
  const side = filterSide ?? contextSide
  const [customExpanded, setCustomExpanded] = useState(false)
  const [customIntensity, setCustomIntensity] = useState(50)
  const [customPattern, setCustomPattern] = useState<'rise' | 'double'>('rise')
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

  function handleTest(intensity: number, pattern: 'rise' | 'double', duration: number, label?: string) {
    setAlarm.mutate({
      side,
      vibrationIntensity: intensity,
      vibrationPattern: pattern,
      duration,
    })
    setActivePattern(label ?? 'custom')
  }

  function handleStop() {
    clearAlarm.mutate({ side })
  }

  function handleQuickTest() {
    handleTest(30, 'rise', 2, 'quick')
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
                  {p.pattern}
                  {' '}
                  &middot;
                  {p.duration}
                  s
                </span>
              </div>
              <p className="text-[10px] text-zinc-500 truncate">{p.description}</p>
              {/* Intensity bar */}
              <div className="mt-1 flex items-center gap-1.5">
                <div className="h-1 flex-1 rounded-full bg-zinc-700 overflow-hidden">
                  <div
                    className={clsx('h-full rounded-full transition-all', intensityColor(p.intensity))}
                    style={{ width: `${p.intensity}%` }}
                  />
                </div>
                <span className={clsx('text-[9px] font-medium tabular-nums', intensityTextColor(p.intensity))}>
                  {p.intensity}
                  %
                </span>
              </div>
            </div>
            {/* Play button */}
            <button
              onClick={() => handleTest(p.intensity, p.pattern, p.duration, p.name)}
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
            {/* Intensity slider */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-400">Intensity</span>
                <span className={clsx('text-xs font-medium', intensityTextColor(customIntensity))}>
                  {customIntensity}
                  %
                </span>
              </div>
              <div className="relative">
                <div className="absolute top-1/2 left-0 right-0 h-1.5 -translate-y-1/2 rounded-full bg-zinc-700 overflow-hidden pointer-events-none">
                  <div
                    className={clsx('h-full rounded-full transition-all', intensityColor(customIntensity))}
                    style={{ width: `${customIntensity}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={customIntensity}
                  onChange={e => setCustomIntensity(parseInt(e.target.value, 10))}
                  className="relative z-10 h-1.5 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
                />
              </div>
              <div className="flex justify-between text-[10px] text-zinc-600">
                <span>1%</span>
                <span>100%</span>
              </div>
            </div>

            {/* Pattern toggle */}
            <div>
              <span className="mb-1.5 block text-xs font-medium text-zinc-400">Pattern</span>
              <div className="grid grid-cols-2 gap-2">
                {(['double', 'rise'] as const).map(pat => (
                  <button
                    key={pat}
                    onClick={() => setCustomPattern(pat)}
                    className={clsx(
                      'flex min-h-[44px] items-center justify-center rounded-lg border py-2.5 text-xs font-medium capitalize transition-colors',
                      customPattern === pat
                        ? 'border-sky-500/50 bg-sky-500/10 text-sky-400'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 active:bg-zinc-700'
                    )}
                  >
                    {pat}
                  </button>
                ))}
              </div>
            </div>

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
              onClick={() => handleTest(customIntensity, customPattern, customDuration)}
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
