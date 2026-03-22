'use client'

import { cn } from '@/lib/utils'
import type { CoolingIntensity } from '@/src/lib/sleepCurve/types'
import { coolingIntensityMeta } from '@/src/lib/sleepCurve/types'

const intensities: CoolingIntensity[] = ['cool', 'balanced', 'warm']

const intensityStyles: Record<CoolingIntensity, { active: string; icon: string }> = {
  cool: {
    active: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
    icon: '❄️',
  },
  balanced: {
    active: 'border-violet-500/40 bg-violet-500/10 text-violet-400',
    icon: '⚖️',
  },
  warm: {
    active: 'border-orange-500/40 bg-orange-500/10 text-orange-400',
    icon: '🔥',
  },
}

interface IntensitySelectorProps {
  value: CoolingIntensity
  onChange: (intensity: CoolingIntensity) => void
}

/**
 * Three-option segmented control for cooling intensity.
 * Matches iOS SmartCurveView intensity selector.
 */
export function IntensitySelector({ value, onChange }: IntensitySelectorProps) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
        Cooling Profile
      </div>
      <div className="grid grid-cols-3 gap-2">
        {intensities.map(intensity => {
          const meta = coolingIntensityMeta[intensity]
          const styles = intensityStyles[intensity]
          const isActive = value === intensity

          return (
            <button
              key={intensity}
              type="button"
              onClick={() => onChange(intensity)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition-all duration-200',
                isActive
                  ? styles.active
                  : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-700',
              )}
            >
              <span className="text-lg">{styles.icon}</span>
              <span className="text-xs font-semibold">{meta.label}</span>
              <span className="text-[10px] leading-tight opacity-70">{meta.description}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
