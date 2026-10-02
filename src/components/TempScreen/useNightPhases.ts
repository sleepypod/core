'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { TempDisplay } from '@/src/providers/PrefsProvider'
import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { nightPhases, phaseShiftUpdates, stepForDisplay, templateBatch, templateRows, type NightPhaseKey, type NightPhases } from './nightPhases'

/** Taps within this window batch into one schedule write. */
const COMMIT_DELAY_MS = 700
/** Give up on an optimistic value the server never reports. */
const OPTIMISTIC_TIMEOUT_MS = 8_000

type Pending = Partial<Record<NightPhaseKey, number>>
type TimerKey = NightPhaseKey | 'draft'

export interface SideNightPhases {
  /** Tonight's phases — or the template's while `draft`. */
  phases: NightPhases | null
  /** No schedule tonight: phases come from the template and the first nudge creates it. */
  draft: boolean
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
 * schedules.batchUpdate, which reloads only the touched scheduler jobs.
 *
 * With a schedule, each edit shifts the phase's set points by one delta on
 * every day that shares tonight's curve. Without one, Night / Dawn preview
 * the balanced template curve; the first edit writes it (with the chosen
 * values) to every night that has no schedule.
 */
export function useNightPhases(side: Side, now: Date, unit: TempUnit, display: TempDisplay, enabled: boolean): SideNightPhases {
  const utils = trpc.useUtils()
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side }, { enabled })
  const batch = trpc.schedules.batchUpdate.useMutation()
  const [pending, setPending] = useState<Pending>({})
  // Draft commits read every nudged phase at fire time, not at schedule time.
  const pendingRef = useRef<Pending>({})
  const timers = useRef<Partial<Record<TimerKey, ReturnType<typeof setTimeout>>>>({})
  const expiry = useRef<Partial<Record<NightPhaseKey, ReturnType<typeof setTimeout>>>>({})

  const rows = data?.temperature
  const real = rows ? nightPhases(rows, now) : null
  const template = rows && !real ? templateRows(rows) : null
  const templatePhases = template ? nightPhases(template, now) : null
  const phases = real ?? templatePhases
  const draft = real == null && templatePhases != null

  const serverF = useCallback((phase: NightPhaseKey) => {
    const p = phases?.[phase]
    return p ? Math.round(p.temperatureF) : null
  }, [phases])

  // Drop an optimistic value once the schedule reports it.
  useEffect(() => {
    if (draft) return
    for (const phase of ['night', 'dawn'] as const) {
      const want = pending[phase]
      if (want != null && timers.current[phase] == null && serverF(phase) === want) {
        clearTimeout(expiry.current[phase])
        setPending(p => ({ ...p, [phase]: undefined }))
      }
    }
  }, [pending, serverF, draft])

  useEffect(() => () => {
    for (const t of Object.values(timers.current)) clearTimeout(t)
    for (const t of Object.values(expiry.current)) clearTimeout(t)
  }, [])

  const { mutate } = batch
  const settle = useCallback((phaseKeys: NightPhaseKey[]) => ({
    onSettled: () => {
      void utils.schedules.getAll.invalidate()
      for (const k of phaseKeys) {
        expiry.current[k] = setTimeout(() => setPending(p => ({ ...p, [k]: undefined })), OPTIMISTIC_TIMEOUT_MS)
      }
    },
    onError: () => {
      pendingRef.current = {}
      setPending(p => Object.fromEntries(Object.entries(p).filter(([k]) => !phaseKeys.includes(k as NightPhaseKey))))
    },
  }), [utils])

  const commit = useCallback((phase: NightPhaseKey, targetF: number) => {
    timers.current[phase] = undefined
    const from = serverF(phase)
    if (!rows || !real || from == null) return
    const temperature = phaseShiftUpdates(rows, real, phase, targetF - from)
    if (temperature.length === 0) {
      setPending(p => ({ ...p, [phase]: undefined }))
      return
    }
    mutate({ updates: { temperature, power: [], alarm: [] } }, settle([phase]))
  }, [rows, real, serverF, mutate, settle])

  // One write for the whole template, however many phases were nudged.
  const commitDraft = useCallback(() => {
    timers.current.draft = undefined
    if (!data || !template || !templatePhases) return
    const targets = pendingRef.current
    pendingRef.current = {}
    mutate(templateBatch(side, data, template, templatePhases, targets), settle(['night', 'dawn']))
  }, [data, template, templatePhases, side, mutate, settle])

  const nudge = useCallback((phase: NightPhaseKey, delta: number) => {
    const base = pending[phase] ?? serverF(phase)
    if (base == null || (draft && batch.isPending)) return
    const next = stepForDisplay(base, delta, unit, display)
    const key: TimerKey = draft ? 'draft' : phase
    clearTimeout(timers.current[key])
    clearTimeout(expiry.current[phase])
    setPending(p => ({ ...p, [phase]: next }))
    pendingRef.current = { ...pendingRef.current, [phase]: next }
    timers.current[key] = setTimeout(() => (draft ? commitDraft() : commit(phase, next)), COMMIT_DELAY_MS)
  }, [pending, serverF, draft, batch.isPending, unit, display, commit, commitDraft])

  return {
    phases,
    draft,
    isLoading: enabled && isLoading,
    error: error?.message ?? null,
    saving: batch.isPending,
    valueF: phase => pending[phase] ?? serverF(phase),
    nudge,
  }
}
