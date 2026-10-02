'use client'

import { Droplets } from 'lucide-react'

/**
 * Priming status row — shown while the pod water system is priming.
 */
export const PrimingIndicator = () => (
  <div role="status" className="flex items-center gap-2.5 rounded-ctl border border-line px-3 py-2.5 text-[13px] text-cool">
    <Droplets size={14} className="shrink-0 animate-pulse" />
    <span className="animate-pulse">Priming</span>
  </div>
)
