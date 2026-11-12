'use client'

import { useState } from 'react'
import { Button } from '@/src/components/ds'
import type { Side } from '@/src/hardware/types'
import { predictiveRecordingStatusSchema } from '@/src/comfort/predictive-recording-contract'
import { trpc } from '@/src/utils/trpc'

/** Historical counts are an observation of collection, never an activation milestone. */
export function PredictiveRecordingStatus({ side }: { side: Side }) {
  const [requested, setRequested] = useState(false)
  const [checkedAt, setCheckedAt] = useState(() => Date.now())
  const query = trpc.comfort.predictiveRecordings.useQuery({ side }, { enabled: false, retry: false, refetchOnWindowFocus: false })
  const parsed = predictiveRecordingStatusSchema.safeParse(query.data)
  const data = requested && parsed.success && parsed.data.side === side && parsed.data.generatedAt <= checkedAt
    && !query.error && !query.isFetching
    ? parsed.data
    : null
  return (
    <section aria-label="Preview recordings" className="space-y-3 border-t border-line pt-4">
      <h5 className="text-sm font-medium">Learning while the app is closed</h5>
      <p className="max-w-prose text-sm text-fg-2">During eligible Preview periods, the Pod saves a comparison up to every five minutes. This keeps a record of what the model suggested before the outcome is known.</p>
      <Button
        variant="secondary"
        className="min-h-11 w-full min-w-0 whitespace-normal text-sm sm:w-auto"
        disabled={query.isFetching}
        onClick={() => {
          setRequested(true)
          setCheckedAt(Date.now())
          void query.refetch().finally(() => setCheckedAt(Date.now()))
        }}
      >
        {query.isFetching ? 'Reading Preview recordings…' : requested ? 'Refresh Preview recordings' : 'Check Preview recordings'}
      </Button>
      {data && (
        <div className="space-y-3" role="status">
          <p className="text-sm font-medium tabular-nums">{`${data.records} comparisons · ${data.sessions} routine sessions`}</p>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            {([['Keep target', data.holds], ['Research candidate', data.candidates], ['Withheld', data.withheld]] as const).map(([label, value]) => (
              <div key={label} className="min-w-0 rounded-lg bg-bg-2 p-3">
                <dt className="text-fg-2">{label}</dt>
                <dd className="mt-1 text-base tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="max-w-prose text-sm text-fg-2">{data.reason}</p>
          <p className="max-w-prose text-sm text-fg-2">{data.outcomeNotice}</p>
          {data.latestAt !== null && <p className="text-xs text-fg-3">{`Latest comparison: ${new Date(data.latestAt).toLocaleString()}. Status checked ${new Date(data.generatedAt).toLocaleString()}.`}</p>}
          {data.collector?.fault && <p className="text-sm text-fg-2" role="alert">{data.collector.fault}</p>}
          {data.collector?.running === false && <p className="text-sm text-fg-2">The background collector was not running when this status was read.</p>}
        </div>
      )}
      {requested && !data && !query.isFetching && <p role="alert" className="text-sm text-fg-2">Preview recording status could not be verified. Check the connection and Core version, then refresh.</p>}
    </section>
  )
}
