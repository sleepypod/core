'use client'

import { useEffect, useState } from 'react'
import { Droplets, Thermometer, Wind, Sun, Activity } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { ROOM_METRICS, roomConfigSchema, type RoomConfig, type RoomMetric } from '@/src/home-context/contract'

const polling = { refetchInterval: 5000, refetchIntervalInBackground: false, retry: false, staleTime: 0 } as const
const field = 'mt-1 w-full rounded-ctl border border-line-2 bg-surface px-3 py-2 text-fg'
const button = 'rounded-ctl border border-line-2 px-4 py-2 text-sm text-fg disabled:opacity-50'
const names = { fresh: 'Fresh measurement', disabled: 'Input disabled', disconnected: 'Broker disconnected', waiting: 'Waiting for a new measurement', unavailable: 'Sensor unavailable', stale: 'Measurement expired', clock_invalid: 'Check source clocks' }
const icons = { temperature: Thermometer, humidity: Droplets, co2: Wind, pm25: Activity, light: Sun }

function SensorMapping({ metric, config, setConfig }: { metric: RoomMetric, config: RoomConfig, setConfig: (config: RoomConfig) => void }) {
  const mapping = config.mappings.find(item => item.metric === metric)
  const definition = ROOM_METRICS[metric]
  function update(change: Partial<NonNullable<typeof mapping>>) {
    if (mapping) setConfig({ ...config, mappings: config.mappings.map(item => item.metric === metric ? { ...item, ...change } : item) })
  }
  return (
    <fieldset className="rounded-ctl border border-line p-3">
      <legend className="px-1 text-sm font-medium">{definition.label}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={!!mapping}
          onChange={event => setConfig({ ...config, mappings: event.target.checked
            ? [...config.mappings, { metric, entityId: '', unit: definition.units[0], timestampAttribute: '', timestampFormat: 'iso8601', maxAgeSeconds: 120 }]
            : config.mappings.filter(item => item.metric !== metric) })}
        />
        Map
        {' '}
        {definition.label.toLowerCase()}
      </label>
      {mapping && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-fg-2">
            Entity ID
            <input className={field} value={mapping.entityId} placeholder="sensor.bedroom_temperature" onChange={event => update({ entityId: event.target.value })} />
          </label>
          <label className="text-xs text-fg-2">
            Source unit
            <select className={field} value={mapping.unit} onChange={event => update({ unit: event.target.value as typeof mapping.unit })}>
              {definition.units.map(unit => <option key={unit}>{unit}</option>)}
            </select>
          </label>
          <label className="text-xs text-fg-2">
            Measurement timestamp attribute
            <input className={field} value={mapping.timestampAttribute} placeholder="Source attribute, e.g. last_seen" onChange={event => update({ timestampAttribute: event.target.value })} />
          </label>
          <label className="text-xs text-fg-2">
            Timestamp format
            <select className={field} value={mapping.timestampFormat} onChange={event => update({ timestampFormat: event.target.value as typeof mapping.timestampFormat })}>
              <option value="iso8601">ISO 8601 with timezone</option>
              <option value="unix_seconds">Unix seconds</option>
              <option value="unix_milliseconds">Unix milliseconds</option>
            </select>
          </label>
          <label className="text-xs text-fg-2">
            Maximum age (seconds)
            <input type="number" min={30} max={900} step={1} className={field} value={mapping.maxAgeSeconds} onChange={event => update({ maxAgeSeconds: Number(event.target.value) })} />
          </label>
        </div>
      )}
    </fieldset>
  )
}

function RoomEditor({ initial, revision, refresh }: { initial: RoomConfig, revision: number, refresh: () => Promise<unknown> }) {
  const [config, setConfig] = useState(initial)
  const [baseRevision, setBaseRevision] = useState(revision)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const mutation = trpc.roomContext.configure.useMutation()
  async function save() {
    setError('')
    setMessage('')
    const parsed = roomConfigSchema.safeParse(config)
    if (!parsed.success) {
      setError(parsed.error.issues.map(item => item.message).join('. '))
      return
    }
    try {
      const saved = await mutation.mutateAsync({ expectedRevision: baseRevision, config: parsed.data })
      setBaseRevision(saved.revision)
      setConfig(saved.config)
      setMessage('Saved. Replace the Home Assistant publisher with this revision before expecting new measurements.')
      await refresh()
    }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not confirm the save. Reload to check the stored configuration.') }
  }
  return (
    <div className="space-y-4">
      {revision !== baseRevision && (
        <p role="status" className="text-sm text-warm">
          The stored mapping changed. Your draft is preserved.
          {' '}
          <button
            className="underline"
            onClick={() => {
              setConfig(initial)
              setBaseRevision(revision)
              setError('')
              setMessage('Loaded the stored mapping.')
            }}
          >
            Discard draft and reload
          </button>
        </p>
      )}
      <p className="text-sm text-fg-2">Select only entities with a verified measurement timestamp. An integration refresh time or a timestamp added with “now” cannot prove a new measurement. Check the entity’s attributes in Home Assistant → Developer tools → States.</p>
      <label className="block max-w-sm text-sm">
        Room name
        <input className={field} value={config.roomName} maxLength={60} onChange={event => setConfig({ ...config, roomName: event.target.value })} />
      </label>
      {(Object.keys(ROOM_METRICS) as RoomMetric[]).map(metric => <SensorMapping key={metric} metric={metric} config={config} setConfig={setConfig} />)}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={config.enabled} onChange={event => setConfig({ ...config, enabled: event.target.checked })} />
        Accept mapped room measurements
      </label>
      <p className="text-xs text-fg-2">This enables sensor input only. Autopilot rules and house scenes remain under their own controls. Each save invalidates previous publishers and waits for a new measurement.</p>
      {error && <p role="alert" className="text-sm text-warm">{error}</p>}
      {message && <p role="status" className="text-sm text-fg-2">{message}</p>}
      <button className={button} disabled={mutation.isPending} onClick={() => void save()}>{mutation.isPending ? 'Saving…' : 'Save room sensors'}</button>
    </div>
  )
}

/** Fresh values are hidden on query failure and age locally between foreground polls. */
export function RoomContext() {
  const status = trpc.roomContext.status.useQuery({}, polling)
  const history = trpc.roomContext.history.useQuery({}, polling)
  const publisher = trpc.roomContext.publisher.useQuery({}, { enabled: false, retry: false })
  const [time, setTime] = useState(Date.now)
  const [copied, setCopied] = useState<number | null>(null)
  const [copyError, setCopyError] = useState(false)
  useEffect(() => {
    const timer = setInterval(() => setTime(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const data = status.isError ? undefined : status.data
  const saved = status.data
  return (
    <section className="space-y-5">
      <div className="rounded-card border border-line bg-surface p-4 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-medium">{data?.config.roomName ?? 'Your room'}</h2>
          <span className="text-xs text-fg-2">{data?.connected ? 'MQTT subscription connected' : 'MQTT not connected'}</span>
        </div>
        {status.isError
          ? (
              <p role="alert" className="mt-3 text-sm text-warm">
                Room data could not be refreshed. Readings are withheld.
                <button className="underline" onClick={() => void status.refetch()}>Retry</button>
              </p>
            )
          : !data
              ? <p className="mt-3 text-sm text-fg-2">Loading room measurements…</p>
              : !data.observations.length
                  ? <p className="mt-3 text-sm text-fg-2">No room sensors mapped. Add your existing Home Assistant entities below; Apple Home pairings stay in place.</p>
                  : (
                      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {data.observations.map((item) => {
                          const Icon = icons[item.metric]
                          const fresh = item.status === 'fresh' && item.expiresAt !== null && time < item.expiresAt && time >= data.generatedAt && time - status.dataUpdatedAt < 15000
                          return (
                            <div key={item.metric} className="rounded-ctl border border-line p-4">
                              <Icon className="mb-3 text-cool" size={20} aria-hidden />
                              <h3 className="text-sm text-fg-2">{ROOM_METRICS[item.metric].label}</h3>
                              <p className="mt-2 text-2xl tabular-nums">
                                {fresh ? item.value?.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—'}
                                <span className="ml-1 text-sm text-fg-2">{item.unit}</span>
                              </p>
                              <p className="mt-2 text-xs text-fg-2">{item.status === 'fresh' && !fresh ? 'Waiting for a fresh update' : names[item.status]}</p>
                              <p className="mt-2 break-all text-xs text-fg-2">{item.entityId}</p>
                              {item.measuredAt && (
                                <p className="mt-1 text-xs text-fg-2">
                                  {`Measured ${new Date(item.measuredAt).toLocaleTimeString()}`}
                                </p>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
        <p className="mt-4 text-xs text-fg-2">Home Assistant measurements · Separate from the Pod’s ambient sensors · Missing data withdraws dependent automation conditions.</p>
      </div>
      {saved && (
        <details className="rounded-card border border-line bg-surface p-4 sm:p-6">
          <summary className="cursor-pointer font-medium">Sensor mapping and setup</summary>
          <div className="mt-5"><RoomEditor initial={saved.config} revision={saved.revision} refresh={() => status.refetch()} /></div>
          <div className="mt-6 border-t border-line pt-4">
            <h3 className="text-sm font-medium">{`Home Assistant publisher · revision ${saved.revision}`}</h3>
            <p className="my-3 text-sm text-fg-2">After saving, generate one automation per sensor. In Home Assistant, create a new empty automation, choose Edit in YAML, and paste one document. JSON is valid YAML. Replace previous publishers after any mapping change.</p>
            <button className={button} disabled={!data?.connected || !saved.config.mappings.length || publisher.isFetching} onClick={() => void publisher.refetch()}>Generate sensor publishers</button>
            {publisher.isError && <p role="alert" className="mt-3 text-sm text-warm">Publisher unavailable. Check MQTT and reload the configuration.</p>}
            {publisher.data?.revision === saved.revision && publisher.data.automations.map((document, index) => (
              <div key={index} className="mt-4">
                <button
                  className={button}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(document)
                      setCopied(index)
                      setCopyError(false)
                    }
                    catch { setCopyError(true) }
                  }}
                >
                  {copied === index ? 'Copied' : `Copy publisher ${index + 1}`}
                </button>
                <pre className="mt-2 max-h-64 overflow-auto rounded-ctl bg-bg p-3 text-xs">{document}</pre>
              </div>
            ))}
            {copyError && <p role="alert" className="text-sm text-warm">Clipboard unavailable. Select and copy the document above.</p>}
          </div>
        </details>
      )}
      <details className="rounded-card border border-line bg-surface p-4 sm:p-6">
        <summary className="cursor-pointer font-medium">Recent room observations</summary>
        <p className="mt-3 text-xs text-fg-2">Source measurements retained locally for up to 30 days or 25,000 reports. Historical values never become live inputs after restart.</p>
        {history.isError
          ? <p role="alert" className="mt-3 text-sm text-warm">Observation history unavailable.</p>
          : !history.data?.items.length
              ? <p className="mt-3 text-sm text-fg-2">No accepted room reports yet.</p>
              : (
                  <ul className="mt-3 divide-y divide-line">
                    {history.data.items.slice(0, 20).map(item => (
                      <li key={item.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                        <span>
                          {ROOM_METRICS[item.metric].label}
                          {' '}
                          ·
                          {' '}
                          {item.available ? `${item.value?.toLocaleString()} ${item.unit}` : 'Unavailable'}
                        </span>
                        <time className="text-fg-2">{new Date(item.measuredAt ?? item.reportedAt).toLocaleString()}</time>
                      </li>
                    ))}
                  </ul>
                )}
      </details>
    </section>
  )
}
