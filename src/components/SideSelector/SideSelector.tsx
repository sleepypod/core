'use client'

import clsx from 'clsx'
import { Link, LinkIcon, Power, TrendingDown, TrendingUp } from 'lucide-react'
import { useSide, type Side } from '@/src/providers/SideProvider'
import { useDeviceStatus } from '@/src/hooks/useDeviceStatus'
import { useSideNames } from '@/src/hooks/useSideNames'
import { determineTrend, ensureF, formatTemp } from '@/src/lib/tempUtils'
import { tempFToOffset, offsetDisplay } from '@/src/lib/tempColors'

/**
 * Side selector wired to SideContext and real device status via tRPC.
 *
 * Mirrors the iOS SideSelectorView:
 * - Two side buttons showing per-side temp/state
 * - Link button in the center to toggle linked mode
 * - When linked, unified highlight behind both buttons
 * - Shows power-off state when side is off
 */
export const SideSelector = () => {
  const { selectedSide, isLinked, selectSide, toggleLink } = useSide()
  const { leftName, rightName } = useSideNames()

  const { status } = useDeviceStatus()

  return (
    <div className="relative my-3 w-full">
      <div
        className={clsx(
          'flex rounded-[16px] p-1.5 transition-all duration-250',
          isLinked
            ? 'bg-[rgb(30,42,58)] border border-sky-500/30'
            : 'bg-zinc-900',
        )}
      >
        <SideButton
          side="left"
          label={leftName}
          isSelected={selectedSide === 'left' || selectedSide === 'both'}
          isLinked={isLinked}
          sideStatus={status?.leftSide}
          onSelect={() => selectSide('left')}
        />
        <SideButton
          side="right"
          label={rightName}
          isSelected={selectedSide === 'right' || selectedSide === 'both'}
          isLinked={isLinked}
          sideStatus={status?.rightSide}
          onSelect={() => selectSide('right')}
        />
      </div>

      {/* Link button — centered between the two sides */}
      <button
        onClick={toggleLink}
        className={clsx(
          'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
          'w-[46px] h-[46px] rounded-full flex items-center justify-center',
          'border-[3px] border-[#0a0a0a] shadow-lg transition-all duration-200',
          isLinked
            ? 'bg-sky-500 text-white'
            : 'bg-[#1a1a1a] text-zinc-500',
        )}
        aria-label={isLinked ? 'Unlink sides' : 'Link sides'}
      >
        {isLinked
          ? <Link size={16} strokeWidth={2.5} />
          : <LinkIcon size={16} strokeWidth={2} />}
      </button>
    </div>
  )
}

interface SideButtonProps {
  side: Side
  label: string
  isSelected: boolean
  isLinked: boolean
  sideStatus?: {
    currentTemperature?: number
    targetTemperature?: number
    targetLevel?: number
    currentTemperatureF?: number
    targetTemperatureF?: number
  }
  onSelect: () => void
}

const SideButton = ({
  side,
  label,
  isSelected,
  isLinked,
  sideStatus,
  onSelect,
}: SideButtonProps) => {
  const hasStatus = sideStatus != null
  const sideIsOn = hasStatus ? (sideStatus.targetLevel ?? 0) !== 0 : false

  // Use Fahrenheit temperatures from status
  const currentTempF = sideStatus?.currentTemperature ?? 80
  const targetTempF = sideStatus?.targetTemperature ?? 80

  const currentF = ensureF(currentTempF, 'F')
  const targetF = ensureF(targetTempF, 'F')
  const trend = determineTrend(currentF, targetF)
  const offset = tempFToOffset(targetF)

  // When linked, individual buttons skip their own bg — the parent draws a merged one
  const showIndividualHighlight = !isLinked && isSelected

  return (
    <button
      onClick={onSelect}
      className={clsx(
        'flex-1 flex flex-col items-center py-3 px-2 rounded-[12px] sm:py-[14px] sm:px-4',
        'bg-transparent text-zinc-500 cursor-pointer transition-all duration-200 ease-in-out',
        side === 'left' ? 'mr-3 sm:mr-4' : 'ml-3 sm:ml-4',
        showIndividualHighlight && 'bg-[rgb(30,42,58)] border border-sky-500/30',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={clsx(
            'text-sm font-medium transition-colors duration-200',
            isSelected ? 'text-sky-400' : 'text-zinc-500',
          )}
        >
          {label}
        </span>
        {sideIsOn && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[13px] mt-1">
        {!hasStatus
          ? (
              <span className="text-zinc-600 animate-pulse">Loading...</span>
            )
          : sideIsOn
            ? (
                <>
                  {trend === 'up' && <TrendingUp size={12} className="text-amber-500" />}
                  {trend === 'down' && <TrendingDown size={12} className="text-sky-500" />}
                  <span className="text-zinc-400">
                    {offsetDisplay(offset)}
                    {' · '}
                    {formatTemp(currentF, 'F')}
                  </span>
                </>
              )
            : (
                <>
                  <Power size={12} className="text-zinc-600" />
                  <span className="text-zinc-600">Off</span>
                </>
              )}
      </div>
    </button>
  )
}
