'use client'

import { useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'
import { useLingui } from '@lingui/react/macro'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { Card, CardHeader, InlineError, LineChart, SegmentedControl, type ChartGuide, type ChartMarker } from '@/src/components/ds'
import { useSideNames } from '@/src/hooks/useSideNames'
import { WatchUpload } from '../WatchUpload'

type Report = inferRouterOutputs<AppRouter>['biometrics']['compareToWatch']
type Night = Report['nights'][number]
type Metric = 'heartRate' | 'breathingRate' | 'hrv'

const DAY_MS = 24 * 60 * 60 * 1000
/** One query covers the widest window; the selector narrows it on the client. */
const FETCH_DAYS = 31
const WINDOWS = ['7', '14', '31'] as const
type WindowDays = typeof WINDOWS[number]
const MAE_COLOR = 'var(--chart-1)'
const BIAS_COLOR = 'var(--chart-2)'
const KAPPA_COLOR = 'var(--chart-3)'

/** Any Watch pairing at all: a scored HR, breathing or HRV sample, or scored stage epochs. */
export const hasWatchPairing = (n: Night) => n.heartRate.n + n.breathingRate.n + n.hrv.n > 0 || n.stages !== null

const nan = (v: number | null | undefined) => v ?? Number.NaN

/** 1, 2 or 5 × 10^k, the smallest at or above `raw`. */
function niceStep(raw: number) {
  const pow = 10 ** Math.floor(Math.log10(raw))
  const f = raw / pow
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
}

/** A domain that always includes zero, snapped to about three steps, with a guide per step and zero drawn strong. */
export function deviationScale(values: number[]) {
  const finite = values.filter(Number.isFinite)
  const lo = Math.min(0, ...finite)
  const hi = Math.max(0, ...finite)
  const step = niceStep((hi - lo) / 3 || 1)
  const min = Math.floor(lo / step) * step
  const max = Math.max(Math.ceil(hi / step) * step, min + step)
  const guides: ChartGuide[] = []
  for (let v = min; v <= max + step / 2; v += step) {
    const value = Number(v.toFixed(6))
    guides.push({ value, label: String(value), strong: value === 0 })
  }
  return { min, max, guides }
}

/**
 * Profile changes drawn between the nights they fall between, as a fractional
 * index; changes before the first or after the last shown night have no
 * before/after to separate, so they are left out. Changes between the same
 * two nights share one hairline.
 */
export function changeMarkers(nights: Array<{ enteredBedAt: Date }>, changes: Report['configChanges']): ChartMarker[] {
  const byAt = new Map<number, number[]>()
  for (const c of changes) {
    const next = nights.findIndex(n => n.enteredBedAt.getTime() >= c.atMs)
    if (next <= 0) continue
    byAt.set(next - 0.5, [...(byAt.get(next - 0.5) ?? []), c.generation])
  }
  return [...byAt].map(([at, gens]) => ({ at, label: `gen ${gens.join(', ')}` }))
}

function dayFormatter(timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone })
  }
  catch {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  }
}

const signed = (v: number, digits: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`

/**
 * Night-by-night deviation of the pod from the Apple Watch for this side, one
 * small chart per metric, with the side's profile changes marked, so a change
 * can be judged by whether the nights after it sit closer to zero. Renders
 * only a one-line upload hint until a night in the last 31 days pairs with
 * Watch data.
 */
export function WatchDeviationTrend({ side, timezone }: { side: 'left' | 'right', timezone: string }) {
  const { t } = useLingui()
  const { sideName } = useSideNames()
  const [endMs] = useState(() => Date.now())
  const [days, setDays] = useState<WindowDays>('14')
  const report = trpc.biometrics.compareToWatch.useQuery(
    { side, startDate: new Date(endMs - FETCH_DAYS * DAY_MS), endDate: new Date(endMs) },
    { staleTime: 5 * 60_000 },
  )

  if (report.error) return <InlineError>{report.error.message}</InlineError>
  if (!report.data) return null
  const all = report.data.nights.map(n => ({ ...n, enteredBedAt: new Date(n.enteredBedAt) }))
  if (!all.some(hasWatchPairing)) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 text-[13px] text-fg-2">
        <span>{t`Upload Apple Watch data to see how far this side's readings sit from the Watch, night by night.`}</span>
        <WatchUpload side={side} name={sideName(side)} />
      </div>
    )
  }

  const nights = all.filter(n => n.enteredBedAt.getTime() >= endMs - Number(days) * DAY_MS)
  const day = dayFormatter(timezone)
  const dates = nights.map(n => day.format(n.enteredBedAt))
  const markers = changeMarkers(nights, report.data.configChanges)
  const units: Record<Metric, string> = { heartRate: t`bpm`, breathingRate: t`br/min`, hrv: t`ms` }
  const titles: Record<Metric, string> = { heartRate: t`Heart rate`, breathingRate: t`Breathing rate`, hrv: t`HRV` }
  const any = nights.some(hasWatchPairing)

  return (
    <Card className="gap-3.5">
      <CardHeader
        title={t`Deviation from Apple Watch`}
        subtitle={t`Pod − Watch per night, by bed-entry date. The goal is zero; dashed lines mark profile changes.`}
        right={(
          <SegmentedControl
            size="sm"
            ariaLabel={t`Deviation window`}
            value={days}
            onChange={setDays}
            options={WINDOWS.map(w => ({ value: w, label: t`${w} d` }))}
          />
        )}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-fg-2">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3.5 rounded-full" style={{ background: MAE_COLOR }} />
          {t`MAE`}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3.5 border-t-2 border-dashed" style={{ borderColor: BIAS_COLOR }} />
          {t`bias (+ = pod reads high)`}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3.5 rounded-full" style={{ background: KAPPA_COLOR }} />
          {t`stage kappa`}
        </span>
        {markers.length > 0 && <span>{t`┆ gen N profile change`}</span>}
      </div>
      {!any
        ? <p className="border-t border-line pt-3 text-[13px] text-fg-2">{t`No night in the last ${days} days pairs with Watch data. Pick a longer window.`}</p>
        : (
            <div className="@container">
              <div className="grid gap-x-5 gap-y-4 @min-[520px]:grid-cols-2">
                {(['heartRate', 'breathingRate', 'hrv'] as const).map(metric => (
                  <DeviationPanel
                    key={metric}
                    title={titles[metric]}
                    unit={units[metric]}
                    mae={nights.map(n => nan(n[metric].mae))}
                    bias={nights.map(n => nan(n[metric].bias))}
                    dates={dates}
                    markers={markers}
                    note={metric === 'hrv' ? report.data.hrvNote : undefined}
                  />
                ))}
                <KappaPanel kappa={nights.map(n => nan(n.stages?.kappa))} dates={dates} markers={markers} />
              </div>
            </div>
          )}
      {any && <DeviationTable nights={nights} dates={dates} units={units} />}
    </Card>
  )
}

function Ticks({ dates }: { dates: string[] }) {
  return (
    <div className="ml-7 flex justify-between pt-1 font-mono text-[10px] text-fg-3">
      <span>{dates[0]}</span>
      {dates.length > 1 && <span>{dates[dates.length - 1]}</span>}
    </div>
  )
}

function lastFinite(values: number[]) {
  for (let i = values.length - 1; i >= 0; i--) if (Number.isFinite(values[i])) return values[i]
  return null
}

function DeviationPanel({ title, unit, mae, bias, dates, markers, note }: {
  title: string
  unit: string
  mae: number[]
  bias: number[]
  dates: string[]
  markers: ChartMarker[]
  note?: string
}) {
  const { t } = useLingui()
  const scale = deviationScale([...mae, ...bias])
  const lastMae = lastFinite(mae)
  const lastBias = lastFinite(bias)
  const latest = lastMae === null || lastBias === null ? null : t`latest MAE ${lastMae.toFixed(1)}, bias ${signed(lastBias, 1)} ${unit}`
  const hasData = mae.some(Number.isFinite) || bias.some(Number.isFinite)
  return (
    <section className="flex min-w-0 flex-col gap-1.5" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="text-fg">
          {title}
          <span className="text-fg-3">{` · ${unit}`}</span>
        </span>
        {latest && <span className="font-mono text-[11px] text-fg-2">{latest}</span>}
      </div>
      {hasData
        ? (
            <div role="img" aria-label={t`${title}: MAE and bias per night, pod minus Watch, in ${unit}.${latest ? ` ${latest}.` : ''}`} className="pt-1">
              <LineChart
                className="ml-7"
                height={96}
                min={scale.min}
                max={scale.max}
                guides={scale.guides}
                markers={markers}
                series={[
                  { data: mae, color: MAE_COLOR, width: 2, dots: true },
                  { data: bias, color: BIAS_COLOR, width: 2, dots: true, dash: true },
                ]}
                xLabel={i => dates[i] ?? ''}
                format={(v, s) => s === 0 ? `MAE ${v.toFixed(1)}` : `bias ${signed(v, 1)}`}
              />
              <Ticks dates={dates} />
            </div>
          )
        : <p className="grid h-[96px] place-items-center text-xs text-fg-3">{t`No Watch pairs in these nights`}</p>}
      {note && <p className="text-[11px] leading-snug text-fg-3">{note}</p>}
    </section>
  )
}

function KappaPanel({ kappa, dates, markers }: { kappa: number[], dates: string[], markers: ChartMarker[] }) {
  const { t } = useLingui()
  const last = lastFinite(kappa)
  const min = Math.min(0, ...kappa.filter(Number.isFinite))
  const guides: ChartGuide[] = [
    ...(min < 0 ? [{ value: -0.5, label: '-0.5' }] : []),
    { value: 0, label: '0', strong: true },
    { value: 0.5, label: '0.5' },
    { value: 1, label: '1' },
  ]
  return (
    <section className="flex min-w-0 flex-col gap-1.5" aria-label={t`Sleep stages`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-fg">
          {t`Sleep stages`}
          <span className="text-fg-3">{` · ${t`kappa`}`}</span>
        </span>
        {last !== null && <span className="font-mono text-[11px] text-fg-2">{t`latest ${last.toFixed(2)}`}</span>}
      </div>
      {kappa.some(Number.isFinite)
        ? (
            <div role="img" aria-label={t`Sleep stages: Cohen's kappa against the Watch per night, 1 is full agreement.${last !== null ? ` Latest ${last.toFixed(2)}.` : ''}`} className="pt-1">
              <LineChart
                className="ml-7"
                height={96}
                min={min < 0 ? -0.5 : 0}
                max={1}
                guides={guides}
                markers={markers}
                series={[{ data: kappa, color: KAPPA_COLOR, width: 2, dots: true }]}
                xLabel={i => dates[i] ?? ''}
                format={v => `kappa ${v.toFixed(2)}`}
              />
              <Ticks dates={dates} />
            </div>
          )
        : <p className="grid h-[96px] place-items-center text-xs text-fg-3">{t`No Watch stages in these nights`}</p>}
      <p className="text-[11px] leading-snug text-fg-3">{t`Every night is re-scored with the current stage rules; higher is better.`}</p>
    </section>
  )
}

function DeviationTable({ nights, dates, units }: { nights: Array<Night & { enteredBedAt: Date }>, dates: string[], units: Record<Metric, string> }) {
  const { t } = useLingui()
  const cell = (v: number | null | undefined, digits: number, sign = false) => v == null ? '—' : sign ? signed(v, digits) : v.toFixed(digits)
  return (
    <details className="text-xs text-fg-2">
      <summary className="cursor-pointer">{t`Nights as a table`}</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-left font-mono text-[11px]">
          <caption className="sr-only">{t`Pod minus Watch per night: MAE and bias per metric, and stage kappa`}</caption>
          <thead className="text-fg-3">
            <tr>
              <th scope="col" className="py-1 pr-3 font-normal">{t`Night`}</th>
              <th scope="col" className="py-1 pr-3 font-normal">{t`HR MAE / bias (${units.heartRate})`}</th>
              <th scope="col" className="py-1 pr-3 font-normal">{t`Breathing MAE / bias (${units.breathingRate})`}</th>
              <th scope="col" className="py-1 pr-3 font-normal">{t`HRV MAE / bias (${units.hrv})`}</th>
              <th scope="col" className="py-1 font-normal">{t`Kappa`}</th>
            </tr>
          </thead>
          <tbody>
            {nights.map((n, i) => (
              <tr key={n.sleepRecordId} className="border-t border-line">
                <th scope="row" className="py-1 pr-3 font-normal text-fg">{dates[i]}</th>
                {(['heartRate', 'breathingRate', 'hrv'] as const).map(m => (
                  <td key={m} className="py-1 pr-3">{`${cell(n[m].mae, 1)} / ${cell(n[m].bias, 1, true)}`}</td>
                ))}
                <td className="py-1">{cell(n.stages?.kappa, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
