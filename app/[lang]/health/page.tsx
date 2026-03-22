'use client'

import { trpc } from '@/src/utils/trpc'
import { Trans } from '@lingui/react/macro'

export default function Page() {
  const healthcheck = trpc.healthcheck.useQuery({})

  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
        <h2 className="text-sm font-medium text-white">tRPC Demo</h2>
        <h3 className="mt-1 text-xs text-zinc-400"><Trans>Hello, tRPC test page!</Trans></h3>
        <p className="mt-2 text-sm text-zinc-300">
          Healthcheck:
          {' '}
          <span className={healthcheck.data ? 'text-emerald-400' : 'text-zinc-500'}>
            {healthcheck.data ?? 'Loading...'}
          </span>
        </p>
      </div>
    </div>
  )
}
