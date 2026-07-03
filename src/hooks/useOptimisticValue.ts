'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Optimistic UI value reconciled against a server-observed value.
 *
 * Device mutations are reflected in the UI through the WS status stream
 * (~2s cadence); clearing local state in a mutation's onSettled therefore
 * snaps the control back to the stale server value before the next frame
 * arrives, then forward again. This hook keeps the optimistic value visible
 * until the server actually reports it (or a timeout expires as a fallback
 * so a failed/ignored write can't pin the UI forever).
 *
 * Not for values where `null` is meaningful — `null` is the "no local
 * override" sentinel.
 */
export function useOptimisticValue<T>(serverValue: T, timeoutMs = 6_000) {
  const [local, setLocal] = useState<T | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // Reconcile: once the server reports the optimistic value, it is no longer
  // an override — drop it so later external changes show through.
  useEffect(() => {
    if (local !== null && Object.is(serverValue, local)) {
      clearTimer()
      setLocal(null)
    }
  }, [serverValue, local])

  // Drop any pending timer on unmount
  useEffect(() => clearTimer, [])

  /** Show a value immediately with no expiry — for in-progress interactions
   * (e.g. dial drag) that will end in commit() or discard(). */
  const preview = useCallback((value: T) => {
    clearTimer()
    setLocal(value)
  }, [])

  /** Show a value immediately and hold it until the server confirms it or
   * timeoutMs passes (fallback to server truth). */
  const commit = useCallback((value: T) => {
    clearTimer()
    setLocal(value)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setLocal(null)
    }, timeoutMs)
  }, [timeoutMs])

  /** Revert to server truth immediately (e.g. mutation error). */
  const discard = useCallback(() => {
    clearTimer()
    setLocal(null)
  }, [])

  return {
    value: local ?? serverValue,
    isOptimistic: local !== null,
    preview,
    commit,
    discard,
  }
}
