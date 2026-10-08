'use client'

import { trpc } from '@/src/utils/trpc'
import { createWebQueryClient, createWebTRPCClient } from '@/src/utils/webClients'
import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

export const TRPCProvider = ({ children, baseDebug = false }: { children: React.ReactNode, baseDebug?: boolean }) => {
  const [queryClient] = useState(createWebQueryClient)
  const [trpcClient] = useState(() => createWebTRPCClient({ baseDebug }))

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
}
