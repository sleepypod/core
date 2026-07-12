'use client'

import { Power } from 'lucide-react'
import { useCallback } from 'react'
import { useSide } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { useDeviceStatus } from '@/src/hooks/useDeviceStatus'
import { useOptimisticValue } from '@/src/hooks/useOptimisticValue'
import styles from './PowerButton.module.css'

/**
 * A circular power button wired to the device.setPower tRPC mutation.
 *
 * Behaviour mirrors the iOS app:
 * - Toggles power for the currently selected side(s)
 * - When linked mode is active, toggles both sides simultaneously
 * - Shows visual on/off state via color changes
 * - Optimistic UI: toggles appearance immediately, held until a status frame
 *   confirms it (the visible status is WS-preferred, so an HTTP invalidate
 *   alone never updated the button); reverts on error
 */
export const PowerButton = () => {
  const { activeSides, primarySide } = useSide()
  const utils = trpc.useUtils()

  // Device status via WebSocket (2s push) with HTTP fallback
  const { status } = useDeviceStatus()

  const setPower = trpc.device.setPower.useMutation({
    onSuccess: () => {
      // Invalidate device status to pick up new state
      utils.device.getStatus.invalidate()
    },
  })

  // Whether the primary side is powered, per the latest status frame
  const serverPowered = (() => {
    if (!status) return false
    const side = primarySide === 'left' ? status.leftSide : status.rightSide
    return side?.targetLevel !== 0
  })()

  const powerOpt = useOptimisticValue(serverPowered)
  const isPowered = powerOpt.value

  const handleToggle = useCallback(async () => {
    if (setPower.isPending) return

    const newPowered = !isPowered
    powerOpt.commit(newPowered)

    // Fire mutations for all active sides atomically (both must succeed/fail together)
    try {
      await Promise.all(
        activeSides.map(side =>
          setPower.mutateAsync({
            side,
            powered: newPowered,
            ...(newPowered && { temperature: 75 }),
          })
        )
      )
    }
    catch {
      // Revert the optimistic state and refetch after partial failure
      powerOpt.discard()
      utils.device.getStatus.invalidate()
    }
  }, [isPowered, activeSides, setPower, utils, powerOpt])

  return (
    <button
      className={`${styles.powerButton} ${isPowered ? styles.powerButtonOn : ''}`}
      onClick={handleToggle}
      disabled={setPower.isPending}
      aria-label={isPowered ? 'Turn off' : 'Turn on'}
    >
      <Power size={20} />
    </button>
  )
}
