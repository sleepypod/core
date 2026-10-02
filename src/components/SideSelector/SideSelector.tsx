'use client'

import { Link2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ACCENT_VAR, directionFor } from '@/src/components/TempControl/TempControl'
import { offsetLabel } from '@/src/components/TempScreen/tempScreenUtils'
import { useDeviceStatus } from '@/src/hooks/useDeviceStatus'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatSetpointF, type TempUnit } from '@/src/lib/tempUtils'
import { useSide, type Side } from '@/src/providers/SideProvider'

export interface SideOverride {
  targetF: number
  isOn: boolean
}

/**
 * Full-width phone side switcher: name + `−4 · 76°` (offset from 80 · target)
 * per side, in the side's accent color when selected, and a link toggle in
 * the middle. Wired to SideProvider; `overrides` lets the Temp screen show
 * its optimistic targets before the status stream confirms them.
 */
export const SideSelector = ({ overrides, className }: {
  overrides?: Partial<Record<Side, SideOverride>>
  className?: string
}) => {
  const { selectedSide, isLinked, selectSide, toggleLink } = useSide()
  const { leftName, rightName } = useSideNames()
  const { unit } = useTemperatureUnit()
  const { status } = useDeviceStatus()

  const tab = (side: Side, label: string) => {
    const sideStatus = side === 'left' ? status?.leftSide : status?.rightSide
    const override = overrides?.[side]
    return (
      <SideTab
        label={label}
        selected={selectedSide === side || selectedSide === 'both'}
        unit={unit}
        loaded={sideStatus != null}
        targetF={override?.targetF ?? sideStatus?.targetTemperature ?? 80}
        bedF={sideStatus?.currentTemperature ?? null}
        isOn={override?.isOn ?? (sideStatus?.targetLevel ?? 0) !== 0}
        onSelect={() => selectSide(side)}
      />
    )
  }

  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)_36px_minmax(0,1fr)] items-center rounded-card border border-line p-1', className)}>
      {tab('left', leftName)}
      <button
        type="button"
        onClick={toggleLink}
        aria-pressed={isLinked}
        aria-label={isLinked ? 'Unlink sides' : 'Link sides'}
        className={cn(
          'flex h-9 cursor-pointer items-center justify-center rounded-ctl border-0 bg-transparent transition-colors hover:bg-active',
          isLinked ? 'text-fg' : 'text-fg-3',
        )}
      >
        <Link2 size={14} />
      </button>
      {tab('right', rightName)}
    </div>
  )
}

function SideTab({ label, selected, unit, loaded, targetF, bedF, isOn, onSelect }: {
  label: string
  selected: boolean
  unit: TempUnit
  loaded: boolean
  targetF: number
  bedF: number | null
  isOn: boolean
  onSelect: () => void
}) {
  const accent = ACCENT_VAR[directionFor(targetF, bedF)]
  const sub = !loaded
    ? '—'
    : isOn
      ? `${offsetLabel(targetF, unit)} · ${formatSetpointF(targetF, unit, { includeUnit: false })}`
      : 'Off'
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex min-w-0 cursor-pointer flex-col items-center rounded-seg border-0 p-2.5 text-center transition-colors',
        selected ? 'bg-active' : 'bg-transparent hover:bg-active',
      )}
    >
      <span className={cn('max-w-full truncate text-sm', selected ? 'font-medium text-fg' : 'text-fg-2')}>{label}</span>
      <span
        className={cn('font-mono text-xs', !(selected && isOn && loaded) && 'text-fg-2')}
        style={selected && isOn && loaded ? { color: accent } : undefined}
      >
        {sub}
      </span>
    </button>
  )
}
