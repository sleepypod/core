'use client'

import { useState } from 'react'
import type { z } from 'zod'
import { trpc } from '@/src/utils/trpc'
import { Button } from '@/src/components/ds'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { useNowMinute } from '@/src/components/Schedule/CurveChart'
import { responseModelPreviewSchema, type responseModelStatusSchema } from '@/src/comfort/response-model-contract'
import { currentLearningRead } from './learningJourneyModel'

type Status = z.infer<typeof responseModelStatusSchema>
const actionClass = 'min-h-11 w-full min-w-0 max-w-full whitespace-normal text-sm sm:w-auto'

/** These explicit actions fit or inspect an inert model; neither action sends a target to hardware. */
export function TargetResponseEvaluation({ status, onSaved }: { status: Status, onSaved: () => void }) {
  const [requested, setRequested] = useState(false)
  const minute = useNowMinute(), now = minute === null ? null : minute * 60_000
  const { formatTemp, unit } = useTemperatureUnit()
  const temperature = (fahrenheit: number) => formatTemp((fahrenheit - 32) * 5 / 9)
  const errorDegrees = (fahrenheit: number) => `${(fahrenheit * (unit === 'C' ? 5 / 9 : 1)).toFixed(2)}°${unit}`
  const preview = trpc.comfort.targetResponsePreview.useQuery({ side: status.side }, {
    enabled: false, retry: false, refetchOnWindowFocus: false,
  })
  const train = trpc.comfort.trainTargetResponseModel.useMutation({ onSuccess: onSaved })
  const model = status.model, passed = model?.current === true && model.horizons.every(horizon => horizon.validation.passes)
  const parsed = responseModelPreviewSchema.safeParse(preview.data)
  const data = passed && requested && !train.isPending && !train.error
    && currentLearningRead(now, preview.dataUpdatedAt, Boolean(preview.error), preview.isFetching)
    && parsed.success && parsed.data.side === status.side && now !== null
    && parsed.data.generatedAt <= now + 60_000 && now - parsed.data.generatedAt <= 90_000
    ? parsed.data
    : null
  const fittedSameEvidence = model?.current && model.datasetHash === status.datasetHash
  return (
    <div className="space-y-3 border-t border-line pt-5" aria-label="Target-response evaluation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-base font-medium">Can small changes be predicted?</h5>
        <span className="text-sm text-fg-2">{model ? !model.current ? 'Needs recheck' : passed ? 'Research preview' : 'Not reliable yet' : status.canTrain ? 'Ready to evaluate' : 'Collecting evidence'}</span>
      </div>
      <p className="max-w-prose text-sm text-fg-2">{status.reason}</p>
      {model && (
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-3 font-medium">How the model was checked</summary>
          <p className="max-w-prose text-fg-2">{`${model.trainingDates.length} earlier nights fit the model, ${model.calibrationDates.length} separate nights set its error band, and ${model.validationDates.length} later nights test it.`}</p>
          {!model.current && <p className="mt-3 text-fg-2">These are saved evaluation results. They cannot support a current prediction until the source checks pass.</p>}
          <div className="divide-y divide-line">
            {model.horizons.map(horizon => (
              <div key={horizon.minutes} className="space-y-2 py-4">
                <p className="font-medium">{`${horizon.minutes} minutes · ${horizon.validation.passes ? 'Passed comparison' : 'Comparison not passed'}`}</p>
                <dl className="space-y-2">
                  {[
                    ['Average prediction error', errorDegrees(horizon.validation.modelMaeF)],
                    ['Best simple alternative', errorDegrees(Math.min(horizon.validation.persistenceMaeF, horizon.validation.simpleMaeF, horizon.validation.trendMaeF))],
                    ['Results inside the error band', `${Math.round(horizon.validation.intervalCoverage * 100)}%`],
                    ['Comparable test conditions', `${Math.round(horizon.validation.supportedFraction * 100)}%`],
                  ].map(([label, value]) => (
                    <div key={label} className="flex flex-wrap justify-between gap-x-5 gap-y-1">
                      <dt className="text-fg-2">{label}</dt>
                      <dd className="font-medium tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          <p className="max-w-prose pb-3 text-fg-2">Lower error is better. Comparisons include holding the last water reading, following the recent trend and a simple target response. A passing result does not prove that a change would improve your comfort.</p>
        </details>
      )}
      {status.canTrain && !fittedSameEvidence && (
        <div className="space-y-2">
          <p className="max-w-prose text-sm text-fg-2">Evaluate these reviewed nights locally on the Pod. This saves a research model and its test results; your routine stays in place.</p>
          <Button
            className={actionClass}
            disabled={train.isPending || Boolean(train.error)}
            onClick={() => {
              setRequested(false)
              train.mutate({ side: status.side, expectedDatasetHash: status.datasetHash })
            }}
          >
            {train.isPending ? 'Evaluating later nights…' : 'Evaluate response model'}
          </Button>
        </div>
      )}
      {train.error && <p role="alert" className="text-sm text-danger">The evaluation could not be saved or verified. Check evidence again before retrying.</p>}
      {passed && (
        <div className="space-y-3">
          <p className="max-w-prose text-sm text-fg-2">Preview nearby targets using current readings. The estimates describe water temperature after a small change. No target is selected or sent to your bed.</p>
          <Button
            variant="secondary"
            className={actionClass}
            disabled={preview.isFetching || train.isPending || Boolean(train.error)}
            onClick={() => {
              setRequested(true)
              void preview.refetch()
            }}
          >
            {preview.isFetching ? 'Checking current readings…' : requested ? 'Refresh response preview' : 'Preview nearby targets'}
          </Button>
          {data && (
            <div className="space-y-4">
              <p role="status" className="text-sm text-fg-2">{data.reason}</p>
              {data.candidates.map(candidate => (
                <div key={candidate.targetF} className="space-y-2 border-t border-line pt-4">
                  <p className="text-sm font-medium">{`If the target were ${temperature(candidate.targetF)}`}</p>
                  {candidate.predictions.map(prediction => (
                    <div key={prediction.minutes} className="space-y-1 text-sm">
                      <p>{`${prediction.minutes} minutes: ${temperature(prediction.waterF)} estimated water`}</p>
                      <p className="text-fg-2">{`${temperature(prediction.lowerF)}–${temperature(prediction.upperF)} observed error range`}</p>
                    </div>
                  ))}
                  {candidate.predictions.length === 0 && <p className="text-sm text-fg-2">{candidate.reason}</p>}
                </div>
              ))}
            </div>
          )}
          {requested && !data && (
            <p role={preview.error ? 'alert' : 'status'} className="text-sm text-fg-2">
              {preview.isFetching ? 'Reading fresh water and room conditions…' : 'No current preview is available. Refresh the preview when the Pod is connected and readings are fresh.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
