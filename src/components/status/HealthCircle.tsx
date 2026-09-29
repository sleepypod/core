'use client'

import type { ReactNode } from 'react'
import { Card, KeyValue } from '@/src/components/ds'
import { POD_CAPS } from '@/src/hardware/pods'
import type { PodVersion } from '@/src/hardware/types'

export function podModelName(version: string | null | undefined): string | undefined {
  if (!version) return undefined
  const caps = POD_CAPS[version as PodVersion]
  return caps?.modelName ?? version
}

/** "N/N healthy" ring: full green when everything passes, amber arc otherwise. */
export function HealthRing({ healthy, total, size = 84, caption = true }: {
  healthy: number
  total: number
  size?: number
  caption?: boolean
}) {
  const progress = total > 0 ? healthy / total : 0
  const allHealthy = total > 0 && healthy === total
  const r = 42
  const c = 2 * Math.PI * r
  const stroke = size < 60 ? 7 : 5
  const label = `${healthy}/${total}`
  // Shrink the count to fit inside the stroke: mono glyphs are ~0.6em wide, 85% of the inner diameter.
  const inner = (2 * (r - stroke / 2) * size) / 96
  const fontSize = Math.min(size < 60 ? 12 : 16, (inner * 0.85) / (label.length * 0.6))
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${healthy} of ${total} checks healthy`}>
      <svg width={size} height={size} viewBox="0 0 96 96" className="-rotate-90">
        <circle cx="48" cy="48" r={r} fill="none" stroke="var(--border-1)" strokeWidth={stroke} />
        <circle
          cx="48"
          cy="48"
          r={r}
          fill="none"
          stroke={allHealthy ? 'var(--status-ok)' : 'var(--status-warn)'}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - progress)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono font-light leading-none tabular-nums" style={{ fontSize }}>
          {label}
        </span>
        {caption && size >= 60 && <span className="text-[10px] text-fg-2">healthy</span>}
      </div>
    </div>
  )
}

export interface HealthItem {
  label: string
  value: ReactNode
  onClick?: () => void
}

/**
 * Status health card: ring of passing checks next to a grid of pod facts
 * (Pod, Build, Wi-Fi, Address, Water, Internet, Disk, Uptime).
 */
export function HealthCircle({ healthy, total, items }: {
  healthy: number
  total: number
  items: HealthItem[]
}) {
  return (
    <Card className="flex-row items-center gap-4 px-4 py-3.5 @min-[800px]:gap-[22px] @min-[800px]:px-5 @min-[800px]:py-[18px]">
      <div className="@min-[800px]:hidden">
        <HealthRing healthy={healthy} total={total} size={64} />
      </div>
      <div className="hidden @min-[800px]:block">
        <HealthRing healthy={healthy} total={total} />
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-6 gap-y-3.5 @min-[800px]:grid-cols-4">
        {items.map(it => (
          it.onClick
            ? (
                <button
                  key={it.label}
                  type="button"
                  onClick={it.onClick}
                  className="min-w-0 cursor-pointer rounded-thumb border-0 bg-transparent p-0 text-left text-fg hover:bg-active"
                >
                  <KeyValue label={it.label} value={it.value} size={13} />
                </button>
              )
            : <KeyValue key={it.label} label={it.label} value={it.value} size={13} />
        ))}
      </div>
    </Card>
  )
}
