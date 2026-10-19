'use client'

import { useEffect, useState } from 'react'
import { Database } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, SelectValue, Skeleton, Toggle } from '@/src/components/ds'
import { ConfirmDialog } from '@/src/components/Schedule/ConfirmDialog'
import { effectiveLoggingMode } from '@/src/lib/recordingPolicy'

export function DataRecordingCard() {
  const utils = trpc.useUtils()
  const policy = trpc.system.getRecordingPolicy.useQuery({}, { refetchInterval: 15_000 })
  const [now, setNow] = useState(Date.now)
  const [confirmArchiveOff, setConfirmArchiveOff] = useState(false)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const save = trpc.system.setRecordingPolicy.useMutation({
    onSuccess: (data) => {
      utils.system.getRecordingPolicy.setData({}, data)
      setConfirmArchiveOff(false)
    },
  })
  const data = policy.data
  if (policy.isPending) return <Card><Skeleton className="h-40" /></Card>
  if (policy.error || !data) return <Card><InlineError>{policy.error?.message ?? 'Recording settings unavailable'}</InlineError></Card>
  const debugging = effectiveLoggingMode(data, now) === 'debug'
  return (
    <Card data-testid="data-recording-card">
      <CardHeader icon={Database} title="Data recording" subtitle="Choose what to keep. Existing history is not deleted when recording stops." />
      <div className="flex flex-col gap-3 border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm">App diagnostic logs</p>
            <p className="text-xs text-fg-2">System journal · configured for RAM on installed pods</p>
          </div>
          <SelectValue
            label="App logging mode"
            value={data.loggingMode}
            options={[{ value: 'quiet', label: 'Quiet · warnings and errors' }, { value: 'off', label: 'Off' }]}
            disabled={save.isPending}
            onChange={loggingMode => save.mutate({ loggingMode })}
          />
        </div>
        <p className="text-xs text-fg-2 text-pretty">
          Applies to core console logs and bundled Python module logs. Firmware, OS logs and third-party direct output are unaffected.
          Off leaves no new app diagnostic trail for troubleshooting. RAM logs disappear on reboot.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ debug: !debugging })}>
            {debugging ? 'Stop debug logging' : 'Debug for 15 minutes'}
          </Button>
          <p role="status" className="text-xs text-fg-2">
            {debugging
              ? `Debug logging active · returns to ${data.loggingMode === 'off' ? 'Off' : 'Quiet'} in ${Math.ceil(((data.debugUntil ?? now) - now) / 60_000)} min`
              : `Logging: ${data.loggingMode === 'off' ? 'Off' : 'Quiet'}`}
          </p>
        </div>
      </div>
      <div className="flex items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-sm">Health timeline</p>
          <p className="text-xs text-fg-2">Flash · diagnostic status history</p>
          <p className="mt-1 text-xs text-fg-2 text-pretty">Stop saving new Health timeline samples. Live health checks, safety monitoring and module lifecycle status continue. Takes effect by the next sample, within a minute.</p>
        </div>
        <Toggle label="Record Health timeline" on={data.healthHistory} disabled={save.isPending} onChange={healthHistory => save.mutate({ healthHistory })} />
      </div>
      <div className="flex items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-sm">Raw waveform archive</p>
          <p className="text-xs text-fg-2">Flash · compressed sensor recordings</p>
          <p className="mt-1 text-xs text-fg-2 text-pretty">For RAW-file firmware using the RAM archiver. Off stops future archive jobs and releases pending RAM pins within a minute; an in-progress file may finish. Live sensing continues. Saved archives remain, subject to normal retention. NATS-managed telemetry is unaffected.</p>
        </div>
        <Toggle label="Record raw waveform archive" on={data.rawArchive} disabled={save.isPending} onChange={rawArchive => rawArchive ? save.mutate({ rawArchive: true }) : setConfirmArchiveOff(true)} />
      </div>
      <p className="text-xs text-fg-2 text-pretty">
        Biometric history stays enabled on flash: current vitals and sleep views depend on these records.
        Hourly flash-write measurements also continue so you can compare the effect of these settings.
      </p>
      {save.error && <InlineError>{save.error.message}</InlineError>}
      <ConfirmDialog
        open={confirmArchiveOff}
        title="Stop raw waveform archiving?"
        message="Pending, unsaved waveforms in RAM will be discarded. New raw waveforms will not be saved for later analysis. Live sensing and existing saved archives are preserved."
        confirmLabel="Stop archiving"
        busy={save.isPending}
        onConfirm={() => save.mutate({ rawArchive: false })}
        onCancel={() => setConfirmArchiveOff(false)}
      />
    </Card>
  )
}
