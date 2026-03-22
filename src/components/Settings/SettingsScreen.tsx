'use client'

import { useState } from 'react'
import { Settings, User, RotateCcw, Wifi } from 'lucide-react'
import clsx from 'clsx'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { DeviceSettingsForm } from './DeviceSettingsForm'
import { SideSettingsForm } from './SideSettingsForm'
import { TapGestureConfig } from './TapGestureConfig'
import { HapticsTestCard } from './HapticsTestCard'

/**
 * Settings screen matching iOS ProfileAndSettingsSheet.
 * Layout: Device section (top) → Per-side tabs (name, gestures, haptics).
 */
export function SettingsScreen() {
  const [selectedSide, setSelectedSide] = useState<'left' | 'right'>('left')
  const { data, isLoading, error } = trpc.settings.getAll.useQuery({})
  const { leftName, rightName } = useSideNames()

  const rebootMutation = trpc.system.triggerUpdate.useMutation()

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <Settings size={18} className="text-zinc-500" />
          <h1 className="text-lg font-semibold text-white">Settings</h1>
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-zinc-900" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-4">
        <p className="text-sm text-red-400">Failed to load settings: {error.message}</p>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 px-1">
        <Settings size={18} className="text-zinc-400" />
        <h1 className="text-lg font-semibold text-white">Settings</h1>
      </div>

      {/* ─── Device Settings ─── */}
      <section>
        <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Device
        </h2>
        <DeviceSettingsForm device={data.device} />

        {/* Reconnect / Reboot actions */}
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => window.location.reload()}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-3 py-3 text-sm font-medium text-zinc-400 transition-colors active:bg-zinc-800"
          >
            <Wifi size={14} />
            Reconnect
          </button>
          <button
            onClick={() => {
              if (confirm('Restart the sleepypod service? The pod will be briefly unavailable.')) {
                rebootMutation.mutate({})
              }
            }}
            disabled={rebootMutation.isPending}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-zinc-900 px-3 py-3 text-sm font-medium text-zinc-400 transition-colors active:bg-zinc-800 disabled:opacity-50"
          >
            <RotateCcw size={14} />
            {rebootMutation.isPending ? 'Restarting...' : 'Restart'}
          </button>
        </div>
        {rebootMutation.isSuccess && (
          <p className="mt-2 text-center text-xs text-emerald-400">Service restarting — reconnecting...</p>
        )}

        {/* Vibration patterns — device-level, shared across sides */}
        <div className="mt-4">
          <HapticsTestCard />
        </div>
      </section>

      {/* ─── Side Settings ─── */}
      <section>
        <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Side
        </h2>

        {/* Side tab switcher */}
        <div className="mb-4 flex rounded-xl bg-zinc-900 p-1">
          {([
            { key: 'left' as const, label: leftName },
            { key: 'right' as const, label: rightName },
          ]).map(t => (
            <button
              key={t.key}
              onClick={() => setSelectedSide(t.key)}
              className={clsx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-medium transition-colors',
                selectedSide === t.key
                  ? 'bg-zinc-800 text-white'
                  : 'text-zinc-500',
              )}
            >
              <User size={14} />
              {t.label}
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {/* Name + away mode */}
          <SideSettingsForm
            side={selectedSide}
            sideData={selectedSide === 'left' ? data.sides.left : data.sides.right}
          />

          {/* Gestures for this side */}
          <TapGestureConfig filterSide={selectedSide} />
        </div>
      </section>
    </div>
  )
}
