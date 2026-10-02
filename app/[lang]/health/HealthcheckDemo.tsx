'use client'

import { trpc } from '@/src/utils/trpc'
import { Trans } from '@lingui/react/macro'

export function HealthcheckDemo() {
  const healthcheck = trpc.healthcheck.useQuery({})

  return (
    <div className="space-y-3">
      <div className="rounded-card border border-line bg-surface px-[18px] py-4">
        <h2 className="text-[15px] font-medium">tRPC Demo</h2>
        <h3 className="mt-1 text-[13px] text-fg-2"><Trans>Hello, tRPC test page!</Trans></h3>
        <p className="mt-2 text-sm text-fg-2">
          Healthcheck:
          {' '}
          <span className={healthcheck.data ? 'font-mono text-ok' : 'font-mono text-fg-3'}>
            {healthcheck.data ?? 'Loading...'}
          </span>
        </p>
      </div>
    </div>
  )
}
