'use client'

import clsx from 'clsx'
import { Wifi, Lock, Globe, Droplet } from 'lucide-react'

interface HealthCircleProps {
  healthy: number
  total: number
  podVersion?: string | null
  branch?: string
  commitHash?: string
  diskPercent?: number
  diskLabel?: string
  internetBlocked?: boolean
  wifiSsid?: string
  wifiSignal?: number
  podIP?: string
  waterLevel?: string
  isPriming?: boolean
  onWaterClick?: () => void
}

function podModelName(version: string): string {
  switch (version.toUpperCase()) {
    case 'H00': return 'Pod 5'
    case 'H01': return 'Pod 4'
    case 'H02': return 'Pod 3'
    case 'H03': return 'Pod 2'
    default: return version
  }
}

export function HealthCircle({
  healthy,
  total,
  podVersion,
  branch,
  commitHash,
  diskPercent,
  diskLabel,
  internetBlocked,
  wifiSsid,
  wifiSignal,
  podIP,
  waterLevel,
  isPriming,
  onWaterClick,
}: HealthCircleProps) {
  const progress = total > 0 ? healthy / total : 0
  const allHealthy = healthy === total && total > 0
  const circumference = 2 * Math.PI * 18

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
      {/* Row 1: Health ring + sleepypod + pod model */}
      <div className="flex items-center gap-3">
        <div className="relative h-11 w-11 shrink-0">
          <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90">
            <circle cx="20" cy="20" r="18" fill="none" stroke="#222" strokeWidth="3.5" />
            <circle
              cx="20" cy="20" r="18"
              fill="none"
              stroke={allHealthy ? '#34d399' : '#f59e0b'}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
              className="transition-all duration-500"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white">
            {healthy}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">sleepypod</span>
            {podVersion && (
              <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-400">
                {podModelName(podVersion)}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-400">
            {healthy} of {total} services healthy
          </p>
        </div>
      </div>

      {/* Row 2: Connection — IP + wifi + internet */}
      {(podIP || wifiSignal !== undefined || internetBlocked !== undefined) && (
        <>
          <div className="my-2.5 border-t border-zinc-800" />
          <div className="flex items-center gap-2 text-xs">
            {podIP && (
              <span className="flex items-center gap-1 text-zinc-400">
                <span className="text-emerald-400">&#x2713;</span>
                <span className="font-mono text-[11px]">{podIP}</span>
              </span>
            )}
            <span className="flex-1" />
            {wifiSignal !== undefined && (
              <span className={clsx(
                'flex items-center gap-1',
                wifiSignal > 60 ? 'text-zinc-400' : wifiSignal > 30 ? 'text-amber-400' : 'text-red-400',
              )}>
                <Wifi size={10} />
                <span className="text-[10px]">{wifiSsid ?? 'WiFi'} {wifiSignal}%</span>
              </span>
            )}
            {internetBlocked !== undefined && (
              <>
                <span className="text-zinc-700">&middot;</span>
                {internetBlocked ? (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-400"><Lock size={10} /> Local only</span>
                ) : (
                  <span className="flex items-center gap-1 text-[10px] text-amber-400"><Globe size={10} /> Internet</span>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* Row 3: Water + Calibration + branch/version */}
      <>
        <div className="my-2.5 border-t border-zinc-800" />
        <div className="flex items-center gap-2">
          {/* Water status — tappable */}
          {isPriming ? (
            <button onClick={onWaterClick} className="flex items-center gap-1 text-[10px] text-sky-400 active:opacity-70">
              <Droplet size={10} /> Priming...
            </button>
          ) : waterLevel ? (
            <button
              onClick={onWaterClick}
              className={clsx(
                'flex items-center gap-1 text-[10px] active:opacity-70',
                waterLevel === 'low' ? 'text-amber-400' : 'text-emerald-400',
              )}
            >
              <Droplet size={10} /> Water {waterLevel === 'ok' ? 'OK' : 'Low'}
            </button>
          ) : (
            <button onClick={onWaterClick} className="flex items-center gap-1 text-[10px] text-zinc-500 active:opacity-70">
              <Droplet size={10} /> Water
            </button>
          )}

          <span className="flex-1" />

          {/* Branch chip */}
          {branch && (
            <span className="rounded-full bg-zinc-800 px-2 py-1 text-[10px] font-medium text-zinc-400">
              &#x2387; {branch}
              {commitHash && (
                <span className="ml-1 text-zinc-500">{commitHash.slice(0, 7)}</span>
              )}
            </span>
          )}
        </div>
      </>

      {/* Row 4: Disk usage */}
      {diskPercent !== undefined && (
        <>
          <div className="my-2.5 border-t border-zinc-800" />
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-zinc-500">{diskLabel ?? 'Disk'}</span>
              <span
                className={clsx(
                  'font-medium',
                  diskPercent > 90 ? 'text-red-400' : diskPercent > 75 ? 'text-amber-400' : 'text-zinc-500',
                )}
              >
                {Math.round(diskPercent)}%
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className={clsx(
                  'h-full rounded-full transition-all duration-500',
                  diskPercent > 90 ? 'bg-red-400' : diskPercent > 75 ? 'bg-amber-400' : 'bg-sky-400',
                )}
                style={{ width: `${Math.min(diskPercent, 100)}%` }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
