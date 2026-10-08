'use client'

import { trpc } from '@/src/utils/trpc'

export function useBaseAvailable() {
  const { data } = trpc.base.getAvailability.useQuery({}, { staleTime: 30_000, refetchInterval: 30_000, retry: false })
  return data?.configured === true
}
