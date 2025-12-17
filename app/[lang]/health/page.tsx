'use client'

import { trpc } from '@/src/utils/trpc'
import { Trans } from '@lingui/react/macro'

export default function Page() {
  const healthcheck = trpc.healthcheck.useQuery()
  const greeting = trpc.greeting.useQuery({ name: 'tRPC' })

  return (
    <div>
      <div>
        <h2>tRPC Demo</h2>
        <h3><Trans>Hello, tRPC test page!</Trans></h3>
        <p>
          Healthcheck:
          {' '}
          {healthcheck.data ?? 'Loading...'}
        </p>
        <p>
          Greeting:
          {' '}
          {greeting.data ?? 'Loading...'}
        </p>
      </div>
    </div>
  )
}
