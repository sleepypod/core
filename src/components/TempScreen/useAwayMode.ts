'use client'

import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'

type SidesAway = Partial<Record<Side, { awayMode?: boolean } | undefined>> | undefined

/**
 * Away mode from the cards and the stage: the same settings.updateSide mutation and
 * getAll invalidation as Settings, so every view agrees. The tapped side shows its new
 * state until the refetch lands; a failed save falls back to the stored value.
 */
export function useAwayMode(sides: SidesAway) {
  const utils = trpc.useUtils()
  const mutation = trpc.settings.updateSide.useMutation({
    onSuccess: () => utils.settings.getAll.invalidate(),
  })

  const isAway = (side: Side) => {
    const sent = mutation.isPending ? mutation.variables : undefined
    return sent?.side === side && sent.awayMode !== undefined ? sent.awayMode : Boolean(sides?.[side]?.awayMode)
  }

  return {
    isAway,
    toggle: (side: Side) => mutation.mutate({ side, awayMode: !isAway(side) }),
    pending: mutation.isPending,
  }
}
