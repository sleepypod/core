'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowRight, CircleCheck, CircleHelp, LoaderCircle, TriangleAlert } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { useNow } from '@/src/components/TempScreen/TonightCard'
import { CARE_MAX_AGE_MS, careCheckCurrent, type BedCare, type CareCheck } from '@/src/bed-care/contract'

export function BedCarePanel() {
  const query = trpc.health.care.useQuery({}, { refetchInterval: 15_000, retry: false })
  const now = useNow(1000).getTime()
  const language = langFromPath(usePathname())
  return (
    <BedCareSummary
      data={query.data}
      unavailable={!!query.error}
      pending={query.isFetching}
      now={Math.max(now, query.dataUpdatedAt)}
      language={language}
      onRetry={() => void query.refetch()}
    />
  )
}

const stateLabels = { checked: 'Checked', attention: 'Needs attention', unknown: 'Not verified', busy: 'In progress' }
const destinations = { thermal: 'View temperature delivery', dashboard: 'Review pump alerts', health: 'Open recording diagnostics', storage: 'Review storage', databases: 'Open backups' }

export function BedCareSummary({ data, unavailable, pending, now, language, onRetry }: {
  data?: BedCare
  unavailable: boolean
  pending: boolean
  now: number
  language: string
  onRetry(): void
}) {
  const fresh = !unavailable && data !== undefined && data.generatedAt <= now && data.generatedAt >= now - CARE_MAX_AGE_MS
  return (
    <section aria-label="Bed care" className="rounded-card border border-line bg-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-prose">
          <h2 className="text-xl font-semibold">Look after your bed</h2>
          <p className="mt-2 text-sm text-fg-2">Start with what needs attention. These checks explain the Pod’s reports; they do not inspect the mattress or detect leaks.</p>
        </div>
        <button type="button" className="min-h-11 rounded-ctl border border-line-2 px-4 text-sm disabled:opacity-50" onClick={onRetry} disabled={pending}>
          {pending ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <p role="status" className="mt-4 text-sm text-fg-2">
        {fresh
          ? `Checked ${new Date(data.generatedAt).toLocaleTimeString()}. Each source is checked separately.`
          : pending && !data ? 'Reading care checks…' : 'Care checks unavailable. Reconnect and check again; saved information cannot establish the bed’s current condition.'}
      </p>
      {data && (
        <ul className="mt-2 divide-y divide-line">
          {data.checks.map(check => <CareRow key={check.id} check={check} current={fresh && ((check.state === 'unknown' && check.observedAt === null) || careCheckCurrent(check, now))} language={language} lastExportAt={data.lastExportAt} />)}
        </ul>
      )}
      <details className="mt-5 border-t border-line pt-2">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">A careful recovery, step by step</summary>
        <ol className="ml-5 max-w-prose list-decimal space-y-3 text-sm text-fg-2">
          <li>Check the current connection and the affected source above. An unavailable reading is not a clean bill of health.</li>
          <li>Before software maintenance, export a backup from Databases and keep a private copy on another device. Verify the archive and rehearse restoration before replacing the controller.</li>
          <li>Open the relevant diagnostics, preserve its error and follow the specific recovery instructions. Do not clear circulation protection merely to hide an alert.</li>
          <li>Recheck after the repair. Confirm temperature, vibration and base movement separately when those functions are affected.</li>
        </ol>
        <p className="mt-4 max-w-prose text-sm text-fg-2">For water, hoses or a maintenance insert, use the manufacturer’s instructions for your exact Pod generation. Insert age and physical leaks are not measured here. A factory reset can remove this custom installation.</p>
        <a className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm text-fg underline underline-offset-4" href="https://help.eightsleep.com/" target="_blank" rel="noreferrer">
          Find instructions for your Pod
          {' '}
          <ArrowRight aria-hidden="true" size={16} />
        </a>
      </details>
    </section>
  )
}

function CareRow({ check, current, language, lastExportAt }: { check: CareCheck, current: boolean, language: string, lastExportAt: number | null }) {
  const state = current ? check.state : 'unknown'
  const Icon = state === 'attention' ? TriangleAlert : state === 'checked' ? CircleCheck : state === 'busy' ? LoaderCircle : CircleHelp
  return (
    <li className="grid gap-2 py-5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
      <div>
        <h3 className="font-medium">{check.title}</h3>
        <p className="mt-2 flex items-center gap-2 text-sm text-fg-2">
          <Icon size={16} aria-hidden="true" />
          {stateLabels[state]}
        </p>
      </div>
      <div className="min-w-0 max-w-prose">
        <p className="text-sm">{current ? check.detail : 'A current check is unavailable. Read the last observation below or try again.'}</p>
        {check.id === 'backup' && lastExportAt !== null && (
          <p className="mt-2 text-sm text-fg-2">
            Last recorded export:
            {new Date(lastExportAt).toLocaleString()}
            . This is not proof of a saved off-Pod backup.
          </p>
        )}
        <p role="note" aria-label="Next step" className="mt-2 text-sm text-fg-2">{current ? check.nextStep : 'Reconnect and check again before acting on this observation.'}</p>
        {(!current || check.evidence.length > 0) && (
          <details className="mt-2">
            <summary className="min-h-11 cursor-pointer py-3 text-sm">{current ? 'See individual checks' : 'See last observation'}</summary>
            {!current && (
              <div className="mb-3 text-sm text-fg-2">
                <p>
                  {check.observedAt === null ? 'No verified observation.' : `Observed ${new Date(check.observedAt).toLocaleString()}.`}
                  {' '}
                  {check.detail}
                </p>
                <p className="mt-2">
                  Advice for that observation:
                  {' '}
                  {check.nextStep}
                </p>
              </div>
            )}
            <ul className="space-y-3 text-sm text-fg-2">
              {check.evidence.map(item => (
                <li key={item.title}>
                  <strong className="font-medium text-fg">{item.title}</strong>
                  <p>{item.detail}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
        <Link href={`/${language}/system?tab=${check.destination}`} className="mt-1 inline-flex min-h-11 items-center gap-2 text-sm text-fg underline underline-offset-4">
          {destinations[check.destination]}
          {' '}
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
    </li>
  )
}
