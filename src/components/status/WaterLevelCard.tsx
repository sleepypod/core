'use client'

import { Droplets, Play } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, Skeleton } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { dailyWaterLevels, useWaterHistory, type WaterDay } from './waterHistory'

const DAY_TONE: Record<'ok' | 'low' | 'none', { past: string, today: string }> = {
  ok: { past: 'bg-ok-line', today: 'bg-ok' },
  low: { past: 'bg-warn-line', today: 'bg-warn' },
  none: { past: 'bg-line', today: 'bg-line-2' },
}

function dayLabel(level: WaterDay): string {
  if (level === 'ok') return 'OK'
  if (level === 'low') return 'low'
  return 'no data'
}

/**
 * Status → Water level: one cell per day for the last week (today solid),
 * last prime, and a Start prime button that opens the Water & priming dialog.
 *
 * Wires into:
 * - waterLevel.getHistory → 7-day strip
 * - device.getStatus → priming state + prime-complete timestamp
 */
export function WaterLevelCard({ onOpen }: { onOpen: () => void }) {
  const { data: history, isLoading: historyLoading } = useWaterHistory()
  const { data: status, isLoading: statusLoading } = trpc.device.getStatus.useQuery({}, { refetchInterval: 10_000 })

  const days = dailyWaterLevels(history)
  const lastPrimed = status?.primeCompletedNotification?.timestamp

  return (
    <Card>
      <CardHeader
        title="Water level"
        icon={Droplets}
        iconClassName="text-cool"
        right={<span className="font-mono text-xs text-fg-2">7 days</span>}
      />
      {historyLoading
        ? <Skeleton className="h-[22px]" data-testid="water-history-loading" />
        : (
            <div className="grid grid-cols-7 gap-1">
              {days.map((d, i) => {
                const tone = DAY_TONE[d.level ?? 'none']
                const date = new Date(d.day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
                return (
                  <span
                    key={d.day}
                    title={`${date}: ${dayLabel(d.level)}`}
                    aria-label={`${date}: ${dayLabel(d.level)}`}
                    className={cn('h-[22px] rounded-tag', i === days.length - 1 ? tone.today : tone.past)}
                  />
                )
              })}
            </div>
          )}
      <div className="flex items-center gap-3 text-[13px] text-fg-2">
        {statusLoading
          ? <Skeleton className="h-4 flex-1" data-testid="water-status-loading" />
          : (
              <span className="min-w-0 flex-1 truncate">
                {status?.isPriming
                  ? 'Priming…'
                  : lastPrimed
                    ? `Last primed ${new Date(lastPrimed).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
                    : 'No recent prime'}
              </span>
            )}
        <Button icon={Play} onClick={onOpen} disabled={statusLoading || status?.isPriming}>
          Start prime
        </Button>
      </div>
    </Card>
  )
}
