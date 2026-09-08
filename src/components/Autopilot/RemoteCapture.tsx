'use client'
import { useEffect, useState } from 'react'
import { describe, detectionSchema, type Detection, type InputId, type RemoteConfig } from '@/src/remote/model'
import { Badge, Button, Card } from './primitives'
import { Icon } from './icons'
/** Subscribe only while armed and display the latest twelve real detections against the current mapping. */
export function RemoteCapture({ config, automations }: {
  config?: RemoteConfig
  automations: {
    id: number
    name: string
  }[]
}) {
  const [armed, setArmed] = useState(false)

  const [state, setState] = useState('Stopped')
  const [connection, setConnection] = useState(0)

  const [log, setLog] = useState<Detection[]>([])

  useEffect(() => {
    if (!armed)
      return

    const source = new EventSource('/api/remote/detections')

    let active = true
    source.onopen = () => {
      if (active) setState('Listening — press a button')
    }
    source.onmessage = (event) => {
      if (!active) return
      try {
        const row = JSON.parse(event.data)

        if (row?.type === 'status') {
          setState(row.running ? 'listening — press a button' : 'Device listener unavailable')

          return
        }

        const parsed = detectionSchema.safeParse(row)
        if (!parsed.success) {
          setState('Invalid detection received')
          return
        }
        setState('Listening — press another button')
        setLog(previous => [parsed.data, ...previous.filter(r => r.id !== parsed.data.id)].slice(0, 12))
      }
      catch {
        setState('Invalid detection received')
      }
    }

    source.onerror = () => {
      if (active) setState('Disconnected — reconnecting…')
    }

    return () => {
      active = false
      source.close()
    }
  }, [armed, connection])

  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Icon.Remote size={14} className="text-zinc-500" />
          <span className="text-[13px] font-medium text-zinc-200">Remote capture</span>
          <span className="text-[11px] text-zinc-500">raw button detections as they arrive</span>
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
          <Button size="sm" variant="ghost" disabled={!log.length} onClick={() => setLog([])}>Clear</Button>
        </div>
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
