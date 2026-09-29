'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { TempDisplay } from '@/src/providers/PrefsProvider'
import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { nightPhases, phaseShiftUpdates, stepForDisplay, type NightPhaseKey, type NightPhases } from './nightPhases'

/** Taps within this window batch into one schedule write. */
const COMMIT_DELAY_MS = 700
/** Give up on an optimistic value the server never reports. */
const OPTIMISTIC_TIMEOUT_MS = 8_000

type Pending = Partial<Record<NightPhaseKey, number>>

export interface SideNightPhases {
  phases: NightPhases | null
  isLoading: boolean
  error: string | null
  saving: boolean
  /** Shown value per phase, °F — optimistic while taps are batching or saving. */
  valueF: (phase: NightPhaseKey) => number | null
  /** ± one display step on a phase; writes after a short pause. */
  nudge: (phase: NightPhaseKey, delta: number) => void
}

/**
 * Tonight's Night / Dawn temperatures for one side, editable. Reads
 * schedules.getAll (same cache as TonightCard) and writes through
 * schedules.batchUpdate, which reloads only the touched scheduler jobs —
 * each edit shifts the phase's set points by one delta on every day that
 * shares tonight's curve.
 */
export function useNightPhases(side: Side, now: Date, unit: TempUnit, display: TempDisplay, enabled: boolean): SideNightPhases {
  const utils = trpc.useUtils()
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side }, { enabled })
  const batch = trpc.schedules.batchUpdate.useMutation()
  const [pending, setPending] = useState<Pending>({})
  const timers = useRef<Partial<Record<NightPhaseKey, ReturnType<typeof setTimeout>>>>({})
  const expiry = useRef<Partial<Record<NightPhaseKey, ReturnType<typeof setTimeout>>>>({})

  const rows = data?.temperature
  const phases = rows ? nightPhases(rows, now) : null
  const serverF = useCallback((phase: NightPhaseKey) => {
    const p = phases?.[phase]
    return p ? Math.round(p.temperatureF) : null
  }, [phases])

  // Drop an optimistic value once the schedule reports it.
  useEffect(() => {
    for (const phase of ['night', 'dawn'] as const) {
      const want = pending[phase]
      if (want != null && timers.current[phase] == null && serverF(phase) === want) {
        clearTimeout(expiry.current[phase])

        setPending(p => ({ ...p, [phase]: undefined }))
      }
    }
  }, [pending, serverF])

  useEffect(() => () => {
    for (const t of Object.values(timers.current)) clearTimeout(t)
    for (const t of Object.values(expiry.current)) clearTimeout(t)
  }, [])

  const { mutate } = batch
  const commit = useCallback((phase: NightPhaseKey, targetF: number) => {
    timers.current[phase] = undefined
    const from = serverF(phase)
    if (!rows || !phases || from == null) return
    const temperature = phaseShiftUpdates(rows, phases, phase, targetF - from)
    const clear = () => setPending(p => ({ ...p, [phase]: undefined }))
    if (temperature.length === 0) {
      clear()
      return
    }
    mutate(
      { updates: { temperature, power: [], alarm: [] } },
      {
        onSettled: () => {
          void utils.schedules.getAll.invalidate()
          expiry.current[phase] = setTimeout(clear, OPTIMISTIC_TIMEOUT_MS)
        },
        onError: clear,
      },
    )
  }, [rows, phases, serverF, mutate, utils])

  const nudge = useCallback((phase: NightPhaseKey, delta: number) => {
    const base = pending[phase] ?? serverF(phase)
    if (base == null) return
    const next = stepForDisplay(base, delta, unit, display)
    clearTimeout(timers.current[phase])
    clearTimeout(expiry.current[phase])
    setPending(p => ({ ...p, [phase]: next }))
    timers.current[phase] = setTimeout(() => commit(phase, next), COMMIT_DELAY_MS)
  }, [pending, serverF, unit, display, commit])

  return {
    phases,
    isLoading: enabled && isLoading,
    error: error?.message ?? null,
    saving: batch.isPending,
    valueF: phase => pending[phase] ?? serverF(phase),
    nudge,
  }
}
