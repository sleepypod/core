'use client'

import type { Phase } from '@/src/lib/sleepCurve/types'
import { phaseLabels, phaseColors } from '@/src/lib/sleepCurve/types'

const displayPhases: Phase[] = ['warmUp', 'coolDown', 'deepSleep', 'preWake']

export function PhaseLegend() {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
      {displayPhases.map(phase => (
        <div key={phase} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: phaseColors[phase] }}
          />
          <span className="text-[10px] font-medium text-zinc-500">{phaseLabels[phase]}</span>
        </div>
      ))}
    </div>
  )
}
