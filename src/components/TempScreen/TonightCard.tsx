'use client'

import { useEffect, useState } from 'react'
import { Card, InlineError, LineChart, SectionLabel, Skeleton, StatusDot } from '@/src/components/ds'
import { formatTime12h } from '@/src/lib/scheduleTime'
import { formatSetpointF, type TempUnit } from '@/src/lib/tempUtils'
import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { formatCountdown, nextSetPoint, tonightPlan } from './tempScreenUtils'

/** Re-render on a wall-clock tick so countdowns stay current. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/**
 * Tonight: schedule on/off, tonight's window, a mini curve of tonight's set
 * points, and the next set point with a countdown.
 *
 * Wires into schedules.getAll (same query key as useScheduleActive).
 */
export function TonightCard({ side, unit }: { side: Side, unit: TempUnit }) {
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })
  const now = useNow()

  if (isLoading) return <Skeleton className="h-[150px]" />

  const temps = data?.temperature ?? []
  const power = data?.power ?? []
  const scheduleOn = temps.some(t => t.enabled) || power.some(p => p.enabled)
  const plan = tonightPlan(temps, power, now)
  const next = nextSetPoint(temps, now)

  return (
    <Card className="gap-2.5">
      <SectionLabel right={<StatusDot tone={scheduleOn ? 'ok' : 'muted'} label={scheduleOn ? 'ON' : 'OFF'} mono />}>
        Tonight
      </SectionLabel>
      {error
        ? <InlineError>{`Could not load schedule: ${error.message}`}</InlineError>
        : (
            <>
              <div className="font-mono text-base">
                {plan.window
                  ? `${formatTime12h(plan.window.start)} → ${formatTime12h(plan.window.end)}`
                  : <span className="font-sans text-sm text-fg-2">No schedule tonight</span>}
              </div>
              {plan.points.length >= 2 && (
                <LineChart
                  height={44}
                  series={[{ data: plan.points.map(p => p.temperature), color: 'var(--accent-warm)', width: 1.5 }]}
                />
              )}
              {scheduleOn && next && (
                <div className="flex font-mono text-xs text-fg-2">
                  {`Next ${formatTime12h(next.time)} · ${formatSetpointF(next.temperature, unit, { includeUnit: false })}`}
                  <span className="ml-auto">
                    {'in '}
                    <span className="text-fg">{formatCountdown(next.at.getTime() - now.getTime())}</span>
                  </span>
                </div>
              )}
            </>
          )}
    </Card>
  )
}
