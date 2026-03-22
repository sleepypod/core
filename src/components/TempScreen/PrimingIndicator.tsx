'use client'

import { Droplets } from 'lucide-react'
import { theme } from '@/src/lib/tempColors'

/**
 * Compact priming status indicator — shown when pod water system is priming.
 * Matches iOS PrimingIndicator with pulsing animation.
 */
export const PrimingIndicator = () => (
  <div className="flex items-center gap-1.5 rounded-full bg-sky-950/40 px-3 py-1.5">
    <Droplets
      size={14}
      className="animate-pulse"
      style={{ color: theme.accent }}
    />
    <span
      className="animate-pulse text-xs font-semibold"
      style={{ color: theme.accent }}
    >
      Priming
    </span>
  </div>
)
