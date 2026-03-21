'use client'

import { useEffect, useState } from 'react'
import { User, Plane } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Toggle } from './Toggle'

interface SideData {
  side: 'left' | 'right'
  name: string
  awayMode: boolean
}

interface SideSettingsFormProps {
  side: 'left' | 'right'
  sideData: SideData
}

/**
 * Per-side settings: name and away mode for a single side.
 */
export function SideSettingsForm({ side, sideData }: SideSettingsFormProps) {
  return <SideCard data={sideData ?? { side, name: side === 'left' ? 'Left' : 'Right', awayMode: false }} />
}

function SideCard({ data }: { data: SideData }) {
  const utils = trpc.useUtils()
  const [name, setName] = useState(data.name)
  const [awayMode, setAwayMode] = useState(data.awayMode)

  // Sync from server
  useEffect(() => {
    setName(data.name)
    setAwayMode(data.awayMode)
  }, [data.name, data.awayMode])

  const mutation = trpc.settings.updateSide.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  })

  const isPending = mutation.isPending
  const sideLabel = data.side === 'left' ? 'Left' : 'Right'

  function handleNameBlur() {
    const trimmed = name.trim()
    if (trimmed && trimmed !== data.name) {
      mutation.mutate({ side: data.side, name: trimmed })
    } else {
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

  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      <div className="mb-3 flex items-center gap-2">
        <User size={16} className="text-zinc-400" />
        <span className="text-sm font-medium text-zinc-300">{sideLabel} Side</span>
      </div>

      {/* Name input */}
      <div className="mb-3">
        <label className="mb-1.5 block text-xs font-medium text-zinc-400">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
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

      {mutation.error && (
        <p className="mt-2 text-xs text-red-400">{mutation.error.message}</p>
      )}
    </div>
  )
}
