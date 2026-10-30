'use client'

import Link from 'next/link'
import { trpc } from '@/src/utils/trpc'
import { useBedroomClock } from '@/src/hooks/useBedroomClock'
import { bedroomReadingCurrent, bedroomReportedReading, bedroomValueLabel } from '@/src/bedroom/presentation'

/** Shared context for the temperature and routine screens; it never rewrites a saved routine. */
export function BedroomSummary() {
  const query = trpc.bedroom.status.useQuery({}, { refetchInterval: 5000, refetchIntervalInBackground: false, retry: false })
  const now = useBedroomClock()
  const data = query.data
  if (!data?.config.sources.length) return null
  const current = (expiresAt: number | null) => bedroomReadingCurrent(data.generatedAt, query.dataUpdatedAt, expiresAt, now, query.isError)
  const temperature = data.aggregates.find(item => item.metric === 'temperature')
  const humidity = data.aggregates.find(item => item.metric === 'humidity')
  const deviceReadings = data.observations.flatMap((item) => {
    if (item.source.metric !== 'temperature' && item.source.metric !== 'humidity') return []
    const fresh = item.status === 'fresh' && current(item.expiresAt)
    const previous = bedroomReportedReading(item, data.generatedAt)
    if (!fresh && !previous) return []
    return [{ item, fresh, previous }]
  })
  return (
    <aside aria-label="Bedroom context for your routine" className="mb-4 rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="font-medium">{data.config.roomName}</span>
        <span className="text-fg-2">
          {temperature?.status === 'ready' && temperature.value !== null && current(temperature.expiresAt) ? `${temperature.value.toFixed(1)}°F` : 'Temperature unavailable'}
          {' · '}
          {humidity?.status === 'ready' && humidity.value !== null && current(humidity.expiresAt) ? `${Math.round(humidity.value)}% humidity` : 'Humidity unavailable'}
        </span>
        <Link href="/home" className="text-cool underline">Devices and readings</Link>
      </div>
      {deviceReadings.length > 0 && (
        <ul aria-label="Individual room readings" className="mt-3 space-y-1 text-xs text-fg-2">
          {deviceReadings.map(({ item, fresh, previous }) => (
            <li key={item.source.id}>
              {item.source.deviceName}
              {' · '}
              {item.source.label}
              {': '}
              {fresh ? 'Current ' : 'Last reported '}
              {bedroomValueLabel(item.source.metric, fresh ? item.value : previous?.value ?? null, item.unit)}
              {' · '}
              {fresh ? item.controlEligible ? 'Included in room context' : 'Display only' : item.timeBasis === 'cached' ? 'cached, freshness unknown' : 'not current'}
              {!fresh && previous && ` · ${new Date(previous.timestamp).toLocaleString()}`}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-fg-2">
        {query.isError
          ? 'Room connection unavailable. Room-dependent adjustments are withheld.'
          : data.guidance.state === 'ready' && !current(data.guidance.expiresAt) ? 'Waiting for fresh bedroom readings.' : data.guidance.reason}
        {' '}
        Room-informed comfort must be selected in Autopilot. Saved routines and wake alarms keep priority.
      </p>
    </aside>
  )
}
