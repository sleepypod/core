'use client'

import { useEffect, useState } from 'react'
import { User, Plane, Timer } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Toggle } from './Toggle'

interface SideData {
  side: 'left' | 'right'
  name: string
  awayMode: boolean
  autoOffEnabled: boolean
  autoOffMinutes: number
}

interface SideSettingsFormProps {
  side: 'left' | 'right'
  sideData: SideData
}

const AUTO_OFF_DURATION_OPTIONS = [5, 10, 15, 30, 45, 60, 90, 120] as const

/**
 * Per-side settings: name, away mode, and auto-off for a single side.
 */
export function SideSettingsForm({ side, sideData }: SideSettingsFormProps) {
  return (
    <SideCard
      data={sideData ?? {
        side,
        name: side === 'left' ? 'Left' : 'Right',
        awayMode: false,
        autoOffEnabled: false,
        autoOffMinutes: 30,
      }}
    />
  )
}

function SideCard({ data }: { data: SideData }) {
  const utils = trpc.useUtils()
  const [name, setName] = useState(data.name)
  const [awayMode, setAwayMode] = useState(data.awayMode)
  const [autoOffEnabled, setAutoOffEnabled] = useState(data.autoOffEnabled)
  const [autoOffMinutes, setAutoOffMinutes] = useState(data.autoOffMinutes)

  // Sync from server
  useEffect(() => {
    setName(data.name)
    setAwayMode(data.awayMode)
    setAutoOffEnabled(data.autoOffEnabled)
    setAutoOffMinutes(data.autoOffMinutes)
  }, [data.name, data.awayMode, data.autoOffEnabled, data.autoOffMinutes])

  const mutation = trpc.settings.updateSide.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  })

  const isPending = mutation.isPending
  const sideLabel = data.side === 'left' ? 'Left' : 'Right'

  function handleNameBlur() {
    const trimmed = name.trim()
    if (trimmed && trimmed !== data.name) {
      mutation.mutate({ side: data.side, name: trimmed })
    }
    else {
      setName(data.name) // revert
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      ;(e.target as HTMLInputElement).blur()
    }
  }

  function handleAwayToggle() {
    const newVal = !awayMode
    setAwayMode(newVal)
    mutation.mutate({ side: data.side, awayMode: newVal })
  }

  function handleAutoOffToggle() {
    const newVal = !autoOffEnabled
    setAutoOffEnabled(newVal)
    mutation.mutate({ side: data.side, autoOffEnabled: newVal })
  }

  function handleAutoOffMinutesChange(minutes: number) {
    setAutoOffMinutes(minutes)
    mutation.mutate({ side: data.side, autoOffMinutes: minutes })
  }

  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      <div className="mb-3 flex items-center gap-2">
        <User size={16} className="text-zinc-400" />
        <span className="text-sm font-medium text-zinc-300">
          {sideLabel}
          {' '}
          Side
        </span>
      </div>

      {/* Name input */}
      <div className="mb-3">
        <label className="mb-1.5 block text-xs font-medium text-zinc-400">Name</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={handleNameKeyDown}
          maxLength={20}
          disabled={isPending}
          className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          placeholder={sideLabel}
        />
      </div>

      {/* Away mode toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plane size={14} className={awayMode ? 'text-sky-400' : 'text-zinc-500'} />
          <span className="text-sm text-zinc-300">Away Mode</span>
        </div>
        <Toggle
          enabled={awayMode}
          onToggle={handleAwayToggle}
          disabled={isPending}
          label={`Toggle away mode for ${sideLabel} side`}
        />
      </div>

      {/* Auto-off toggle */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Timer size={14} className={autoOffEnabled ? 'text-sky-400' : 'text-zinc-500'} />
          <span className="text-sm text-zinc-300">Auto-off when empty</span>
        </div>
        <Toggle
          enabled={autoOffEnabled}
          onToggle={handleAutoOffToggle}
          disabled={isPending}
          label={`Toggle auto-off for ${sideLabel} side`}
        />
      </div>

      {/* Auto-off duration picker (shown when enabled) */}
      {autoOffEnabled && (
        <div className="mt-3">
          <label className="mb-1.5 block text-xs font-medium text-zinc-400">
            Auto-off after
          </label>
          <div className="flex flex-wrap gap-1.5">
            {AUTO_OFF_DURATION_OPTIONS.map(mins => (
              <button
                key={mins}
                onClick={() => handleAutoOffMinutesChange(mins)}
                disabled={isPending}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  autoOffMinutes === mins
                    ? 'bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/40'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {mins < 60 ? `${mins}m` : `${mins / 60}h${mins % 60 ? ` ${mins % 60}m` : ''}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {mutation.error && (
        <p className="mt-2 text-xs text-red-400">{mutation.error.message}</p>
      )}
    </div>
  )
}
