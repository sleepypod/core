'use client'

import { trpc } from '@/src/utils/trpc'
import type { Side } from '@/src/hardware/types'
import { Button } from '@/src/components/ds'

/** Forecast measurements stay separate from comfort suggestions and actuator controls. */
export function WaterForecastCard({ side }: { side: Side }) {
  const utils = trpc.useUtils()
  const query = trpc.comfort.waterForecast.useQuery({ side }, { retry: false, refetchOnWindowFocus: false })
  const preview = trpc.comfort.waterForecastPreview.useQuery({ side }, {
    enabled: query.data?.model?.current === true, retry: false, refetchOnWindowFocus: false,
  })
  const train = trpc.comfort.trainWaterForecast.useMutation({ onSuccess: () => {
    void utils.comfort.waterForecast.invalidate({ side })
    void utils.comfort.waterForecastPreview.invalidate({ side })
  } })
  const data = query.data, busy = query.isFetching || train.isPending
  return (
    <section aria-label="Water temperature forecast" className="mt-6 space-y-4 rounded-card border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-medium">How your bed responds</h3>
        <span className="rounded-full bg-cool/10 px-3 py-1 text-xs text-cool">Water forecast · Preview</span>
      </div>
      <p className="text-sm text-fg-2">Learns 15- and 30-minute water-temperature changes while a target stays steady. This is separate from your body temperature, sleep stages and morning comfort.</p>
      {query.isLoading && <p role="status">Checking complete recordings…</p>}
      {query.error && <p role="alert" className="text-sm text-danger">Water forecast could not be checked. Reconnect or update the controller and try again.</p>}
      {data && (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              ['Reviewed nights', `${data.completeNights} / ${data.requiredNights}`],
              ['Model', data.model ? data.model.current ? 'Saved · Preview' : 'Needs recheck' : 'Collecting'],
              ['Bed adjustments', 'None'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-ctl bg-active p-3">
                <dt className="text-xs text-fg-2">{label}</dt>
                <dd className="mt-2 text-lg font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-fg-2">{data.reason}</p>
          {data.model?.current && (
            <div className="space-y-3 rounded-ctl border border-line p-3">
              <p className="text-sm font-medium">If the current target stays unchanged</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {preview.data?.predictions.map(prediction => (
                  <div key={prediction.minutes}>
                    <p className="text-xs text-fg-2">{`In ${prediction.minutes} minutes`}</p>
                    <p className="text-xl font-medium">{`${prediction.waterF.toFixed(1)}°F water`}</p>
                    <p className="text-xs text-fg-2">{`${prediction.lowerF.toFixed(1)}–${prediction.upperF.toFixed(1)}°F empirical error band`}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-fg-2">{preview.error ? 'Current readings could not be checked.' : preview.data?.reason ?? 'Checking current readings…'}</p>
            </div>
          )}
          {data.model && (
            <details className="rounded-ctl border border-line p-3 text-sm">
              <summary className="cursor-pointer font-medium">Whole-night forecast evaluation</summary>
              <p className="mt-3 text-fg-2">{`${data.model.trainingDates.length} earlier nights fit the model, ${data.model.calibrationDates.length} separate nights set error bands, and ${data.model.validationDates.length} later nights test it.`}</p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {data.model.horizons.map(horizon => (
                  <div key={horizon.minutes} className="rounded-ctl bg-active p-3">
                    <p className="font-medium">{`${horizon.minutes}-minute forecast`}</p>
                    <dl className="mt-2 space-y-2 text-xs">
                      {[
                        ['Model error', `${horizon.validation.modelMaeF.toFixed(2)}°F`],
                        ['Hold last reading', `${horizon.validation.persistenceMaeF.toFixed(2)}°F`],
                        ['Simple target response', `${horizon.validation.simpleMaeF.toFixed(2)}°F`],
                        ['Within error band', `${Math.round(horizon.validation.intervalCoverage * 100)}%`],
                      ].map(([label, value]) => (
                        <div key={label} className="flex flex-wrap justify-between gap-2">
                          <dt className="text-fg-2">{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-3 text-xs text-fg-2">{horizon.validation.reason}</p>
                  </div>
                ))}
              </div>
            </details>
          )}
          {data.excluded.length > 0 && (
            <details className="rounded-ctl border border-line p-3 text-sm">
              <summary className="cursor-pointer">Why recordings were excluded</summary>
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
              {train.isPending ? 'Fitting water forecast…' : 'Train water forecast'}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void query.refetch()
                if (data.model?.current) void preview.refetch()
              }}
            >
              Refresh forecast
            </Button>
          </div>
        </>
      )}
      {!data && query.error && <Button disabled={busy} onClick={() => { void query.refetch() }}>Retry forecast</Button>}
      {train.error && <p role="alert" className="text-sm text-danger">{train.error.message}</p>}
      {train.isSuccess && <p role="status" className="text-sm">Forecast evaluation finished. Review the results; your bed settings were not changed.</p>}
      <p className="text-xs text-fg-2">Uses the same complete, reviewed thermal nights as comfort learning. Partial data, wake warming, unstable targets and long gaps are excluded. Predictions assume a steady target and similar room conditions; they do not establish the effect of changing a target.</p>
    </section>
  )
}
