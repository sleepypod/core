'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Archive, ArrowLeft, ArrowRight, X } from 'lucide-react'
import { Button, Card, CardHeader, InlineError, PageHeader, SegmentedControl, Skeleton, TextField } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import type { HistoryKind, HistoryRecord, HistorySnapshot } from '@/src/history/contract'
import { historyRange, shiftHistoryDate, sourceDate } from './historyDates'

const KINDS = [{ value: 'presence', label: 'Bed presence' }, { value: 'vitals', label: 'Vitals' }, { value: 'movement', label: 'Movement' }] as const
const numberLabel = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString(undefined, { maximumFractionDigits: 1 })
const durationLabel = (seconds: number | null) => seconds === null ? 'Unavailable' : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
const timestampLabel = (seconds: number, timeZone: string) => new Intl.DateTimeFormat('en', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(seconds * 1000)

/** Archived observations stay separate from current sleep stages and qualified Preview evidence. */
export function ImportedHistory({ sectionSwitch }: { sectionSwitch?: ReactNode }) {
  const status = trpc.importedHistory.status.useQuery({})
  // Historical sides are independent of today's away mode and occupant names.
  const [side, setSide] = useState<'left' | 'right'>('left')
  const [kind, setKind] = useState<HistoryKind>('presence')
  const snapshot = status.data?.status === 'ready' && !status.error ? status.data.snapshot : null
  return (
    <>
      <PageHeader
        title="Imported history"
        middle={(
          <SegmentedControl
            ariaLabel="Historical side"
            value={side}
            options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]}
            onChange={setSide}
          />
        )}
      />
      <div className="min-[900px]:hidden">{sectionSwitch}</div>
      <Card>
        <CardHeader icon={Archive} title="Earlier records" subtitle="Your original Free Sleep observations, kept separate from current Pod and Apple Watch measurements." />
        <p className="text-sm text-fg-2">Bed presence describes time in bed. Vitals are original five-minute averages with unverified signal quality. These records do not count as Preview nights or guide automatic adjustments.</p>
        {status.isLoading && <Skeleton className="h-16" />}
        {status.error && <InlineError>Imported history could not be loaded.</InlineError>}
        {!status.isLoading && !status.error && !snapshot && <p role="status" className="text-sm text-fg-2">{status.data?.message ?? 'No earlier records have been imported.'}</p>}
        {(status.error || status.data?.status === 'unavailable') && <Button onClick={() => { void status.refetch() }}>Retry history</Button>}
        {snapshot && (
          <p className="text-xs text-fg-2">
            Imported
            {' '}
            {timestampLabel(snapshot.importedAt / 1000, snapshot.timeZone)}
            {' '}
            · Dates and times use
            {' '}
            {snapshot.timeZone}
            .
            {snapshot.unassignedRecords > 0 && ` Records without a recognized side remain in the archive (${snapshot.unassignedRecords}).`}
          </p>
        )}
      </Card>
      {snapshot && (
        <>
          <SegmentedControl full ariaLabel="History measurement" value={kind} options={KINDS} onChange={setKind} />
          <HistoryRange
            key={`${snapshot.snapshotId}:${side}:${kind}`}
            snapshot={snapshot}
            side={side}
            kind={kind}
            reload={() => { void status.refetch() }}
          />
        </>
      )}
    </>
  )
}

function HistoryRange({ snapshot, side, kind, reload }: { snapshot: HistorySnapshot, side: 'left' | 'right', kind: HistoryKind, reload: () => void }) {
  const bounds = snapshot.sides[side][kind]
  const latest = sourceDate(bounds.lastAt ?? snapshot.importedAt / 1000, snapshot.timeZone)
  const [from, setFrom] = useState(() => shiftHistoryDate(latest, -29))
  const [through, setThrough] = useState(latest)
  const range = useMemo(() => historyRange(from, through, snapshot.timeZone), [from, through, snapshot.timeZone])
  return (
    <>
      <Card>
        <CardHeader
          title={`${bounds.readableRecords.toLocaleString()} available ${bounds.readableRecords === 1 ? 'record' : 'records'}`}
          subtitle={bounds.firstAt === null || bounds.lastAt === null
            ? 'This snapshot has no readable observations for this measurement and side.'
            : `${timestampLabel(bounds.firstAt, snapshot.timeZone)} – ${timestampLabel(bounds.lastAt, snapshot.timeZone)}`}
        />
        {bounds.records > bounds.readableRecords && (
          <p className="text-sm text-fg-2">
            Records with invalid identities or time windows remain unchanged in the archive (
            {bounds.records - bounds.readableRecords}
            ).
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="From" type="date" value={from} onChange={setFrom} />
          <TextField label="Through" type="date" value={through} onChange={setThrough} />
        </div>
        {!range && <div role="alert"><InlineError>Choose a valid date range of at most 90 days.</InlineError></div>}
      </Card>
      {range && <HistoryResults key={`${range.startTime}:${range.endTime}`} snapshot={snapshot} side={side} kind={kind} range={range} reload={reload} />}
    </>
  )
}

function HistoryResults({ snapshot, side, kind, range, reload }: {
  snapshot: HistorySnapshot
  side: 'left' | 'right'
  kind: HistoryKind
  range: { startTime: string, endTime: string }
  reload: () => void
}) {
  const [cursors, setCursors] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const query = trpc.importedHistory.records.useQuery({ snapshotId: snapshot.snapshotId, side, kind, ...range, cursor: cursors.at(-1), limit: 50 })
  const page = query.error ? null : query.data
  const recordTime = (record: HistoryRecord) => timestampLabel(record.kind === 'presence' ? record.enteredBedAt : record.timestamp, snapshot.timeZone)
  return (
    <>
      <Card>
        {query.isLoading && <Skeleton className="h-32" />}
        {query.error && (
          <>
            <InlineError>{query.error.message}</InlineError>
            <Button onClick={() => {
              reload()
              void query.refetch()
            }}
            >
              Reload imported snapshot
            </Button>
          </>
        )}
        {page && !page.records.length && <p role="status" className="text-sm text-fg-2">No records in this date range. Missing observations are not zero.</p>}
        {page && page.records.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <caption className="sr-only">
                Imported
                {' '}
                {kind}
                {' '}
                records, newest first
              </caption>
              <thead className="text-xs text-fg-2">
                <tr>
                  <th className="pb-3 pr-4 font-medium">Recorded at</th>
                  {kind === 'presence'
                    ? (
                        <>
                          <th className="pb-3 pr-4 font-medium">Bed window</th>
                          <th className="pb-3 font-medium">Details</th>
                        </>
                      )
                    : kind === 'vitals'
                      ? (
                          <>
                            <th className="pb-3 pr-4 font-medium">Heart · bpm</th>
                            <th className="pb-3 pr-4 font-medium">HRV · ms</th>
                            <th className="pb-3 font-medium">Breaths / min</th>
                          </>
                        )
                      : <th className="pb-3 font-medium">Recorded movement</th>}
                </tr>
              </thead>
              <tbody>
                {page.records.map(record => (
                  <tr key={record.id} className="border-t border-line align-top">
                    <td className="py-3 pr-4">{recordTime(record)}</td>
                    {record.kind === 'presence'
                      ? (
                          <>
                            <td className="py-3 pr-4 font-mono">{durationLabel(record.leftBedAt - record.enteredBedAt)}</td>
                            <td className="py-2"><Button size="sm" aria-label={`View imported bed presence ${recordTime(record)}`} onClick={() => setSelectedId(record.id)}>View</Button></td>
                          </>
                        )
                      : record.kind === 'vitals'
                        ? (
                            <>
                              <td className="py-3 pr-4 font-mono">{numberLabel(record.heartRateBpm)}</td>
                              <td className="py-3 pr-4 font-mono">{numberLabel(record.hrvEstimateMs)}</td>
                              <td className="py-3 font-mono">{numberLabel(record.breathingRatePerMinute)}</td>
                            </>
                          )
                        : <td className="py-3 font-mono">{numberLabel(record.totalMovement)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            icon={ArrowLeft}
            disabled={!cursors.length || query.isFetching}
            onClick={() => {
              setSelectedId(null)
              setCursors(previous => previous.slice(0, -1))
            }}
          >
            Newer records
          </Button>
          <Button
            icon={ArrowRight}
            disabled={!page?.nextCursor || query.isFetching}
            onClick={() => {
              const nextCursor = page?.nextCursor
              if (nextCursor) {
                setSelectedId(null)
                setCursors(previous => [...previous, nextCursor])
              }
            }}
          >
            Older records
          </Button>
        </div>
      </Card>
      {page && selectedId !== null && <HistoryPresence key={selectedId} snapshot={snapshot} side={side} id={selectedId} reload={reload} close={() => setSelectedId(null)} />}
    </>
  )
}

function HistoryPresence({ snapshot, side, id, close, reload }: { snapshot: HistorySnapshot, side: 'left' | 'right', id: number, close: () => void, reload: () => void }) {
  const query = trpc.importedHistory.presence.useQuery({ snapshotId: snapshot.snapshotId, side, id })
  const detail = query.error ? null : query.data
  return (
    <Card aria-label="Imported bed presence detail">
      <CardHeader title="Recorded bed presence" right={<Button size="sm" icon={X} aria-label="Close imported presence detail" onClick={close}>Close</Button>} />
      {query.isLoading && <Skeleton className="h-24" />}
      {query.error && (
        <>
          <InlineError>{query.error.message}</InlineError>
          <Button onClick={() => {
            reload()
            void query.refetch()
          }}
          >
            Reload imported snapshot
          </Button>
        </>
      )}
      {detail && (
        <>
          <p className="text-sm text-fg-2">
            {timestampLabel(detail.record.enteredBedAt, snapshot.timeZone)}
            {' '}
            –
            {' '}
            {timestampLabel(detail.record.leftBedAt, snapshot.timeZone)}
          </p>
          <p className="text-sm">
            Recorded occupied time:
            {' '}
            <span className="font-mono">{durationLabel(detail.present.coveredSeconds)}</span>
          </p>
          {detail.present.intervals && (
            <div role="img" aria-label="Recorded presence timeline" className="relative h-6 overflow-hidden rounded-md bg-active">
              {detail.present.intervals.map(([start, end]) => (
                <span
                  key={start}
                  className="absolute inset-y-0 rounded-sm bg-fg-2"
                  style={{
                    left: `${100 * (start - detail.record.enteredBedAt) / (detail.record.leftBedAt - detail.record.enteredBedAt)}%`,
                    width: `${100 * (end - start) / (detail.record.leftBedAt - detail.record.enteredBedAt)}%`,
                  }}
                />
              ))}
            </div>
          )}
          {detail.present.status !== 'available' && <p className="text-sm text-fg-2">The original presence intervals cannot establish occupied time for this record.</p>}
          <p className="text-xs text-fg-2">This is bed-presence history. No sleep stages or signal-quality scores have been inferred.</p>
        </>
      )}
    </Card>
  )
}
