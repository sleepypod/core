'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Accumulates point-in-time snapshots into a fixed-length, in-memory ring
 * buffer so the diagnostics console can render polled data as a trend without
 * a backend history endpoint.
 *
 * Client-only: the buffer lives for the lifetime of the component and resets on
 * reload. A new entry is appended whenever `key` changes — pass the tRPC
 * query's `dataUpdatedAt` (a ms timestamp) so each successful refetch
 * contributes exactly one point, even when the underlying values repeat.
 */
export function useTrendBuffer<T extends object>(
  sample: T | undefined,
  key: number | undefined,
  maxPoints = 120,
): Array<T & { t: number }> {
  const [buffer, setBuffer] = useState<Array<T & { t: number }>>([])
  const lastKey = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (sample == null || key == null || key === lastKey.current) return
    lastKey.current = key
    setBuffer((prev) => {
      const next = [...prev, { ...sample, t: key }]
      return next.length > maxPoints ? next.slice(next.length - maxPoints) : next
    })
  }, [sample, key, maxPoints])

  return buffer
}
