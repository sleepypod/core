'use client'

import { useState } from 'react'
import { RotateCw, Waves } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, SegmentedControl, SettingRow, Skeleton, StatusDot, TextField } from '@/src/components/ds'
import { fmtAgo, RESTARTABLE_UNITS } from '@/src/lib/dataPath'
import { isNatsSubjectPrefix } from '@/src/lib/natsSubjectPrefix'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import {
  observedSummary,
  PREFIX_CHOICES,
  prefixChoice,
  sensorSourceVerdict,
  sourcesSummary,
  TRANSPORT_LABELS,
  type PrefixChoice,
} from './sensorSourceLogic'

const POLL_MS = 10_000

type NatsDiagnostics = NonNullable<inferRouterOutputs<AppRouter>['system']['getSensorSource']['nats']>

/**
 * Settings → Device → "Sensor data source".
 *
 * A fleet of sleepypods spans three firmware generations, and which one a pod
 * runs decides whether the core reads `.RAW` files or a local NATS stream.
 * The transport pick is automatic and happens once per process — the card
 * exists so the first support question ("which pipeline is this pod on, and
 * is data flowing?") is answerable from the app instead of `sp-status` over
 * SSH. On NATS firmware it also sets the subject prefix the readers subscribe
 * under, for firmware that publishes somewhere the auto mode doesn't read.
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
    observedPrefixes: q.data.nats?.observedPrefixes,
  })
  const natsRelevant = stream.source === 'nats' || firmware.expectedTransport === 'nats'

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

      {q.data.nats && <NatsTraffic nats={q.data.nats} />}

      {natsRelevant && <SubjectPrefixSetting />}

      {verdict.note && (
        <p className="text-xs leading-[1.4] text-warn text-pretty" data-testid="source-note">{verdict.note}</p>
      )}
    </Card>
  )
}

/** Which prefix feeds each subject, and every prefix the firmware publishes under. */
function NatsTraffic({ nats }: { nats: NatsDiagnostics }) {
  return (
    <>
      <SettingRow label="Subjects" sub={sourcesSummary(nats.sources) ?? 'No subject has delivered a frame yet.'}>
        <span className="font-mono text-[13px]" data-testid="nats-mode">{nats.mode}</span>
      </SettingRow>
      <SettingRow label="Publishing prefixes" sub={observedSummary(nats.observedPrefixes) ?? 'None seen yet.'} />
    </>
  )
}

/**
 * `settings.natsSubjectPrefix`. The core's stream re-subscribes on save; the
 * Python biometrics modules read it at startup, so a change offers to restart
 * them through the same `health.restartService` path System → Health uses.
 */
function SubjectPrefixSetting() {
  const utils = trpc.useUtils()
  const settings = trpc.settings.getAll.useQuery({})
  const saved = settings.data?.device.natsSubjectPrefix ?? null
  const [customOpen, setCustomOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [changed, setChanged] = useState(false)
  const update = trpc.settings.updateDevice.useMutation({
    onSuccess: () => {
      setChanged(true)
      setCustomOpen(false)
      void utils.settings.getAll.invalidate()
      void utils.system.getSensorSource.invalidate()
    },
  })
  const restart = trpc.health.restartService.useMutation()
  const [restarting, setRestarting] = useState(false)
  const [restartResult, setRestartResult] = useState<string | null>(null)

  if (!settings.data) return null

  const choice: PrefixChoice = customOpen ? 'custom' : prefixChoice(saved)
  const save = (prefix: string | null) => {
    if (prefix !== saved) update.mutate({ natsSubjectPrefix: prefix })
  }
  const choose = (next: PrefixChoice) => {
    if (next === 'custom') {
      setCustomOpen(true)
      setDraft(prefixChoice(saved) === 'custom' ? saved ?? '' : '')
      return
    }
    setCustomOpen(false)
    save(next === 'auto' ? null : next)
  }
  const draftValid = isNatsSubjectPrefix(draft)
  const restartModules = async () => {
    setRestarting(true)
    setRestartResult(null)
    const results = await Promise.all(RESTARTABLE_UNITS.map(unit => restart.mutateAsync({ unit }).catch((e: Error) => ({ ok: false, message: e.message }))))
    const failed = results.filter(r => !r.ok)
    setRestarting(false)
    setRestartResult(failed.length === 0 ? `Restarted ${results.length} biometrics modules.` : failed.map(r => r.message).join(' '))
  }

  return (
    <>
      <SettingRow
        label="Subject prefix"
        sub="Auto reads raw and rawmem, preferring raw. Pin a prefix only if the firmware publishes somewhere else."
      >
        <SegmentedControl ariaLabel="NATS subject prefix" size="sm" value={choice} options={PREFIX_CHOICES} onChange={choose} />
      </SettingRow>
      {choice === 'custom' && (
        <div className="flex items-end gap-2.5">
          <TextField
            label="Custom prefix"
            className="flex-1"
            value={draft}
            onChange={setDraft}
            placeholder="rawmem"
            maxLength={32}
            hint={draft === '' || draftValid ? undefined : 'Letters, digits, _ or -, up to 32 characters. No dots or wildcards.'}
          />
          <Button disabled={!draftValid || update.isPending} onClick={() => save(draft)}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
      {update.error && <InlineError>{update.error.message}</InlineError>}
      {changed && (
        <div className="flex flex-wrap items-center gap-2.5" data-testid="prefix-restart">
          <p className="min-w-0 flex-1 basis-[220px] text-xs leading-[1.4] text-fg-2 text-pretty">
            The live stream switched already. Biometrics modules pick this up on their next restart.
          </p>
          <Button icon={RotateCw} disabled={restarting} onClick={() => void restartModules()}>
            {restarting ? 'Restarting…' : 'Restart biometrics modules'}
          </Button>
          {restartResult && <p className="w-full text-xs text-fg-2" data-testid="prefix-restart-result">{restartResult}</p>}
        </div>
      )}
    </>
  )
}
