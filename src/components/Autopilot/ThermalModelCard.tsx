'use client'

import { trpc } from '@/src/utils/trpc'
import type { Side } from '@/src/hardware/types'
import { Button } from '@/src/components/ds'

/** Model readiness is separate from activation: training never changes a bed setting. */
export function ThermalModelCard({ side }: { side: Side }) {
  const utils = trpc.useUtils()
  const query = trpc.comfort.thermalModel.useQuery({ side }, { refetchOnWindowFocus: false, retry: false })
  const train = trpc.comfort.trainThermalModel.useMutation({ onSuccess: () => {
    void utils.comfort.thermalModel.invalidate({ side })
  } })
  const data = query.data
  const preview = trpc.comfort.thermalModelPreview.useQuery({ side }, {
    enabled: data?.model?.current === true, refetchOnWindowFocus: false, retry: false,
  })
  const busy = query.isFetching || train.isPending
  return (
    <section className="mt-6 space-y-4 rounded-card border border-line bg-surface p-4 sm:p-5" aria-label="On-Pod temperature model">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-medium">Your temperature model</h3>
        <span className="rounded-full bg-cool/10 px-3 py-1 text-xs text-cool">Trains locally on your Pod</span>
      </div>
      <p className="text-sm text-fg-2">Learns the direction of your morning comfort feedback from complete nights of bed and room readings. Sleep-stage models and historical Health summaries answer different questions.</p>
      {query.isLoading && <p role="status" className="text-sm">Checking complete nights…</p>}
      {query.error && <p role="alert" className="text-sm text-danger">Could not check model readiness. Reconnect and try again.</p>}
      {data && (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              ['Complete reviewed nights', `${data.completeNights} / ${data.requiredNights}`],
              ['Morning check-ins', String(data.feedbackNights)],
              ['Model status', data.model ? data.model.current ? 'Saved · Preview' : 'Needs recheck' : 'Collecting'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-ctl bg-active p-3">
                <dt className="text-xs text-fg-2">{label}</dt>
                <dd className="mt-2 text-lg font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-fg-2">{data.reason}</p>
          {data.model?.current && (
            <div className="rounded-ctl border border-line p-3 text-sm" aria-label="Model context preview">
              <p className="font-medium">Current context · research preview</p>
              <p className="mt-2 text-fg-2">{preview.error ? 'Current measurements could not be checked.' : preview.data?.reason ?? 'Checking measurements…'}</p>
              <p className="mt-2 text-xs text-fg-2">This model learned whole-night feedback. A single moment does not establish when an overnight adjustment would help.</p>
            </div>
          )}
          {data.model && (
            <details className="rounded-ctl border border-line p-3 text-sm">
              <summary className="cursor-pointer font-medium">Validation on later, unseen nights</summary>
              <p className="mt-3 text-fg-2">{`${data.model.trainingDates.length} earlier nights fitted · ${data.model.validationDates.length} later nights held out. Lower error is better; these are feedback-direction scores, not measured ideal temperatures.`}</p>
              <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {[
                  ['Model error', data.model.validation.modelMae], ['Hold temperature', data.model.validation.holdMae],
                  ['Average feedback', data.model.validation.averageMae],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-fg-2">{label}</dt>
                    <dd>{Number(value).toFixed(2)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-xs text-fg-2">{data.model.validation.reason}</p>
            </details>
          )}
          {data.excluded.length > 0 && (
            <details className="rounded-ctl border border-line p-3 text-sm">
              <summary className="cursor-pointer font-medium">{`Why ${data.excluded.length} check-in nights were excluded`}</summary>
              <ul className="mt-3 space-y-3">
                {data.excluded.map(item => (
                  <li key={item.date}>
                    <time className="font-medium">{item.date}</time>
                    <p className="text-fg-2">{item.reason}</p>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy || Boolean(query.error) || !data.canTrain} onClick={() => train.mutate({ side, expectedDatasetHash: data.datasetHash })}>
              {train.isPending ? 'Training on Pod…' : data.model ? 'Recheck & train model' : 'Train temperature model'}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void query.refetch()
                if (data.model?.current) void preview.refetch()
              }}
            >
              Check nights again
            </Button>
          </div>
        </>
      )}
      {!data && query.error && <Button disabled={busy} onClick={() => { void query.refetch() }}>Retry</Button>}
      {train.error && <p role="alert" className="text-sm text-danger">{train.error.message}</p>}
      {train.isSuccess && <p role="status" className="text-sm">Model and validation saved on your Pod. Temperature control remains unchanged.</p>}
      <p className="text-xs text-fg-2">Training uses reviewed 6–12 hour nights with at least 90% qualified thermal coverage. Partial recordings, changed configurations and wake-up warming are excluded. A successful fit does not establish better sleep or enable adjustments.</p>
    </section>
  )
}
