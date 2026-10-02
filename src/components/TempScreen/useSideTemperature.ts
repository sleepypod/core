'use client'

import { useCallback, useEffect, useRef } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useOptimisticValue } from '@/src/hooks/useOptimisticValue'
import { TEMP } from '@/src/lib/tempColors'
import type { Side } from '@/src/providers/SideProvider'

interface SideStatus {
  currentTemperature: number | null
  targetTemperature: number | null
  targetLevel: number
}

export interface SideTemperature {
  side: Side
  /** Optimistic target set point, °F. */
  targetF: number
  /** Current bed temperature, °F (null until the pod reports one). */
  bedF: number | null
  isOn: boolean
  tempPending: boolean
  powerPending: boolean
  /** Visual-only drag update — no hardware call. */
  preview: (f: number) => void
  /** Send a set point, holding it on screen until the status stream confirms it. */
  commitTemp: (f: number) => void
  /** −/+ taps: show the value now, send one set point once taps pause. */
  stepTemp: (f: number) => void
  commitPower: (on: boolean) => void
}

/** −/+ taps within this window pool into one setTemperature. */
const STEP_COMMIT_DELAY_MS = 500

/**
 * One side's target/power with optimistic overrides. The visible status is
 * WS-preferred (~2s cadence), so clearing local state in onSettled would snap
 * the control back to the stale value; useOptimisticValue holds the local
 * value until the server reports it (or a timeout gives up).
 */
export function useSideTemperature(
  side: Side,
  sideStatus: SideStatus | undefined,
  holdMinutes: number,
  refetch: () => unknown,
): SideTemperature {
  const setTempMutation = trpc.device.setTemperature.useMutation()
  const setPowerMutation = trpc.device.setPower.useMutation()

  const targetOpt = useOptimisticValue(sideStatus?.targetTemperature ?? TEMP.BASE_F)
  const powerOpt = useOptimisticValue((sideStatus?.targetLevel ?? 0) !== 0)
  const { preview: previewTarget, commit: commitTarget, discard: discardTarget } = targetOpt
  const { commit: commitPowerOpt, discard: discardPower } = powerOpt
  const { mutate: mutateTemp } = setTempMutation
  const { mutate: mutatePower } = setPowerMutation

  const commitTemp = useCallback((f: number) => {
    commitTarget(f)
    mutateTemp(
      // 30 min is the server default; only send an explicit override.
      { side, temperature: f, ...(holdMinutes === 30 ? {} : { holdMinutes }) },
      {
        onSettled: () => { void refetch() },
        onError: () => discardTarget(),
      },
    )
  }, [side, holdMinutes, refetch, commitTarget, discardTarget, mutateTemp])

  const stepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (stepTimer.current) clearTimeout(stepTimer.current)
  }, [])

  const stepTemp = useCallback((f: number) => {
    previewTarget(f)
    if (stepTimer.current) clearTimeout(stepTimer.current)
    stepTimer.current = setTimeout(() => {
      stepTimer.current = null
      commitTemp(f)
    }, STEP_COMMIT_DELAY_MS)
  }, [previewTarget, commitTemp])

  const commitPower = useCallback((on: boolean) => {
    commitPowerOpt(on)
    mutatePower(
      { side, powered: on },
      {
        onSettled: () => { void refetch() },
        onError: () => discardPower(),
      },
    )
  }, [side, refetch, commitPowerOpt, discardPower, mutatePower])

  return {
    side,
    targetF: targetOpt.value,
    bedF: sideStatus?.currentTemperature ?? null,
    isOn: powerOpt.value,
    tempPending: setTempMutation.isPending,
    powerPending: setPowerMutation.isPending,
    preview: previewTarget,
    commitTemp,
    stepTemp,
    commitPower,
  }
}
