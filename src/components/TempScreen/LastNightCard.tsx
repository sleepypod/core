'use client'

import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'

import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Card, InlineError, SectionLabel, Skeleton } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { formatSleepDuration } from './tempScreenUtils'
import { average } from '@/src/components/Sleep/sleepData'

const round = (v: number | null | undefined) => (v == null ? '—' : String(Math.round(v)))

/** Whole-night recording coverage and vitals; unknown gaps remain excluded. */
export function LastNightCard({ side, name }: { side: Side, name: string }) {
  const { formatClock: clock } = useTimeFormatter()
  const lang = langFromPath(usePathname())
  const latestQuery = trpc.biometrics.getSleepStages.useQuery(
    { side },
    { refetchInterval: 60_000, staleTime: 30_000 },
  )
  const latest = latestQuery.data?.recording
  const { data: settings } = trpc.settings.getAll.useQuery({})
  const epochs = latestQuery.data?.epochs ?? []
  const vitals = {
    avgHeartRate: average(epochs.map(epoch => epoch.heartRate)),
    avgHRV: average(epochs.map(epoch => epoch.hrv)),
    avgBreathingRate: average(epochs.map(epoch => epoch.breathingRate)),
  }

  if (latestQuery.isLoading) return <Skeleton className="h-[172px]" />

  const exits = latest?.exits ?? 0

  return (
    <Link href={`/${lang}/sleep`} className="block rounded-card text-fg no-underline">
      <Card className="gap-2 transition-colors hover:bg-active">
        <SectionLabel right={<ChevronRight size={14} className="text-fg-2" />}>
          {`Latest night · ${name}`}
        </SectionLabel>
        {latestQuery.error
          ? <InlineError>{`Could not load sleep: ${latestQuery.error.message}`}</InlineError>
          : !latest
              ? <span className="text-sm text-fg-2">No sleep recorded yet</span>
              : (
                  <>
                    <div className="font-mono text-2xl font-light">{formatSleepDuration(latest.durationMs / 1000)}</div>
                    <div className="text-xs text-fg-2">{new Date(latest.end).toLocaleDateString(undefined, { timeZone: settings?.device?.timezone, weekday: 'short', month: 'short', day: 'numeric' })}</div>
                    <div className="font-mono text-xs text-fg-2">
                      {`${clock(new Date(latest.start))} → ${clock(new Date(latest.end))} · ${exits} ${exits === 1 ? 'exit' : 'exits'}`}
                    </div>
                    <div className="text-xs text-fg-2">
                      Recorded bed time ·
                      {latest.recordIds.length}
                      {' '}
                      {latest.recordIds.length === 1 ? 'segment' : 'segments'}
                      . Unknown gaps are excluded.
                    </div>
                    <div className="mt-0.5 grid grid-cols-3 gap-2 border-t border-line pt-2.5">
                      <Vital value={round(vitals?.avgHeartRate)} label="HR bpm" />
                      <Vital value={round(vitals?.avgHRV)} label="HRV ms" />
                      <Vital value={round(vitals?.avgBreathingRate)} label="br/min" />
                    </div>
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
