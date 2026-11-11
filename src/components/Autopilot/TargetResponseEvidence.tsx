'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import type { Side } from '@/src/hardware/types'
import { Button } from '@/src/components/ds'
import { useNowMinute } from '@/src/components/Schedule/CurveChart'
import { responseModelStatusSchema } from '@/src/comfort/response-model-contract'
import { currentLearningRead } from './learningJourneyModel'
import { TargetResponseEvaluation } from './TargetResponseEvaluation'

/** An explicit read keeps evidence inspection separate from training and bed control. */
export function TargetResponseEvidence({ side }: { side: Side }) {
  const [requested, setRequested] = useState(false)
  const minute = useNowMinute(), now = minute === null ? null : minute * 60_000
  const query = trpc.comfort.targetResponseModel.useQuery({ side }, {
    enabled: false, retry: false, refetchOnWindowFocus: false,
  })
  const parsed = responseModelStatusSchema.safeParse(query.data)
  const candidate = parsed.success ? parsed.data : null
  const current = requested && currentLearningRead(now, query.dataUpdatedAt, Boolean(query.error), query.isFetching)
    && candidate?.side === side && now !== null && candidate.generatedAt <= now + 60_000 && now - candidate.generatedAt <= 300_000
  const status = current ? candidate : null
  const data = status?.evidence
  const readable = data && data.status !== 'unavailable'
  return (
    <section aria-label="Learning from small temperature changes" className="max-w-3xl space-y-3 border-t border-line pt-5">
      <h4 className="text-base font-medium">Learning from small changes</h4>
      <p className="max-w-prose text-sm text-fg-2">See what the bed reported after small temperature changes. This reads existing records without running a test on your bed.</p>
      {readable && (
        <>
          <dl className="divide-y divide-line text-sm">
            {[
              ['Usable reviewed nights', `${data.responseNights} of ${data.reviewedNights}`],
              ['Cooling changes observed', String(data.coolingWindows)],
              ['Warming changes observed', String(data.warmingWindows)],
            ].map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-5 py-2">
                <dt className="text-fg-2">{label}</dt>
                <dd className="shrink-0 font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            {data.responseNights >= data.requiredNights
              ? 'Collection milestone reached. A separate model evaluation checks whether later nights can be predicted.'
              : `The first milestone is ${data.requiredNights} usable nights. Keep your comfortable routine and review each night.`}
          </p>
          {data.status === 'partial' && <p role="status" className="text-sm text-fg-2">Some records could not be inspected. Counts cover usable evidence only.</p>}
          {data.exclusions.length > 0 && (
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer py-3 font-medium">Why some changes were excluded</summary>
              <ul className="space-y-3 pb-3">
                {data.exclusions.map(item => (
                  <li key={`${item.date}:${item.reason}`}>
                    <p className="font-medium">
                      <time>{item.date}</time>
                      {item.count > 1 ? ` · ${item.count} checks` : ''}
                    </p>
                    <p className="text-fg-2">{item.reason}</p>
                  </li>
                ))}
              </ul>
              {data.exclusionsTruncated && <p className="text-fg-2">Only the first 300 exclusion summaries are shown.</p>}
            </details>
          )}
        </>
      )}
      {data?.status === 'unavailable' && <p role="status" className="text-sm text-fg-2">{data.reason}</p>}
      {requested && !query.isFetching && !data && (
        <p role={query.error ? 'alert' : 'status'} className="text-sm text-fg-2">
          {query.error
            ? 'Could not read the evidence. Reconnect to your Pod and check again.'
            : 'This check is missing, expired or belongs to another side. Check again for current evidence.'}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          className="min-h-11 w-full min-w-0 max-w-full whitespace-normal text-sm sm:w-auto"
          disabled={query.isFetching}
          onClick={() => {
            setRequested(true)
            void query.refetch()
          }}
        >
          {query.isFetching ? 'Checking recorded changes…' : requested ? 'Check evidence again' : 'Check recorded changes'}
        </Button>
        {query.isFetching && <p role="status" className="text-sm text-fg-2">Reading complete nights and reported water temperatures…</p>}
      </div>
      {status && <TargetResponseEvaluation key={`${side}:${status.generatedAt}`} status={status} onSaved={() => { void query.refetch() }} />}
      <p className="text-sm text-fg-2">Reading evidence and evaluating predictions leave your bed settings unchanged.</p>
      <details className="max-w-prose text-sm">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">About these observations</summary>
        <p className="text-fg-2">These readings belong to this physical half of the bed. They do not establish a person’s body temperature or improved comfort. Historical Health sleep totals cannot replace missing temperature readings. Do not change temperatures just to fill the count.</p>
      </details>
    </section>
  )
}
