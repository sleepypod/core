import { QueryClient } from '@tanstack/react-query'
import { httpBatchStreamLink } from '@trpc/client'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from './trpc'
import { transformer } from './transformer'
import { getBaseUrl } from './url'

export function createWebQueryClient(): QueryClient {
  const client = new QueryClient()
  // Mutations already invalidate these queries. Live device/sensor queries
  // retain their own freshness policies, including refetch on reconnect.
  client.setQueryDefaults(getQueryKey(trpc.settings.getAll), { staleTime: 30_000 })
  client.setQueryDefaults(getQueryKey(trpc.schedules), { staleTime: 30_000 })
  return client
}

export function createWebTRPCClient() {
  return trpc.createClient({
    links: [
      // Deliver fast queries even while hardware/history queries are pending.
      httpBatchStreamLink({ url: getBaseUrl() + '/api/trpc', transformer }),
    ],
  })
}
