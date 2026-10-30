'use client'

import { useState } from 'react'
import { Droplets, Radio, Thermometer, Wind } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useBedroomClock } from '@/src/hooks/useBedroomClock'
import { bedroomProviderHint, bedroomReadingCurrent, bedroomReportedReading, bedroomValueLabel } from '@/src/bedroom/presentation'
import { BEDROOM_METRICS, type BedroomConfig, type BedroomObservation } from '@/src/bedroom/contract'

const providerNames = { home_assistant: 'Home Assistant', homebridge: 'Homebridge', apple_home: 'Apple Home' }
const statusNames = { fresh: 'Current', cached: 'Saved value · freshness unknown', stale: 'Reading expired', waiting: 'Waiting for a new reading', unavailable: 'Device unavailable', disabled: 'Input disabled' }
const button = 'rounded-ctl border border-line-2 px-4 py-2 text-sm text-fg disabled:opacity-50'

function SourceSettings({ initial, revision, refresh }: { initial: BedroomConfig, revision: number, refresh: () => Promise<unknown> }) {
  const [draft, setDraft] = useState(initial)
  const [expectedRevision, setExpectedRevision] = useState(revision)
  const [message, setMessage] = useState('')
  const mutation = trpc.bedroom.configure.useMutation()
  async function save() {
    try {
      const saved = await mutation.mutateAsync({ expectedRevision, config: draft })
      setExpectedRevision(saved.revision)
      setDraft(saved.config)
      setMessage('Saved. Waiting for new readings from the updated publisher configuration.')
      await refresh()
    }
    catch { setMessage('Save could not be confirmed. Refresh the saved configuration before retrying.') }
  }
  return (
    <details className="rounded-card border border-line bg-surface p-4">
      <summary className="cursor-pointer font-medium">Manage bedroom inputs</summary>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-fg-2">Choose which verified sources may inform room rules. This does not enable Autopilot or change your sleep schedule.</p>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
          Accept bedroom readings
        </label>
        {draft.sources.map(source => (
          <label key={source.id} className="flex items-center justify-between gap-3 border-t border-line py-3 text-sm">
            <span>
              {source.deviceName}
              {' '}
              ·
              {' '}
              {source.label}
            </span>
            <span className="flex items-center gap-2 text-fg-2">
              <input
                aria-label={`Use ${source.deviceName} ${source.label} for room rules`}
                type="checkbox"
                checked={source.useForControl}
                onChange={event => setDraft({ ...draft, sources: draft.sources.map(item => item.id === source.id ? { ...item, useForControl: event.target.checked } : item) })}
              />
              Use for room rules
            </span>
          </label>
        ))}
        {revision !== expectedRevision && (
          <p role="status" className="text-sm text-warm">
            The saved sources changed. Your draft is preserved.
            {' '}
            <button
              className="underline"
              onClick={() => {
                setDraft(initial)
                setExpectedRevision(revision)
                setMessage('')
              }}
            >
              Discard draft and reload
            </button>
          </p>
        )}
        {message && <p role="status" className="text-sm text-fg-2">{message}</p>}
        <button className={button} disabled={mutation.isPending || revision !== expectedRevision} onClick={() => void save()}>
          {mutation.isPending ? 'Saving…' : 'Save bedroom inputs'}
        </button>
      </div>
    </details>
  )
}

/** Data ages in the browser too: a successful old request cannot keep a disconnected room looking live. */
export function BedroomSensors() {
  const query = trpc.bedroom.status.useQuery({}, { refetchInterval: 5000, refetchIntervalInBackground: false, retry: false, staleTime: 0 })
  const now = useBedroomClock()
  const data = query.data
  const connectionFresh = !query.isError && data !== undefined && now >= query.dataUpdatedAt && now - query.dataUpdatedAt < 15000
  const devices = new Map<string, BedroomObservation[]>()
  for (const observation of data?.observations ?? []) {
    devices.set(observation.source.deviceId, [...devices.get(observation.source.deviceId) ?? [], observation])
  }
  return (
    <section aria-label="Bedroom sensors" className="space-y-4">
      <div className="rounded-card border border-line bg-surface p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-fg-2">Room context</p>
            <h2 className="mt-2 text-xl font-medium">{data?.config.roomName ?? 'Bedroom'}</h2>
          </div>
          <Radio size={24} className="text-cool" aria-hidden />
        </div>
        <p className="mt-3 max-w-xl text-sm text-fg-2">Bedside climate and air quality, with every source visible. Conflicting, expired and cached readings are kept out of room-based adjustments.</p>
        {query.isError && (
          <p role="alert" className="mt-4 text-sm text-warm">
            Bedroom data could not be refreshed.
            {' '}
            <button className="underline" onClick={() => void query.refetch()}>Retry</button>
          </p>
        )}
        {!data && !query.isError && <p role="status" className="mt-4 text-sm text-fg-2">Loading bedroom devices…</p>}
        {data && (
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {(['temperature', 'humidity', 'pm25'] as const).map((metric) => {
              const aggregate = data.aggregates.find(item => item.metric === metric)
              const fresh = connectionFresh && aggregate?.status === 'ready' && bedroomReadingCurrent(data.generatedAt, query.dataUpdatedAt, aggregate.expiresAt, now)
              const Icon = metric === 'temperature' ? Thermometer : metric === 'humidity' ? Droplets : Wind
              return (
                <div key={metric} className="rounded-ctl border border-line p-4">
                  <Icon size={19} className="mb-4 text-cool" aria-hidden />
                  <h3 className="text-sm text-fg-2">{BEDROOM_METRICS[metric].label}</h3>
                  <p className="mt-2 text-2xl tabular-nums">{bedroomValueLabel(metric, fresh ? aggregate.value : null, BEDROOM_METRICS[metric].unit)}</p>
                  <p className="mt-2 text-xs text-fg-2">{!connectionFresh ? 'Waiting for a fresh update' : aggregate?.status === 'disagreement' ? 'Sources disagree · adjustment withheld' : fresh ? `${aggregate.sourceIds.length} qualified source${aggregate.sourceIds.length === 1 ? '' : 's'}` : 'No qualified current reading'}</p>
                </div>
              )
            })}
          </div>
        )}
        {data && devices.size === 0 && <p className="mt-5 text-sm text-fg-2">No bedroom sources connected yet. Connect your existing Home Assistant, Homebridge or Apple Home sensors to see them here.</p>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[...devices].map(([deviceId, observations]) => (
          <article key={deviceId} className="rounded-card border border-line bg-surface p-4 sm:p-5">
            <h3 className="font-medium">{observations[0].source.deviceName}</h3>
            <p className="mt-1 text-xs text-fg-2">
              {providerNames[observations[0].source.provider]}
              {' '}
              ·
              {' '}
              {observations[0].source.location === 'room' ? 'Bedroom' : `${observations[0].source.location === 'left' ? 'Left' : 'Right'} bedside`}
            </p>
            {observations.every(item => item.status === 'waiting' && item.observedAt === null) && (
              <p className="mt-3 text-xs text-fg-2">{bedroomProviderHint[observations[0].source.provider]}</p>
            )}
            {observations.map((item) => {
              const fresh = connectionFresh && item.status === 'fresh' && data !== undefined && bedroomReadingCurrent(data.generatedAt, query.dataUpdatedAt, item.expiresAt, now)
              const observedAt = item.measuredAt ?? item.observedAt
              const previous = !fresh && data ? bedroomReportedReading(item, data.generatedAt) : null
              return (
                <div key={item.source.id} className="mt-4 border-t border-line pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-fg-2">{item.source.label}</span>
                    <span className="text-lg tabular-nums">{bedroomValueLabel(item.source.metric, fresh ? item.value : null, item.unit)}</span>
                  </div>
                  {previous && (
                    <p className="mt-2 text-sm text-fg-2">
                      Last reported:
                      {' '}
                      {bedroomValueLabel(item.source.metric, previous.value, item.unit)}
                      {' · '}
                      {item.timeBasis === 'cached' ? 'cached, freshness unknown' : 'not current'}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-fg-2">
                    {!connectionFresh ? 'Connection needs refresh' : item.status === 'fresh' && !fresh ? 'Reading expired' : statusNames[item.status]}
                    {' '}
                    ·
                    {' '}
                    {item.controlEligible && fresh ? 'Included in room context' : 'Display only'}
                  </p>
                  {observedAt !== null && (
                    <p className="mt-1 text-xs text-fg-2">
                      {item.measuredAt !== null ? 'Measured' : 'Reported'}
                      {' '}
                      {new Date(observedAt).toLocaleString()}
                    </p>
                  )}
                </div>
              )
            })}
          </article>
        ))}
      </div>
      {data && data.config.sources.length > 0 && <SourceSettings initial={data.config} revision={data.revision} refresh={query.refetch} />}
    </section>
  )
}
