'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react'
import { Card } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { useNow } from '@/src/components/TempScreen/TonightCard'
import { trpc } from '@/src/utils/trpc'
import { RECORDING_CHECK_MAX_AGE_MS } from '@/src/recording-health/evaluate'
import type { RecordingHealth } from '@/src/recording-health/contract'

export function RecordingHealthCard() {
  const query = trpc.health.recording.useQuery({}, { refetchInterval: 30_000, retry: false })
  const language = langFromPath(usePathname())
  const now = useNow(1000).getTime()
  return (
    <RecordingHealthSummary
      data={query.data}
      unavailable={!!query.error}
      now={Math.max(now, query.dataUpdatedAt)}
      diagnosticsHref={`/${language}/system?section=health`}
      onRetry={() => void query.refetch()}
      pending={query.isFetching}
    />
  )
}

export function RecordingHealthSummary({ data, unavailable, now, diagnosticsHref, onRetry, pending }: {
  data?: RecordingHealth
  unavailable: boolean
  now: number
  diagnosticsHref: string
  onRetry(): void
  pending: boolean
}) {
  const current = !unavailable && data !== undefined && Number.isSafeInteger(data.generatedAt)
    && Number.isSafeInteger(data.expiresAt) && data.expiresAt > now
    && data.generatedAt <= now && data.generatedAt >= now - RECORDING_CHECK_MAX_AGE_MS
  const state = current ? data.state : 'unknown'
  const Icon = state === 'ready' ? CircleCheck : state === 'attention' ? TriangleAlert : CircleHelp
  const title = current ? data.summary : pending ? 'Checking recording readiness…' : 'Recording check unavailable'
  return (
    <Card role="region" aria-label="Recording readiness">
      <div className="flex flex-wrap items-start justify-between gap-3" aria-live="polite">
        <div>
          <p className="flex items-center gap-2 font-medium">
            <Icon aria-hidden="true" size={18} className={state === 'attention' ? 'text-amber-400' : state === 'ready' ? 'text-emerald-400' : 'text-fg-2'} />
            {title}
          </p>
          <p className="mt-1 text-xs text-fg-2">Current Pod checks cover recording equipment, not sleep quality or Watch imports.</p>
        </div>
        <button type="button" className="min-h-11 rounded-ctl border border-line-2 px-3 text-sm disabled:opacity-50" disabled={pending} onClick={onRetry}>
          {pending ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {!current && <p className="mt-2 text-sm text-fg-2">Reconnect to check the sensors and storage. A saved result cannot confirm that recording is working now.</p>}
      {data && (
        <details className="mt-3" open={current && state === 'attention'}>
          <summary className="min-h-11 cursor-pointer py-3 text-sm">{current ? 'See recording checks' : 'See last successful check'}</summary>
          <p className="mb-3 text-xs text-fg-2">{`Checked ${new Date(data.generatedAt).toLocaleString()}`}</p>
          <ul className="space-y-4">
            {data.checks.map(check => (
              <li key={check.id}>
                <p className="text-sm font-medium">
                  {check.title}
                  <span className="ml-2 text-xs font-normal text-fg-2">{check.state === 'attention' ? 'Needs attention' : check.state === 'unknown' ? 'Not verified' : 'Checked'}</span>
                </p>
                <p className="text-sm text-fg-2">{check.detail}</p>
                {check.nextStep && <p className="mt-1 text-sm">{check.nextStep}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Link href={diagnosticsHref} className="mt-2 inline-flex min-h-11 items-center text-sm text-sky-400 underline underline-offset-4">Open recording diagnostics</Link>
    </Card>
  )
}
