'use client'

import { Sun, Moon } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'

/**
 * Compact ambient light indicator — shows current lux reading with day/night icon.
 * Matches iOS TempScreen EnvironmentInfoView lux display.
 *
 * Wires into:
 * - environment.getLatestAmbientLight → current lux reading
 */
export function AmbientLightChip() {
  const { data, isLoading } = trpc.environment.getLatestAmbientLight.useQuery(
    {},
    { refetchInterval: 30_000 },
  )

  if (isLoading || !data) return null

  const lux = data.lux
  if (lux == null) return null

  const isDark = lux < 10

  return (
    <div className="flex items-center gap-1 text-[11px] text-zinc-500">
      {isDark
        ? (
            <Moon size={12} className="text-indigo-400" />
          )
        : (
            <Sun size={12} className="text-amber-400" />
          )}
      <span className="tabular-nums">
        {Math.round(lux)}
        {' '}
        lux
      </span>
    </div>
  )
}
