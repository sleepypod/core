'use client'

import { useEffect, useRef, useState } from 'react'

/** Transient overlay riding a single deviceStatus frame's side payload. */
export interface GuardRejectionOverlay {
  ts: number
  source: string
}

const AUTO_DISMISS_MS = 5_000

/**
 * Latch the transient guardRejection overlay broadcast when a guard-blocked
 * HomeKit write is refused (sideController). The overlay rides exactly one
 * WS frame — the next poll frame drops it — so this hook remembers the last
 * seen rejection ts per side and surfaces a snackbar message for a few
 * seconds. A repeat rejection (newer ts) restarts the dismiss timer.
 */
export function useGuardRejectionNotice(
  leftRejection: GuardRejectionOverlay | undefined,
  rightRejection: GuardRejectionOverlay | undefined,
): string | null {
  const [notice, setNotice] = useState<{ text: string, ts: number } | null>(null)
  const seen = useRef<Record<'left' | 'right', number>>({ left: 0, right: 0 })

  const leftTs = leftRejection?.ts ?? null
  const rightTs = rightRejection?.ts ?? null

  useEffect(() => {
    const sides = [['left', leftTs], ['right', rightTs]] as const
    for (const [side, ts] of sides) {
      if (ts != null && ts > seen.current[side]) {
        seen.current[side] = ts
        setNotice({
          text: `${side === 'left' ? 'Left' : 'Right'} side change from HomeKit blocked — pump stall protection active`,
          ts,
        })
      }
    }
  }, [leftTs, rightTs])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [notice])

  return notice?.text ?? null
}
