'use client'

import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Card, InlineError, SectionLabel, Skeleton } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { formatSleepDuration } from './tempScreenUtils'

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const round = (v: number | null | undefined) => (v == null ? '—' : String(Math.round(v)))

/**
 * Last night: duration, bed → wake times and exits, then HR / HRV / BR averaged
 * over that session. The whole card links to Sleep.
 *
 * Wires into:
 * - biometrics.getLatestSleep → most recent sleep record for the side
 * - biometrics.getVitalsSummary → averages over that record's window
 */
export function LastNightCard({ side, name }: { side: Side, name: string }) {
  const lang = langFromPath(usePathname())
  const latestQuery = trpc.biometrics.getLatestSleep.useQuery(
    { side },
    { refetchInterval: 60_000, staleTime: 30_000 },
  )
  const latest = latestQuery.data
  const vitalsQuery = trpc.biometrics.getVitalsSummary.useQuery(
    // Open session: omit endDate so the server uses "now" (a client Date here
    // would change the query key every render).
    { side, startDate: latest?.enteredBedAt, ...(latest?.leftBedAt ? { endDate: latest.leftBedAt } : {}) },
    { enabled: latest != null, staleTime: 60_000 },
  )
  const vitals = vitalsQuery.data

  if (latestQuery.isLoading) return <Skeleton className="h-[172px]" />

  const exits = latest?.timesExitedBed ?? 0

  return (
    <Link href={`/${lang}/sleep`} className="block rounded-card text-fg no-underline">
      <Card className="gap-2 transition-colors hover:bg-active">
        <SectionLabel right={<ChevronRight size={14} className="text-fg-2" />}>
          {`Last night · ${name}`}
        </SectionLabel>
        {latestQuery.error
          ? <InlineError>{`Could not load sleep: ${latestQuery.error.message}`}</InlineError>
          : !latest
              ? <span className="text-sm text-fg-2">No sleep recorded yet</span>
              : (
                  <>
                    <div className="font-mono text-2xl font-light">{formatSleepDuration(latest.sleepDurationSeconds)}</div>
                    <div className="font-mono text-xs text-fg-2">
                      {`${clock(latest.enteredBedAt)} → ${latest.leftBedAt ? clock(latest.leftBedAt) : 'now'} · ${exits} ${exits === 1 ? 'exit' : 'exits'}`}
                    </div>
                    <div className="mt-0.5 grid grid-cols-3 gap-2 border-t border-line pt-2.5">
                      <Vital value={round(vitals?.avgHeartRate)} label="HR bpm" />
                      <Vital value={round(vitals?.avgHRV)} label="HRV ms" />
                      <Vital value={round(vitals?.avgBreathingRate)} label="br/min" />
                    </div>
                    {vitalsQuery.error && <InlineError>{`Could not load vitals: ${vitalsQuery.error.message}`}</InlineError>}
                  </>
                )}
      </Card>
    </Link>
  )
}

function Vital({ value, label }: { value: string, label: string }) {
  return (
    <div>
      <div className="font-mono text-base">{value}</div>
      <div className="text-xs text-fg-2">{label}</div>
    </div>
  )
}
