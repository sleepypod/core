'use client'

import { trpc } from '@/src/utils/trpc'
import { Card, InlineError, SectionLabel, Skeleton } from '@/src/components/ds'
import { VitalsExplorer } from '@/src/components/biometrics/VitalsExplorer'
import { VitalsLegend } from '@/src/components/biometrics/VitalsChart'
import { baselineBand, splitSessions } from '@/src/components/biometrics/biometricsLogic'

/** Nights and Biometrics use the same recorded data, chart, colors and navigation. */
export function NightVitals({ side, start, end }: { side: 'left' | 'right', start: number, end: number }) {
  const range = { side, startDate: new Date(start), endDate: new Date(end) }
  const vitals = trpc.biometrics.getVitals.useQuery({ ...range, limit: 100000 })
  const hr = trpc.biometrics.getReferenceVitals.useQuery({ ...range, limit: 20000 })
  const hrv = trpc.biometrics.getReferenceSamples.useQuery({ ...range, metric: 'hrv_sdnn', limit: 20000 })
  const br = trpc.biometrics.getReferenceSamples.useQuery({ ...range, metric: 'breathing_rate', limit: 20000 })
  const movement = trpc.biometrics.getMovementBuckets.useQuery({ ...range, bucketSeconds: 300, limit: 10000 })
  const points = (vitals.data ?? []).map(r => ({ t: new Date(r.timestamp).getTime(), hr: r.heartRate, hrv: r.hrv, br: r.breathingRate,
    provenanceKey: r.provenance?.processingRunId ?? r.processingRunId ?? 'legacy_unknown', hrvMetricId: r.provenance?.hrvMetricId ?? null }))
  const reference = (hr.data ?? []).map(r => ({ t: new Date(r.timestamp).getTime(), hr: r.heartRate })).sort((a, b) => a.t - b.t)
  const referenceHrv = (hrv.data ?? []).map(r => ({ t: new Date(r.timestamp).getTime(), value: r.value }))
  const referenceBr = (br.data ?? []).map(r => ({ t: new Date(r.timestamp).getTime(), value: r.value }))
  const sessionPoints = points.length
    ? points
    : [...new Set([...reference, ...referenceHrv, ...referenceBr].map(r => r.t))]
        .sort((a, b) => a - b).map(t => ({ t, hr: null, hrv: null, br: null }))
  return (
    <Card className="min-w-0 gap-3">
      <SectionLabel>Vitals through the night</SectionLabel>
      {vitals.error && <InlineError>Could not load this night’s recorded vitals.</InlineError>}
      {(hr.error || hrv.error || br.error) && <InlineError>Some Apple Watch readings could not be loaded.</InlineError>}
      {vitals.isLoading || hr.isLoading || hrv.isLoading || br.isLoading
        ? <Skeleton className="h-80" />
        : sessionPoints.length > 0
          ? <VitalsExplorer key={`${side}-${start}-${end}`} sessions={splitSessions(sessionPoints)} stall={null} bands={{ hr: baselineBand(points, 'hr'), hrv: baselineBand(points, 'hrv'), br: baselineBand(points, 'br') }} reference={reference} referenceHrv={referenceHrv} referenceBr={referenceBr} movement={movement.data ?? []} />
          : <p className="py-6 text-center text-sm text-fg-2">No recorded vitals for this night.</p>}
      <VitalsLegend bandLabel="middle 50% of the night" stalled={false} reference={reference.length > 0} referenceHrv={referenceHrv.length > 0} referenceBr={referenceBr.length > 0} />
      {referenceHrv.length > 0 && <p className="text-xs text-fg-3">Watch SDNN and sleepypod’s window-based IBI variability index use different calculations. They cannot be directly converted; compare their trends, not their absolute values.</p>}
    </Card>
  )
}
