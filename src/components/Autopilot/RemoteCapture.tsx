'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { describe, detectionSchema, type Detection, type InputId, type RemoteConfig } from '@/src/remote/model'
import { RemoteRecording } from '@/src/remote/capture'
import { Badge, Button, Card } from './primitives'
import { Icon } from './icons'
/** Subscribe only while armed and display the latest twelve real detections against the current mapping. */
export function RemoteCapture({ config, automations, build }: {
  build?: { branch: string, commitHash: string, buildDate: string }
  config?: RemoteConfig
  automations: {
    id: number
    name: string
  }[]
}) {
  const [armed, setArmed] = useState(false)

  const [state, setState] = useState('Stopped')
  const [connection, setConnection] = useState(0)

  const recording = useRef(new RemoteRecording())
  const [recordCount, setRecordCount] = useState(0)
  const [omitted, setOmitted] = useState(0)
  const [notes, setNotes] = useState('')
  const record = useCallback((row: unknown) => {
    recording.current.append(row)
    setRecordCount(recording.current.count)
    setOmitted(recording.current.dropped)
  }, [])

  const [log, setLog] = useState<Detection[]>([])

  useEffect(() => {
    if (!armed)
      return

    record({ type: 'connection_start', at: Date.now() })
    const source = new EventSource('/api/remote/detections?raw=1')

    let active = true
    source.onopen = () => {
      if (active) {
        record({ type: 'connection_open', at: Date.now() })
        setState('Listening — press a button')
      }
    }
    source.onmessage = (event) => {
      if (!active) return
      try {
        const row = JSON.parse(event.data)

        if (row?.type === 'raw' || row?.type === 'raw_omitted') {
          record({ ...row, observedAt: Date.now() })
          return
        }

        if (row?.type === 'status') {
          setState(row.running ? 'listening — press a button' : 'Device listener unavailable')

          return
        }

        const parsed = detectionSchema.safeParse(row)
        if (!parsed.success) {
          setState('Invalid detection received')
          return
        }
        record({ type: 'detection', observedAt: Date.now(), detection: parsed.data })
        setState('Listening — press another button')
        setLog(previous => [parsed.data, ...previous.filter(r => r.id !== parsed.data.id)].slice(0, 12))
      }
      catch {
        setState('Invalid detection received')
      }
    }

    source.onerror = () => {
      if (active) {
        record({ type: 'connection_gap', at: Date.now() })
        setState('Disconnected — reconnecting…')
      }
    }

    return () => {
      active = false
      source.close()
      record({ type: 'connection_stop', at: Date.now() })
    }
  }, [armed, connection, record])

  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Icon.Remote size={14} className="text-zinc-500" />
          <span className="text-[13px] font-medium text-zinc-200">Remote capture</span>
          <span className="text-[11px] text-zinc-500">button detections and firmware evidence</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {armed && (
            <span role="status" className="text-[11px]" style={{ color: 'var(--accent)' }}>
              <span aria-hidden="true" className="mr-1 inline-block animate-pulse">●</span>
              {state}
            </span>
          )}
          <Button
            size="sm"
            variant={armed ? 'default' : 'outline'}
            onClick={() => {
              setState(armed ? 'Stopped' : 'Connecting…')
              setArmed(!armed)
            }}
          >
            {armed ? 'Stop capture' : 'Arm capture'}
          </Button>
          {armed && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setState('Connecting…')
                setConnection(previous => previous + 1)
              }}
            >
              Reconnect
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!log.length && !recordCount}
            onClick={() => {
              setLog([])
              recording.current = new RemoteRecording()
              record({ type: 'cleared', at: Date.now(), listening: armed })
            }}
          >
            Clear
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!recordCount}
            onClick={() => {
              const data = recording.current.export({ exportedAt: new Date().toISOString(), notes, build: build ?? null, userAgent: navigator.userAgent, source: 'decoded buttonEvent and controller logs; not binary RAW', listening: armed })
              const url = URL.createObjectURL(new Blob([data], { type: 'application/x-ndjson' }))
              const link = document.createElement('a')
              link.href = url
              link.download = `remote-capture-${new Date().toISOString().replaceAll(':', '-')}.ndjson`
              link.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            }}
          >
            Download capture
          </Button>
        </div>
      </div>
      <div className="space-y-2 border-b border-zinc-800 px-4 py-3">
        <label className="block text-[12px] text-zinc-400">
          Cover / firmware and test notes
          <input value={notes} maxLength={2000} onChange={event => setNotes(event.target.value)} placeholder="Cover model, firmware version if known, buttons pressed in order…" className="mt-1 block w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-200" />
        </label>
        <p className="text-[11px] text-zinc-500">
          {recordCount}
          {' '}
          records retained for download · download before leaving this view.
          {omitted > 0 && ` Capture limit reached: ${omitted} records omitted. Download and clear to begin another capture.`}
        </p>
      </div>
      <div className="max-h-[210px] overflow-auto">
        <table className="w-full text-left text-[12px]">
          <thead className="sticky top-0 bg-zinc-950 text-[10px] uppercase tracking-[0.1em] text-zinc-500"><tr>{['Time', 'Remote', 'Mask', 'Gesture', 'Input', 'Resolved to', 'Δt'].map(h => <th className="px-3 py-2 font-medium" key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {log.map(r => (
              <tr key={r.id} className="border-t border-zinc-800/50" style={{ animation: 'apFade .25s ease' }}>
                <td className="mono whitespace-nowrap px-3 py-2 text-zinc-400">{new Date(r.t).toLocaleTimeString()}</td>
                <td className="px-3 py-2">{r.side === 'left' ? 'L' : 'R'}</td>
                <td className="mono px-3 py-2">
                  0b
                  {r.mask.toString(2).padStart(3, '0')}
                </td>
                <td className="px-3 py-2"><Badge tone={r.gesture === 'combo' ? 'accent' : 'zinc'}>{r.gesture}</Badge></td>
                <td title={r.detail} className="mono whitespace-nowrap px-3 py-2">{r.inputId}</td>
                <td className="px-3 py-2" style={{ color: 'var(--accent)' }}>
                  {r.gesture === 'unsupported' ? r.detail : config ? describe(config[r.side][r.inputId as InputId], automations) : 'Loading mapping…'}
                  <div className="text-[10px] text-zinc-500">{r.outcome}</div>
                </td>
                <td title="Firmware timestamps have second precision; delivery latency is not measurable" className="px-3 py-2 text-zinc-500">—</td>
              </tr>
            ))}
            {!log.length && <tr><td colSpan={7} className="px-4 py-5 text-[12px] text-zinc-500">{armed ? 'Waiting for physical button detections…' : 'Arm capture to inspect real button inputs.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="border-t border-zinc-800/50 px-4 py-2 text-[11px] text-zinc-500">Capture observes inputs; saved actions and native firmware remain active. Resolved to uses the current mapping. Δt is unavailable from second-resolution timestamps.</p>
    </Card>
  )
}
