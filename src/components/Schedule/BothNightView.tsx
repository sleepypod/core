'use client'

import { Fragment, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { Badge, Card, GhostIcon, SegmentedControl } from '@/src/components/ds'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { groupDaysBySharedCurve, type ScheduleGroup } from '@/src/lib/scheduleGrouping'
import { getCurrentDay, type DayOfWeek } from '@/src/lib/scheduleTime'
import type { Side } from '@/src/providers/SideProvider'
import { buildTimeline, chartDomain, CurveChart, useNowMinute } from './CurveChart'
import { formatTempRange, formatWindow, PhaseStrip } from './CurveCard'
import { DAY_ORDER, DAY_SHORT, formatDayRange } from './scheduleFormat'
import { formatCountdown, formatNightDates, nightDate, nightSetPoints, nightWindow, type TempRow } from './bothNight'

const SIDES: Side[] = ['left', 'right']
const LANE_HEIGHT = 150

interface BothNightViewProps {
  temps: Record<Side, TempRow[] | undefined>
  names: Record<Side, string>
}

/**
 * Both sides' curves for one night as stacked lanes on a shared time axis,
 * each lane with its own temperature scale, plus one phase row per person.
 * Curves cover sets of days, so the day picker chooses which night to show.
 */
export function BothNightView({ temps, names }: BothNightViewProps) {
  const { unit } = useTemperatureUnit()
  const [day, setDay] = useState<DayOfWeek>(() => getCurrentDay())
  const nowMinute = useNowMinute()

  const lanes = SIDES.map(side => ({ side, setPoints: nightSetPoints(temps[side], day) }))
  const withPoints = lanes.filter(l => l.setPoints.length > 0)
  const { start, end, step } = chartDomain(withPoints.flatMap(l => buildTimeline(l.setPoints)))
  const axisSide = withPoints[withPoints.length - 1]?.side

  let meta = ''
  let showNow = false
  if (nowMinute !== null) {
    const now = new Date(nowMinute * 60_000)
    const midnight = nightDate(day, now)
    const windows = withPoints.map(l => nightWindow(l.setPoints, midnight)).filter(w => w !== null)
    const first = windows.reduce<Date | null>((a, w) => (!a || w.start < a ? w.start : a), null)
    const last = windows.reduce<Date | null>((a, w) => (!a || w.end > a ? w.end : a), null)
    meta = formatNightDates(midnight)
    if (first && now < first) meta += ` · starts in ${formatCountdown(first.getTime() - now.getTime())}`
    else if (first && last && now < last) {
      meta += ` · ends in ${formatCountdown(last.getTime() - now.getTime())}`
      showNow = true
    }
  }

  return (
    <Card className="gap-3.5 p-5" data-testid="both-night">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
        <span className="text-base font-medium">{`${DAY_LABEL[day]} night`}</span>
        {meta && <span className="font-mono text-xs text-fg-2">{meta}</span>}
        <SegmentedControl
          size="sm"
          ariaLabel="Night"
          className="ml-auto"
          options={DAY_ORDER.map(d => ({ value: d, label: DAY_SHORT[d] }))}
          value={day}
          onChange={setDay}
        />
      </div>

      <div className="flex flex-col gap-4">
        {lanes.map(({ side, setPoints }) => (
          <div key={side} className="grid grid-cols-[88px_minmax(0,1fr)] gap-3" data-testid={`lane-${side}`}>
            <div className="flex min-w-0 flex-col gap-0.5 pt-1">
              <span className="truncate text-sm">{names[side]}</span>
              <span className="text-xs text-fg-2">{side === 'left' ? 'Left' : 'Right'}</span>
              {setPoints.length > 0 && <span className="font-mono text-[11px] text-fg-2">{formatTempRange(setPoints, unit)}</span>}
            </div>
            {setPoints.length > 0
              ? (
                  <CurveChart
                    setPoints={setPoints}
                    height={LANE_HEIGHT}
                    timeDomain={{ start, end, step }}
                    grid="neutral"
                    showAxis={side === axisSide}
                    showNow={showNow}
                  />
                )
              : (
                  <div className="flex items-center rounded-ctl border border-dashed border-line px-3 text-xs text-fg-3" style={{ height: LANE_HEIGHT / 2 }}>
                    {`No curve on ${DAY_SHORT[day]}`}
                  </div>
                )}
          </div>
        ))}
      </div>

      {withPoints.length > 0 && (
        <div className="flex flex-col border-t border-line">
          {withPoints.map(({ side, setPoints }) => (
            <div key={side} className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3 border-b border-line py-3.5 last:border-b-0">
              <span className="truncate text-sm">{names[side]}</span>
              <PhaseStrip setPoints={setPoints} />
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

const DAY_LABEL: Record<DayOfWeek, string> = {
  sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday',
}

/** Every curve on both sides, one row each, grouped by person. */
export function PersonCurveList({ temps, names, onEdit, onDelete }: BothNightViewProps & {
  onEdit: (side: Side, group: ScheduleGroup) => void
  onDelete: (side: Side, group: ScheduleGroup) => void
}) {
  const { unit } = useTemperatureUnit()
  const rows = SIDES.flatMap(side => groupDaysBySharedCurve(temps[side] ?? [])
    .filter(g => g.setPoints.length > 0 || g.allDisabled)
    .map(group => ({ side, group })))
  if (rows.length === 0) return null

  return (
    <Card flat className="gap-0 px-4 py-1" data-testid="person-curves">
      {rows.map(({ side, group }) => {
        const label = formatDayRange(group.days)
        const paused = !!group.allDisabled
        const meta = [formatWindow(group.setPoints), formatTempRange(group.setPoints, unit)].filter(Boolean)
        return (
          <div key={`${side}-${group.key}`} className="flex min-w-0 items-center gap-3 border-b border-line py-2.5 last:border-b-0">
            <span className="w-[76px] shrink-0 truncate text-sm text-fg-2">{names[side]}</span>
            <span className="shrink-0 text-sm">{label}</span>
            {paused
              ? (
                  <>
                    <Badge variant="paused" />
                    <span className="truncate text-xs text-fg-3">No set points</span>
                  </>
                )
              : (
                  <span className="hidden truncate font-mono text-xs text-fg-2 min-[600px]:inline">
                    {meta.map((part, i) => (
                      <Fragment key={i}>
                        {i > 0 && ' · '}
                        {part}
                      </Fragment>
                    ))}
                  </span>
                )}
            <div className="ml-auto flex items-center gap-1">
              <GhostIcon icon={Pencil} size={15} label={`Edit ${names[side]} ${label}`} onClick={() => onEdit(side, group)} />
              <GhostIcon icon={Trash2} size={15} label={`Delete ${names[side]} ${label}`} className="text-fg-3" onClick={() => onDelete(side, group)} />
            </div>
          </div>
        )
      })}
    </Card>
  )
}
