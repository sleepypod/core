'use client'

import { Sun, Moon } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'

/**
 * Compact ambient light reading with a day/night glyph (Room card label row).
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

  const Icon = lux < 10 ? Moon : Sun

  return (
    <span className="flex items-center gap-1 font-mono text-[11px] text-fg-2">
      <Icon size={12} />
      {`${Math.round(lux)} lux`}
    </span>
  )
}
