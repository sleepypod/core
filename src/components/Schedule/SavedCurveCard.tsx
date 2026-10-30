'use client'

import type { MouseEvent } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { Card, GhostIcon, Toggle } from '@/src/components/ds'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import type { SavedCurve } from '@/src/hooks/useCurveTemplates'
import { type DayMove, LIBRARY_SIDES, type LibrarySide } from '@/src/lib/scheduleLibrary'
import { formatTempRange, formatWindow } from './CurveCard'
import { MiniCurve } from './CurveChart'
import { formatDayRange } from './scheduleFormat'

/** Set points of a saved curve as the editor and charts take them. */
export function templateSetPoints(template: Pick<SavedCurve, 'points'>): Array<{ time: string, temperature: number }> {
  return Object.entries(template.points).map(([time, temperature]) => ({ time, temperature }))
}

/**
 * "Mon–Fri" for one side, or each side's days by name when the card shows
 * both sides; "No days" when the curve has none there.
 */
export function curveDaysLabel(curve: Pick<SavedCurve, 'days'>, sides: readonly LibrarySide[], names: Record<LibrarySide, string>): string {
  const shown = sides.filter(s => curve.days[s].length > 0)
  if (shown.length === 0) return 'No days'
  if (sides.length === 1) return formatDayRange(curve.days[sides[0]])
  const [left, right] = LIBRARY_SIDES.map(s => formatDayRange(curve.days[s]))
  if (shown.length === 2 && left === right) return `Both · ${left}`
  return shown.map(s => `${names[s]} ${formatDayRange(curve.days[s])}`).join(' · ')
}

/**
 * "Mon, Tue move from Weeknight; Right Sat moves from Lazy Sunday, which
 * turns off" — what turning a curve on takes from the others. Side names
 * appear when a curve gives up days on both sides or on a side not in view.
 */
export function describeMoves(moves: DayMove[], names: Record<LibrarySide, string>, viewSides: readonly LibrarySide[] = LIBRARY_SIDES): string {
  const byCurve = new Map<number, DayMove[]>()
  for (const m of moves) byCurve.set(m.id, [...(byCurve.get(m.id) ?? []), m])
  return [...byCurve.values()].map((list) => {
    const named = list.length > 1 || !viewSides.includes(list[0].side)
    const days = list.map(m => `${named ? `${names[m.side]} ` : ''}${formatDayRange(m.days)}`).join(' and ')
    const count = list.reduce((n, m) => n + m.days.length, 0)
    return `${days} ${count === 1 ? 'moves' : 'move'} from ${list[0].name}${list[0].deactivated ? ', which turns off' : ''}`
  }).join('; ')
}

/**
 * A curve in the schedule library. The switch turns it on (on its days) or
 * off; clicking the card opens it in the curve editor.
 */
export function SavedCurveCard({ template, daysLabel, onOpen, onToggle, onDelete, busy = false }: {
  template: SavedCurve
  daysLabel: string
  onOpen: () => void
  onToggle: (next: boolean) => void
  onDelete: () => void
  busy?: boolean
}) {
  const { timeFormat } = useTimeFormatter()
  const { unit } = useTemperatureUnit()
  const setPoints = templateSetPoints(template)
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  const meta = [
    formatWindow(setPoints, timeFormat),
    formatTempRange(setPoints, unit, false),
    template.endAction === 'maintain' ? 'Maintains final temperature' : null,
  ].filter(Boolean).join(' · ')
  return (
    <Card flat dashed={!template.active} onClick={onOpen} className="gap-2 px-4 py-3.5" data-testid="library-curve">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[15px] font-medium min-[900px]:text-sm">{template.name}</span>
        <div className="ml-auto flex items-center gap-2">
          <GhostIcon icon={Pencil} size={15} label={`Edit ${template.name}`} onClick={stop(onOpen)} />
          <GhostIcon icon={Trash2} size={15} label={`Delete ${template.name}`} className="text-fg-3" onClick={stop(onDelete)} />
          <span onClick={e => e.stopPropagation()} className="flex">
            <Toggle
              on={template.active}
              onChange={onToggle}
              disabled={busy}
              label={`${template.active ? 'Turn off' : 'Turn on'} ${template.name}`}
            />
          </span>
        </div>
      </div>
      <span className={template.active ? 'font-mono text-xs text-fg' : 'font-mono text-xs text-fg-3'}>
        {template.active ? daysLabel : `Off · ${daysLabel}`}
      </span>
      <MiniCurve setPoints={setPoints} className="hidden min-[900px]:block" />
      {template.notes && <p className="line-clamp-2 text-xs text-fg-2">{template.notes}</p>}
      <span className="font-mono text-xs text-fg-2">{meta}</span>
    </Card>
  )
}
