'use client'

import { cn } from '@/lib/utils'
import { TANK_BARS, type WaterTank } from './waterTank'

/**
 * Water tank gauge from `frzWater`: five bars filling bottom-up, with the
 * tank label and priming state beside it. Bars pulse while the pod primes; an
 * invalid capacitive reading leaves every bar unlit and labels the tank from
 * `hasWater`.
 */
export function WaterTankGauge({ tank, className }: { tank: WaterTank, className?: string }) {
  const lit = tank.level ?? 0
  const bar = tank.tone === 'warn' ? 'bg-warn' : 'bg-cool'
  const prime = tank.prime === 'priming' ? 'Priming…' : tank.prime === 'needed' ? 'Needs prime' : null
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} data-testid="water-tank">
      <span
        role="img"
        aria-label={tank.level != null ? `Water tank ${tank.level} of ${TANK_BARS}` : `Water ${tank.label.toLowerCase()}, tank level unavailable`}
        className={cn('flex w-2.5 shrink-0 flex-col-reverse gap-px', tank.prime === 'priming' && 'animate-pulse')}
      >
        {Array.from({ length: TANK_BARS }, (_, i) => (
          <span key={i} data-lit={i < lit} className={cn('h-[2px] w-full rounded-[1px]', i < lit ? bar : 'bg-active')} />
        ))}
      </span>
      <span className={cn('shrink-0', tank.tone === 'warn' && 'text-warn')}>{tank.label}</span>
      {prime && <span className={cn('truncate', tank.prime === 'needed' ? 'text-warn' : 'text-fg-2')}>{prime}</span>}
    </span>
  )
}
