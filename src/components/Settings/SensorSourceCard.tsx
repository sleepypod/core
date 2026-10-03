'use client'

import { Waves } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Card, CardHeader, InlineError, SettingRow, Skeleton, StatusDot } from '@/src/components/ds'
import { fmtAgo } from '@/src/lib/dataPath'
import { sensorSourceVerdict, TRANSPORT_LABELS } from './sensorSourceLogic'

const POLL_MS = 10_000

/**
 * Settings → Device → "Sensor data source". Read-only.
 *
 * A fleet of sleepypods spans three firmware generations, and which one a pod
 * runs decides whether the core reads `.RAW` files or a local NATS stream.
 * The pick is automatic and happens once per process, so there is nothing to
 * toggle here — the card exists so the first support question ("which
 * pipeline is this pod on, and is data flowing?") is answerable from the app
 * instead of `sp-status` over SSH.
 */
export function SensorSourceCard() {
  const q = trpc.system.getSensorSource.useQuery({}, { refetchInterval: POLL_MS })

  if (q.isLoading) return <Skeleton className="h-[164px]" />
  if (q.error) {
    return (
      <Card>
        <CardHeader title="Sensor data source" icon={Waves} />
        <InlineError>{q.error.message}</InlineError>
      </Card>
    )
  }
  if (!q.data) return null

  const { firmware, stream } = q.data
  const verdict = sensorSourceVerdict({
    source: stream.source,
    expectedTransport: firmware.expectedTransport,
    override: stream.override,
    legacyNatsDisabled: stream.legacyNatsDisabled,
    lastFrameAgeMs: stream.lastFrameAgeMs,
    uptimeSeconds: stream.uptimeSeconds,
  })

  return (
    <Card tone={verdict.tone === 'danger' ? 'danger' : verdict.tone === 'warn' ? 'warn' : undefined}>
      <CardHeader
        title="Sensor data source"
        subtitle={verdict.summary}
        icon={Waves}
        right={<StatusDot tone={verdict.tone} label={verdict.status} mono />}
      />

      <SettingRow label="Firmware" sub={firmware.probed ? firmware.detail : 'Not running on a pod — no firmware detected.'}>
        <span className="font-mono text-[13px]" data-testid="firmware-generation">
          {firmware.probed ? firmware.label : '—'}
        </span>
      </SettingRow>

      <SettingRow label="Reading from" sub="Chosen once at startup. Restart the service after a firmware update to re-detect.">
        <span className="font-mono text-[13px]" data-testid="stream-source">
          {stream.source === 'pending' ? 'choosing…' : TRANSPORT_LABELS[stream.source]}
        </span>
      </SettingRow>

      <SettingRow label="Last frame" sub={stream.lastFrameType ? `${stream.lastFrameType} frame` : undefined}>
        <span className="font-mono text-[13px]" data-testid="last-frame">
          {stream.lastFrameAgeMs === null ? 'none yet' : fmtAgo(stream.lastFrameAgeMs)}
        </span>
      </SettingRow>

      {verdict.note && (
        <p className="text-xs leading-[1.4] text-warn text-pretty" data-testid="source-note">{verdict.note}</p>
      )}
    </Card>
  )
}
