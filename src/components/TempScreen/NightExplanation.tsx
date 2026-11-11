'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { nightExplanationSchema, type NightExplanation as NightReport } from '@/src/night/contract'
import type { Side } from '@/src/hardware/types'
import { formatSetpointF, type TempUnit } from '@/src/lib/tempUtils'
import { nightKindLabels, nightSourceLabels, nightTemperatureSegments } from './nightExplanationModel'
import { useNow } from './TonightCard'

export function NightExplanation({ side, unit }: { side: Side, unit: TempUnit }) {
  return <NightExplanationForSide key={side} side={side} unit={unit} />
}
function NightExplanationForSide({ side, unit }: { side: Side, unit: TempUnit }) {
  const [open, setOpen] = useState(false)
  const [wakeDate, setWakeDate] = useState('')
  const [filter, setFilter] = useState('all')
  const [visibleCount, setVisibleCount] = useState(30)
  const now = useNow(15_000).getTime()
  const query = trpc.device.nightExplanation.useQuery({ side, ...(wakeDate ? { wakeDate } : {}) }, { enabled: open, retry: false, refetchOnWindowFocus: false })
  const parsed = useMemo(() => nightExplanationSchema.safeParse(query.data), [query.data])
  const report = parsed.success && !query.isError && parsed.data.side === side && (!wakeDate || parsed.data.wakeDate === wakeDate)
    && parsed.data.generatedAt <= now && now - parsed.data.generatedAt < 300_000
    ? parsed.data
    : null
  const clock = (at: number) => new Intl.DateTimeFormat(undefined, { timeZone: report?.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at)
  const events = (report?.events ?? []).filter(event => filter === 'all' || event.source === filter)
  return (
    <section aria-label="Overnight explanation" className="my-5 border-y border-line py-2 [overflow-wrap:anywhere]">
      <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">What happened overnight?</summary>
        <div className="space-y-5 pb-4">
          <p className="max-w-prose text-sm text-fg-2">
            {side === 'left' ? 'Left' : 'Right'}
            {' '}
            physical zone. Follow requests, reported temperatures and reasons changes were held back. A zone does not identify a sleeper.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              Morning of
              <input
                aria-label="Wake date"
                type="date"
                className="min-h-11 max-w-full rounded-ctl border border-line bg-surface px-3 text-fg focus-visible:outline focus-visible:outline-2"
                value={wakeDate || report?.wakeDate || ''}
                onChange={(event) => {
                  setWakeDate(event.target.value)
                  setVisibleCount(30)
                }}
              />
            </label>
            <Button variant="ghost" className="min-h-11 text-sm" disabled={query.isFetching} onClick={() => { void query.refetch() }}>Refresh night</Button>
          </div>
          {query.isFetching && <p role="status" className="text-sm text-fg-2">Reading the selected night…</p>}
          {!report && !query.isFetching && <p role="status" className="max-w-prose text-sm">Night evidence is unavailable or out of date. Choose a started night within the last 30 days, then refresh. Check your Pod connection and its time zone if this continues.</p>}
          {report && (
            <>
              <p className="text-sm text-fg-2">
                {clock(report.start)}
                –
                {clock(report.end)}
                {' '}
                ·
                {' '}
                {report.timeZone}
                . Read
                {' '}
                {clock(report.generatedAt)}
                . Missing records are unknown, not proof that nothing happened.
              </p>
              <NightTemperatures report={report} unit={unit} />
              <div>
                <label className="flex max-w-sm flex-col gap-1 text-sm">
                  Show events
                  <select
                    aria-label="Event source"
                    className="min-h-11 rounded-ctl border border-line bg-surface px-3 text-fg"
                    value={filter}
                    onChange={(event) => {
                      setFilter(event.target.value)
                      setVisibleCount(30)
                    }}
                  >
                    <option value="all">All recorded events</option>
                    <option value="applications">Controller requests</option>
                    <option value="decisions">Personal Autopilot</option>
                    <option value="rules">Automation rules</option>
                  </select>
                </label>
                {report.eventsTruncated && <p className="mt-3 text-sm">Showing the most recent 600 retained events. Earlier events are not included in this view.</p>}
                {!events.length && <p className="py-4 text-sm text-fg-2">No retained events for this selection. Review source availability below; this does not establish that the bed stayed unchanged.</p>}
                <ol className="mt-3 divide-y divide-line">
                  {events.slice(0, visibleCount).map(event => (
                    <li key={event.id} className="py-4">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-fg-2">
                        <time dateTime={new Date(event.at).toISOString()}>{clock(event.at)}</time>
                        <span>{nightKindLabels[event.kind]}</span>
                      </div>
                      <h3 className="mt-1 text-sm font-medium">
                        {event.title}
                        {event.targetF !== null ? ` · ${formatSetpointF(event.targetF, unit)}` : ''}
                      </h3>
                      <p className="mt-1 max-w-prose text-sm">{event.detail}</p>
                      {event.count > 1 && (
                        <p className="mt-1 text-sm text-fg-2">
                          {event.count}
                          {' '}
                          matching recorded evaluations, through
                          {' '}
                          {clock(event.through)}
                          . This count is not continuous sensor coverage.
                        </p>
                      )}
                      {event.scope === 'unassigned' && <p className="mt-1 text-sm text-fg-2">No historical side assignment was recorded for this rule evaluation.</p>}
                      <details className="mt-1 text-xs text-fg-2">
                        <summary className="min-h-11 cursor-pointer py-3">Source detail</summary>
                        <p>
                          {nightSourceLabels[event.source]}
                          {' '}
                          ·
                          {' '}
                          {event.id}
                          . Evidence:
                          {' '}
                          {event.evidence.replaceAll('_', ' ')}
                          .
                        </p>
                        {event.reportedF !== null && (
                          <p>
                            Policy’s recorded temperature:
                            {formatSetpointF(event.reportedF, unit)}
                            . This is the policy snapshot, not a separate sensor sample.
                          </p>
                        )}
                      </details>
                    </li>
                  ))}
                </ol>
                {events.length > visibleCount && <Button className="min-h-11 text-sm" onClick={() => setVisibleCount(count => count + 30)}>Show 30 more events</Button>}
              </div>
              <details>
                <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                  Room conditions ·
                  {' '}
                  {report.room.length}
                  {' '}
                  retained reports
                </summary>
                <p className="max-w-prose text-sm text-fg-2">Latest report per sensor and five-minute bin. The clock label identifies a measurement, device read, integration report or cached value. These reports alone do not explain what caused a temperature change.</p>
                {report.roomTruncated && <p className="mt-2 text-sm">Only the most recent 2,000 sampled room reports are included.</p>}
                <RoomReports report={report} unit={unit} />
              </details>
              <details>
                <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Data sources and gaps</summary>
                <ul className="divide-y divide-line text-sm">
                  {report.sources.map(source => (
                    <li key={source.key} className="py-3">
                      <strong>
                        {nightSourceLabels[source.key]}
                        {' '}
                        ·
                        {' '}
                        {source.status === 'read' ? 'Read successfully' : source.status === 'empty' ? 'No retained rows' : source.status === 'partial' ? 'Partial evidence' : 'Unavailable'}
                      </strong>
                      <p className="mt-1 max-w-prose text-fg-2">{source.note}</p>
                      <p className="mt-1 text-fg-2">
                        {source.rowsRead}
                        {' '}
                        rows read;
                        {' '}
                        {source.discarded}
                        {' '}
                        invalid rows excluded.
                        {source.truncated ? ' Older rows were omitted at the read limit.' : ''}
                      </p>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 max-w-prose text-sm text-fg-2">House actions are not yet connected to this timeline. A room sensor or accessory report cannot establish who issued a command. No controls run when you open this view.</p>
              </details>
            </>
          )}
        </div>
      </details>
    </section>
  )
}

function RoomReports({ report, unit }: { report: NightReport, unit: TempUnit }) {
  const [visible, setVisible] = useState(12)
  return (
    <div className="mt-3">
      <ul className="divide-y divide-line text-sm">
        {report.room.slice(-visible).reverse().map(sample => (
          <li key={sample.id} className="py-3">
            <p className="font-medium">
              {sample.label}
              :
              {' '}
              {sample.value === null ? 'Unavailable' : sample.metric === 'temperature' ? formatSetpointF(sample.value, unit) : `${sample.value} ${sample.unit}`}
            </p>
            <p className="mt-1 text-fg-2">
              {new Date(sample.observedAt).toLocaleString(undefined, { timeZone: report.timeZone })}
              {' '}
              ·
              {' '}
              {sample.timeBasis.replaceAll('_', ' ')}
              {sample.measuredAt !== null ? ` · measured ${new Date(sample.measuredAt).toLocaleTimeString(undefined, { timeZone: report.timeZone })}` : ' · measurement time not supplied'}
            </p>
          </li>
        ))}
      </ul>
      {!report.room.length && <p className="py-3 text-sm text-fg-2">No room reports were retained for this window.</p>}
      {report.room.length > visible && <Button className="min-h-11 text-sm" onClick={() => setVisible(count => count + 24)}>Show older room reports</Button>}
    </div>
  )
}

function NightTemperatures({ report, unit }: { report: NightReport, unit: TempUnit }) {
  const actual = nightTemperatureSegments(report.thermal, 'reportedF'), target = nightTemperatureSegments(report.thermal, 'targetF')
  const points = [...actual.flat(), ...target.flat()]
  const low = Math.floor(Math.min(65, ...points.map(point => point.value)) / 5) * 5
  const high = Math.ceil(Math.max(75, ...points.map(point => point.value)) / 5) * 5
  const positionX = (at: number) => 112 + 562 * (at - report.start) / (report.end - report.start)
  const positionY = (value: number) => 180 - 138 * (value - low) / (high - low)
  const draw = (segments: typeof actual, color: string, dashed: boolean) => segments.map((segment, index) => segment.length === 1
    ? <circle key={index} cx={positionX(segment[0].at)} cy={positionY(segment[0].value)} r="2" fill="currentColor" className={color} />
    : <polyline key={index} points={segment.map(point => `${positionX(point.at)},${positionY(point.value)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={dashed ? '5 4' : undefined} className={color} />)
  return (
    <figure aria-label="Recorded Pod temperatures" className="min-w-0">
      <figcaption className="text-sm">
        <strong>Pod temperatures</strong>
        <p className="mt-1 text-fg-2">Solid blue: reported water temperature. Dashed: Pod-reported target while powered. Gaps over 90 seconds are not joined.</p>
      </figcaption>
      {!points.length
        ? <p className="py-4 text-sm text-fg-2">No usable temperature samples in this window.</p>
        : (
            <svg viewBox="0 0 700 236" role="img" aria-label={`${report.thermal.length} recorded temperature samples; target and reported water temperature are separate.`} className="mt-3 w-full text-fg-2">
              {[low, (low + high) / 2, high].map(value => (
                <g key={value}>
                  <line x1="112" x2="674" y1={positionY(value)} y2={positionY(value)} stroke="currentColor" opacity="0.15" />
                  <text x="104" y={positionY(value) + 4} textAnchor="end" fill="currentColor" className="text-[0.8125rem] max-[600px]:text-[1.5rem]">{formatSetpointF(value, unit)}</text>
                </g>
              ))}
              {draw(target, 'text-fg-2', true)}
              {draw(actual, 'text-cool', false)}
              {[report.start, (report.start + report.end) / 2, report.end].map((at, index) => <text key={at} x={positionX(at)} y="210" textAnchor={index === 0 ? 'start' : index === 2 ? 'end' : 'middle'} fill="currentColor" className="text-[0.8125rem] max-[600px]:text-[1.5rem]">{new Date(at).toLocaleTimeString(undefined, { timeZone: report.timeZone, hour: 'numeric', minute: '2-digit' })}</text>)}
            </svg>
          )}
      <p className="text-xs text-fg-2">
        {report.thermal.length}
        {' '}
        retained samples ·
        {' '}
        {report.side}
        {' '}
        zone · this is not body temperature or measured sleep.
      </p>
    </figure>
  )
}
