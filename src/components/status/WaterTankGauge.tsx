'use client'

import { cn } from '@/lib/utils'
import { StatusDot } from '@/src/components/ds'

export interface WaterTankGaugeProps {
  /** Capacitive water level 0–5 (from frzWater frame). */
  capLevel?: number
  /** True when the capacitive sensor reading is calibrated and valid. */
  capValid?: boolean
  /** Active priming in progress. */
  isPriming?: boolean
  /** Firmware flagged prime needed (e.g. bubbles or refill). */
  needsPriming?: boolean
  /** Binary fallback from DAC / status table: 'ok' | 'low' | undefined. */
  waterLevel?: string
  className?: string
}

export function WaterTankGauge({
  capLevel,
  capValid,
  isPriming,
  needsPriming,
  waterLevel,
  className,
}: WaterTankGaugeProps) {
  // If capacitive level is valid, render the 5-bar gauge
  if (capValid && typeof capLevel === 'number') {
    const level = Math.max(0, Math.min(5, Math.round(capLevel)))
    const isLow = level <= 1
    return (
      <span
        className={cn('inline-flex items-center gap-1.5', className)}
        title={`Tank level: ${level}/5 bars${isPriming ? ' (priming)' : needsPriming ? ' (needs prime)' : ''}`}
        aria-label={`Tank level ${level} of 5 bars`}
        data-testid="water-tank-gauge"
      >
        <span className="flex h-3 items-center gap-[2px]" role="img">
          {[1, 2, 3, 4, 5].map((bar) => {
            const filled = bar <= level
            return (
              <span
                key={bar}
                data-bar={bar}
                className={cn(
                  'h-3 w-1 rounded-[1px] transition-colors',
                  filled
                    ? isLow
                      ? 'bg-warn'
                      : 'bg-cool'
                    : 'bg-active',
                  isPriming && filled && 'animate-pulse',
                )}
              />
            )
          })}
        </span>
        <span className="font-mono text-[11px] text-fg-2">{`${level}/5`}</span>
        {isPriming
          ? (
              <span className="font-mono text-[10px] text-cool">priming</span>
            )
          : needsPriming
            ? (
                <span className="font-mono text-[10px] text-warn">needs prime</span>
              )
            : null}
      </span>
    )
  }

  // Fallback to binary ok/low when frzWater has not arrived or capValid is false
  if (waterLevel === 'low' || waterLevel === 'ok') {
    return (
      <span className={cn('inline-flex items-center gap-1.5', className)} data-testid="water-tank-gauge-fallback">
        <StatusDot tone={waterLevel === 'low' ? 'warn' : 'ok'} label={waterLevel === 'low' ? 'Low' : 'OK'} className="text-[12px]" />
      </span>
    )
  }

  return null
}
