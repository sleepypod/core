'use client'

import clsx from 'clsx'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { determineTrend, ensureF, formatTemp, mapToEightSleepScale } from 'src/lib/tempUtils'

type Side = 'left' | 'right'

interface SideTemp {
  currentTemp: number
  targetTemp: number
}

interface SideSelectorProps {
  temperatures: {
    leftSide: SideTemp
    rightSide: SideTemp
  }
}

export const SideSelector = ({ temperatures }: SideSelectorProps) => {
  const [activeSide, setActiveSide] = useState<Side>('left')

  const { leftSide, rightSide } = temperatures

  const handleSideChange = (side: Side) => {
    setActiveSide(side)
  }
  return (
    <div className="flex bg-zinc-900 rounded-[16px] p-1.5 my-3 w-full">
      <button
        onClick={() => handleSideChange('left')}
        className={clsx(
          'flex-1 flex flex-col items-center py-[14px] px-4 rounded-[12px] bg-transparent text-zinc-500 cursor-pointer transition-all duration-200 ease-in-out mr-2',
          { 'bg-[rgb(30,42,58)] border border-sky-500/30': activeSide === 'left' }
        )}
      >
        <span className={clsx('text-sm font-medium mb-1 transition-colors duration-200', activeSide === 'left' && 'text-sky-400')}>
          Left Side
        </span>
        <div className="flex items-center gap-1.5 text-[13px]">
          {
            (() => {
              const currentF = ensureF(leftSide.currentTemp, 'F')
              const targetF = ensureF(leftSide.targetTemp, 'F')
              const trend = determineTrend(currentF, targetF)
              const scale = mapToEightSleepScale(currentF)
              return (
                <>
                  {trend === 'up'
                    ? (
                        <TrendingUp size={14} className="text-amber-500" />
                      )
                    : trend === 'down'
                      ? (
                          <TrendingDown size={14} className="text-sky-500" />
                        )
                      : (
                          <TrendingUp size={14} className="text-zinc-400" />
                        )}
                  <span>
                    {formatTemp(currentF, 'F')}
                    {' '}
                    ·
                    {' '}
                    {scale}
                    /10
                  </span>
                </>
              )
            })()
          }
        </div>
      </button>

      <button
        onClick={() => handleSideChange('right')}
        className={clsx(
          'flex-1 flex flex-col items-center py-[14px] px-4 rounded-[12px] bg-transparent text-zinc-500 cursor-pointer transition-all duration-200 ease-in-out ml-2',
          { 'bg-[rgb(30,42,58)] border border-sky-500/30': activeSide === 'right' }
        )}
      >
        <span className={clsx('text-sm font-medium mb-1 transition-colors duration-200', activeSide === 'right' && 'text-sky-400')}>
          Right Side
        </span>
        <div className="flex items-center gap-1.5 text-[13px]">
          {
            (() => {
              const currentF = ensureF(rightSide.currentTemp, 'F')
              const targetF = ensureF(rightSide.targetTemp, 'F')
              const trend = determineTrend(currentF, targetF)
              const scale = mapToEightSleepScale(currentF)
              return (
                <>
                  {trend === 'up'
                    ? (
                        <TrendingUp size={14} className="text-amber-500" />
                      )
                    : trend === 'down'
                      ? (
                          <TrendingDown size={14} className="text-sky-500" />
                        )
                      : (
                          <TrendingUp size={14} className="text-zinc-400" />
                        )}
                  <span>
                    {formatTemp(currentF, 'F')}
                    {' '}
                    ·
                    {' '}
                    {scale}
                    /10
                  </span>
                </>
              )
            })()
          }
        </div>
      </button>
    </div>
  )
}
