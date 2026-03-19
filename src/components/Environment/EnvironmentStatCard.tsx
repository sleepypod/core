'use client'

import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface EnvironmentStatCardProps {
  icon: ReactNode
  label: string
  value: string
  subValue?: string
  colorClass?: string
}

export function EnvironmentStatCard({
  icon,
  label,
  value,
  subValue,
  colorClass = 'text-zinc-400',
}: EnvironmentStatCardProps) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 rounded-lg bg-zinc-900/50 px-2 py-3">
      <div className={cn('text-sm', colorClass)}>{icon}</div>
      <span className={cn('text-lg font-bold tabular-nums', value === '--' ? 'text-zinc-600' : 'text-white')}>
        {value}
      </span>
      <span className="text-[10px] text-zinc-500">{label}</span>
      {subValue && (
        <span className="text-[9px] text-zinc-600">{subValue}</span>
      )}
    </div>
  )
}
