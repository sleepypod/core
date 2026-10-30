'use client'

import { useEffect, useReducer } from 'react'

/** Expire quiet connections periodically and compare new query receipts with the current render's clock. */
export function useBedroomClock() {
  const [, refreshClock] = useReducer((tick: number) => tick + 1, 0)
  useEffect(() => {
    const timer = setInterval(refreshClock, 1000)
    return () => clearInterval(timer)
  }, [])
  // A query can arrive between ticks. Sampling here avoids a false negative age; rollback still fails closed.
  // eslint-disable-next-line react-hooks/purity
  return Date.now()
}
