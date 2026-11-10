'use client'

import Link from 'next/link'
import { Brain, MoonStar, Thermometer, Smartphone } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import type { Side } from '@/src/hardware/types'
import { Button, SegmentedControl } from '@/src/components/ds'
import { useNowMinute } from '@/src/components/Schedule/CurveChart'
import { useSideNames } from '@/src/hooks/useSideNames'
import { baselineLearning, currentLearningRead, stageLearning, temperatureLearning, type LearningStep } from './learningJourneyModel'

export function LearningJourney({ side, onSideChange, lang, onTemperature }: {
  side: Side
  onSideChange(side: Side): void
  lang: string
  onTemperature(): void
}) {
  const minute = useNowMinute()
  const now = minute === null ? null : minute * 60_000
  const { sideName } = useSideNames()
  const options = { retry: false, refetchOnMount: 'always' as const, refetchOnWindowFocus: 'always' as const }
  const stages = trpc.sleepStages.getModel.useQuery({ side }, options)
  const thermal = trpc.comfort.thermalModel.useQuery({ side }, options)
  const stageCurrent = currentLearningRead(now, stages.dataUpdatedAt, Boolean(stages.error), stages.isFetching)
  const thermalCurrent = currentLearningRead(now, thermal.dataUpdatedAt, Boolean(thermal.error), thermal.isFetching)
    && thermal.data?.side === side && now !== null && thermal.data.generatedAt <= now + 60_000 && now - thermal.data.generatedAt <= 300_000
  const steps = [stageLearning(stageCurrent ? stages.data : undefined), baselineLearning,
    temperatureLearning(thermalCurrent ? thermal.data : undefined)]
  const icons = [MoonStar, Brain, Thermometer]
  return (
    <section aria-label="Learning journey" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-card border border-line bg-surface p-5">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-xl font-medium">Three kinds of learning. One useful next step.</h2>
          <p className="text-sm text-fg-2">Start with reliable recordings. Review your actual nights, compare results on unseen data, then decide what to use. Finishing a progress bar never turns on bed control.</p>
        </div>
        <SegmentedControl
          ariaLabel="Learning side"
          value={side}
          onChange={onSideChange}
          options={(['left', 'right'] as const).map(value => ({ value, label: sideName(value) }))}
        />
      </div>
      <div className="grid gap-4 min-[1100px]:grid-cols-3">
        {steps.map((step, index) => {
          const Icon = icons[index]
          return (
            <article key={step.title} aria-label={step.title} className="flex min-w-0 flex-col gap-4 rounded-card border border-line bg-surface p-5">
              <Icon aria-hidden="true" className="size-6 text-cool" />
              <h3 className="text-lg font-medium">{step.title}</h3>
              <p className="w-fit rounded-ctl bg-active px-3 py-1 text-sm text-fg">{step.state}</p>
              <p className="text-sm text-fg-2">{step.description}</p>
              {step.progress && <LearningProgress value={step.progress} />}
              <div className="space-y-2 border-t border-line pt-4">
                <h4 className="text-sm font-medium">Your next step</h4>
                <p className="text-sm text-fg-2">{step.next}</p>
              </div>
              {index === 0 && (
                <Link
                  className="mt-auto min-h-11 rounded-ctl border border-line px-3 py-2 text-center text-sm font-medium focus-visible:outline-2"
                  href={`/${lang}/settings?section=sleep-stages`}
                >
                  {`Model details · choose ${sideName(side)}`}
                </Link>
              )}
              {index === 1 && (
                <p className="mt-auto flex items-center gap-2 text-sm text-fg-2">
                  <Smartphone aria-hidden="true" className="size-5 shrink-0" />
                  No phone Health history is uploaded to this page.
                </p>
              )}
              {index === 2 && <Button className="mt-auto" onClick={onTemperature}>Review temperature learning</Button>}
            </article>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <Button
          variant="secondary"
          disabled={stages.isFetching || thermal.isFetching}
          onClick={() => {
            void stages.refetch()
            void thermal.refetch()
          }}
        >
          Refresh model checks
        </Button>
        <p className="text-fg-2" role="status">
          {stageCurrent && thermalCurrent
            ? 'Current Pod inventory checked. Local phone models are separate.'
            : stages.isFetching || thermal.isFetching ? 'Reading model inventory…' : 'Some model checks are unavailable or expired. Refresh to check again.'}
        </p>
      </div>
      <details className="rounded-card border border-line p-5 text-sm">
        <summary className="cursor-pointer font-medium">What these models cannot establish</summary>
        <p className="mt-3 text-fg-2">A stage model estimates labels. A baseline measures differences from earlier nights. A temperature model predicts comfort feedback in familiar conditions. None establishes a medical diagnosis or improved sleep. Historical Health nights cannot supply missing Pod temperatures, and heart rate alone cannot tell whether you feel hot or cold.</p>
      </details>
    </section>
  )
}

function LearningProgress({ value }: { value: NonNullable<LearningStep['progress']> }) {
  return (
    <div className="space-y-2">
      <p className="text-sm">{`${value.completed} / ${value.required} complete reviewed nights for fitting`}</p>
      <progress
        className="h-2 w-full accent-[var(--accent-cool)]"
        value={Math.min(value.completed, value.required)}
        max={value.required}
        aria-label="Reviewed temperature training nights"
      />
      <p className="text-xs text-fg-2">Coverage only. Validation and activation are separate.</p>
    </div>
  )
}
