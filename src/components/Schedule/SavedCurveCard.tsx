'use client'

import type { MouseEvent } from 'react'
import { CalendarPlus, Trash2 } from 'lucide-react'
import { Card, GhostIcon } from '@/src/components/ds'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import type { SavedCurve } from '@/src/hooks/useCurveTemplates'
import { formatTempRange, formatWindow } from './CurveCard'
import { MiniCurve } from './CurveChart'

/** Set points of a saved curve as the editor and charts take them. */
export function templateSetPoints(template: Pick<SavedCurve, 'points'>): Array<{ time: string, temperature: number }> {
  return Object.entries(template.points).map(([time, temperature]) => ({ time, temperature }))
}

/**
 * A saved curve: named set points not assigned to any day yet. Clicking it
 * opens the curve editor with those set points so the sleeper picks days.
 */
export function SavedCurveCard({ template, onUse, onDelete }: {
  template: SavedCurve
  onUse: () => void
  onDelete: () => void
}) {
  const { timeFormat } = useTimeFormatter()
  const { unit } = useTemperatureUnit()
  const setPoints = templateSetPoints(template)
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <Card flat dashed onClick={onUse} className="gap-2 px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[15px] font-medium min-[900px]:text-sm">{template.name}</span>
        <span className="font-mono text-[10px] tracking-wide text-fg-3">NO DAYS</span>
        <div className="ml-auto flex items-center gap-1">
          <GhostIcon icon={CalendarPlus} size={15} label={`Use ${template.name}`} onClick={stop(onUse)} />
          <GhostIcon icon={Trash2} size={15} label={`Delete ${template.name}`} className="text-fg-3" onClick={stop(onDelete)} />
        </div>
      </div>
      <MiniCurve setPoints={setPoints} className="hidden min-[900px]:block" />
      {template.notes && <p className="line-clamp-2 text-xs text-fg-2">{template.notes}</p>}
      <span className="font-mono text-xs text-fg-2">
        {[formatWindow(setPoints, timeFormat), formatTempRange(setPoints, unit, false)].filter(Boolean).join(' · ')}
      </span>
    </Card>
  )
}
