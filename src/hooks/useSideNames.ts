'use client'

import { trpc } from '@/src/utils/trpc'

/**
 * Single source of truth for side display names.
 * Reads from settings.getAll and falls back to "Left"/"Right".
 * All components that show side names should use this hook.
 */
export function useSideNames() {
  const { data } = trpc.settings.getAll.useQuery(
    {},
    { staleTime: 30_000 },
  )

  const leftName = data?.sides?.left?.name || 'Left'
  const rightName = data?.sides?.right?.name || 'Right'

  return {
    leftName,
    rightName,
    sideName: (side: 'left' | 'right') => side === 'left' ? leftName : rightName,
  }
}
