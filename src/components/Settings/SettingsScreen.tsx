'use client'

import { Settings } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { DeviceSettingsForm } from './DeviceSettingsForm'
import { SideSettingsForm } from './SideSettingsForm'
import { TapGestureConfig } from './TapGestureConfig'

/**
 * Settings screen — device-level and side-level configuration.
 * Wired to settings.getAll, settings.updateDevice, and settings.updateSide tRPC calls.
 */
export function SettingsScreen() {
  const { data, isLoading, error } = trpc.settings.getAll.useQuery({})

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

      {/* Device Settings */}
      <section>
        <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Device
        </h2>
        <DeviceSettingsForm device={data.device} />
      </section>

      {/* Side Settings */}
      <section>
        <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Sides
        </h2>
        <SideSettingsForm left={data.sides.left} right={data.sides.right} />
      </section>

      {/* Tap Gestures */}
      <section>
        <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Gestures
        </h2>
        <TapGestureConfig />
      </section>
    </div>
  )
}
