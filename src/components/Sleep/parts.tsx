'use client'

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hypnogram, type HypnoBlock } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import type { Tick } from './sleepData'

/** Ring color for a 0–100 quality score. */
export function qualityColor(score: number | null | undefined): string {
  if (score == null) return 'var(--dial-track)'
  return score >= 70 ? 'var(--status-ok)' : 'var(--status-warn)'
}

/** Compact vitals tile (icon, mono value, caption). */
export function VitalTile({ icon: Icon, iconClassName, value, label, className }: {
  icon: LucideIcon
  iconClassName?: string
  value: ReactNode
  label: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 rounded-card border border-line bg-surface p-3', className)}>
      <Icon size={14} className={cn('text-icon', iconClassName)} />
      <span className="font-mono text-xl font-light min-[900px]:text-[22px]">{value}</span>
      <span className="text-[11px] leading-[1.3] text-fg-2">{label}</span>
    </div>
  )
}

/** Four-lane hypnogram with proportionally placed time ticks. */
export function NightHypnogram({ blocks, ticks, lane = 26, bar = 18, labels = true }: {
  blocks: HypnoBlock[]
  ticks?: Tick[]
  lane?: number
  bar?: number
  labels?: boolean
}) {
  return (
    <div className="flex flex-col">
      <Hypnogram blocks={blocks} lane={lane} bar={bar} labels={labels} />
      {ticks && ticks.length > 0 && (
        <div className="grid gap-x-2.5" style={{ gridTemplateColumns: labels ? '48px minmax(0,1fr)' : 'minmax(0,1fr)' }}>
          {labels && <div />}
          <div className="relative h-[22px] pt-1.5 font-mono text-[11px] text-fg-3">
            {ticks.map((t, i) => (
              <span
                key={`${t.label}-${i}`}
                className="absolute whitespace-nowrap"
                style={{
                  left: `${t.pct}%`,
                  transform: i === 0 ? undefined : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Centered muted copy for an empty card slot. */
export function EmptyNote({ children, className }: { children: ReactNode, className?: string }) {
  return (
    <div className={cn('flex items-center justify-center py-8 text-center text-[13px] text-fg-2', className)}>
      {children}
    </div>
  )
}
