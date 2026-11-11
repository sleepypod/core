'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { langFromPath } from '@/src/components/AppShell/navItems'
import type { Side } from '@/src/hardware/types'
import { trpc } from '@/src/utils/trpc'
import { useNow } from './TonightCard'
import { LastNightCard } from './LastNightCard'
import { currentTonightRead, morningInPodZone, personalComfortMode } from './tonightSummary'

/** The everyday plan stays visible in both layouts; detailed editors keep their existing authority. */
export function TonightOverview({ side, name, sleepSide = side, sleepName = name, timeZone, morning: showMorning }: { side: Side, name: string, sleepSide?: Side, sleepName?: string, timeZone?: string, morning?: boolean }) {
  const lang = langFromPath(usePathname())
  const now = useNow(1000).getTime()
  const options = { refetchInterval: 30_000, retry: false as const, refetchOnWindowFocus: 'always' as const }
  const comfort = trpc.comfort.get.useQuery({ side }, options)
  const alarm = trpc.nextAlarm.get.useQuery({ side }, options)
  const limit = trpc.comfortLimit.get.useQuery({ side }, options)
  const currentComfort = currentTonightRead(comfort.dataUpdatedAt, comfort.isError, now) && comfort.data?.side === side ? comfort.data : undefined
  const currentAlarm = currentTonightRead(alarm.dataUpdatedAt, alarm.isError, now) && alarm.data?.side === side ? alarm.data : undefined
  const currentLimit = currentTonightRead(limit.dataUpdatedAt, limit.isError, now) && limit.data?.side === side ? limit.data : undefined
  const next = currentAlarm?.alarm
  const futureAlarm = next && Date.parse(next.at) > now ? next : null
  const wake = currentLimit?.wake
  const coherentWake = wake && futureAlarm && currentAlarm?.state === 'scheduled' && wake.alarmAt === Date.parse(futureAlarm.at)
    && wake.targetF === futureAlarm.alarmTemperatureF && wake.timeZone === currentAlarm.timeZone
    ? wake
    : null
  const formatTime = (at: number | string, zone: string) => {
    try {
      return new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(at))
    }
    catch { return 'Time unavailable' }
  }
  const morning = showMorning ?? morningInPodZone(now, timeZone)
  return (
    <section aria-label="Tonight overview" className="mb-5 min-w-0 space-y-4 [overflow-wrap:anywhere]">
      {morning && (
        <div className="grid items-start gap-3 min-[700px]:grid-cols-2" aria-label="Morning review">
          <div className="space-y-2 py-2">
            <h2 className="text-xl font-semibold">Your morning review</h2>
            <p className="max-w-prose text-sm text-fg-2">Open the latest night to review recorded time and gaps. Personal Health reports stay in the iPhone app.</p>
            <Link className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={`/${lang}/autopilot?view=automations&side=${side}#personal-comfort`}>Review overnight comfort</Link>
          </div>
          <LastNightCard side={sleepSide} name={sleepName} />
        </div>
      )}
      <div className="rounded-card border border-line bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 flex-1 text-base font-semibold">
            {name}
            {' '}
            · tonight’s plan
          </h2>
          <button
            type="button"
            aria-label="Refresh tonight’s plan"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-ctl text-fg-2 hover:bg-active disabled:opacity-50"
            disabled={comfort.isFetching || alarm.isFetching || limit.isFetching}
            onClick={() => {
              void comfort.refetch()
              void alarm.refetch()
              void limit.refetch()
            }}
          >
            <RefreshCw size={18} aria-hidden="true" />
          </button>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-4 max-[359px]:grid-cols-1">
          <div>
            <dt className="text-sm text-fg-2">Personal Autopilot</dt>
            <dd className="mt-1 font-medium" data-testid="tonight-comfort-mode">{personalComfortMode(currentComfort, now)}</dd>
            <dd className="mt-1 text-sm text-fg-2">{!currentLimit ? 'Automatic range not checked' : currentLimit.config.enabled ? `${currentLimit.config.minF}–${currentLimit.config.maxF}°F automatic range` : 'No automatic range enabled'}</dd>
            <dd><Link className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={`/${lang}/autopilot?view=automations&side=${side}#personal-comfort`}>Review Autopilot</Link></dd>
          </div>
          <div>
            <dt className="text-sm text-fg-2">Next wake-up</dt>
            <dd className="mt-1 font-medium">{!currentAlarm ? 'Not checked' : currentAlarm.state === 'away' ? 'Paused while away' : currentAlarm.state === 'skipped' ? 'Next occurrence skipped' : futureAlarm ? `${formatTime(futureAlarm.at, currentAlarm.timeZone)} · ${futureAlarm.duration}s vibration` : next ? 'Alarm time passed · refresh to confirm' : 'No alarm scheduled'}</dd>
            <dd className="mt-1 text-sm text-fg-2">{coherentWake ? `Warming from ${formatTime(coherentWake.startsAt, coherentWake.timeZone)} toward ${coherentWake.targetF}°F.` : !futureAlarm ? 'Review your wake plan before relying on it.' : 'Warming not confirmed · refresh the plan.'}</dd>
            <dd><Link className="inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={`/${lang}/schedule?side=${side}`}>Review wake plan</Link></dd>
          </div>
        </dl>
        <details className="mt-1 text-xs text-fg-2">
          <summary className="min-h-11 cursor-pointer py-3">About this saved plan</summary>
          <p>Acknowledgments do not verify physical warming or vibration. Manual holds can temporarily override the automatic range.</p>
        </details>
      </div>
    </section>
  )
}
